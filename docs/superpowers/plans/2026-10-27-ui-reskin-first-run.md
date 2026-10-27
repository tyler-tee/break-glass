# UI Reskin and Zero-Config First Run Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give break-glass a calm, high-contrast, no-JS-on-family UI and a guided, resumable first-run that takes a household from `docker compose up -d` (no `.env`) to a working toolkit.

**Architecture:** Keep the existing Hono + hono/jsx server-rendered, plain-POST-with-302 model. Add a `/assets/*` route serving real files from a top-level `public/` dir (CSS, self-hosted font, favicon, manifest, `admin.js`), three shared layouts behind an extended `page()`, a DB-backed secrets store with env-wins precedence that makes `ADMIN_PASSWORD_HASH`/`SESSION_SECRET` optional, a request-time services resolver so keys take effect without restart, a public `/setup` claim flow, and a resumable `/admin/setup` wizard that reuses existing repos/services.

**Tech Stack:** TypeScript ESM, Hono 4, hono/jsx, drizzle-orm + better-sqlite3, zod, vitest. No new runtime dependency. Font (Atkinson Hyperlegible Next) and Lucide icon paths are vendored into `public/`.

**Spec:** `docs/superpowers/specs/2026-10-27-ui-reskin-first-run-design.md`

## Global Constraints

- Keep server-rendered HTML, plain POST forms, 302 redirects, flash via query string. No client framework.
- No external CDN, web-font service, or analytics anywhere; the site must render fully offline.
- Never echo stored API keys or the password hash to any page or log. Key inputs are `type="password"`; saved keys display only as `Saved (ends in …<last4>)`.
- No `<script>` tags or `on*` attributes on family pages. The only script anywhere is one external `/assets/admin.js`, referenced solely by AdminLayout. Everything works with JS off.
- All source files under `src/`, `test/`, `scripts/` stay valid UTF-8 (`test/encoding.test.ts`). Binary assets live in top-level `public/` (not scanned, not under tsc `rootDir`).
- New POST routes (including public `/setup`) sit behind `requireSameOrigin`.
- Existing tests keep passing. A test may be edited only to follow an intentional copy/markup change, with the reason in the commit message; the `<script`/escaping negatives never weaken.
- Do not change heading levels, visible copy pinned by tests, attribute order, or element order without an explicit test update. Specifically keep: `Steps</h2>`, `Sources</h2>`, at least one `<h2` on `/emergency/:slug`; no ` mi` on `/l/:id` when distance is null; `<!doctype html>` prefix (case-insensitive); `action="/admin/locations/${id}/reapprove"` immediately followed by `name="return_to" value="/admin/warn"`; redirect `Location` headers `/admin/settings?saved=1`, `/admin/candidates?category=...`, `/admin/login?next=%2Fadmin`, `/admin?job=...&result=done`; `Places calls this month: X / Y` and `nearing the monthly cap`.
- Accessibility baseline on every page: skip link, visible focus ring (2-3px), label on every input, errors beside the field with `role="alert"`, 44px min targets (56px family primary buttons), `prefers-reduced-motion` honored, zoom not disabled.
- Copy stays US English, miles, `911` default. Contrast >=4.5:1 text / >=3:1 UI glyphs in both color schemes.

## Review Focus

- **Setup-code lockout recovery:** after the rate limiter trips, a legitimate owner entering the correct code once the window/lockout elapses must be able to claim. Pinned by a test in Task 6.
- **Env-provided secret with a DB value also present:** env must win and the field must render read-only ("Set by the server environment"); a wizard/settings save must not overwrite or clear it. Pinned in Task 2.
- **Blank key field on save:** leaving a key field empty keeps the existing value; only an explicit "Remove" clears it. Pinned in Task 2/8.
- **Manual protocol body edited to break SOP headings:** `assertSopHeadings` rejects with a 400 field error, never a 500. Pinned in Task 10.
- **Unknown or traversal `/assets` path (`../`, missing file):** returns 404 via the layout, never serves outside `public/`. Pinned in Task 1.

---

### Task 1: Static assets pipeline, tokens, icons, font

**Files:**
- Create: `public/styles.css`, `public/admin.js`, `public/favicon.svg`, `public/icon.svg`, `public/manifest.webmanifest`, `public/fonts/atkinson-hyperlegible-next.woff2`
- Create: `src/web/assets.ts`, `src/web/components/Icon.tsx`
- Modify: `src/app.ts` (register the assets route)
- Test: `test/assets.test.ts`

