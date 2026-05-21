"""
AWS Lambda handler for the Civitas RFP scraping system.

Supports three invocation modes:

1. Single site with chained batching (Cal eProcure):
    {"site_id": "caleprocure", "batch_offset": 0, "batch_size": 15}

2. Multiple sites in one invocation, with optional chained continuation:
    {"sites": ["planetbids_san_diego", "planetbids_fresno"],
     "remaining_sites": ["planetbids_anaheim", ...],
     "skip_enrich": false}

3. All sites (dispatches batched invocations):
    {"mode": "all"}

Batched chaining: mode=all splits all sites into batches of BATCH_SIZE,
fires Cal eProcure and BidSync as separate invocations, then chains
PlanetBids + agentic sites in groups of BATCH_SIZE. Each batch self-invokes
with the next group until all sites are processed.
"""

import asyncio
import glob
import json
import logging
import os
import shutil
import time
import traceback

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)

# One portal per invocation. The new market-intel scraping clicks 3 extra
# tabs per detail page; large portals (San Diego, Anaheim) push close to or
# past the 15min Lambda timeout. Single-portal batches give each its own
# full timeout budget.
BATCH_SIZE = 1

# Seconds the next chained invocation should sleep before starting work.
# Combined with chain-first dispatch (chain fires BEFORE current scrape),
# this serializes portals — invocation N+1 sleeps while N runs.
CHAIN_STAGGER_SECONDS = 360  # 6 minutes

# Wave-based dispatch for mode=all. Cumulative-delay fan-out is unsafe:
# Lambda timeout is 900s, so any portal scheduled with
# delay_before_start > ~900s dies inside time.sleep() before its scrape or
# chain-first dispatch ever runs. We instead fire the queue in waves, where
# each wave dispatches up to DISPATCH_WAVE_SIZE portals (each with a small
# in-wave stagger) and then chains the next wave via a self-invocation
# whose own delay fits comfortably in the Lambda budget.
#
# Sizing is constrained by the AWS account concurrency limit (currently 10).
# Each active portal also fires within-portal chain invocations (chain-first
# pattern in _handle_single_site), so realistic slot use ≈ 2 per active
# portal. Wave size 4 keeps total in-flight ≤ ~9: 4 active portals × 2 +
# 1 dispatch_queue Lambda during its inter-wave sleep.
DISPATCH_PORTAL_STAGGER = 90   # seconds between adjacent portals in a wave
DISPATCH_WAVE_SIZE = 4         # portals per wave (concurrency=10-safe)
# Wave duration: 4 * 90 = 360s. Last portal in wave gets delay=270s,
# leaves ≥ 630s for scrape work. dispatch_queue Lambda sleeps ≤ 360s
# between waves, fires fast.


def _batch_size_for(event: dict) -> int:
    return BATCH_SIZE


def handler(event, context):
    """Lambda entry point supporting single-site, multi-site, and run-all modes."""

    # Always clean up /tmp at the start to handle warm container reuse
    _cleanup_tmp()

    mode = event.get("mode")

    if mode == "discover":
        return _handle_discover(event)
    if mode == "onboard":
        return _handle_onboard(event)
    if mode == "investigate_and_onboard":
        return _handle_investigate_and_onboard(event)
    if mode == "explore":
        return _handle_explore(event)
    if mode == "onboard_explored":
        return _handle_onboard_explored(event)
    if mode == "daily_pipeline":
        return _handle_daily_pipeline(event, context)
    if mode == "monitor":
        return _handle_monitor(event)
    if mode == "dispatch_queue":
        return _handle_dispatch_queue(event, context)
    if mode == "enrich_backfill":
        return _handle_enrich_backfill(event, context)

    # Mode 1: Multi-site batch (with optional chaining)
    sites = event.get("sites", [])
    if sites:
        return _handle_multi_site(sites, event, context)

    # Mode 2: Run all sites (dispatches batched invocations)
    if mode == "all":
        return _handle_run_all(event, context)

    # Mode 3: Single site with chained batching
    site_id = event.get("site_id", os.environ.get("SITE_ID", ""))
    if not site_id:
        return {
            "statusCode": 400,
            "body": (
                "site_id, sites, mode=all, mode=discover, mode=onboard, "
                "or mode=monitor is required"
            ),
        }

    return _handle_single_site(site_id, event, context)


