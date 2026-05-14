"""
Exploration agent — walks the universe of California government
agencies and emits candidate procurement portal URLs for the
investigation agent to scrape next.

Categories cover the full state-and-local landscape: counties, cities,
UC/CSU/community colleges, judicial, state agencies (Caltrans et al),
transit/utility, and an open-ended "emerging platforms" pass for new
procurement SaaS we don't know about yet.

For each candidate, the agent reports:
  - url:             the LISTING page (not the agency homepage)
  - agency_name:     full agency name
  - platform_guess:  opengov | planetbids | bidsync | bonfire |
                     demandstar | jaggaer | ionwave | salesforce_aura
                     | peoplesoft | custom | unknown
  - reasoning:       one-line why

Output: `s3://.../scrapes/v2/exploration/{category}.json` — appended on
each run, deduped by URL.

The output is consumed by `agents.spec_onboarding.onboard_explored`,
which smart-routes candidates: known platforms go through the cheap
`discovery.py` verifier; unknown ones invoke the (more expensive)
`site_investigation` agent.

## Tools

- Anthropic's built-in `web_search` (server-side tool — Anthropic
  handles fetching + parsing; we just see search results).
- `report_candidate(...)` — emit a candidate. Non-terminal; the agent
  reports many.
- `mark_category_complete` — terminal; the agent calls this when done.

No Playwright in this agent — the deep-dive happens in
`site_investigation`. Keeping exploration light keeps the per-run cost
predictable.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import re
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Optional

import anthropic

from webscraping.v2 import budget, issues
from webscraping.v2.config import (
    ANTHROPIC_API_KEY,
    ANTHROPIC_MODEL,
    S3_BUCKET,
    get_s3_client,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Categories — the slices of the CA gov landscape the agent enumerates
# ---------------------------------------------------------------------------

CATEGORIES: dict[str, str] = {
    "ca_counties": (
        "All 58 California counties. Each county runs procurement out "
        "of a Purchasing Department, Internal Services Department, or "
        "similar. Look for the bid/RFP listing page on the county's "
        "official .gov / .ca.gov / .us site."
    ),
    "ca_cities": (
        "Top 100 California cities by population — large enough to "
        "have a dedicated procurement function. Start with Los Angeles, "
        "San Diego, San Jose, San Francisco, Fresno, Sacramento, Long "
        "Beach, Oakland, Bakersfield, and work down."
    ),
    "uc_system": (
        "All University of California campuses (10), UC Office of the "
        "President (UCOP), UC Health, and Lawrence Berkeley National "
        "Lab. Most use Jaggaer (CalUSource), but check each one."
    ),
    "csu_system": (
        "All 23 California State University campuses plus the CSU "
        "Chancellor's Office. Many use a shared Jaggaer instance via "
        "CSUBUY; some still run their own portals."
    ),
    "community_colleges": (
        "California community college districts (73 districts covering "
        "116 campuses). Smaller districts often share a procurement "
        "platform; check both individual districts and the statewide "
        "Foundation for California Community Colleges (FCCC)."
    ),
    "judicial": (
        "California Judicial Council, the Administrative Office of "
        "the Courts, and 58 superior courts (one per county). Many "
        "route procurement through the Judicial Council's central "
        "procurement page."
    ),
    "state_agencies": (
        "California state agencies and departments OUTSIDE the "
        "Cal eProcure umbrella. Targets: Caltrans, CalPERS, CalSTRS, "
        "CalEPA, CalRecycle, CalHR, CDCR, EDD, DMV, DGS-specialty "
        "portals, Lottery, Department of Water Resources."
    ),
    "transit_utility": (
        "Transit agencies and public utilities: LA Metro, BART, VTA, "
        "AC Transit, SamTrans, MWD (Metropolitan Water District), "
        "EBMUD, LADWP, SMUD, SDG&E (public-side), Port of Oakland, "
        "Port of Los Angeles, Port of Long Beach."
    ),
    "emerging_platforms": (
        "Open-ended: find PROCUREMENT SaaS PLATFORMS new to us that "
        "any California agency has migrated to. Target queries like "
        "'<California city> new procurement portal 2025', 'replaced "
        "PlanetBids', 'switched from BidSync to ...'. Returns "
        "candidates as one entry per platform-instance discovered."
    ),
}


# ---------------------------------------------------------------------------
# Platform recognition — URL patterns
# ---------------------------------------------------------------------------
#
# These map a portal URL to the platform vendor. The exploration agent
# is asked to populate `platform_guess` from the same rules; emitting
# this from the system prompt rather than letting the agent invent
# class names keeps the smart-router unambiguous on the receiving end.

PLATFORM_URL_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("opengov", re.compile(r"procurement\.opengov\.com/portal/([^/?#]+)", re.I)),
    ("planetbids", re.compile(r"vendors\.planetbids\.com/portal/(\d+)", re.I)),
    ("bidsync", re.compile(r"(?:^|//)([^.]+)\.bidsync\.com|//www\.bidsync\.com/", re.I)),
    ("bonfire", re.compile(r"(?:^|//)([^.]+)\.bonfirehub\.com", re.I)),
    ("demandstar", re.compile(r"demandstar\.com/agency/([^/?#]+)", re.I)),
    ("ionwave", re.compile(r"(?:^|//)([^.]+)\.ionwave\.net", re.I)),
    ("jaggaer", re.compile(r"\.sciquest\.com|jaggaer\.com|calusource", re.I)),
    ("periscope", re.compile(r"periscopeholdings\.com|bids\.periscopeholdings", re.I)),
    ("salesforce_aura", re.compile(r"/s/sfsites/|force\.com/", re.I)),
    ("peoplesoft", re.compile(r"/psc/|\.GBL", re.I)),
]


def classify_url(url: str) -> str:
    """Return the platform key for a URL, or 'unknown' if none match."""
    for key, pat in PLATFORM_URL_PATTERNS:
        if pat.search(url):
            return key
    return "unknown"


# ---------------------------------------------------------------------------
# Candidate dataclass + S3 persistence
# ---------------------------------------------------------------------------

@dataclass
class ExplorationCandidate:
    url: str
    agency_name: str
    platform_guess: str
    reasoning: str
    category: str
    found_at: str = ""


def _exploration_key(category: str) -> str:
    return f"scrapes/v2/exploration/{category}.json"


def _existing_urls_for_category(category: str) -> set[str]:
    """Load URLs already discovered in past runs of this category."""
    try:
        s3 = get_s3_client()
        resp = s3.get_object(Bucket=S3_BUCKET, Key=_exploration_key(category))
        data = json.loads(resp["Body"].read())
        return {c["url"].rstrip("/") for c in data.get("candidates", [])}
    except Exception:
        return set()


def _known_skip_set() -> set[str]:
    """Build the dedupe set: every portal we already onboarded.

    Pulled from three sources:
      1. In-code OpenGov / PlanetBids / BidSync agency registries.
      2. S3 onboarding registries (`registry/{platform}.json` —
         OpenGov tenants the discovery agent already verified).
      3. S3 spec-driven registry (`spec_sites/*.json` — anything the
         investigation agent has already onboarded).
    """
    skip: set[str] = set()

    try:
        from webscraping.v2.scrapers.opengov import OPENGOV_AGENCIES
        for a in OPENGOV_AGENCIES.values():
            skip.add(a["url"].rstrip("/"))
    except Exception:
        pass
    try:
        from webscraping.v2.scrapers.planetbids import PLANETBIDS_AGENCIES
        for a in PLANETBIDS_AGENCIES.values():
            skip.add(a["url"].rstrip("/"))
    except Exception:
        pass
    try:
        from webscraping.v2.scrapers.bidsync import BIDSYNC_AGENCIES
        for a in BIDSYNC_AGENCIES.values():
            url = a.get("url") if isinstance(a, dict) else None
            if url:
                skip.add(url.rstrip("/"))
    except Exception:
        pass

    try:
        s3 = get_s3_client()
        # OpenGov dynamic registry
        try:
            resp = s3.get_object(
                Bucket=S3_BUCKET, Key="scrapes/v2/registry/opengov.json"
            )
            data = json.loads(resp["Body"].read())
            if isinstance(data, dict):
                for a in data.values():
                    if isinstance(a, dict) and a.get("url"):
                        skip.add(a["url"].rstrip("/"))
        except Exception:
            pass
        # Spec-driven sites
        try:
            paginator = s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(
                Bucket=S3_BUCKET, Prefix="scrapes/v2/spec_sites/"
            ):
                for obj in page.get("Contents") or []:
                    key = obj["Key"]
                    if not key.endswith(".json") or key.endswith("_failures.json"):
                        continue
                    body = s3.get_object(Bucket=S3_BUCKET, Key=key)["Body"].read()
                    entry = json.loads(body)
                    if isinstance(entry, dict) and entry.get("url"):
                        skip.add(entry["url"].rstrip("/"))
        except Exception:
            pass
    except Exception:
        pass

    return skip


def save_candidates(category: str, candidates: list[ExplorationCandidate]) -> str:
    """Persist (merge-on-URL) the candidate list for `category`."""
    s3 = get_s3_client()
    key = _exploration_key(category)
    try:
        resp = s3.get_object(Bucket=S3_BUCKET, Key=key)
        existing = json.loads(resp["Body"].read()).get("candidates", [])
    except Exception:
        existing = []

    by_url: dict[str, dict] = {c["url"].rstrip("/"): c for c in existing}
    for c in candidates:
        by_url[c.url.rstrip("/")] = asdict(c)

    body = {
        "category": category,
        "updated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(by_url),
        "candidates": list(by_url.values()),
    }
    s3.put_object(
        Bucket=S3_BUCKET,
        Key=key,
        Body=json.dumps(body, indent=2),
        ContentType="application/json",
    )
    logger.info(
        f"Exploration: saved {len(candidates)} new + {len(existing)} existing "
        f"= {len(by_url)} total candidates to s3://{S3_BUCKET}/{key}"
    )
    return key


# ---------------------------------------------------------------------------
# Tool box used by the agent
# ---------------------------------------------------------------------------

@dataclass
class ExplorerToolbox:
    category: str
    candidates: list[ExplorationCandidate] = field(default_factory=list)
    seen_urls: set[str] = field(default_factory=set)
    skip_urls: set[str] = field(default_factory=set)
    complete: bool = False
    complete_note: str = ""


def _normalise_url(url: str) -> str:
    url = (url or "").strip()
    if not url:
        return url
    # Strip trailing slash / fragments / utm params for dedupe.
    url = re.sub(r"#.*$", "", url)
    url = re.sub(r"[?&]utm_[^=]+=[^&]*", "", url)
    return url.rstrip("/?&")


def tool_report_candidate(tb: ExplorerToolbox, args: dict) -> str:
    url = _normalise_url(args.get("url", ""))
    if not url:
        return "ERROR: url is required"
    if url in tb.skip_urls:
        return f"skipped: already onboarded ({url})"
    if url in tb.seen_urls:
        return f"skipped: duplicate this run ({url})"

    agency_name = (args.get("agency_name") or "").strip()
    if not agency_name:
        return "ERROR: agency_name is required"

    platform_guess = (args.get("platform_guess") or "").strip().lower() or "unknown"
    # If the URL matches a known pattern, override whatever the agent
    # claimed — pattern match is authoritative.
    classified = classify_url(url)
    if classified != "unknown":
        platform_guess = classified

    candidate = ExplorationCandidate(
        url=url,
        agency_name=agency_name,
        platform_guess=platform_guess,
        reasoning=(args.get("reasoning") or "").strip(),
        category=tb.category,
        found_at=datetime.now(timezone.utc).isoformat(),
    )
    tb.candidates.append(candidate)
    tb.seen_urls.add(url)
    logger.info(
        f"  candidate [{platform_guess}] {agency_name}: {url}"
    )
    return (
        f"accepted: platform={platform_guess}, total_so_far={len(tb.candidates)}"
    )


def tool_mark_category_complete(tb: ExplorerToolbox, args: dict) -> str:
    tb.complete = True
    tb.complete_note = (args.get("note") or "").strip()
    return f"noted; investigation will end ({len(tb.candidates)} candidates)"


TOOL_HANDLERS = {
    "report_candidate": tool_report_candidate,
    "mark_category_complete": tool_mark_category_complete,
}


# Custom tool schemas (the Anthropic-built-in `web_search` tool gets
# added in `run_exploration` so the schema stays whatever the SDK
# version expects).
CUSTOM_TOOL_SCHEMAS: list[dict] = [
    {
        "name": "report_candidate",
        "description": (
            "Emit a candidate procurement portal for downstream "
            "investigation/onboarding. Call once per portal you "
            "identify. Do NOT call this for agency homepages — only "
            "for the actual bid/RFP/solicitation listing URL."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": (
                        "The LISTING page URL (where bids/RFPs are "
                        "indexed), not the agency homepage."
                    ),
                },
                "agency_name": {
                    "type": "string",
                    "description": "Full agency name, e.g. 'City of Long Beach'",
                },
                "platform_guess": {
                    "type": "string",
                    "enum": [
                        "opengov",
                        "planetbids",
                        "bidsync",
                        "bonfire",
                        "demandstar",
                        "jaggaer",
                        "ionwave",
                        "periscope",
                        "salesforce_aura",
                        "peoplesoft",
                        "custom",
                        "unknown",
                    ],
                    "description": (
                        "Best guess from URL pattern. 'custom' = "
                        "agency-built portal; 'unknown' = can't tell."
                    ),
                },
                "reasoning": {
                    "type": "string",
                    "description": (
                        "One-line why you think this is the right URL "
                        "(useful for the audit log)."
                    ),
                },
            },
            "required": ["url", "agency_name", "platform_guess"],
        },
    },
    {
        "name": "mark_category_complete",
        "description": (
            "TERMINAL: call when you have reported every candidate "
            "you can find in this category. Pass a brief `note` "
            "summarising what you covered."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"note": {"type": "string"}},
        },
    },
]


# ---------------------------------------------------------------------------
# System prompt
# ---------------------------------------------------------------------------

SYSTEM_PROMPT = """You are an exploration agent. Given a category of California government agencies, find their procurement portals on the open web.

