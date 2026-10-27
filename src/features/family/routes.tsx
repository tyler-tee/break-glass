import { Hono } from 'hono';
import { raw } from 'hono/html';
import type { AppDeps } from '../../app.js';
import { requestClock } from '../clock.js';
import { LocationCard } from '../../web/components/LocationCard.js';
import { WarningBadge } from '../../web/components/WarningBadge.js';
import { renderMarkdown } from '../../web/format.js';
import { page } from '../../web/Layout.js';
import { getCategoryBySlug, listCategories } from '../categories/repo.js';
import { getPublished, getPublishedBySlug } from '../protocols/repo.js';
import { getVisibleLocation, listVisibleByCategory, searchLocations } from '../locations/search.js';

export function familyRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const { now, tz } = requestClock(deps);
  const app = new Hono();

  app.get('/', (c) => {
    const cats = listCategories(db);
    return page(
      c,
      'Emergency toolkit',
      <>
        <h1>Emergency toolkit</h1>
        <a class="emergency" href="/emergency">
          Emergency protocols
        </a>
        <form class="search" method="get" action="/search" role="search">
          <input type="search" name="q" placeholder="Search (e.g. dentist)" aria-label="Search" />
          <button type="submit">Search</button>
        </form>
        <h2>Categories</h2>
        {cats.map((cat) => (
          <a class="row" href={`/c/${cat.slug}`}>
            {cat.name}
          </a>
        ))}
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
    const reviewed = version.reviewedAt ? ` · reviewed ${version.reviewedAt.toISOString().slice(0, 10)}` : '';
    return page(
      c,
      protocol.title,
      <>
        <h1>{protocol.title}</h1>
        {protocol.needsRereview ? (
          <WarningBadge kind="warn" summary={protocol.rereviewReason ?? 'Sources changed; under re-review'} />
        ) : null}
        <article class="protocol">{raw(renderMarkdown(version.bodyMd))}</article>
        <section>
          <h2>Sources</h2>
          <ul class="sources">
            {sources.map((s) => (
              <li>
                <a href={s.url}>{s.title ?? s.url}</a>
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
