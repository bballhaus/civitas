"""
PDF Parsing Library Benchmark for Civitas.

Compares pdfplumber, PyMuPDF (fitz), and pdf-parse (Node.js) across:
  - Text completeness (char/word count)
  - Text accuracy (pattern extraction: emails, phones, dollars, dates, NAICS)
  - Table extraction capability
  - Speed (per-file and total)
  - Memory usage (peak RSS delta)
  - Error resilience

Test data:
  - 24 local PDFs from docs/test-profiles/ (proposals & company profiles)
  - ~5 RFP PDFs downloaded from S3 (civitas-ai bucket)

Usage:
    python tests/pdf_parsing_benchmark.py
"""

from __future__ import annotations

import json
import os
import re
import resource
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path

# ── Library imports ──────────────────────────────────────────────────────────

import pdfplumber
import fitz  # PyMuPDF

# Add project root for S3 config
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

TESTS_DIR = Path(__file__).resolve().parent
PROFILES_DIR = PROJECT_ROOT / "docs" / "test-profiles"
REPORT_PATH = TESTS_DIR / "pdf_benchmark_report.md"

# Node.js helper script for pdf-parse (created at runtime)
PDF_PARSE_SCRIPT = TESTS_DIR / "_pdf_parse_helper.js"

# ── Data structures ──────────────────────────────────────────────────────────


@dataclass
class ExtractionResult:
    library: str
    file: str
    text: str = ""
    char_count: int = 0
    word_count: int = 0
    page_count: int = 0
    time_seconds: float = 0.0
    memory_kb: int = 0
    tables_found: int = 0
    error: str = ""
    # Pattern counts
    emails_found: int = 0
    phones_found: int = 0
    dollars_found: int = 0
    dates_found: int = 0
    naics_found: int = 0


# ── Pattern matchers ─────────────────────────────────────────────────────────

EMAIL_RE = re.compile(r"[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z]{2,}")
PHONE_RE = re.compile(r"\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}")
DOLLAR_RE = re.compile(r"\$[\d,]+(?:\.\d{2})?")
DATE_RE = re.compile(
    r"\b(?:\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|"
    r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4})\b",
    re.IGNORECASE,
)
NAICS_RE = re.compile(r"\b\d{6}\b")  # 6-digit codes


def count_patterns(text: str) -> dict:
    return {
        "emails_found": len(EMAIL_RE.findall(text)),
        "phones_found": len(PHONE_RE.findall(text)),
        "dollars_found": len(DOLLAR_RE.findall(text)),
        "dates_found": len(DATE_RE.findall(text)),
        "naics_found": len(NAICS_RE.findall(text)),
    }


# ── Extractors ───────────────────────────────────────────────────────────────


def extract_pdfplumber(filepath: str) -> ExtractionResult:
    result = ExtractionResult(library="pdfplumber", file=Path(filepath).name)
    mem_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    t0 = time.perf_counter()
    try:
        with pdfplumber.open(filepath) as pdf:
            result.page_count = len(pdf.pages)
            parts = []
            table_count = 0
            for page in pdf.pages:
                text = page.extract_text()
                if text:
                    parts.append(text)
                tables = page.extract_tables()
                if tables:
                    table_count += len(tables)
                    for table in tables:
                        for row in table:
                            row_text = " | ".join(
                                str(cell) if cell else "" for cell in row
                            )
                            parts.append(row_text)
            result.text = "\n\n".join(parts).strip()
            result.tables_found = table_count
    except Exception as e:
        result.error = str(e)

    result.time_seconds = time.perf_counter() - t0
    mem_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result.memory_kb = max(0, mem_after - mem_before)

    result.char_count = len(result.text)
    result.word_count = len(result.text.split())
    result.__dict__.update(count_patterns(result.text))
    return result


