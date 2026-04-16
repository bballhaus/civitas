# Civitas User Discovery Outreach

Tools for compiling government contractor contacts from PlanetBids and sending cold outreach emails for user discovery interviews.

## Overview

PlanetBids portals publish a **Prospective Bidders** list for each open bid, showing companies that downloaded bid documents. This includes company name, contact name, email, phone, and address — ideal for reaching contractors actively engaged in government procurement.

## Files

| File | Description |
|------|-------------|
| `scrape_contacts.py` | Scrapes prospective bidder contacts from all 44 SoCal PlanetBids portals |
| `scrape_bay_area.py` | Scrapes contacts from 5 Bay Area PlanetBids portals (Mountain View, Sunnyvale, Menlo Park, Richmond, Walnut Creek) |
| `send_emails.py` | Sends personalized cold emails via SMTP with dry-run, batching, and logging |
| `email_template.html` | Email template with `{{contact_name}}` and `{{company}}` placeholders |
| `.env.example` | SMTP credential template — copy to `.env` and fill in |
| `contacts_bay_area.csv` | 170 Bay Area contractor contacts |
| `contacts.csv` | 230 SoCal contractor contacts |
| `contacts_all.csv` | 388 merged contacts (Bay Area first, then SoCal, deduplicated) |

## Usage

### Scraping contacts

```bash
# Scrape SoCal portals (44 agencies)
python outreach/scrape_contacts.py --target 200

# Scrape Bay Area portals (5 agencies)
python outreach/scrape_bay_area.py --target 200

# Limit to first N portals (useful for testing)
python outreach/scrape_contacts.py --portals 3 --target 50
```

### Sending emails

```bash
# 1. Set up credentials
cp outreach/.env.example outreach/.env
# Edit .env with your Gmail address and App Password
# (https://myaccount.google.com/apppasswords)

# 2. Preview emails without sending
python outreach/send_emails.py --csv outreach/contacts_all.csv --dry-run --limit 5

# 3. Send a small batch first
python outreach/send_emails.py --csv outreach/contacts_all.csv --limit 20 --delay 10

# 4. Send all (with 5s delay between emails)
python outreach/send_emails.py --csv outreach/contacts_all.csv --delay 5
```

### CSV format

The contact CSVs have the following columns:

| Column | Description |
|--------|-------------|
| `company` | Company name |
| `contact_name` | Contact person's name |
| `email` | Email address |
| `phone` | Phone number |
| `address` | Street address |
| `city` | City |
| `state` | State |
| `agency` | Issuing agency (e.g. "City of San Diego") |
| `bid_title` | The RFP/bid they were listed on |
| `bid_number` | Bid/invitation number |

## Dependencies

- `playwright` (already installed for the webscraping module)
- Python standard library (`smtplib`, `csv`, `email`)

## Notes

- The sender tracks sent emails in `send_log.csv` to avoid duplicate sends on re-runs
- Bay Area PlanetBids coverage is limited — most Bay Area cities use BidNet, OpenGov, or Biddingo instead
- Contacts are deduplicated by email address across all portals
