# break-glass: UI reskin and zero-config First Run

Date: 2026-10-27. Status: approved direction (user chose zero-config first run and asked us to proceed without a question round; calls marked **[builder's call]** or **[Claude's call]** were not discussed with the user).

## Intent

break-glass should be something any household can stand up for itself, not just its author. Today a new household must generate a password hash on the command line, hand-edit `.env`, and then work through six unstyled admin pages in an order only the README explains. The family-facing pages work but look like a debugging view, which matters because they are opened on a phone during an emergency.

Two outcomes:

1. **Zero-config first run.** `docker compose up -d` with no `.env`, open the site, and a guided setup takes a non-technical admin from nothing to a working toolkit: claim the install, set a password, optionally add API keys, set home, pick categories, find and approve places, write a first protocol.
2. **A real UI.** Calm, legible, high-contrast family pages built for a stressed person on a phone, and an admin area that reads like a small, tidy app.

## Goals

- A fresh install needs no command-line step beyond `docker compose up -d` and reading one line from `docker compose logs`.
- Every setup step is reachable, resumable and skippable; the admin can leave and come back.
- The app stays fully usable without API keys (manual locations, hand-written protocols).
- Family pages: readable at arm's length, one obvious action per screen, works in light and dark, no JavaScript.
- Existing deployments (secrets in `.env`) keep working unchanged.

## Non-goals

- Multi-user accounts, roles, or per-family-member logins.
- Internet exposure, TLS, or hardening beyond the LAN model the app already assumes.
- Offline/service-worker support, push notifications, native apps.
- Changing the job, discovery, extraction or drafting logic beyond what the wizard needs.
- Internationalization (copy stays US English, miles, 911 default).

## Anti-goals (would make this a failure even if it works)

- A setup flow that a stranger on the LAN can complete before the owner (unauthenticated claim).
- Any page that depends on an external CDN, web font service or analytics. The site must render fully when the internet is down.
- Showing stored API keys or the password hash back in any page or log.
- Color as the only signal for status (open/closed, warn, reported closed).
- Breaking the "no script on family pages" property (`test/protocolVisibility.test.ts:96` enforces it on protocol pages).

## Constraints from the existing code

- Hono + `hono/jsx`, server-rendered, plain POST forms with 302 redirects, flash via query string. Keep that model.
- Every page goes through `page()` in `src/web/Layout.tsx`; CSS is one inline string. There is no static file route and no admin layout; `AdminNav` is rendered inside each admin page body (15 call sites).
- Tests assert on rendered HTML with substrings (visible copy, some exact attribute strings such as `action="/admin/locations/${id}/reapprove"` followed by `name="return_to" value="/admin/warn"`, `Steps</h2>`, `Sources</h2>`, element order via `indexOf`, `<!doctype html>` prefix, no `' mi'` on `/l/:id`, no `<script` on `/emergency/:slug`). No test asserts on class names. Changing classes and layout is free; changing copy, heading levels, attribute order or element order needs a deliberate test update with a reason.
- `requireSameOrigin` guards admin POSTs; new POST routes must sit behind it (the new public `/setup` POSTs too).
- `test/encoding.test.ts`: all source files valid UTF-8.
- Docker image copies only `dist/` and `drizzle/` into the runtime stage; any new static assets must be copied too.
- Publishing a protocol currently requires the LLM (the only way to create a version is the draft route). The wizard must not dead-end without an LLM key.

## Design

### 1. Install states and auth

Three states, derived at request time:

| State | Condition | Behavior |
|---|---|---|
| Unclaimed | No admin password hash in env **and** none stored in the DB | `/setup` is the only admin-ish route. `/admin/*` redirects to `/setup`. Family home shows a short "not set up yet" panel linking to `/setup`. |
| Claimed, setup incomplete | Hash exists; `settings.setup_completed_at` is null | Login works. After login with no explicit `next`, redirect to `/admin/setup` (resume at the first incomplete step). Other admin pages are not blocked; the overview shows a "Continue setup" card. |
| Set up | `setup_completed_at` set | Normal. The wizard stays reachable from the overview ("Run setup again"). |

