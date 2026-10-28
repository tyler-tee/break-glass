# break-glass: family app (mockup-driven)

Date: 2026-10-27. Source of truth: `docs/design/emergency-toolkit-mockup.html` (four 390px screens: Home,
Search results, Emergency protocols, Protocol page), supplied by the user. Where this note and the mockup
disagree, the mockup wins. An earlier text-only spec was discarded, along with every screen built from it.

## Screens and routes

| Mockup screen | Route | Notes |
|---|---|---|
| Home | `/` | Eyebrow is `<household> · data verified N days ago`, using the oldest check across shown places. Five category tiles, then "All categories" (`/categories`). Tile icons are chosen by keyword. |
| Search: dentist | `/search?q=`, `/c/:slug` | Same layout. Nearest first. A category tile opens `/c/:slug` with its name in the box. No match shows a category list. |
| Emergency protocols | `/emergency?q=` | The search is a server-side GET filter on title and tags. No JavaScript. |
| Protocol | `/emergency/:slug` | Built from the four SOP sections. "Find a vetted X" appears when a tag equals a category's name, slug or search term. |

`/l/:id` redirects to the place's card on its category page.

## Data rules that the mockup implies

- Status pill + words: "Open now · until 9 PM", "Closed · opens Mon 7:30 AM", "Open now · open 24 hours",
  "Hours unknown · call first", "Closed · temporarily, per Google". All computed in the home time zone.
- `warn` places show "Needs re-approval" with a sentence built from unresolved changes.
- Permanently closed places are hidden from family pages (the JSON API still reports them).
- Light theme only, Public Sans self-hosted, styles in `public/family.css` (admin keeps `styles.css`).

## Not covered

The admin side and setup wizard: they need their own mockup before any build.