**Interfaces:**
- Produces: `registerAssets(app: Hono): void` mounts `GET /assets/:file`; serves only names in a fixed allowlist map (`styles.css`->`text/css`, `admin.js`->`text/javascript`, `favicon.svg`/`icon.svg`->`image/svg+xml`, `manifest.webmanifest`->`application/manifest+json`, the `.woff2`->`font/woff2`) with `Cache-Control: public, max-age=31536000, immutable`; anything else -> `c.notFound()`. Files are read from `public/` resolved via `fileURLToPath(new URL('../../public', import.meta.url))` (same two-levels-up trick as `src/db/migrate.ts`) and held in memory with a per-file 8-hex sha256.
- Produces: `assetUrl(name: string): string` -> `/assets/<name>?v=<hash>`.
- Produces: `Icon: FC<{ name: IconName; label?: string }>` renders inline `<svg aria-hidden="true" focusable="false">` with a vendored Lucide path per name. `IconName` covers at least: phone, map-pin, clock, alert-triangle, x-octagon, check, menu, search, chevron-right. With `label`, adds a visually-hidden `<span>`.
- Produces: `public/styles.css` defines tokens on `:root` and under `@media (prefers-color-scheme: dark)`. Token names (values are the decision; builder verifies contrast): `--surface` (light `#f8fafc` / dark `#020617`), `--surface-2` (`#ffffff`/`#0f172a`), `--ink` (`#0f172a`/`#e2e8f0`), `--muted` (`#475569`/`#94a3b8`), `--border` (`#cbd5e1`/`#334155`), `--primary` (`#0f5f6e`/`#5eead4`), `--primary-ink` (`#ffffff`/`#042f2e`), `--focus` (= primary), `--danger` (`#b00020`/`#ff6b6b`), `--go` (`#1b7f3b`/`#4ade80`), `--warn-bg` (`#fde68a`/`#78350f`), `--warn-ink` (`#78350f`/`#fde68a`). An `@font-face` for Atkinson Hyperlegible Next with the vendored woff2 and `font-display: swap`; family stack falls back to `system-ui`. Family base 18px, admin 16px, line-height 1.5, scale 14/16/18/22/28/36, tabular figures for distances/times. Honor `prefers-reduced-motion`.

Decisions (spec builder/Claude calls): assets read into memory at boot and served by an explicit allowlist map (no serveStatic, no path-traversal surface); cache-busting via `?v=<sha256-8>` with `immutable`; the font is vendored as a single variable woff2 committed to `public/fonts/` (obtain once from npm `@fontsource-variable/atkinson-hyperlegible-next`, latin subset; no runtime dep, no build step); Lucide path `d` strings vendored into `Icon.tsx`; no apple-touch PNG (SVG mask icon only).

- [ ] **Step 1: Write failing tests** `test/assets.test.ts`:
  - `serves styles.css with long-lived immutable cache header`: GET `/assets/styles.css` -> 200, content-type contains `text/css`, cache-control contains `max-age=31536000` and `immutable`, body contains `--primary`.
  - `serves the woff2 font`: GET `/assets/atkinson-hyperlegible-next.woff2` -> 200, content-type `font/woff2`.
  - `unknown and traversal paths 404`: GET `/assets/nope.css` and `/assets/..%2f..%2fpackage.json` -> 404.
- [ ] **Step 2: Run** `npx vitest run test/assets.test.ts` — FAIL (route missing).
- [ ] **Step 3:** Create the six `public/` files, `src/web/assets.ts`, `src/web/components/Icon.tsx`; call `registerAssets(app)` in `createApp` before the family route so it is reachable without auth.
- [ ] **Step 4: Run** the test — PASS.
- [ ] **Step 5: Commit** `feat(assets): static assets route, tokens stylesheet, icons, self-hosted font`.

---

### Task 2: Secrets store, install states, optional env secrets, session autogen, runtime services, new settings columns

**Files:**
- Modify: `src/db/schema.ts` (new `app_secrets` table; add `settings.householdName`, `settings.emergencyNumber`, `settings.setupCompletedAt`), then `npm run db:generate`
- Create: `src/features/admin/secrets.ts`, `src/features/admin/install.ts`, `src/services/resolver.ts`
- Modify: `src/env.ts` (make `ADMIN_PASSWORD_HASH`/`SESSION_SECRET` optional), `src/app.ts` (`AppDeps`; build store + resolver when not supplied), `src/features/admin/routes.tsx` (auth from store), `src/features/admin/settingsRoutes.tsx`, `src/features/categories/routes.tsx`, `src/features/protocols/adminRoutes.tsx` (read services via resolver), `src/index.ts` (pass store; resolve inside job closures)
- Test: `test/secrets.test.ts`, `test/install.test.ts`, edit `test/env.test.ts`

