## Attachment Enrichment for RFP Matching

This document explains how to enrich scraped RFP events with structured metadata extracted from PDF attachments stored in S3.

The extraction script reads PDFs from S3, extracts text with pdfplumber, sends it to Groq LLM for structured extraction, and uploads results back to S3. The frontend `/api/events` route automatically merges extraction data with base events.

### What gets extracted

For each event's PDF attachments, the script produces:
- NAICS codes
- Certifications required (e.g., contractor licenses, DIR registration)
- Clearances required (e.g., Live Scan, background check)
- Set-aside types (e.g., Small Business, DVBE)
- Capabilities required
- Contract value estimate and duration
- Location details
- Deliverables and evaluation criteria
- Key requirements summary
- Raw text rollup (for downstream LLM features like Capabilities Analysis)

---

## Running the extraction

### Prerequisites

- AWS credentials with access to the `civitas-uploads` S3 bucket
- A Groq API key (paid tier recommended to avoid rate limits)
- Python 3.10+ with dependencies: `boto3`, `pdfplumber`, `groq`, `python-dotenv`, `tqdm`

These should be set in `back_end/.env`:
```
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
AWS_STORAGE_BUCKET_NAME=civitas-uploads
GROQ_API_KEY=...
```

### Commands

```bash
# Process all events (skips already-extracted ones)
python webscraping/extract_attachments.py

# Process a single event
python webscraping/extract_attachments.py --event 3600/0000037663

# Dry run — list events and their PDFs without processing
python webscraping/extract_attachments.py --dry-run

# Force re-process everything (ignores existing extractions)
python webscraping/extract_attachments.py --force
```

### How it works

1. **Resume support**: Downloads existing extractions from S3 first (authoritative source), merges with any local file, and skips already-processed events
2. **PDF priority filtering**: Classifies attachments by filename into high priority (Specification, Bid, SOW, RFP), medium (Addendum, Agreement, Attachment), and skip (Drawing, Job Walk, Photo). High-priority PDFs are processed first.
3. **Text extraction**: Uses pdfplumber to extract text from each qualifying PDF (truncated to 15,000 chars)
4. **LLM extraction**: Sends text to Groq (llama-3.1-8b-instant) with a structured prompt requesting JSON output
5. **Multi-PDF merge**: If an event has multiple qualifying PDFs, extractions are merged (lists are unioned, scalars take first non-null value)
6. **Rate limit handling**: Automatically retries on 429 errors with exponential backoff, parsing wait times from Groq error messages
7. **Incremental save**: Saves to local file after each event and uploads final results to S3

### S3 data layout

```
civitas-uploads/
├── scrapes/caleprocure/
│   ├── all_events.json                  # Base event metadata (509 events)
│   ├── attachment_extractions.json      # Structured extractions (415 events)
│   └── attachments/
│       ├── 0890_0000038160/             # PDFs organized by event ID
│       │   ├── Bid_Specification.pdf
│       │   └── Addendum_1.pdf
│       └── 3790_0000037817/
│           └── SOW_Document.pdf
```

---

## Frontend integration

The frontend `/api/events` route (`front_end/src/app/api/events/route.ts`) automatically merges extraction data with base events:

- **NAICS codes**: Directly from `extraction.naics_codes`
- **Certifications**: From `extraction.certifications_required`, with a text-based regex fallback that detects contractor licenses (Class A/B/C/C-XX), DIR registration, and PE licenses from description and attachment text when the structured extraction missed them
- **Capabilities**: Inferred via regex from title/description (LLM-extracted capabilities are not used as primary source due to quality issues)
- **Other fields**: Clearances, set-asides, deliverables, evaluation criteria, contract duration, and location details are passed through directly

No frontend code changes are needed when new extractions are uploaded to S3.

---

## After a new scrape

After running the webscraper (`cal_eprocure_store.py`), run the extraction to process any new events:

```bash
python webscraping/extract_attachments.py
```

The script will automatically detect which events already have extractions and only process new ones. Results are uploaded to S3 and picked up by the frontend's cached S3 reads (5-minute TTL).
