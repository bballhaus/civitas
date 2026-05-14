"""
Spec-driven onboarding — connects `agents.site_investigation` to the
runtime `scrapers.spec_driven.SpecDrivenScraper` via an S3 registry.

The investigation agent emits an `InvestigationSpec` for a portal URL.
This module:
  1. Builds a `SiteConfig` from the spec + slug/name.
  2. Probes the portal with `SpecDrivenScraper` (a real scrape pass,
     bounded to PROBE_BATCH_SIZE events).
  3. If the probe yields ≥ MIN_EVENTS with a real title, writes the spec
     to `scrapes/v2/spec_sites/{site_id}.json` so the next runner pickup
     includes the portal — no code deploy.

Failures are logged to `scrapes/v2/spec_sites/_failures.json` rather than
silently dropped, so the human reviewing onboarding has an audit trail.

Distinct from `agents.onboarding`: that module promotes pre-verified
candidates onto a known platform's registry (today only OpenGov). This
module is platform-agnostic — the spec IS the platform definition.

Usage:
    python -m webscraping.v2.agents.spec_onboarding \\
        https://procurement.opengov.com/portal/long-beach \\
        --slug long-beach --name "City of Long Beach"

Lambda invocation (when wired):
    {"mode":"investigate_and_onboard","url":"...","slug":"...","name":"..."}
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Optional

from webscraping.v2.agents.site_investigation import (
    DEFAULT_MAX_TURNS,
    DEFAULT_MODEL,
    InvestigationSpec,
    run_investigation,
)
from webscraping.v2.config import S3_BUCKET, get_s3_client
from webscraping.v2.models import RawScrapedEvent, ScraperType, SiteConfig
from webscraping.v2.scrapers.spec_driven import SpecDrivenScraper

logger = logging.getLogger(__name__)


MIN_EVENTS_TO_ACCEPT = 1
PROBE_BATCH_SIZE = 5
SPEC_SITES_PREFIX = "scrapes/v2/spec_sites/"
SPEC_FAILURES_KEY = f"{SPEC_SITES_PREFIX}_failures.json"


@dataclass
class SpecOnboardingResult:
    site_id: str
    accepted: bool
    spec_class: str = ""
    confidence: str = ""
    events_scraped: int = 0
    pdfs_observed: int = 0
    sample_titles: list[str] = field(default_factory=list)
    reason: str = ""
    onboarded_at: str = ""


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _spec_site_key(site_id: str) -> str:
    return f"{SPEC_SITES_PREFIX}{site_id}.json"


def save_spec_site(
    *,
    site_id: str,
    slug: str,
    name: str,
    url: str,
    spec: InvestigationSpec,
) -> str:
    """Write a vetted spec into the S3 registry. Returns the S3 key."""
    body = {
        "site_id": site_id,
        "slug": slug,
        "name": name,
        "url": url,
        "spec": spec.model_dump(),
        "onboarded_at": datetime.utcnow().isoformat(),
    }
    key = _spec_site_key(site_id)
    s3 = get_s3_client()
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=json.dumps(body, indent=2),
        ContentType="application/json",
    )
    logger.info(f"Registered spec site s3://{S3_BUCKET}/{key}")
    return key


def _append_failure(record: dict) -> None:
    s3 = get_s3_client()
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=SPEC_FAILURES_KEY)
        failures = json.loads(resp["Body"].read())
        if not isinstance(failures, list):
            failures = []
    except Exception:
        failures = []
    failures.append(record)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=SPEC_FAILURES_KEY,
        Body=json.dumps(failures, indent=2),
        ContentType="application/json",
    )


# ---------------------------------------------------------------------------
# Probe + onboard
# ---------------------------------------------------------------------------

def _site_id_for(slug: str, platform_class: str) -> str:
    """Build a stable site_id from slug + platform class.

    Format: `spec_{platform}_{slug}`. The `spec_` prefix marks dynamic
    onboards (vs in-code seed entries like `opengov_pasadena`); the
    platform class makes it readable in the registry listing.
    """
    safe_slug = re.sub(r"[^a-z0-9]+", "_", slug.lower()).strip("_") or "unknown"
    safe_class = re.sub(r"[^a-z0-9]+", "_", platform_class.lower()).strip("_") or "custom"
    return f"spec_{safe_class}_{safe_slug}"


async def probe_spec(
    *,
    site_id: str,
    slug: str,
    name: str,
    url: str,
    spec: InvestigationSpec,
) -> SpecOnboardingResult:
    """Run a bounded scrape pass with the spec and decide if it's usable."""
    result = SpecOnboardingResult(
        site_id=site_id,
        accepted=False,
        spec_class=spec.platform_class,
        confidence=spec.confidence,
    )

    config = SiteConfig(
        site_id=site_id,
        name=name,
        url=url,
        scraper_type=ScraperType.SPEC_DRIVEN,
        min_request_interval_ms=4000,
        config={
            "slug": slug,
            "name": name,
            "url": url,
            "spec": spec.model_dump(),
        },
    )

    try:
        scraper = SpecDrivenScraper(config, batch_size=PROBE_BATCH_SIZE)
    except Exception as e:
        result.reason = f"spec invalid: {e}"
        return result

    events: list[RawScrapedEvent] = []
    try:
        events = await scraper.run()
    except NotImplementedError as e:
        result.reason = f"unsupported spec: {e}"
        return result
    except Exception as e:
        result.reason = f"probe scrape failed: {e}"
        return result

    result.events_scraped = len(events)
    result.sample_titles = [e.title[:80] for e in events[:5]]
    result.pdfs_observed = sum(len(e.attachment_urls) for e in events)

    if len(events) < MIN_EVENTS_TO_ACCEPT:
        result.reason = f"too few events ({len(events)} < {MIN_EVENTS_TO_ACCEPT})"
        return result
    if not any(e.title for e in events):
        result.reason = "no titles extracted"
        return result

    result.accepted = True
    result.onboarded_at = datetime.utcnow().isoformat()
    return result


