"""
Site investigation agent.

Drives a real Chromium browser via Playwright and uses Claude as the
reasoning brain to figure out how to scrape an unknown procurement
portal. Outputs an `InvestigationSpec` describing the cleanest scrape
strategy plus the call/URL templates needed.

The spec is the contract between investigation and code generation: a
follow-up step (or a human) takes the spec and writes a structured
scraper module that follows the same `BaseScraper` conventions as
Cal eProcure / PlanetBids / OpenGov.

## Goal hierarchy

The agent prefers — in this order:

  1. Clean REST JSON API on a separate host (the OpenGov pattern).
  2. Salesforce Lightning / Aura RPC (`/s/sfsites/aura`).
  3. PeopleSoft IScripts and similar enterprise wrappers.
  4. Rendered-HTML scrape via Playwright + BeautifulSoup.

Confidence reflects how stable the resulting scraper is likely to be.

## Run locally

  python -m webscraping.v2.agents.site_investigation \\
      https://procurement.opengov.com/portal/pasadena \\
      --out /tmp/pasadena.spec.json
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import dataclass
from typing import Any, Optional

import anthropic
from playwright.async_api import Page, Request, Response, async_playwright
from pydantic import BaseModel, Field

from webscraping.v2.config import ANTHROPIC_API_KEY

logger = logging.getLogger(__name__)


# ============================================================================
# Spec model — the agent's terminal output
# ============================================================================

class ListingEndpoint(BaseModel):
    """How to fetch the listing of bids/RFPs for the portal."""

    method: str = Field(..., description="HTTP method, e.g. GET or POST")
    url_template: str = Field(
        ...,
        description=(
            "URL template; may include placeholders like {slug}, "
            "{page}, {limit}"
        ),
    )
    body_template: Optional[str] = Field(
        None,
        description=(
            "Request body template for POST/etc.; may include "
            "placeholders. Omit for GET."
        ),
    )
    headers_required: dict[str, str] = Field(
        default_factory=dict,
        description=(
            "Headers the server requires (e.g. browser-like User-Agent "
            "to dodge Cloudflare). Don't include cookies or tokens."
        ),
    )
    response_format: str = Field(..., description="json or html")
    rows_path: str = Field(
        "",
        description=(
            "For json: dotted path from the response root to the array "
            "of rows (e.g. 'rows', 'data.projects'). Empty when the "
            "response itself IS the array."
        ),
    )
    row_id_field: str = Field(
        "",
        description=(
            "Field name on each row that's the per-bid identifier the "
            "detail endpoint expects."
        ),
    )
    row_title_field: str = Field("", description="Field name on each row that holds the title.")


class DetailEndpoint(BaseModel):
    """How to fetch the per-bid detail when the listing doesn't have everything."""

    method: str
    url_template: str = Field(..., description="URL template using {id}")
    body_template: Optional[str] = None
    headers_required: dict[str, str] = Field(default_factory=dict)
    response_format: str
    summary_field: str = ""
    attachment_array_path: str = ""
    attachment_url_field: str = ""
    attachment_filename_field: str = ""
    contact_email_field: str = ""
    contact_name_field: str = ""
    contact_phone_field: str = ""


class InvestigationSpec(BaseModel):
    """Top-level scrape spec for a procurement portal."""

    portal_url: str
    platform_class: str = Field(
        ...,
        description=(
            "One of: opengov_api, salesforce_aura, "
            "peoplesoft_iscript, rendered_html, custom"
        ),
    )
    confidence: str = Field(..., description="high | medium | low")
    listing: ListingEndpoint
    detail: Optional[DetailEndpoint] = None
    notes: str = Field(
        "",
        description=(
            "Caveats: header gotchas, token-rotation needs, anti-bot "
            "considerations, anything a human should verify before "
            "deploying the scraper."
        ),
    )


# ============================================================================
# Network capture — listens to fetch/XHR via Playwright events
# ============================================================================

