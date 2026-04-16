# PDF Parsing Benchmark Report — Civitas

**Date**: 2026-04-16 02:31
**PDFs tested**: 24
**Libraries**: pdfplumber 0.11.9, PyMuPDF 1.27.2.2, pdf-parse (Node.js)

## Summary

| Metric | pdfplumber | PyMuPDF | pdf-parse |
|--------|-----------|---------|-----------|
| Files parsed | 24 | 24 | 24 |
| Failures | 0 | 0 | 0 |
| Total chars extracted | 18,147 | 18,444 | 18,545 |
| Total words extracted | 2,176 | 2,176 | 2,301 |
| Total time (s) | 0.51 | 0.19 | 5.33 |
| Avg time/file (s) | 0.021 | 0.008 | 0.222 |
| Tables found | 0 | 0 | 0 |
| Emails found | 0 | 0 | 0 |
| Phone numbers found | 0 | 0 | 0 |
| Dollar amounts found | 19 | 19 | 19 |
| Dates found | 0 | 0 | 0 |
| 6-digit codes (NAICS) | 17 | 17 | 17 |

## Per-File Comparison

| File | pdfplumber (chars) | PyMuPDF (chars) | pdf-parse (chars) | Winner |
|------|-------------------|-----------------|-------------------|--------|
| Golden Valley Infrastructure Group – Company Profi | 1,058 | 1,084 | 1,074 | pymupdf |
| Pacific Habitat Restoration & Environmental Servic | 1,532 | 1,565 | 1,562 | pymupdf |
| Peninsula Civil Constructors – Company Profile.pdf | 962 | 987 | 978 | pymupdf |
| Proposal – California State Office Complex Site Im | 378 | 387 | 394 | pdf-parse |
| Proposal – Central Valley Highway Shoulder Rehabil | 1,139 | 1,161 | 1,155 | pymupdf |
| Proposal – Central Valley Roadway Reconstruction P | 424 | 434 | 440 | pdf-parse |
| Proposal – Chico Roadway Resurfacing Program.pdf | 425 | 434 | 441 | pdf-parse |
| Proposal – Fresno County Utility Corridor Reconstr | 370 | 378 | 386 | pdf-parse |
| Proposal – Humboldt Coastal Wetland Rehabilitation | 748 | 763 | 764 | pdf-parse |
| Proposal – Modesto Public Works Facility Renovatio | 360 | 368 | 376 | pdf-parse |
| Proposal – Mountain View Civic Center Pavement Reh | 378 | 387 | 394 | pdf-parse |
| Proposal – Northern California Wildfire Rehabilita | 627 | 640 | 643 | pdf-parse |
| Proposal – Sacramento County Bridge Approach Impro | 475 | 485 | 491 | pdf-parse |
| Proposal – San Jose Neighborhood Sidewalk Accessib | 483 | 493 | 499 | pdf-parse |
| Proposal – Santa Clara Municipal Facility Site Imp | 380 | 389 | 396 | pdf-parse |
| Proposal – Sierra Nevada Meadow Restoration Initia | 604 | 616 | 620 | pdf-parse |
| Proposal – Stockton Stormwater Pump Station Upgrad | 751 | 767 | 767 | pymupdf |
| Proposal – Sunnyvale Storm Drain Replacement.pdf | 370 | 378 | 386 | pdf-parse |
| Proposal – Trinity River Habitat Restoration Proje | 1,064 | 1,084 | 1,080 | pymupdf |
| Redwood Public Works Builders – Company Profile.pd | 844 | 869 | 860 | pymupdf |
| proposal_caltrans_drainage_upgrade.pdf | 1,159 | 1,159 | 1,175 | pdf-parse |
| proposal_sacramento_sidewalk_project.pdf | 1,174 | 1,174 | 1,190 | pdf-parse |
| proposal_santa_clara_facility_renovation.pdf | 1,165 | 1,165 | 1,181 | pdf-parse |
| sierra_west_company_profile.pdf | 1,277 | 1,277 | 1,293 | pdf-parse |

## Speed Comparison

| File | pdfplumber (s) | PyMuPDF (s) | pdf-parse (s) |
|------|---------------|-------------|---------------|
| Golden Valley Infrastructure Group – Company Profi | 0.049 | 0.022 | 0.454 |
| Pacific Habitat Restoration & Environmental Servic | 0.047 | 0.015 | 0.201 |
| Peninsula Civil Constructors – Company Profile.pdf | 0.033 | 0.009 | 0.189 |
| Proposal – California State Office Complex Site Im | 0.014 | 0.004 | 0.204 |
| Proposal – Central Valley Highway Shoulder Rehabil | 0.037 | 0.011 | 0.180 |
| Proposal – Central Valley Roadway Reconstruction P | 0.015 | 0.005 | 0.256 |
| Proposal – Chico Roadway Resurfacing Program.pdf | 0.015 | 0.005 | 0.182 |
| Proposal – Fresno County Utility Corridor Reconstr | 0.014 | 0.004 | 0.213 |
| Proposal – Humboldt Coastal Wetland Rehabilitation | 0.024 | 0.008 | 0.190 |
| Proposal – Modesto Public Works Facility Renovatio | 0.017 | 0.004 | 0.200 |
| Proposal – Mountain View Civic Center Pavement Reh | 0.014 | 0.004 | 0.233 |
| Proposal – Northern California Wildfire Rehabilita | 0.021 | 0.007 | 0.186 |
| Proposal – Sacramento County Bridge Approach Impro | 0.016 | 0.005 | 0.192 |
| Proposal – San Jose Neighborhood Sidewalk Accessib | 0.017 | 0.005 | 0.196 |
| Proposal – Santa Clara Municipal Facility Site Imp | 0.013 | 0.004 | 0.192 |
| Proposal – Sierra Nevada Meadow Restoration Initia | 0.021 | 0.006 | 0.180 |
| Proposal – Stockton Stormwater Pump Station Upgrad | 0.024 | 0.008 | 0.190 |
| Proposal – Sunnyvale Storm Drain Replacement.pdf | 0.013 | 0.004 | 0.196 |
| Proposal – Trinity River Habitat Restoration Proje | 0.033 | 0.010 | 0.175 |
| Redwood Public Works Builders – Company Profile.pd | 0.028 | 0.008 | 0.183 |
| proposal_caltrans_drainage_upgrade.pdf | 0.011 | 0.012 | 0.219 |
| proposal_sacramento_sidewalk_project.pdf | 0.010 | 0.010 | 0.221 |
| proposal_santa_clara_facility_renovation.pdf | 0.012 | 0.011 | 0.438 |
| sierra_west_company_profile.pdf | 0.011 | 0.011 | 0.256 |

