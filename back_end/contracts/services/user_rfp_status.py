"""
User RFP status: applied_rfp_ids (user marked as applied) and in_progress_rfp_ids (user generated POA).
Stored in S3 user JSON alongside profile.
"""
import logging

from django.contrib.auth import get_user_model

from .user_data_s3 import get_user_data, save_user_data
from .profile_storage import _username_for_user_id

logger = logging.getLogger(__name__)

USER_RFP_KEYS = ("applied_rfp_ids", "in_progress_rfp_ids")


def get_rfp_status(user_id: int) -> dict:
    """
    Return applied_rfp_ids and in_progress_rfp_ids for the user from S3.
    Returns {"applied_rfp_ids": [], "in_progress_rfp_ids": []} if missing or on error.
    """
    username = _username_for_user_id(user_id)
    if not username:
        return {"applied_rfp_ids": [], "in_progress_rfp_ids": []}
    data = get_user_data(username)
    if not data:
        return {"applied_rfp_ids": [], "in_progress_rfp_ids": []}
    applied = data.get("applied_rfp_ids")
    in_progress = data.get("in_progress_rfp_ids")
    if not isinstance(applied, list):
        applied = []
    if not isinstance(in_progress, list):
        in_progress = []
    return {"applied_rfp_ids": applied, "in_progress_rfp_ids": in_progress}


def _ensure_list(val):
    if isinstance(val, list):
        return val
    return []


def add_applied_rfp(user_id: int, rfp_id: str) -> dict:
    """Add rfp_id to user's applied list. Returns updated status."""
    username = _username_for_user_id(user_id)
    if not username:
        return get_rfp_status(user_id)
    data = get_user_data(username) or {}
    applied = _ensure_list(data.get("applied_rfp_ids"))
    rfp_id_str = str(rfp_id).strip()
    if rfp_id_str and rfp_id_str not in applied:
        applied.append(rfp_id_str)
        data["applied_rfp_ids"] = applied
        save_user_data(username, data)
        logger.info("User %s marked RFP %s as applied", user_id, rfp_id_str)
    return {"applied_rfp_ids": applied, "in_progress_rfp_ids": _ensure_list(data.get("in_progress_rfp_ids"))}


def remove_applied_rfp(user_id: int, rfp_id: str) -> dict:
    """Remove rfp_id from user's applied list. Returns updated status."""
    username = _username_for_user_id(user_id)
    if not username:
        return get_rfp_status(user_id)
    data = get_user_data(username) or {}
    applied = _ensure_list(data.get("applied_rfp_ids"))
    rfp_id_str = str(rfp_id).strip()
    if rfp_id_str and rfp_id_str in applied:
        applied = [x for x in applied if x != rfp_id_str]
        data["applied_rfp_ids"] = applied
        save_user_data(username, data)
        logger.info("User %s removed RFP %s from applied", user_id, rfp_id_str)
    return {"applied_rfp_ids": applied, "in_progress_rfp_ids": _ensure_list(data.get("in_progress_rfp_ids"))}


def add_in_progress_rfp(user_id: int, rfp_id: str) -> dict:
    """Add rfp_id to user's in_progress list (e.g. after generating POA). Returns updated status."""
    username = _username_for_user_id(user_id)
    if not username:
        return get_rfp_status(user_id)
    data = get_user_data(username) or {}
    in_progress = _ensure_list(data.get("in_progress_rfp_ids"))
    rfp_id_str = str(rfp_id).strip()
    if rfp_id_str and rfp_id_str not in in_progress:
        in_progress.append(rfp_id_str)
        data["in_progress_rfp_ids"] = in_progress
        save_user_data(username, data)
        logger.info("User %s marked RFP %s as in progress (POA generated)", user_id, rfp_id_str)
    return {"applied_rfp_ids": _ensure_list(data.get("applied_rfp_ids")), "in_progress_rfp_ids": in_progress}


def remove_in_progress_rfp(user_id: int, rfp_id: str) -> dict:
    """Remove rfp_id from user's in_progress list. Returns updated status."""
    username = _username_for_user_id(user_id)
    if not username:
        return get_rfp_status(user_id)
    data = get_user_data(username) or {}
    in_progress = _ensure_list(data.get("in_progress_rfp_ids"))
    rfp_id_str = str(rfp_id).strip()
    if rfp_id_str and rfp_id_str in in_progress:
        in_progress = [x for x in in_progress if x != rfp_id_str]
        data["in_progress_rfp_ids"] = in_progress
        save_user_data(username, data)
        logger.info("User %s removed RFP %s from in progress", user_id, rfp_id_str)
    return {"applied_rfp_ids": _ensure_list(data.get("applied_rfp_ids")), "in_progress_rfp_ids": in_progress}


def get_generated_poe(user_id: int, rfp_id: str) -> str | None:
    """Return saved Plan of Execution for this user and RFP from S3, or None."""
    username = _username_for_user_id(user_id)
    if not username:
        return None
    data = get_user_data(username)
    if not data:
        return None
    by_rfp = data.get("generated_poe_by_rfp")
    if not isinstance(by_rfp, dict):
        return None
    content = by_rfp.get(str(rfp_id).strip())
    return content if isinstance(content, str) else None


def save_generated_poe(user_id: int, rfp_id: str, content: str) -> None:
    """Save Plan of Execution for this user and RFP in S3."""
    username = _username_for_user_id(user_id)
    if not username:
        return
    rfp_id_str = str(rfp_id).strip()
    if not rfp_id_str:
        return
    data = get_user_data(username) or {}
    by_rfp = data.get("generated_poe_by_rfp")
    if not isinstance(by_rfp, dict):
        by_rfp = {}
    by_rfp[rfp_id_str] = content
    data["generated_poe_by_rfp"] = by_rfp
    save_user_data(username, data)
    logger.info("User %s saved generated POE for RFP %s", user_id, rfp_id_str)