def _handle_discover(event: dict) -> dict:
    """Trigger the discovery agent for a given platform."""
    platform = event.get("platform", "opengov")
    try:
        from webscraping.v2.agents.discovery import discover_platform
        candidates = asyncio.get_event_loop().run_until_complete(
            discover_platform(platform)
        )
        verified = sum(1 for c in candidates if c.verified)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "mode": "discover",
                "platform": platform,
                "total_candidates": len(candidates),
                "verified": verified,
            }),
        }
    except Exception as e:
        logger.error(f"Discovery failed: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({"mode": "discover", "error": str(e)}),
        }


def _handle_onboard(event: dict) -> dict:
    """Probe verified candidates and register the ones that scrape OK."""
    platform = event.get("platform", "opengov")
    max_per_run = int(event.get("max_per_run", 5))
    try:
        from webscraping.v2.agents.onboarding import onboard_platform
        results = asyncio.get_event_loop().run_until_complete(
            onboard_platform(platform, max_per_run=max_per_run)
        )
        accepted = sum(1 for r in results if r.accepted)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "mode": "onboard",
                "platform": platform,
                "probed": len(results),
                "accepted": accepted,
                "rejected": len(results) - accepted,
            }),
        }
    except Exception as e:
        logger.error(f"Onboarding failed: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({"mode": "onboard", "error": str(e)}),
        }


def _handle_investigate_and_onboard(event: dict) -> dict:
    """Smart-routed onboarding for a single URL.

    Routes by platform_guess (auto-detected from the URL if not given):
      - opengov / planetbids / bidsync → cheap path (~$0.001)
      - unknown / custom               → investigation agent (~$0.50)

    Payload:
      {"mode":"investigate_and_onboard",
       "url": "https://...",
       "name": "Agency Name",            # required
       "platform_guess": "opengov",     # optional; auto-classified from URL otherwise
       "slug": "...",                   # optional; legacy, ignored by the cheap path
       "max_turns": 35}
    """
    url = event.get("url")
    name = event.get("name")
    if not (url and name):
        return {
            "statusCode": 400,
            "body": json.dumps({
                "mode": "investigate_and_onboard",
                "error": "url and name are required",
            }),
        }

    platform_guess = (event.get("platform_guess") or "").lower().strip()
    if not platform_guess:
        try:
            from webscraping.v2.agents.exploration import classify_url
            platform_guess = classify_url(url)
        except Exception:
            platform_guess = "unknown"

    try:
        from webscraping.v2.agents.spec_onboarding import smart_route_and_onboard
        result = asyncio.get_event_loop().run_until_complete(
            smart_route_and_onboard(
                url=url,
                agency_name=name,
                platform_guess=platform_guess,
                max_turns=int(event.get("max_turns", 35)),
            )
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "mode": "investigate_and_onboard",
                "platform_guess": platform_guess,
                "site_id": result.site_id,
                "accepted": result.accepted,
                "spec_class": result.spec_class,
                "confidence": result.confidence,
                "events_scraped": result.events_scraped,
                "pdfs_observed": result.pdfs_observed,
                "reason": result.reason,
            }),
        }
    except Exception as e:
        logger.error(f"investigate_and_onboard failed: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({
                "mode": "investigate_and_onboard",
                "error": str(e),
            }),
        }


def _handle_explore(event: dict) -> dict:
    """Run the exploration agent for one category."""
    category = event.get("category")
    if not category:
        return {
            "statusCode": 400,
            "body": json.dumps({
                "mode": "explore",
                "error": "category is required",
            }),
        }
    try:
        from webscraping.v2.agents.exploration import run_exploration
        candidates = asyncio.get_event_loop().run_until_complete(
            run_exploration(
                category,
                max_turns=int(event.get("max_turns", 40)),
            )
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "mode": "explore",
                "category": category,
                "new_candidates": len(candidates),
            }),
        }
    except Exception as e:
        logger.error(f"Explore failed: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({"mode": "explore", "error": str(e)}),
        }


