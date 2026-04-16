"""
PlanetBids Prospective Bidders contact scraper.

Scrapes contact information (company, name, email, phone, address) from the
"Prospective Bidders" tab on PlanetBids bid detail pages across multiple
California municipal portals.

Usage:
    python outreach/scrape_contacts.py                    # scrape all portals
    python outreach/scrape_contacts.py --portals 5        # first 5 portals only
    python outreach/scrape_contacts.py --target 200       # stop after 200 contacts
    python outreach/scrape_contacts.py --output my.csv    # custom output path
"""

from __future__ import annotations

import argparse
import asyncio
import csv
import logging
import re
import sys
from dataclasses import dataclass, fields
from pathlib import Path

from playwright.async_api import async_playwright, Page, Browser

# Add project root to path for imports
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from webscraping.v2.scrapers.planetbids import PLANETBIDS_AGENCIES

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────────────────────────────────────
# Data model
# ──────────────────────────────────────────────────────────────────────────────


@dataclass
class Contact:
    company: str = ""
    contact_name: str = ""
    email: str = ""
    phone: str = ""
    address: str = ""
    city: str = ""
    state: str = ""
    agency: str = ""          # issuing agency (e.g. "City of San Diego")
    bid_title: str = ""       # RFP title they were bidding on
    bid_number: str = ""


# ──────────────────────────────────────────────────────────────────────────────
# Parsing
# ──────────────────────────────────────────────────────────────────────────────

def parse_vendor_cell(text: str, agency: str, bid_title: str, bid_number: str) -> Contact:
    """Parse the first <td> of a Prospective Bidders row into a Contact.

    Typical format:
        Company Name
        123 Main St
        City, State ZIP
        Contact: First Last
        Phone: 555-555-5555
        email@example.com
    """
    lines = [l.strip() for l in text.strip().split("\n") if l.strip()]
    contact = Contact(agency=agency, bid_title=bid_title, bid_number=bid_number)

    if not lines:
        return contact

    # First line is always the company name
    contact.company = lines[0]

    for line in lines[1:]:
        if line.lower().startswith("contact:"):
            contact.contact_name = line.split(":", 1)[1].strip()
        elif line.lower().startswith("phone:"):
            contact.phone = line.split(":", 1)[1].strip()
        elif re.match(r"^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$", line):
            contact.email = line
        else:
            # Try to parse as city/state line
            state_match = re.match(
                r"^(.+?),\s*([A-Za-z ]+)\s+\d{5}", line
            )
            if state_match:
                contact.city = state_match.group(1).strip()
                contact.state = state_match.group(2).strip()
            elif not contact.address:
                contact.address = line
            else:
                # Additional address line — append
                contact.address += ", " + line

    return contact


# ──────────────────────────────────────────────────────────────────────────────
# Scraping
# ──────────────────────────────────────────────────────────────────────────────

async def scrape_bid_contacts(page: Page, detail_url: str, agency: str) -> list[Contact]:
    """Navigate to a bid detail page and scrape the Prospective Bidders tab."""
    try:
        await page.goto(detail_url, wait_until="networkidle", timeout=30000)
        await page.wait_for_timeout(2000)
    except Exception as e:
        logger.debug(f"Failed to load {detail_url}: {e}")
        return []

    # Get bid title and number from the page
    bid_title = ""
    bid_number = ""
    try:
        heading = await page.query_selector("h1, h2, .bid-title")
        if heading:
            full_text = (await heading.inner_text()).strip()
            bid_title = full_text
            # Try to extract bid number from the heading
            num_match = re.search(r"(\S+-\d+\S*)\s*$", full_text)
            if num_match:
                bid_number = num_match.group(1)
                bid_title = full_text[:num_match.start()].strip()
    except Exception:
        pass

    # Click "Prospective Bidders" tab
    try:
        tab = await page.query_selector(
            'a:has-text("Prospective Bidders"), '
            'button:has-text("Prospective Bidders"), '
            'li:has-text("Prospective Bidders")'
        )
        if not tab:
            logger.debug(f"No Prospective Bidders tab on {detail_url}")
            return []
        await tab.click()
        await page.wait_for_timeout(2000)
    except Exception as e:
        logger.debug(f"Failed to click Prospective Bidders tab: {e}")
        return []

    # Extract vendor rows
    contacts = []
    rows = await page.query_selector_all("table tbody tr")
    for row in rows:
        cells = await row.query_selector_all("td")
        if not cells:
            continue
        vendor_text = (await cells[0].inner_text()).strip()
        if not vendor_text:
            continue
        contact = parse_vendor_cell(vendor_text, agency, bid_title, bid_number)
        if contact.email:  # only keep contacts with emails
            contacts.append(contact)

    return contacts


