# Break Glass: household emergency toolkit

A self-hosted web app for the home LAN that answers one question fast: "Where do we go, and what do we do?" Search "dentist" during an emergency and get a short list of pre-vetted local providers with tap-to-call. An emergency section holds first-aid protocols (SOPs) drafted from authoritative sources and reviewed before anyone sees them. An LLM compiles and refreshes the information, but nothing reaches the family-facing pages without the admin's approval.

**Location lifecycle.** Google Places discovery inserts `candidate` locations the family cannot see. The admin approves or rejects them. Approved locations are visible; a weekly refresh re-fetches details (and the website, if an LLM is configured) and never silently overwrites anything: if a tracked field changed, or the location could not be verified several times in a row, it moves to `warn` and shows a yellow warning with a change summary until the admin re-approves or rejects it.

**Protocol lifecycle.** The admin enters source URLs for a protocol (the LLM never picks its own sources), generates a `draft`, reviews it next to the sources, and publishes it. Exactly one version is `published` at a time and the previous one becomes `superseded`. A monthly re-check re-fetches the sources of each published version; if any changed, the protocol is flagged `needs_rereview` and keeps showing the published text with a warning until a new version is published.

## Quick start

You need Docker with Compose on the server (Docker Compose v2.24 or newer, because `docker-compose.yml` reads an optional `.env`). Nothing else, and no `.env` file.

```
git clone https://github.com/tyler-tee/break-glass.git
cd break-glass
docker compose up -d --build
docker compose logs app
```

1. `docker compose logs app` prints a one-time setup code. Copy it.
2. Open `http://<host>:3000/setup` from a device on your LAN, enter the code, and choose the admin password.
3. The setup wizard at `/admin/setup` takes it from there.

The database is created and migrated automatically at boot. Health check: `GET /health` returns `{"ok":true}` (the container healthcheck uses it). Family pages at `http://<host>:3000` need no login.

### What the wizard covers

1. Household: a name for the household.
2. API keys (optional): Google Places and Anthropic. See below.
3. Home: the home address (geocoded when a Places key is present, otherwise coordinates by hand), default radius and timezone.
4. Categories: what you want to anticipate (dentist, urgent care, ER, vet), from presets or your own, with search terms and a target count.
5. Places: find nearby candidates for each category, then approve the ones you want.
6. A first protocol: add its source URLs and generate a draft, or write it yourself; review and publish.

You can leave the wizard and come back; it stays available until you finish it.

### API keys are optional

- Google Places API (New) key: geocoding, discovery of nearby places, and the weekly location refresh. Without it you enter locations by hand.
- Anthropic API key: reading provider websites during refresh and drafting protocols from your sources. Without it you write protocols by hand.

Add or change either later in Setup, under Services. Keys saved in the app are stored in the SQLite database on the `bg-data` volume.

## Advanced: configure with .env

Every variable is optional. To pre-seed configuration, copy the example file and edit it:

```
cp .env.example .env
```

Anything set in the environment wins over a value saved in the app, and the app shows it as read-only ("Set by the server environment"). For local development you can put overrides in `.env.local`. It is loaded after `.env`, wins over it, and never overrides variables set in the real environment. Both files are git-ignored. Empty values (`PORT=`) count as unset and fall back to the default.

- `ADMIN_PASSWORD_HASH`: claim the install without the setup code. Generate it with `npm run hash-password -- '<password>'` (run `npm install` once first; this can be your laptop). Without Node on the host, build the image and hash inside it: `docker compose run --rm --no-deps app node -e "import('./dist/features/admin/auth.js').then(m=>m.hashPassword(process.argv[1])).then(console.log)" '<password>'` (untested here, since Docker was unavailable when this was written).
- `SESSION_SECRET`: at least 32 characters (`openssl rand -hex 32`). Generated automatically and stored in the database if absent.
- Optionally `GOOGLE_PLACES_API_KEY` and `LLM_API_KEY`. Drafting and extraction turn on whenever an Anthropic key exists (here or saved in the app); `LLM_PROVIDER=none` forces them off.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port (positive integer). Compose pins this to 3000 inside the container. |
| `DATABASE_PATH` | `./data/app.db` | SQLite file. Compose pins it to `/data/app.db` on the `bg-data` volume. |
| `ADMIN_PASSWORD_HASH` | unset | Output of `npm run hash-password`. Optional. |
| `SESSION_SECRET` | generated | At least 32 characters; signs session cookies. Optional. |
| `GOOGLE_PLACES_API_KEY` | unset | Enables geocoding, discovery and location refresh. |
| `LLM_PROVIDER` | auto (on when a key exists) | Unset: on when an Anthropic key is set here or saved in the app. `none`: drafting and extraction stay off even with a saved key. `anthropic`: on, but still needs a key. |
| `LLM_API_KEY` | unset | Anthropic API key. |
| `LLM_EXTRACT_MODEL` | `claude-haiku-5-5` | Model for website extraction. |
| `LLM_DRAFT_MODEL` | `claude-opus-5-5` | Model for protocol drafting. |
| `REFRESH_FAILURE_THRESHOLD` | `3` | Consecutive failed verifications before a location is set to `warn` (positive integer). |
| `RATING_WARN_DELTA` | `0.5` | Rating change that triggers `warn` (0 or more). Smaller changes are recorded only. |
| `PLACES_CALL_CAP` | `200` | Max Places calls per refresh or discovery run (positive integer). |
| `PLACES_MONTHLY_CAP` | `800` | Max Places calls per calendar month across all runs (positive integer). |
| `PROTOCOL_SOURCE_ALLOWLIST` | empty | Comma-separated domains allowed as protocol sources; empty means no restriction. |
| `TZ` | `America/Denver` | Compose only: container timezone. |

### Upgrading an existing install

Secrets already in your `.env` keep working and show as read-only in the app. The setup wizard appears once after the upgrade until you finish it (or skip through it).

## Prerequisites for development

Node 24 and npm, for local development and tests and for generating a password hash on a machine without the app's container.

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
- Sessions are stateless signed cookies, so they cannot be revoked individually. They are signed with a key derived from both the session secret and the current admin password hash, so changing the admin password (or resetting it) signs out every other device, whether or not `SESSION_SECRET` is set in the environment. To sign everyone out without changing the password, set a new `SESSION_SECRET` in the environment and restart.
- Secrets saved in the app (API keys, password hash, session secret) live in the SQLite database on the `bg-data` volume. That is the same trust boundary as a `.env` file on the host: whoever can read the volume can read them.
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
- Container restarts immediately: check `docker compose logs app`; an invalid value in `.env` (for example a `SESSION_SECRET` shorter than 32 characters) is reported as "Invalid environment". With no `.env`, none of the variables are required.
- Forgot the admin password: run `docker compose exec app node dist/cli/reset-admin.js`, open `http://<server>:3000/setup`, then run `docker compose logs app` to find the new setup code. This clears the password stored in the database and signs out all admin sessions. It will not touch `ADMIN_PASSWORD_HASH`; if that is set in the environment, edit it there and restart.
- Setup code locked after 5 wrong tries: wait 15 minutes, or run `docker compose restart app` to get a fresh code from the logs. If someone on the network keeps locking it, set `ADMIN_PASSWORD_HASH` in `.env` to claim the install directly.
