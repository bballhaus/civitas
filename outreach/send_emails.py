"""
Cold email sender for Civitas user discovery outreach.

Reads contacts from a CSV and sends personalized emails using an SMTP server
(Gmail, Outlook, etc.). Supports dry-run mode to preview emails before sending.

Usage:
    # Preview first 5 emails (no sending)
    python outreach/send_emails.py --dry-run --limit 5

    # Send to all contacts
    python outreach/send_emails.py

    # Send with a delay between emails (recommended)
    python outreach/send_emails.py --delay 10

    # Resume from a specific row (if you stopped midway)
    python outreach/send_emails.py --start 50

Environment variables (or .env file in outreach/):
    SMTP_EMAIL=your.email@gmail.com
    SMTP_PASSWORD=your-app-password
    SMTP_HOST=smtp.gmail.com      (optional, defaults to Gmail)
    SMTP_PORT=587                  (optional, defaults to 587)
"""

from __future__ import annotations

import argparse
import csv
import logging
import os
import smtplib
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from pathlib import Path

logger = logging.getLogger(__name__)

OUTREACH_DIR = Path(__file__).resolve().parent

# ──────────────────────────────────────────────────────────────────────────────
# Template
# ──────────────────────────────────────────────────────────────────────────────

SUBJECT_TEMPLATE = "Quick Question About Your Bidding Process, {contact_name}"

BODY_TEMPLATE = """\
Hi {contact_name},

I came across {company} while researching government contractors in California, and your work really caught my eye.

I'm Brooke, a computer science master's student at Stanford, and I'm building Civitas -- a tool designed to help contractors like you spend less time hunting for the right RFPs and more time actually winning them. We're focused on making it dramatically easier for small and mid-sized firms to discover compatible bid opportunities across the dozens of procurement sites out there.

I'd love to hear about your experience with the bidding process -- what's working, what's frustrating, and what would make your life easier. Your perspective would be incredibly valuable in shaping what we build.

Would you be open to a quick 15-minute call sometime in the next couple of weeks? Happy to work around your schedule.

Thanks so much for considering it -- I really appreciate your time.

Best,
Brooke Ballhaus
Stanford University | Class of 2026
B.S. Candidate | Computer Science
M.S. Candidate | Computer Science
"""


# ──────────────────────────────────────────────────────────────────────────────
# Email sending
# ──────────────────────────────────────────────────────────────────────────────

def load_env():
    """Load environment variables from outreach/.env if it exists."""
    env_path = OUTREACH_DIR / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                key, val = line.split("=", 1)
                os.environ.setdefault(key.strip(), val.strip())


def get_smtp_config() -> dict:
    load_env()
    email = os.environ.get("SMTP_EMAIL")
    password = os.environ.get("SMTP_PASSWORD")
    if not email or not password:
        raise ValueError(
            "Set SMTP_EMAIL and SMTP_PASSWORD in environment or outreach/.env\n"
            "For Gmail, use an App Password: https://myaccount.google.com/apppasswords"
        )
    return {
        "email": email,
        "password": password,
        "host": os.environ.get("SMTP_HOST", "smtp.gmail.com"),
        "port": int(os.environ.get("SMTP_PORT", "587")),
    }


def build_email(
    sender: str,
    recipient_email: str,
    contact_name: str,
    company: str,
) -> MIMEMultipart:
    """Build a personalized email message."""
    # Use first name only for a warmer tone
    first_name = contact_name.split()[0] if contact_name else "there"

    subject = SUBJECT_TEMPLATE.format(contact_name=first_name)
    body = BODY_TEMPLATE.format(contact_name=first_name, company=company)

    msg = MIMEMultipart("alternative")
    msg["From"] = sender
    msg["To"] = recipient_email
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain"))

    return msg


def send_emails(
    contacts_csv: str = "outreach/contacts.csv",
    dry_run: bool = False,
    limit: int | None = None,
    start: int = 0,
    delay: float = 5.0,
):
    """Send personalized emails to all contacts in the CSV."""
    csv_path = Path(contacts_csv)
    if not csv_path.exists():
        print(f"Contacts CSV not found: {csv_path}")
        print("Run scrape_contacts.py first, or create the CSV manually.")
        return

    with open(csv_path) as f:
        reader = csv.DictReader(f)
        contacts = list(reader)

    if start:
        contacts = contacts[start:]
    if limit:
        contacts = contacts[:limit]

    print(f"{'[DRY RUN] ' if dry_run else ''}Processing {len(contacts)} contacts...")

    if not dry_run:
        config = get_smtp_config()
        server = smtplib.SMTP(config["host"], config["port"])
        server.starttls()
        server.login(config["email"], config["password"])
        sender = config["email"]
    else:
        sender = "your.email@example.com"
        server = None

    sent = 0
    skipped = 0
    log_path = OUTREACH_DIR / "send_log.csv"
    log_exists = log_path.exists()

    # Track already-sent emails to avoid duplicates
    already_sent = set()
    if log_exists:
        with open(log_path) as f:
            for row in csv.DictReader(f):
                already_sent.add(row.get("email", ""))

    log_file = open(log_path, "a", newline="")
    log_writer = csv.writer(log_file)
    if not log_exists:
        log_writer.writerow(["email", "contact_name", "company", "status", "timestamp"])

    try:
        for i, contact in enumerate(contacts):
            email = contact.get("email", "").strip()
            name = contact.get("contact_name", "").strip()
            company = contact.get("company", "").strip()

            if not email:
                skipped += 1
                continue

            if email in already_sent:
                logger.info(f"Skipping {email} (already sent)")
                skipped += 1
                continue

            msg = build_email(sender, email, name, company)

            if dry_run:
                print(f"\n{'='*60}")
                print(f"To: {email}")
                print(f"Subject: {msg['Subject']}")
                print(f"{'='*60}")
                print(msg.get_payload()[0].get_payload())
                sent += 1
            else:
                try:
                    server.sendmail(sender, email, msg.as_string())
                    log_writer.writerow([
                        email, name, company, "sent",
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ])
                    sent += 1
                    print(f"[{sent}] Sent to {name} <{email}> @ {company}")

                    if delay and i < len(contacts) - 1:
                        time.sleep(delay)

                except Exception as e:
                    log_writer.writerow([
                        email, name, company, f"failed: {e}",
                        time.strftime("%Y-%m-%d %H:%M:%S"),
                    ])
                    logger.error(f"Failed to send to {email}: {e}")

    finally:
        log_file.close()
        if server:
            server.quit()

    print(f"\nDone! Sent: {sent}, Skipped: {skipped}")
    if not dry_run:
        print(f"Log saved to: {log_path}")


# ──────────────────────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Send Civitas outreach emails")
    parser.add_argument("--csv", default="outreach/contacts.csv", help="Path to contacts CSV")
    parser.add_argument("--dry-run", action="store_true", help="Preview emails without sending")
    parser.add_argument("--limit", type=int, default=None, help="Max emails to send")
    parser.add_argument("--start", type=int, default=0, help="Start from this row number")
    parser.add_argument("--delay", type=float, default=5.0, help="Seconds between emails")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    send_emails(
        contacts_csv=args.csv,
        dry_run=args.dry_run,
        limit=args.limit,
        start=args.start,
        delay=args.delay,
    )
