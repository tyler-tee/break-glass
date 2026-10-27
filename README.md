# Break Glass: household emergency toolkit

A self-hosted web app for the home LAN that answers one question fast: "Where do we go, and what do we do?" Search "dentist" during an emergency and get a short list of pre-vetted local providers with tap-to-call. An emergency section holds first-aid protocols (SOPs) drafted from authoritative sources and reviewed before anyone sees them. An LLM compiles and refreshes the information, but nothing reaches the family-facing pages without the admin's approval.

**Location lifecycle.** Google Places discovery inserts `candidate` locations the family cannot see. The admin approves or rejects them. Approved locations are visible; a weekly refresh re-fetches details (and the website, if an LLM is configured) and never silently overwrites anything: if a tracked field changed, or the location could not be verified several times in a row, it moves to `warn` and shows a yellow warning with a change summary until the admin re-approves or rejects it.

**Protocol lifecycle.** The admin enters source URLs for a protocol (the LLM never picks its own sources), generates a `draft`, reviews it next to the sources, and publishes it. Exactly one version is `published` at a time and the previous one becomes `superseded`. A monthly re-check re-fetches the sources of each published version; if any changed, the protocol is flagged `needs_rereview` and keeps showing the published text with a warning until a new version is published.

## Prerequisites

- Docker with Compose, for the homelab deployment.
- Node 24 and npm on any machine where you generate the password hash and session secret (it can be your laptop, not the server), and for local development and tests. No-Node alternatives are given under Configuration.
- Optional: a Google Places API (New) key (discovery, refresh, geocoding) and an Anthropic API key (extraction, protocol drafting). Without them the app still serves manually entered locations.

## Configuration

Copy the example file and edit it:

```
cp .env.example .env
```

1. Admin password hash: `npm run hash-password -- '<password>'` (run `npm install` once first). Paste the output into `ADMIN_PASSWORD_HASH`. Without Node on the host you can build the image first and hash inside it (untested here, since Docker was unavailable when this was written): `docker compose run --rm --no-deps app node -e "import('./dist/features/admin/auth.js').then(m=>m.hashPassword(process.argv[1])).then(console.log)" '<password>'`. This needs a `.env` that already passes validation, so put a placeholder hash and a real secret in first, then replace the hash.
2. Session secret: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and paste it into `SESSION_SECRET` (at least 32 characters). Without Node, `openssl rand -hex 32` does the same.
3. Optionally add `GOOGLE_PLACES_API_KEY`, and `LLM_PROVIDER=anthropic` with `LLM_API_KEY`.

For local development you can put overrides in `.env.local`. It is loaded after `.env`, wins over it, and never overrides variables set in the real environment. Both files are git-ignored. Empty values (`PORT=`) count as unset and fall back to the default.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (positive integer). Compose pins this to 3000 inside the container. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. Compose pins it to `/data/app.db` on the `bg-data` volume. |
| `ADMIN_PASSWORD_HASH` | required | Output of `npm run hash-password`. |
| `SESSION_SECRET` | required | At least 32 characters; signs session cookies. |
| `GOOGLE_PLACES_API_KEY` | unset | Enables geocoding, discovery and location refresh. |
| `LLM_PROVIDER` | `none` | `anthropic` or `none`. |
| `LLM_API_KEY` | unset | Anthropic API key. |
| `LLM_EXTRACT_MODEL` | `claude-haiku-5-5` | Model for website extraction. |
| `LLM_DRAFT_MODEL` | `claude-opus-5-5` | Model for protocol drafting. |
| `REFRESH_FAILURE_THRESHOLD` | `3` | Consecutive failed verifications before a location is set to `warn` (positive integer). |
| `RATING_WARN_DELTA` | `0.5` | Rating change that triggers `warn` (0 or more). Smaller changes are recorded only. |
| `PLACES_CALL_CAP` | `200` | Max Places calls per refresh or discovery run (positive integer). |
| `PLACES_MONTHLY_CAP` | `800` | Max Places calls per calendar month across all runs (positive integer). |
| `PROTOCOL_SOURCE_ALLOWLIST` | empty | Comma-separated domains allowed as protocol sources; empty means no restriction. |
| `TZ` | `America/Denver` | Compose only: container timezone. |

## First run

```
docker compose up -d --build
```

1. Open `http://<host>:3000` from any device on the LAN. The family pages need no login.
2. Log in at `http://<host>:3000/admin/login` with your password.
3. Settings: geocode the home address (or enter coordinates), set the default radius, the two cron schedules, and the timezone.
4. Categories: add what you want to anticipate (dentist, urgent care, ER, vet) with search terms and a target count.
5. Discover: run discovery per category, then review the candidates and approve up to the target count.
6. Protocols: create a protocol, add its sources, Generate draft, review it beside the sources, and publish.

The database is created and migrated automatically at boot, and a default settings row is created if none exists. Health check: `GET /health` returns `{"ok":true}` (the container healthcheck uses it).

