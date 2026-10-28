import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { locations, placesUsage, settings } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createSecretsStore } from '../../src/features/admin/secrets.js';
import { CATEGORY_PRESETS } from '../../src/features/admin/setup/presets.js';
import { createCategory, listCategories } from '../../src/features/categories/repo.js';
import { makeServiceResolver } from '../../src/services/resolver.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const PW = 'correct horse battery';
const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');
const KEY = 'AIzaSyWIZARD-places-key-1234';
let HASH: string;
beforeAll(async () => {
  HASH = await hashPassword(PW);
});

async function harness(opts: { key?: boolean; fetch?: typeof fetch; home?: boolean } = {}) {
  const db = createTestDb(); // seeded home 40.7608, -111.891 (matches the recorded fixtures)
  if (opts.home === false) db.update(settings).set({ homeLat: null, homeLng: null }).where(eq(settings.id, 1)).run();
  const env = loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: HASH });
  const secrets = createSecretsStore(db, env);
  if (opts.key) secrets.setPlacesKey(KEY);
  const resolve = makeServiceResolver(db, env, secrets, { fetch: opts.fetch ?? recordingFetch(FIXTURE_DIR, 'replay') });
  const app = createApp({ db, env, secrets, resolve, now: () => now, scheduler: { reschedule: vi.fn() } });
  const cookie = await adminLogin(app, PW);
  const get = (p: string) => app.request(p, { headers: { cookie } });
  const post = (p: string, fields: Record<string, string | string[]>) => {
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
    return app.request(p, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: body.toString(),
    });
  };
  return { db, app, get, post };
}

const slugs = (db: ReturnType<typeof createTestDb>) => listCategories(db).map((c) => c.slug).sort();

