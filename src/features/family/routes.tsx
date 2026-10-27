import { Hono } from 'hono';
import { raw } from 'hono/html';
import { eq } from 'drizzle-orm';
import { settings } from '../../db/schema.js';
import { Icon } from '../../web/components/Icon.js';
import { splitSopSections } from '../../web/protocolSections.js';
import type { AppDeps } from '../../app.js';
import { requestClock } from '../clock.js';
import { LocationCard } from '../../web/components/LocationCard.js';
import { WarningBadge } from '../../web/components/WarningBadge.js';
import { renderMarkdown, safeHref, telHref } from '../../web/format.js';
import { page } from '../../web/Layout.js';
import { getCategoryBySlug, listCategories } from '../categories/repo.js';
import { getPublished, getPublishedBySlug } from '../protocols/repo.js';
import { getVisibleLocation, listVisibleByCategory, listVisibleGrouped, searchLocations } from '../locations/search.js';

export function familyRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const { now, tz } = requestClock(deps);
  const app = new Hono();

  app.get('/', (c) => {
    const cats = listCategories(db);
    const number =
      db.select({ n: settings.emergencyNumber }).from(settings).where(eq(settings.id, 1)).get()?.n?.trim() || '911';
    const counts = new Map(listVisibleGrouped(db, now(), tz()).map((g) => [g.category.id, g.locations.length]));
    return page(
      c,
      'Emergency toolkit',
      <>
        <a class="emergency emergency-call" href={telHref(number)}>
          <Icon name="phone" /> Call {number}
        </a>
        <h2>What to do</h2>
        <a class="row action-row" href="/emergency">
          <Icon name="alert-triangle" /> <span>Emergency protocols</span> <Icon name="chevron-right" />
        </a>
        <form class="search" method="get" action="/search" role="search">
          <input type="search" name="q" placeholder="Search (e.g. dentist)" aria-label="Search" />
          <button type="submit">
            <Icon name="search" /> Search
          </button>
        </form>
        <h2>Find help nearby</h2>
        <div class="tiles">
          {cats.map((cat) => (
            <a class="tile" href={`/c/${cat.slug}`}>
              <Icon name="map-pin" />
              <span class="tile-name">{cat.name}</span>
              <span class="tile-count">{counts.get(cat.id) ?? 0}</span>
            </a>
          ))}
        </div>
      </>,
    );
  });

  app.get('/search', (c) => {
    const q = c.req.query('q') ?? '';
    const groups = searchLocations(db, q, now(), tz());
    return page(
      c,
      'Search',
      <>
        <h1>Search</h1>
        <form class="search" method="get" action="/search" role="search">
          <input type="search" name="q" value={q} aria-label="Search" />
          <button type="submit">Search</button>
        </form>
        {groups.length === 0 ? (
          <p>No matches</p>
        ) : (
          groups.map((g) => (
            <section>
              <h2>{g.category.name}</h2>
              {g.locations.map((l) => (
                <LocationCard location={l} />
              ))}
            </section>
          ))
        )}
      </>,
    );
  });

  app.get('/c/:slug', (c) => {
    const category = getCategoryBySlug(db, c.req.param('slug'));
    if (!category) return page(c, 'Not found', <p>Category not found</p>, 404);
    const views = listVisibleByCategory(db, category.slug, now(), tz());
    return page(
      c,
      category.name,
      <>
        <h1>{category.name}</h1>
        {views.length === 0 ? <p>No locations yet</p> : views.map((l) => <LocationCard location={l} />)}
      </>,
    );
  });

  app.get('/l/:id', (c) => {
    const id = Number(c.req.param('id'));
    const view = Number.isInteger(id) ? getVisibleLocation(db, id, now(), tz()) : null;
    if (!view) return page(c, 'Not found', <p>Location not found</p>, 404);
    return page(
      c,
      view.name,
      <>
        <h1>{view.name}</h1>
        <LocationCard location={view} showCategory />
      </>,
    );
  });

  app.get('/emergency', (c) => {
    const items = getPublished(db);
    return page(
      c,
      'Emergency protocols',
      <>
        <h1>Emergency protocols</h1>
        {items.length === 0 ? (
          <p>No protocols published yet</p>
        ) : (
          items.map(({ protocol }) => (
            <a class="row protocol-row" href={`/emergency/${protocol.slug}`}>
              <span>
                <strong>{protocol.title}</strong>
                {protocol.tags && protocol.tags.length > 0 ? <small class="muted"> {protocol.tags.join(', ')}</small> : null}
                {protocol.needsRereview ? (
                  <WarningBadge kind="warn" summary="Sources changed; under re-review" />
                ) : null}
              </span>
            </a>
          ))
        )}
      </>,
    );
  });

  app.get('/emergency/:slug', (c) => {
    const found = getPublishedBySlug(db, c.req.param('slug'));
    if (!found) return page(c, 'Not found', <p>Protocol not found</p>, 404);
    const { protocol, version, sources } = found;
    const reviewed = version.reviewedAt ? ` - reviewed ${version.reviewedAt.toISOString().slice(0, 10)}` : '';
    return page(
      c,
      protocol.title,
      <>
        <h1>{protocol.title}</h1>
        {protocol.needsRereview ? (
          <WarningBadge kind="warn" summary={protocol.rereviewReason ?? 'Sources changed; under re-review'} />
        ) : null}
        <article class="protocol">
          {splitSopSections(version.bodyMd).map((chunk) => {
            const html = raw(renderMarkdown(chunk.md));
            if (chunk.heading === 'Escalation criteria')
              return (
                <section class="callout callout-escalation" data-callout="escalation">
                  {html}
                  <Icon name="alert-triangle" />
                </section>
              );
            if (chunk.heading === 'Do not')
              return (
                <section class="callout callout-do-not" data-callout="do-not">
                  {html}
                  <Icon name="x-octagon" />
                </section>
              );
            if (chunk.heading === 'Steps') return <section class="sop-steps">{html}</section>;
            return <section class="sop-section">{html}</section>;
          })}
        </article>
        <section>
          <h2>Sources</h2>
          <ul class="sources">
            {sources.map((s) => (
              <li>
                {safeHref(s.url) ? <a href={safeHref(s.url)!}>{s.title ?? s.url}</a> : <span>{s.title ?? s.url}</span>}
                {s.fetchedAt ? <span class="muted"> (fetched {s.fetchedAt.toISOString().slice(0, 10)})</span> : null}
              </li>
            ))}
          </ul>
        </section>
        <p class="muted">
          Published v{version.version}
          {reviewed}
        </p>
      </>,
    );
  });

  return app;
}