def extract_pymupdf(filepath: str) -> ExtractionResult:
    result = ExtractionResult(library="pymupdf", file=Path(filepath).name)
    mem_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

    t0 = time.perf_counter()
    try:
        doc = fitz.open(filepath)
        result.page_count = len(doc)
        parts = []
        table_count = 0
        for page in doc:
            text = page.get_text()
            if text.strip():
                parts.append(text.strip())
            # PyMuPDF table extraction
            try:
                tabs = page.find_tables()
                if tabs and tabs.tables:
                    table_count += len(tabs.tables)
                    for tab in tabs.tables:
                        df = tab.extract()
                        for row in df:
                            row_text = " | ".join(
                                str(cell) if cell else "" for cell in row
                            )
                            parts.append(row_text)
            except Exception:
                pass  # table extraction not critical
        doc.close()
        result.text = "\n\n".join(parts).strip()
        result.tables_found = table_count
    except Exception as e:
        result.error = str(e)

    result.time_seconds = time.perf_counter() - t0
    mem_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    result.memory_kb = max(0, mem_after - mem_before)

    result.char_count = len(result.text)
    result.word_count = len(result.text.split())
    result.__dict__.update(count_patterns(result.text))
    return result


def _ensure_pdf_parse_helper():
    """Write the Node.js helper script for pdf-parse v2."""
    script = """\
const fs = require('fs');
const { PDFParse } = require('pdf-parse');

const filepath = process.argv[2];
const buffer = fs.readFileSync(filepath);

(async () => {
    try {
        const parser = new PDFParse(new Uint8Array(buffer));
        const result = await parser.getText();
        const text = result.text || "";
        const out = {
            text: text,
            pages: result.numpages || 0,
            char_count: text.length,
            word_count: text.split(/\\s+/).filter(w => w).length,
            error: ""
        };
        process.stdout.write(JSON.stringify(out));
    } catch (err) {
        process.stdout.write(JSON.stringify({
            text: "",
            pages: 0,
            char_count: 0,
            word_count: 0,
            error: err.message || String(err)
        }));
    }
})();
"""
    PDF_PARSE_SCRIPT.write_text(script)


def extract_pdf_parse(filepath: str) -> ExtractionResult:
    result = ExtractionResult(library="pdf-parse", file=Path(filepath).name)

    _ensure_pdf_parse_helper()

    # Find node_modules with pdf-parse
    node_modules = PROJECT_ROOT / "front_end" / "node_modules"
    if not (node_modules / "pdf-parse").exists():
        result.error = "pdf-parse not installed in front_end/node_modules"
        return result

    t0 = time.perf_counter()
    try:
        env = os.environ.copy()
        env["NODE_PATH"] = str(node_modules)
        proc = subprocess.run(
            ["node", str(PDF_PARSE_SCRIPT), str(Path(filepath).resolve())],
            capture_output=True,
            text=True,
            timeout=30,
            env=env,
        )
        if proc.returncode != 0:
            result.error = proc.stderr.strip()[:200]
        else:
            data = json.loads(proc.stdout)
            result.text = data.get("text", "")
            result.page_count = data.get("pages", 0)
            result.char_count = data.get("char_count", 0)
            result.word_count = data.get("word_count", 0)
            result.error = data.get("error", "")
            result.tables_found = 0  # pdf-parse has no table extraction
    except subprocess.TimeoutExpired:
        result.error = "timeout (>30s)"
    except Exception as e:
        result.error = str(e)

    result.time_seconds = time.perf_counter() - t0
    # No meaningful memory measurement for subprocess
    result.memory_kb = 0

    if result.text:
        result.__dict__.update(count_patterns(result.text))
    return result


# ── S3 PDF download ─────────────────────────────────────────────────────────


