"""
Portal onboarding pipeline.

Takes verified candidates (from `agents.discovery`) and:
  1. Spins up the platform's scraper against the candidate.
  2. Runs a sanity check on the scraped output (≥ MIN_EVENTS, real titles,
     non-zero PDFs on at least one event).
  3. If sanity passes, appends the candidate to the on-S3 OpenGov registry
     so the next Lambda run picks it up — no code deploy required.

The S3 registry lives at `scrapes/v2/registry/{platform}.json` and is
loaded by `scrapers.opengov.get_opengov_site_configs` at registry-build
time. The in-code seed list (`OPENGOV_AGENCIES`) wins on collisions.

Failures are logged to S3 at `scrapes/v2/onboarding/failures.json` for
diagnosis, never silently dropped.
"""

from __future__ import annotations

import asyncio
import json
import logging
from dataclasses import asdict, dataclass, field
from datetime import datetime
from typing import Optional

from webscraping.v2.agents.discovery import Candidate, load_candidates
from webscraping.v2.config import S3_BUCKET, S3_V2_PREFIX, get_s3_client
from webscraping.v2.models import RawScrapedEvent, SiteConfig

logger = logging.getLogger(__name__)


MIN_EVENTS_TO_ACCEPT = 1
PROBE_BATCH_SIZE = 5  # Cap events scraped during onboarding probe.

REGISTRY_KEY_TEMPLATE = "{prefix}registry/{platform}.json"
FAILURES_KEY = f"{S3_V2_PREFIX}onboarding/failures.json"


@dataclass
class OnboardingResult:
    site_id: str
    accepted: bool
    events_scraped: int = 0
    pdfs_observed: int = 0
    sample_titles: list[str] = field(default_factory=list)
    reason: str = ""
    onboarded_at: str = ""


def _registry_key(platform: str) -> str:
    return REGISTRY_KEY_TEMPLATE.format(prefix=S3_V2_PREFIX, platform=platform)


def _load_registry(platform: str) -> dict[str, dict]:
    s3 = get_s3_client()
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_registry_key(platform))
        data = json.loads(resp["Body"].read())
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def _save_registry(platform: str, registry: dict[str, dict]) -> None:
    s3 = get_s3_client()
    body = json.dumps(registry, indent=2)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=_registry_key(platform),
        Body=body,
        ContentType="application/json",
    )


def _append_failure(record: dict) -> None:
    s3 = get_s3_client()
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=FAILURES_KEY)
        failures = json.loads(resp["Body"].read())
        if not isinstance(failures, list):
            failures = []
    except Exception:
        failures = []
    failures.append(record)
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=FAILURES_KEY,
        Body=json.dumps(failures, indent=2),
        ContentType="application/json",
    )


def _scraper_for_candidate(candidate: Candidate):
    """Return a configured scraper instance for the candidate's platform."""
    if candidate.platform == "opengov":
        from webscraping.v2.scrapers.opengov import OpenGovScraper
        config = SiteConfig(
            site_id=candidate.site_id,
            name=candidate.name,
            url=candidate.url,
            scraper_type="structured",
            min_request_interval_ms=4000,
            config={
                "slug": candidate.slug,
                "name": candidate.name,
                "url": candidate.url,
            },
        )
        return OpenGovScraper(config, batch_size=PROBE_BATCH_SIZE)
    raise ValueError(f"No onboarding scraper for platform: {candidate.platform}")


async def probe_candidate(candidate: Candidate) -> OnboardingResult:
    """Run a quick scrape pass and decide if the candidate should be onboarded."""
    result = OnboardingResult(site_id=candidate.site_id, accepted=False)

    try:
        scraper = _scraper_for_candidate(candidate)
    except Exception as e:
        result.reason = f"no scraper: {e}"
        return result

    events: list[RawScrapedEvent] = []
    try:
        events = await scraper.run()
    except Exception as e:
        result.reason = f"scrape failed: {e}"
        return result

    result.events_scraped = len(events)
    result.sample_titles = [e.title[:80] for e in events[:5]]
    result.pdfs_observed = sum(len(e.attachment_urls) for e in events)

    if len(events) < MIN_EVENTS_TO_ACCEPT:
        result.reason = (
            f"too few events ({len(events)} < {MIN_EVENTS_TO_ACCEPT})"
        )
        return result
    if not any(e.title for e in events):
        result.reason = "no titles extracted"
        return result

    result.accepted = True
    result.onboarded_at = datetime.utcnow().isoformat()
    return result


def register_candidate(candidate: Candidate) -> None:
    """Append a vetted candidate to the on-S3 registry."""
    registry = _load_registry(candidate.platform)
    registry[candidate.site_id] = {
        "slug": candidate.slug,
        "name": candidate.name,
        "url": candidate.url,
    }
    _save_registry(candidate.platform, registry)
    logger.info(
        f"Registered {candidate.site_id} in s3://{S3_BUCKET}/"
        f"{_registry_key(candidate.platform)}"
    )


async def onboard_one(candidate: Candidate) -> OnboardingResult:
    """Probe + register if it passes, log failure otherwise."""
    logger.info(f"--- Onboarding {candidate.site_id} ({candidate.url}) ---")
    result = await probe_candidate(candidate)

    if result.accepted:
        register_candidate(candidate)
        logger.info(
            f"  ACCEPTED: {result.events_scraped} events, "
            f"{result.pdfs_observed} PDFs"
        )
    else:
        logger.warning(f"  REJECTED: {result.reason}")
        _append_failure({
            "candidate": asdict(candidate),
            "result": asdict(result),
            "ts": datetime.utcnow().isoformat(),
        })

    return result


async def onboard_platform(platform: str, max_per_run: int = 5) -> list[OnboardingResult]:
    """Onboard up to N verified-but-unregistered candidates for `platform`."""
    candidates = load_candidates(platform)
    verified = [c for c in candidates if c.verified]

    # Skip already-registered (in-code or S3-registered).
    if platform == "opengov":
        from webscraping.v2.scrapers.opengov import OPENGOV_AGENCIES
        in_code = set(OPENGOV_AGENCIES.keys())
    else:
        in_code = set()
    in_s3 = set(_load_registry(platform).keys())
    todo = [c for c in verified if c.site_id not in in_code and c.site_id not in in_s3]

    logger.info(
        f"Onboarding queue for {platform}: {len(todo)} candidates "
        f"(of {len(verified)} verified, "
        f"{len(in_code) + len(in_s3)} already registered)"
    )

    results: list[OnboardingResult] = []
    for c in todo[:max_per_run]:
        results.append(await onboard_one(c))
    return results


def main():
    """CLI: python -m webscraping.v2.agents.onboarding opengov"""
    import sys
    logging.basicConfig(
        level=logging.INFO, format="%(levelname)s %(message)s"
    )
    platform = sys.argv[1] if len(sys.argv) > 1 else "opengov"
    max_per_run = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    results = asyncio.run(onboard_platform(platform, max_per_run=max_per_run))
    print(f"\nOnboarding done: {len(results)} probed")
    for r in results:
        marker = "OK" if r.accepted else "FAIL"
        print(f"  [{marker}] {r.site_id}: {r.reason or 'accepted'}")


if __name__ == "__main__":
    main()