async def investigate_and_onboard(
    *,
    url: str,
    slug: str,
    name: str,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> SpecOnboardingResult:
    """End-to-end: run the agent → probe the spec → register on success."""
    logger.info(f"=== Investigation+onboard: {url} (slug={slug}) ===")

    spec = await run_investigation(url, model=model, max_turns=max_turns)
    if spec is None:
        result = SpecOnboardingResult(
            site_id=_site_id_for(slug, "unknown"),
            accepted=False,
            reason="investigation agent returned no spec",
        )
        _append_failure({"url": url, "slug": slug, "result": asdict(result)})
        return result

    site_id = _site_id_for(slug, spec.platform_class)
    result = await probe_spec(
        site_id=site_id, slug=slug, name=name, url=url, spec=spec
    )

    if result.accepted:
        save_spec_site(
            site_id=site_id, slug=slug, name=name, url=url, spec=spec
        )
        logger.info(
            f"ACCEPTED {site_id}: {result.events_scraped} events, "
            f"{result.pdfs_observed} PDFs, confidence={result.confidence}"
        )
    else:
        logger.warning(f"REJECTED {site_id}: {result.reason}")
        _append_failure({
            "url": url,
            "slug": slug,
            "name": name,
            "spec": spec.model_dump(),
            "result": asdict(result),
            "ts": datetime.utcnow().isoformat(),
        })

    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Investigate a portal and onboard it via spec_sites/ if usable",
    )
    parser.add_argument("url", help="Portal URL to investigate")
    parser.add_argument("--slug", required=True, help="Per-portal slug for {slug} substitution")
    parser.add_argument("--name", required=True, help="Agency display name")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )

    result = asyncio.run(
        investigate_and_onboard(
            url=args.url,
            slug=args.slug,
            name=args.name,
            model=args.model,
            max_turns=args.max_turns,
        )
    )
    print(json.dumps(asdict(result), indent=2, default=str))


if __name__ == "__main__":
    main()