def _handle_onboard_explored(event: dict) -> dict:
    """Drain exploration candidates through smart-routed onboarding."""
    category = event.get("category")  # None = all categories
    max_candidates = int(event.get("max_candidates", 10))
    try:
        from webscraping.v2.agents.spec_onboarding import onboard_explored
        results = asyncio.get_event_loop().run_until_complete(
            onboard_explored(
                category=category,
                max_candidates=max_candidates,
                max_turns=int(event.get("max_turns", 35)),
            )
        )
        accepted = sum(1 for r in results if r.accepted)
        return {
            "statusCode": 200,
            "body": json.dumps({
                "mode": "onboard_explored",
                "category": category,
                "probed": len(results),
                "accepted": accepted,
                "rejected": len(results) - accepted,
            }),
        }
    except Exception as e:
        logger.error(f"onboard_explored failed: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({"mode": "onboard_explored", "error": str(e)}),
        }


# Categories rotate so each is freshly explored once every 9 days. The
# daily pipeline picks `EXPLORATION_CATEGORIES[day_of_year % len(...)]`.
EXPLORATION_CATEGORIES = [
    "ca_counties",
    "ca_cities",
    "uc_system",
    "csu_system",
    "community_colleges",
    "judicial",
    "state_agencies",
    "transit_utility",
    "emerging_platforms",
]


def _handle_daily_pipeline(event: dict, context) -> dict:
    """One Lambda invocation = one day's exploration + onboarding pass.

    Sequence:
      1. Explore one rotating category (cheap; ~$1).
      2. Drain `max_candidates` of the candidate backlog via smart
         routing (cheap for known platforms, expensive for unknowns).

    The budget meter (webscraping/v2/budget.py) hard-caps total spend
    today. Either step can abort early on BudgetExceeded — pipeline
    returns partial results, surfaced via mode=monitor.
    """
    from datetime import datetime as _dt
    now = _dt.utcnow()
    cat = event.get("category") or EXPLORATION_CATEGORIES[
        now.timetuple().tm_yday % len(EXPLORATION_CATEGORIES)
    ]
    max_candidates = int(event.get("max_candidates", 10))

    summary = {"mode": "daily_pipeline", "date": now.date().isoformat(),
               "category": cat}

    try:
        from webscraping.v2.agents.exploration import run_exploration
        candidates = asyncio.get_event_loop().run_until_complete(
            run_exploration(cat, max_turns=int(event.get("max_turns", 40)))
        )
        summary["new_candidates"] = len(candidates)
    except Exception as e:
        logger.error(f"daily_pipeline explore failed: {traceback.format_exc()}")
        summary["explore_error"] = str(e)

    try:
        from webscraping.v2.agents.spec_onboarding import onboard_explored
        results = asyncio.get_event_loop().run_until_complete(
            onboard_explored(
                category=None,  # drain across all categories
                max_candidates=max_candidates,
                max_turns=int(event.get("onboard_max_turns", 35)),
            )
        )
        accepted = sum(1 for r in results if r.accepted)
        summary["onboarded_probed"] = len(results)
        summary["onboarded_accepted"] = accepted
    except Exception as e:
        logger.error(f"daily_pipeline onboard failed: {traceback.format_exc()}")
        summary["onboard_error"] = str(e)

    # Surface budget state so the monitor can tell at a glance how much
    # of today's cap got consumed.
    try:
        from webscraping.v2 import budget as _budget
        summary["budget_spent_usd"] = _budget.spent_today_usd()
        summary["budget_remaining_usd"] = _budget.remaining_today_usd()
    except Exception:
        pass

    return {"statusCode": 200, "body": json.dumps(summary)}