def download_s3_pdfs(max_files: int = 5) -> list[str]:
    """Download a sample of RFP PDFs from the civitas-ai S3 bucket."""
    downloaded = []
    try:
        from webscraping.v2.config import get_s3_client, S3_BUCKET, S3_V2_PREFIX

        s3 = get_s3_client()

        # List manifests to find events with attachment URLs
        manifests = s3.list_objects_v2(
            Bucket=S3_BUCKET, Prefix=f"{S3_V2_PREFIX}manifests/", Delimiter="/"
        )
        source_prefixes = [
            p["Prefix"] for p in manifests.get("CommonPrefixes", [])
        ]

        attachment_urls = []
        for prefix in source_prefixes[:10]:  # check up to 10 sources
            try:
                manifest_key = f"{prefix}latest.json"
                obj = s3.get_object(Bucket=S3_BUCKET, Key=manifest_key)
                manifest = json.loads(obj["Body"].read())
                events = manifest if isinstance(manifest, list) else manifest.get("events", [])
                for event in events:
                    urls = event.get("attachment_urls", [])
                    for url in urls:
                        if url.lower().endswith(".pdf"):
                            attachment_urls.append(url)
                            if len(attachment_urls) >= max_files * 3:
                                break
                    if len(attachment_urls) >= max_files * 3:
                        break
            except Exception:
                continue
            if len(attachment_urls) >= max_files * 3:
                break

        # Download PDFs
        import requests
        for url in attachment_urls[:max_files * 2]:
            if len(downloaded) >= max_files:
                break
            try:
                resp = requests.get(url, timeout=15, allow_redirects=True)
                if resp.status_code == 200 and len(resp.content) > 1000:
                    tmp = tempfile.NamedTemporaryFile(
                        suffix=".pdf", prefix="s3_rfp_", delete=False, dir=str(TESTS_DIR)
                    )
                    tmp.write(resp.content)
                    tmp.close()
                    downloaded.append(tmp.name)
                    print(f"  Downloaded S3 PDF: {Path(url).name} ({len(resp.content)} bytes)")
            except Exception as e:
                print(f"  Failed to download {url}: {e}")
                continue

    except Exception as e:
        print(f"  S3 download skipped: {e}")

    return downloaded


# ── Report generation ────────────────────────────────────────────────────────


