
# Household Emergency Toolkit — Spec

## Purpose

A self-hosted web app on the home LAN that answers one question fast: **"Where do we go, and what do we do?"**

- Search "dentist" during an emergency → a short list (~5) of pre-vetted local providers with tap-to-call.
- An emergency section with SOP-style first-aid protocols, drafted from authoritative sources and reviewed before publication (modeled on fire department protocol management: drafted from current standards → peer reviewed → distributed).

An LLM compiles and refreshes the information, but nothing reaches the family-facing side without the admin's approval.

## Scope

### In scope (v1)
- Server-rendered web app reachable by any device on the LAN over plain HTTP
- Location discovery, vetting, and scheduled re-verification with change flagging
- Protocol drafting from sources, review, publication, and re-review when sources change
- Single admin login for vetting and review; family-facing pages need no login

### Out of scope (v1)
- PWA / offline sync to devices
- HTTPS, remote access, VPN
- Multiple user accounts or roles beyond admin
- Push or email notifications

Keep the architecture compatible with adding a PWA later (the read side should be backed by a JSON API, even if v1 renders HTML server-side).

## Stack

- **Language:** TypeScript throughout
- **Server:** Hono on Node, server-rendered with Hono JSX
- **Database:** SQLite via Drizzle ORM (file on a mounted volume)
- **Scheduling:** in-process scheduler (e.g. `node-cron`) for the refresh worker
- **External services:** Google Places API (New) for discovery and details; an LLM API for extraction and protocol drafting (provider configurable, behind an interface)
- **Tests:** Vitest; external APIs mocked with recorded fixtures
- **Deploy:** Docker image + `docker-compose.yml` for the homelab

## Core concepts

### Location lifecycle

| Status | Meaning | Visible to family? |
|---|---|---|
| `candidate` | Found by discovery, not yet vetted | No |
| `approved` | Vetted by admin | Yes |
| `warn` | Was approved; refresh detected a change since last approval | Yes, with yellow warning icon and change summary |
| `rejected` | Admin declined | No |

- Refresh never silently overwrites an approved entry. Detected changes move it to `warn`.
- Re-approving a `warn` entry accepts the current data and returns it to `approved`.
- Search and browse show `approved` and `warn` entries only.

### Protocol lifecycle

| Status | Meaning | Visible to family? |
|---|---|---|
| `draft` | LLM-generated from sources | No |
| `in_review` | Submitted for admin review | No |
| `published` | Approved; the live version | Yes |
| `superseded` | A previous published version | No (kept for history) |
| `rejected` | Declined in review | No |

- Exactly one `published` version per protocol at a time.
- If a published version's sources change, the protocol is flagged `needs_rereview` and shown with the same yellow warning icon. The published version stays visible until a new version is published.

The two lifecycles intentionally mirror each other. Share the review/warn UI components where practical.

## Data model

Field names are guidance; adjust as needed but keep the semantics.

**settings** (single row)
- `home_label`, `home_lat`, `home_lng`
- `default_radius_mi`
- `location_refresh_cron`, `protocol_refresh_cron`

**categories**
- `id`, `name` (e.g. "Dentist"), `slug`
- `search_terms` (JSON array; used for Places queries, e.g. `["emergency dentist", "dentist"]`)
- `target_count` (default 5)

**locations**
- `id`, `category_id`, `place_id` (unique, nullable for manual entries)
- `name`, `address`, `phone`, `website`, `lat`, `lng`, `distance_mi`
- `rating`, `rating_count`, `business_status`
- `hours` (JSON, normalized weekly schedule)
- `after_hours_notes`, `walk_ins` (bool, nullable), `insurance_notes` — from LLM extraction; null means unknown
- `admin_notes`
- `status`, `last_verified_at`, `consecutive_fetch_failures`, `created_at`, `updated_at`

**location_snapshots**
- `id`, `location_id`, `fetched_at`, `payload` (JSON of tracked fields), `hash`

**location_changes**
- `id`, `location_id`, `detected_at`, `field`, `old_value`, `new_value`, `resolved_at`

**protocols**
- `id`, `slug`, `title`, `tags` (JSON)
- `needs_rereview` (bool), `rereview_reason`

**protocol_versions**
- `id`, `protocol_id`, `version` (int), `status`
- `body_md` (SOP format, see below)
- `created_at`, `submitted_at`, `reviewed_at`, `review_notes`

**protocol_sources**
- `id`, `protocol_version_id`, `url`, `title`, `fetched_at`, `content_hash`

## Components

### 1. First-run setup (admin)
1. Set home location (address → lat/lng via Places geocoding or manual entry) and default radius.
2. Create categories to anticipate (dentist, urgent care, ER, vet, etc.), with search terms.
3. Run discovery per category → review candidates → approve up to `target_count`.

### 2. Discovery
- Triggered by admin per category.
- Places Text Search with each search term, biased to home location and radius.
- Dedupe by `place_id`; skip places already stored in any status.
- Compute distance from home; rank by distance and rating.
- Insert as `candidate`. Optionally run extraction (component 4) on each.

### 3. Refresh worker (locations)
Runs on `location_refresh_cron` for all `approved` and `warn` locations:
1. Fetch Place Details for the tracked fields (name, address, phone, website, hours, rating, business status).
2. Run extraction (component 4) if the location has a website.
3. Normalize, hash, and compare against the latest snapshot.
4. If tracked fields differ: write snapshot, write `location_changes` rows, set status to `warn`.
5. If unchanged: update `last_verified_at` only.
6. On fetch failure: do not change status; increment `consecutive_fetch_failures`. After N failures (configurable, default 3), set `warn` with a "could not verify" change row.

