"""
Platform discovery agent.

Finds new instances of a given procurement-platform family across CA
state, county, and municipal government. Used to expand coverage —
e.g. enumerate every CA city that has migrated to OpenGov Procurement.

Two-stage flow:
  1. Enumerate candidates with Claude (training-data + iterative refinement).
  2. Verify each candidate with a Playwright probe of the actual URL.

Verified candidates are written to S3 at
`scrapes/v2/discovered/{platform}.json` for human review or for the
onboarding pipeline (`agents.onboarding`) to pick up.

The agent is platform-agnostic — pass the platform name + URL pattern
and a description of what counts as a "valid procurement portal." Each
new family of sites needs only an entry in `PLATFORM_PROFILES`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field, asdict
from typing import Optional

import anthropic
from bs4 import BeautifulSoup
from playwright.async_api import async_playwright

from webscraping.v2.config import (
    ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL,
    S3_BUCKET,
    S3_V2_PREFIX,
    fetch_via_scrapingbee,
    get_s3_client,
    has_scrapingbee_key,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-platform profiles
# ---------------------------------------------------------------------------

@dataclass
class PlatformProfile:
    """Metadata describing a procurement-platform family."""

    name: str  # Internal key — also the registry filename stem.
    display_name: str  # Human-readable.
    url_template: str  # e.g. "https://procurement.opengov.com/portal/{slug}"
    listing_markers: list[str]  # Substrings on page text indicating a real portal.
    enumeration_hint: str  # Extra guidance for Claude (history, common slugs, etc.)
    requires_proxy: bool = False  # Route Playwright probes through ScrapingBee.


PLATFORM_PROFILES: dict[str, PlatformProfile] = {
    "opengov": PlatformProfile(
        name="opengov",
        display_name="OpenGov Procurement",
        url_template="https://procurement.opengov.com/portal/{slug}",
        listing_markers=[
            "OpenGov",
            "Procurement",
            "Bid",
            "Solicitation",
            "Open Projects",
        ],
        enumeration_hint=(
            "OpenGov Procurement (formerly ProcureNow) is a SaaS platform "
            "many California cities have migrated to in 2024-2026. Known "
            "migrations include Pasadena. Slugs are typically the city or "
            "agency name in lowercase, hyphenated where multi-word "
            "(e.g. 'pasadena', 'long-beach', 'culver-city')."
        ),
        # OpenGov fronts every portal with Cloudflare bot detection.
        # Probes from headless Chromium without a stealth proxy hit the
        # "Just a moment" challenge and never resolve.
        requires_proxy=True,
    ),
    # Future platforms wire in by adding entries here.
}


# ---------------------------------------------------------------------------
# Candidate dataclass + S3 persistence
# ---------------------------------------------------------------------------

@dataclass
class Candidate:
    """A discovered-but-not-yet-onboarded procurement portal."""

    platform: str  # e.g. "opengov"
    site_id: str  # e.g. "opengov_long_beach"
    slug: str  # URL slug, e.g. "long-beach"
    name: str  # Human-readable agency name
    url: str  # Full portal URL
    verified: bool = False
    verification_notes: str = ""
    listing_count_observed: int = 0
    page_title_observed: str = ""


def _discovered_s3_key(platform: str) -> str:
    return f"{S3_V2_PREFIX}discovered/{platform}.json"


def save_candidates(platform: str, candidates: list[Candidate]) -> str:
    """Persist candidate list to S3 for human review."""
    s3 = get_s3_client()
    key = _discovered_s3_key(platform)
    body = json.dumps(
        {"platform": platform, "candidates": [asdict(c) for c in candidates]},
        indent=2,
    )
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=body,
        ContentType="application/json",
    )
    logger.info(
        f"Saved {len(candidates)} candidates ({sum(1 for c in candidates if c.verified)} verified) "
        f"to s3://{S3_BUCKET}/{key}"
    )
    return key


def load_candidates(platform: str) -> list[Candidate]:
    """Load previously-saved candidate list from S3."""
    s3 = get_s3_client()
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_discovered_s3_key(platform))
        data = json.loads(resp["Body"].read())
        return [Candidate(**c) for c in data.get("candidates", [])]
    except Exception:
        return []


# ---------------------------------------------------------------------------
# Stage 1: Enumerate via Claude
# ---------------------------------------------------------------------------

ENUMERATION_SYSTEM_PROMPT = """You enumerate California state, county, and \
municipal government agencies that use a specific procurement platform.

