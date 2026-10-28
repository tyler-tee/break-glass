import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { Child, FC } from 'hono/jsx';
import type { AppDeps } from '../../app.js';
import { slugify } from '../../domain/slug.js';
import { type HouseFactKind, type HouseSystem } from '../../domain/types.js';
import { telHref } from '../../web/format.js';
import { page } from '../../web/Layout.js';
import { Field } from '../admin/setup/shared.js';
import { HOME_CATEGORY_PRESETS, HOME_GUIDE_PRESETS } from '../admin/setup/presets.js';
import { getSettings } from '../admin/settingsRepo.js';
import { CategoryError, createCategory, getCategoryBySlug, listCategories } from '../categories/repo.js';
import { safeReturnTo } from '../locations/adminRoutes.js';
import { getProtocolBySlug } from '../protocols/repo.js';
import {
  HouseFactError, MAX_PHOTOS_PER_FACT, MAX_PHOTO_BYTES, addPhoto, createFact, deleteFact, deletePhoto, getFact, getPhoto,
  listFacts, listPhotos, markChecked, updateFact, type HouseFact, type HouseFactField, type HouseFactInput,
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

const many = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);

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

/* The fact form ---------------------------------------------------------------------------------- */
const KIND_CHOICES: [HouseFactKind, string][] = [
  ['shutoff', 'Shutoff'],
  ['utility', 'Utility'],
  ['contact', 'Contact'],
  ['note', 'Note'],
];
const SYSTEM_CHOICES: [HouseSystem, string][] = [
  ['water', 'Water'],
  ['electric', 'Power'],
  ['hvac', 'AC'],
  ['gas', 'Gas'],
  ['general', 'Other'],
];
const SYSTEM_LABEL = Object.fromEntries(SYSTEM_CHOICES) as Record<HouseSystem, string>;
const PRIVACY = "Anyone on your home Wi-Fi can see this. Don't add alarm, lockbox or gate codes, or account numbers.";

type FormValues = Record<'kind' | 'system' | 'title' | 'where_note' | 'instructions' | 'org' | 'phone' | 'category_id', string>;
type FieldErrors = Partial<Record<HouseFactField, string>>;

const NEW_VALUES: FormValues = {
  kind: 'shutoff', system: 'water', title: '', where_note: '', instructions: '', org: '', phone: '', category_id: '',
};
const valuesOf = (f: HouseFact): FormValues => ({
  kind: f.kind,
  system: f.system,
  title: f.title,
  where_note: f.whereNote ?? '',
  instructions: f.instructions ?? '',
  org: f.org ?? '',
  phone: f.phone ?? '',
  category_id: f.categoryId === null ? '' : String(f.categoryId),
});
const submitted = (body: Record<string, unknown>): FormValues => ({
  kind: str(body['kind']),
  system: str(body['system']),
  title: str(body['title']),
  where_note: str(body['where_note']),
  instructions: str(body['instructions']),
  org: str(body['org']),
  phone: str(body['phone']),
  category_id: str(body['category_id']),
});

const AlertIcon: FC = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
    <path d="M12 9v4M12 17h.01" />
  </svg>
);

const Seg: FC<{ legend: string; name: string; value: string; options: [string, string][]; error: string | undefined; five?: boolean }> = ({
  legend, name, value, options, error, five,
}) => (
  <fieldset class="seg-field">
    <legend>{legend}</legend>
    <div class={five ? 'seg five' : 'seg'}>
      {options.map(([v, label]) => (
        <label>
          <input type="radio" name={name} value={v} checked={value === v} />
          <span>{label}</span>
        </label>
      ))}
    </div>
    {error && (
      <p class="field-error" role="alert">
        {error}
      </p>
    )}
  </fieldset>
);

