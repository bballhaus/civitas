"""
Contract storage: S3 only. Files at uploads/{user_id}/{contract_id}/{filename};
contract list stored in user JSON (users/{username}.json) under profile.uploaded_documents.
No DynamoDB.
"""
import logging
import uuid
from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone

from .aws_client import get_boto3_kwargs
from .user_data_s3 import get_user_data, save_user_data

logger = logging.getLogger(__name__)


def _username_for_user_id(user_id):
    """Resolve Django user id to username."""
    try:
        return get_user_model().objects.get(pk=int(user_id)).username
    except Exception:
        return None


def _s3_key(user_id, contract_id, filename):
    """Store under uploads/{user_id}/{contract_id}/{filename}. Use .pdf if no extension."""
    base = (filename or "document").replace(" ", "_")
    if not base.lower().endswith(".pdf") and "." not in base:
        base = f"{base}.pdf"
    return f"uploads/{user_id}/{contract_id}/{base}"


def _contract_attrs():
    return [
        "title",
        "contractor_name",
        "document_s3_key",
        "document",
        "rfp_id",
        "issuing_agency",
        "jurisdiction_state",
        "jurisdiction_county",
        "jurisdiction_city",
        "required_certifications",
        "required_clearances",
        "onsite_required",
        "work_locations",
        "naics_codes",
        "industry_tags",
        "min_past_performance",
        "contract_value_estimate",
        "timeline_duration",
        "work_description",
        "award_date",
        "start_date",
        "end_date",
        "created_at",
        "updated_at",
    ]


def _get_document_url(s3_key):
    if not s3_key or not getattr(settings, "AWS_STORAGE_BUCKET_NAME", None):
        return None
    bucket = settings.AWS_STORAGE_BUCKET_NAME
    region = getattr(settings, "AWS_S3_REGION_NAME", "us-east-1")
    return f"https://{bucket}.s3.{region}.amazonaws.com/{s3_key}"


def _stored_to_contract(stored, user_id):
    """Stored dict from profile.uploaded_documents -> contract dict for API (with document URL)."""
    if not stored:
        return None
    cid = stored.get("id") or stored.get("contract_id") or ""
    doc_key = stored.get("document_s3_key")
    doc_url = stored.get("document") or _get_document_url(doc_key)
    return {
        "id": cid,
        "contract_id": cid,
        "user_id": user_id,
        "title": stored.get("title") or "",
        "contractor_name": stored.get("contractor_name") or "",
        "document": doc_url,
        "document_s3_key": doc_key,
        "rfp_id": stored.get("rfp_id") or "",
        "issuing_agency": stored.get("issuing_agency") or "",
        "jurisdiction_state": stored.get("jurisdiction_state") or "CA",
        "jurisdiction_county": stored.get("jurisdiction_county") or "",
        "jurisdiction_city": stored.get("jurisdiction_city") or "",
        "required_certifications": list(stored.get("required_certifications") or []),
        "required_clearances": list(stored.get("required_clearances") or []),
        "onsite_required": stored.get("onsite_required"),
        "work_locations": list(stored.get("work_locations") or []),
        "naics_codes": list(stored.get("naics_codes") or []),
        "industry_tags": list(stored.get("industry_tags") or []),
        "min_past_performance": stored.get("min_past_performance") or "",
        "contract_value_estimate": stored.get("contract_value_estimate") or "",
        "timeline_duration": stored.get("timeline_duration") or "",
        "work_description": stored.get("work_description") or "",
        "award_date": stored.get("award_date") or "",
        "start_date": stored.get("start_date") or "",
        "end_date": stored.get("end_date") or "",
        "created_at": stored.get("created_at") or "",
        "updated_at": stored.get("updated_at") or "",
    }


def _contract_to_stored(c, contract_id):
    """Contract dict -> stored dict for profile.uploaded_documents (JSON-serializable)."""
    return {
        "id": contract_id,
        "contract_id": contract_id,
        "title": c.get("title") or "",
        "contractor_name": c.get("contractor_name") or "",
        "document": c.get("document") or "",
        "document_s3_key": c.get("document_s3_key"),
        "rfp_id": c.get("rfp_id") or "",
        "issuing_agency": c.get("issuing_agency") or "",
        "jurisdiction_state": c.get("jurisdiction_state") or "CA",
        "jurisdiction_county": c.get("jurisdiction_county") or "",
        "jurisdiction_city": c.get("jurisdiction_city") or "",
        "required_certifications": list(c.get("required_certifications") or []),
        "required_clearances": list(c.get("required_clearances") or []),
        "onsite_required": c.get("onsite_required"),
        "work_locations": list(c.get("work_locations") or []),
        "naics_codes": list(c.get("naics_codes") or []),
        "industry_tags": list(c.get("industry_tags") or []),
        "min_past_performance": c.get("min_past_performance") or "",
        "contract_value_estimate": c.get("contract_value_estimate") or "",
        "timeline_duration": c.get("timeline_duration") or "",
        "work_description": c.get("work_description") or "",
        "award_date": c.get("award_date") or "",
        "start_date": c.get("start_date") or "",
        "end_date": c.get("end_date") or "",
        "created_at": c.get("created_at") or "",
        "updated_at": c.get("updated_at") or "",
    }


