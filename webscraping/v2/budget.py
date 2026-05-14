"""
Daily Anthropic spend cap for the agentic pipeline.

The exploration agent (Sonnet + web_search), the investigation agent
(Sonnet + Playwright), and any future Claude-driven path read the same
S3-persisted counter. When the daily cap is hit, agents raise
`BudgetExceeded` and terminate gracefully — never a runaway bill.

## Cap schedule

The cap ramps from $25/day (first week of the pipeline) down to $5/day
(steady state). This is deliberate: the initial backlog of unknown
portals takes hundreds of investigations to drain; once drained, daily
new platform migrations are slow (a few per month) and $5 is plenty.

Override either way with the `DAILY_BUDGET_USD` env var on the Lambda
function.

## Persistence

Stored at `s3://.../scrapes/v2/budget/YYYY-MM-DD.json`:

```json
{
  "date": "2026-05-14",
  "spent_usd": 3.45,
  "cap_usd": 25.0,
  "by_source": {"exploration": 0.92, "investigation": 2.53}
}
```

Read-modify-write is intentionally not atomic — at the daily cadence
with a handful of Lambda invocations the race-loss is bounded to a
few cents and never breaches the cap meaningfully. If we ever need
hard atomicity, swap the S3 backing for DynamoDB conditional updates.

## Pricing

Pricing dict mirrors Anthropic's public rates (USD per million tokens)
as of the date in PRICING_UPDATED_AT. Web search is billed separately
at $10 per 1000 searches.

Keep PRICING in sync with anthropic.com/pricing — a stale entry just
means we under- or over-charge ourselves; the cap remains enforced.
"""

from __future__ import annotations

import json
import logging
import os
from datetime import date, datetime, timezone
from typing import Any, Optional

logger = logging.getLogger(__name__)


PRICING_UPDATED_AT = "2026-05-14"

PRICING: dict[str, dict[str, float]] = {
    "claude-sonnet-4-6": {
        "input": 3.00,
        "output": 15.00,
        "cache_write": 3.75,
        "cache_read": 0.30,
    },
    "claude-sonnet-4-20250514": {  # older alias still referenced in some agents
        "input": 3.00,
        "output": 15.00,
        "cache_write": 3.75,
        "cache_read": 0.30,
    },
    "claude-opus-4-7": {
        "input": 15.00,
        "output": 75.00,
        "cache_write": 18.75,
        "cache_read": 1.50,
    },
    "claude-haiku-4-5-20251001": {
        "input": 0.80,
        "output": 4.00,
        "cache_write": 1.00,
        "cache_read": 0.08,
    },
}

WEB_SEARCH_USD_PER_CALL = 0.01  # $10 per 1000 searches

# Date-based cap ramp. The pipeline launches at PIPELINE_START_DATE
# with HIGH_CAP_USD ($25/day) to drain the initial backlog quickly,
# then drops to STEADY_CAP_USD ($5/day) on RAMP_END_DATE. Override
# either by setting DAILY_BUDGET_USD in the Lambda env.
PIPELINE_START_DATE = date(2026, 5, 14)
RAMP_END_DATE = date(2026, 5, 21)
HIGH_CAP_USD = 25.0
STEADY_CAP_USD = 5.0


class BudgetExceeded(Exception):
    """Raised when reserving spend would exceed today's cap."""


def daily_cap_usd(today: Optional[date] = None) -> float:
    """Cap for `today` (defaults to UTC today).

    Env override wins; otherwise the date-based ramp applies.
    """
    explicit = os.environ.get("DAILY_BUDGET_USD")
    if explicit:
        try:
            return float(explicit)
        except ValueError:
            logger.warning(
                f"DAILY_BUDGET_USD={explicit!r} not a float; falling back to ramp"
            )
    today = today or datetime.now(timezone.utc).date()
    return HIGH_CAP_USD if today < RAMP_END_DATE else STEADY_CAP_USD


def _budget_key(today: Optional[date] = None) -> str:
    today = today or datetime.now(timezone.utc).date()
    return f"scrapes/v2/budget/{today.isoformat()}.json"


def _empty_meter(today: Optional[date] = None) -> dict:
    today = today or datetime.now(timezone.utc).date()
    return {
        "date": today.isoformat(),
        "spent_usd": 0.0,
        "cap_usd": daily_cap_usd(today),
        "by_source": {},
    }