const FactForm: FC<{
  action: string;
  v: FormValues;
  errors: FieldErrors;
  topError: string | undefined;
  homeCategories: { id: number; name: string }[];
  edit: boolean;
}> = ({ action, v, errors, topError, homeCategories, edit }) => {
  const first = (['kind', 'system', 'title', 'where_note', 'instructions', 'org', 'phone', 'category_id'] as const).find((k) => errors[k]);
  return (
    <form method="post" action={action} class="admin-form fact-form" data-fact-form>
      {topError && <p role="alert">{topError}</p>}
      <Seg legend="What kind" name="kind" value={v.kind} options={KIND_CHOICES} error={errors.kind} />
      <Seg legend="System" name="system" value={v.system} options={SYSTEM_CHOICES} error={errors.system} five />
      <Field id="title" label="Name" error={errors.title} control={(d, bad) => (
        <input id="title" name="title" value={v.title} maxlength={80} autocomplete="off" aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'title'} />
      )} />
      <div data-kinds="shutoff">
        <Field id="where_note" label="Where is it?" hint="Needed for shutoffs." error={errors.where_note} control={(d, bad) => (
          <textarea id="where_note" name="where_note" rows={2} maxlength={300} aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'where_note'}>{v.where_note}</textarea>
        )} />
      </div>
      <div>
        <Field id="instructions" label="How to use it (optional)" hint="For a note, write the note here." error={errors.instructions} control={(d, bad) => (
          <textarea id="instructions" name="instructions" rows={3} maxlength={2000} placeholder="For example: quarter turn clockwise; the key is in the garage" aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'instructions'}>
            {v.instructions}
          </textarea>
        )} />
      </div>
      <div data-kinds="utility contact">
        <Field id="org" label="Company" hint="For utilities and contacts." error={errors.org} control={(d, bad) => (
          <input id="org" name="org" value={v.org} maxlength={80} autocomplete="off" aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'org'} />
        )} />
      </div>
      <div data-kinds="utility contact">
        <Field id="phone" label="Phone" hint="Needed for utilities and contacts." error={errors.phone} control={(d, bad) => (
          <input id="phone" name="phone" type="tel" value={v.phone} autocomplete="off" aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'phone'} />
        )} />
      </div>
      <div data-kinds="contact">
        <Field id="category_id" label="Trade (optional)" hint="For contacts only. Shows this contact first on guides for that trade." error={errors.category_id} control={(d, bad) => (
          <select id="category_id" name="category_id" aria-describedby={d} aria-invalid={bad ? 'true' : undefined} autofocus={first === 'category_id'}>
            <option value="">(no trade)</option>
            {homeCategories.map((c) => (
              <option value={String(c.id)} selected={v.category_id === String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        )} />
      </div>
      <p class="privacy">
        <AlertIcon />
        <span>{PRIVACY}</span>
      </p>
      {!edit && <p class="field-hint">Save the fact first, then you can add photos of it.</p>}
      {edit && <p class="field-hint">Saving also marks this fact as checked today.</p>}
      <button type="submit" class="btn">
        Save fact
      </button>
    </form>
  );
};

/* Photos on the edit page ----------------------------------------------------------------------- */
type PhotoRow = { id: number; caption: string | null };

const PhotosCard: FC<{ factId: number; photos: PhotoRow[]; error: string | undefined }> = ({ factId, photos, error }) => {
  const back = `/admin/house/${factId}/edit#photos`;
  return (
    <section class="card" id="photos" aria-labelledby="photos-h">
      <h2 id="photos-h">Photos</h2>
      <p class="muted">
        {photos.length} of {MAX_PHOTOS_PER_FACT}. Photos are shrunk on your phone before they upload.
      </p>
      {error && <p role="alert">{error}</p>}
      {photos.length > 0 && (
        <ul class="photo-list">
          {photos.map((p) => (
            <li>
              <img src={`/house/photos/${p.id}`} alt={p.caption ?? ''} width="120" height="90" loading="lazy" />
              {p.caption && <span class="cap">{p.caption}</span>}
              <form method="post" action={`/admin/house/photos/${p.id}/delete`}>
                <input type="hidden" name="return_to" value={back} />
                <button type="submit" class="btn-danger">
                  Remove
                </button>
              </form>
            </li>
          ))}
        </ul>
      )}
      {photos.length < MAX_PHOTOS_PER_FACT ? (
        <form method="post" action={`/admin/house/${factId}/photos`} enctype="multipart/form-data" class="photo-form" data-photo-form>
          <input type="hidden" name="return_to" value={back} />
          <div class="photo-pick">
            <label class="photo-btn btn">
              <span>Take photo</span>
              <input type="file" name="photo" accept="image/*" capture="environment" />
            </label>
            <label class="photo-btn btn btn-secondary">
              <span>Choose file</span>
              <input type="file" name="photo_file" accept="image/*" />
            </label>
          </div>
          <p class="field-hint" data-photo-name hidden></p>
          <div class="field">
            <label for="caption">Caption (optional)</label>
            <input id="caption" name="caption" maxlength={200} autocomplete="off" />
          </div>
          <button type="submit" class="btn">
            Add photo
          </button>
        </form>
      ) : (
        <p class="muted">That is the most a fact can have. Remove one to add another.</p>
      )}
    </section>
  );
};

/* The list page --------------------------------------------------------------------------------- */
const SECTIONS: { title: string; kinds: HouseFactKind[]; empty: string }[] = [
  { title: 'Shutoffs', kinds: ['shutoff'], empty: 'No shutoffs yet. Add the water main, the breaker panel, the AC air handler.' },
  { title: 'Who to call', kinds: ['utility', 'contact'], empty: 'No utilities or contacts yet.' },
  { title: 'Notes', kinds: ['note'], empty: 'No notes yet.' },
];

type Photo = { id: number; caption: string | null };

const FactCard: FC<{ f: HouseFact; photos: Photo[]; trade: string | undefined; checked: string }> = ({ f, photos, trade, checked }) => {
  const edit = `/admin/house/${f.id}/edit`;
  return (
    <li class="fact">
      <div class="fact-main">
        <h3>
          <a href={edit}>{f.title}</a> <span class="sys">{SYSTEM_LABEL[f.system]}</span>
        </h3>
        {f.whereNote && <p>{f.whereNote}</p>}
        {(f.org || f.phone) && (
          <p>
            {f.org}
            {f.org && f.phone ? ' · ' : ''}
            {f.phone && <a href={telHref(f.phone)}>{f.phone}</a>}
          </p>
        )}
        {f.kind === 'note' && f.instructions && <p class="muted">{f.instructions}</p>}
        {trade && <p class="muted">Trade: {trade}</p>}
        {photos.length > 0 && (
          <div class="thumbs">
            {photos.map((p) => (
              <a href={edit}>
                <img src={`/house/photos/${p.id}`} alt={p.caption ?? 'Photo'} width="56" height="56" loading="lazy" />
              </a>
            ))}
          </div>
        )}
        <p class="muted">Checked {checked}</p>
      </div>
      <div class="row-actions">
        <a href={edit}>Edit</a>
        <form method="post" action={`/admin/house/${f.id}/check`}>
          <button type="submit" class="btn-secondary">
            Still right
          </button>
        </form>
      </div>
    </li>
  );
};

/** Mounted under /admin, after requireAdmin and requireSameOrigin. */
export function houseAdminRoutes(deps: AppDeps): Hono {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  const dateText = (d: Date | null): string => {
    if (d === null) return 'never';
    try {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: getSettings(db).homeTz });
    } catch {
      return d.toISOString().slice(0, 10);
    }
  };

  const listPage = (c: Parameters<typeof page>[0], opts: { error?: string; notice?: Child; status?: 200 | 400 } = {}) => {
    const facts = listFacts(db);
    const homeCats = listCategories(db, { area: 'home' });
    const tradeName = new Map(homeCats.map((cat) => [cat.id, cat.name]));
    return page(
      c,
      'House',
      <>
        <h1>House</h1>
        <p class="lede">Shutoffs, utilities and who to call for home emergencies. The family sees these next to the guides that use them.</p>
        {opts.error && <p role="alert">{opts.error}</p>}
        {opts.notice && <p class="notice notice-status" role="status">{opts.notice}</p>}
        <div class="page-actions">
          <a class="btn" href="/admin/house/new">
            Add a fact
          </a>
        </div>
        {homeCats.length === 0 ? (
          <section class="card" aria-labelledby="setup-h">
            <h2 id="setup-h">Set up Home</h2>
            <p>Pick the trades you would call for a home emergency. Each becomes a category you can run Find places on.</p>
            <form method="post" action="/admin/house/setup">
              {HOME_CATEGORY_PRESETS.map((p) => (
                <div class="check">
                  <input type="checkbox" id={`preset-${p.slug}`} name="preset" value={p.slug} checked={p.checked} />
                  <label for={`preset-${p.slug}`}>
                    {p.name}
                    <span class="field-hint"> Looks for {p.searchTerms.join(' and ')}.</span>
                  </label>
                </div>
              ))}
              <button type="submit" class="btn">
                Set up Home
              </button>
            </form>
          </section>
        ) : (
          <p class="muted">
            Home trades are set up. <a href="/admin/places/find">Find places for them</a>.
          </p>
        )}
        {SECTIONS.map((sec) => {
          const rows = facts.filter((f) => (sec.kinds as string[]).includes(f.kind));
          return (
            <section aria-labelledby={`sec-${sec.kinds[0]}`}>
              <h2 id={`sec-${sec.kinds[0]}`}>{sec.title}</h2>
              {rows.length === 0 ? (
                <p class="muted">{sec.empty}</p>
              ) : (
                <ul class="fact-list">
                  {rows.map((f) => (
                    <FactCard
                      f={f}
                      photos={listPhotos(db, f.id)}
                      trade={f.categoryId === null ? undefined : tradeName.get(f.categoryId)}
                      checked={dateText(f.checkedAt)}
                    />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        <section class="card" aria-labelledby="guides-h">
          <h2 id="guides-h">Start these guides</h2>
          <p class="muted">Each opens the new protocol form with the title and tags filled in.</p>
          <ul class="list guide-list">
            {HOME_GUIDE_PRESETS.map((g) => {
              const existing = getProtocolBySlug(db, slugify(g.title));
              const href = `/admin/protocols/new?area=home&title=${encodeURIComponent(g.title)}&tags=${encodeURIComponent(g.tags.join(', '))}`;
              return (
                <li>
                  {existing ? (
                    <>
                      <a href={`/admin/protocols/${existing.id}`}>{g.title}</a> <span class="muted">Already started</span>
                    </>
                  ) : (
                    <a href={href}>{g.title}</a>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      </>,
      opts.status ?? 200,
      { layout: 'admin', activeNav: 'house' },
    );
  };

  const formPage = (
    c: Parameters<typeof page>[0],
    o: {
      fact?: HouseFact;
      values: FormValues;
      errors?: FieldErrors;
      topError?: string;
      notice?: string;
      photoError?: string;
      status?: 200 | 400;
    },
  ) => {
    const fact = o.fact;
    const homeCategories = listCategories(db, { area: 'home' }).map((cat) => ({ id: cat.id, name: cat.name }));
    return page(
      c,
      fact ? 'Edit house fact' : 'Add a house fact',
      <>
        <h1>{fact ? 'Edit house fact' : 'Add a house fact'}</h1>
        {o.notice && <p class="notice notice-status" role="status">{o.notice}</p>}
        <FactForm
          action={fact ? `/admin/house/${fact.id}` : '/admin/house'}
          v={o.values}
          errors={o.errors ?? {}}
          topError={o.topError}
          homeCategories={homeCategories}
          edit={fact !== undefined}
        />
        {fact && <PhotosCard factId={fact.id} photos={listPhotos(db, fact.id)} error={o.photoError} />}
        {fact && (
          <section class="card" aria-label="Check or delete">
            <p class="muted">Checked {dateText(fact.checkedAt)}</p>
            <div class="button-row">
              <form method="post" action={`/admin/house/${fact.id}/check`}>
                <input type="hidden" name="return_to" value={`/admin/house/${fact.id}/edit`} />
                <button type="submit" class="btn-secondary">
                  Still right
                </button>
              </form>
              <form method="post" action={`/admin/house/${fact.id}/delete`}>
                <button type="submit" class="btn-danger">
                  Delete fact
                </button>
              </form>
            </div>
          </section>
        )}
        <p>
          <a href="/admin/house">Back to House</a>
        </p>
      </>,
      o.status ?? 200,
      { layout: 'admin', activeNav: 'house' },
    );
  };

  /** A validation error lands on its field; one without a field shows at the top. */
  const errorsOf = (e: HouseFactError): { errors: FieldErrors; topError?: string } =>
    e.field && e.field !== 'photo' ? { errors: { [e.field]: e.message } } : { errors: {}, topError: e.message };

  app.get('/', (c) => listPage(c, c.req.query('setup') === '1' ? { notice: 'Home trades added. Next, find places for them.' } : {}));

  app.get('/new', (c) => formPage(c, { values: NEW_VALUES }));

  app.get('/:id/edit', (c) => {
    const id = idOf(c.req.param('id'));
    const fact = id === null ? null : getFact(db, id);
    if (!fact) return c.notFound();
    return formPage(c, { fact, values: valuesOf(fact), ...(c.req.query('saved') === '1' ? { notice: 'Saved. You can add photos below.' } : {}) });
  });

  app.post('/', async (c) => {
    const body = await c.req.parseBody();
    let fact: HouseFact;
    try {
      fact = createFact(db, toInput(body), now());
    } catch (e) {
      if (e instanceof HouseFactError) return formPage(c, { values: submitted(body), ...errorsOf(e), status: 400 });
      throw e;
    }
    // A shutoff is usually added standing at the valve, so go straight to its photos.
    const next = fact.kind === 'shutoff' ? `/admin/house/${fact.id}/edit?saved=1#photos` : '/admin/house';
    return c.redirect(safeReturnTo(body['return_to']) ?? next, 302);
  });

  app.post('/setup', async (c) => {
    const body = await c.req.parseBody({ all: true });
    const chosen = new Set(many(body['preset']));
    const picked = HOME_CATEGORY_PRESETS.filter((p) => chosen.has(p.slug));
    if (picked.length === 0) return listPage(c, { error: 'Pick at least one trade to set up.', status: 400 });
    for (const p of picked) {
      if (getCategoryBySlug(db, p.slug)) continue; // idempotent by slug
      try {
        createCategory(db, { name: p.name, searchTerms: [...p.searchTerms], hoursNeed: p.hoursNeed, area: 'home' });
      } catch (e) {
        if (!(e instanceof CategoryError && e.code === 'duplicate')) throw e;
      }
    }
    return c.redirect('/admin/house?setup=1', 302);
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
    const fact = factId === null ? null : getFact(db, factId);
    if (!fact) return c.notFound();
    const body = await c.req.parseBody();
    // "Take photo" and "Choose file" are two inputs; whichever one holds a file is the photo.
    const file = [body['photo'], body['photo_file']].find((f): f is File => f instanceof File && f.size > 0);
    const fail = (message: string) =>
      formPage(c, { fact, values: valuesOf(fact), photoError: message, status: 400 });
    if (!file) return fail('Choose a photo to upload');
    try {
      addPhoto(db, fact.id, new Uint8Array(await file.arrayBuffer()), str(body['caption']), now());
    } catch (e) {
      if (e instanceof HouseFactError) return e.code === 'not_found' ? c.notFound() : fail(e.message);
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin', 302);
  });

  app.post('/:id/check', async (c) => {
    const id = idOf(c.req.param('id'));
    const body = await c.req.parseBody();
    try {
      if (id === null) return c.notFound();
      markChecked(db, id, now());
    } catch (e) {
      if (e instanceof HouseFactError) return c.notFound();
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin/house', 302);
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
        return formPage(c, { fact: getFact(db, id)!, values: submitted(body), ...errorsOf(e), status: 400 });
      }
      throw e;
    }
    return c.redirect(safeReturnTo(body['return_to']) ?? '/admin/house', 302);
  });

  return app;
}