def _get_contracts_list(user_id):
    """Read contract list from user JSON profile.uploaded_documents. Returns (profile_dict, docs_list)."""
    username = _username_for_user_id(user_id)
    if not username:
        return {}, []
    data = get_user_data(username)
    if not data:
        return {}, []
    profile = data.get("profile") or {}
    docs = profile.get("uploaded_documents") or []
    # Filter out documents whose S3 key belongs to a different user (cross-user contamination guard)
    user_prefix = f"uploads/{user_id}/"
    clean_docs = []
    for d in docs:
        s3_key = d.get("document_s3_key") if isinstance(d, dict) else None
        if s3_key and not s3_key.startswith(user_prefix):
            logger.warning("Filtering out document with foreign S3 key %s from user_id=%s", s3_key, user_id)
            continue
        clean_docs.append(d)
    if len(clean_docs) < len(docs):
        # Persist the cleanup so contaminated entries are removed permanently
        profile["uploaded_documents"] = clean_docs
        data["profile"] = profile
        save_user_data(username, data)
        logger.info("Cleaned %d foreign documents from user_id=%s", len(docs) - len(clean_docs), user_id)
    return profile, clean_docs


def _save_contracts_list(user_id, contracts_list):
    """Write contract list to user JSON profile.uploaded_documents. Preserves rest of profile."""
    username = _username_for_user_id(user_id)
    if not username:
        logger.warning("Cannot save contracts: no username for user_id=%s", user_id)
        return False
    data = get_user_data(username) or {}
    profile = data.get("profile") or {}
    profile["uploaded_documents"] = contracts_list
    data["profile"] = profile
    save_user_data(username, data)
    return True


def _upload_to_s3(file, s3_key, content_type=None):
    """Upload file to S3. No-op on failure or if bucket not configured."""
    if not file or not getattr(settings, "AWS_STORAGE_BUCKET_NAME", None):
        return False
    try:
        import boto3

        bucket = settings.AWS_STORAGE_BUCKET_NAME
        client = boto3.client("s3", **get_boto3_kwargs())
        extra = {}
        if content_type:
            extra["ContentType"] = content_type
        client.upload_fileobj(file, bucket, s3_key, ExtraArgs=extra if extra else None)
        return True
    except Exception as e:
        logger.warning("S3 upload failed for key=%s: %s", s3_key, e)
        return False


def _delete_from_s3(s3_key):
    if not s3_key or not getattr(settings, "AWS_STORAGE_BUCKET_NAME", None):
        return
    try:
        import boto3

        client = boto3.client("s3", **get_boto3_kwargs())
        client.delete_object(Bucket=settings.AWS_STORAGE_BUCKET_NAME, Key=s3_key)
    except Exception as e:
        logger.warning("S3 delete failed for key=%s: %s", s3_key, e)


def list_contracts(user_id):
    """List all contracts for user from profile.uploaded_documents in S3 user JSON."""
    _, docs = _get_contracts_list(user_id)
    uid = int(user_id)
    out = [_stored_to_contract(d, uid) for d in docs if isinstance(d, dict)]
    out.sort(key=lambda x: (x.get("updated_at") or ""), reverse=True)
    return out


def get_contract(user_id, contract_id):
    """Get one contract by user_id and contract_id from user JSON."""
    _, docs = _get_contracts_list(user_id)
    if not docs:
        return None
    uid = int(user_id)
    for d in docs:
        if not isinstance(d, dict):
            continue
        cid = d.get("id") or d.get("contract_id")
        if cid == str(contract_id):
            return _stored_to_contract(d, uid)
    return None