def _load_meter(today: Optional[date] = None) -> dict:
    from webscraping.v2.config import S3_BUCKET, get_s3_client
    try:
        s3 = get_s3_client()
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_budget_key(today))
        data = json.loads(resp["Body"].read())
        if isinstance(data, dict):
            data.setdefault("cap_usd", daily_cap_usd(today))
            data.setdefault("by_source", {})
            data.setdefault("spent_usd", 0.0)
            return data
    except Exception:
        pass
    return _empty_meter(today)


def _save_meter(meter: dict) -> None:
    from webscraping.v2.config import S3_BUCKET, get_s3_client
    try:
        s3 = get_s3_client()
        s3.put_object(
            Bucket=S3_BUCKET,
            Key=_budget_key(),
            Body=json.dumps(meter, indent=2),
            ContentType="application/json",
        )
    except Exception as e:
        # If we can't write the meter, we can't enforce the cap. Log
        # loud but don't crash the agent — local-dev runs without S3
        # access still need to work.
        logger.error(f"Failed to persist budget meter: {e}")


def spent_today_usd() -> float:
    return _load_meter().get("spent_usd", 0.0)


def remaining_today_usd() -> float:
    meter = _load_meter()
    return max(0.0, meter["cap_usd"] - meter["spent_usd"])


def ensure_budget(reserve_usd: float, *, source: str) -> None:
    """Raise BudgetExceeded if we can't afford `reserve_usd` more today."""
    remaining = remaining_today_usd()
    if remaining < reserve_usd:
        raise BudgetExceeded(
            f"Daily budget exhausted: ${remaining:.2f} remaining, "
            f"${reserve_usd:.2f} requested by {source!r}"
        )


def record(cost_usd: float, *, source: str, meta: Optional[dict] = None) -> dict:
    """Increment today's spent total and the per-source breakdown.

    Returns the updated meter dict so callers can log the new state
    without a second S3 read.
    """
    if cost_usd <= 0:
        return _load_meter()
    meter = _load_meter()
    meter["spent_usd"] = round(meter.get("spent_usd", 0.0) + cost_usd, 4)
    by_source = meter.setdefault("by_source", {})
    by_source[source] = round(by_source.get(source, 0.0) + cost_usd, 4)
    _save_meter(meter)
    logger.info(
        f"BUDGET +${cost_usd:.4f} ({source}); "
        f"spent today: ${meter['spent_usd']:.4f} / ${meter['cap_usd']:.2f}"
    )
    return meter


# ---------------------------------------------------------------------------
# Anthropic response cost extraction
# ---------------------------------------------------------------------------

def usage_cost_usd(usage: Any, model: str) -> float:
    """Compute USD cost from an Anthropic Messages `.usage` object.

    Accepts either the SDK's `Usage` dataclass or a plain dict (so
    cached/serialised responses also work in tests).
    """
    if usage is None:
        return 0.0

    def _get(name: str) -> int:
        if isinstance(usage, dict):
            return int(usage.get(name) or 0)
        return int(getattr(usage, name, 0) or 0)

    pricing = PRICING.get(model)
    if pricing is None:
        logger.warning(
            f"Unknown model {model!r} for pricing; recording zero cost. "
            f"Add it to PRICING in budget.py."
        )
        return 0.0

    cost = 0.0
    cost += _get("input_tokens") / 1e6 * pricing["input"]
    cost += _get("output_tokens") / 1e6 * pricing["output"]
    cost += _get("cache_creation_input_tokens") / 1e6 * pricing.get("cache_write", 0.0)
    cost += _get("cache_read_input_tokens") / 1e6 * pricing.get("cache_read", 0.0)
    return round(cost, 6)


def record_response(response: Any, model: str, *, source: str) -> float:
    """Cost-track a single Anthropic response. Returns the USD added."""
    usage = getattr(response, "usage", None)
    cost = usage_cost_usd(usage, model)
    if cost > 0:
        record(cost, source=source)
    return cost


def record_web_search(count: int = 1, *, source: str) -> float:
    """Cost-track web_search tool invocations."""
    cost = count * WEB_SEARCH_USD_PER_CALL
    if cost > 0:
        record(cost, source=source, meta={"web_searches": count})
    return cost
