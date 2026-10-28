import { Hono } from 'hono';
import type { Child } from 'hono/jsx';
import type { AppDeps } from '../../app.js';
import { page } from '../../web/Layout.js';
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
        <div class="page-actions">
          <a class="btn btn-secondary" href="/admin/categories/new">
            New category
          </a>
          <a href="/admin/places/find">Find &amp; rank places for these categories</a>
        </div>
        <table class="stack-table t-categories">
          <thead>
            <tr>
              <th>Name</th>
              <th>Slug</th>
              <th>Search terms</th>
              <th>Hours</th>
              <th>Area</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {listCategories(db).map((cat) => (
              <tr>
                <td>{cat.name}</td>
                <td>{cat.slug}</td>
                <td>{cat.searchTerms.join(', ')}</td>
                <td>{cat.hoursNeed === 'daytime' ? 'Daytime' : 'Overnight'}</td>
                <td>{cat.area === 'home' ? 'Home' : 'Health'}</td>
                <td class="row-actions">
                  <a href={`/admin/categories/${cat.id}/edit`}>Edit</a>
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
