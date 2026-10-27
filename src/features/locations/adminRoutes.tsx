import { Hono } from 'hono';
import type { AppDeps } from '../../app.js';
import type { LocationStatus } from '../../domain/types.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { page } from '../../web/Layout.js';
import { ReviewQueue } from '../../web/components/ReviewQueue.js';
import { getCategoryBySlug, getCategory, listCategories } from '../categories/repo.js';
import { getLocation, listLocations, type Location } from './repo.js';
import {
  LocationError,
  approveLocation,
  canTransition,
  createManualLocation,
  rejectLocation,
  updateLocation,
  type ManualLocationInput,
} from './service.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
// Blank means "not provided"; anything else must parse as a number (NaN is rejected by validation).
const num = (v: unknown): number | null => (str(v).trim() === '' ? null : Number(str(v)));
const tri = (v: unknown): boolean | null => (str(v) === 'yes' ? true : str(v) === 'no' ? false : null);
const triValue = (v: boolean | null | undefined): string => (v === true ? 'yes' : v === false ? 'no' : '');

const reportLine = (q: Record<string, string>): string | null => {
  if (q['inserted'] === undefined) return null;
  const stopped = q['stopped'] ? ' (stopped early: call cap reached)' : '';
  return `Discovery: inserted ${q['inserted']}, skipped ${q['skipped'] ?? '0'}, calls ${q['calls'] ?? '0'}${stopped}`;
};

const SECTIONS: [LocationStatus, string][] = [
  ['candidate', 'Candidates'],
  ['approved', 'Approved'],
  ['warn', 'Warn'],
  ['rejected', 'Rejected'],
];

type FormValues = Record<
  'category_id' | 'name' | 'address' | 'phone' | 'website' | 'lat' | 'lng' | 'after_hours_notes' | 'walk_ins' | 'insurance_notes' | 'admin_notes',
  string
>;

const toInput = (body: Record<string, unknown>): ManualLocationInput => ({
  categoryId: Number(str(body['category_id'])),
  name: str(body['name']),
  address: str(body['address']),
  phone: str(body['phone']),
  website: str(body['website']),
  lat: num(body['lat']),
  lng: num(body['lng']),
  afterHoursNotes: str(body['after_hours_notes']),
  walkIns: tri(body['walk_ins']),
  insuranceNotes: str(body['insurance_notes']),
  adminNotes: str(body['admin_notes']),
});

const submitted = (body: Record<string, unknown>): FormValues => ({
  category_id: str(body['category_id']),
  name: str(body['name']),
  address: str(body['address']),
  phone: str(body['phone']),
  website: str(body['website']),
  lat: str(body['lat']),
  lng: str(body['lng']),
  after_hours_notes: str(body['after_hours_notes']),
  walk_ins: str(body['walk_ins']),
  insurance_notes: str(body['insurance_notes']),
  admin_notes: str(body['admin_notes']),
});

const EMPTY: FormValues = submitted({});

