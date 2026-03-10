# Civitas Wiki

**Civitas** is a California government RFP matching platform that helps contractors discover, evaluate, and respond to government contract opportunities. The system uses AI-powered matching to score RFPs against company profiles, and generates tailored proposals and execution plans.

## Documentation

### Architecture
- **[Frontend Architecture](Frontend)** — Next.js app structure, pages, API routes, state management, and UI flows
- **[Backend Architecture](Backend)** — Django REST API, S3 storage model, authentication, LLM extraction, and API endpoints

### Product
- **[Key Features](Key-Features)** — End-to-end explanation of each major feature: RFP discovery, profile building, matching, proposal generation, status tracking, and web scraping pipeline
- **[Matching Algorithm](Matching-Algorithm)** — Deep dive into the 3-stage scoring pipeline, 10 scoring categories, synonym expansion, canonicalization, and explanation generation

## Quick Links

| Component | Dev URL | Prod URL |
|---|---|---|
| Frontend | `localhost:3000` | `civitas-ai.onrender.com` |
| Backend | `localhost:8000` | `civitas-srv.onrender.com` |
| S3 Bucket | — | `civitas-uploads` (us-east-1) |

## Tech Stack

| Layer | Technologies |
|---|---|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4 |
| Backend | Django 6, Django REST Framework, Gunicorn |
| Storage | AWS S3 (JSON files), SQLite (auth sessions only) |
| AI/LLM | Groq (llama-3.1-8b-instant) for extraction & generation |
| Scraping | Selenium, BeautifulSoup, pdfplumber |
| Deployment | Render.com |

## Team

An Doan, Erika Li, Clara Wang, Iona Xia, Brooke Ballhaus