## Running natively for development

```
npm install
npm run db:seed    # sample categories and locations
npm run dev        # tsx watch, reads .env and .env.local
```

`npm run build` compiles to `dist/`; `npm start` runs the compiled app.

## Tests

```
npm test
```

The suite is offline by design: Places and LLM calls are replayed from recorded fixtures and website fetches use local fakes. A missing fixture fails the test instead of reaching the network.

### Re-recording fixtures

The committed Places fixtures were hand-authored to the API shape (`npx tsx test/fixtures/places/author.ts`). To record against the real API, run with `FIXTURE_MODE=record` and a real key. The tests currently pass `'replay'` explicitly to `recordingFetch(...)`, so for a recording run either drop that argument in the test you want to re-record (so it reads `FIXTURE_MODE`) or use the author scripts. LLM fixtures are regenerated with `npx tsx test/fixtures/llm/author.ts`; the header comments in both author files explain the details. Review the diff before committing recorded files.

## Google Places cost control

Places bills per SKU, and each SKU has a monthly free tier. Requests that include rating fields bill at the Enterprise SKU, whose free tier is roughly 1,000 calls a month. The app helps in three ways, but only the console settings are a hard guarantee:

- `PLACES_CALL_CAP` limits calls in a single refresh or discovery run.
- `PLACES_MONTHLY_CAP` limits calls per calendar month across all runs; the default 800 leaves headroom under the free tier. When either cap is hit the admin page shows a 429 "Places call cap reached" message.
- The admin dashboard shows the current month's call counter.

In the Google Cloud console, also restrict the API key to "Places API (New)" only and set a per-day quota on that API. This protects you if the key leaks or the app misbehaves.

## Security posture

- The app is meant for a trusted LAN over plain HTTP. Do not expose it to the internet.
- Session cookies are HttpOnly, SameSite and signed, but not Secure (that would break plain HTTP). They expire after 12 hours.
- Sessions are stateless signed cookies, so they cannot be revoked individually. Rotating `SESSION_SECRET` logs everyone out.
- Website fetches (extraction and protocol sources) are SSRF-guarded against private and loopback addresses, but DNS rebinding is not fully closed.
- LLM output is validated against a schema and sanitized at render time (markdown is converted to HTML and cleaned before it is shown); nothing is published without admin review.
- Admin POSTs whose `Origin` (or `Referer`) host differs from the request `Host` are rejected with 403.

## Operations

- Schedules run in the home timezone set in Settings, not the container's. Both cron expressions are editable there.
- The admin UI has "Run now" buttons for the location refresh and the protocol re-check.
- Changing the HTML text extractor changes how source text is hashed, so every published protocol is flagged `needs_rereview` once on the next re-check. Re-publishing a protocol clears the flag.
- Backup: stop the app, then copy `app.db`, `app.db-wal` and `app.db-shm` together out of the volume with a one-shot container. A clean stop (SIGTERM, which `docker compose stop` sends) checkpoints the WAL into `app.db`, but copying all three files keeps the backup complete even if the stop was not clean. The volume name is prefixed with the compose project name (usually the directory name), so look it up first:

  ```
  docker volume ls            # find <project>_bg-data
  docker compose stop app
  docker run --rm -v <project>_bg-data:/data -v "$PWD":/backup debian:bookworm-slim sh -c 'mkdir -p /backup/app-db && cp /data/app.db* /backup/app-db/'
  docker compose start app
  ```

- Restore: stop the app, then copy all three files back from a one-shot container (or only `app.db` when the backup has no `-wal` file). The `node` user in the image is uid 1000, so the restored files must be owned by 1000:1000.

  ```
  docker compose stop app
  docker run --rm -v <project>_bg-data:/data -v "$PWD":/backup debian:bookworm-slim sh -c 'rm -f /data/app.db /data/app.db-wal /data/app.db-shm && cp /backup/app-db/app.db* /data/ && chown 1000:1000 /data/app.db*'
  docker compose start app
  ```

- Update: `git pull && docker compose up -d --build`. Migrations run at boot; the volume is preserved.

## Troubleshooting

- 403 from Places: the key is invalid, or its API restriction does not include "Places API (New)". Check the key and that the API is enabled for the project.
- 502 pages in the admin UI: an upstream returned an error. Places errors (including timeouts and network failures, shown as status 0) show the upstream error text. A protocol draft that the LLM provider fails (rate limit, 5xx, auth, network) or that fails validation shows "Draft rejected" with an "LLM provider error" message truncated to 200 characters.
- 429: the Places call cap for the run or the month was reached. Raise `PLACES_CALL_CAP` or `PLACES_MONTHLY_CAP`, or wait for the next month.
- Container restarts immediately: check `docker compose logs app`; a missing or too-short `SESSION_SECRET` or a missing `ADMIN_PASSWORD_HASH` is reported as "Invalid environment".
