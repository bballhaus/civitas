"""
AWS Lambda handler for the Civitas RFP scraping system.

Supports chained invocations for large sites: each invocation scrapes a batch
of events, saves progress, then invokes itself with the next batch offset.

Event payload:
    {
        "site_id": "caleprocure",       # required
        "batch_offset": 0,              # optional: start index (default 0)
        "batch_size": 40,               # optional: events per invocation (default 40)
        "skip_enrich": true             # optional: skip PDF enrichment (default true)
    }

When batch_offset + batch_size < total events, the Lambda self-invokes with
the next offset. This chains until all events are scraped.
"""

import asyncio
import json
import logging
import os

import boto3

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """Lambda entry point with chained batch support."""
    site_id = event.get("site_id", os.environ.get("SITE_ID", ""))
    batch_offset = event.get("batch_offset", 0)
    batch_size = event.get("batch_size", 40)
    skip_enrich = event.get("skip_enrich", True)

    if not site_id:
        return {"statusCode": 400, "body": "site_id is required"}

    logger.info(
        f"Lambda invoked: site={site_id}, offset={batch_offset}, "
        f"batch_size={batch_size}, skip_enrich={skip_enrich}"
    )

    from webscraping.v2.orchestrator.runner import run_site_batch

    result = asyncio.get_event_loop().run_until_complete(
        run_site_batch(
            site_id,
            batch_offset=batch_offset,
            batch_size=batch_size,
            skip_enrich=skip_enrich,
        )
    )

    events_scraped = result.get("events_scraped", 0)
    total_events = result.get("total_events", 0)
    next_offset = batch_offset + events_scraped

    logger.info(
        f"Batch complete: scraped {events_scraped} events "
        f"(offset {batch_offset}-{next_offset} of {total_events})"
    )

    # Chain: invoke next batch if there are more events
    if next_offset < total_events and events_scraped > 0:
        logger.info(f"Chaining next batch: offset={next_offset}")
        lambda_client = boto3.client("lambda", region_name=os.environ.get("AWS_REGION", "us-east-1"))
        lambda_client.invoke(
            FunctionName=context.function_name,
            InvocationType="Event",  # async — fire and forget
            Payload=json.dumps({
                "site_id": site_id,
                "batch_offset": next_offset,
                "batch_size": batch_size,
                "skip_enrich": skip_enrich,
            }),
        )
        logger.info(f"Next batch invoked (offset={next_offset})")

    return {
        "statusCode": 200,
        "body": json.dumps({
            "site_id": site_id,
            "events_scraped": events_scraped,
            "batch_offset": batch_offset,
            "next_offset": next_offset,
            "total_events": total_events,
            "chain_continues": next_offset < total_events,
        }),
    }
