"""
Per-source scrape health tracking.

Every batch writes a small heartbeat record to
`scrapes/v2/health/{source_id}.json` and emits a single CloudWatch
metric (`Civitas/Scraping/EventsScraped` keyed by source_id) so we can
spot a source going dark without scanning logs.

Health record schema:
{
  "source_id": "...",
  "source_name": "...",
  "last_success_at": "...",
  "last_attempt_at": "...",
  "consecutive_failures": int,
  "last_events_scraped": int,
  "last_pdfs_observed": int,
  "last_error": "..."
}

The monitor lambda mode (`mode=monitor`) scans every health record and
returns the list of sources that are stale (>X hours since last success)
or have a high failure streak — that's the alarm trigger.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from typing import Optional

import boto3

from webscraping.v2.config import S3_BUCKET, S3_V2_PREFIX, get_s3_client

logger = logging.getLogger(__name__)


HEALTH_PREFIX = f"{S3_V2_PREFIX}health/"
SUMMARY_KEY = f"{HEALTH_PREFIX}_summary.json"

# A source is "stale" if no successful run in this many hours.
DEFAULT_STALE_HOURS = 72
# Trip an alarm if more than this many consecutive failures.
FAILURE_STREAK_TRIPWIRE = 3


def _key(source_id: str) -> str:
    return f"{HEALTH_PREFIX}{source_id}.json"


def _now() -> str:
    return datetime.now(tz=timezone.utc).isoformat()


def _load(source_id: str) -> dict:
    s3 = get_s3_client()
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_key(source_id))
        return json.loads(resp["Body"].read())
    except Exception:
        return {}


def _save(source_id: str, record: dict) -> None:
    s3 = get_s3_client()
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=_key(source_id),
        Body=json.dumps(record, indent=2),
        ContentType="application/json",
    )


def _emit_metric(source_id: str, events_scraped: int, success: bool) -> None:
    """Emit a CloudWatch metric so SREs / dashboards can alarm."""
    try:
        cw = boto3.client(
            "cloudwatch",
            region_name=os.environ.get("AWS_REGION", "us-east-1"),
        )
        cw.put_metric_data(
            Namespace="Civitas/Scraping",
            MetricData=[
                {
                    "MetricName": "EventsScraped",
                    "Dimensions": [{"Name": "SourceId", "Value": source_id}],
                    "Value": float(events_scraped),
                    "Unit": "Count",
                },
                {
                    "MetricName": "RunSuccess",
                    "Dimensions": [{"Name": "SourceId", "Value": source_id}],
                    "Value": 1.0 if success else 0.0,
                    "Unit": "Count",
                },
            ],
        )
    except Exception as e:
        logger.debug(f"CloudWatch metric emit failed for {source_id}: {e}")


def record_run(
    source_id: str,
    source_name: str,
    events_scraped: int,
    pdfs_observed: int = 0,
    error: Optional[str] = None,
) -> None:
    """Write a heartbeat for this run and emit metrics."""
    success = error is None
    existing = _load(source_id)

    record = {
        "source_id": source_id,
        "source_name": source_name,
        "last_attempt_at": _now(),
        "last_success_at": (
            _now() if success else existing.get("last_success_at", "")
        ),
        "consecutive_failures": (
            0 if success else int(existing.get("consecutive_failures", 0)) + 1
        ),
        "last_events_scraped": events_scraped if success else
            existing.get("last_events_scraped", 0),
        "last_pdfs_observed": pdfs_observed if success else
            existing.get("last_pdfs_observed", 0),
        "last_error": error or "",
    }
    try:
        _save(source_id, record)
    except Exception as e:
        logger.warning(f"Failed to write health record for {source_id}: {e}")

    _emit_metric(source_id, events_scraped, success)


def stale_sources(stale_hours: int = DEFAULT_STALE_HOURS) -> list[dict]:
    """Return sources whose last_success_at is older than `stale_hours` hours
    or whose consecutive_failures exceeds the tripwire."""
    s3 = get_s3_client()
    paginator = s3.get_paginator("list_objects_v2")
    cutoff = datetime.now(tz=timezone.utc).timestamp() - stale_hours * 3600

    stale: list[dict] = []
    for page in paginator.paginate(Bucket=S3_BUCKET, Prefix=HEALTH_PREFIX):
        for obj in page.get("Contents", []) or []:
            key = obj["Key"]
            if key.endswith("_summary.json"):
                continue
            try:
                body = s3.get_object(Bucket=S3_BUCKET, Key=key)["Body"].read()
                record = json.loads(body)
            except Exception:
                continue

            last_success = record.get("last_success_at") or ""
            try:
                last_ts = datetime.fromisoformat(last_success).timestamp()
            except ValueError:
                last_ts = 0.0

            failures = int(record.get("consecutive_failures", 0))
            if last_ts < cutoff or failures >= FAILURE_STREAK_TRIPWIRE:
                stale.append(record)
    return stale


def write_summary(stale_hours: int = DEFAULT_STALE_HOURS) -> dict:
    """Roll up health into a single summary file (for the dashboard / API)."""
    stale = stale_sources(stale_hours=stale_hours)
    summary = {
        "generated_at": _now(),
        "stale_hours": stale_hours,
        "stale_count": len(stale),
        "stale": stale,
    }
    s3 = get_s3_client()
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=SUMMARY_KEY,
        Body=json.dumps(summary, indent=2),
        ContentType="application/json",
    )
    return summary
