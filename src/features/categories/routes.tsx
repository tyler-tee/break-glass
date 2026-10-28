import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppDeps } from '../../app.js';
import { page } from '../../web/Layout.js';
import { budgetExhaustedPage, placesErrorPage } from '../../web/placesErrorPage.js';
import { BudgetExhausted, newPlacesBudget } from '../../services/places/budget.js';
import { PlacesError } from '../../services/places/client.js';
import { extractOf, placesOf } from '../../services/resolver.js';
import { NoHomeLocation, runDiscovery } from '../locations/discovery.js';
import type { HoursNeed } from '../../domain/types.js';
import { CategoryError, createCategory, deleteCategory, getCategory, listCategories, updateCategory } from './repo.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const parseTerms = (v: unknown): string[] => str(v).split(/[\n\r,]+/);
// Blank means "use the default"; anything else is validated in the repo.
const hoursNeedOf = (v: unknown): { hoursNeed?: HoursNeed } =>
  str(v).trim() === '' ? {} : { hoursNeed: str(v) as HoursNeed };

type FormValues = { name: string; searchTerms: string; hoursNeed: string };

export function categoriesRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  const listPage = (c: Parameters<typeof page>[0], opts: { error?: Child; status?: 200 | 400 | 409 } = {}) =>
    page(
      c,
      'Categories',
      <>
        <h1>Categories</h1>
        {opts.error && <p role="alert">{opts.error}</p>}
        <p>
          <a href="/admin/categories/new">New category</a>
        </p>
        <table class="stack-table t-categories">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Search terms</th>
              <th>Hours</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {listCategories(db).map((cat) => (
              <tr>
                <td>{cat.name}</td>
                <td>{cat.slug}</td>
                <td>{cat.searchTerms.join(', ')}</td>
                <td>{cat.hoursNeed}</td>
                <td class="row-actions">
                  <a href={`/admin/categories/${cat.id}/edit`}>Edit</a>
                  <form method="post" action={`/admin/categories/${cat.id}/discover`} data-busy="Searching nearby…">
                    <button type="submit" class="btn-secondary">Discover</button>
                  </form>
                  <form method="post" action={`/admin/categories/${cat.id}/delete`}>
                    <button type="submit" class="btn-danger">Delete</button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'categories' },
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
              When would you go?
              <select name="hours_need">
                <option value="daytime" selected={v.hoursNeed === 'daytime'}>
                  Daytime
                </option>
                <option value="overnight" selected={v.hoursNeed !== 'daytime'}>
                  Any time, including overnight
                </option>
              </select>
            </label>
          </p>
          <button type="submit">Save</button>
        </form>
        <p>
          <a href="/admin/categories">Back to categories</a>
        </p>
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'categories' },
    );

  const submitted = (body: Record<string, unknown>): FormValues => ({
    name: str(body['name']),
    searchTerms: str(body['search_terms']),
    hoursNeed: str(body['hours_need']),
  });

  app.get('/', (c) => listPage(c));

  app.get('/new', (c) =>
    formPage(c, '/admin/categories', {
      name: '',
      searchTerms: '',
      hoursNeed: 'overnight',
    }),
  );

  app.get('/:id/edit', (c) => {
    const cat = getCategory(db, Number(c.req.param('id')));
    if (!cat) return c.notFound();
    return formPage(c, `/admin/categories/${cat.id}`, {
      name: cat.name,
      searchTerms: cat.searchTerms.join('\n'),
      hoursNeed: cat.hoursNeed,
    });
  });

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    try {
      createCategory(db, {
        name: str(body['name']),
        searchTerms: parseTerms(body['search_terms']),
        ...hoursNeedOf(body['hours_need']),
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
    const places = placesOf(deps);
    if (!places) {
      return listPage(c, {
        error: (
          <>
            Add a Google Places key in Setup → Services to enable discovery.{' '}
            <a href="/admin/setup/services">Add a key</a>
          </>
        ),
        status: 400,
      });
    }
    const extract = extractOf(deps);
    try {
      const report = await runDiscovery(db, id, {
        places: { ...places, budget: newPlacesBudget(db, deps.env, deps.now) },
        now: deps.now ?? (() => new Date()),
        log: console,
        ...(extract ? { extract } : {}),
      });
      // runDiscovery reports budget stops instead of throwing; with no calls made there is nothing to show.
      if (report.stoppedEarly && report.callsUsed === 0) return budgetExhaustedPage(c, report.stopReason ?? 'run');
      const q = new URLSearchParams({
        category: category.slug,
        inserted: String(report.inserted),
        skipped: String(report.skipped),
        calls: String(report.callsUsed),
      });
      if (report.stoppedEarly) q.set('stopped', report.stopReason ?? 'run');
      return c.redirect(`/admin/candidates?${q}`, 302);
    } catch (e) {
      if (e instanceof NoHomeLocation) {
        return listPage(c, { error: 'Set the home location in Settings first', status: 400 });
      }
      if (e instanceof BudgetExhausted) return budgetExhaustedPage(c, e.reason);
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
        ...hoursNeedOf(body['hours_need']),
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