@dataclass
class CapturedRequest:
    method: str
    url: str
    post_data: Optional[str]
    resource_type: str
    timestamp: float
    response_status: Optional[int] = None
    response_content_type: str = ""


# Substrings on the URL that mark a request as analytics/noise. The agent
# rarely cares about these, so the default filter drops them. Add to this
# list rather than special-casing in the agent.
_NETWORK_NOISE = (
    "google-analytics",
    "googletagmanager",
    "gstatic",
    "cookielaw",
    "piwik",
    "segment.io",
    "launchdarkly",
    "pendo.io",
    "grafana",
    "doubleclick",
    "facebook.com",
    "stats.g.doubleclick",
)


class NetworkCapture:
    """Records XHR/fetch traffic for the agent to inspect.

    Listens via Playwright's `request` and `response` events rather than
    JS injection — survives navigations, no script to install, no race
    against page bootstrap.
    """

    def __init__(self, page: Page):
        self.page = page
        self.requests: list[CapturedRequest] = []
        page.on("request", self._on_request)
        page.on("response", self._on_response)

    def _on_request(self, request: Request) -> None:
        if request.resource_type not in ("xhr", "fetch"):
            return
        self.requests.append(
            CapturedRequest(
                method=request.method,
                url=request.url,
                post_data=request.post_data,
                resource_type=request.resource_type,
                timestamp=time.time(),
            )
        )

    def _on_response(self, response: Response) -> None:
        if response.request.resource_type not in ("xhr", "fetch"):
            return
        # Update the most recent matching request without a status yet.
        for req in reversed(self.requests):
            if req.url == response.url and req.response_status is None:
                req.response_status = response.status
                ct = response.headers.get("content-type") or response.headers.get(
                    "Content-Type", ""
                )
                req.response_content_type = ct
                break

    def filtered(self, host_filter: Optional[str] = None) -> list[CapturedRequest]:
        out = [r for r in self.requests if not any(n in r.url for n in _NETWORK_NOISE)]
        if host_filter:
            out = [r for r in out if host_filter in r.url]
        return out

    def clear(self) -> None:
        self.requests.clear()


# ============================================================================
# Toolbox — bag of stuff the tool functions read/write
# ============================================================================

@dataclass
class Toolbox:
    page: Page
    capture: NetworkCapture
    spec_received: Optional[InvestigationSpec] = None
    failure_reason: Optional[str] = None


# ============================================================================
# Tool implementations
# ============================================================================

async def tool_navigate(tb: Toolbox, args: dict) -> str:
    url = args["url"]
    try:
        await tb.page.goto(url, wait_until="domcontentloaded", timeout=45000)
        await tb.page.wait_for_timeout(3000)
        title = await tb.page.title()
        return f"navigated to {tb.page.url}; title: {title!r}"
    except Exception as e:
        return f"navigate failed: {e}"


async def tool_click(tb: Toolbox, args: dict) -> str:
    text = args.get("text")
    selector = args.get("selector")
    if not (text or selector):
        return "ERROR: must pass `text` or `selector`"
    try:
        if text:
            await tb.page.get_by_text(text, exact=False).first.click(timeout=10000)
        else:
            await tb.page.click(selector, timeout=10000)
        await tb.page.wait_for_timeout(2500)
        return f"clicked; new URL: {tb.page.url}"
    except Exception as e:
        return f"click failed: {e}"


async def tool_read_page_text(tb: Toolbox, args: dict) -> str:
    max_chars = args.get("max_chars", 4000)
    try:
        title = await tb.page.title()
        text = await tb.page.evaluate(
            "() => document.body ? document.body.innerText : ''"
        )
    except Exception as e:
        return f"read_page_text failed: {e}"
    return json.dumps(
        {
            "url": tb.page.url,
            "title": title,
            "body_text": text[:max_chars],
            "body_text_total_len": len(text),
        },
        indent=2,
    )


