# Storage breakdown & connecting user data

## Storage: AWS for data, Django only for auth

**No toggles.** Profile and user data use **S3 (one JSON file per user)**. Contracts use **S3 only** (no DynamoDB): document files in S3 and contract list in user JSON. Only session and user account stay in Django.

### 1. What’s stored where (current)

| Storage        | What it holds                         | Location |
|----------------|----------------------------------------|----------|
| **Session**    | Session ID in cookie (`sessionid`)    | **Local** (Django DB) – who is logged in |
| **Django DB**  | **User** (id, username, email, password) | **Local** – auth and session lookup only. |
| **AWS S3**     | **One JSON file per user**             | **AWS** – key `users/{username}.json`. All user info serialized: `profile`, `token`, `token_expires_at`. Read/write = deserialize/serialize. |
| **AWS S3**     | **Token index**                       | **AWS** – key `auth/tokens.json`. Map `token -> username` for Bearer auth lookup. |
| **AWS S3**     | Contract **document files**           | **AWS** – paths `uploads/{user_id}/{contract_id}/{filename}` (e.g. PDF). Linked from profile.uploaded_documents. |
| **API**        | REST                                  | `/api/auth/me/`, `/api/profile/`, `/api/contracts/` |

- **User (auth):** Django only. No DynamoDB table for users; no “user table” in AWS.
- **User data (profile + token):** One **JSON file per user** in S3 at `users/{username}.json`. Backend **serializes** (dict → JSON string → PutObject) and **deserializes** (GetObject → JSON string → dict). The file is **constantly updated**: on every profile save (PATCH /api/profile/) and after every contract create, update, or delete (profile is recomputed from contracts and written back).
- **Contracts:** No DynamoDB. Document files in S3 at `uploads/{user_id}/{contract_id}/{filename}`; contract list (metadata + link) in `profile.uploaded_documents` in the user's JSON file.

**Session key and CSRF:** Stored by Django. Bearer tokens live in the user’s JSON file and in `auth/tokens.json` for lookup.

### 2. S3 only (no DynamoDB)

Use one bucket (e.g. `AWS_STORAGE_BUCKET_NAME`):

- **User data:** `users/{username}.json` – created/updated by the app (serialize/deserialize). No separate table.
- **Token index:** `auth/tokens.json` – created/updated by the app.
- **Uploaded documents:** `uploads/{user_id}/{contract_id}/{filename}` — contract files (e.g. PDF) stored here; the list and links are in the user's profile JSON as `uploaded_documents`. No DynamoDB table required.

---

### 2. Frontend

| Storage        | Keys / usage                           | Tied to user? |
|----------------|----------------------------------------|----------------|
| **Cookies**    | `sessionid` (via `/api/django` proxy)  | Yes (session)  |
| **localStorage** | `companyProfile`                     | No             |
| **localStorage** | `extractedProfileData`               | No             |
| **localStorage** | `uploadedFiles`                      | No             |
| **localStorage** | `civitas_saved_rfps`                 | No             |
| **localStorage** | `civitas_not_interested_rfps`        | No             |
| **localStorage** | `civitas_expressed_interest_rfps`    | No             |

So today:

- **Auth** is user-specific (session cookie → backend knows who you are).
- **Profile and RFP actions** are global per browser: same `companyProfile` and same saved/not-interested lists for everyone on that device. Login/logout do not change what you see there.

---

## What “connect user data to storage” means

Goal: **login shows this user’s data; logout clears or hides it.**

Two directions:

### A. Use backend as source of truth (recommended)

- **Profile**: Stop using `companyProfile` (and `extractedProfileData` / `uploadedFiles`) as the main store. Use backend instead:
  - **On login / app load**: Call `GET /api/auth/me/` (and optionally `GET /api/profile/`). Use that for “current profile” and for match logic.
  - **On save (profile-setup / profile page)**: `PATCH /api/profile/` with the edited fields. Optionally keep a small local cache keyed by `user_id` for offline/UX.
- **Contracts**: Already backend; use `GET /api/contracts/` and `POST /api/contracts/` so uploads are tied to the logged-in user.
- **RFP actions** (saved, not interested, expressed interest): Either:
  - Move to backend (new models + API), and load/save per user, or
  - Keep in localStorage but **key by user id**, e.g. `civitas_saved_rfps_${userId}`. Then on login you switch to that user’s keys; on logout you clear in-memory state (and optionally leave keys for next time that user logs in on this device).

Result: login/logout “get” the right stuff because the app loads and saves by “current user” (session + backend, and optionally user-scoped localStorage).

### B. Keep everything in localStorage but key by user

- Store `current_user_id` in memory (or a short-lived cookie) after login; drop it on logout.
- All keys become per-user: `companyProfile_${userId}`, `civitas_saved_rfps_${userId}`, etc.
- On login: set `current_user_id`, read from `*_${userId}`.
- On logout: clear `current_user_id` and in-memory state; next login uses a different `userId` and different keys.

This gives per-user behavior on one device but does not sync across devices or back up to the server.

---

## Recommended path: backend for profile + user-scoped localStorage for RFP actions

1. **Auth (already done)**  
   Login/logout and `/api/auth/me/` already give you the current user; session is the storage that makes “get stuff for this user” work.

2. **Profile**  
   - After login (or on app init when session exists), call `GET /api/auth/me/` and use `profile` for dashboard match logic and profile page.
   - On profile-setup and profile page: save with `PATCH /api/profile/` instead of (or in addition to) `localStorage.setItem("companyProfile", ...)`.
   - Optionally: one-time migration from existing `companyProfile` into backend on first load after login (e.g. if backend profile is empty, POST/PATCH from localStorage then clear or stop using it).

3. **Contracts**  
   - Upload flow: `POST /api/contracts/` with the logged-in user’s session so contracts are stored per user.
   - List: `GET /api/contracts/` so login/logout naturally “get” the right contracts.

4. **RFP actions (saved, not interested, expressed interest)**  
   - **Quick win**: Keep using localStorage but key by user id, e.g. `civitas_saved_rfps_${user_id}`. Load/save with that key after you have `user_id` from `GET /api/auth/me/`. On logout, clear in-memory state.
   - **Later**: Add backend models and API so these are stored in the DB and shared across devices.

5. **Optional cleanup**  
   - Stop writing `companyProfile` / `extractedProfileData` / `uploadedFiles` once profile and contracts are fully driven by backend, or keep them only as a cache keyed by `user_id` if you want offline/UX benefits.

---

## Summary table (after connecting)

| Data           | Storage              | How login/logout “get” it                    |
|----------------|----------------------|----------------------------------------------|
| Who is logged in | Session (cookie)   | Backend reads session; frontend calls `/api/auth/me/` |
| User + profile | Backend (DB)         | Load from `/api/auth/me/` and `/api/profile/` |
| Contracts      | Backend (DB)         | Load from `/api/contracts/`                  |
| Saved RFPs     | localStorage (per user) or backend | Load from `civitas_saved_rfps_${userId}` or API |
| Not interested | Same                 | Same pattern                                 |
| Expressed interest | Same              | Same pattern                                 |

Once profile and (optionally) RFP actions are tied to the current user (via backend or user-scoped keys), login/logout will correctly show and update that user’s data.
