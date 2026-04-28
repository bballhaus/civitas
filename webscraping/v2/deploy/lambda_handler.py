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
    batch_offset = event.get("batch_offset", 0)
    batch_size = event.get("batch_size", 40)
    skip_enrich = event.get("skip_enrich", False)

    logger.info(
        f"Single-site: site={site_id}, offset={batch_offset}, "
        f"batch_size={batch_size}, skip_enrich={skip_enrich}"
    )

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
    next_offset = batch_offset + events_scraped
    chain_continues = next_offset < total_events and events_scraped > 0

    logger.info(
        f"Batch complete: scraped {events_scraped} events "
        f"(offset {batch_offset}-{next_offset} of {total_events})"
    )

    # Chain: invoke next batch if there are more events
    chain_error = None
    if chain_continues:
        try:
            logger.info(f"Chaining next batch: offset={next_offset}")
            _invoke_async(context, {
                "site_id": site_id,
                "batch_offset": next_offset,
                "batch_size": batch_size,
                "skip_enrich": skip_enrich,
            })
            logger.info(f"Next batch invoked (offset={next_offset})")
        except Exception as e:
            chain_error = str(e)
            logger.error(f"Failed to chain next batch: {e}")

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
    Dispatch all sites as batched Lambda invocations.

    Splits sites into three groups:
    1. Cal eProcure — its own chained batch (already handled by _handle_multi_site)
    2. BidSync all_ca — single invocation (one search covers all CA agencies)
    3. PlanetBids + agentic — batched in groups of BATCH_SIZE, chained

    Individual bidsync_* sites are skipped since bidsync_all_ca covers them.
    """
    skip_enrich = event.get("skip_enrich", False)
    include_awarded = event.get("include_awarded", False)
    bsize = _batch_size_for(event)
    logger.info(
        f"Run-all mode, skip_enrich={skip_enrich}, "
        f"include_awarded={include_awarded}, batch_size={bsize}"
    )

    from webscraping.v2.orchestrator.runner import SITE_REGISTRY

    all_sites = [sid for sid, cfg in SITE_REGISTRY.items() if cfg.enabled]
    logger.info(f"Total enabled sites: {len(all_sites)}")

    # Group 1: Cal eProcure (chained batching — launched by _handle_multi_site)
    # Group 2: BidSync all_ca (one invocation covers all CA agencies)
    # Group 3: Everything else (PlanetBids + agentic), excluding individual bidsync_*
    other_sites = [
        sid for sid in all_sites
        if sid != "caleprocure"
        and sid != "bidsync_all_ca"
        and not sid.startswith("bidsync_")  # skip individual bidsync — covered by all_ca
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

    # Dispatch PlanetBids + agentic in batches (chained, one portal per
    # invocation). The chain is staggered via delay_before_start in
    # _handle_multi_site so portals run sequentially rather than in parallel.
    if other_sites:
        first_batch = other_sites[:bsize]
        remaining = other_sites[bsize:]
        logger.info(
            f"Dispatching {len(other_sites)} remaining sites: "
            f"first batch={first_batch}, {len(remaining)} queued"
        )
        try:
            _invoke_async(context, {
                "sites": first_batch,
                "remaining_sites": remaining,
                "skip_enrich": skip_enrich,
                "include_awarded": include_awarded,
            })
            dispatched.extend(first_batch)
        except Exception as e:
            logger.error(f"Failed to dispatch PlanetBids batch: {e}")

    return {
        "statusCode": 200,
        "body": json.dumps({
            "mode": "run-all-dispatch",
            "dispatched": dispatched,
            "total_sites": len(all_sites),
            "batches_queued": (len(other_sites) + bsize - 1) // bsize if other_sites else 0,
            "note": "Sites dispatched as async invocations. Check CloudWatch logs for progress.",
        }),
    }
