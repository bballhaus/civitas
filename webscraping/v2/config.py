"""
Configuration for the Civitas v2 scraping system.
Loads AWS credentials and API keys from environment / .env files.
"""

import json
import os
from functools import lru_cache
from pathlib import Path

import boto3
from dotenv import load_dotenv

# Load .env from back_end (has AWS + GROQ keys)
_BACKEND_ENV = Path(__file__).resolve().parent.parent.parent / "back_end" / ".env"
if _BACKEND_ENV.exists():
    load_dotenv(_BACKEND_ENV, override=True)
load_dotenv(override=True)  # also try CWD .env

# AWS — use `or None` so empty strings fall back to boto3's credential chain
# (IAM role on Lambda, ~/.aws on local dev)
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "") or None
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "") or None
AWS_REGION = os.environ.get("AWS_S3_REGION_NAME", os.environ.get("AWS_REGION", "us-east-1"))
S3_BUCKET = os.environ.get("AWS_STORAGE_BUCKET_NAME", "civitas-ai")


def get_s3_client():
    """Create an S3 client that works on both Lambda (IAM role) and local dev (.env creds).

    On Lambda: boto3 automatically uses the IAM role's temporary credentials
    (access key + secret + session token) from the environment.
    On local dev: dotenv loads long-term credentials from .env, which boto3
    picks up from the environment automatically.

    We never pass credentials explicitly — boto3's default credential chain
    handles both cases correctly.
    """
    return boto3.client("s3", region_name=AWS_REGION)

# S3 prefixes
S3_V2_PREFIX = "scrapes/v2/"
S3_LEGACY_PREFIX = "scrapes/caleprocure/"

# Secret names in AWS Secrets Manager
PLANETBIDS_SECRET_NAME = "civitas/scraping/planetbids"


@lru_cache(maxsize=8)
def get_secret(secret_name: str) -> dict:
    """Fetch a JSON secret from AWS Secrets Manager.

    Local fallback: if PLANETBIDS_USERNAME/PLANETBIDS_PASSWORD env vars are
    set and secret_name == PLANETBIDS_SECRET_NAME, return them without an
    AWS call. Lets developers run scrapes locally without IAM access.
    """
    if secret_name == PLANETBIDS_SECRET_NAME:
        env_user = os.environ.get("PLANETBIDS_USERNAME")
        env_pass = os.environ.get("PLANETBIDS_PASSWORD")
        if env_user and env_pass:
            return {"username": env_user, "password": env_pass}

    client = boto3.client("secretsmanager", region_name=AWS_REGION)
    resp = client.get_secret_value(SecretId=secret_name)
    return json.loads(resp["SecretString"])

# LLM — provider choice for PDF enrichment.
# "anthropic" (default): Claude Haiku 4.5 with prompt caching on the system
#   prompt; better structured extraction than llama 3.1 8B and the system
#   prompt cache makes per-PDF cost dominated by per-PDF text only.
# "groq": llama 3.1 8B fallback, kept as an escape hatch.
LLM_PROVIDER = os.environ.get("LLM_PROVIDER", "anthropic").strip().lower()

GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = "llama-3.1-8b-instant"

ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_MODEL = os.environ.get(
    "ANTHROPIC_MODEL", "claude-haiku-4-5-20251001"
)

# ScrapingBee — managed-scraping API used to bypass Cloudflare on
# protected portals (OpenGov today, possibly more later). Only sites
# that explicitly opt in via `requires_proxy=True` route through it,
# so credit burn is bounded to what actually needs it.
#
# Integration mode: API, not proxy. The proxy endpoint
# (proxy.scrapingbee.com:8886) does not expose stealth_proxy, which is
# what OpenGov's Cloudflare config requires — that path was tried,
# returned "Not found :(", and was removed. The API endpoint with
# render_js=true&stealth_proxy=true returns post-React-hydration HTML.
#
# Local: set SCRAPINGBEE_API_KEY in env / .env.
# Lambda: set SCRAPINGBEE_API_KEY env var, OR (preferred) store in
#   Secrets Manager at SCRAPINGBEE_SECRET_NAME and let get_secret()
#   pull it.
SCRAPINGBEE_SECRET_NAME = "civitas/scraping/scrapingbee"
SCRAPINGBEE_API_URL = "https://app.scrapingbee.com/api/v1/"


def _resolve_scrapingbee_key() -> str:
    """Env var first, then Secrets Manager. Empty string when neither."""
    key = os.environ.get("SCRAPINGBEE_API_KEY", "")
    if key:
        return key
    try:
        secret = get_secret(SCRAPINGBEE_SECRET_NAME)
    except Exception:
        return ""
    return (secret or {}).get("api_key", "") or (secret or {}).get("apiKey", "") or ""


def has_scrapingbee_key() -> bool:
    return bool(_resolve_scrapingbee_key())


def fetch_via_scrapingbee(
    url: str,
    render_js: bool = True,
    stealth: bool = True,
    timeout: int = 90,
) -> str:
    """Fetch `url` through ScrapingBee API mode and return rendered HTML.

    Defaults match what OpenGov needs to clear Cloudflare. Caller must
    handle the empty-key case explicitly — this function raises on a
    missing key rather than silently falling through to a direct GET,
    because a direct GET will hit Cloudflare and look like a generic
    network failure further down the stack.
    """
    import requests

    key = _resolve_scrapingbee_key()
    if not key:
        raise RuntimeError(
            "SCRAPINGBEE_API_KEY not configured (env var or Secrets "
            f"Manager '{SCRAPINGBEE_SECRET_NAME}')"
        )

    params = {
        "api_key": key,
        "url": url,
        "render_js": "true" if render_js else "false",
        "stealth_proxy": "true" if stealth else "false",
    }
    resp = requests.get(SCRAPINGBEE_API_URL, params=params, timeout=timeout)
    resp.raise_for_status()
    return resp.text

# Scraping defaults
DEFAULT_REQUEST_INTERVAL_MS = 3000
MAX_TEXT_CHARS = 15_000
# Inter-call sleep — only enforced for Groq's free-tier rate limits.
GROQ_SLEEP_SECONDS = 2