async def tool_recent_xhr(tb: Toolbox, args: dict) -> str:
    limit = args.get("limit", 15)
    host_filter = args.get("host_filter")
    include_body = args.get("include_body", True)
    rows = tb.capture.filtered(host_filter)[-limit:]
    out = []
    for r in rows:
        entry: dict[str, Any] = {
            "method": r.method,
            "path": r.url.split("?")[0],
            "query_len": len(r.url.split("?", 1)[1]) if "?" in r.url else 0,
            "post_data_len": len(r.post_data) if r.post_data else 0,
            "response_status": r.response_status,
            "content_type": r.response_content_type,
        }
        if include_body and r.post_data:
            entry["post_data_preview"] = r.post_data[:400]
        out.append(entry)
    return json.dumps(out, indent=2, default=str)


async def tool_replay(tb: Toolbox, args: dict) -> str:
    """Re-issue an HTTP call from the same browser context (cookies, UA)."""
    method = args["method"].upper()
    url = args["url"]
    body = args.get("body")
    headers = dict(args.get("headers") or {})

    try:
        ctx = tb.page.context
        if method == "GET":
            resp = await ctx.request.get(url, headers=headers, timeout=30000)
        elif method == "POST":
            kwargs: dict[str, Any] = {"headers": headers, "timeout": 30000}
            if body:
                # Detect JSON vs form body by sniffing leading char.
                stripped = body.strip() if isinstance(body, str) else ""
                if stripped.startswith("{") or stripped.startswith("["):
                    try:
                        json.loads(stripped)
                        headers.setdefault("Content-Type", "application/json")
                    except Exception:
                        pass
                kwargs["data"] = body
            resp = await ctx.request.post(url, **kwargs)
        else:
            return f"ERROR: unsupported method {method}"
    except Exception as e:
        return f"replay failed: {e}"

    status = resp.status
    ct = (resp.headers.get("content-type") or "").lower()
    summary: dict[str, Any] = {"status": status, "content_type": ct}

    if "json" in ct:
        try:
            j = await resp.json()
            summary["json_type"] = type(j).__name__
            if isinstance(j, dict):
                keys = list(j.keys())
                summary["top_keys"] = keys[:30]
                summary["sample_value_types"] = {
                    k: type(j[k]).__name__ for k in keys[:15]
                }
                # Surface the first array-of-objects child — almost
                # always the row list.
                for k in keys:
                    v = j[k]
                    if isinstance(v, list) and v and isinstance(v[0], dict):
                        summary[f"{k}_array_len"] = len(v)
                        summary[f"{k}_item_keys"] = list(v[0].keys())[:30]
                        break
            elif isinstance(j, list):
                summary["array_len"] = len(j)
                if j and isinstance(j[0], dict):
                    summary["item_keys"] = list(j[0].keys())[:30]
        except Exception as e:
            summary["json_parse_error"] = str(e)[:200]
    else:
        text = await resp.text()
        summary["body_len"] = len(text)
        summary["body_first_400"] = text[:400]

    return json.dumps(summary, indent=2, default=str)


_REACT_FIBER_JS = """
([text, fields]) => {
    const els = Array.from(document.querySelectorAll('a, div, span, button, td'));
    const el = els.find(e => (e.textContent || '').trim() === text);
    if (!el) return { found: false, reason: 'no element with that exact text' };
    const fk = Object.keys(el).find(k => k.startsWith('__reactFiber'));
    if (!fk) return { found: false, reason: 'no react fiber on element' };
    let walk = el[fk];
    for (let i = 0; i < 12 && walk; i++) {
        const orig = walk.memoizedProps && walk.memoizedProps.original;
        const okFields = orig && typeof orig === 'object' &&
            (fields.length === 0 || fields.every(f => f in orig));
        if (okFields) {
            const out = {};
            const keys = fields.length ? fields : Object.keys(orig).slice(0, 12);
            for (const f of keys) {
                const v = orig[f];
                out[f] = (typeof v === 'object' && v !== null) ? `[${typeof v}]` : v;
            }
            return {
                found: true,
                fields: out,
                allKeys: Object.keys(orig).slice(0, 40),
                fiberDepth: i,
            };
        }
        walk = walk.return;
    }
    return { found: false, reason: 'no fiber prop with all required fields' };
}
"""


