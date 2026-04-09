"""
AWS Lambda handler for the Civitas RFP scraping system.

Triggered by EventBridge on a schedule. Runs the scraping pipeline for
a specific site or all enabled sites.

Environment variables (set in Lambda config):
    SITE_ID: Optional — run a specific site. If unset, runs all enabled sites.
    SKIP_ENRICH: Optional — set to "true" to skip PDF enrichment.
    AWS_STORAGE_BUCKET_NAME: S3 bucket for scraped data.
    GROQ_API_KEY: For PDF enrichment.
    ANTHROPIC_API_KEY: For agentic scraper (optional).

Note: This handler is designed for sites that DON'T need a browser (API scrapers).
For Playwright-based scrapers (Cal eProcure, PlanetBids, agentic), use ECS Fargate
tasks instead — Lambda doesn't support headless Chromium well within its constraints.

For Cal eProcure specifically, we provide an ECS-compatible entry point that can
also be run as a Lambda with a container image that includes Chromium.
"""

import asyncio
import json
import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)


def handler(event, context):
    """Lambda entry point."""
    site_id = os.environ.get("SITE_ID", event.get("site_id", ""))
    skip_enrich = os.environ.get("SKIP_ENRICH", "false").lower() == "true"

    logger.info(f"Lambda invoked: site_id={site_id or 'all'}, skip_enrich={skip_enrich}")

    # Import here to allow Lambda cold start to be faster
    from webscraping.v2.orchestrator.runner import run_site, run_all

    if site_id:
        result = asyncio.get_event_loop().run_until_complete(
            run_site(site_id, skip_enrich=skip_enrich)
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "site_id": site_id,
                "events_processed": len(result),
            }),
        }
    else:
        results = asyncio.get_event_loop().run_until_complete(
            run_all(skip_enrich=skip_enrich)
        )
        return {
            "statusCode": 200,
            "body": json.dumps({
                "sites_processed": results,
            }),
        }