## Pattern Extraction (information captured in raw text)

| Pattern | pdfplumber | PyMuPDF | pdf-parse |
|---------|-----------|---------|-----------|
| Emails | 0 | 0 | 0 |
| Phone numbers | 0 | 0 | 0 |
| Dollar amounts | 19 | 19 | 19 |
| Dates | 0 | 0 | 0 |
| 6-digit codes (NAICS) | 17 | 17 | 17 |

## Table Extraction

| Library | Tables found | Notes |
|---------|-------------|-------|
| pdfplumber | 0 | Native table extraction with cell-level data |
| PyMuPDF | 0 | Table detection via `find_tables()` (PyMuPDF 1.23+) |
| pdf-parse | 0 | No table extraction capability |

## Errors

### pdfplumber
No errors.

### pymupdf
No errors.

### pdf-parse
No errors.

## Analysis

### Text Completeness
All three libraries are very close. pdf-parse extracted the most total characters (18,545), followed by PyMuPDF (18,444, ~0.5% less), then pdfplumber (18,147, ~2% less). pdf-parse won 15/24 files, PyMuPDF won 7/24, pdfplumber won 0. The differences are small (typically 10-20 chars per file — likely whitespace/newline handling differences).

**Verdict**: Effectively a tie — all three extract the same meaningful content.

### Speed
PyMuPDF is the clear winner: **2.6x faster than pdfplumber, 28x faster than pdf-parse**.
- PyMuPDF: 0.19s total (0.008s avg per file)
- pdfplumber: 0.51s total (0.021s avg per file)
- pdf-parse: 5.33s total (0.222s avg per file — includes Node.js subprocess overhead)

On Lambda processing hundreds of PDFs, PyMuPDF would save significant execution time and cost.

### Pattern Extraction
All three libraries extracted identical patterns: 19 dollar amounts, 17 six-digit codes (potential NAICS). No differences — the text quality is equivalent for downstream LLM extraction.

### Table Extraction
None of the test PDFs contained structured tables (all returned 0). Both pdfplumber and PyMuPDF have table extraction APIs; pdf-parse does not. For real-world RFPs with pricing tables and requirement matrices, pdfplumber's `extract_tables()` and PyMuPDF's `find_tables()` would both be valuable. pdfplumber has a more mature and well-documented table extraction API.

### Reliability
All three parsed all 24 files with zero errors.

### Lambda Deployment Considerations
- **PyMuPDF**: C-based (MuPDF), fast cold starts, low memory. Well-suited for Lambda.
- **pdfplumber**: Python-based, wraps pdfminer. Heavier but pure Python.
- **pdf-parse**: Node.js only — not usable in the Python Lambda pipeline without a subprocess call, which adds ~200ms overhead per file.

## Recommendation

### Verdict: **PyMuPDF** for the backend pipeline

| Factor | Winner | Why |
|--------|--------|-----|
| Speed | **PyMuPDF** | 2.6x faster than pdfplumber, 28x faster than pdf-parse |
| Text quality | Tie | All three extract equivalent content |
| Pattern extraction | Tie | Identical results across all libraries |
| Table extraction | pdfplumber (edge) | More mature API, but PyMuPDF's `find_tables()` is capable |
| Lambda fit | **PyMuPDF** | C-based, fast cold starts, lower memory |
| Reliability | Tie | Zero errors across all three |

**PyMuPDF is the recommended choice for Civitas's backend PDF pipeline.** It matches pdfplumber and pdf-parse on text quality while being significantly faster — critical when processing hundreds of RFP attachments per scraping run on Lambda. The speed advantage compounds at scale and directly reduces AWS costs.

**Keep pdf-parse on the frontend** for user-uploaded proposals in the Next.js app — it works well there and avoids adding a Python dependency to the frontend.

### Migration path
Switching from pdfplumber to PyMuPDF in `webscraping/v2/pipeline/enrich.py` is a one-function change:

```python
# Before (pdfplumber)
def extract_text_from_pdf(filepath: str) -> str:
    parts = []
    with pdfplumber.open(filepath) as pdf:
        for page in pdf.pages:
            page_text = page.extract_text()
            if page_text:
                parts.append(page_text)
    return "\n\n".join(parts).strip()

# After (PyMuPDF)
def extract_text_from_pdf(filepath: str) -> str:
    parts = []
    doc = fitz.open(filepath)
    for page in doc:
        text = page.get_text()
        if text.strip():
            parts.append(text.strip())
    doc.close()
    return "\n\n".join(parts).strip()
```
