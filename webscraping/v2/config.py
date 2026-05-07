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

# Scraping defaults
DEFAULT_REQUEST_INTERVAL_MS = 3000
MAX_TEXT_CHARS = 15_000
# Inter-call sleep — only enforced for Groq's free-tier rate limits.
GROQ_SLEEP_SECONDS = 2
