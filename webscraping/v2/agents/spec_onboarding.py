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

    try:
        from webscraping.v2 import budget as _budget
        _budget.ensure_budget(0.50, source="investigation")
    except ImportError:
        pass
    except Exception as e:
        from webscraping.v2 import issues as _issues
        _issues.record_issue(
            category=_issues.CATEGORY_BUDGET_EXCEEDED,
            severity=_issues.SEVERITY_WARN,
            source=f"investigate_and_onboard:{url}",
            summary=str(e),
        )
        return SpecOnboardingResult(
            site_id=_site_id_for(slug, "unknown"),
            accepted=False,
            reason=f"budget exhausted before investigation: {e}",
        )

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
# Smart router: known platforms skip the investigation agent
# ---------------------------------------------------------------------------
#
# The exploration agent guesses a `platform_guess` for each candidate
# (opengov / planetbids / bidsync / ...). For platforms we already
# know how to scrape, we can bypass the expensive investigation agent
# entirely:
#
#   - opengov: extract slug from the URL, hand to `agents.onboarding`
#     which probes via `OpenGovScraper` and writes to the per-platform
#     S3 registry. ~$0.001 per candidate vs ~$0.50 for investigation.
#
#   - planetbids / bidsync: ditto pattern; the per-platform scrapers
#     are already there.
#
# If the cheap route fails (URL doesn't match the expected pattern,
# slug 404s the platform API, probe returns no events), we fall back
# to the full investigation agent. That guarantees coverage even if
# the exploration agent's classification was wrong.

import re as _re


_OPENGOV_SLUG_RE = _re.compile(
    r"procurement\.opengov\.com/portal/([^/?#]+)", _re.I
)


def _extract_opengov_slug(url: str) -> Optional[str]:
    m = _OPENGOV_SLUG_RE.search(url or "")
    return m.group(1) if m else None


async def _route_known_opengov(
    *, url: str, agency_name: str
) -> Optional[SpecOnboardingResult]:
    """Try the cheap OpenGov path. Returns None to fall through to investigation."""
    slug = _extract_opengov_slug(url)
    if not slug:
        return None

    from webscraping.v2.agents.discovery import Candidate as DiscoveryCandidate
    from webscraping.v2.agents.onboarding import onboard_one

    site_id = f"opengov_{_re.sub(r'[^a-z0-9]+', '_', slug.lower()).strip('_')}"
    discovery_candidate = DiscoveryCandidate(
        platform="opengov",
        site_id=site_id,
        slug=slug,
        name=agency_name,
        url=url,
        verified=True,  # exploration found it; discovery probe is the real check
    )
    try:
        onboarding_result = await onboard_one(discovery_candidate)
    except Exception as e:
        logger.warning(f"OpenGov cheap-route failed for {url}: {e}")
        return None

    result = SpecOnboardingResult(
        site_id=site_id,
        accepted=onboarding_result.accepted,
        spec_class="opengov_api",
        confidence="high",  # cheap-route only accepts on real-API probe
        events_scraped=onboarding_result.events_scraped,
        pdfs_observed=onboarding_result.pdfs_observed,
        sample_titles=onboarding_result.sample_titles,
        reason=onboarding_result.reason,
        onboarded_at=onboarding_result.onboarded_at,
    )
    return result


async def smart_route_and_onboard(
    *,
    url: str,
    agency_name: str,
    platform_guess: str,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> SpecOnboardingResult:
    """Route by platform_guess, falling back to investigation on failure.

    Today this only short-circuits OpenGov (the only platform with a
    public unauth API discovery path). PlanetBids/BidSync would need
    a slug-extract + auth probe — additive work, same shape.
    """
    pg = (platform_guess or "").lower()

    if pg == "opengov":
        cheap = await _route_known_opengov(url=url, agency_name=agency_name)
        if cheap is not None and cheap.accepted:
            return cheap
        if cheap is not None and not cheap.accepted:
            # Cheap route ran but rejected (probe returned no events,
            # etc.). Fall through to investigation — exploration may
            # have classified wrong, or the OpenGov portal might be
            # uniquely shaped.
            try:
                from webscraping.v2 import issues as _issues
                _issues.record_issue(
                    category=_issues.CATEGORY_ROUTING_FALLBACK,
                    severity=_issues.SEVERITY_INFO,
                    source=f"smart_route:{url}",
                    summary=(
                        f"OpenGov cheap route rejected ({cheap.reason}); "
                        f"falling back to investigation agent"
                    ),
                )
            except Exception:
                pass

    # Fall-through: investigation agent (handles unknown / custom /
    # known-platform-cheap-route-failed). Slug for {slug} substitution
    # is the URL's last path segment if nothing better is available.
    slug = _extract_opengov_slug(url) or _re.sub(
        r"[^a-z0-9-]", "-", (url.rstrip("/").rsplit("/", 1)[-1] or "site").lower()
    )
    return await investigate_and_onboard(
        url=url, slug=slug, name=agency_name,
        model=model, max_turns=max_turns,
    )


async def onboard_explored(
    *,
    category: Optional[str] = None,
    max_candidates: int = 10,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
) -> list[SpecOnboardingResult]:
    """Drain the exploration backlog for `category` (or all categories).

    Iterates candidates discovered by `agents.exploration`, skipping any
    URL already onboarded. Each candidate runs through `smart_route_and_onboard`.
    Loop terminates early on `BudgetExceeded`.
    """
    from webscraping.v2.agents.exploration import (
        ExplorationCandidate,
        _exploration_key,
        _known_skip_set,
        CATEGORIES,
    )

    s3 = get_s3_client()
    cats = [category] if category else list(CATEGORIES.keys())
    skip = _known_skip_set()

    results: list[SpecOnboardingResult] = []
    spent_candidates = 0

    for cat in cats:
        try:
            resp = s3.get_object(Bucket=S3_BUCKET, Key=_exploration_key(cat))
            data = json.loads(resp["Body"].read())
            candidates = data.get("candidates") or []
        except Exception:
            candidates = []

        for c in candidates:
            if spent_candidates >= max_candidates:
                return results
            url = (c.get("url") or "").rstrip("/")
            if not url or url in skip:
                continue

            try:
                from webscraping.v2 import budget as _budget
                # Cheap-route candidates need much less ($0.001); reserve
                # the worst case so we don't start an investigation we
                # can't afford to finish.
                _budget.ensure_budget(0.50, source="onboard_explored")
            except ImportError:
                pass
            except Exception as e:
                from webscraping.v2 import issues as _issues
                _issues.record_issue(
                    category=_issues.CATEGORY_BUDGET_EXCEEDED,
                    severity=_issues.SEVERITY_WARN,
                    source="onboard_explored",
                    summary=str(e),
                    context={"category": cat, "processed": spent_candidates},
                )
                return results

            try:
                result = await smart_route_and_onboard(
                    url=url,
                    agency_name=c.get("agency_name", url),
                    platform_guess=c.get("platform_guess", "unknown"),
                    model=model,
                    max_turns=max_turns,
                )
                results.append(result)
                spent_candidates += 1
                # Add the URL to skip so a downstream candidate that
                # somehow points to the same portal doesn't double-onboard.
                skip.add(url)
            except Exception as e:
                logger.error(f"onboard_explored failed for {url}: {e}")
                from webscraping.v2 import issues as _issues
                _issues.record_issue(
                    category=_issues.CATEGORY_INVESTIGATION_FAILED,
                    severity=_issues.SEVERITY_ERROR,
                    source=f"onboard_explored:{url}",
                    summary=str(e),
                    context={"category": cat},
                )

    return results


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