async def tool_inspect_react(tb: Toolbox, args: dict) -> str:
    text = args["text"]
    fields = args.get("fields") or []
    try:
        result = await tb.page.evaluate(_REACT_FIBER_JS, [text, fields])
    except Exception as e:
        return f"inspect_react failed: {e}"
    return json.dumps(result, default=str)


_DOM_CARD_JS = """
(text) => {
    const els = Array.from(document.querySelectorAll('*'));
    const el = els.find(e => (e.textContent || '').trim() === text && e.children.length === 0);
    if (!el) return { found: false };
    let n = el;
    const trail = [];
    for (let i = 0; i < 6 && n; i++) {
        trail.push({
            depth: i,
            tag: n.tagName,
            cls: (n.getAttribute('class') || '').slice(0, 100),
            href: n.getAttribute && n.getAttribute('href'),
            childCount: n.children.length,
        });
        n = n.parentElement;
    }
    return { found: true, trail };
}
"""


async def tool_dom_card(tb: Toolbox, args: dict) -> str:
    try:
        result = await tb.page.evaluate(_DOM_CARD_JS, args["text"])
    except Exception as e:
        return f"dom_card failed: {e}"
    return json.dumps(result, default=str)


async def tool_report(tb: Toolbox, args: dict) -> str:
    try:
        spec = InvestigationSpec.model_validate(args)
    except Exception as e:
        return (
            f"ERROR: spec validation failed: {e}; "
            f"please fix the fields and re-call `report`."
        )
    tb.spec_received = spec
    return "spec accepted; investigation will end"


async def tool_give_up(tb: Toolbox, args: dict) -> str:
    tb.failure_reason = args.get("reason", "agent gave up")
    return "noted; investigation will end"


# ----------------------------------------------------------------------------
# Tool registry + JSON schemas (sent to the model)
# ----------------------------------------------------------------------------

TOOL_HANDLERS = {
    "navigate": tool_navigate,
    "click": tool_click,
    "read_page_text": tool_read_page_text,
    "recent_xhr": tool_recent_xhr,
    "replay": tool_replay,
    "inspect_react": tool_inspect_react,
    "dom_card": tool_dom_card,
    "report": tool_report,
    "give_up": tool_give_up,
}