You return ONLY valid JSON in this shape:
{
  "candidates": [
    {"slug": "<URL slug>", "name": "<full agency name>"},
    ...
  ]
}

Rules:
- Only include California agencies.
- Slugs should match the platform's URL conventions.
- Prefer high-confidence entries — do not invent agencies you are not >70% sure use this platform.
- Skip the example/seed agency the caller already knows about.
- Do not wrap the JSON in markdown.
"""


def _claude() -> anthropic.Anthropic:
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY required for discovery agent")
    return anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)


def _parse_json(text: str) -> dict:
    if "```" in text:
        m = re.search(r"```(?:json)?\s*\n?(.*?)```", text, re.DOTALL)
        if m:
            text = m.group(1)
    return json.loads(text.strip())


def enumerate_candidates(
    platform_name: str,
    seed_known: Optional[list[str]] = None,
) -> list[Candidate]:
    """Ask Claude for candidate agencies on the given platform."""
    profile = PLATFORM_PROFILES.get(platform_name)
    if not profile:
        raise ValueError(f"Unknown platform: {platform_name}")

    seed_known = seed_known or []
    seed_text = (
        f"\nAlready known (skip these): {', '.join(seed_known)}"
        if seed_known else ""
    )

    user_prompt = f"""Enumerate California government agencies that use \
{profile.display_name}.

Platform context:
{profile.enumeration_hint}

URL template: {profile.url_template}{seed_text}

