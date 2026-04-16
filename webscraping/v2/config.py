"""
Configuration for the Civitas v2 scraping system.
Loads AWS credentials and API keys from environment / .env files.
"""

import os
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

# LLM
GROQ_API_KEY = os.environ.get("GROQ_API_KEY", "")
GROQ_MODEL = "llama-3.1-8b-instant"
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

# Scraping defaults
DEFAULT_REQUEST_INTERVAL_MS = 3000
MAX_TEXT_CHARS = 15_000
GROQ_SLEEP_SECONDS = 2
