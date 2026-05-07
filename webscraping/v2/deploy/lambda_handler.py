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


def _batch_size_for(event: dict) -> int:
    return BATCH_SIZE


def handler(event, context):
    """Lambda entry point supporting single-site, multi-site, and run-all modes."""

    # Always clean up /tmp at the start to handle warm container reuse
    _cleanup_tmp()

    # Mode 1: Multi-site batch (with optional chaining)
    sites = event.get("sites", [])
    if sites:
        return _handle_multi_site(sites, event, context)

    # Mode 2: Run all sites (dispatches batched invocations)
    if event.get("mode") == "all":
        return _handle_run_all(event, context)

    # Mode 3: Single site with chained batching
    site_id = event.get("site_id", os.environ.get("SITE_ID", ""))
    if not site_id:
        return {"statusCode": 400, "body": "site_id, sites, or mode is required"}

    return _handle_single_site(site_id, event, context)


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
    Dispatch all sites as async Lambda invocations.

    Cal eProcure: chained within-portal batches (size 15 events).
    BidSync all_ca: one invocation covers all CA agencies.
    PlanetBids: each portal dispatched as its own chained within-portal
        batches (size 8 events), staggered so concurrent logins don't hammer.
    Agentic (LA, SF): chain-first multi-site batch.
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

    # Group 1: Cal eProcure (chained batching — within-portal pagination)
    # Group 2: BidSync all_ca (one invocation covers all CA agencies)
    # Group 3: PlanetBids portals (each dispatched as its own chained batch
    #          with within-portal pagination; staggered to avoid hammering)
    # Group 4: Agentic (LA, SF) — multi-site batch with chain-first stagger
    planetbids_sites = [s for s in all_sites if s.startswith("planetbids_")]
    agentic_sites = [
        sid for sid in all_sites
        if sid != "caleprocure"
        and not sid.startswith("bidsync_")
        and not sid.startswith("planetbids_")
    ]

    dispatched = []

    # Dispatch Cal eProcure
    try:
        logger.info("Dispatching Cal eProcure (chained batch)")
        _invoke_async(context, {
            "site_id": "caleprocure",
            "batch_offset": 0,
            "batch_size": 15,
            "skip_enrich": skip_enrich,
        })
        dispatched.append("caleprocure")
    except Exception as e:
        logger.error(f"Failed to dispatch Cal eProcure: {e}")

    # Dispatch BidSync all_ca
    if "bidsync_all_ca" in all_sites:
        try:
            logger.info("Dispatching BidSync all_ca")
            _invoke_async(context, {
                "sites": ["bidsync_all_ca"],
                "skip_enrich": skip_enrich,
            })
            dispatched.append("bidsync_all_ca")
        except Exception as e:
            logger.error(f"Failed to dispatch BidSync: {e}")

    # Dispatch each PlanetBids portal as its own single-site chained job.
    # Each portal paginates internally (5 events per Lambda invocation —
    # each detail page is ~70-80s once login + tabs + market intel are
    # accounted for, so 5 leaves ~10min of headroom under the 15-min
    # Lambda budget). Stagger between portals avoids ~44 concurrent
    # logins to the same vendor account.
    PLANETBIDS_BATCH_SIZE = 5
    PLANETBIDS_STAGGER_SECONDS = 90
    for i, site_id in enumerate(planetbids_sites):
        try:
            _invoke_async(context, {
                "site_id": site_id,
                "batch_offset": 0,
                "batch_size": PLANETBIDS_BATCH_SIZE,
                "skip_enrich": skip_enrich,
                "delay_before_start": i * PLANETBIDS_STAGGER_SECONDS,
            })
            dispatched.append(site_id)
        except Exception as e:
            logger.error(f"Failed to dispatch {site_id}: {e}")
    if planetbids_sites:
        logger.info(
            f"Dispatched {len(planetbids_sites)} PlanetBids portals "
            f"(stagger {PLANETBIDS_STAGGER_SECONDS}s, batch size {PLANETBIDS_BATCH_SIZE} events)"
        )

    # Dispatch agentic sites as a chain-first multi-site batch (no pagination).
    if agentic_sites:
        first_batch = agentic_sites[:1]
        remaining = agentic_sites[1:]
        try:
            _invoke_async(context, {
                "sites": first_batch,
                "remaining_sites": remaining,
                "skip_enrich": skip_enrich,
                "include_awarded": include_awarded,
            })
            dispatched.extend(first_batch)
        except Exception as e:
            logger.error(f"Failed to dispatch agentic batch: {e}")

    return {
        "statusCode": 200,
        "body": json.dumps({
            "mode": "run-all-dispatch",
            "dispatched": dispatched,
            "total_sites": len(all_sites),
            "planetbids_portals": len(planetbids_sites),
            "agentic_portals": len(agentic_sites),
            "note": "Sites dispatched as async invocations. Check CloudWatch logs for progress.",
        }),
    }