def create_contract(user_id, metadata, file=None):
    """
    Upload file to S3 at uploads/{user_id}/{contract_id}/{filename}, append contract to
    profile.uploaded_documents in user JSON. Returns contract dict or None if S3/user JSON unavailable.
    """
    bucket = getattr(settings, "AWS_STORAGE_BUCKET_NAME", None)
    if not bucket:
        logger.warning(
            "Contract storage unavailable: AWS_STORAGE_BUCKET_NAME not set. "
            "Add it to back_end/.env (e.g. civitas-uploads)."
        )
        return None
    username = _username_for_user_id(user_id)
    if not username:
        logger.warning("Contract storage: no user for user_id=%s", user_id)
        return None
    try:
        contract_id = uuid.uuid4().hex
        now = timezone.now().isoformat()
        meta = dict(metadata)
        meta.setdefault("created_at", now)
        meta.setdefault("updated_at", now)
        meta.setdefault("issuing_agency", "Unknown")
        s3_key = None
        if file and bucket:
            name = getattr(file, "name", None) or "document"
            key = _s3_key(user_id, contract_id, name)
            file.seek(0)
            content_type = getattr(file, "content_type", None) or "application/pdf"
            if _upload_to_s3(file, key, content_type=content_type):
                s3_key = key
            else:
                logger.warning("create_contract: S3 upload failed for user_id=%s; aborting contract creation", user_id)
                return None
        doc_url = _get_document_url(s3_key) if s3_key else ""
        meta["document_s3_key"] = s3_key
        meta["document"] = doc_url
        meta["created_at"] = now
        meta["updated_at"] = now
        stored = _contract_to_stored(meta, contract_id)
        stored["id"] = contract_id
        stored["contract_id"] = contract_id
        _, docs = _get_contracts_list(user_id)
        if docs is None:
            docs = []
        docs = list(docs)
        docs.append(stored)
        if not _save_contracts_list(user_id, docs):
            return None
        return _stored_to_contract(stored, int(user_id))
    except Exception as e:
        logger.exception("create_contract failed for user_id=%s: %s", user_id, e)
        return None


def update_contract(user_id, contract_id, metadata, file=None):
    """Update contract in user JSON; optionally replace document in S3. Returns updated contract dict or None."""
    _, docs = _get_contracts_list(user_id)
    if not docs:
        return None
    idx = None
    for i, d in enumerate(docs):
        if not isinstance(d, dict):
            continue
        cid = d.get("id") or d.get("contract_id")
        if cid == str(contract_id):
            idx = i
            break
    if idx is None:
        return None
    existing = _stored_to_contract(docs[idx], int(user_id))
    now = timezone.now().isoformat()
    merged = {**existing, **metadata, "updated_at": now}
    if file and getattr(settings, "AWS_STORAGE_BUCKET_NAME", None):
        s3_key = _s3_key(user_id, contract_id, getattr(file, "name", None) or "document")
        file.seek(0)
        content_type = getattr(file, "content_type", None) or "application/pdf"
        if _upload_to_s3(file, s3_key, content_type=content_type):
            merged["document_s3_key"] = s3_key
            merged["document"] = _get_document_url(s3_key)
    stored = _contract_to_stored(merged, str(contract_id))
    stored["id"] = str(contract_id)
    stored["contract_id"] = str(contract_id)
    docs = list(docs)
    docs[idx] = stored
    if not _save_contracts_list(user_id, docs):
        return None
    return _stored_to_contract(stored, int(user_id))


def delete_contract(user_id, contract_id):
    """Remove contract from user JSON and delete its file from S3."""
    _, docs = _get_contracts_list(user_id)
    if not docs:
        return False
    idx = None
    s3_key = None
    for i, d in enumerate(docs):
        if not isinstance(d, dict):
            continue
        cid = d.get("id") or d.get("contract_id")
        if cid == str(contract_id):
            idx = i
            s3_key = d.get("document_s3_key")
            break
    if idx is None:
        return False
    if s3_key:
        _delete_from_s3(s3_key)
    docs = list(docs)
    docs.pop(idx)
    return _save_contracts_list(user_id, docs)


def contract_dict_to_object(c):
    """Build an object with .id, .title, .document, .jurisdiction_*, etc. for ContractSerializer."""
    if not c:
        return None

    class ContractObj:
        pass

    o = ContractObj()
    o.id = c.get("id") or c.get("contract_id")
    o.title = c.get("title") or ""
    o.contractor_name = c.get("contractor_name") or ""
    o.document = c.get("document") or ""
    o.rfp_id = c.get("rfp_id") or ""
    o.issuing_agency = c.get("issuing_agency") or ""
    o.jurisdiction_state = c.get("jurisdiction_state") or "CA"
    o.jurisdiction_county = c.get("jurisdiction_county") or ""
    o.jurisdiction_city = c.get("jurisdiction_city") or ""
    o.required_certifications = c.get("required_certifications") or []
    o.required_clearances = c.get("required_clearances") or []
    o.onsite_required = c.get("onsite_required")
    o.work_locations = c.get("work_locations") or []
    o.naics_codes = c.get("naics_codes") or []
    o.industry_tags = c.get("industry_tags") or []
    o.min_past_performance = c.get("min_past_performance") or ""
    o.contract_value_estimate = c.get("contract_value_estimate") or ""
    o.timeline_duration = c.get("timeline_duration") or ""
    o.work_description = c.get("work_description") or ""
    o.award_date = c.get("award_date") or ""
    o.start_date = c.get("start_date") or ""
    o.end_date = c.get("end_date") or ""
    o.created_at = c.get("created_at") or ""
    o.updated_at = c.get("updated_at") or ""
    return o


def list_contracts_for_profile(user_id):
    """
    Return list of contract-like dicts for profile aggregation (required_certifications, etc.).
    Used by refresh_profile_from_contracts. Same as list_contracts.
    """
    return list_contracts(user_id)
