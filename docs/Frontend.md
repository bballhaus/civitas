# Frontend Architecture

Civitas's frontend is a **Next.js 16** application built with React 19, TypeScript, and Tailwind CSS 4. It handles RFP browsing, matching, profile management, AI document generation, and authentication.

## Tech Stack

| Technology | Purpose |
|---|---|
| Next.js 16.1.6 | React framework with server-side API routes |
| React 19.2.3 | UI component library |
| TypeScript 5 | Type-safe development |
| Tailwind CSS 4 | Utility-first styling |
| Groq SDK | LLM-powered proposal & plan generation (server-side) |
| AWS SDK (S3) | Fetching scraped RFP data (server-side) |
| pdf-parse | PDF text extraction for style reference |
| react-markdown | Rendering generated documents |

## Directory Structure

```
front_end/src/
├── app/                              # Next.js App Router pages & API routes
│   ├── page.tsx                      # Root redirect
│   ├── layout.tsx                    # Root layout (fonts, global CSS, prefetch)
│   ├── login/page.tsx                # Login form
│   ├── signup/page.tsx               # Registration with password validation
│   ├── home/page.tsx                 # Dashboard overview (stats, deadlines)
│   ├── upload/page.tsx               # Contract upload & AI extraction
│   ├── profile-setup/page.tsx        # First-time profile setup
│   ├── profile/page.tsx              # Full profile editor
│   ├── dashboard/
│   │   ├── page.tsx                  # Main RFP search & matching interface
│   │   └── rfp/[id]/page.tsx         # Individual RFP detail view
│   └── api/                          # Server-side API routes
│       ├── auth/                     # Authentication (signup, login, logout, me, change-password)
│       ├── contracts/                # Contract CRUD + extraction
│       ├── profile/                  # Profile CRUD + refresh + extraction
│       ├── user/                     # RFP status, generated POE/proposals
│       ├── events/route.ts           # Fetch & transform RFPs from S3
│       ├── capabilities-analysis/route.ts
│       ├── match-summary/route.ts
│       ├── rfp-requirements-summary/route.ts
│       ├── generate-proposal/route.ts
│       └── generate-plan-of-execution/route.ts
├── components/
│   ├── AppHeader.tsx                 # Navigation bar (Home, Matches, Profile, Logout)
│   ├── MeshBackground.tsx            # Decorative background
│   ├── PrefetchEvents.tsx            # Background RFP data preloader
│   ├── LoadingScreen.tsx             # Loading spinner
│   └── MarkdownContent.tsx           # Markdown renderer
├── lib/
│   ├── api.ts                        # Frontend API client (auth, profile, contracts)
│   ├── s3.ts                         # S3 client utility
│   ├── user-data.ts                  # User JSON read/write in S3
│   ├── auth.ts                       # JWT + password hashing
│   ├── extraction.ts                 # LLM document extraction
│   ├── contract-storage.ts           # Contract CRUD operations
│   ├── profile-storage.ts            # Profile management + aggregation
│   ├── rfp-status.ts                 # RFP status tracking
│   ├── rfp-matching.ts               # Matching algorithm (1300+ lines)
│   ├── capabilities.ts               # Capability normalization & synonyms
│   └── events-cache.ts               # Client-side RFP caching
├── data/
│   ├── filter-options.ts             # California cities, NAICS codes, filter lists
│   ├── california-counties.json      # County list
│   └── capabilities.json             # Capability taxonomy
└── types/
    └── file-saver.d.ts               # Type declarations
```

## Pages & User Flows

### Authentication

**Login** (`/login`) — Username/password form that authenticates via `/api/auth/login`. On success, stores a JWT in localStorage and redirects to `/home`.

**Signup** (`/signup`) — Registration form with real-time password strength validation:
- At least 8 characters
- One uppercase letter, one lowercase letter, one special character

On successful signup, redirects to `/upload` for profile setup.

### Onboarding

**Upload** (`/upload`) — Drag-and-drop interface for uploading past contracts (PDF, DOCX, TXT). The backend uses Groq LLM to extract company metadata (certifications, capabilities, NAICS codes, etc.) and auto-populates the user's profile.

