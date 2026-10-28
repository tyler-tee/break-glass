import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Child } from 'hono/jsx';
import type { AppDeps } from '../../app.js';
import { HOUSE_FACT_KINDS, HOUSE_SYSTEMS } from '../../domain/types.js';
import { page } from '../../web/Layout.js';
import { listCategories } from '../categories/repo.js';
import { safeReturnTo } from '../locations/adminRoutes.js';
import {
  HouseFactError, MAX_PHOTO_BYTES, addPhoto, createFact, deleteFact, deletePhoto, getPhoto, listFacts, listPhotos,
  updateFact, type HouseFact, type HouseFactInput,
} from './repo.js';

/** Multipart framing and the caption field on top of the largest allowed photo. */
export const UPLOAD_BODY_LIMIT_BYTES = MAX_PHOTO_BYTES + 64 * 1024;
/** The one route the app-wide body limit skips: POST /admin/house/:id/photos. */
export const UPLOAD_PATH = /^\/admin\/house\/\d+\/photos\/?$/;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const idOf = (raw: string): number | null => (/^\d+$/.test(raw) ? Number(raw) : null);

/** Unauthenticated, like the rest of the family side. Mounted at /house. */
export function housePublicRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const app = new Hono();
  app.get('/photos/:id', (c) => {
    const id = idOf(c.req.param('id'));
    const photo = id === null ? null : getPhoto(db, id);
    if (!photo) return c.notFound();
    const etag = `"${photo.sha256}"`;
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      ETag: etag,
      'Cache-Control': 'private, max-age=86400',
    };
    const inm = c.req.header('if-none-match');
    if (inm && inm.split(',').some((t) => [etag, `W/${etag}`, '*'].includes(t.trim()))) {
      return new Response(null, { status: 304, headers });
    }
    return new Response(new Uint8Array(photo.bytes), { status: 200, headers: { ...headers, 'Content-Type': photo.mime } });
  });
  return app;
}

const toInput = (body: Record<string, unknown>): HouseFactInput => {
  const cat = str(body['category_id']).trim();
  return {
    kind: str(body['kind']),
    system: str(body['system']),
    title: str(body['title']),
    whereNote: str(body['where_note']),
    instructions: str(body['instructions']),
    org: str(body['org']),
    phone: str(body['phone']),
    categoryId: cat === '' ? null : Number(cat),
  };
};

/** Mounted under /admin, after requireAdmin and requireSameOrigin. Bare, unstyled forms until the mockup. */
export function houseAdminRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  const factForm = (action: string, f: Partial<HouseFact>, label: string): Child => (
    <form method="post" action={action}>
      <select name="kind">
        {HOUSE_FACT_KINDS.map((k) => (
          <option value={k} selected={f.kind === k}>{k}</option>
        ))}
      </select>
      <select name="system">
        {HOUSE_SYSTEMS.map((s) => (
          <option value={s} selected={(f.system ?? 'general') === s}>{s}</option>
        ))}
      </select>
      <input name="title" placeholder="Title" value={f.title ?? ''} />
      <input name="where_note" placeholder="Where" value={f.whereNote ?? ''} />
      <input name="org" placeholder="Company" value={f.org ?? ''} />
      <input name="phone" placeholder="Phone" value={f.phone ?? ''} />
      <select name="category_id">
        <option value="">(no category)</option>
        {listCategories(db, { area: 'home' }).map((c) => (
          <option value={String(c.id)} selected={f.categoryId === c.id}>{c.name}</option>
        ))}
      </select>
      <textarea name="instructions" placeholder="Instructions">{f.instructions ?? ''}</textarea>
      <button type="submit">{label}</button>
    </form>
  );

  const listPage = (c: Parameters<typeof page>[0], opts: { error?: string; status?: 200 | 400 } = {}) =>
    page(
      c,
      'House facts',
      <>
        <h1>House facts</h1>
        {opts.error && <p role="alert">{opts.error}</p>}
        <h2>Add a fact</h2>
        {factForm('/admin/house', {}, 'Add')}
        {listFacts(db).map((f) => (
          <section>
            <h2>{f.title} ({f.kind}, {f.system})</h2>
            {factForm(`/admin/house/${f.id}`, f, 'Save')}
            {listPhotos(db, f.id).map((p) => (
              <form method="post" action={`/admin/house/photos/${p.id}/delete`}>
                <input type="hidden" name="return_to" value="/admin/house" />
                <img src={`/house/photos/${p.id}`} alt={p.caption ?? ''} width="120" />
                <button type="submit">Delete photo</button>
              </form>
            ))}
            <form method="post" action={`/admin/house/${f.id}/photos`} enctype="multipart/form-data">
              <input type="hidden" name="return_to" value="/admin/house" />
              <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
              <input name="caption" placeholder="Caption" />
              <button type="submit">Add photo</button>
            </form>
            <form method="post" action={`/admin/house/${f.id}/delete`}>
              <button type="submit">Delete fact</button>
            </form>
          </section>
        ))}
      </>,
      opts.status ?? 200,
      { layout: 'admin' },
    );

  app.get('/', (c) => listPage(c));

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    try {
      createFact(db, toInput(body), now());
    } catch (e) {
      if (e instanceof HouseFactError) return listPage(c, { error: e.message, status: 400 });
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin/house', 302);
  });

  // Photo routes first so "photos" is never read as a fact id.
  app.post('/photos/:id/delete', async (c) => {
    const id = idOf(c.req.param('id'));
    const body = await c.req.parseBody();
    try {
      if (id === null) return c.notFound();
      deletePhoto(db, id);
    } catch (e) {
      if (e instanceof HouseFactError) return c.notFound();
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin', 302);
  });

  // Auth and the same-origin check ran as router middleware before this point, so nothing is parsed for an
  // unauthenticated caller. This route's own limit replaces the app-wide one (see UPLOAD_PATH in app.ts).
  app.post('/:factId/photos', bodyLimit({ maxSize: UPLOAD_BODY_LIMIT_BYTES }), async (c) => {
    const factId = idOf(c.req.param('factId'));
    if (factId === null) return c.notFound();
    const body = await c.req.parseBody();
    const file = body['photo'];
    if (!(file instanceof File) || file.size === 0) return c.text('Choose a photo to upload', 400);
    try {
      addPhoto(db, factId, new Uint8Array(await file.arrayBuffer()), str(body['caption']), now());
    } catch (e) {
      if (e instanceof HouseFactError) return e.code === 'not_found' ? c.notFound() : c.text(e.message, 400);
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin', 302);
  });

  app.post('/:id/delete', (c) => {
    const id = idOf(c.req.param('id'));
    try {
      if (id === null) return c.notFound();
      deleteFact(db, id);
    } catch (e) {
      if (e instanceof HouseFactError) return c.notFound();
      throw e;
    }
    return c.redirect('/admin/house', 302);
  });

  app.post('/:id', async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.notFound();
    const body = await c.req.parseBody();
    try {
      updateFact(db, id, toInput(body), now());
    } catch (e) {
      if (e instanceof HouseFactError) {
        if (e.code === 'not_found') return c.notFound();
        return listPage(c, { error: e.message, status: 400 });
      }
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin/house', 302);
  });

  return app;
}