def _handle_monitor(event: dict) -> dict:
    """Roll up per-source health and onboarding-pipeline state."""
    stale_hours = int(event.get("stale_hours", 72))
    out: dict = {"mode": "monitor", "stale_hours": stale_hours}
    try:
        from webscraping.v2.pipeline.health import write_summary
        summary = write_summary(stale_hours=stale_hours)
        out["stale_count"] = summary.get("stale_count", 0)
        out["stale_sources"] = [
            s.get("source_id") for s in summary.get("stale", [])
        ]
    except Exception as e:
        logger.error(f"Health summary failed: {traceback.format_exc()}")
        out["health_error"] = str(e)

    # Pipeline observability: today's issues + budget state.
    try:
        from webscraping.v2 import budget as _budget
        out["budget_spent_usd"] = _budget.spent_today_usd()
        out["budget_remaining_usd"] = _budget.remaining_today_usd()
        out["budget_cap_usd"] = _budget.daily_cap_usd()
    except Exception as e:
        out["budget_error"] = str(e)
    try:
        from webscraping.v2 import issues as _issues
        today_issues = _issues.load_today_issues()
        out["issues"] = _issues.summarise_issues(today_issues)
    except Exception as e:
        out["issues_error"] = str(e)

    return {"statusCode": 200, "body": json.dumps(out)}


def _cleanup_tmp():
    """Remove Playwright/Chromium temp dirs from /tmp to prevent ENOSPC."""
    patterns = [
        "/tmp/playwright-*",
        "/tmp/playwright_*",
        "/tmp/chromium-*",
        "/tmp/chromium_*",
    ]
    for pattern in patterns:
        for d in glob.glob(pattern):
            try:
                shutil.rmtree(d, ignore_errors=True)
            except Exception:
                pass


def _invoke_async(context, payload: dict):
    """Fire-and-forget async Lambda invocation."""
    lambda_client = boto3.client(
        "lambda", region_name=os.environ.get("AWS_REGION", "us-east-1")
    )
    lambda_client.invoke(
        FunctionName=context.function_name,
        InvocationType="Event",
        Payload=json.dumps(payload),
    )


def _handle_enrich_backfill(event, context):
    """Re-trigger a scrape with enrichment forced on (skip_enrich=False).

    Wraps the standard single-site or mode=all dispatch but overrides
    `skip_enrich` to False. Used to backfill LLM-extracted fields for
    sources whose normal cron runs with `skip_enrich:true` (the default
    today). Cal eProcure attachment URLs are session-bound, so the only
    reliable backfill path is a fresh scrape that re-discovers and
    downloads PDFs in-session — this mode is sugar over that flow.

    Payload:
      {"mode": "enrich_backfill", "site_id": "caleprocure"}           # single site
      {"mode": "enrich_backfill"}                                      # all sites
    """
    site_id = event.get("site_id")
    if site_id:
        per_source_default = 15 if site_id == "caleprocure" else 5
        forwarded = {
            "site_id": site_id,
            "batch_offset": event.get("batch_offset", 0),
            "batch_size": event.get("batch_size", per_source_default),
            "skip_enrich": False,
        }
        logger.info(
            f"enrich_backfill: routing to single-site chain for "
            f"{site_id} with skip_enrich=False"
        )
        return _handle_single_site(site_id, forwarded, context)

    logger.info("enrich_backfill: routing to mode=all with skip_enrich=False")
    return _handle_run_all({**event, "skip_enrich": False}, context)


