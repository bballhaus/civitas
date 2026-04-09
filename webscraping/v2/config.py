"""
Configuration for the Civitas v2 scraping system.
Loads AWS credentials and API keys from environment / .env files.
"""

import os
from pathlib import Path

from dotenv import load_dotenv

# Load .env from back_end (has AWS + GROQ keys)
_BACKEND_ENV = Path(__file__).resolve().parent.parent.parent / "back_end" / ".env"
if _BACKEND_ENV.exists():
    load_dotenv(_BACKEND_ENV, override=True)
load_dotenv(override=True)  # also try CWD .env

# AWS
AWS_ACCESS_KEY_ID = os.environ.get("AWS_ACCESS_KEY_ID", "")
AWS_SECRET_ACCESS_KEY = os.environ.get("AWS_SECRET_ACCESS_KEY", "")
AWS_REGION = os.environ.get("AWS_S3_REGION_NAME", os.environ.get("AWS_REGION", "us-east-1"))
S3_BUCKET = os.environ.get("AWS_STORAGE_BUCKET_NAME", "civitas-ai")

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