describe('categories step', () => {
  it('lists the six presets with their terms and targets', () => {
    expect(CATEGORY_PRESETS.map((p) => [p.name, p.slug, p.targetCount])).toEqual([
      ['Urgent care', 'urgent-care', 3],
      ['Emergency room', 'emergency-room', 2],
      ['24-hour pharmacy', '24-hour-pharmacy', 2],
      ['Dentist (emergency)', 'dentist-emergency', 3],
      ['Emergency vet', 'emergency-vet', 2],
      ['Pediatrician', 'pediatrician', 3],
    ]);
    expect(CATEGORY_PRESETS[0]!.searchTerms).toEqual(['urgent care', 'walk-in clinic']);
  });

  it('creating presets is idempotent and existing ones render checked, disabled and "Already added"', async () => {
    const { db, post, get } = await harness();
    const fields = { preset: ['urgent-care', 'emergency-room', 'pediatrician'], go: 'next' };
    const res = await post('/admin/setup/categories', fields);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/places');
    expect(listCategories(db)).toHaveLength(3);
    const urgent = listCategories(db).find((c) => c.slug === 'urgent-care')!;
    expect(urgent).toMatchObject({ name: 'Urgent care', searchTerms: ['urgent care', 'walk-in clinic'], targetCount: 3 });

    const again = await post('/admin/setup/categories', fields);
    expect(again.status).toBe(302);
    expect(listCategories(db)).toHaveLength(3);

    const html = await (await get('/admin/setup/categories')).text();
    expect(html.match(/Already added/g)).toHaveLength(3);
    const input = (slug: string) => html.match(new RegExp(`<input[^>]*value="${slug}"[^>]*>`))![0];
    expect(input('urgent-care')).toContain('checked');
    expect(input('urgent-care')).toContain('disabled');
    expect(input('emergency-vet')).not.toContain('checked');
    expect(input('emergency-vet')).not.toContain('disabled');
  });

  it('adds a custom category with terms split on lines and commas, default target 5', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/categories', {
      custom_name: 'Eye doctor',
      custom_terms: 'eye doctor\noptometrist, ophthalmologist',
      custom_target: '',
      go: 'next',
    });
    expect(res.status).toBe(302);
    expect(listCategories(db)[0]).toMatchObject({
      slug: 'eye-doctor',
      searchTerms: ['eye doctor', 'optometrist', 'ophthalmologist'],
      targetCount: 5,
    });
  });

  it('custom validation errors re-render with 400, an alert beside the field, and save nothing', async () => {
    const { db, post } = await harness();
    const cases: [Record<string, string>, string, RegExp][] = [
      [{ custom_name: '', custom_terms: 'eye doctor' }, 'custom_name', /Name is required/],
      [{ custom_name: '***', custom_terms: 'x' }, 'custom_name', /letters or numbers/],
      [{ custom_name: 'Eye doctor', custom_terms: '  , ' }, 'custom_terms', /search term/],
      [{ custom_name: 'Eye doctor', custom_terms: 'eyes', custom_target: '0' }, 'custom_target', /whole number/],
      [{ custom_name: 'Eye doctor', custom_terms: 'eyes', custom_target: 'abc' }, 'custom_target', /whole number/],
    ];
    for (const [fields, field, message] of cases) {
      // custom_name '' with terms filled counts as an attempt, so it must be reported
      const res = await post('/admin/setup/categories', { preset: 'urgent-care', ...fields, go: 'next' });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      const html = await res.text();
      expect(html).toMatch(new RegExp(`id="${field}-error" role="alert">[^<]*`));
      expect(html).toMatch(message);
      expect(html).toContain('aria-invalid="true"');
      expect(listCategories(db)).toHaveLength(0);
    }
  });

  it('a custom name that matches a checked preset does not fail', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/categories', {
      preset: 'urgent-care',
      custom_name: 'Urgent care',
      custom_terms: 'urgent care',
      go: 'next',
    });
    expect(res.status).toBe(302);
    expect(slugs(db)).toEqual(['urgent-care']);
  });

  it('requires at least one category to save and continue, but Skip for now still works', async () => {
    const { db, post, get } = await harness();
    const res = await post('/admin/setup/categories', { go: 'next' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/role="alert"[^>]*>[^<]*Pick at least one/);
    expect(listCategories(db)).toHaveLength(0);

    const skip = await post('/admin/setup/categories', { go: 'skip' });
    expect(skip.status).toBe(302);
    expect(skip.headers.get('location')).toBe('/admin/setup/places');
    const back = await post('/admin/setup/categories', { preset: 'urgent-care', go: 'back' });
    expect(back.headers.get('location')).toBe('/admin/setup/home');
    expect(listCategories(db)).toHaveLength(0);

    // Existing categories satisfy the rule even when nothing new is checked.
    createCategory(db, { name: 'Eye doctor', searchTerms: ['eyes'] });
    const ok = await post('/admin/setup/categories', { go: 'next' });
    expect(ok.status).toBe(302);
    expect(await (await get('/admin/setup/categories')).text()).toContain('Eye doctor');
  });

  it('lists existing non-preset categories as already added, with an edit link', async () => {
    const { db, get } = await harness();
    const eye = createCategory(db, { name: 'Eye doctor', searchTerms: ['eyes'] });
    createCategory(db, { name: 'Urgent care', searchTerms: ['urgent care'] });
    const html = await (await get('/admin/setup/categories')).text();
    expect(html).toMatch(/<legend>Already added<\/legend>[\s\S]*Eye doctor/);
    expect(html).toContain(`href="/admin/categories/${eye.id}/edit"`);
    // Presets stay in the preset list, not in the custom list.
    const custom = html.slice(html.indexOf('<legend>Already added</legend>'), html.indexOf('<legend>Add your own</legend>'));
    expect(custom).not.toContain('Urgent care');
  });

  it('errors carry the field they belong to', async () => {
    const { db } = await harness();
    const field = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { field?: string }).field;
      }
    };
    expect(field(() => createCategory(db, { name: '', searchTerms: ['x'] }))).toBe('name');
    expect(field(() => createCategory(db, { name: 'A', searchTerms: [] }))).toBe('search_terms');
    expect(field(() => createCategory(db, { name: 'A', searchTerms: ['x'], targetCount: 0 }))).toBe('target_count');
    createCategory(db, { name: 'A', searchTerms: ['x'] });
    expect(field(() => createCategory(db, { name: 'a', searchTerms: ['x'] }))).toBe('name');
  });

  it('Finish later saves the checked presets and goes to the overview', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/categories', { preset: ['emergency-vet'], go: 'later' });
    expect(res.headers.get('location')).toBe('/admin');
    expect(slugs(db)).toEqual(['emergency-vet']);
  });
});

