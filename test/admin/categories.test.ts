import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { seed } from '../../src/db/seed.js';
import { categories } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { getCategoryBySlug } from '../../src/features/categories/repo.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

let app: ReturnType<typeof createApp>;
let db: Db;
let cookie: string;

beforeEach(async () => {
  db = createTestDb();
  seed(db);
  app = createApp({
    db,
    env: loadEnv({
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    }),
  });
  cookie = await adminLogin(app, 'correct horse');
});

const post = (path: string, body: string) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });

const idOf = (slug: string) => getCategoryBySlug(db, slug)!.id;

describe('admin categories', () => {
  it('requires login', async () => {
    const res = await app.request('/admin/categories');
    expect(res.status).toBe(302);
  });

  it('create → appears on family home', async () => {
    const res = await post('/admin/categories', 'name=Pharmacy&search_terms=pharmacy%0A24+hour+pharmacy');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/categories');
    const home = await (await app.request('/')).text();
    expect(home).toContain('Pharmacy');
    expect(home).toContain('/c/pharmacy');
    expect(getCategoryBySlug(db, 'pharmacy')?.searchTerms).toEqual(['pharmacy', '24 hour pharmacy']);
  });

  it('create stores hours need and defaults to overnight', async () => {
    await post('/admin/categories', 'name=Clinic&search_terms=clinic&hours_need=daytime');
    expect(getCategoryBySlug(db, 'clinic')?.hoursNeed).toBe('daytime');
    await post('/admin/categories', 'name=Pharmacy&search_terms=pharmacy');
    expect(getCategoryBySlug(db, 'pharmacy')?.hoursNeed).toBe('overnight');
  });

  it('invalid hours need → 400', async () => {
    const res = await post('/admin/categories', 'name=Clinic&search_terms=clinic&hours_need=sometimes');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('when you would go');
    expect(getCategoryBySlug(db, 'clinic')).toBeNull();
  });

  it('edit form shows the When would you go? field with the saved choice', async () => {
    const html = await (await app.request(`/admin/categories/${idOf('urgent-care')}/edit`, { headers: { cookie } })).text();
    expect(html).toContain('When would you go?');
    expect(html).toContain('name="hours_need"');
    expect(html).toContain('Any time, including overnight');
    expect(html).toMatch(/<option value="daytime" selected[^>]*>/);
    expect(html).not.toContain('Target count');
    const res = await post(`/admin/categories/${idOf('urgent-care')}`, 'name=Urgent+care&search_terms=urgent+care&hours_need=overnight');
    expect(res.status).toBe(302);
    expect(getCategoryBySlug(db, 'urgent-care')?.hoursNeed).toBe('overnight');
  });

  it('duplicate name → 400', async () => {
    const res = await post('/admin/categories', 'name=Dentist&search_terms=dentist');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('already exists');
    expect(db.select().from(categories).all()).toHaveLength(4);
  });

  it('delete with locations → 409', async () => {
    const res = await post(`/admin/categories/${idOf('dentist')}/delete`, '');
    expect(res.status).toBe(409);
    expect(await res.text()).toContain('in use');
    expect(getCategoryBySlug(db, 'dentist')).not.toBeNull();
    const list = await (await app.request('/admin/categories', { headers: { cookie } })).text();
    expect(list).toContain('Dentist');
  });

  it('delete empty category → 302', async () => {
    const res = await post(`/admin/categories/${idOf('vet')}/delete`, '');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/categories');
    expect(getCategoryBySlug(db, 'vet')).toBeNull();
    expect(await (await app.request('/')).text()).not.toContain('/c/vet');
  });

  it('edit updates search terms and slug', async () => {
    const id = idOf('vet');
    const res = await post(`/admin/categories/${id}`, 'name=Animal+hospital&search_terms=emergency+vet');
    expect(res.status).toBe(302);
    const row = db.select().from(categories).where(eq(categories.id, id)).get()!;
    expect(row.slug).toBe('animal-hospital');
    expect(row.searchTerms).toEqual(['emergency vet']);
  });

  it('blank search terms → 400', async () => {
    const res = await post('/admin/categories', 'name=Pharmacy&search_terms=+%0A+');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('search term');
    expect(getCategoryBySlug(db, 'pharmacy')).toBeNull();
  });

  it('unknown id → 404', async () => {
    const res = await app.request('/admin/categories/9999/edit', {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });
});