Your job is BREADTH, not depth. For each agency you can identify in the category, search the web to find its bid/RFP/solicitation listing page, classify the platform from the URL, and call `report_candidate`. When you have reported every agency you can find, call `mark_category_complete`.

# Platform recognition (URL patterns)

| Pattern in URL | platform_guess |
|---|---|
| `procurement.opengov.com/portal/{slug}` | opengov |
| `vendors.planetbids.com/portal/{id}` | planetbids |
| `*.bidsync.com` or `bidsync.com` | bidsync |
| `*.bonfirehub.com` | bonfire |
| `demandstar.com/agency/{slug}` | demandstar |
| `*.ionwave.net` | ionwave |
| `*.sciquest.com`, `jaggaer.com`, `calusource` | jaggaer |
| `periscopeholdings.com` | periscope |
| Contains `/s/sfsites/` or `force.com/` | salesforce_aura |
| Contains `/psc/` or `.GBL` | peoplesoft |
| Agency-built page on their own .gov domain | custom |
| Can't tell from URL | unknown |

# Workflow

1. Enumerate the agencies in this category. Use what you know from training, then `web_search` for "list of California [category]" or similar to fill gaps.
2. For each agency:
   a. `web_search` for "<agency name> procurement" or "<agency name> bid opportunities" or "<agency name> RFP".
   b. From results, identify the URL of the LISTING page (where bids are indexed) — NOT the agency homepage. Often titled "Bid Opportunities", "Current Solicitations", "Procurement", "Doing Business With Us".
   c. Classify the platform from the URL using the table above.
   d. Call `report_candidate` with url, agency_name, platform_guess, and a one-line `reasoning`.
