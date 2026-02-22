"""
User profile storage: one JSON file per user in S3 (users/{username}.json).
All profile data is serialized/deserialized; no DynamoDB table for users or profiles.
"""
import logging
from decimal import Decimal

from django.contrib.auth import get_user_model

from .user_data_s3 import get_user_data, save_user_data

logger = logging.getLogger(__name__)

# Profile dict keys matching API / UserProfileSerializer
PROFILE_ATTRS = [
    "name",
    "total_contract_value",
    "contract_count",
    "certifications",
    "clearances",
    "naics_codes",
    "industry_tags",
    "work_cities",
    "work_counties",
    "capabilities",
    "agency_experience",
    "created_at",
    "updated_at",
    "uploaded_documents",  # list of { id, title, document, created_at } sustained in profile
]


def _username_for_user_id(user_id):
    """Resolve Django user id to username."""
    try:
        User = get_user_model()
        return User.objects.get(pk=int(user_id)).username
    except Exception:
        return None


def _default_profile_dict(user_id):
    from django.utils import timezone

    now = timezone.now().isoformat()
    return {
        "user_id": user_id,
        "name": "",
        "total_contract_value": "0",
        "contract_count": 0,
        "certifications": [],
        "clearances": [],
        "naics_codes": [],
        "industry_tags": [],
        "work_cities": [],
        "work_counties": [],
        "capabilities": [],
        "agency_experience": [],
        "created_at": now,
        "updated_at": now,
        "uploaded_documents": [],
    }


def _json_to_profile(raw, user_id):
    """Convert JSON/dict (from S3) to profile dict for serializer (id = user_id)."""
    if not raw:
        return None
    total = raw.get("total_contract_value")
    if total is not None and not isinstance(total, str):
        total = str(total)
    return {
        "id": user_id,
        "name": raw.get("name") or "",
        "total_contract_value": total if total is not None else "0",
        "contract_count": int(raw.get("contract_count", 0)),
        "certifications": list(raw.get("certifications") or []),
        "clearances": list(raw.get("clearances") or []),
        "naics_codes": list(raw.get("naics_codes") or []),
        "industry_tags": list(raw.get("industry_tags") or []),
        "work_cities": list(raw.get("work_cities") or []),
        "work_counties": list(raw.get("work_counties") or []),
        "capabilities": list(raw.get("capabilities") or []),
        "agency_experience": list(raw.get("agency_experience") or []),
        "created_at": raw.get("created_at") or "",
        "updated_at": raw.get("updated_at") or "",
        "uploaded_documents": list(raw.get("uploaded_documents") or []),
    }


def profile_dict_to_object(profile_dict):
    """Return an object with attributes so UserProfileSerializer can serialize it."""
    if profile_dict is None:
        return None

    class ProfileObj:
        pass

    o = ProfileObj()
    for k, v in profile_dict.items():
        setattr(o, k, v)
    return o


def _profile_to_json(profile_dict):
    """Profile dict -> JSON-serializable dict (no user_id in stored profile blob)."""
    out = {}
    for k in PROFILE_ATTRS:
        v = profile_dict.get(k)
        if v is None and k in ("total_contract_value", "contract_count"):
            v = "0" if k == "total_contract_value" else 0
        if v is None and k == "uploaded_documents":
            v = []
        if v is not None:
            if k == "total_contract_value" and isinstance(v, (int, float, Decimal)):
                v = str(v)
            if k == "uploaded_documents":
                v = list(v) if isinstance(v, (list, tuple)) else []
            out[k] = v
    return out


def get_profile(user_id):
    """
    Load profile from S3 users/{username}.json. Returns profile dict (id, name, ...)
    or None if not found.
    """
    username = _username_for_user_id(user_id)
    if not username:
        return None
    data = get_user_data(username)
    if not data:
        return None
    raw = data.get("profile")
    if not raw:
        return None
    logger.info("Retrieved profile from S3 for user_id=%s username=%s", user_id, username)
    return _json_to_profile(raw, int(user_id))


def save_profile(profile_dict):
    """
    Save profile to S3 users/{username}.json. Preserves token/token_expires_at in the same file.
    Called whenever profile is saved (PATCH /api/profile/) or after contract create/update/delete
    (refresh_profile_from_contracts), so the JSON is constantly updated.
    """
    user_id = profile_dict.get("user_id")
    if user_id is None:
        return
    username = _username_for_user_id(user_id)
    if not username:
        logger.warning("Cannot save profile: no username for user_id=%s", user_id)
        return
    data = get_user_data(username) or {}
    # Preserve token so profile saves don't wipe Bearer auth
    profile_blob = _profile_to_json(profile_dict)
    data["profile"] = profile_blob
    save_user_data(username, data)
    logger.info("Profile saved to S3 for user_id=%s username=%s", user_id, username)


