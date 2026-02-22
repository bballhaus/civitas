"""
Per-user JSON file in S3: one object per user at users/{username}.json.
All user information (profile, token, etc.) is serialized/deserialized as JSON.
No DynamoDB table for users or profiles.
"""
import json
import logging
from urllib.parse import quote

from django.conf import settings

from .aws_client import get_boto3_kwargs

logger = logging.getLogger(__name__)

USER_DATA_PREFIX = "users/"
TOKEN_INDEX_KEY = "auth/tokens.json"


def _s3_client():
    try:
        import boto3
        return boto3.client("s3", **get_boto3_kwargs())
    except Exception:
        return None


def _bucket():
    return getattr(settings, "AWS_STORAGE_BUCKET_NAME", None)


def _user_key(username: str) -> str:
    """S3 key for a user's JSON file. Username is quoted so it's safe for S3."""
    safe = quote(username, safe="")
    return f"{USER_DATA_PREFIX}{safe}.json"


def get_user_data(username: str) -> dict | None:
    """
    Load user data from S3 users/{username}.json. Deserialize JSON to dict.
    Returns None if bucket missing, key missing, or on error.
    """
    client = _s3_client()
    bucket = _bucket()
    if not client or not bucket:
        logger.warning("S3 not available; cannot read user data")
        return None
    key = _user_key(username)
    try:
        r = client.get_object(Bucket=bucket, Key=key)
        body = r["Body"].read().decode("utf-8")
        data = json.loads(body)
        logger.info("Read user data from S3 for username=%s", username)
        return data
    except client.exceptions.NoSuchKey:
        logger.info("No user data in S3 for username=%s", username)
        return None
    except Exception as e:
        logger.warning("Failed to read user data from S3 (username=%s): %s", username, e)
        return None


def save_user_data(username: str, data: dict) -> None:
    """
    Serialize data to JSON and put to S3 users/{username}.json.
    No-op if bucket or client unavailable.
    """
    client = _s3_client()
    bucket = _bucket()
    if not bucket:
        logger.warning(
            "S3 bucket not set: add AWS_STORAGE_BUCKET_NAME to .env (e.g. civitas-uploads). User data not saved."
        )
        return
    if not client:
        logger.warning("S3 client unavailable (check AWS credentials in .env). User data not saved.")
        return
    key = _user_key(username)
    try:
        body = json.dumps(data, default=str)
        client.put_object(Bucket=bucket, Key=key, Body=body, ContentType="application/json")
        logger.info("Saved user data to S3 bucket=%s key=%s", bucket, key)
    except Exception as e:
        logger.warning("Failed to save user data to S3 (bucket=%s key=%s): %s", bucket, key, e)


def get_token_index() -> dict:
    """Load auth/tokens.json from S3: { token_string: username }. Returns {} if missing or error."""
    client = _s3_client()
    bucket = _bucket()
    if not client or not bucket:
        return {}
    try:
        r = client.get_object(Bucket=bucket, Key=TOKEN_INDEX_KEY)
        body = r["Body"].read().decode("utf-8")
        return json.loads(body)
    except client.exceptions.NoSuchKey:
        return {}
    except Exception as e:
        logger.warning("Failed to read token index from S3: %s", e)
        return {}


def save_token_index(index: dict) -> None:
    """Write auth/tokens.json to S3."""
    client = _s3_client()
    bucket = _bucket()
    if not client or not bucket:
        return
    try:
        body = json.dumps(index, default=str)
        client.put_object(Bucket=bucket, Key=TOKEN_INDEX_KEY, Body=body, ContentType="application/json")
    except Exception as e:
        logger.warning("Failed to save token index to S3: %s", e)