3. When you have covered the category, call `mark_category_complete`.

# Rules

- ONE candidate per agency. If an agency has multiple platforms (rare), report the primary one with the highest activity.
- URL must be the LISTING page. Agency homepages are useless to downstream onboarding.
- Skip any agency whose URL is already in the "already onboarded" list provided in the user message.
- Don't invent URLs. If `web_search` doesn't produce a candidate URL for an agency, skip it.
- Stay California-only. If a search returns an out-of-state portal, skip it.
- Don't burn budget on agencies that obviously have no online procurement (e.g., very small special districts that fax RFPs). Skip them.

# Stop conditions

Call `mark_category_complete` when:
- You have reported every agency you can find in the category, OR
- The budget reminder injected in tool_result text says you have <10 turns left and you have any candidates reported.

A partial result is always better than no result.
"""


# ---------------------------------------------------------------------------
# Agent loop
# ---------------------------------------------------------------------------

DEFAULT_MAX_TURNS = 40
DEFAULT_MAX_TOKENS = 4096
DEFAULT_MODEL = "claude-sonnet-4-6"


def _serialize_assistant_content(blocks: list) -> list:
    out = []
    for b in blocks:
        if hasattr(b, "model_dump"):
            out.append(b.model_dump(exclude_unset=False))
        elif isinstance(b, dict):
            out.append(b)
        else:
            out.append({"type": getattr(b, "type", "text"), "text": str(b)})
    return out


def _build_user_seed(category: str, skip_urls: set[str]) -> str:
    desc = CATEGORIES.get(category, "")
    skip_block = ""
    if skip_urls:
        sample = sorted(skip_urls)[:60]
        skip_block = (
            "\n\nAlready onboarded — DO NOT report these URLs (or other "
            "URLs that would resolve to these portals):\n"
            + "\n".join(f"- {u}" for u in sample)
        )
        if len(skip_urls) > 60:
            skip_block += f"\n- ... and {len(skip_urls) - 60} more"
    return (
        f"Explore category: **{category}**\n\n"
        f"{desc}{skip_block}\n\n"
        f"Begin enumeration. Use `web_search` aggressively; call "
        f"`report_candidate` for each portal you find; call "
        f"`mark_category_complete` when you've covered the category."
    )


async def run_exploration(
    category: str,
    *,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> list[ExplorationCandidate]:
    """Run the exploration agent for one category. Returns new candidates."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY required for exploration agent")
    if category not in CATEGORIES:
        raise ValueError(
            f"Unknown category {category!r}; valid: {sorted(CATEGORIES)}"
        )

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    skip_urls = _known_skip_set() | _existing_urls_for_category(category)
    toolbox = ExplorerToolbox(category=category, skip_urls=skip_urls)

    user_seed = _build_user_seed(category, skip_urls)
    messages: list[dict] = [{"role": "user", "content": user_seed}]

    # The Anthropic SDK's web_search tool is a server-side tool — its
    # actual results are returned in the assistant's content blocks
    # automatically. We add our custom tools alongside.
    tools = list(CUSTOM_TOOL_SCHEMAS)
    tools.append({"type": "web_search_20250305", "name": "web_search"})
    # Cache the system prompt + tool block to amortise across turns.
    cached_tools = [dict(t) for t in tools]
    cached_tools[-1] = {**cached_tools[-1], "cache_control": {"type": "ephemeral"}}
    cached_system = [
        {
            "type": "text",
            "text": SYSTEM_PROMPT,
            "cache_control": {"type": "ephemeral"},
        }
    ]

    for turn in range(max_turns):
        logger.info("--- Exploration turn %d/%d ---", turn + 1, max_turns)

        try:
            budget.ensure_budget(0.30, source="exploration")
        except budget.BudgetExceeded as e:
            logger.warning("Exploration halted by budget: %s", e)
            issues.record_issue(
                category=issues.CATEGORY_BUDGET_EXCEEDED,
                severity=issues.SEVERITY_WARN,
                source=f"exploration:{category}",
                summary=str(e),
                context={"turn": turn + 1, "candidates_so_far": len(toolbox.candidates)},
            )
            break

        try:
            response = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=cached_system,
                tools=cached_tools,
                messages=messages,
            )
        except Exception as e:
            logger.error("Exploration LLM call failed: %s", e)
            issues.record_issue(
                category=issues.CATEGORY_EXPLORATION_FAILED,
                severity=issues.SEVERITY_ERROR,
                source=f"exploration:{category}",
                summary=f"LLM call failed: {e}",
                context={"turn": turn + 1},
            )
            break

        # Cost-track.
        try:
            budget.record_response(response, model, source="exploration")
        except Exception as e:
            logger.debug(f"budget.record_response failed: {e}")
        # Estimate web_search billing — count server-tool uses this turn.
        web_search_uses = sum(
            1 for b in response.content
            if getattr(b, "type", None) == "server_tool_use"
            and getattr(b, "name", "") == "web_search"
        )
        if web_search_uses > 0:
            try:
                budget.record_web_search(web_search_uses, source="exploration")
            except Exception as e:
                logger.debug(f"budget.record_web_search failed: {e}")

        messages.append(
            {
                "role": "assistant",
                "content": _serialize_assistant_content(response.content),
            }
        )

        tool_uses = [
            b for b in response.content
            if getattr(b, "type", None) == "tool_use"
        ]
        if not tool_uses:
            logger.warning(
                "Exploration: no client-tool calls (stop_reason=%s) — stopping",
                response.stop_reason,
            )
            break

        tool_results = []
        for tu in tool_uses:
            handler = TOOL_HANDLERS.get(tu.name)
            if handler is None:
                result = f"ERROR: unknown tool {tu.name}"
            else:
                try:
                    result = handler(toolbox, tu.input or {})
                except Exception as e:  # noqa: BLE001
                    result = f"ERROR: tool {tu.name} raised: {e}"
            tool_results.append(
                {
                    "type": "tool_result",
                    "tool_use_id": tu.id,
                    "content": result,
                }
            )

        user_content: list = list(tool_results)
        turns_remaining = max_turns - turn - 1
        if 0 < turns_remaining <= 8:
            user_content.append(
                {
                    "type": "text",
                    "text": (
                        f"BUDGET: {turns_remaining} turns left. Wrap up — "
                        f"if you have any candidates, call "
                        f"`mark_category_complete` now."
                    ),
                }
            )
        messages.append({"role": "user", "content": user_content})

        if toolbox.complete:
            logger.info(
                "Exploration complete: %d candidates (%s)",
                len(toolbox.candidates), toolbox.complete_note,
            )
            break
    else:
        # Loop fell off without `mark_category_complete`. Still save
        # whatever we got — partial results are useful.
        logger.warning(
            "Exploration exhausted %d turns without mark_category_complete",
            max_turns,
        )

    if toolbox.candidates:
        save_candidates(category, toolbox.candidates)
    return toolbox.candidates


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Explore one CA-gov category for procurement portals",
    )
    parser.add_argument(
        "category",
        choices=sorted(CATEGORIES),
        help="Which category to explore",
    )
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )

    candidates = asyncio.run(
        run_exploration(
            args.category, model=args.model, max_turns=args.max_turns
        )
    )
    print(json.dumps(
        {"category": args.category, "candidates": [asdict(c) for c in candidates]},
        indent=2, default=str,
    ))


if __name__ == "__main__":
    main()