async def get_bid_detail_urls(page: Page, portal_url: str) -> list[str]:
    """Get all bid detail URLs from a portal's search page."""
    try:
        await page.goto(portal_url, wait_until="networkidle", timeout=60000)
        await page.wait_for_timeout(3000)
    except Exception as e:
        logger.warning(f"Failed to load portal {portal_url}: {e}")
        return []

    # Filter to "Bidding" status
    try:
        selects = await page.query_selector_all("select.select-field")
        if len(selects) >= 2:
            await selects[1].select_option("3")
            await page.wait_for_timeout(500)
            search_btn = await page.query_selector(
                'button:has-text("Search"), input[type="submit"], button[type="submit"]'
            )
            if search_btn:
                await search_btn.click()
                await page.wait_for_timeout(3000)
    except Exception as e:
        logger.debug(f"Filter failed: {e}")

    # Scroll to load all rows
    prev_count = 0
    for _ in range(30):
        await page.evaluate("""() => {
            const c = document.querySelector('.table-overflow-container');
            if (c) c.scrollTop = c.scrollHeight;
            else window.scrollTo(0, document.body.scrollHeight);
        }""")
        await page.wait_for_timeout(1500)
        rows = await page.query_selector_all("table tbody tr")
        if len(rows) == prev_count:
            break
        prev_count = len(rows)

    # Extract detail URLs from rows
    detail_urls = []
    portal_base = portal_url.split("/bo/")[0] if "/bo/" in portal_url else portal_url
    rows = await page.query_selector_all("table tbody tr")

    for row in rows:
        try:
            # Try clicking the row to see if it navigates
            link = await row.query_selector("a[href]")
            if link:
                href = await link.get_attribute("href")
                if href and "bo-detail" in href:
                    if href.startswith("/"):
                        href = "https://vendors.planetbids.com" + href
                    detail_urls.append(href)
                    continue

            # Try data-itemid attribute on cells
            item_cell = await row.query_selector("td[data-itemid]")
            if item_cell:
                item_id = await item_cell.get_attribute("data-itemid")
                if item_id:
                    detail_urls.append(f"{portal_base}/bo/bo-detail/{item_id}")
                    continue

            # Last resort: try to get the URL by clicking the row
            # Extract the bid number and construct the URL
            cells = await row.query_selector_all("td")
            if len(cells) >= 2:
                # Click the row and capture navigation
                await row.click()
                await page.wait_for_timeout(1500)
                current_url = page.url
                if "bo-detail" in current_url:
                    detail_urls.append(current_url)
                    # Go back to the listing
                    await page.go_back()
                    await page.wait_for_timeout(2000)
        except Exception:
            continue

    logger.info(f"Found {len(detail_urls)} bid detail URLs from {portal_base}")
    return detail_urls


async def scrape_portal_contacts(
    browser: Browser,
    portal_id: str,
    agency_info: dict,
    target: int | None = None,
    seen_emails: set | None = None,
) -> list[Contact]:
    """Scrape all prospective bidder contacts from a single portal."""
    if seen_emails is None:
        seen_emails = set()

    context = await browser.new_context(
        viewport={"width": 1920, "height": 1080},
        user_agent=(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36"
        ),
    )
    page = await context.new_page()
    contacts = []

    try:
        agency_name = agency_info["name"]
        portal_url = agency_info["url"]
        logger.info(f"Scraping portal: {agency_name}")

        detail_urls = await get_bid_detail_urls(page, portal_url)

        for url in detail_urls:
            if target and len(contacts) + len(seen_emails) >= target:
                break

            bid_contacts = await scrape_bid_contacts(page, url, agency_name)
            for c in bid_contacts:
                if c.email not in seen_emails:
                    seen_emails.add(c.email)
                    contacts.append(c)
                    logger.info(
                        f"  [{len(seen_emails)}] {c.contact_name} <{c.email}> @ {c.company}"
                    )

            # Rate limiting
            await page.wait_for_timeout(1500)

    except Exception as e:
        logger.error(f"Error scraping {agency_info['name']}: {e}")
    finally:
        await context.close()

    logger.info(f"Got {len(contacts)} unique contacts from {agency_info['name']}")
    return contacts


# ──────────────────────────────────────────────────────────────────────────────
# Main
# ──────────────────────────────────────────────────────────────────────────────

async def main(
    max_portals: int | None = None,
    target: int = 200,
    output_path: str = "outreach/contacts.csv",
):
    all_contacts: list[Contact] = []
    seen_emails: set[str] = set()
    agencies = list(PLANETBIDS_AGENCIES.items())

    if max_portals:
        agencies = agencies[:max_portals]

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        )

        try:
            for portal_id, agency_info in agencies:
                if len(seen_emails) >= target:
                    logger.info(f"Reached target of {target} contacts, stopping.")
                    break

                contacts = await scrape_portal_contacts(
                    browser, portal_id, agency_info, target, seen_emails
                )
                all_contacts.extend(contacts)
                logger.info(
                    f"Running total: {len(seen_emails)} unique contacts "
                    f"(target: {target})"
                )

        finally:
            await browser.close()

    # Write CSV
    output = Path(output_path)
    output.parent.mkdir(parents=True, exist_ok=True)

    field_names = [f.name for f in fields(Contact)]
    with open(output, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=field_names)
        writer.writeheader()
        for c in all_contacts:
            writer.writerow({fn: getattr(c, fn) for fn in field_names})

    print(f"\nDone! Wrote {len(all_contacts)} contacts to {output}")
    return all_contacts


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Scrape PlanetBids prospective bidder contacts")
    parser.add_argument("--portals", type=int, default=None, help="Max portals to scrape")
    parser.add_argument("--target", type=int, default=200, help="Target number of contacts")
    parser.add_argument("--output", type=str, default="outreach/contacts.csv", help="Output CSV path")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )

    asyncio.run(main(max_portals=args.portals, target=args.target, output_path=args.output))