Rating changes are recorded but should not by themselves trigger `warn` unless they cross a configurable threshold, to avoid churn. All other tracked-field changes trigger `warn`.

### 4. LLM extraction
- Input: text content of the location's website (homepage plus a small number of likely pages, e.g. hours, contact, insurance).
- Output: structured JSON validated against a schema: `after_hours_notes`, `walk_ins`, `insurance_notes`, plus the source URL for each field.
- Rules: return null for anything not stated on the page; never infer or invent. Reject and log responses that fail schema validation.

### 5. Protocol pipeline
1. **Sources:** admin enters or approves source URLs for a protocol. Optionally restrict to a configurable domain allowlist of authoritative sources. The LLM does not choose its own sources.
2. **Draft:** fetch sources, store `content_hash`, and have the LLM draft `body_md` citing only those sources. Save as `draft`.
3. **Review:** admin reads the draft side by side with its sources, edits if needed, then approves (→ `published`, previous published → `superseded`) or rejects with notes.
4. **Re-check:** on `protocol_refresh_cron`, re-fetch sources of each published version. If any `content_hash` changed, set `needs_rereview` with the changed source(s) as the reason. Admin can start a new draft from there.

**SOP body format** (markdown, consistent headings):
- Title and scope (when this protocol applies)
- Steps (numbered, short, imperative)
- Escalation criteria (when to call 911 / go to the ER)
- Do not (common mistakes)
- Sources (rendered from `protocol_sources`)

### 6. Family-facing UI (no login)
Mobile-first; assume it's used on a phone under stress. Large tap targets, minimal text per screen.
- **Home:** search box, list of categories, prominent link to the emergency section.
- **Search:** matches category names, search terms, and location names. Results grouped by category, sorted by distance.
- **Location card:** name, distance, tap-to-call (`tel:`), open in maps, hours with "open now" indicator, after-hours/walk-in/insurance notes when known, yellow warning icon plus change summary when in `warn`.
- **Emergency section:** list of published protocols; protocol page renders the SOP body, with a warning icon if `needs_rereview`.

### 7. Admin UI (login required)
- Login: single admin password from env (stored as a hash), session cookie.
- Setup and settings
- Categories CRUD
- Candidates queue per category: approve / reject
- Warn queue: shows each change (field, old → new); re-approve or reject
- Manual location add/edit
- Protocols: manage sources, generate draft, review/edit/publish, version history
- "Run refresh now" button for testing

### 8. JSON API
Expose read endpoints for categories, visible locations, and published protocols (`GET /api/...`). The family UI may render server-side, but this API is the seam for a future PWA.

## Configuration (env)
- `PORT`
- `DATABASE_PATH`
- `ADMIN_PASSWORD_HASH`
- `SESSION_SECRET`
- `GOOGLE_PLACES_API_KEY`
- `LLM_PROVIDER`, `LLM_API_KEY`, `LLM_MODEL`
- `REFRESH_FAILURE_THRESHOLD` (default 3)

## Milestones

Each milestone should be independently testable and leave the app in a working state.

**M1 — Skeleton and read side**
- Project scaffold, Drizzle schema and migrations, seed script with sample categories and approved locations.
- Home, search, location card, JSON read API.
- *Accept:* from a phone on the LAN, searching "dentist" shows seeded approved locations sorted by distance, with working tap-to-call.

**M2 — Admin and vetting**
- Admin auth, categories CRUD, manual location CRUD, status transitions.
- *Accept:* admin can add a location, approve or reject it, and family search reflects the change. Candidates and rejected entries never appear in search.

**M3 — Discovery**
- Places integration, candidate ranking, candidates queue.
- *Accept:* running discovery for a category creates deduplicated candidates with distance and rating; approving them makes them searchable. Tests use recorded Places fixtures.

**M4 — Refresh and warn**
- Scheduler, snapshot/diff logic, change records, warn queue, re-approve flow, failure threshold.
- *Accept:* unit tests cover unchanged, changed-field, rating-below-threshold, rating-above-threshold, and repeated-failure cases. A changed fixture moves an approved location to `warn` with the correct change summary; re-approval clears it.

**M5 — LLM extraction**
- Provider interface, website fetch, schema-validated extraction, integration into discovery and refresh.
- *Accept:* extraction populates notes fields from fixture pages, returns null for unstated fields, and rejects malformed output without crashing the refresh run.

**M6 — Protocol pipeline**
- Sources management, drafting, review/publish, version history, protocol pages.
- *Accept:* a protocol can go from sources → draft → published, a second publish supersedes the first, and drafts are never visible on family pages.

**M7 — Protocol re-check**
- Scheduled source re-fetch and `needs_rereview` flagging.
- *Accept:* changing a source fixture's content flags the protocol with the correct reason; the published version remains visible with a warning icon.

**M8 — Deployment**
- Dockerfile, `docker-compose.yml` with a volume for SQLite, health check endpoint, README with setup steps.
- *Accept:* `docker compose up` on a fresh machine runs the app, and data survives container restarts.

## Open questions (resolved 2026-10-27)
- `CLOSED_PERMANENTLY`: standard `warn`, family pages sort last with a red "reported closed" label.
- Cadences: locations weekly (Sun 03:00), protocol sources monthly (1st, 04:00), both editable in settings.
- LLM: Anthropic; `claude-haiku-5-5` for extraction, `claude-opus-5-5` for drafting; env-configurable.
- Places spend: `PLACES_CALL_CAP=200` calls per refresh or discovery run.
