import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import { requestClock } from '../clock.js';
import { LocationCard } from '../../web/components/LocationCard.js';
import { page } from '../../web/Layout.js';
import { getCategoryBySlug, listCategories } from '../categories/repo.js';
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

  return app;
}
