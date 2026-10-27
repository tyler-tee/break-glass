import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { page } from '../../web/Layout.js';
import { placesErrorPage } from '../../web/placesErrorPage.js';
import { CallBudget, PlacesError } from '../../services/places/client.js';
import { NoHomeLocation, runDiscovery } from '../locations/discovery.js';
import { CategoryError, createCategory, deleteCategory, getCategory, listCategories, updateCategory } from './repo.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const parseTerms = (v: unknown): string[] => str(v).split(/[\n\r,]+/);
// Blank target count means "use the default"; anything else must parse as a number.
const parseTarget = (v: unknown): number | undefined => (str(v).trim() === '' ? undefined : Number(str(v)));

type FormValues = { name: string; searchTerms: string; targetCount: string };

export function categoriesRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  const listPage = (c: Parameters<typeof page>[0], opts: { error?: string; status?: 200 | 400 | 409 } = {}) =>
    page(
      c,
      'Categories',
      <>
        <h1>Categories</h1>
        <AdminNav />
        {opts.error && <p role="alert">{opts.error}</p>}
        <p>
          <a href="/admin/categories/new">New category</a>
        </p>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Search terms</th>
              <th>Target</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {listCategories(db).map((cat) => (
              <tr>
                <td>{cat.name}</td>
                <td>{cat.slug}</td>
                <td>{cat.searchTerms.join(', ')}</td>
                <td>{cat.targetCount}</td>
                <td>
                  <a href={`/admin/categories/${cat.id}/edit`}>Edit</a>
                  <form method="post" action={`/admin/categories/${cat.id}/discover`}>
                    <button type="submit">Discover</button>
                  </form>
                  <form method="post" action={`/admin/categories/${cat.id}/delete`}>
                    <button type="submit">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>,
      opts.status ?? 200,
    );

  const formPage = (
    c: Parameters<typeof page>[0],
    action: string,
    v: FormValues,
    opts: { error?: string; status?: 200 | 400 } = {},
  ) =>
    page(
      c,
      'Category',
      <>
        <h1>Category</h1>
        <AdminNav />
        {opts.error && <p role="alert">{opts.error}</p>}
        <form method="post" action={action}>
          <p>
            <label>
              Name <input name="name" value={v.name} />
            </label>
          </p>
          <p>
            <label>
              Search terms (one per line)
              <textarea name="search_terms" rows={5}>
                {v.searchTerms}
              </textarea>
            </label>
          </p>
          <p>
            <label>
              Target count <input name="target_count" value={v.targetCount} />
            </label>
          </p>
          <button type="submit">Save</button>
        </form>
        <p>
          <a href="/admin/categories">Back to categories</a>
        </p>
      </>,
      opts.status ?? 200,
    );

  const submitted = (body: Record<string, unknown>): FormValues => ({
    name: str(body['name']),
    searchTerms: str(body['search_terms']),
    targetCount: str(body['target_count']),
  });

  app.get('/', (c) => listPage(c));

  app.get('/new', (c) =>
    formPage(c, '/admin/categories', {
      name: '',
      searchTerms: '',
      targetCount: '5',
    }),
  );

  app.get('/:id/edit', (c) => {
    const cat = getCategory(db, Number(c.req.param('id')));
    if (!cat) return c.notFound();
    return formPage(c, `/admin/categories/${cat.id}`, {
      name: cat.name,
      searchTerms: cat.searchTerms.join('\n'),
      targetCount: String(cat.targetCount ?? 5),
    });
  });

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    try {
      createCategory(db, {
        name: str(body['name']),
        searchTerms: parseTerms(body['search_terms']),
        targetCount: parseTarget(body['target_count']),
      });
    } catch (e) {
      if (e instanceof CategoryError) {
        return formPage(c, '/admin/categories', submitted(body), {
          error: e.message,
          status: 400,
        });
      }
      throw e;
    }
    return c.redirect('/admin/categories', 302);
  });

  app.post('/:id/discover', async (c) => {
    const id = Number(c.req.param('id'));
    const category = getCategory(db, id);
    if (!category) return c.notFound();
    if (!deps.places) return listPage(c, { error: 'Set GOOGLE_PLACES_API_KEY to enable discovery', status: 400 });
    try {
      const report = await runDiscovery(db, id, {
        places: { ...deps.places, budget: new CallBudget(deps.env.PLACES_CALL_CAP) },
        now: deps.now ?? (() => new Date()),
        log: console,
      });
      const q = new URLSearchParams({
        category: category.slug,
        inserted: String(report.inserted),
        skipped: String(report.skipped),
        calls: String(report.callsUsed),
      });
      if (report.stoppedEarly) q.set('stopped', '1');
      return c.redirect(`/admin/candidates?${q}`, 302);
    } catch (e) {
      if (e instanceof NoHomeLocation) {
        return listPage(c, { error: 'Set the home location in Settings first', status: 400 });
      }
      if (e instanceof PlacesError) return placesErrorPage(c, e);
      throw e;
    }
  });

  app.post('/:id/delete', (c) => {
    try {
      deleteCategory(db, Number(c.req.param('id')));
    } catch (e) {
      if (e instanceof CategoryError) {
        if (e.code === 'not_found') return c.notFound();
        return listPage(c, { error: e.message, status: 409 });
      }
      throw e;
    }
    return c.redirect('/admin/categories', 302);
  });

  app.post('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    try {
      updateCategory(db, id, {
        name: str(body['name']),
        searchTerms: parseTerms(body['search_terms']),
        targetCount: parseTarget(body['target_count']),
      });
    } catch (e) {
      if (e instanceof CategoryError) {
        if (e.code === 'not_found') return c.notFound();
        return formPage(c, `/admin/categories/${id}`, submitted(body), {
          error: e.message,
          status: 400,
        });
      }
      throw e;
    }
    return c.redirect('/admin/categories', 302);
  });

  return app;
}
