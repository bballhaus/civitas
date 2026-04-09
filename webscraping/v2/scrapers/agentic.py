"""
Agentic scraper — LLM-powered auto-adaptation for unknown procurement sites.

Uses Claude Sonnet + Playwright to:
1. Navigate to a procurement site
2. Discover the RFP listing page
3. Recognize the page structure (table/cards/list)
4. Generate a reusable "recipe" (CSS selectors + pagination config)
5. Extract events using the recipe
6. Cache the recipe for subsequent runs (zero LLM cost on repeat)
7. Self-heal: if a cached recipe breaks, re-run discovery

This is a Tier 3 scraper — used for new/unknown sites or when structured
scrapers fail due to layout changes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from datetime import datetime
from typing import AsyncIterator, Optional

import anthropic
from playwright.async_api import async_playwright, Page, BrowserContext

from webscraping.v2.config import ANTHROPIC_API_KEY
from webscraping.v2.models import RawScrapedEvent, ContactInfo, SiteConfig, ScraperRecipe
from webscraping.v2.scrapers.base import BaseScraper

logger = logging.getLogger(__name__)

# Max pages to paginate through
MAX_PAGES = 50
# Max events per site per run
MAX_EVENTS = 500


# ---------------------------------------------------------------------------
# System prompts for the agent
# ---------------------------------------------------------------------------

DISCOVERY_PROMPT = """You are navigating a government procurement website to find RFP/bid/solicitation listings.

Your goal: Find the page that shows CURRENT, OPEN bids, RFPs, solicitations, or procurement opportunities.

Look for links or navigation items containing words like:
- "Current Bids", "Open Solicitations", "Active Procurements"
- "Bid Opportunities", "RFP", "RFQ", "IFB"
- "Procurement", "Purchasing", "Contracts"
- "Vendor Opportunities", "Business Opportunities"

If you're already on a listing page (you can see a table/list of bids with titles and dates), say FOUND.

If you need to click a link to get to the listing page, provide the EXACT text or selector of the link to click.

Respond with JSON only:
{"status": "FOUND"} if you're on the listing page
{"status": "CLICK", "selector": "css selector or link text"} if you need to click something
{"status": "NAVIGATE", "url": "full URL"} if you need to navigate to a specific URL
{"status": "FAILED", "reason": "why"} if you can't find any procurement listings
"""

RECIPE_PROMPT = """You are analyzing a government procurement listing page to create an extraction recipe.

Look at the HTML and identify:
1. The container holding individual RFP/bid entries (table rows, cards, list items)
2. For each entry, the selectors for: title, due date, agency/department, detail URL
3. Pagination mechanism (next button, page numbers, load more, or none)

The HTML of the page is below. Create a recipe as JSON:

{
  "listing_selector": "CSS selector for each individual entry (e.g. 'table.bids tbody tr', '.bid-card')",
  "fields": {
    "title": {"selector": "CSS selector relative to entry", "attribute": "text or href or other attr"},
    "due_date": {"selector": "...", "attribute": "text"},
    "agency": {"selector": "...", "attribute": "text"},
    "detail_url": {"selector": "...", "attribute": "href"},
    "description": {"selector": "...", "attribute": "text"},
    "event_id": {"selector": "...", "attribute": "text"}
  },
  "pagination": {
    "type": "next_button|page_numbers|load_more|none",
    "selector": "CSS selector for next/load more button, or page number links"
  }
}

Rules:
- Only include fields you can actually find in the HTML. title is required, others are optional.
- Use CSS selectors that are as specific as possible but not brittle (prefer class-based over nth-child).
- For detail_url, use the <a> tag's href attribute.
- If there's no pagination, set type to "none".
- Return ONLY the JSON, no explanation.

