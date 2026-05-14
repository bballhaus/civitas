"""
Structured issue log for the agentic onboarding pipeline.

Every failure that's worth a human glance — agent timeout, spec
validation rejection, scrape probe that yielded zero events, budget
exceeded, smart-routing fallback, exploration agent skipping a
category — emits a record here. Records persist to S3 so the
`mode=monitor` Lambda summary can roll them up.

Distinct from per-source health (`pipeline.health`): that tracks
recurring scrape success/failure for known portals. This tracks
*one-off* events in the onboarding loop — the things you'd want to
see in a "what went wrong yesterday?" digest.

## Persistence

`s3://.../scrapes/v2/issues/YYYY-MM-DD.json` — append-only list,
rotated daily. Each entry:

```json
{
  "ts": "2026-05-14T17:21:00.123Z",
  "category": "investigation_failed",
  "severity": "warn",
  "source": "spec_opengov_api_long_beach",
  "summary": "agent exhausted 35 turns without spec",
  "context": {...}
}
```

Categories are free-form strings; severities are info/warn/error.
"""

from __future__ import annotations

import json
import logging
from datetime import date, datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


SEVERITY_INFO = "info"
SEVERITY_WARN = "warn"
SEVERITY_ERROR = "error"

# Recognised categories — free-form strings, but listing here so they
# stay consistent across callers and so `mode=monitor` can roll up by
# category cleanly.
CATEGORY_EXPLORATION_FAILED = "exploration_failed"
CATEGORY_INVESTIGATION_FAILED = "investigation_failed"
CATEGORY_SPEC_REJECTED = "spec_rejected"
CATEGORY_SCRAPE_PROBE_FAILED = "scrape_probe_failed"
CATEGORY_BUDGET_EXCEEDED = "budget_exceeded"
CATEGORY_ROUTING_FALLBACK = "routing_fallback"
CATEGORY_DISCOVERY_VERIFIER_REJECTED = "discovery_verifier_rejected"
CATEGORY_LAMBDA_ERROR = "lambda_error"


def _issues_key(today: Optional[date] = None) -> str:
    today = today or datetime.now(timezone.utc).date()
    return f"scrapes/v2/issues/{today.isoformat()}.json"


def record_issue(
    *,
    category: str,
    severity: str,
    source: str,
    summary: str,
    context: Optional[dict] = None,
) -> None:
    """Append a structured issue record to today's S3 log.

    Best-effort: if S3 write fails (local dev without creds, network
    blip), we still log to stdout so the issue isn't lost — the
    caller never sees an exception from issues tracking.
    """
    issue = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "category": category,
        "severity": severity,
        "source": source,
        "summary": summary,
        "context": context or {},
    }

    log_fn = logger.warning if severity == SEVERITY_WARN else (
        logger.error if severity == SEVERITY_ERROR else logger.info
    )
    log_fn(f"ISSUE [{severity}/{category}] {source}: {summary}")

    try:
        from webscraping.v2.config import S3_BUCKET, get_s3_client
        s3 = get_s3_client()
        key = _issues_key()
        try:
            resp = s3.get_object(Bucket=S3_BUCKET, Key=key)
            existing = json.loads(resp["Body"].read())
            if not isinstance(existing, list):
                existing = []
        except Exception:
            existing = []
        existing.append(issue)
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=key,
            Body=json.dumps(existing, indent=2),
            ContentType="application/json",
        )
    except Exception as e:
        logger.error(f"Failed to persist issue to S3: {e}")


def load_today_issues() -> list[dict]:
    """Read today's issue log. Returns [] on missing/error."""
    try:
        from webscraping.v2.config import S3_BUCKET, get_s3_client
        s3 = get_s3_client()
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_issues_key())
        data = json.loads(resp["Body"].read())
        if isinstance(data, list):
            return data
    except Exception:
        pass
    return []


def summarise_issues(issues: list[dict]) -> dict:
    """Aggregate by category + severity. Used by `mode=monitor`."""
    by_category: dict[str, int] = {}
    by_severity: dict[str, int] = {}
    for i in issues:
        by_category[i.get("category", "unknown")] = (
            by_category.get(i.get("category", "unknown"), 0) + 1
        )
        by_severity[i.get("severity", "info")] = (
            by_severity.get(i.get("severity", "info"), 0) + 1
        )
    return {
        "total": len(issues),
        "by_category": by_category,
        "by_severity": by_severity,
    }
