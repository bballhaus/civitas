"""Parsers for PlanetBids market-intel table rows.

The Prospective Bidders, Bid Results, and Awards tabs all render as HTML
tables. The first cell of each row holds vendor identity as a multi-line
block (name / street / city,state zip / contact / phone / email / certs);
other cells hold structured data (bid amount, responsive Y/N, etc.).

We extract per-cell innerText (which preserves newlines) and parse the
vendor block by landmark words ("Contact:", "Phone:") rather than line
position, since the line count varies (no street, fax line present, etc.).
"""

from __future__ import annotations

import re
from typing import Optional

from webscraping.v2.models import Vendor

_CURRENCY_RE = re.compile(r"\$\s?([\d,]+(?:\.\d+)?)")
_PHONE_RE = re.compile(r"\b(\d{3}[-.\s)]\s?\d{3}[-.\s]\d{4})\b")
_EMAIL_RE = re.compile(r"\b([\w*+.-]+@[\w.-]+\.[A-Za-z]{2,})\b")
# "Buford, Georgia 30515"  /  "San Diego, California 92107"  /  "El Cajon, CA 92021-1234"
_CITY_STATE_ZIP_RE = re.compile(
    r"^(?P<city>[A-Za-z .'\-]+?),?\s+(?P<state>[A-Za-z]{2,}(?:\s[A-Za-z]+)?)\s+(?P<zip>\d{5}(?:-\d{4})?)\s*$"
)


def parse_currency(text: Optional[str]) -> Optional[int]:
    """Currency text -> cents int. '$1,190,650.00' -> 119065000."""
    if not text:
        return None
    m = _CURRENCY_RE.search(text)
    if not m:
        return None
    try:
        return round(float(m.group(1).replace(",", "")) * 100)
    except ValueError:
        return None


def parse_responsive(text: Optional[str]) -> Optional[bool]:
    """'Yes'/'No' -> True/False; anything else -> None."""
    if not text:
        return None
    t = text.strip().lower()
    if t in ("yes", "y", "responsive"):
        return True
    if t in ("no", "n", "non-responsive", "nonresponsive"):
        return False
    return None


def parse_pre_bid_attendee(text: Optional[str]) -> Optional[bool]:
    """Same shape as responsive; separate name keeps callsites readable."""
    return parse_responsive(text)


def parse_certifications(text: Optional[str]) -> list[str]:
    """Comma-separated cert tokens. Drops obvious non-cert tokens."""
    if not text:
        return []
    out: list[str] = []
    for tok in text.split(","):
        t = tok.strip()
        if not t or len(t) > 16:
            continue
        # Cert tokens are short alphabetic words, optionally with digits.
        if re.match(r"^[A-Za-z][A-Za-z0-9 \-]*$", t):
            out.append(t)
    return out


def parse_vendor_block(cell_text: Optional[str]) -> Optional[Vendor]:
    """Parse the multi-line vendor cell into a Vendor object.

    The vendor cell holds identity only: name, address, contact, phone, email.
    Certifications are in a separate cell on PlanetBids tables — caller is
    responsible for setting `vendor.certifications` from that cell.
    """
    if not cell_text or not cell_text.strip():
        return None

    lines = [l.strip() for l in cell_text.splitlines() if l.strip()]
    if not lines:
        return None

    name = lines[0]
    address_parts: list[str] = []
    city = state = zip_code = None
    contact_name = phone = email_redacted = None

    for line in lines[1:]:
        m = re.match(r"^Contact:\s*(.+)$", line, re.IGNORECASE)
        if m:
            contact_name = m.group(1).strip()
            continue
        m = re.match(r"^Phone:\s*(.+)$", line, re.IGNORECASE)
        if m:
            ph = _PHONE_RE.search(m.group(1))
            if ph:
                phone = ph.group(1)
            continue
        if re.match(r"^Fax:", line, re.IGNORECASE):
            continue
        em = _EMAIL_RE.search(line)
        if em:
            email_redacted = em.group(1)
            continue
        cs = _CITY_STATE_ZIP_RE.match(line)
        if cs:
            city = cs.group("city").strip()
            state = cs.group("state").strip()
            zip_code = cs.group("zip").strip()
            continue
        address_parts.append(line)

    return Vendor(
        name=name,
        address=" ".join(address_parts) if address_parts else None,
        city=city,
        state=state,
        zip_code=zip_code,
        contact_name=contact_name,
        phone=phone,
        email_redacted=email_redacted,
        certifications=[],
    )