TOOL_SCHEMAS: list[dict] = [
    {
        "name": "navigate",
        "description": (
            "Navigate the browser to a URL. Use for the initial portal "
            "load and any time you've inferred a different listing/detail "
            "URL from the page text."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"url": {"type": "string"}},
            "required": ["url"],
        },
    },
    {
        "name": "click",
        "description": (
            "Click an element by visible text or CSS selector. Use to "
            "navigate into the listing page or to fire a Search button "
            "that triggers an XHR. Pass exactly one of `text` or `selector`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Visible text on the element (partial match)",
                },
                "selector": {"type": "string", "description": "CSS selector"},
            },
        },
    },
    {
        "name": "read_page_text",
        "description": (
            "Return the page's body innerText (truncated). Useful when you "
            "need to orient yourself — find the right link to click, see if "
            "results rendered, etc."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "max_chars": {"type": "integer", "default": 4000},
            },
        },
    },
    {
        "name": "recent_xhr",
        "description": (
            "List recent XHR/fetch calls captured by the page (filtered to "
            "non-noise hosts). Returns method, path, body shape, response "
            "status. Call AFTER an action that should fire network "
            "activity (search, click into detail)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "default": 15},
                "host_filter": {
                    "type": "string",
                    "description": (
                        "Substring on the URL — useful to focus on the API "
                        "host once you've identified it"
                    ),
                },
                "include_body": {"type": "boolean", "default": True},
            },
        },
    },
    {
        "name": "replay",
        "description": (
            "Re-issue an HTTP call from the same browser context (so it "
            "carries the same cookies + UA). Returns response shape: "
            "status, content-type, top-level keys (for JSON) or first 400 "
            "chars (for HTML). Use to confirm a captured XHR is replayable "
            "and to inspect its shape."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "method": {"type": "string", "enum": ["GET", "POST"]},
                "url": {"type": "string"},
                "body": {
                    "type": "string",
                    "description": "Request body (form-encoded or JSON string)",
                },
                "headers": {
                    "type": "object",
                    "description": "Extra headers (rare; cookies come from context)",
                },
            },
            "required": ["method", "url"],
        },
    },
    {
        "name": "inspect_react",
        "description": (
            "Find an element by exact text and walk its React Fiber to "
            "extract props from the parent component. Useful when the "
            "visible row text is in DOM but the underlying ID lives in "
            "React component state (the OpenGov pattern). Specify the "
            "field names you expect to find on the row data."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {
                    "type": "string",
                    "description": "Exact text content of the leaf element",
                },
                "fields": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Field names you expect on the row data (e.g. "
                        "['id', 'financialId']). If empty, returns the "
                        "first 12 keys."
                    ),
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "dom_card",
        "description": (
            "Find an element by exact text and return its 6-level "
            "ancestor chain (tags, classes, href). Useful to understand "
            "row markup on server-rendered listings."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "report",
        "description": (
            "TERMINAL: emit the InvestigationSpec describing how to "
            "scrape this portal. Call ONCE at the end."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "portal_url": {"type": "string"},
                "platform_class": {
                    "type": "string",
                    "enum": [
                        "opengov_api",
                        "salesforce_aura",
                        "peoplesoft_iscript",
                        "rendered_html",
                        "custom",
                    ],
                },
                "confidence": {
                    "type": "string",
                    "enum": ["high", "medium", "low"],
                },
                "listing": {
                    "type": "object",
                    "properties": {
                        "method": {"type": "string"},
                        "url_template": {"type": "string"},
                        "body_template": {"type": "string"},
                        "headers_required": {"type": "object"},
                        "response_format": {
                            "type": "string",
                            "enum": ["json", "html"],
                        },
                        "rows_path": {"type": "string"},
                        "row_id_field": {"type": "string"},
                        "row_title_field": {"type": "string"},
                    },
                    "required": ["method", "url_template", "response_format"],
                },
                "detail": {
                    "type": "object",
                    "properties": {
                        "method": {"type": "string"},
                        "url_template": {"type": "string"},
                        "body_template": {"type": "string"},
                        "headers_required": {"type": "object"},
                        "response_format": {"type": "string"},
                        "summary_field": {"type": "string"},
                        "attachment_array_path": {"type": "string"},
                        "attachment_url_field": {"type": "string"},
                        "attachment_filename_field": {"type": "string"},
                        "contact_email_field": {"type": "string"},
                        "contact_name_field": {"type": "string"},
                        "contact_phone_field": {"type": "string"},
                    },
                },
                "notes": {"type": "string"},
            },
            "required": ["portal_url", "platform_class", "confidence", "listing"],
        },
    },
    {
        "name": "give_up",
        "description": (
            "TERMINAL: declare the portal infeasible (down, requires "
            "Civitas-incompatible login, etc.). Provide a concrete "
            "`reason`."
        ),
        "input_schema": {
            "type": "object",
            "properties": {"reason": {"type": "string"}},
            "required": ["reason"],
        },
    },
]


# ============================================================================
# System prompt
# ============================================================================

