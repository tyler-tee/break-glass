import { Hono } from 'hono';
import type { Context } from 'hono';
import { raw } from 'hono/html';
import type { AppDeps } from '../../app.js';
import { installState } from '../admin/install.js';
import { getSettings } from '../admin/settingsRepo.js';
import { requestClock } from '../clock.js';
import { type Category, getCategoryBySlug, listCategories } from '../categories/repo.js';
import { categoryForTags, forFamily } from '../locations/familyViews.js';
import { type CategoryGroup, getVisibleLocation, listVisibleByCategory, listVisibleGrouped, searchLocations } from '../locations/search.js';
import { getPublished, getPublishedBySlug } from '../protocols/repo.js';
import { renderMarkdown, safeHref, telHref } from '../../web/format.js';
import { householdName, page } from '../../web/Layout.js';
import { splitSopSections } from '../../web/protocolSections.js';
import { BackLink, categoryIcon, daysAgo, oldestVerified, ProviderCard, SearchField, Svg } from '../../web/family/ui.js';

const POISON_CONTROL = { display: '1-800-222-1222', tel: 'tel:18002221222' };
// Home shows this many category tiles, then the dashed "All categories" tile (always present, per the mockup).
const MAX_TILES = 5;

export function familyRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const { now, tz } = requestClock(deps);
  const app = new Hono();

  const emergencyNumber = () => {
    const stored = getSettings(db).emergencyNumber?.trim() ?? '';
    return /\d/.test(stored) ? stored : '911';
  };
  // Creation order, so the household's first categories (the presets) lead the grid.
  const orderedCategories = () => [...listCategories(db, { area: 'health' })].sort((a, b) => a.id - b.id);

  app.get('/', (c) => {
    // Until someone claims the install there is nothing for the family yet; point at /setup instead.
    if (deps.secrets && installState({ db, secrets: deps.secrets }) === 'unclaimed') {
      return page(
        c,
        'Not set up yet',
        <section class="plain" aria-labelledby="unclaimed-title">
          <h1 id="unclaimed-title">This toolkit is not set up yet</h1>
          <p>Whoever runs the server needs to finish setting it up before your family can use it.</p>
          <a class="btn btn-solid" href="/setup">
            Set it up
          </a>
        </section>,
      );
    }
    const number = emergencyNumber();
    const groups = new Map(listVisibleGrouped(db, now(), tz(), { area: 'health' }).map((g) => [g.category.id, forFamily(g.locations)]));
    const cats = orderedCategories();
    const shown = cats.slice(0, MAX_TILES);
    const verified = oldestVerified([...groups.values()].flat());
    return page(
      c,
      'Preparedness kit',
      <>
        <header class="home-head">
          <p>
            {householdName(c)}
            {verified ? ` · data verified ${daysAgo(verified, now())}` : ''}
          </p>
          <h1>Preparedness kit</h1>
        </header>

        <SearchField action="/search" id="q" label="Find a provider" visibleLabel placeholder="Dentist, urgent care, vet…" />

        <a class="protocols-banner" href="/emergency">
          <span class="badge">
            <Svg name="plus" size={26} sw={2.4} />
          </span>
          <span class="text">
            <span class="title">Emergency protocols</span>
            <span class="sub">First aid SOPs · when to call {number}</span>
          </span>
          <Svg name="chevron-right" size={22} />
        </a>

        <div class="pair">
          <a class="btn btn-accent-outline" href={telHref(number)}>
            <Svg name="phone" /> Call {number}
          </a>
          <a class="btn btn-outline" href={POISON_CONTROL.tel} aria-label={`Call Poison Control, ${POISON_CONTROL.display}`}>
            <Svg name="flask" sw={2} /> Poison control
          </a>
        </div>

        <section class="providers" aria-labelledby="providers-title">
          <h2 class="section-label" id="providers-title">
            Vetted providers
          </h2>
          <div class="tiles">
            {shown.map((cat) => (
              <CategoryTile cat={cat} views={groups.get(cat.id) ?? []} />
            ))}
            <a class="tile more" href="/categories">
              <Svg name="plus" size={22} sw={2} />
              <span>All categories</span>
            </a>
          </div>
        </section>
      </>,
      200,
      { mainClass: 'home' },
    );
  });

  app.get('/search', (c) => {
    const q = (c.req.query('q') ?? '').trim();
    const groups = q ? searchLocations(db, q, now(), tz(), { area: 'health' }) : [];
    const exact = groups.find((g) => g.category.name.toLowerCase() === q.toLowerCase());
    const ordered = exact ? [exact, ...groups.filter((g) => g !== exact)] : groups;
    return resultsPage(c, q || 'Search', q, ordered.map((g) => ({ ...g, locations: forFamily(g.locations) })));
  });

  app.get('/c/:slug', (c) => {
    const category = getCategoryBySlug(db, c.req.param('slug'));
    if (!category || category.area !== 'health') return notFound(c, 'We could not find that category.');
    const views = forFamily(listVisibleByCategory(db, category.slug, now(), tz()));
    return resultsPage(c, category.name, category.name, [{ category, locations: views }]);
  });

  // The old per-place page is gone; send old links to the place's card in its category.
  app.get('/l/:id', (c) => {
    const id = Number(c.req.param('id'));
    const view = Number.isInteger(id) ? getVisibleLocation(db, id, now(), tz()) : null;
    if (!view || view.category.area !== 'health') return notFound(c, 'We could not find that place.');
    return c.redirect(`/c/${view.category.slug}#place-${view.id}`, 302);
  });

  app.get('/categories', (c) => {
    const counts = new Map(listVisibleGrouped(db, now(), tz(), { area: 'health' }).map((g) => [g.category.id, forFamily(g.locations).length]));
    return page(
      c,
      'All categories',
      <>
        <div class="page-head">
          <BackLink href="/" label="Back to home" />
          <h1>All categories</h1>
        </div>
        <CategoryList cats={orderedCategories()} counts={counts} />
      </>,
    );
  });

  app.get('/emergency', (c) => {
    const number = emergencyNumber();
    const q = (c.req.query('q') ?? '').trim();
    const all = getPublished(db, { area: 'health' });
    const needle = q.toLowerCase();
    const items = needle
      ? all.filter(({ protocol: p }) =>
          [p.title, ...(p.tags ?? [])].some((t) => t.toLowerCase().includes(needle)),
        )
      : all;
    return page(
      c,
      'Emergency protocols',
      <>
        <div class="page-head">
          <BackLink href="/" label="Back to home" />
          <h1>Emergency protocols</h1>
        </div>
        <CallBlock number={number} />
        {all.length > 0 ? (
          <SearchField action="/emergency" id="q3" label="Search protocols" value={q} compact
            placeholder="Burn, choking, bee sting…" />
        ) : null}
        {all.length === 0 ? (
          <p class="empty">No protocols have been published yet. For any emergency, call {number}.</p>
        ) : items.length === 0 ? (
          <p class="empty">
            No protocol matches “{q}”. <a href="/emergency">Show all protocols</a>
          </p>
        ) : (
          <nav class="list" aria-label="Protocols">
            {items.map(({ protocol: p }) => (
              <a href={`/emergency/${p.slug}`}>
                <span class="text">
                  <span class="title">{p.title}</span>
                  {p.needsRereview ? (
                    <span class="sub review">
                      <Svg name="warning" size={14} /> Source changed · pending re-review
                    </span>
                  ) : p.tags && p.tags.length > 0 ? (
                    <span class="sub">{capitalize(p.tags[0]!)}</span>
                  ) : null}
                </span>
                <span class="chev">
                  <Svg name="chevron-right" size={20} />
                </span>
              </a>
            ))}
          </nav>
        )}
      </>,
    );
  });

  app.get('/emergency/:slug', (c) => {
    const found = getPublishedBySlug(db, c.req.param('slug'));
    if (!found || found.protocol.area !== 'health') return notFound(c, 'We could not find that protocol.', '/emergency', 'Back to protocols');
    const { protocol, version, sources } = found;
    const number = emergencyNumber();
    const tag = protocol.tags?.[0];
    const category = categoryForTags(listCategories(db), protocol.tags, protocol.area);
    const chunks = splitSopSections(version.bodyMd);
    const body = (heading: string) => chunks.find((ch) => ch.heading === heading);
    const md = (chunkMd: string) => raw(renderMarkdown(withoutHeading(chunkMd)));
    const scope = body('Title and scope');
    const escalation = body('Escalation criteria');
    const steps = body('Steps');
    const doNot = body('Do not');
    // Anything outside the four SOP sections still renders, plainly, so no content is dropped.
    const extra = chunks.filter((ch) => !['Title and scope', 'Escalation criteria', 'Steps', 'Do not'].includes(ch.heading));
    const reviewed = version.reviewedAt ? ` · reviewed ${version.reviewedAt.toISOString().slice(0, 10)}` : '';
    return page(
      c,
      protocol.title,
      <>
        <div class="page-head">
          <BackLink href="/emergency" label="Back to protocols" />
          <span class="eyebrow">{tag ? `${tag} · SOP` : 'SOP'}</span>
        </div>
        <div class="sop-head">
          <h1>{protocol.title}</h1>
          {scope ? <div class="lede">{md(scope.md)}</div> : null}
        </div>
        {protocol.needsRereview ? (
          <div class="alert" role="note">
            <Svg name="warning" />
            <span class="text">
              <strong>Sources changed recently</strong>
              <span>This protocol is being re-checked.</span>
            </span>
          </div>
        ) : null}
        <section class="escalate" aria-labelledby="escalate-title">
          <h2 id="escalate-title">Call {number} instead if</h2>
          {escalation ? <div class="body">{md(escalation.md)}</div> : null}
          <a class="btn sm btn-accent" href={telHref(number)}>
            Call {number}
          </a>
        </section>
        {steps ? (
          <section class="steps" aria-labelledby="steps-title">
            <h2 class="section-label" id="steps-title">
              Steps
            </h2>
            <div class="body">{md(steps.md)}</div>
            {category ? (
              <a class="btn lg btn-solid" href={`/c/${category.slug}`}>
                <Svg name={categoryIcon(category)} size={20} sw={1.8} /> Find a vetted {category.name.toLowerCase()}
              </a>
            ) : null}
          </section>
        ) : null}
        {doNot ? (
          <section class="do-not" aria-labelledby="donot-title">
            <h2 id="donot-title">Do not</h2>
            <div class="body">{md(doNot.md)}</div>
          </section>
        ) : null}
        {extra.map((ch) => (
          <section class="sop-extra">{raw(renderMarkdown(ch.md.replace(/^# .*$/m, '')))}</section>
        ))}
        <footer class="sop-meta">
          <p class="version">
            <b>Version {version.version}</b>
            {reviewed}
          </p>
          {sources.length > 0 ? (
            <>
              <p>Sources</p>
              <ul>
                {sources.map((s) => (
                  <li>
                    {safeHref(s.url) ? <a href={safeHref(s.url)!}>{s.title ?? s.url}</a> : <span>{s.title ?? s.url}</span>}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </footer>
      </>,
    );
  });

  function resultsPage(c: Context, title: string, q: string, groups: CategoryGroup[]) {
    const single = groups.length === 1;
    const verified = oldestVerified(groups.flatMap((g) => g.locations));
    return page(
      c,
      title,
      <>
        <div class="page-head">
          <BackLink href="/" label="Back to home" />
          <SearchField action="/search" id="q2" label="Search providers" value={q} compact
            placeholder="Dentist, urgent care, vet…" />
        </div>
        {groups.length === 0 ? (
          <>
            <p class="empty">{q ? `No vetted providers match “${q}”.` : 'Type what you need, like “dentist”.'} Pick a category instead:</p>
            <CategoryList
              cats={orderedCategories()}
              counts={new Map(listVisibleGrouped(db, now(), tz(), { area: 'health' }).map((g) => [g.category.id, forFamily(g.locations).length]))}
            />
          </>
        ) : (
          groups.map((g) => (
            <section class="providers" aria-labelledby={`cat-${g.category.slug}`}>
              <div class="results-head">
                {single ? <h1 id={`cat-${g.category.slug}`}>{g.category.name}</h1> : <h2 id={`cat-${g.category.slug}`}>{g.category.name}</h2>}
                <p>{g.locations.length === 0 ? 'none vetted yet' : `${g.locations.length} vetted · nearest first`}</p>
              </div>
              {g.locations.length === 0 ? (
                <p class="empty">No places have been vetted for {g.category.name.toLowerCase()} yet.</p>
              ) : (
                g.locations.map((l) => <ProviderCard view={l} headingLevel={single ? 2 : 3} />)
              )}
            </section>
          ))
        )}
        {verified ? <p class="footnote">Last verified {daysAgo(verified, now())}</p> : null}
      </>,
    );
  }

  return app;
}

function notFound(c: Context, message: string, href = '/', label = 'Back to home') {
  return page(
    c,
    'Not found',
    <>
      <div class="page-head">
        <BackLink href={href} label={label} />
        <h1>Not found</h1>
      </div>
      <p class="empty">{message}</p>
    </>,
    404,
  );
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// The page draws its own heading for each SOP section, so drop the "## ..." line (and any "# title").
function withoutHeading(md: string): string {
  return md.replace(/^\s*##? .*(\r?\n|$)/, '').replace(/^# .*$/m, '');
}

function CategoryTile({ cat, views }: { cat: Category; views: { status: string }[] }) {
  const review = views.filter((v) => v.status === 'warn').length;
  return (
    <a class="tile" href={`/c/${cat.slug}`}>
      <Svg name={categoryIcon(cat)} size={26} sw={1.8} />
      <span>
        <span class="name">{cat.name}</span>
        {views.length === 0 ? (
          <span class="sub">None vetted yet</span>
        ) : review > 0 ? (
          <span class="sub review">
            <Svg name="warning" size={14} /> {views.length} vetted · {review} to review
          </span>
        ) : (
          <span class="sub">{views.length} vetted</span>
        )}
      </span>
    </a>
  );
}

function CategoryList({ cats, counts }: { cats: Category[]; counts: Map<number, number> }) {
  return (
    <nav class="list" aria-label="Categories">
      {cats.map((cat) => {
        const n = counts.get(cat.id) ?? 0;
        return (
          <a href={`/c/${cat.slug}`}>
            <Svg name={categoryIcon(cat)} size={24} sw={1.8} />
            <span class="text">
              <span class="title">{cat.name}</span>
              <span class="sub">{n === 0 ? 'None vetted yet' : `${n} vetted`}</span>
            </span>
            <span class="chev">
              <Svg name="chevron-right" size={20} />
            </span>
          </a>
        );
      })}
    </nav>
  );
}

function CallBlock({ number }: { number: string }) {
  return (
    <div class="call-block">
      <p>Not breathing, unresponsive, severe bleeding, or chest pain?</p>
      <a class="btn btn-white" href={telHref(number)}>
        <Svg name="phone" size={20} /> Call {number} now
      </a>
    </div>
  );
}
