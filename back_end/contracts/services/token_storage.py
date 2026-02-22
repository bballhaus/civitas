"""
Auth tokens: stored in each user's S3 JSON file and in auth/tokens.json (token -> username).
No DynamoDB table for tokens.
"""
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from django.contrib.auth import get_user_model

from .user_data_s3 import (
    get_token_index,
    get_user_data,
    save_token_index,
    save_user_data,
)

logger = logging.getLogger(__name__)

TOKEN_VALID_DAYS = 30


def create_token(user_id: int) -> str:
    """Create a token, store in user's S3 JSON and in token index, return the token string."""
    User = get_user_model()
    try:
        user = User.objects.get(pk=user_id)
    except User.DoesNotExist:
        return ""
    username = user.username
    # Ensure user has a JSON file (profile may not exist yet)
    from .profile_storage import get_or_create_profile

    get_or_create_profile(user_id)
    token = secrets.token_urlsafe(32)
    now = datetime.now(timezone.utc)
    expires = (now + timedelta(days=TOKEN_VALID_DAYS)).isoformat()
    # Add token to user's JSON file
    data = get_user_data(username) or {}
    data["token"] = token
    data["token_expires_at"] = expires
    save_user_data(username, data)
    # Add token -> username to index for lookup
    index = get_token_index()
    index[token] = username
    save_token_index(index)
    logger.info("Token set in S3 for user_id=%s username=%s", user_id, username)
    return token


def get_user_id_for_token(token: str) -> Optional[int]:
    """Look up token in auth/tokens.json, get username, return Django user id."""
    if not token or not token.strip():
        return None
    token = token.strip()
    index = get_token_index()
    username = index.get(token)
    if not username:
        return None
    try:
        User = get_user_model()
        user = User.objects.get(username=username)
        # Check expiry from user's JSON
        data = get_user_data(username)
        if data:
            expires_at = data.get("token_expires_at")
            if expires_at:
                try:
                    exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
                    if datetime.now(timezone.utc) >= exp:
                        return None
                except Exception:
                    pass
        return user.pk
    except User.DoesNotExist:
        return None
    except Exception as e:
        logger.warning("Token lookup failed: %s", e)
        return None


def delete_token(token: str) -> None:
    """Remove token from index and from user's S3 JSON (e.g. on logout)."""
    if not token or not token.strip():
        return
    token = token.strip()
    index = get_token_index()
    username = index.pop(token, None)
    if not username:
        return
    save_token_index(index)
    # Remove from user's JSON
    data = get_user_data(username) or {}
    data.pop("token", None)
    data.pop("token_expires_at", None)
    save_user_data(username, data)
    logger.info("Token removed from S3 for username=%s", username)
