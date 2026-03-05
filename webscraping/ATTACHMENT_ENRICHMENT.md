## Attachment enrichment for RFP matching

This document explains how to enrich existing scraped events with attachment-based summaries and constraints, without re-running the webscraper.

The goal is to populate the `attachmentRollup` field for each event in `all_events_detailed.json`. The frontend and APIs are already wired to use this field to:

- Improve match scores using attachment-derived requirements (certifications, clearances, set-asides, geography, etc.).
- Improve explainability in:
  - "Why this is a good match"
  - "About this RFP"

---

## One-time (or occasional) enrichment run

### Prerequisites

- You have already run the webscraper and have:
  - `webscraping/all_events_detailed.json`
  - Attachments downloaded under `webscraping/downloads/` (one subfolder per event, based on a cleaned `event_id`).
- You have a Groq API key available as `GROQ_API_KEY`.

### Steps

From the repo root:

```bash
cd win26-Team9/win26-Team9/front_end

# Run the enrichment script
GROQ_API_KEY=your_key_here node scripts/enrich-events-with-attachments.cjs
```

What this does:

- Reads `../webscraping/all_events_detailed.json`.
- For each event:
  - Looks for attachments under `../webscraping/downloads/<safeEventId>/`.
  - Reads any `.txt` / `.md` files as text (you can extend this to PDFs/DOCX inside the script).
  - Calls Groq once per event to produce an `attachmentRollup` JSON object with:
    - `aboutRfpSummary`
    - `keyRequirementsBullets`
    - `combinedConstraints` (required certifications, clearances, NAICS, small-business / set-aside, geography, etc.)
    - `keywordHints`
  - Writes that rollup back on the event as `attachmentRollup`.
- Writes the result to:
  - `../webscraping/all_events_detailed_enriched.json`

### Making the app use the enriched data

Once you're satisfied with the enriched output:

```bash
cd win26-Team9/win26-Team9/webscraping
mv all_events_detailed.json all_events_detailed.original.json
mv all_events_detailed_enriched.json all_events_detailed.json
```

The `GET /api/events` route already reads `all_events_detailed.json` and passes through `attachmentRollup`, so no further code changes are required.

---

## Optional: better attachment text extraction

The enrichment script currently reads `.txt` / `.md` attachments as-is. To get better summaries from PDFs or DOCX files:

1. Open `front_end/scripts/enrich-events-with-attachments.cjs`.
2. Update the `extractTextFromFile(filePath)` function to:
   - Detect extensions like `.pdf`, `.docx`, etc.
   - Use your preferred extraction tool or library to return plain text.
3. Re-run the enrichment script to regenerate `all_events_detailed_enriched.json`.

---

## Automating after each webscrape (optional)

You do **not** need to modify the webscraping code itself to automate this. Instead, you can:

- Add a small wrapper script or CI step that runs **after** the scraper finishes:

```bash
# Example wrapper (pseudo-code)
python webscraping/cal_eprocure.py             # existing scraper
cd win26-Team9/win26-Team9/front_end
GROQ_API_KEY=your_key_here node scripts/enrich-events-with-attachments.cjs
cd ../webscraping
mv all_events_detailed_enriched.json all_events_detailed.json
```

- Or in a GitHub Action / CI pipeline, have one job step that runs the scraper and a following step that runs the enrichment script and swaps the JSON.

This keeps the enrichment logic decoupled from the scraper while ensuring that every fresh scrape is immediately augmented with attachment-based summaries.