def generate_report(all_results: list[ExtractionResult], pdf_files: list[str]):
    """Generate a markdown benchmark report."""
    libs = ["pdfplumber", "pymupdf", "pdf-parse"]

    # Aggregate stats per library
    stats = {}
    for lib in libs:
        lib_results = [r for r in all_results if r.library == lib]
        successful = [r for r in lib_results if not r.error]
        stats[lib] = {
            "total_files": len(lib_results),
            "successes": len(successful),
            "failures": len(lib_results) - len(successful),
            "total_chars": sum(r.char_count for r in successful),
            "total_words": sum(r.word_count for r in successful),
            "total_time": sum(r.time_seconds for r in lib_results),
            "avg_time": (
                sum(r.time_seconds for r in successful) / len(successful)
                if successful
                else 0
            ),
            "total_tables": sum(r.tables_found for r in successful),
            "total_emails": sum(r.emails_found for r in successful),
            "total_phones": sum(r.phones_found for r in successful),
            "total_dollars": sum(r.dollars_found for r in successful),
            "total_dates": sum(r.dates_found for r in successful),
            "total_naics": sum(r.naics_found for r in successful),
            "errors": [r for r in lib_results if r.error],
        }

    lines = []
    lines.append("# PDF Parsing Benchmark Report — Civitas")
    lines.append("")
    lines.append(f"**Date**: {time.strftime('%Y-%m-%d %H:%M')}")
    lines.append(f"**PDFs tested**: {len(pdf_files)}")
    lines.append(f"**Libraries**: pdfplumber {pdfplumber.__version__}, "
                 f"PyMuPDF {fitz.version[0]}, pdf-parse (Node.js)")
    lines.append("")

    # ── Summary table ────────────────────────────────────────────────────
    lines.append("## Summary")
    lines.append("")
    lines.append("| Metric | pdfplumber | PyMuPDF | pdf-parse |")
    lines.append("|--------|-----------|---------|-----------|")

    def row(label, key, fmt="{:,}"):
        vals = [fmt.format(stats[lib][key]) for lib in libs]
        lines.append(f"| {label} | {vals[0]} | {vals[1]} | {vals[2]} |")

    row("Files parsed", "successes")
    row("Failures", "failures")
    row("Total chars extracted", "total_chars")
    row("Total words extracted", "total_words")
    row("Total time (s)", "total_time", "{:.2f}")
    row("Avg time/file (s)", "avg_time", "{:.3f}")
    row("Tables found", "total_tables")
    row("Emails found", "total_emails")
    row("Phone numbers found", "total_phones")
    row("Dollar amounts found", "total_dollars")
    row("Dates found", "total_dates")
    row("6-digit codes (NAICS)", "total_naics")
    lines.append("")

    # ── Per-file comparison ──────────────────────────────────────────────
    lines.append("## Per-File Comparison")
    lines.append("")
    lines.append("| File | pdfplumber (chars) | PyMuPDF (chars) | pdf-parse (chars) | Winner |")
    lines.append("|------|-------------------|-----------------|-------------------|--------|")

    file_names = sorted(set(r.file for r in all_results))
    for fname in file_names:
        file_results = {r.library: r for r in all_results if r.file == fname}
        counts = {}
        for lib in libs:
            r = file_results.get(lib)
            counts[lib] = r.char_count if r and not r.error else 0

        winner = max(libs, key=lambda l: counts[l])
        vals = [f"{counts[lib]:,}" if counts[lib] else "FAIL" for lib in libs]
        lines.append(
            f"| {fname[:50]} | {vals[0]} | {vals[1]} | {vals[2]} | {winner} |"
        )
    lines.append("")

    # ── Speed comparison ─────────────────────────────────────────────────
    lines.append("## Speed Comparison")
    lines.append("")
    lines.append("| File | pdfplumber (s) | PyMuPDF (s) | pdf-parse (s) |")
    lines.append("|------|---------------|-------------|---------------|")

    for fname in file_names:
        file_results = {r.library: r for r in all_results if r.file == fname}
        times = []
        for lib in libs:
            r = file_results.get(lib)
            times.append(f"{r.time_seconds:.3f}" if r else "N/A")
        lines.append(f"| {fname[:50]} | {times[0]} | {times[1]} | {times[2]} |")
    lines.append("")

    # ── Pattern extraction comparison ────────────────────────────────────
    lines.append("## Pattern Extraction (information captured in raw text)")
    lines.append("")
    lines.append("| Pattern | pdfplumber | PyMuPDF | pdf-parse |")
    lines.append("|---------|-----------|---------|-----------|")
    for label, key in [
        ("Emails", "total_emails"),
        ("Phone numbers", "total_phones"),
        ("Dollar amounts", "total_dollars"),
        ("Dates", "total_dates"),
        ("6-digit codes (NAICS)", "total_naics"),
    ]:
        vals = [str(stats[lib][key]) for lib in libs]
        lines.append(f"| {label} | {vals[0]} | {vals[1]} | {vals[2]} |")
    lines.append("")

    # ── Table extraction ─────────────────────────────────────────────────
    lines.append("## Table Extraction")
    lines.append("")
    lines.append("| Library | Tables found | Notes |")
    lines.append("|---------|-------------|-------|")
    lines.append(f"| pdfplumber | {stats['pdfplumber']['total_tables']} | "
                 "Native table extraction with cell-level data |")
    lines.append(f"| PyMuPDF | {stats['pymupdf']['total_tables']} | "
                 "Table detection via `find_tables()` (PyMuPDF 1.23+) |")
    lines.append(f"| pdf-parse | 0 | "
                 "No table extraction capability |")
    lines.append("")

    # ── Errors ───────────────────────────────────────────────────────────
    lines.append("## Errors")
    lines.append("")
    for lib in libs:
        errs = stats[lib]["errors"]
        if errs:
            lines.append(f"### {lib}")
            for r in errs:
                lines.append(f"- `{r.file}`: {r.error}")
            lines.append("")
        else:
            lines.append(f"### {lib}")
            lines.append("No errors.")
            lines.append("")

    # ── Recommendation ───────────────────────────────────────────────────
    lines.append("## Recommendation")
    lines.append("")

    # Determine winner by scoring
    scores = {lib: 0 for lib in libs}

    # Text completeness (most chars wins)
    ranked_chars = sorted(libs, key=lambda l: stats[l]["total_chars"], reverse=True)
    scores[ranked_chars[0]] += 3
    scores[ranked_chars[1]] += 1

    # Speed (fastest wins)
    ranked_speed = sorted(libs, key=lambda l: stats[l]["total_time"])
    scores[ranked_speed[0]] += 3
    scores[ranked_speed[1]] += 1

    # Pattern extraction (most patterns found wins)
    pattern_total = {
        lib: sum(
            stats[lib][k]
            for k in [
                "total_emails",
                "total_phones",
                "total_dollars",
                "total_dates",
                "total_naics",
            ]
        )
        for lib in libs
    }
    ranked_patterns = sorted(libs, key=lambda l: pattern_total[l], reverse=True)
    scores[ranked_patterns[0]] += 2
    scores[ranked_patterns[1]] += 1

    # Table extraction
    ranked_tables = sorted(libs, key=lambda l: stats[l]["total_tables"], reverse=True)
    scores[ranked_tables[0]] += 2

    # Reliability (fewest failures)
    ranked_reliability = sorted(libs, key=lambda l: stats[l]["failures"])
    scores[ranked_reliability[0]] += 2

    winner = max(libs, key=lambda l: scores[l])

    lines.append("### Scoring")
    lines.append("")
    lines.append("| Category (weight) | Winner |")
    lines.append("|-------------------|--------|")
    lines.append(f"| Text completeness (3) | {ranked_chars[0]} |")
    lines.append(f"| Speed (3) | {ranked_speed[0]} |")
    lines.append(f"| Pattern extraction (2) | {ranked_patterns[0]} |")
    lines.append(f"| Table extraction (2) | {ranked_tables[0]} |")
    lines.append(f"| Reliability (2) | {ranked_reliability[0]} |")
    lines.append("")
    lines.append(f"| **Library** | **Score** |")
    lines.append("|------------|----------|")
    for lib in sorted(libs, key=lambda l: scores[l], reverse=True):
        lines.append(f"| {lib} | {scores[lib]} |")
    lines.append("")
    lines.append(f"### Verdict: **{winner}**")
    lines.append("")

    # Write context-specific notes
    lines.append("### Notes for Civitas")
    lines.append("")
    lines.append("- **Primary use case**: Extract text from RFP/proposal PDFs → send to Groq LLM for structured metadata extraction")
    lines.append("- **Deployment**: AWS Lambda (512MB–1GB memory, cold start sensitivity)")
    lines.append("- **Scale**: Hundreds of PDFs per scraping run across 44+ procurement portals")
    lines.append("- **Table data matters**: RFPs contain pricing tables, requirement matrices, evaluation criteria")
    lines.append("- The frontend (Next.js) currently uses `pdf-parse` for user-uploaded proposals — this can remain independent of the backend choice")
    lines.append("")

    report = "\n".join(lines)
    REPORT_PATH.write_text(report)
    print(f"\nReport written to: {REPORT_PATH}")
    return report