def _handle_single_site(site_id, event, context):
    """Scrape a single site with optional chained batching."""
    delay_before_start = event.get("delay_before_start", 0)
    if delay_before_start > 0:
        logger.info(f"Staggered start for {site_id}: sleeping {delay_before_start}s")
        time.sleep(delay_before_start)

    batch_offset = event.get("batch_offset", 0)
    batch_size = event.get("batch_size", 40)
    skip_enrich = event.get("skip_enrich", False)
    # `expected_total` propagates through chained invocations once the
    # first batch learns the total event count. Used to bound the chain:
    # once batch_offset >= expected_total there's nothing left to do, so
    # we skip the scrape AND skip the speculative dispatch (the runaway
    # we hit when zero-event batches kept chaining was caused by missing
    # this guard).
    expected_total = event.get("expected_total")

    # Runaway-chain guard. The speculative dispatch fires BEFORE the
    # scrape returns, so we can't condition on events_scraped > 0 to
    # decide whether to chain. When the source's listing API count
    # over-reports relative to truly-scrape-able events (the OpenGov
    # `count=1233` example: includes per-row statuses we filter out
    # client-side), the chain runs forever with `expected_total=None`.
    # Fix: synthesize a per-source hard cap on `expected_total` for the
    # FIRST invocation in the chain. Once set, it propagates and bounds
    # the chain at a sensible depth. Cal eProcure caps high (we want
    # full coverage); OpenGov caps low (any single tenant has <60
    # actively-open RFPs in practice).
    if expected_total is None:
        if site_id.startswith("opengov_"):
            expected_total = 60
        elif site_id.startswith("planetbids_"):
            expected_total = 600
        elif site_id == "caleprocure":
            expected_total = 2000
        else:
            expected_total = 300

    logger.info(
        f"Single-site: site={site_id}, offset={batch_offset}, "
        f"batch_size={batch_size}, skip_enrich={skip_enrich}, "
        f"expected_total={expected_total}"
    )

    # Stop if we already know we're past the end of the listing.
    if expected_total is not None and batch_offset >= expected_total:
        logger.info(
            f"Chain done: offset={batch_offset} >= expected_total={expected_total}"
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "site_id": site_id,
                "events_scraped": 0,
                "batch_offset": batch_offset,
                "next_offset": batch_offset,
                "total_events": expected_total,
                "chain_continues": False,
                "chain_error": None,
            }),
        }

    # Chain-first: dispatch next batch BEFORE running current scrape.
    # Robust to the current invocation's runtime / timeout. Only fire the
    # speculative chain if we either don't yet know the total or we know
    # there's more work after the next offset — otherwise we'd pile on a
    # cascade of zero-event invocations.
    next_offset = batch_offset + batch_size
    speculative_dispatched = False
    should_speculate = (
        expected_total is None or next_offset < expected_total
    )
    if should_speculate:
        try:
            _invoke_async(context, {
                "site_id": site_id,
                "batch_offset": next_offset,
                "batch_size": batch_size,
                "skip_enrich": skip_enrich,
                "expected_total": expected_total,
                # No delay_before_start — within-portal chain runs back-to-back
            })
            speculative_dispatched = True
            logger.info(f"Speculatively chained next batch: offset={next_offset}")
        except Exception as e:
            logger.error(f"Failed to speculatively chain: {e}")

    try:
        from webscraping.v2.orchestrator.runner import run_site_batch

        result = asyncio.get_event_loop().run_until_complete(
            run_site_batch(
                site_id,
                batch_offset=batch_offset,
                batch_size=batch_size,
                skip_enrich=skip_enrich,
            )
        )
    except Exception as e:
        logger.error(f"Scraping failed for {site_id}: {traceback.format_exc()}")
        return {
            "statusCode": 500,
            "body": json.dumps({"site_id": site_id, "error": str(e)}),
        }

    events_scraped = result.get("events_scraped", 0)
    total_events = result.get("total_events", 0)
    chain_error = None
    next_offset_actual = batch_offset + events_scraped

    logger.info(
        f"Batch complete: scraped {events_scraped} events "
        f"(offset {batch_offset}-{next_offset_actual} of {total_events})"
    )

    # If we couldn't speculatively chain (or didn't because total is known
    # to be smaller), fire a recovery chain only when there is actual work
    # remaining. The over-shoot case (we scraped fewer than batch_size,
    # hit end of listing) is handled gracefully by the expected_total
    # guard at the top of the next invocation. Honour an explicit user-
    # passed cap (used for tests) instead of overriding with total_events.
    propagated_total = total_events
    if expected_total is not None:
        propagated_total = min(expected_total, total_events)
    chain_continues = (
        next_offset_actual < propagated_total and events_scraped > 0
    )
    if chain_continues and not speculative_dispatched:
        try:
            _invoke_async(context, {
                "site_id": site_id,
                "batch_offset": next_offset_actual,
                "batch_size": batch_size,
                "skip_enrich": skip_enrich,
                "expected_total": propagated_total,
            })
            logger.info(f"Recovery-chained next batch: offset={next_offset_actual}")
        except Exception as e:
            chain_error = str(e)
            logger.error(f"Failed to recovery-chain: {e}")
    next_offset = next_offset_actual

    return {
        "statusCode": 200,
        "body": json.dumps({
            "site_id": site_id,
            "events_scraped": events_scraped,
            "batch_offset": batch_offset,
            "next_offset": next_offset,
            "total_events": total_events,
            "chain_continues": chain_continues,
            "chain_error": chain_error,
        }),
    }