export function locationsAdminRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  const listPage = (c: Parameters<typeof page>[0], opts: { error?: string; status?: 200 | 409 } = {}) => {
    const all = listLocations(db);
    return page(
      c,
      'Locations',
      <>
        <h1>Locations</h1>
        <AdminNav />
        {opts.error && <p role="alert">{opts.error}</p>}
        <p>
          <a href="/admin/locations/new">New location</a>
        </p>
        {SECTIONS.map(([status, title]) => (
          <section>
            <h2>{title}</h2>
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Category</th>
                  <th>Distance</th>
                  <th>Phone</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {all
                  .filter((l) => l.status === status)
                  .map((l) => (
                    <tr>
                      <td>{l.name}</td>
                      <td>{l.categoryName}</td>
                      <td>{l.distanceMi === null ? '' : `${l.distanceMi.toFixed(1)} mi`}</td>
                      <td>{l.phone}</td>
                      <td>
                        <a href={`/admin/locations/${l.id}/edit`}>Edit</a>
                        {canTransition(l.status, 'approved') && (
                          <form method="post" action={`/admin/locations/${l.id}/approve`}>
                            <button type="submit">Approve</button>
                          </form>
                        )}
                        {canTransition(l.status, 'rejected') && (
                          <form method="post" action={`/admin/locations/${l.id}/reject`}>
                            <button type="submit">Reject</button>
                          </form>
                        )}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </section>
        ))}
      </>,
      opts.status ?? 200,
    );
  };

  const formPage = (
    c: Parameters<typeof page>[0],
    action: string,
    v: FormValues,
    opts: { error?: string; status?: 200 | 400 } = {},
  ) =>
    page(
      c,
      'Location',
      <>
        <h1>Location</h1>
        <AdminNav />
        {opts.error && <p role="alert">{opts.error}</p>}
        <form method="post" action={action}>
          <p>
            <label>
              Category
              <select name="category_id">
                {listCategories(db).map((cat) => (
                  <option value={String(cat.id)} selected={String(cat.id) === v.category_id}>
                    {cat.name}
                  </option>
                ))}
              </select>
            </label>
          </p>
          <p>
            <label>
              Name <input name="name" value={v.name} />
            </label>
          </p>
          <p>
            <label>
              Address <input name="address" value={v.address} />
            </label>
          </p>
          <p>
            <label>
              Phone <input name="phone" value={v.phone} />
            </label>
          </p>
          <p>
            <label>
              Website <input name="website" value={v.website} />
            </label>
          </p>
          <p>
            <label>
              Latitude <input name="lat" value={v.lat} />
            </label>
          </p>
          <p>
            <label>
              Longitude <input name="lng" value={v.lng} />
            </label>
          </p>
          <p>
            <label>
              After-hours notes
              <textarea name="after_hours_notes" rows={3}>
                {v.after_hours_notes}
              </textarea>
            </label>
          </p>
          <p>
            <label>
              Walk-ins
              <select name="walk_ins">
                <option value="" selected={v.walk_ins === ''}>
                  Unknown
                </option>
                <option value="yes" selected={v.walk_ins === 'yes'}>
                  Yes
                </option>
                <option value="no" selected={v.walk_ins === 'no'}>
                  No
                </option>
              </select>
            </label>
          </p>
          <p>
            <label>
              Insurance notes
              <textarea name="insurance_notes" rows={3}>
                {v.insurance_notes}
              </textarea>
            </label>
          </p>
          <p>
            <label>
              Admin notes
              <textarea name="admin_notes" rows={3}>
                {v.admin_notes}
              </textarea>
            </label>
          </p>
          <button type="submit">Save</button>
        </form>
        <p>
          <a href="/admin/locations">Back to locations</a>
        </p>
      </>,
      opts.status ?? 200,
    );

  app.get('/', (c) => listPage(c));

  app.get('/new', (c) => formPage(c, '/admin/locations', EMPTY));

  app.get('/:id/edit', (c) => {
    const loc = getLocation(db, Number(c.req.param('id')));
    if (!loc) return c.notFound();
    return formPage(c, `/admin/locations/${loc.id}`, {
      category_id: String(loc.categoryId),
      name: loc.name,
      address: loc.address ?? '',
      phone: loc.phone ?? '',
      website: loc.website ?? '',
      lat: loc.lat === null ? '' : String(loc.lat),
      lng: loc.lng === null ? '' : String(loc.lng),
      after_hours_notes: loc.afterHoursNotes ?? '',
      walk_ins: triValue(loc.walkIns),
      insurance_notes: loc.insuranceNotes ?? '',
      admin_notes: loc.adminNotes ?? '',
    });
  });

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    try {
      createManualLocation(db, toInput(body), now());
    } catch (e) {
      if (e instanceof LocationError) {
        return formPage(c, '/admin/locations', submitted(body), { error: e.message, status: 400 });
      }
      throw e;
    }
    return c.redirect('/admin/locations', 302);
  });

  const transitionRoute = (act: typeof approveLocation) => async (c: Parameters<typeof page>[0] & { req: { param(n: string): string } }) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    let loc: Location;
    try {
      loc = act(db, id, now());
    } catch (e) {
      if (e instanceof LocationError) {
        if (e.code === 'not_found') return c.notFound();
        return listPage(c, { error: e.message, status: 409 });
      }
      throw e;
    }
    if (str(body['return']) !== '') {
      const slug = getCategory(db, loc.categoryId)?.slug;
      if (slug) return c.redirect(`/admin/candidates?category=${encodeURIComponent(slug)}`, 302);
    }
    return c.redirect('/admin/locations', 302);
  };

  app.post('/:id/approve', transitionRoute(approveLocation));
  app.post('/:id/reject', transitionRoute(rejectLocation));

  app.post('/:id', async (c) => {
    const id = Number(c.req.param('id'));
    const body = await c.req.parseBody();
    try {
      updateLocation(db, id, toInput(body), now());
    } catch (e) {
      if (e instanceof LocationError) {
        if (e.code === 'not_found') return c.notFound();
        return formPage(c, `/admin/locations/${id}`, submitted(body), { error: e.message, status: 400 });
      }
      throw e;
    }
    return c.redirect('/admin/locations', 302);
  });

  return app;
}

export function candidatesRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  app.get('/', (c) => {
    const slug = c.req.query('category');
    const category = slug ? getCategoryBySlug(db, slug) : null;
    if (slug && !category) return c.notFound();
    if (!category) {
      return page(
        c,
        'Candidates',
        <>
          <h1>Candidates</h1>
          <AdminNav />
          <ul>
            {listCategories(db).map((cat) => (
              <li>
                <a href={`/admin/candidates?category=${encodeURIComponent(cat.slug)}`}>{cat.name}</a>
              </li>
            ))}
          </ul>
        </>,
      );
    }
    const report = reportLine(c.req.query());
    const items = listLocations(db)
      .filter((l) => l.status === 'candidate' && l.categoryId === category.id)
      .map((l) => ({
        id: l.id,
        title: l.name,
        subtitle: [
          l.distanceMi === null ? null : `${l.distanceMi.toFixed(1)} mi`,
          l.rating === null ? null : `${l.rating} stars`,
          l.phone,
        ]
          .filter((p) => p !== null)
          .join(' · '),
      }));
    return page(
      c,
      'Candidates',
      <>
        <h1>Candidates: {category.name}</h1>
        <AdminNav />
        {report && <p role="status">{report}</p>}
        <ReviewQueue
          title="Candidates"
          empty="No candidates to review."
          items={items}
          approveAction={(id) => `/admin/locations/${id}/approve`}
          rejectAction={(id) => `/admin/locations/${id}/reject`}
        />
        <p>
          <a href="/admin/candidates">All categories</a>
        </p>
      </>,
    );
  });

  return app;
}
