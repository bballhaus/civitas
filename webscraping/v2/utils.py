"""Shared utility functions that don't require heavy dependencies."""

import hashlib


def event_hash(source_id: str, source_event_id: str) -> str:
    """Deterministic hash for deduplication: first 12 chars of SHA-256."""
    key = f"{source_id}:{source_event_id}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def make_event_id(source_id: str, source_event_id: str) -> str:
    """Create a deterministic, URL-safe event ID."""
    return f"{source_id}-{event_hash(source_id, source_event_id)}"