def _handle_multi_site(sites, event, context):
    """
    Scrape a batch of sites sequentially, then chain to the next batch.

    Cal eProcure is handled separately via chained batching (it has ~640
    events that each require a page reload to discover URLs).

    If `remaining_sites` is present in the event, the next batch is
    automatically dispatched after this batch completes.
    """
    skip_enrich = event.get("skip_enrich", False)
    include_awarded = event.get("include_awarded", False)
    remaining_sites = event.get("remaining_sites", [])
    delay_before_start = event.get("delay_before_start", 0)

    # Stagger: sleep before doing anything so concurrent invocations serialize.
    # Combined with chain-first dispatch below, this means invocation N+1
    # naps while N runs — preventing PlanetBids hammering at high concurrency.
    if delay_before_start > 0:
        logger.info(f"Staggered start: sleeping {delay_before_start}s")
        time.sleep(delay_before_start)

    logger.info(
        f"Multi-site batch: {len(sites)} sites this batch, "
        f"{len(remaining_sites)} remaining after, "
        f"include_awarded={include_awarded}"
    )

    from webscraping.v2.orchestrator.runner import run_site

    # Cal eProcure needs chained batching — kick it off separately.
    # include_awarded is PlanetBids-only, so it's not propagated to Cal eProcure.
    if "caleprocure" in sites:
        sites = [s for s in sites if s != "caleprocure"]
        logger.info("Launching Cal eProcure as chained batch invocation")
        try:
            _invoke_async(context, {
                "site_id": "caleprocure",
                "batch_offset": 0,
                "batch_size": 15,
                "skip_enrich": skip_enrich,
            })
        except Exception as e:
            logger.error(f"Failed to launch Cal eProcure: {e}")

    # CHAIN-FIRST: dispatch next batch BEFORE running the current scrape.
    # Lambda timeouts SIGKILL the runtime, skipping any post-loop logic.
    # Dispatching first ensures the chain advances even if the current
    # invocation times out mid-portal. The next invocation sleeps via
    # delay_before_start so we don't fan-out concurrent scrapes.
    chain_error = None
    if remaining_sites:
        bsize = _batch_size_for(event)
        next_batch = remaining_sites[:bsize]
        still_remaining = remaining_sites[bsize:]
        logger.info(
            f"Chaining next batch (chain-first): {next_batch} "
            f"({len(still_remaining)} remaining after, "
            f"delay={CHAIN_STAGGER_SECONDS}s)"
        )
        try:
            _invoke_async(context, {
                "sites": next_batch,
                "remaining_sites": still_remaining,
                "skip_enrich": skip_enrich,
                "include_awarded": include_awarded,
                "delay_before_start": CHAIN_STAGGER_SECONDS,
            })
        except Exception as e:
            chain_error = str(e)
            logger.error(f"Failed to chain next batch: {e}")

    results = {}
    for site_id in sites:
        _cleanup_tmp()
        try:
            logger.info(f"--- Starting {site_id} ---")
            events = asyncio.get_event_loop().run_until_complete(
                run_site(
                    site_id,
                    skip_enrich=skip_enrich,
                    include_awarded=include_awarded,
                )
            )
            results[site_id] = {"events": len(events), "status": "ok"}
            logger.info(f"--- {site_id}: {len(events)} events ---")
        except Exception as e:
            logger.error(f"--- {site_id} FAILED: {e} ---")
            results[site_id] = {"events": 0, "status": "error", "error": str(e)}

    return {
        "statusCode": 200,
        "body": json.dumps({
            "mode": "multi-site",
            "results": results,
            "chain_continues": len(remaining_sites) > 0,
            "chain_error": chain_error,
        }),
    }