**Claiming (`/setup`):**
- When the app finds itself unclaimed (at boot, and again if it becomes unclaimed at runtime via the reset CLI), it generates a one-time setup code (about 40 bits, Crockford base32, shown as `XXXX-XXXX`), keeps it in memory only, and prints it to stdout in a block that is easy to spot in `docker compose logs`. A restart issues a new code.
- `/setup` asks for the code, then a new password (minimum 12 characters, confirm field, `autocomplete="new-password"`). On success: store the scrypt hash in the DB, discard the code, create a session, redirect to `/admin/setup`.
- Code comparison is constant-time. Failed attempts are rate limited in memory **[builder's call on exact policy; must make brute force impractical, e.g. 5 failures per minute globally with a lockout that only a restart or time clears]**.
- `/setup` returns 404 (or redirects to `/admin/login`) once claimed.

**Secrets storage:**
- New single-row (or key/value) table for app secrets: admin password hash, session secret, Google Places key, Anthropic key. **[builder's call on shape]**
- Session secret: if `SESSION_SECRET` is not in env, generate 32 random bytes on first boot and persist it.
- Precedence everywhere: environment variable wins over DB value. The UI shows "Set by the server environment" (read-only) for any env-provided value.
- `ADMIN_PASSWORD_HASH` and `SESSION_SECRET` become optional in `src/env.ts`. `docker-compose.yml` makes `.env` optional (`env_file` with `required: false`).
- Keys are never echoed: inputs are `type="password"`, saved keys display as "Saved (ends in …1a2b)". Leaving a key field blank on save keeps the existing value; an explicit "Remove" clears it.
- Storing secrets in the SQLite volume has the same trust boundary as `.env` on the host; the README says so.

**Runtime key changes:** today `places`, `llm` and `extract` deps are built once at boot from env. They must become resolvable at request time (or rebuilt when keys change) so a key saved in the wizard takes effect without a restart. Jobs and the scheduler must see the same current deps. **[builder's call on mechanism]**

**Account maintenance:**
- Settings gets a "Change password" form (current password + new + confirm). Disabled with an explanation when the hash comes from env.
- A reset CLI shipped in the image clears the DB-stored password hash so the install returns to Unclaimed and prints a fresh code: `docker compose exec app node dist/cli/reset-admin.js` (exact path builder's call; README documents it). It does not touch env-provided hashes and says so.

### 2. First Run wizard (`/admin/setup`)

A linear, resumable flow with a step indicator ("Step 3 of 7"), Back, Skip for now, and Save & continue on every step. Each step's done-state is derived from data, not stored, except the final `setup_completed_at`. "Finish later" goes to the overview.

1. **Welcome / household.** Household name (shown in the family header, default "Our household") and emergency number (default `911`). New settings columns.
2. **Services (optional).** Google Places key and Anthropic key, each with one sentence on what it unlocks (Places: find nearby places, look up addresses, weekly re-checks; Anthropic: read clinic websites, draft protocols from sources), rough cost, and a link to where to get the key. A "Test" action per key makes the cheapest possible call and reports success or the error in plain words **[builder's call on the exact probe; must not burn the monthly Places cap noticeably]**. Skippable.
3. **Home.** Address lookup (if Places) or manual latitude/longitude with a short "how to find these" hint; search radius; time zone (prefilled from `TZ`/current setting, `<input list>` over `Intl.supportedValuesOf('timeZone')`). The two cron schedules move under an "Advanced" `<details>`, described in plain words ("Re-check places weekly, Sunday 3:00 am").
4. **Categories.** Starter presets as checkboxes, each with sensible search terms and target count: Urgent care, Emergency room, 24-hour pharmacy, Dentist (emergency), Emergency vet, Pediatrician **[Claude's call on the list; builder may tune search terms]**. Plus "Add your own". Already-created categories show as checked/existing.
5. **Find places.** Per category: "Find places" (Places discovery, as today) and inline approve/reject of the resulting candidates, or "Add a place by hand" (existing manual form, which creates a candidate; the wizard then lets them approve it in place). Shows "N approved of target M" per category. Without a Places key, only manual entry is offered, with a note on what the key would add.
6. **First protocol.** Create a protocol (title + tags). Two paths: "Draft from sources" (existing LLM draft route; disabled with explanation without a key) or **"Write it yourself"**: a new manual path that creates a draft version prefilled with the four required SOP headings (`## Title and scope`, `## Steps`, `## Escalation criteria`, `## Do not`), validated by the existing `assertSopHeadings`, then the existing review/publish screen. The manual path is also added to the normal protocol admin pages, closing the no-LLM dead end. Skippable.
7. **Done.** Checklist summary, link to the family site, a short "add it to your family's phones" tip (Add to Home Screen), then set `setup_completed_at`.

Wizard redirects: wizard POSTs redirect back into the wizard (not to the classic admin pages); classic admin routes keep their current redirect targets so existing tests hold. Reuse the existing repos/services; the wizard is a new route module that calls them.

### 3. Visual system

**Principles:** calm, clinical-but-warm, high contrast, one primary action per screen, big targets. Not neumorphism, not glass, no gradients-for-decoration.

**Tokens** on `:root`, redefined under `@media (prefers-color-scheme: dark)`. No theme toggle (would need JS on family pages). **[Claude's call on exact values; builder verifies contrast ≥4.5:1 for text, ≥3:1 for UI glyphs in both modes]**
- Ink/surface neutrals: cool slate (light: near-white surface, slate-900 text; dark: slate-950 surface, slate-100 text).
- Primary: deep teal (`#0F5F6E`-ish light, lighter tint in dark) for links, primary buttons, focus ring.
- Emergency red, reserved for the emergency-number button and "Reported closed".
- Go green for Call / Open now. Amber for warnings, always paired with an icon and text.

**Type:** Atkinson Hyperlegible Next (OFL, designed for low-vision legibility), self-hosted woff2 with `font-display: swap`, falling back to `system-ui`. Base 18px family / 16px admin, line-height 1.5, scale 14/16/18/22/28/36. Tabular figures for distances and times. **[Claude's call; if a variable woff2 isn't available under a permissive license from npm/fontsource, the builder may use the static 400/700 files or fall back to system-ui]**

**Icons:** a small `Icon` component with inline SVG paths from Lucide (ISC), `aria-hidden` with visible text labels. Replace emoji glyphs used as icons (e.g. `⚠` in `WarningBadge`).

**Static assets:** add a `/assets/*` route serving the stylesheet, font files, favicon (SVG), web app manifest and icon, with long-lived cache headers and a content hash or version query for cache-busting. The stylesheet moves out of the inline string into a real `.css` file. The Dockerfile copies the assets into the runtime image. An apple-touch-icon PNG if one can be produced without new runtime dependencies **[builder's call]**.

**Layouts:**
- `FamilyLayout`: slim header with the household name and a Home link; content max-width ~640px; 16px gutters; no nav clutter.
- `AdminLayout`: top bar (app name, "View family site", Log out) and primary nav (Overview, Setup while incomplete, Settings, Categories, Places, Review queue, Warnings, Protocols). Sidebar at ≥1024px; on small screens a `<details>` disclosure menu (no JS). Active item marked with `aria-current="page"`. Content max-width ~1100px. `AdminNav` calls inside page bodies are removed in favor of the layout; `page()` grows a layout option.
- Wide tables become stacked cards under ~640px via CSS.
- Global error and 404 pages get the layout (add `notFound`/`onError` handlers) instead of plain text.

**Family pages:**
- Home: emergency-number button (big, red, `tel:`), then "What to do" (protocols), then search, then categories as a two-column tile grid with icons and counts.
- Location card: name, status pill with icon + text ("Open now", "Closed", "Hours unknown", "Reported closed"), distance, side-by-side Call and Directions buttons, hours and notes in a native `<details>`.
- Protocol page: large numbered steps; the four SOP sections rendered as distinct callouts (Escalation in amber-bordered box, Do not in red-bordered box) by splitting the markdown at the known headings server-side before rendering, still through `renderMarkdown`'s sanitizer; headings stay `h2`.
- Unclaimed install: a friendly panel explaining the toolkit isn't set up and linking to `/setup`.

**Admin JS:** allowed only on admin pages as a single small external `/assets/admin.js` (progressive enhancement: disable submit buttons and show "Working…" on long POSTs such as discovery and drafting). Everything must still work with JS off. No inline scripts or `on*` attributes anywhere.

**Accessibility baseline:** skip link, visible focus ring (2-3px, ring token), labels on every input, errors next to fields with `role="alert"` and focus on the first invalid field when re-rendering, 44px minimum targets (56px for family primary buttons), `prefers-reduced-motion` honored, zoom never disabled.

### 4. Overview (`/admin`)

Replaces the bare dashboard: setup checklist card while incomplete; counts (approved places, candidates awaiting review, warnings, published protocols, protocols needing re-review) each linking to its page; the existing job buttons and Places usage line (keep the tested copy "Places calls this month: X / Y" and "nearing the monthly cap").

## Testing expectations

- All existing tests keep passing. A test may be edited only to follow an intentional copy or markup change, with the reason in the commit message; never to weaken an assertion's intent (the `<script` and escaping negatives stay).
- New tests: install-state detection and env-over-DB precedence; `/setup` requires the code, rejects wrong codes, rate limits, refuses once claimed; password change; reset CLI returns to Unclaimed; session secret auto-generation persists across app instances on the same DB; keys saved in the wizard take effect without restart; wizard step done-states and redirects; manual protocol draft path including SOP heading validation; family pages render with no `<script`; assets route serves CSS/font with cache headers; 404 page uses the layout.
- Manual check at 375px and 1280px in light and dark before calling the reskin done (Playwright screenshots are fine).

## Left to the builder

Exact token values, spacing scale, component markup, secrets table shape, rate-limit policy, runtime-deps mechanism, preset search terms, key-test probes, asset hashing scheme, file layout for new modules. Anything that would change what the user sees in a way not described here should be flagged rather than decided silently.