HTML:
"""


# ---------------------------------------------------------------------------
# Agent helper: call Claude
# ---------------------------------------------------------------------------

def _call_claude(system: str, user_content: str, max_tokens: int = 2000) -> str:
    """Call Claude Sonnet for agent reasoning."""
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)
    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": user_content}],
    )
    return response.content[0].text.strip()


def _parse_json_response(text: str) -> dict:
    """Extract JSON from agent response, handling markdown code blocks."""
    # Strip markdown code blocks
    if "```" in text:
        match = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
        if match:
            text = match.group(1).strip()
    return json.loads(text)


# ---------------------------------------------------------------------------
# Agentic scraper
# ---------------------------------------------------------------------------

class AgenticScraper(BaseScraper):
    """LLM-powered scraper that auto-adapts to unknown procurement sites."""

    def __init__(self, site_config: SiteConfig):
        super().__init__(site_config)
        self._recipe: Optional[ScraperRecipe] = None

    async def scrape(self) -> AsyncIterator[RawScrapedEvent]:
        """Main scrape loop: discover, recipe, extract, paginate."""
        async with async_playwright() as p:
            browser = await p.chromium.launch(headless=True)
            context = await browser.new_context(
                viewport={"width": 1920, "height": 1080},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
            )
            page = await context.new_page()

            try:
                # Try cached recipe first
                recipe = self._load_cached_recipe()
                if recipe:
                    logger.info(f"Using cached recipe for {self.source_id}")
                    events = await self._extract_with_recipe(page, recipe)
                    if events:
                        for event in events:
                            yield event
                        return
                    else:
                        logger.warning("Cached recipe returned 0 events, re-discovering...")

                # Discovery phase: find the listing page
                listing_url = await self._discover_listing_page(page)
                if not listing_url:
                    logger.error(f"Could not find listing page for {self.source_id}")
                    return

                # Recipe generation: analyze page structure
                recipe = await self._generate_recipe(page, listing_url)
                if not recipe:
                    logger.error(f"Could not generate recipe for {self.source_id}")
                    return

                # Cache the recipe
                self._cache_recipe(recipe)

                # Extract events
                events = await self._extract_with_recipe(page, recipe)
                for event in events:
                    yield event

            finally:
                await browser.close()

    async def _discover_listing_page(self, page: Page, max_attempts: int = 5) -> Optional[str]:
        """Navigate to the site and find the RFP listing page."""
        logger.info(f"Discovering listing page for {self.site_config.url}")
        await page.goto(self.site_config.url, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(3000)

        for attempt in range(max_attempts):
            # Get page content for the agent
            html = await page.content()
            # Truncate HTML to avoid token limits
            if len(html) > 50000:
                html = html[:50000] + "\n... [truncated]"

            visible_text = await page.evaluate("() => document.body.innerText.substring(0, 5000)")

            prompt = f"Current URL: {page.url}\n\nVisible text:\n{visible_text}\n\nWhat should I do to find the procurement listings?"

            try:
                response = _call_claude(DISCOVERY_PROMPT, prompt)
                action = _parse_json_response(response)
            except Exception as e:
                logger.warning(f"Discovery attempt {attempt + 1} failed: {e}")
                continue

            status = action.get("status", "")

            if status == "FOUND":
                logger.info(f"Found listing page: {page.url}")
                return page.url

            elif status == "CLICK":
                selector = action.get("selector", "")
                logger.info(f"Clicking: {selector}")
                try:
                    # Try as CSS selector first
                    elem = await page.query_selector(selector)
                    if not elem:
                        # Try as text content
                        elem = await page.query_selector(f"text={selector}")
                    if elem:
                        await elem.click()
                        await page.wait_for_load_state("networkidle", timeout=15000)
                        await page.wait_for_timeout(2000)
                    else:
                        logger.warning(f"Could not find element: {selector}")
                except Exception as e:
                    logger.warning(f"Click failed: {e}")

            elif status == "NAVIGATE":
                url = action.get("url", "")
                logger.info(f"Navigating to: {url}")
                await page.goto(url, wait_until="networkidle", timeout=60000)
                await page.wait_for_timeout(2000)

            elif status == "FAILED":
                logger.error(f"Discovery failed: {action.get('reason', 'unknown')}")
                return None

        logger.error("Max discovery attempts reached")
        return None

    async def _generate_recipe(self, page: Page, listing_url: str) -> Optional[ScraperRecipe]:
        """Analyze the listing page and generate an extraction recipe."""
        logger.info("Generating extraction recipe...")

        # Get clean HTML (remove scripts/styles for smaller payload)
        html = await page.evaluate("""() => {
            const clone = document.documentElement.cloneNode(true);
            clone.querySelectorAll('script, style, noscript, svg, img').forEach(e => e.remove());
            return clone.innerHTML.substring(0, 80000);
        }""")

        try:
            response = _call_claude(
                "You are an expert at web scraping. Analyze HTML and create extraction recipes.",
                f"{RECIPE_PROMPT}\n{html}",
                max_tokens=3000,
            )
            recipe_data = _parse_json_response(response)
        except Exception as e:
            logger.error(f"Recipe generation failed: {e}")
            return None

        # Validate the recipe by testing it
        listing_selector = recipe_data.get("listing_selector", "")
        entries = await page.query_selector_all(listing_selector)
        if not entries:
            logger.warning(f"Recipe listing_selector '{listing_selector}' matched 0 entries")
            return None

        logger.info(f"Recipe validated: {len(entries)} entries found with '{listing_selector}'")

        return ScraperRecipe(
            site_id=self.source_id,
            listing_url=listing_url,
            listing_selector=listing_selector,
            fields=recipe_data.get("fields", {}),
            pagination=recipe_data.get("pagination"),
        )

    async def _extract_with_recipe(
        self, page: Page, recipe: ScraperRecipe
    ) -> list[RawScrapedEvent]:
        """Use a recipe to extract events from the listing page."""
        await page.goto(recipe.listing_url, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(3000)

        all_events = []
        page_num = 0

        while page_num < MAX_PAGES and len(all_events) < MAX_EVENTS:
            entries = await page.query_selector_all(recipe.listing_selector)
            if not entries:
                break

            logger.info(f"Page {page_num + 1}: {len(entries)} entries")

            for entry in entries:
                try:
                    event = await self._extract_entry(page, entry, recipe)
                    if event and event.title:
                        all_events.append(event)
                except Exception as e:
                    logger.debug(f"Failed to extract entry: {e}")

            # Pagination
            if not await self._go_to_next_page(page, recipe):
                break
            page_num += 1
            self.throttle()

        return all_events

    async def _extract_entry(
        self, page: Page, entry, recipe: ScraperRecipe
    ) -> Optional[RawScrapedEvent]:
        """Extract a single event from a listing entry using the recipe."""
        fields = recipe.fields
        data = {}

        for field_name, field_config in fields.items():
            selector = field_config.get("selector", "")
            attribute = field_config.get("attribute", "text")

            try:
                elem = await entry.query_selector(selector)
                if not elem:
                    data[field_name] = ""
                    continue

                if attribute == "text":
                    data[field_name] = (await elem.inner_text()).strip()
                elif attribute == "href":
                    href = await elem.get_attribute("href")
                    if href and not href.startswith("http"):
                        # Make absolute
                        href = f"{page.url.split('/')[0]}//{page.url.split('/')[2]}{href}"
                    data[field_name] = href or ""
                else:
                    data[field_name] = await elem.get_attribute(attribute) or ""
            except Exception:
                data[field_name] = ""

        title = data.get("title", "")
        if not title:
            return None

        event_id = data.get("event_id", "") or title[:50]
        detail_url = data.get("detail_url", "")

        return RawScrapedEvent(
            source_id=self.source_id,
            source_event_id=event_id,
            source_url=detail_url or page.url,
            title=title,
            description=data.get("description", ""),
            issuing_agency=data.get("agency", ""),
            due_date=data.get("due_date"),
            contact=ContactInfo(),
            procurement_type="RFP",
        )

    async def _go_to_next_page(self, page: Page, recipe: ScraperRecipe) -> bool:
        """Navigate to the next page of results. Returns False if no more pages."""
        pagination = recipe.pagination
        if not pagination or pagination.get("type") == "none":
            return False

        selector = pagination.get("selector", "")
        if not selector:
            return False

        pag_type = pagination.get("type", "next_button")

        if pag_type == "next_button":
            btn = await page.query_selector(selector)
            if not btn or not await btn.is_visible():
                return False
            # Check if disabled
            disabled = await btn.get_attribute("disabled")
            cls = await btn.get_attribute("class") or ""
            if disabled or "disabled" in cls:
                return False
            await btn.click()
            await page.wait_for_load_state("networkidle", timeout=15000)
            await page.wait_for_timeout(2000)
            return True

        elif pag_type == "load_more":
            btn = await page.query_selector(selector)
            if not btn or not await btn.is_visible():
                return False
            await btn.click()
            await page.wait_for_timeout(3000)
            return True

        return False

    # --- Recipe caching ---

    def _load_cached_recipe(self) -> Optional[ScraperRecipe]:
        """Load cached recipe from site config."""
        if self.site_config.cached_recipe:
            try:
                return ScraperRecipe(**self.site_config.cached_recipe)
            except Exception:
                return None
        return None

    def _cache_recipe(self, recipe: ScraperRecipe):
        """Cache recipe in site config (and optionally to S3)."""
        self.site_config.cached_recipe = recipe.model_dump()
        self._recipe = recipe
        logger.info(f"Cached recipe for {self.source_id}")

        # Also save to S3
        try:
            key = f"scrapes/v2/recipes/{self.source_id}.json"
            self.s3.put_object(
                Bucket=S3_BUCKET,
                Key=key,
                Body=recipe.model_dump_json(indent=2),
                ContentType="application/json",
            )
            logger.info(f"Saved recipe to S3: {key}")
        except Exception as e:
            logger.debug(f"Could not save recipe to S3: {e}")


# ---------------------------------------------------------------------------
# Standalone runner
# ---------------------------------------------------------------------------

async def main():
    """Test the agentic scraper on a given URL."""
    import sys
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

    url = sys.argv[1] if len(sys.argv) > 1 else "https://www.lacity.org/for-businesses/bids-contracts"
    site_id = sys.argv[2] if len(sys.argv) > 2 else "test_site"

    config = SiteConfig(
        site_id=site_id,
        name=f"Test: {site_id}",
        url=url,
        scraper_type="agentic",
    )

    scraper = AgenticScraper(config)
    events = await scraper.run()

    print(f"\nScraped {len(events)} events")
    for e in events[:10]:
        print(f"  - {e.title[:60]}")
        if e.due_date:
            print(f"    Due: {e.due_date}")


if __name__ == "__main__":
    asyncio.run(main())