def _handle_run_all(event, context):
    """
    Build a dispatch queue of all enabled sites and hand it to the wave-based
    dispatcher (`mode=dispatch_queue`). Old upfront fan-out used cumulative
    `delay_before_start` sleeps that exceeded the 900s Lambda timeout — any
    portal scheduled past ~895s died inside `time.sleep()` before scraping
    or chain-fire could run. The dispatch_queue handler fires portals in
    capped-duration waves so every invocation completes inside the budget.

    Queue order: Cal eProcure first (it has its own internal chained
    pagination), then BidSync, then PlanetBids portals, OpenGov portals,
    spec-driven portals, agentic batch last.
    """
    skip_enrich = event.get("skip_enrich", False)
    include_awarded = event.get("include_awarded", False)
    logger.info(
        f"Run-all mode, skip_enrich={skip_enrich}, "
        f"include_awarded={include_awarded}"
    )

    from webscraping.v2.orchestrator.runner import SITE_REGISTRY

    all_sites = [sid for sid, cfg in SITE_REGISTRY.items() if cfg.enabled]
    logger.info(f"Total enabled sites: {len(all_sites)}")

    planetbids_sites = [s for s in all_sites if s.startswith("planetbids_")]
    opengov_sites = [s for s in all_sites if s.startswith("opengov_")]

    from webscraping.v2.models import ScraperType
    from webscraping.v2.orchestrator.runner import SITE_REGISTRY as _REG
    spec_driven_sites = [
        sid for sid in all_sites
        if _REG[sid].scraper_type == ScraperType.SPEC_DRIVEN
    ]

    agentic_sites = [
        sid for sid in all_sites
        if sid != "caleprocure"
        and not sid.startswith("bidsync_")
        and not sid.startswith("planetbids_")
        and not sid.startswith("opengov_")
        and sid not in spec_driven_sites
    ]

    # Per-source batch sizes — tuned so a single Lambda invocation comfortably
    # scrapes one batch within the 15-min budget.
    PLANETBIDS_BATCH_SIZE = 5
    OPENGOV_BATCH_SIZE = 6
    SPEC_DRIVEN_BATCH_SIZE = 8

    queue: list[dict] = []

    queue.append({
        "site_id": "caleprocure",
        "batch_offset": 0,
        "batch_size": 15,
        "skip_enrich": skip_enrich,
    })

    if "bidsync_all_ca" in all_sites:
        queue.append({
            "sites": ["bidsync_all_ca"],
            "skip_enrich": skip_enrich,
        })

    for site_id in planetbids_sites:
        queue.append({
            "site_id": site_id,
            "batch_offset": 0,
            "batch_size": PLANETBIDS_BATCH_SIZE,
            "skip_enrich": skip_enrich,
        })

    for site_id in opengov_sites:
        queue.append({
            "site_id": site_id,
            "batch_offset": 0,
            "batch_size": OPENGOV_BATCH_SIZE,
            "skip_enrich": skip_enrich,
        })

    for site_id in spec_driven_sites:
        queue.append({
            "site_id": site_id,
            "batch_offset": 0,
            "batch_size": SPEC_DRIVEN_BATCH_SIZE,
            "skip_enrich": skip_enrich,
        })

    if agentic_sites:
        first_batch = agentic_sites[:1]
        remaining = agentic_sites[1:]
        queue.append({
            "sites": first_batch,
            "remaining_sites": remaining,
            "skip_enrich": skip_enrich,
            "include_awarded": include_awarded,
        })

    try:
        _invoke_async(context, {
            "mode": "dispatch_queue",
            "queue": queue,
            "wave_size": DISPATCH_WAVE_SIZE,
            "portal_stagger": DISPATCH_PORTAL_STAGGER,
        })
    except Exception as e:
        logger.error(f"Failed to seed dispatch_queue: {e}")
        return {
            "statusCode": 500,
            "body": json.dumps({"mode": "run-all-dispatch", "error": str(e)}),
        }

    return {
        "statusCode": 200,
        "body": json.dumps({
            "mode": "run-all-dispatch",
            "queue_size": len(queue),
            "wave_size": DISPATCH_WAVE_SIZE,
            "portal_stagger": DISPATCH_PORTAL_STAGGER,
            "total_sites": len(all_sites),
            "planetbids_portals": len(planetbids_sites),
            "opengov_portals": len(opengov_sites),
            "spec_driven_portals": len(spec_driven_sites),
            "agentic_portals": len(agentic_sites),
            "note": (
                "Queue handed off to dispatch_queue handler; portals will "
                "fan out in waves. Check CloudWatch logs for progress."
            ),
        }),
    }