def get_or_create_profile(user_id):
    """
    Load profile from S3; if missing, create default and save, then return it.
    Returns profile dict.
    """
    try:
        logger.info("get_or_create_profile: loading from S3 (user_id=%s)", user_id)
        profile = get_profile(user_id)
        if profile is not None:
            return profile
        logger.info("Creating new profile in S3 for user_id=%s", user_id)
        default = _default_profile_dict(user_id)
        save_profile(default)
        return _json_to_profile(_profile_to_json(default), user_id)
    except Exception as e:
        logger.warning("get_or_create_profile failed for user_id=%s: %s", user_id, e)
        default = _default_profile_dict(user_id)
        return _json_to_profile(_profile_to_json(default), user_id)


def refresh_profile_from_contracts(user):
    """
    Recompute profile from user's contracts (stored in user JSON) and save to S3 users/{username}.json.
    Called after every contract create, update, and delete so the user JSON stays in sync.
    """
    from django.utils import timezone

    from .contract_storage import list_contracts_for_profile

    contract_list = list_contracts_for_profile(user.id)
    certs = set()
    clearances_set = set()
    naics = set()
    tags = set()
    cities = set()
    counties = set()
    capabilities_set = set()
    agencies = set()
    total_val = Decimal("0")
    for c in contract_list:
        rc = getattr(c, "required_certifications", None) or (
            c.get("required_certifications") if isinstance(c, dict) else []
        )
        rcl = getattr(c, "required_clearances", None) or (
            c.get("required_clearances") if isinstance(c, dict) else []
        )
        naics_list = getattr(c, "naics_codes", None) or (
            c.get("naics_codes") if isinstance(c, dict) else []
        )
        it = getattr(c, "industry_tags", None) or (
            c.get("industry_tags") if isinstance(c, dict) else []
        )
        jc = getattr(c, "jurisdiction_city", None) or (
            c.get("jurisdiction_city") if isinstance(c, dict) else None
        )
        jcy = getattr(c, "jurisdiction_county", None) or (
            c.get("jurisdiction_county") if isinstance(c, dict) else None
        )
        wl = getattr(c, "work_locations", None) or (
            c.get("work_locations") if isinstance(c, dict) else []
        )
        ia = getattr(c, "issuing_agency", None) or (
            c.get("issuing_agency") if isinstance(c, dict) else None
        )
        wd = getattr(c, "work_description", None) or (
            c.get("work_description") if isinstance(c, dict) else None
        )
        val = getattr(c, "contract_value_estimate", None) or (
            c.get("contract_value_estimate") if isinstance(c, dict) else None
        )
        certs.update(rc or [])
        clearances_set.update(rcl or [])
        naics.update(naics_list or [])
        tags.update(it or [])
        if jc:
            cities.add(jc)
        if jcy:
            counties.add(jcy)
        cities.update(wl or [])
        if ia:
            agencies.add(ia)
        if wd and str(wd).strip():
            capabilities_set.add(str(wd).strip())
        try:
            total_val += Decimal(str(val or "0").replace(",", "").replace("$", ""))
        except Exception:
            pass
    now = timezone.now().isoformat()
    profile_dict = get_profile(user.id) or _default_profile_dict(user.id)
    # Keep full contract list in uploaded_documents (source of truth in user JSON; no DynamoDB)
    uploaded_documents = []
    for c in contract_list:
        if isinstance(c, dict):
            uploaded_documents.append(c)
        else:
            cid = getattr(c, "id", None) or getattr(c, "contract_id", None)
            title = getattr(c, "title", None) or ""
            doc = getattr(c, "document", None) or ""
            created = getattr(c, "created_at", None) or ""
            uploaded_documents.append({"id": cid, "title": title, "document": doc, "created_at": created})
    profile_dict.update(
        {
            "user_id": user.id,
            "certifications": list(certs),
            "clearances": list(clearances_set),
            "naics_codes": list(naics),
            "industry_tags": list(tags),
            "work_cities": list(cities),
            "work_counties": list(counties),
            "capabilities": list(capabilities_set),
            "agency_experience": list(agencies),
            "contract_count": len(contract_list),
            "total_contract_value": str(total_val),
            "updated_at": now,
            "uploaded_documents": uploaded_documents,
        }
    )
    save_profile(profile_dict)
    return profile_dict