**Interfaces:**
- Produces: table `app_secrets { key text primary key, value text not null, updatedAt integer(ms) not null }`. Keys: `admin_password_hash`, `session_secret`, `google_places_api_key`, `anthropic_api_key`. (Decision: key/value shape — additive; remove = delete row.)
- Produces: `createSecretsStore(db: Db, env: Env): SecretsStore` with `getAdminHash(): string | undefined`, `setAdminHash(hash): void`, `clearAdminHash(): void`, `getSessionSecret(): string` (read-or-generate-and-persist 32 random bytes hex), `getPlacesKey(): string | undefined`, `setPlacesKey(v): void`, `removePlacesKey(): void`, `getAnthropicKey(): string | undefined`, `setAnthropicKey(v): void`, `removeAnthropicKey(): void`, and `isEnvProvided(logical: adminHash|sessionSecret|placesKey|anthropicKey): boolean`.
  Precedence: a getter returns the env value when the mapped env var is set and non-empty (`ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `GOOGLE_PLACES_API_KEY`, `LLM_API_KEY`), else the DB value. The `set*`/`remove*`/`clear*` methods throw if the value is env-provided (callers disable the UI first; this is the backstop).
- Produces: `type InstallState = unclaimed | incomplete | ready` and `installState(deps): InstallState`: `unclaimed` when `getAdminHash()` is undefined; else `incomplete` when `settings.setupCompletedAt` is null; else `ready`.
- Produces: `type PlacesDep = { fetch: typeof fetch; apiKey: string }`; `type ServiceResolver = { places(): PlacesDep | undefined; llm(): LlmProvider | undefined; extract(): Extractor | undefined }`; `makeServiceResolver(db, env, secrets): ServiceResolver` memoizes instances keyed by the current effective key strings and rebuilds when a key changes, so a key saved in the wizard takes effect on the next request/job with no restart. `extract()` is built from `llm()` + `env.LLM_EXTRACT_MODEL`.
- Produces: accessor helpers in `src/services/resolver.ts` used by handlers/jobs: `placesOf(deps)`, `llmOf(deps)`, `extractOf(deps)` return `deps.resolve?.<x>() ?? deps.<x>` so existing tests that pass static `places`/`llm`/`extract` keep working.
- Modifies: `AppDeps` gains `secrets?: SecretsStore` and `resolve?: ServiceResolver`; `createApp` sets `deps.secrets ??= createSecretsStore(db, env)` and `deps.resolve ??= makeServiceResolver(db, env, deps.secrets)` once, before mounting sub-routers, and passes the enriched `deps` down. Auth reads `const sessionSecret = deps.secrets.getSessionSecret()` and `verifyPassword(pw, deps.secrets.getAdminHash() ?? empty)`.

Decision (session secret is read per request): auth middleware and `createSession` call `deps.secrets.getSessionSecret()` on every request (one indexed SQLite read; no process-level cache), so a rotation by the reset CLI (a separate process) or a password change takes effect immediately. `SecretsStore` also gets `rotateSessionSecret(): void` (writes a fresh 32-byte hex value; throws when env-provided).

Decision (when the LLM is on): `LLM_PROVIDER` loses its zod default (`z.enum(['anthropic','none']).optional()`). Effective provider = `env.LLM_PROVIDER ?? (secrets.getAnthropicKey() ? 'anthropic' : 'none')`, so a key saved in the wizard turns drafting/extraction on, while an explicit `LLM_PROVIDER=none` in env still disables it. `src/index.ts` and the resolver both use this rule; existing tests that build static `llm`/`extract` deps are unaffected.

Decision: `env.ts` — `ADMIN_PASSWORD_HASH: z.string().min(1).optional()`, `SESSION_SECRET: z.string().min(32).optional()`. Empty-string cleaning already turns `KEY=` into unset. `test/env.test.ts` line 7-8 (rejects missing SESSION_SECRET) is replaced by `allows missing admin hash and session secret` (both parse to undefined); the commit message states this follows the spec making them optional for zero-config.

- [ ] **Step 1: Write failing tests:**
  - `test/secrets.test.ts` `env wins over DB`: store with `GOOGLE_PLACES_API_KEY` env set and a different DB `google_places_api_key` -> `getPlacesKey()` returns the env value and `isEnvProvided(placesKey)` is true.
  - `blank save keeps existing, remove clears`: `setPlacesKey(k)`, then a save with a blank field is a no-op (value still k); `removePlacesKey()` then `getPlacesKey()` undefined. (Store-level; the handler is pinned in Task 8.)
  - `session secret autogenerates and persists across instances on the same DB`: no `SESSION_SECRET` env; `createSecretsStore(db,env).getSessionSecret()` equals a second fresh store value on the same `db`, length >= 32.
  - `cannot overwrite an env-provided secret`: with env hash set, `setAdminHash(...)`/`clearAdminHash()` throw.
  - `rotated session secret invalidates old cookies`: log in, `rotateSessionSecret()`, the old cookie on GET `/admin` -> 302 to login.
  - `wizard-saved Anthropic key enables the LLM`: no `LLM_PROVIDER`/`LLM_API_KEY` env, `setAnthropicKey('k')` -> `resolver.llm()` defined; with env `LLM_PROVIDER=none` -> undefined.
  - `test/install.test.ts`: fresh DB + no env hash -> unclaimed; after `setAdminHash` -> incomplete; after setting `setupCompletedAt` -> ready.
- [ ] **Step 2: Run** `npx vitest run test/secrets.test.ts test/install.test.ts test/env.test.ts` — FAIL.
- [ ] **Step 3:** Add columns + table, generate migration, implement store/install/resolver, make env optional, rewire auth + service call sites + the `index.ts` job closures.
- [ ] **Step 4: Run** full suite — PASS (all prior `createApp({db,env})` tests still log in because the store returns the env secret).
- [ ] **Step 5: Commit** `feat(secrets): DB secret store, optional env, install states, runtime service resolver`.

---

### Task 3: Layout system (page() chrome option, FamilyLayout/AdminLayout/AuthLayout, 404/error)

**Files:**
- Modify: `src/web/Layout.tsx` (extend `page()`, drop the inline CSS string, add layouts, link the stylesheet + head tags)
- Modify (remove `<AdminNav/>` from bodies, pass `chrome`): `src/features/admin/routes.tsx`, `src/features/admin/settingsRoutes.tsx`, `src/features/categories/routes.tsx`, `src/features/locations/adminRoutes.tsx`, `src/features/protocols/adminRoutes.tsx`, `src/web/placesErrorPage.tsx`
- Modify: `src/app.ts` (`app.notFound(...)`, `app.onError(...)`)
- Delete: `src/web/components/AdminNav.tsx` (nav moves into AdminLayout)
- Test: `test/layout.test.ts`

**Interfaces:**
- Produces: `type LayoutKind = family | admin | auth` and `type PageChrome = { layout?: LayoutKind; household?: string; emergencyNumber?: string; activeNav?: AdminNavKey }`.
- Produces: extended signature `page(c: Context, title: string, body: Child, status?: 200|400|401|404|409|429|502|503, chrome?: PageChrome)` — `status` keeps its 4th-positional slot and default `200`; `chrome` defaults to `{ layout: family }`. Every existing `page(c,t,b)` and `page(c,t,b,status)` call compiles unchanged.
- Produces: `AdminNavKey = overview | setup | settings | categories | places | review | warnings | protocols`. AdminLayout renders the top bar (app name, View family site -> `/`, Log out POST -> `/admin/logout`) and primary nav; sidebar at >=1024px, a `<details>` disclosure menu below; the item matching `activeNav` gets `aria-current=page`. The Setup item appears only while install state is `incomplete`. FamilyLayout renders a slim header: household name (default: Our household) and a Home link; content max-width ~640px. AuthLayout: minimal header, no nav. All layouts include a head block: charset, viewport (zoom enabled), title, `<link rel=stylesheet href={assetUrl(styles.css)}>`, favicon/manifest links, and a skip link as the first body element. AdminLayout additionally emits one `<script src={assetUrl(admin.js)} defer>` tag.

Decision: Admin page bodies no longer render `<AdminNav/>`; they pass `{ layout: admin, activeNav }`. Login passes `{ layout: auth }`. `placesErrorPage`/`budgetExhaustedPage` pass `{ layout: admin }`. `notFound` and `onError` render through `page()` with the layout (family by default; admin when `c.req.path` starts with `/admin`).

- [ ] **Step 1: Write failing tests** `test/layout.test.ts`:
  - `404 uses the layout, not plain text`: GET `/no-such-page` -> 404, body contains the doctype prefix (case-insensitive) and `/assets/styles.css`.
  - `admin page carries one admin.js script tag`: logged-in GET `/admin` -> body contains the admin.js path and exactly one `<script`.
  - `family page has no script tag`: GET `/` -> body does not contain `<script`.
- [ ] **Step 2: Run** `npx vitest run test/layout.test.ts` — FAIL.
- [ ] **Step 3:** Extend `page()`; add the three layouts; remove all `<AdminNav/>` usages and the component file; pass `chrome`; add `notFound`/`onError`.
- [ ] **Step 4: Run** `npx vitest run` (full suite) — PASS. Update any pre-existing test that asserted old inline-nav markup, with the reason noted; none assert class names.
- [ ] **Step 5: Commit** `feat(web): shared layouts, page() layout option, styled 404/500, drop per-page AdminNav`.

---

### Task 4: Family pages reskin

**Files:**
- Modify: `src/features/family/routes.tsx` (home grid, protocol-page callouts, unclaimed panel, pass household/emergencyNumber to `page()`)
- Modify: `src/web/components/LocationCard.tsx`, `src/web/components/WarningBadge.tsx` (status pills with Icon + text; replace the warning glyph)
- Create: `src/web/protocolSections.ts` (`splitSopSections`)
- Test: add to `test/family.test.ts` and `test/protocolVisibility.test.ts`

**Interfaces:**
- Produces: `splitSopSections(bodyMd: string): { heading: string; md: string }[]` — splits the markdown on the four known `## ` SOP headings server-side, keeping each heading line inside its chunk; any content before the first heading is a leading chunk. Each chunk is rendered through the existing `renderMarkdown` (so the sanitizer still runs and headings stay `h2`). The family protocol page wraps the Escalation criteria chunk in an amber-bordered callout and Do not in a red-bordered callout; Steps renders as large numbered steps. Unknown/missing sections render normally (no content dropped).
- Consumes: `renderMarkdown` (`src/web/format.ts`), `telHref`/`mapsHref`/`formatMiles` (unchanged), `Icon` (Task 1).

Decision: status pill text stays exactly `Open now`, `Closed`, `Hours unknown`, `Reported closed` (color plus Icon plus text, never color alone). Home order: emergency-number button (big red `tel:` using emergencyNumber), then What to do (protocols), then search, then categories as a two-column tile grid with icons and counts. Keep `formatMiles` returning null when distance is null so `/l/:id` never contains the mile suffix for a no-coords card.

- [ ] **Step 1: Write failing tests** (add to the family suites):
  - `escalation and do-not render as callouts`: publish a protocol whose body has all four SOP sections; `/emergency/:slug` body contains `Escalation criteria</h2>` and `Do not</h2>` and still contains `Steps</h2>` and `Sources</h2>`.
  - Keep the existing `script tags stripped from body` test green (every chunk routes through `renderMarkdown`).
- [ ] **Step 2: Run** the family suites — the new assertion FAILs.
- [ ] **Step 3:** Implement `splitSopSections`, reskin home/card/badge, wire household + emergency number.
- [ ] **Step 4: Run** `npx vitest run test/family.test.ts test/protocolVisibility.test.ts` — PASS (including the mile and script/onerror/iframe/javascript negatives).
- [ ] **Step 5: Commit** `feat(family): reskinned home, location cards, protocol callouts`.

---

### Task 5: Admin overview and admin pages reskin

**Files:**
- Modify: `src/features/admin/routes.tsx` (overview = setup checklist card while incomplete + linked counts + existing job buttons + Places usage line)
- Modify: `src/features/admin/settingsRoutes.tsx`, `src/features/categories/routes.tsx`, `src/features/locations/adminRoutes.tsx`, `src/features/protocols/adminRoutes.tsx` (markup polish; wide tables become stacked cards under ~640px via CSS classes only)
- Test: `test/admin/dashboard.test.ts` (keep passing; add one assertion)

**Interfaces:**
- Consumes: counts from `listCategories`, `listLocations`, `listProtocols`, `getPublished`; `newPlacesBudget(...).monthUsed()`; `installState(deps)` (Task 2).
- Produces: overview counts (approved places, candidates awaiting review, warnings, published protocols, protocols needing re-review), each an `<a>` to its page.

Decision: responsive stacked tables are pure CSS (add a class on the existing `<table>` elements; no markup/order change) so indexOf-order and attribute-sequence assertions hold. Keep verbatim: `Places calls this month: {monthUsed} / {monthlyCap}` and the `nearing the monthly cap` alert, the `role=status` job line, and both job forms posting to `/admin/jobs/.../run`.

- [ ] **Step 1:** Keep `test/admin/dashboard.test.ts` pinning the two copy strings; add `overview shows linked counts`: seed one approved location and one published protocol, GET `/admin` contains `href="/admin/locations"` and `href="/admin/protocols"`.
- [ ] **Step 2: Run** — the new assertion FAILs.
- [ ] **Step 3:** Implement overview + table classes.
- [ ] **Step 4: Run** `npx vitest run test/admin test/locations test/protocols test/categories` — PASS.
- [ ] **Step 5: Commit** `feat(admin): overview with checklist and counts; responsive admin tables`.

---

### Task 6: Public /setup claim — setup code, rate limit, unclaimed guards, resume-after-login

**Files:**
- Create: `src/features/admin/setupCode.ts` (code generator + in-memory state + limiter), `src/features/admin/setupClaim.tsx` (`/setup` routes)
- Modify: `src/app.ts` (mount `setupClaimRoutes` at `/setup`, public, with `requireSameOrigin` on POST), `src/index.ts` (print the code at boot when unclaimed), `src/features/admin/routes.tsx` (unclaimed guard + resume-after-login), `src/features/family/routes.tsx` (unclaimed home panel)
- Test: `test/setup/claim.test.ts`

**Interfaces:**
- Produces: `createSetupCodeManager(opts: { now: () => Date; log?: Logger }): { current(): string | null; ensure(): string; consume(submitted: string): ok | wrong | locked; reset(): void }`.
  - `ensure()` returns the active code, generating and printing one (a clearly delimited stdout block) when none exists; `current()` is read-only.
  - Code = 40 bits from `randomBytes(5)` encoded in Crockford base32 (alphabet 0-9 A-Z minus I L O U), displayed as XXXX-XXXX.
  - `consume` compares constant-time (via `timingSafeEqual` on equal-length buffers) after upper-casing and stripping dashes/space; on success it clears the code (one-time). Rate limit (decision, spec builder call): in-memory global fixed window — max 5 failures per 60s; the 6th within the window returns locked for a 15-minute lockout that clears on time or process restart; a successful claim clears the counters.
- Produces: `setupClaimRoutes(deps): Hono` mounting GET `/setup` (claim form: setup code + new password `minlength=12` + confirm, `autocomplete=new-password`) and POST `/setup`. On success: `deps.secrets.setAdminHash(await hashPassword(pw))`, consume the code, `createSession`, redirect `/admin/setup`. Returns 404 once `installState(deps) !== unclaimed`.
- Modifies: admin routes — a guard at the top of `adminRoutes`: when `installState(deps) === unclaimed`, redirect any `/admin/*` (including `/admin/login`) to `/setup` 302. Login POST success with no explicit `/admin*` next and `installState === incomplete` redirects to `/admin/setup`.
- Modifies: family home — when unclaimed, render a short not-set-up-yet panel linking to `/setup` instead of the normal home.

- [ ] **Step 1: Write failing tests** `test/setup/claim.test.ts` (inject now):
  - `requires the code`: POST `/setup` with wrong code + valid password -> re-render with `role=alert`, no hash stored, still unclaimed.
  - `claims with the right code`: GET `/setup` (triggers ensure), read the code via the manager, POST correct code + 12-char password -> 302 `/admin/setup`, `getAdminHash()` now set, a second GET `/setup` -> 404.
  - `rate limits then recovers`: 6 wrong attempts -> the 6th returns locked (429); advancing now past the lockout then a correct code succeeds. (Review Focus: lockout recovery.)
  - `password too short rejected`: 11-char password -> re-render, not claimed.
  - `/admin redirects to /setup while unclaimed`: GET `/admin` -> 302 `/setup`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement the manager, claim routes, guards, boot print, family panel.
- [ ] **Step 4: Run** `npx vitest run test/setup test/admin test/family.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(setup): unauthenticated-safe /setup claim with one-time code and rate limit`.

---

### Task 7: Account maintenance — change password form and reset CLI

**Files:**
- Modify: `src/features/admin/settingsRoutes.tsx` (Change-password form + POST; disabled with an explanation when the hash is env-provided)
- Create: `src/cli/reset-admin.ts` (compiles to `dist/cli/reset-admin.js`)
- Test: `test/admin/changePassword.test.ts`, `test/cli/resetAdmin.test.ts`

**Interfaces:**
- Produces: POST `/admin/settings/password` (behind `requireSameOrigin` + `requireAdmin`): fields current/new/confirm; verifies current via `verifyPassword(current, secrets.getAdminHash())`, requires new == confirm and length >= 12, then `secrets.setAdminHash(await hashPassword(new))`, `secrets.rotateSessionSecret()` when the session secret is not env-provided (signs out every other device), issues a fresh session cookie for the current browser, and redirects `/admin/settings?saved=1`. `resetAdmin` likewise rotates the DB session secret (unless env-provided) so sessions from before the reset die. When `secrets.isEnvProvided(adminHash)`, render the form disabled with Set by the server environment and reject the POST with a 400 explanation.
- Produces: `resetAdmin(db: Db, env: Env, log?: Logger): reset | env-managed` in `src/cli/reset-admin.ts`; the module entry clears the DB admin hash via `createSecretsStore(db, env).clearAdminHash()` unless env-provided (then it prints that it will not touch an env-provided hash and exits), opening the DB from `DATABASE_PATH`. After reset the install is unclaimed; the running server regenerates and prints a fresh code lazily on the next `/setup` (or `/admin` redirect) hit. README documents `docker compose exec app node dist/cli/reset-admin.js`.

- [ ] **Step 1: Write failing tests:**
  - `changePassword.test.ts` `changes with correct current`: login, POST current+new(12+)+confirm -> 302 `/admin/settings?saved=1`; the new password now logs in, the old fails.
  - `rejects wrong current / mismatch / short`: 400, hash unchanged.
  - `disabled when env-provided`: with an env hash, GET shows the disabled explanation and the POST is a 400 no-op. (Review Focus: env precedence.)
  - `changes with correct current` also asserts a cookie issued before the change no longer opens `/admin` (other devices signed out) while the response's new cookie does.
  - `resetAdmin.test.ts` `clears a DB hash -> unclaimed`: seed a DB hash, `resetAdmin(db, env)` returns reset, `installState` is unclaimed, and the stored session secret changed.
  - `refuses an env hash`: env hash set -> returns env-managed, hash untouched. (Review Focus: reset vs env.)
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement the form/handler and the CLI.
- [ ] **Step 4: Run** `npx vitest run test/admin/changePassword.test.ts test/cli` — PASS.
- [ ] **Step 5: Commit** `feat(admin): change-password form and reset-admin CLI`.

---

### Task 8: Wizard framework and steps 1-3 (household, services, home)

**Files:**
- Create: `src/features/admin/setup/routes.tsx` (mounted at `/admin/setup`), `src/features/admin/setup/steps.ts` (step list + done-state derivation + resume), `src/features/admin/setup/StepShell.tsx` (indicator, Back / Skip for now / Save and continue / Finish later)
- Create: `src/services/keyProbe.ts` (`testPlacesKey`, `testAnthropicKey`)
- Modify: `src/features/admin/routes.tsx` (mount wizard; overview Continue setup / Run setup again)
- Test: `test/setup/wizard.test.ts`, `test/setup/keyProbe.test.ts`

**Interfaces:**
- Produces: `const STEPS = [welcome, services, home, categories, places, protocol, done] as const` and `stepDone(deps, step): boolean` — welcome: `settings.householdName != null`; services: always true (optional, never a resume target); home: homeLat/homeLng set; categories: >=1 category; places: >=1 approved location; protocol: >=1 published protocol; done: `setupCompletedAt` set. `resumeTarget(deps): string` = first of welcome,home,categories,places,protocol not done, else `/admin/setup/done`.
- Note: mount `setupRoutes` inside `adminRoutes` after the `requireSameOrigin`/`requireAdmin` middleware so every wizard GET/POST is authenticated and origin-checked.
- Produces: `setupRoutes(deps): Hono` — GET `/admin/setup` -> 302 to `resumeTarget`; a GET+POST per step. POSTs write via existing services/repos and redirect within the wizard (next step for Save and continue / Skip for now; prev for Back; `/admin` for Finish later). The indicator shows Step N of 7.
  - welcome: household name (default shown Our household) + emergency number (default 911) -> write the new columns.
  - services: Google Places and Anthropic key fields (`type=password`, saved shown as `Saved (ends in ...<last4>)`, each with a blank-keeps / Remove control and a Test button) plus one-sentence value/cost/where-to-get copy per spec; env-provided keys render read-only Set by the server environment.
  - home: address lookup (when a Places key is resolvable) or manual lat/lng with a how-to-find hint; radius; time zone via `<input list>` over `Intl.supportedValuesOf(timeZone)` prefilled from `TZ`/current; the two crons under an `<details>` Advanced described in plain words.
- Produces: `testPlacesKey(key, deps): Promise<{ ok: true } | { ok: false; message: string }>` — one `places:searchText` for a trivial query using a throwaway `new CallBudget(1)` with no ledger (does not count against the monthly cap); maps `PlacesError` status to plain words (403 -> key rejected by Google). `testAnthropicKey(key, env): Promise<...>` — a minimal `generateJson` on `LLM_EXTRACT_MODEL` with `maxTokens: 16` and a trivial `z.object({ ok: z.boolean() })` schema; success -> ok, otherwise the error in plain words. (Decisions, spec builder call on probes.)

- [ ] **Step 1: Write failing tests:**
  - `wizard.test.ts` `resume lands on first incomplete step`: a fresh claimed install -> GET `/admin/setup` 302 to `/admin/setup/welcome`; after saving household and home, resume skips to `/admin/setup/categories`.
  - `household save persists and advances`: POST welcome -> 302 `/admin/setup/services`, `settings.householdName` set, the family header shows it.
  - `blank key save keeps existing; remove clears`: pre-set a places key in DB, POST services with a blank key -> still set; POST with Remove -> cleared. (Review Focus.)
  - `env-provided key is read-only`: with `GOOGLE_PLACES_API_KEY` env set, the services step shows Set by the server environment and the POST does not change it.
  - `keyProbe.test.ts`: `testPlacesKey` with a recorded 200 fetch -> ok and does not touch `placesUsage`; with a 403 fetch -> not-ok with a plain message.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement the shell, steps 1-3, probes, overview continue/rerun links.
- [ ] **Step 4: Run** `npx vitest run test/setup` — PASS.
- [ ] **Step 5: Commit** `feat(setup): resumable wizard shell with household, services, home steps`.

---

### Task 9: Category presets and find-places step (wizard steps 4-5)

**Files:**
- Create: `src/features/admin/setup/presets.ts`
- Modify: `src/features/admin/setup/routes.tsx` (categories + places steps)
- Test: `test/setup/wizardCategories.test.ts`

**Interfaces:**
- Produces: `const CATEGORY_PRESETS` (decision, spec Claude call):
  - Urgent care — terms [urgent care, walk-in clinic], target 3
  - Emergency room — terms [emergency room, hospital emergency department], target 2
  - 24-hour pharmacy — terms [24 hour pharmacy, late night pharmacy], target 2
  - Dentist (emergency) — terms [emergency dentist, 24 hour dentist], target 3
  - Emergency vet — terms [emergency vet, 24 hour animal hospital], target 2
  - Pediatrician — terms [pediatrician, childrens urgent care], target 3
  Plus an Add your own free form. Presets already present (matched by slug) render checked/existing.
- Produces: the categories step POST creates the checked presets via the existing `createCategory` (idempotent by slug) and the custom one; redirects to the places step. The places step, per category: Find places (reuses `runDiscovery` through `placesOf(deps)`) with inline approve/reject of candidates (reuse `ReviewQueue` + the existing `/admin/locations/:id/approve|reject`), or Add a place by hand (reuse the manual location form, which creates a candidate, then approve in place). Shows N approved of target M per category. With no resolvable Places key, only manual entry is offered, with a note on what the key adds.

Decision: the find-places step reuses the existing discovery and location transition routes (which keep their current redirect targets for their own tests); the wizard links to them with a `return_to` back into `/admin/setup/places` where applicable, and derives approved-vs-target counts from `listLocations`.

- [ ] **Step 1: Write failing tests** `test/setup/wizardCategories.test.ts`:
  - `creating presets is idempotent`: POST categories with three presets checked -> three categories; re-POST the same -> still three, shown as existing.
  - `places step shows approved-of-target and a manual-only note without a key`: with no Places key, the step shows Add a place by hand, the no-key note, and the per-category 0 approved of target N.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement presets + both steps.
- [ ] **Step 4: Run** `npx vitest run test/setup test/categories test/locations` — PASS.
- [ ] **Step 5: Commit** `feat(setup): category presets and find-places step`.

---

### Task 10: Manual protocol path (service + classic admin + wizard step 6 + done step 7)

**Files:**
- Modify: `src/features/protocols/service.ts` (`createManualDraft`), `src/features/protocols/adminRoutes.tsx` (Write it yourself on the protocol detail page + route)
- Modify: `src/features/admin/setup/routes.tsx` (protocol step: Draft from sources vs Write it yourself; done step sets `setupCompletedAt`)
- Test: `test/protocols/manualDraft.test.ts`, `test/setup/wizardProtocol.test.ts`

**Interfaces:**
- Produces: `createManualDraft(db: Db, protocolId: number, now: Date): ProtocolVersion` — inserts a draft version whose `bodyMd` is the SOP template below (passes `assertSopHeadings`), at `nextVersionNumber`. Template (exact — the four headings, in order, are the only level-2 headings):
  ```
  ## Title and scope
  What this covers and who it is for.

  ## Steps
  1. First step.

  ## Escalation criteria
  Call 911 or go to the ER if ...

  ## Do not
  - Common mistake to avoid.
  ```
- Produces: classic admin POST `/admin/protocols/:id/manual-draft` -> `createManualDraft` then 302 to `/admin/protocols/:id/versions/:vid` (the existing review/publish screen). The detail page shows Write it yourself beside Generate draft; Generate draft stays disabled with its explanation when no LLM key is resolvable (closing the no-LLM dead end).
- Produces: the wizard protocol step offers title+tags -> create protocol (reuse `createProtocol`), then either the LLM draft route (disabled without a key) or Write it yourself (`createManualDraft`), landing on the review screen. The done step renders a checklist summary, a link to the family site and an Add to Home Screen tip, and on confirm sets `settings.setupCompletedAt = now` and redirects to `/admin`.

- [ ] **Step 1: Write failing tests:**
  - `manualDraft.test.ts` `creates a valid draft that publishes`: `createManualDraft` body passes `assertSopHeadings`; via the route, approve and publish works end to end with no LLM configured.
  - `editing to break headings is a 400`: save a body that drops the Do not heading -> the `updateDraftBody` route re-renders with `role=alert` and status 400, not 500. (Review Focus.)
  - `wizardProtocol.test.ts` `write-it-yourself path reaches review`: the wizard protocol step with no key -> POST creates protocol + manual draft -> 302 to the version review URL.
  - `done sets setup_completed_at`: POST done -> `installState` becomes ready, 302 `/admin`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement `createManualDraft`, routes, wizard steps 6-7.
- [ ] **Step 4: Run** `npx vitest run test/protocols test/setup` — PASS.
- [ ] **Step 5: Commit** `feat(protocols): manual draft path in admin and wizard; finish setup`.

---

### Task 11: admin.js progressive enhancement

**Files:**
- Modify: `public/admin.js` (fill in the behavior authored empty in Task 1)
- Test: extend `test/assets.test.ts`

**Interfaces:**
- Produces: on `DOMContentLoaded`, for every `<form data-busy>` submit, disable the submit button and set its text to Working... (store the original to restore on `pageshow`). No inline scripts, no `on*` attributes; purely additive. Admin long-POST forms (discovery, draft, manual-draft) get `data-busy`. Everything still works with JS off.

- [ ] **Step 1:** Extend `test/assets.test.ts`: `admin.js served as javascript` -> GET `/assets/admin.js` 200, content-type contains javascript, body contains `data-busy`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3:** Implement `admin.js`; add `data-busy` to the discovery/draft forms.
- [ ] **Step 4: Run** `npx vitest run test/assets.test.ts` — PASS.
- [ ] **Step 5: Commit** `feat(admin): progressive-enhancement admin.js for long POSTs`.

---

### Task 12: Deploy and docs

**Files:**
- Modify: `Dockerfile` (copy `public/` into the runtime stage), `docker-compose.yml` (optional `.env`), `README.md`, `.env.example`
- Test: none (config/docs)

**Decisions:**
- `Dockerfile` runtime stage adds a copy of `/app/public` so `/assets/*` works in the image.
- `docker-compose.yml` makes `.env` optional via the long `env_file` form with `required: false` (the two pinned environment overrides and `TZ` stay).
- `README.md`: a First run with no .env section (`docker compose up -d`, read the setup code from `docker compose logs`, open `/setup`); document that `ADMIN_PASSWORD_HASH`/`SESSION_SECRET` are now optional (CLI hashing is the advanced path); document the wizard, the reset CLI (`docker compose exec app node dist/cli/reset-admin.js`), that DB-stored secrets share the SQLite volume trust boundary with `.env`, and that env-provided values win and show as read-only.
- `.env.example`: note every secret is optional; keep it as the reference for the advanced/pre-seeded path.

- [ ] **Step 1:** Edit the four files.
- [ ] **Step 2: Run** `npx vitest run` (unchanged green) and `docker compose config` to confirm the compose file parses with no `.env` present.
- [ ] **Step 3: Commit** `docs,build: optional .env, copy public assets, document zero-config first run`.

---

### Task 13: Final visual QA (375px and 1280px, light and dark)

**Files:** none (verification only)

- [ ] **Step 1:** `npm run build && npm start` (or `npm run dev`) against a DB exercised through the wizard.
- [ ] **Step 2:** With Playwright (skill/MCP if available), capture the family home, a location card, a protocol page, the admin overview, and one wizard step at 375px and 1280px in both light and dark `prefers-color-scheme`.
- [ ] **Step 3:** Verify against the spec: one primary action per family screen, status conveyed by icon+text (not color alone), visible focus ring, 44/56px targets, tables stack under ~640px, no horizontal scroll at 375px, fonts load (or degrade to system-ui) with no CDN request.
- [ ] **Step 4:** File any pixel fixes as follow-up commits referencing this task. No merge until this passes.

---

## Self-Review Notes

- **Spec coverage:** install states/auth -> Tasks 2,6,7; secrets storage + precedence + optional env + session autogen -> Task 2; runtime key changes -> Task 2 (resolver), consumed in 8,9,10; wizard steps 1-7 -> Tasks 8,9,10; visual tokens/font/icons/assets -> Tasks 1,3; layouts + 404/500 -> Task 3; family pages -> Task 4; admin JS -> Task 11; overview -> Task 5; testing expectations -> distributed per task; deploy/docs -> Task 12; manual QA -> Task 13.
- **Proportion:** bodies appear only for the SOP template (spec-fixed) and the token values (a pinned Claude call); everything else is signatures, exact copy, and test assertions.
- **Type consistency:** `SecretsStore`, `InstallState`, `ServiceResolver`/`placesOf|llmOf|extractOf`, `PageChrome`/`AdminNavKey`, `STEPS`/`stepDone`/`resumeTarget`, `createManualDraft`, `assetUrl`/`Icon` are defined once and referenced by name downstream.