def _handle_dispatch_queue(event, context):
    """Fire portal invocations in capped-duration waves.

    Each wave dispatches up to `wave_size` portals with a per-portal
    `delay_before_start` of `0..(wave_size-1)*portal_stagger` seconds.
    After firing the wave, this Lambda re-invokes itself with
    `delay_before_start = wave_size * portal_stagger` so the next wave's
    portals don't overlap with the previous wave's batches in time.

    Bounds: each portal Lambda sleeps for at most
    `(wave_size - 1) * portal_stagger` seconds, then has the remainder of
    the 900s budget for scrape work. Each dispatch_queue invocation sleeps
    at most `wave_size * portal_stagger` and then runs in seconds. With
    the defaults (wave=10, stagger=60s) both bounds are well under 900s.
    """
    delay_before_start = event.get("delay_before_start", 0)
    if delay_before_start > 0:
        logger.info(f"dispatch_queue: sleeping {delay_before_start}s before next wave")
        time.sleep(delay_before_start)

    queue = list(event.get("queue", []))
    wave_size = int(event.get("wave_size", DISPATCH_WAVE_SIZE))
    portal_stagger = int(event.get("portal_stagger", DISPATCH_PORTAL_STAGGER))

    # Defensive: refuse to schedule a wave whose own sleep would blow the
    # Lambda budget. Caller bug if this fires.
    if wave_size * portal_stagger >= 850:
        msg = (
            f"dispatch_queue: wave_size*portal_stagger={wave_size * portal_stagger}s "
            f"would exceed Lambda timeout; aborting chain"
        )
        logger.error(msg)
        return {"statusCode": 500, "body": json.dumps({"error": msg})}

    wave = queue[:wave_size]
    rest = queue[wave_size:]

    dispatched: list = []
    for i, entry in enumerate(wave):
        payload = dict(entry)
        payload["delay_before_start"] = (
            payload.get("delay_before_start", 0) + i * portal_stagger
        )
        try:
            _invoke_async(context, payload)
            dispatched.append(entry.get("site_id") or entry.get("sites"))
        except Exception as e:
            logger.error(f"dispatch_queue: failed to fire {entry}: {e}")

    chain_error = None
    if rest:
        try:
            _invoke_async(context, {
                "mode": "dispatch_queue",
                "queue": rest,
                "wave_size": wave_size,
                "portal_stagger": portal_stagger,
                "delay_before_start": wave_size * portal_stagger,
            })
        except Exception as e:
            chain_error = str(e)
            logger.error(f"dispatch_queue: failed to chain next wave: {e}")

    logger.info(
        f"dispatch_queue: wave fired {len(dispatched)} portals "
        f"({len(rest)} remaining)"
    )
    return {
        "statusCode": 200,
        "body": json.dumps({
            "mode": "dispatch_queue",
            "wave_dispatched": dispatched,
            "remaining": len(rest),
            "chain_error": chain_error,
        }),
    }
