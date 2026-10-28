import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { locations, settings } from '../../src/db/schema.js';
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
  it('lists the seven presets with their terms and hours need', () => {
    expect(CATEGORY_PRESETS.map((p) => [p.name, p.slug, p.hoursNeed])).toEqual([
      ['Urgent care', 'urgent-care', 'daytime'],
      ['Emergency room', 'emergency-room', 'overnight'],
      ["Children's ER", 'children-s-er', 'overnight'],
      ['24-hour pharmacy', '24-hour-pharmacy', 'overnight'],
      ['Dentist (emergency)', 'dentist-emergency', 'overnight'],
      ['Emergency vet', 'emergency-vet', 'overnight'],
      ['Pediatrician', 'pediatrician', 'daytime'],
    ]);
    expect(CATEGORY_PRESETS[0]!.searchTerms).toEqual(['urgent care', 'walk-in clinic']);
  });

  it("offers the Children's ER preset and saves it as overnight with its search terms", async () => {
    const { db, post, get } = await harness();
    const html = await (await get('/admin/setup/categories')).text();
    expect(html).toContain("Children&#39;s ER");
    expect(html).not.toContain('aims for');
    await post('/admin/setup/categories', { preset: ['children-s-er'], go: 'next' });
    expect(listCategories(db)[0]).toMatchObject({
      name: "Children's ER",
      hoursNeed: 'overnight',
      searchTerms: ["children's emergency room", 'pediatric emergency room', "children's hospital"],
    });
  });

  it('creating presets is idempotent and existing ones render checked, disabled and "Already added"', async () => {
    const { db, post, get } = await harness();
    const fields = { preset: ['urgent-care', 'emergency-room', 'pediatrician'], go: 'next' };
    const res = await post('/admin/setup/categories', fields);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/places');
    expect(listCategories(db)).toHaveLength(3);
    const urgent = listCategories(db).find((c) => c.slug === 'urgent-care')!;
    expect(urgent).toMatchObject({ name: 'Urgent care', searchTerms: ['urgent care', 'walk-in clinic'], hoursNeed: 'daytime' });

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

  it('adds a custom category with terms split on lines and commas, default overnight', async () => {
    const { db, post } = await harness();
    const res = await post('/admin/setup/categories', {
      custom_name: 'Eye doctor',
      custom_terms: 'eye doctor\noptometrist, ophthalmologist',
      custom_hours: '',
      go: 'next',
    });
    expect(res.status).toBe(302);
    expect(listCategories(db)[0]).toMatchObject({
      slug: 'eye-doctor',
      searchTerms: ['eye doctor', 'optometrist', 'ophthalmologist'],
      hoursNeed: 'overnight',
    });
  });

  it('adds a custom category that is only needed in the daytime', async () => {
    const { db, post } = await harness();
    await post('/admin/setup/categories', { custom_name: 'Eye doctor', custom_terms: 'eye doctor', custom_hours: 'daytime', go: 'next' });
    expect(listCategories(db)[0]).toMatchObject({ hoursNeed: 'daytime' });
  });

  it('custom validation errors re-render with 400, an alert beside the field, and save nothing', async () => {
    const { db, post } = await harness();
    const cases: [Record<string, string>, string, RegExp][] = [
      [{ custom_name: '', custom_terms: 'eye doctor' }, 'custom_name', /Name is required/],
      [{ custom_name: '***', custom_terms: 'x' }, 'custom_name', /letters or numbers/],
      [{ custom_name: 'Eye doctor', custom_terms: '  , ' }, 'custom_terms', /search term/],
      [{ custom_name: 'Eye doctor', custom_terms: 'eyes', custom_hours: 'sometimes' }, 'custom_hours', /when you would go/],
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
    expect(field(() => createCategory(db, { name: 'A', searchTerms: ['x'], hoursNeed: 'sometimes' as never }))).toBe('hours_need');
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
  it('shows one card with the pick count, a link to Find places, a note about the key, and manual entry', async () => {
    const { db, get } = await harness();
    createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] });
    const res = await get('/admin/setup/places');
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('0 of 1 category has picks.');
    expect(html).toContain('No picks yet');
    expect(html).toMatch(/<a class="btn" href="\/admin\/places\/find">\s*Find &amp; rank places\s*<\/a>/);
    expect(html).toContain('Add a place by hand');
    expect(html).not.toContain('/admin/setup/places/discover/');
    expect(html).not.toContain('/admin/locations/');
    expect(html).toMatch(/Google Places key[^<]*<a href="\/admin\/setup\/services">/);
  });

  it('counts approved and warn locations as picked, per category', async () => {
    const { db, get } = await harness();
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'] });
    createCategory(db, { name: 'Test Vet', searchTerms: ['y'] });
    const at = new Date();
    for (const [name, status] of [['A', 'approved'], ['B', 'warn'], ['C', 'candidate'], ['D', 'rejected']] as const) {
      db.insert(locations).values({ categoryId: cat.id, name, status, createdAt: at, updatedAt: at }).run();
    }
    const html = await (await get('/admin/setup/places')).text();
    expect(html).toContain('1 of 2 categories have picks.');
    expect(html).toContain('2 picked');
    expect(html).toContain('No picks yet');
  });

  it('with no categories it points back to the Categories step', async () => {
    const { get } = await harness();
    const html = await (await get('/admin/setup/places')).text();
    expect(html).toContain('href="/admin/setup/categories"');
  });

  it('adds a place by hand as a candidate and points to Find places to save it', async () => {
    const { db, post, get } = await harness();
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'] });
    const res = await post('/admin/setup/places/manual', {
      category_id: String(cat.id),
      name: 'Corner Dental',
      address: '1 Main St',
      phone: '801-555-0199',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/setup/places?added=1');
    const row = db.select().from(locations).get()!;
    expect(row).toMatchObject({ name: 'Corner Dental', status: 'candidate', placeId: null });

    const html = await (await get('/admin/setup/places?added=1')).text();
    expect(html).toMatch(/role="status"[^>]*>Added\. It is waiting on <a href="\/admin\/places\/find">Find places<\/a>/);

    // It shows on Find places, unranked, ready to save as a pick.
    const find = await (await get('/admin/places/find')).text();
    expect(find).toContain('Corner Dental');
    expect(find).toContain('Not searched yet');
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
  it('has no per-category discover forms; the old discover route is gone', async () => {
    const { db, get, post } = await harness({ key: true });
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] });
    const html = await (await get('/admin/setup/places')).text();
    expect(html).not.toContain('/discover');
    expect(html).not.toContain('Google Places key');
    expect(html).toContain('href="/admin/places/find"');
    expect((await post(`/admin/setup/places/discover/${cat.id}`, {})).status).toBe(404);
  });

  it('once every category has a pick, the step is marked done and Save and continue is the primary again', async () => {
    const { db, get } = await harness({ key: true });
    const cat = createCategory(db, { name: 'Test Dentist', searchTerms: ['x'] });
    let html = await (await get('/admin/setup/places')).text();
    expect(html).toMatch(/<button type="submit" name="go" value="next" class="btn-secondary">/);
    const at = new Date();
    db.insert(locations).values({ categoryId: cat.id, name: 'A', status: 'approved', createdAt: at, updatedAt: at }).run();
    html = await (await get('/admin/setup/places')).text();
    expect(html).toContain('1 of 1 category has picks.');
    expect(html).toMatch(/<button type="submit" name="go" value="next">/);
  });
});