Return up to 30 candidates as JSON.
"""

    client = _claude()
    response = client.messages.create(
        model=ANTHROPIC_MODEL,
        max_tokens=2000,
        temperature=0.0,
        system=ENUMERATION_SYSTEM_PROMPT,
        messages=[{"role": "user", "content": user_prompt}],
    )
    raw = "".join(
        block.text for block in response.content
        if getattr(block, "type", "") == "text"
    )

    parsed = _parse_json(raw)
    out: list[Candidate] = []
    for entry in parsed.get("candidates", []):
        slug = (entry.get("slug") or "").strip()
        name = (entry.get("name") or "").strip()
        if not slug or not name:
            continue
        site_id = f"{platform_name}_{re.sub(r'[^a-z0-9]+', '_', slug.lower())}".strip("_")
        out.append(
            Candidate(
                platform=platform_name,
                site_id=site_id,
                slug=slug,
                name=name,
                url=profile.url_template.format(slug=slug),
            )
        )
    return out


# ---------------------------------------------------------------------------
# Stage 2: Verify each candidate
# ---------------------------------------------------------------------------
#
# Two probe paths exist:
#   - Playwright (direct headless Chromium): for platforms with no
#     bot-detection layer.
#   - ScrapingBee API mode (`fetch_via_scrapingbee` + BeautifulSoup):
#     for `requires_proxy=True` platforms. The Cloudflare challenge in
#     front of OpenGov can't be solved with vanilla headless Chromium,
#     and ScrapingBee's *proxy* endpoint doesn't expose stealth_proxy,
#     so Playwright-via-proxy was abandoned in favor of API mode.

# Cloudflare/anti-bot interstitial markers. Listing-marker keyword
# matching false-positives on these pages because the challenge body
# usually contains the platform domain (e.g. "procurement.opengov.com"
# matches "OpenGov" and "Procurement").
_BLOCKED_TITLE_TOKENS = ("just a moment", "attention required")
_BLOCKED_BODY_TOKENS = (
    "performing security verification",
    "verifying you are human",
    "ray id:",
)


def _is_blocked(title: str, body_text: str) -> bool:
    title_lower = (title or "").lower()
    head = (body_text or "")[:1500].lower()
    if any(t in title_lower for t in _BLOCKED_TITLE_TOKENS):
        return True
    return any(t in head for t in _BLOCKED_BODY_TOKENS)


def _evaluate_probe(
    candidate: Candidate,
    profile: PlatformProfile,
    title: str,
    body_text: str,
    listing_count: int,
) -> None:
    """Apply the verified-or-not decision based on observed markers."""
    candidate.page_title_observed = (title or "")[:160]
    candidate.listing_count_observed = listing_count

    if _is_blocked(title, body_text):
        candidate.verification_notes = (
            f"blocked: anti-bot challenge (title='{title[:60]}')"
        )
        return

    text_lower = (body_text or "").lower()
    title_lower = (title or "").lower()
    matches = [m for m in profile.listing_markers if m.lower() in text_lower]

    if (
        len(matches) >= 2
        and "404" not in title_lower
        and "not found" not in text_lower[:500]
    ):
        candidate.verified = True
        candidate.verification_notes = (
            f"matches={matches}, listings={listing_count}"
        )
    else:
        candidate.verification_notes = (
            f"weak: matches={matches}, listings={listing_count}"
        )


async def _probe_one_playwright(
    page, candidate: Candidate, profile: PlatformProfile
) -> None:
    try:
        # networkidle hangs on SPA-style portals; use domcontentloaded
        # and a hard settle, then read DOM state.
        await page.goto(candidate.url, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)
    except Exception as e:
        candidate.verification_notes = f"goto failed: {e}"
        return

    title = await page.title()
    body_text = await page.evaluate(
        "() => (document.body ? document.body.innerText : '').slice(0, 6000)"
    )
    listing_count = await page.evaluate(
        """() => document.querySelectorAll('a[href*="/projects/"]').length"""
    )
    _evaluate_probe(candidate, profile, title, body_text, listing_count)


def _probe_one_scrapingbee(
    candidate: Candidate, profile: PlatformProfile
) -> None:
    try:
        html = fetch_via_scrapingbee(candidate.url)
    except Exception as e:
        candidate.verification_notes = f"scrapingbee fetch failed: {e}"
        return

    soup = BeautifulSoup(html, "html.parser")
    title_el = soup.find("title")
    title = title_el.get_text(strip=True) if title_el else ""
    body_text = (soup.body.get_text(" ", strip=True) if soup.body else "")[:6000]

    # OpenGov listings expose bid links as <a href="#"> (the React
    # detail navigation is in JS state, not the href). Counting
    # /projects/ anchors — as the Playwright probe used to do — finds
    # zero on real portals. Instead, count anchors with non-trivial
    # text inside the page body, which mirrors what the scraper
    # actually parses.
    listing_count = 0
    if soup.body is not None:
        for a in soup.body.find_all("a"):
            if a.find_parent(["nav", "header", "footer"]):
                continue
            t = a.get_text(strip=True) or ""
            if 8 <= len(t) <= 240:
                listing_count += 1

    _evaluate_probe(candidate, profile, title, body_text, listing_count)


async def verify_candidates(
    platform_name: str,
    candidates: list[Candidate],
    concurrency: int = 5,
) -> list[Candidate]:
    """Probe each candidate URL; populate verified flag.

    Forks on `profile.requires_proxy`:
      - True  → ScrapingBee API mode (sync HTTP, offloaded to threads).
      - False → Playwright direct.

    Probes run in parallel (semaphore-bounded) so the whole verification
    pass fits inside Lambda's 15-min timeout.
    """
    profile = PLATFORM_PROFILES[platform_name]

    if profile.requires_proxy:
        if not has_scrapingbee_key():
            logger.warning(
                f"Discovery: {platform_name} requires_proxy=True but no "
                f"SCRAPINGBEE_API_KEY configured — probes will fail"
            )
        else:
            logger.info(
                f"Discovery: routing {platform_name} probes through "
                f"ScrapingBee API mode"
            )
        await _verify_via_scrapingbee(candidates, profile, concurrency)
    else:
        await _verify_via_playwright(candidates, profile, concurrency)

    return candidates


async def _verify_via_scrapingbee(
    candidates: list[Candidate],
    profile: PlatformProfile,
    concurrency: int,
) -> None:
    sem = asyncio.Semaphore(concurrency)
    completed = {"n": 0}
    total = len(candidates)

    async def probe(c: Candidate) -> None:
        async with sem:
            try:
                await asyncio.to_thread(_probe_one_scrapingbee, c, profile)
            except Exception as e:
                c.verification_notes = f"probe error: {e}"
            finally:
                completed["n"] += 1
                logger.info(
                    f"  Probed [{completed['n']}/{total}] {c.site_id} "
                    f"-> {'OK' if c.verified else 'reject'}"
                )

    await asyncio.gather(*(probe(c) for c in candidates))


async def _verify_via_playwright(
    candidates: list[Candidate],
    profile: PlatformProfile,
    concurrency: int,
) -> None:
    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--disable-gpu",
                "--single-process",
            ],
        )
        context = await browser.new_context(
            viewport={"width": 1920, "height": 1080},
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
        )
        await context.add_init_script(
            'Object.defineProperty(navigator, "webdriver", '
            '{get: () => undefined});'
        )

        sem = asyncio.Semaphore(concurrency)
        completed = {"n": 0}
        total = len(candidates)

        async def probe(c: Candidate) -> None:
            async with sem:
                page = await context.new_page()
                try:
                    await _probe_one_playwright(page, c, profile)
                except Exception as e:
                    c.verification_notes = f"probe error: {e}"
                finally:
                    completed["n"] += 1
                    logger.info(
                        f"  Probed [{completed['n']}/{total}] {c.site_id} "
                        f"-> {'OK' if c.verified else 'reject'}"
                    )
                    try:
                        await page.close()
                    except Exception:
                        pass

        try:
            await asyncio.gather(*(probe(c) for c in candidates))
        finally:
            await browser.close()


# ---------------------------------------------------------------------------
# Top-level entry point
# ---------------------------------------------------------------------------

def known_seed_for(platform_name: str) -> list[str]:
    """Names of already-onboarded portals for this platform — fed back to
    Claude as a 'skip these' hint."""
    if platform_name == "opengov":
        from webscraping.v2.scrapers.opengov import OPENGOV_AGENCIES
        return [a["name"] for a in OPENGOV_AGENCIES.values()]
    return []


async def discover_platform(platform_name: str) -> list[Candidate]:
    """Run discovery end-to-end: enumerate → verify → save to S3."""
    logger.info(f"=== Discovery: {platform_name} ===")
    seed = known_seed_for(platform_name)
    logger.info(f"Skipping {len(seed)} already-known portals")

    candidates = enumerate_candidates(platform_name, seed_known=seed)
    logger.info(f"Claude returned {len(candidates)} candidates")

    if not candidates:
        return []

    candidates = await verify_candidates(platform_name, candidates)
    verified = [c for c in candidates if c.verified]
    logger.info(
        f"Verified {len(verified)}/{len(candidates)} candidates "
        f"({len(candidates) - len(verified)} rejected)"
    )

    save_candidates(platform_name, candidates)
    return candidates


def main():
    """CLI: python -m webscraping.v2.agents.discovery opengov"""
    import sys
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(message)s"
    )
    platform = sys.argv[1] if len(sys.argv) > 1 else "opengov"
    candidates = asyncio.run(discover_platform(platform))
    print(f"\nFinal: {len(candidates)} candidates")
    for c in candidates:
        marker = "OK" if c.verified else "..."
        print(f"  [{marker}] {c.site_id}: {c.name} — {c.verification_notes}")


if __name__ == "__main__":
    main()