**Profile Setup** (`/profile-setup`) — Guided first-time profile editor. Pre-populated from document extraction results. Users review and edit fields before saving.

### Core Application

**Home** (`/home`) — Overview dashboard showing:
- Quick stats: saved RFPs, applied count, in-progress count, upcoming deadlines
- Card sections for saved, applied, and in-progress RFPs
- Upcoming deadline alerts (next 30 days)

**Dashboard** (`/dashboard`) — The main RFP matching interface:
- Fetches all RFPs and scores them against the user's profile
- 12 filter categories: industry, agency, value range, capabilities, contract type, certifications, clearances, NAICS codes, cities, counties, size status, deadline status
- Sort by match score, deadline, or value
- RFP cards show title, agency, deadline, value, and match percentage
- Expandable match score breakdown per RFP
- Save, apply, and in-progress status actions

**RFP Detail** (`/dashboard/rfp/[id]`) — Deep-dive into a single RFP:
- Full metadata display (description, contact info, requirements)
- Detailed match score breakdown with explanations
- AI-generated **Proposal** and **Plan of Execution**
- Iterative refinement with user feedback
- Optional style reference from past proposals

**Profile** (`/profile`) — Full profile editor with sections for:
- Company name, industries, business size status
- Certifications, clearances, NAICS codes
- Work locations (cities & counties)
- Capabilities, agency experience, contract types
- Contract count, total past value, past performance narrative
- Uploaded contract documents

## API Routes (Server-Side)

These Next.js API routes run on the server and handle data fetching and AI generation.

### `GET /api/events`
Fetches scraped RFPs from S3 and transforms them into structured objects. Merges attachment extraction data (NAICS codes, certifications, deliverables) with base event data. Includes intelligent inference of industry, capabilities, and location from title/description text. Cached for 5 minutes.

### `POST /api/generate-proposal`
Generates an AI proposal draft using Groq LLM. Accepts the RFP, company profile, and optional past proposals for style matching. Supports iterative refinement with user feedback.

### `POST /api/generate-plan-of-execution`
Generates an internal planning document covering: requirements summary, capability gap analysis, action items, execution phases, and risks. Designed for internal decision-making rather than submission.

### `POST /api/match-summary`
Generates a natural-language summary explaining why an RFP matches (or doesn't match) the user's profile.

### `POST /api/rfp-requirements-summary`
Summarizes RFP requirements in a structured format for quick review.

### `POST /api/capabilities-analysis`
Analyzes the gap between a user's capabilities and an RFP's requirements.

## API Client (`lib/api.ts`)

Centralized module for all backend communication.

**Authentication**: `getAuthToken()`, `setAuthToken()`, `clearAuthToken()`, `getCsrfToken()`, `authHeaders()`

**User Management**: `getCurrentUser()`, `getProfileFromBackend()`, `logout()`

**Profile**: `saveProfileToBackend()`, `uploadContractDocument()`, `deleteContractDocument()`, `listContracts()`

**RFP Status**: `updateUserRfpStatus()`, `getGeneratedPoe()`, `getGeneratedProposal()`

**Caching**: `getCachedUser()`, `setCachedUser()`, `getCachedProfile()`, `setCachedProfile()`

The client auto-detects the environment (dev vs. prod) and routes requests to the appropriate backend URL.

## State Management & Caching

- **localStorage**: User auth token, cached profile data, saved RFP IDs
- **In-memory cache**: User object and profile cached per session
- **Server-side S3 cache**: RFP events cached for 5 minutes with stale-while-revalidate
- **PrefetchEvents component**: Preloads RFP data in the background on app mount
- **React useDeferredValue**: Smooth filter updates on the dashboard without blocking UI

## Development

```bash
cd front_end
npm install
npm run dev     # Start dev server on localhost:3000
npm run build   # Production build
npm run lint    # ESLint
```

**Environment Variables** (`front_end/.env.local`):
```
AWS_ACCESS_KEY_ID=...              # S3 credentials
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=us-east-1
AWS_S3_BUCKET=civitas-ai
GROQ_API_KEY=...                   # For AI generation + extraction
JWT_SECRET=...                     # HS256 signing key (min 256 bits)
```