SYSTEM_PROMPT = """You are an investigation agent. Given a procurement portal URL, drive a real Chromium browser to figure out the cleanest way to scrape it. Your terminal action emits an InvestigationSpec describing the strategy.

# Goal hierarchy (prefer earlier ones)

1. Clean REST JSON API on a separate host. Best case. Example: OpenGov exposes `api.procurement.opengov.com` with simple POST/GET that returns clean JSON; no Cloudflare on the API host. **Look for this first.**

2. Salesforce Lightning / Aura RPC. Common on `/s/` URLs (Salesforce Experience Cloud). Single endpoint at `/s/sfsites/aura` with action descriptors. Usable but brittle (token rotation, context blob).

3. PeopleSoft IScripts and similar enterprise wrappers. Recognisable by URLs like `/psc/.../s/WEBLIB_*.FieldFormula.IScript_*` or `*.GBL`. Usually returns HTML, not JSON. Often the simplest scrape is parsing the wrapper page's rendered DOM.

4. Rendered-HTML scrape. Fall-back: load in Playwright (or via ScrapingBee if Cloudflare blocks), parse with BeautifulSoup. Use this when there's no clean API and the data is fully in the rendered DOM.

# Workflow

1. `navigate` to the portal URL.
2. `read_page_text` to orient yourself.
3. Find the listing/search page. May need a `click` to navigate to it.
4. Once on a listing with multiple bid rows, look for an XHR fired during search:
   - Trigger a search (`click` the search/filter button).
   - `recent_xhr` to see what fired.
   - For each non-noise XHR, decide whether it's the listing call.
5. `replay` the candidate listing call. Confirm it returns useful data.
6. Find the per-row identifier:
   - For React apps, `inspect_react` with the row title and likely field names like ["id", "financialId", "projectNumber"].
   - For server-rendered, `dom_card` to inspect row markup.
7. Find the detail endpoint:
   - `click` into one bid; watch `recent_xhr`.
   - If a clean detail API exists, `replay` it to confirm the shape.
8. When confident, call `report` with the spec.

# Spec quality

- Prefer `platform_class: opengov_api` (clean REST) > `salesforce_aura` > `peoplesoft_iscript` > `rendered_html`.
- `confidence`: a clean unauth GET = high; an Aura RPC needing a context blob = medium; a brittle DOM scrape = low.
- `notes` should record header gotchas (e.g. "API 403s the default python-requests/X.Y.Z UA — needs a browser-like User-Agent"), token-rotation needs, anti-bot considerations, and anything a human should verify before deploying.
- **Use template placeholders, not the specific values you used while investigating.** If you tested with `pasadena`, the spec MUST show `{slug}` not `pasadena`. If you tested detail with id `232604`, the spec MUST show `{id}` not `232604`. The placeholder convention: `{slug}` for the per-portal/per-tenant identifier in the URL, `{id}` for the per-bid identifier, `{page}` and `{limit}` for pagination params. Hardcoded specific values produce a single-portal scraper that won't generalize.
- Don't include session-bound tokens (CSRF, Aura tokens, ViewState, cookies) in templates either — those have to be re-extracted at scrape time, so the spec describes them only in `notes`.

# Stop conditions — read this carefully

You have a strict budget. **As soon as both of these are true, call `report` IMMEDIATELY:**

- (a) `replay` of a candidate **listing** endpoint returned status 200 with a parseable list of rows (e.g. JSON `{count, rows[]}` or an array, or HTML containing visible bid rows).
- (b) `replay` of a candidate **detail** endpoint returned status 200 with per-row data including a description/summary field and ideally attachment URLs.

Do NOT keep exploring once both are true. Do NOT re-navigate to the SPA portal you started on once you've confirmed the API host works — the SPA will hit Cloudflare on subsequent loads, which is a dead end. Stay on the API host. Additional exploration burns turns and is not rewarded — the goal is the spec, not a perfect understanding of the site.

If a listing-only spec is what you have when turns run low, that is still useful — emit a spec with no `detail` endpoint and `confidence: medium` rather than letting the loop time out. Calling `report` with a partial spec is always better than not calling `report`.

If the portal is down, requires Civitas-incompatible login, or you've spent many turns without identifying ANY working endpoint, call `give_up` with a concrete reason.

# Worked example: OpenGov / Pasadena

- Portal URL: `https://procurement.opengov.com/portal/pasadena`
- Listing: `POST https://api.procurement.opengov.com/api/v1/government/{slug}/project/public` with body `{"status":"open","page":1,"limit":50}`. Response: `{count, rows[]}`. `rows_path: "rows"`, `row_id_field: "id"`, `row_title_field: "title"`.
- Detail: `GET https://api.procurement.opengov.com/api/v1/project/{id}`. Response includes `summary` (full HTML description), `attachments[]` (each with `url`, `filename`), and flat `contact*` fields (`contactEmail`, `contactDisplayName`, `contactPhoneComplete`).
- Notes: API 403s default `python-requests/X.Y.Z` UA; needs browser-like User-Agent. The customer-facing portal `procurement.opengov.com` has Cloudflare, but the API host `api.procurement.opengov.com` does not.
- platform_class: `opengov_api`, confidence: `high`.
"""