# ── Main ─────────────────────────────────────────────────────────────────────


def main():
    print("=" * 60)
    print("PDF Parsing Benchmark — Civitas")
    print("=" * 60)

    # Collect PDF files
    pdf_files = []

    # Local test profiles
    print("\nLoading test profile PDFs...")
    for pdf in sorted(PROFILES_DIR.rglob("*.pdf")):
        pdf_files.append(str(pdf))
        print(f"  {pdf.relative_to(PROJECT_ROOT)}")

    # S3 RFP attachments
    print("\nDownloading S3 RFP PDFs...")
    s3_pdfs = download_s3_pdfs(max_files=5)
    pdf_files.extend(s3_pdfs)

    print(f"\nTotal PDFs to test: {len(pdf_files)}")
    print("=" * 60)

    # Run benchmarks
    all_results: list[ExtractionResult] = []
    libraries = [
        ("pdfplumber", extract_pdfplumber),
        ("pymupdf", extract_pymupdf),
        ("pdf-parse", extract_pdf_parse),
    ]

    for lib_name, extractor in libraries:
        print(f"\n--- Testing {lib_name} ---")
        for filepath in pdf_files:
            fname = Path(filepath).name
            result = extractor(filepath)
            all_results.append(result)
            status = "OK" if not result.error else f"ERR: {result.error[:50]}"
            print(
                f"  {fname[:45]:45s} | "
                f"{result.char_count:>7,} chars | "
                f"{result.time_seconds:.3f}s | "
                f"tables:{result.tables_found} | "
                f"{status}"
            )

    # Generate report
    print("\n" + "=" * 60)
    print("Generating report...")
    generate_report(all_results, pdf_files)

    # Cleanup S3 temp files
    for f in s3_pdfs:
        try:
            os.unlink(f)
        except Exception:
            pass

    # Cleanup helper script
    if PDF_PARSE_SCRIPT.exists():
        PDF_PARSE_SCRIPT.unlink()


if __name__ == "__main__":
    main()
