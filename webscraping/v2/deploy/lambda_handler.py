"""
AWS Lambda handler for the Civitas RFP scraping system.

Supports three invocation modes:

1. Single site with chained batching (Cal eProcure):
    {"site_id": "caleprocure", "batch_offset": 0, "batch_size": 40}

2. Multiple sites in one invocation (BidSync, PlanetBids):
    {"sites": ["planetbids_san_diego", "planetbids_fresno", ...]}

3. All non-Cal-eProcure sites:
    {"mode": "all"}

Chained batching: when batch_offset + batch_size < total events, the Lambda
self-invokes with the next offset. This chains until all events are scraped.
"""

import asyncio
import json
import logging
import os
import traceback

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """Lambda entry point supporting single-site, multi-site, and run-all modes."""

    # Mode 1: Multi-site batch
    sites = event.get("sites", [])
    if sites:
        return _handle_multi_site(sites, event, context)

    # Mode 2: Run all non-Cal-eProcure sites
    if event.get("mode") == "all":
        return _handle_run_all(event, context)

    # Mode 3: Single site with chained batching
    site_id = event.get("site_id", os.environ.get("SITE_ID", ""))
    if not site_id:
        return {"statusCode": 400, "body": "site_id, sites, or mode is required"}

    return _handle_single_site(site_id, event, context)


def _handle_single_site(site_id, event, context):
    """Scrape a single site with optional chained batching."""
    batch_offset = event.get("batch_offset", 0)
    batch_size = event.get("batch_size", 40)
    skip_enrich = event.get("skip_enrich", True)

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
            lambda_client = boto3.client(
                "lambda", region_name=os.environ.get("AWS_REGION", "us-east-1")
            )
            lambda_client.invoke(
                FunctionName=context.function_name,
                InvocationType="Event",
                Payload=json.dumps({
                    "site_id": site_id,
                    "batch_offset": next_offset,
                    "batch_size": batch_size,
                    "skip_enrich": skip_enrich,
                }),
            )
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
    """Scrape multiple sites sequentially in one invocation.

    Cal eProcure is handled separately via chained batching (it has ~640
    events that each require a page reload to discover URLs). All other
    sites run the full pipeline in a single call.
    """
    skip_enrich = event.get("skip_enrich", True)
    logger.info(f"Multi-site: {len(sites)} sites, skip_enrich={skip_enrich}")

    from webscraping.v2.orchestrator.runner import run_site

    # Cal eProcure needs chained batching — kick it off separately
    if "caleprocure" in sites:
        sites = [s for s in sites if s != "caleprocure"]
        logger.info("Launching Cal eProcure as chained batch invocation")
        try:
            lambda_client = boto3.client(
                "lambda", region_name=os.environ.get("AWS_REGION", "us-east-1")
            )
            lambda_client.invoke(
                FunctionName=context.function_name,
                InvocationType="Event",
                Payload=json.dumps({
                    "site_id": "caleprocure",
                    "batch_offset": 0,
                    "batch_size": 40,
                    "skip_enrich": skip_enrich,
                }),
            )
        except Exception as e:
            logger.error(f"Failed to launch Cal eProcure: {e}")

    results = {}
    for site_id in sites:
        try:
            logger.info(f"--- Starting {site_id} ---")
            events = asyncio.get_event_loop().run_until_complete(
                run_site(site_id, skip_enrich=skip_enrich)
            )
            results[site_id] = {"events": len(events), "status": "ok"}
            logger.info(f"--- {site_id}: {len(events)} events ---")
        except Exception as e:
            logger.error(f"--- {site_id} FAILED: {e} ---")
            results[site_id] = {"events": 0, "status": "error", "error": str(e)}

    return {
        "statusCode": 200,
        "body": json.dumps({"mode": "multi-site", "results": results}),
    }


def _handle_run_all(event, context):
    """Scrape all enabled sites."""
    skip_enrich = event.get("skip_enrich", True)
    logger.info(f"Run-all mode, skip_enrich={skip_enrich}")

    from webscraping.v2.orchestrator.runner import SITE_REGISTRY

    sites = [sid for sid, cfg in SITE_REGISTRY.items() if cfg.enabled]
    logger.info(f"Running {len(sites)} sites: {sites}")

    return _handle_multi_site(sites, event, context)