describe('places step without a key', () => {
  it('offers only manual entry, a note about the key, and 0 approved of target N per category', async () => {
    const { db, get } = await harness();
    createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'], targetCount: 3 });
    const res = await get('/admin/setup/places');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('0 approved of target 3');
    expect(html).toContain('Add a place by hand');
    expect(html).not.toContain('>Find places</button>');
    expect(html).not.toContain('/admin/setup/places/discover/');
    expect(html).toMatch(/Google Places key[^<]*<a href="\/admin\/setup\/services">/);
  });

  it('counts approved and warn locations toward the target', async () => {
    const { db, get } = await harness();
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'], targetCount: 4 });
    const at = new Date();
    for (const [name, status] of [['A', 'approved'], ['B', 'warn'], ['C', 'candidate'], ['D', 'rejected']] as const) {
      db.insert(locations).values({ categoryId: cat.id, name, status, createdAt: at, updatedAt: at }).run();
    }
    expect(await (await get('/admin/setup/places')).text()).toContain('2 approved of target 4');
  });

  it('with no categories it points back to the Categories step', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/places')).text();
    expect(html).toContain('href="/admin/setup/categories"');
  });

  it('adds a place by hand as a candidate, back on the wizard, then approves it in place', async () => {
    const { db, post, get } = await harness();
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'] });
    const res = await post('/admin/setup/places/manual', {
      category_id: String(cat.id),
      name: 'Corner Dental',
      address: '1 Main St',
      phone: '801-555-0199',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/^\/admin\/setup\/places(\?|#)/);
    const row = db.select().from(locations).get()!;
    expect(row).toMatchObject({ name: 'Corner Dental', status: 'candidate', placeId: null });

    const html = await (await get('/admin/setup/places')).text();
    expect(html).toContain('Corner Dental');
    expect(html).toContain(`/admin/locations/${row.id}/approve`);
    expect(html).toContain('name="return_to" value="/admin/setup/places#test-dentist"');

    const approve = await post(`/admin/locations/${row.id}/approve`, { return_to: '/admin/setup/places#test-dentist' });
    expect(approve.status).toBe(302);
    expect(approve.headers.get('location')).toBe('/admin/setup/places#test-dentist');
    expect(db.select().from(locations).get()!.status).toBe('approved');
    expect(await (await get('/admin/setup/places')).text()).toContain('1 approved of target 5');
  });

  it('manual-add validation errors re-render on the wizard with 400 and an alert', async () => {
    const { db, post } = await harness();
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'] });
    const res = await post('/admin/setup/places/manual', { category_id: String(cat.id), name: ' ' });
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toMatch(/id="manual_name-error" role="alert">[^<]*Name is required/);
    expect(html).toContain('Step 5 of 7');
    expect(db.select().from(locations).all()).toHaveLength(0);
  });

  it('Save and continue, Skip for now, Back and Finish later move between steps', async () => {
    const { post } = await harness();
    expect((await post('/admin/setup/places', { go: 'next' })).headers.get('location')).toBe('/admin/setup/protocol');
    expect((await post('/admin/setup/places', { go: 'skip' })).headers.get('location')).toBe('/admin/setup/protocol');
    expect((await post('/admin/setup/places', { go: 'back' })).headers.get('location')).toBe('/admin/setup/categories');
    expect((await post('/admin/setup/places', { go: 'later' })).headers.get('location')).toBe('/admin');
  });
});

describe('places step with a Places key', () => {
  const setup = async (opts: Parameters<typeof harness>[0] = {}) => {
    const h = await harness({ key: true, ...opts });
    const cat = createCategory(h.db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] });
    return { ...h, cat };
  };

  it('shows a Find places form with data-busy per category', async () => {
    const { get, cat } = await setup();
    const html = await (await get('/admin/setup/places')).text();
    const form = html.match(new RegExp(`<form[^>]*action="/admin/setup/places/discover/${cat.id}"[^>]*>`))![0];
    expect(form).toContain('data-busy');
    expect(html).toContain('>Find places</button>');
  });

  it('discovery inserts candidates and lands back on the wizard with a status line and Approve/Reject', async () => {
    const { db, post, get, cat } = await setup();
    const res = await post(`/admin/setup/places/discover/${cat.id}`, {});
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith('/admin/setup/places?')).toBe(true);
    expect(loc).toContain('inserted=2');
    expect(loc).toContain('skipped=0');
    expect(loc.endsWith('#test-dentist')).toBe(true);

    const rows = db.select().from(locations).all();
    expect(rows.map((r) => r.name).sort()).toEqual(['Far Dental', 'Near Dental Group']);

    const html = await (await get(loc.replace(/#.*/, ''))).text();
    expect(html).toMatch(/role="status"[^>]*>[^<]*Added 2 new places/);
    expect(html).toContain('Near Dental Group');
    for (const r of rows) {
      expect(html).toContain(`/admin/locations/${r.id}/approve`);
      expect(html).toContain(`/admin/locations/${r.id}/reject`);
    }
    expect(html).toContain('name="return_to" value="/admin/setup/places#test-dentist"');
    expect(html).toContain('0 approved of target 5');
  });

  it('approving from the wizard returns to the wizard and updates the count', async () => {
    const { db, post, get, cat } = await setup();
    await post(`/admin/setup/places/discover/${cat.id}`, {});
    const near = db.select().from(locations).all().find((r) => r.name === 'Near Dental Group')!;
    const res = await post(`/admin/locations/${near.id}/approve`, { return_to: '/admin/setup/places#test-dentist' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/places#test-dentist');
    expect(await (await get('/admin/setup/places')).text()).toContain('1 approved of target 5');
  });

  it('only whitelisted numeric status params are reflected', async () => {
    const { get, cat } = await setup();
    const html = await (
      await get(`/admin/setup/places?found=${cat.id}&inserted=%3Cscript%3Ealert(1)%3C/script%3E&skipped=1&stopped=evil`)
    ).text();
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('evil');
    expect(html).not.toMatch(/role="status"[^>]*>[^<]*Added/);
  });

  it('without a home location it explains and links to the Home step', async () => {
    const { post, db, cat } = await setup({ home: false });
    const res = await post(`/admin/setup/places/discover/${cat.id}`, {});
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('href="/admin/setup/home"');
    expect(html).toMatch(/role="alert"/);
    expect(db.select().from(locations).all()).toHaveLength(0);
  });

  it('a Google error shows plain words and never the key or the raw upstream body', async () => {
    const fetchFn = (async () =>
      new Response(`{"error":{"message":"RAW-UPSTREAM-BODY key=${KEY}"}}`, { status: 403 })) as unknown as typeof fetch;
    const { post, cat } = await setup({ fetch: fetchFn });
    const res = await post(`/admin/setup/places/discover/${cat.id}`, {});
    expect(res.status).toBe(502);
    const html = await res.text();
    expect(html).toMatch(/role="alert"/);
    expect(html).toContain('Google rejected this key');
    expect(html).not.toContain('RAW-UPSTREAM-BODY');
    expect(html).not.toContain(KEY);
  });

  it('an exhausted monthly cap shows a plain message', async () => {
    const { post, db, cat } = await setup();
    db.insert(placesUsage).values({ month: now.toISOString().slice(0, 7), calls: 100000, updatedAt: now }).run();
    const res = await post(`/admin/setup/places/discover/${cat.id}`, {});
    expect(res.status).toBe(429);
    const html = await res.text();
    expect(html).toMatch(/role="alert"[^>]*>[^<]*Places call limit/);
  });

  it('an unknown category is a 404', async () => {
    const { post } = await setup();
    expect((await post('/admin/setup/places/discover/9999', {})).status).toBe(404);
  });
});