# ============================================================================
# Agent loop
# ============================================================================

DEFAULT_MAX_TURNS = 35
DEFAULT_MAX_TOKENS = 4096
DEFAULT_MODEL = "claude-sonnet-4-6"


def _serialize_assistant_content(blocks: list) -> list:
    """Convert anthropic SDK ContentBlock list to JSON-serializable dicts.

    Tool-use loops require sending the assistant's prior response back to
    the API. The SDK returns typed objects; round-tripping through dicts
    is the safest portable form across SDK versions.
    """
    out = []
    for b in blocks:
        if hasattr(b, "model_dump"):
            out.append(b.model_dump(exclude_unset=False))
        elif isinstance(b, dict):
            out.append(b)
        else:
            # Best-effort fallback
            out.append({"type": getattr(b, "type", "text"), "text": str(b)})
    return out


async def run_investigation(
    portal_url: str,
    *,
    headless: bool = True,
    model: str = DEFAULT_MODEL,
    max_turns: int = DEFAULT_MAX_TURNS,
    max_tokens: int = DEFAULT_MAX_TOKENS,
) -> Optional[InvestigationSpec]:
    """Run the agent loop. Returns the spec on success, None on failure."""
    if not ANTHROPIC_API_KEY:
        raise RuntimeError("ANTHROPIC_API_KEY required for investigation agent")

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=headless,
            args=[
                "--disable-blink-features=AutomationControlled",
                "--no-sandbox",
                "--disable-dev-shm-usage",
            ],
        )
        try:
            context = await browser.new_context(
                viewport={"width": 1440, "height": 900},
                user_agent=(
                    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/120.0.0.0 Safari/537.36"
                ),
                locale="en-US",
                timezone_id="America/Los_Angeles",
            )
            await context.add_init_script(
                'Object.defineProperty(navigator, "webdriver", '
                '{get: () => undefined});'
            )
            page = await context.new_page()
            capture = NetworkCapture(page)
            toolbox = Toolbox(page=page, capture=capture)

            messages: list[dict] = [
                {
                    "role": "user",
                    "content": (
                        "Investigate this procurement portal and produce "
                        "an InvestigationSpec describing how to scrape "
                        f"it:\n\n{portal_url}"
                    ),
                }
            ]

            # Prompt caching: the system prompt + tool schemas repeat on
            # every turn (~5 KB). Marking the last tool with
            # cache_control caches BOTH the tools list and the preceding
            # system block, so each turn pays ~1/10th the input rate on
            # those tokens. ~3× total cost reduction on long agent loops.
            cached_tools = [dict(t) for t in TOOL_SCHEMAS]
            cached_tools[-1] = {
                **cached_tools[-1],
                "cache_control": {"type": "ephemeral"},
            }
            cached_system = [
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ]

            for turn in range(max_turns):
                logger.info("--- Turn %d/%d ---", turn + 1, max_turns)

                # Budget gate: reserve a turn's worth before calling.
                # Pessimistic estimate ($0.20) handles the worst-case
                # late-turn invocation where history is largest.
                try:
                    from webscraping.v2 import budget as _budget
                    _budget.ensure_budget(0.20, source="investigation")
                except ImportError:
                    _budget = None
                except Exception as e:
                    # Budget exceeded → emit whatever spec we have and stop.
                    logger.warning(
                        "Investigation halted by budget at turn %d: %s",
                        turn + 1, e,
                    )
                    try:
                        from webscraping.v2 import issues as _issues
                        _issues.record_issue(
                            category=_issues.CATEGORY_BUDGET_EXCEEDED,
                            severity=_issues.SEVERITY_WARN,
                            source=f"investigation:{portal_url}",
                            summary=str(e),
                            context={"turn": turn + 1, "max_turns": max_turns},
                        )
                    except Exception:
                        pass
                    return toolbox.spec_received

                response = client.messages.create(
                    model=model,
                    max_tokens=max_tokens,
                    system=cached_system,
                    tools=cached_tools,
                    messages=messages,
                )

                # Cost-track this turn. Best-effort — never blocks the loop.
                if _budget is not None:
                    try:
                        _budget.record_response(
                            response, model, source="investigation"
                        )
                    except Exception as e:
                        logger.debug(f"budget.record_response failed: {e}")

                messages.append(
                    {
                        "role": "assistant",
                        "content": _serialize_assistant_content(response.content),
                    }
                )

                tool_uses = [b for b in response.content if getattr(b, "type", None) == "tool_use"]
                if not tool_uses:
                    logger.warning(
                        "No tool calls this turn (stop_reason=%s) — stopping",
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
                            result = await handler(toolbox, tu.input or {})
                        except Exception as e:  # noqa: BLE001
                            result = f"ERROR: tool {tu.name} raised: {e}"
                    logger.info("  tool=%s result_preview=%r", tu.name, result[:200])
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tu.id,
                            "content": result,
                        }
                    )

                # Budget reminder: when turns are running low, nudge the
                # model to terminate. Without this the loop tends to spend
                # its tail re-exploring instead of calling `report`.
                user_content: list = list(tool_results)
                turns_remaining = max_turns - turn - 1
                if 0 < turns_remaining <= 5:
                    user_content.append(
                        {
                            "type": "text",
                            "text": (
                                f"BUDGET: only {turns_remaining} turns left. "
                                f"If ANY listing endpoint is working, call "
                                f"`report` NOW with whatever you have. A "
                                f"partial spec is far better than no spec."
                            ),
                        }
                    )
                messages.append({"role": "user", "content": user_content})

                if toolbox.spec_received is not None:
                    logger.info("Investigation complete: spec received")
                    return toolbox.spec_received
                if toolbox.failure_reason is not None:
                    logger.warning("Investigation gave up: %s", toolbox.failure_reason)
                    return None

            logger.warning(
                "Investigation exhausted %d turns without a result", max_turns
            )
            return None
        finally:
            await browser.close()


# ============================================================================
# CLI
# ============================================================================

def main() -> None:
    parser = argparse.ArgumentParser(
        description="Investigate a procurement portal and emit a scrape spec",
    )
    parser.add_argument("url", help="Portal URL to investigate")
    parser.add_argument(
        "--no-headless",
        action="store_true",
        help="Show the browser (debug)",
    )
    parser.add_argument("--max-turns", type=int, default=DEFAULT_MAX_TURNS)
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--out", help="Path to write the spec JSON; default: stdout")
    parser.add_argument("--verbose", "-v", action="store_true")
    args = parser.parse_args()

    logging.basicConfig(
        level=logging.INFO if args.verbose else logging.WARNING,
        format="%(levelname)s %(message)s",
    )

    spec = asyncio.run(
        run_investigation(
            args.url,
            headless=not args.no_headless,
            model=args.model,
            max_turns=args.max_turns,
        )
    )

    if spec is None:
        print("Investigation failed", file=sys.stderr)
        sys.exit(1)

    out_text = json.dumps(spec.model_dump(), indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out_text)
        print(f"Wrote spec to {args.out}", file=sys.stderr)
    else:
        print(out_text)


if __name__ == "__main__":
    main()
