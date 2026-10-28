import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { locations } from '../../src/db/schema.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { createCategory, getCategoryBySlug } from '../../src/features/categories/repo.js';
import { createFact } from '../../src/features/house/repo.js';
import { getProtocolBySlug } from '../../src/features/protocols/repo.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

const NOW = new Date('2026-10-27T16:00:00Z');

let db: Db;
let app: ReturnType<typeof createApp>;
let cookie: string;

beforeEach(async () => {
  db = createTestDb();
  app = createApp({
    db,
    env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: await hashPassword('correct horse') }),
    now: () => NOW,
  });
  cookie = await adminLogin(app, 'correct horse');
});

const get = (path: string) => app.request(path, { headers: { cookie } });
const post = (path: string, body: Record<string, string>) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body: new URLSearchParams(body).toString(),
  });

describe('categories admin: area', () => {
  it('the form has an Area select that defaults to Health', async () => {
    const html = await (await get('/admin/categories/new')).text();
    expect(html).toContain('name="area"');
    expect(html).toMatch(/<option value="health" selected[^>]*>/);
  });

  it('saves the area on create and keeps it on edit', async () => {
    const res = await post('/admin/categories', { name: 'Emergency plumber', search_terms: 'emergency plumber', area: 'home' });
    expect(res.status).toBe(302);
    const cat = getCategoryBySlug(db, 'emergency-plumber')!;
    expect(cat.area).toBe('home');

    const edit = await (await get(`/admin/categories/${cat.id}/edit`)).text();
    expect(edit).toMatch(/<option value="home" selected[^>]*>/);

    // An edit that leaves area out keeps it; one that names it changes it.
    await post(`/admin/categories/${cat.id}`, { name: 'Emergency plumber', search_terms: 'emergency plumber' });
    expect(getCategoryBySlug(db, 'emergency-plumber')!.area).toBe('home');
    await post(`/admin/categories/${cat.id}`, { name: 'Emergency plumber', search_terms: 'emergency plumber', area: 'health' });
    expect(getCategoryBySlug(db, 'emergency-plumber')!.area).toBe('health');
  });

  it('rejects an unknown area and re-renders the form', async () => {
    const res = await post('/admin/categories', { name: 'Odd', search_terms: 'odd', area: 'garage' });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Choose health or home');
  });

  it('the list groups categories under Health and Home headings', async () => {
    createCategory(db, { name: 'Dentist', searchTerms: ['dentist'] });
    createCategory(db, { name: 'Emergency plumber', searchTerms: ['plumber'], area: 'home' });
    const html = await (await get('/admin/categories')).text();
    const health = html.indexOf('>Health</h2>');
    const home = html.indexOf('>Home</h2>');
    expect(health).toBeGreaterThan(-1);
    expect(home).toBeGreaterThan(health);
    expect(html.indexOf('Dentist')).toBeGreaterThan(health);
    expect(html.indexOf('Dentist')).toBeLessThan(home);
    expect(html.indexOf('Emergency plumber')).toBeGreaterThan(home);
  });
});

describe('protocols admin: area', () => {
  it('the create form prefills title, tags and area from the query', async () => {
    const html = await (await get('/admin/protocols/new?area=home&title=Burst%20pipe&tags=water%2C%20emergency-plumber')).text();
    expect(html).toContain('value="Burst pipe"');
    expect(html).toContain('value="water, emergency-plumber"');
    expect(html).toMatch(/<option value="home" selected[^>]*>/);
    const plain = await (await get('/admin/protocols/new')).text();
    expect(plain).toMatch(/<option value="health" selected[^>]*>/);
  });

  it('creating with area home stores it with the tags, and the list shows the area', async () => {
    const res = await post('/admin/protocols/new', { title: 'Burst pipe', tags: 'water, emergency-plumber', area: 'home' });
    expect(res.status).toBe(302);
    const p = getProtocolBySlug(db, 'burst-pipe')!;
    expect(p.area).toBe('home');
    expect(p.tags).toEqual(['water', 'emergency-plumber']);
    await post('/admin/protocols/new', { title: 'Choking', tags: '' });
    expect(getProtocolBySlug(db, 'choking')!.area).toBe('health');
    const list = await (await get('/admin/protocols')).text();
    expect(list).toContain('<th>Area</th>');
    expect(list).toContain('<td>Home</td>');
    expect(list).toContain('<td>Health</td>');
  });

  it('a failed create keeps the chosen area', async () => {
    const res = await post('/admin/protocols/new', { title: '!!!', tags: 'water', area: 'home' });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/<option value="home" selected[^>]*>/);
  });

  it('a home protocol page shows how many house facts and which trades are linked; a health one does not', async () => {
    createCategory(db, { name: 'Emergency plumber', searchTerms: ['plumber'], area: 'home' });
    createFact(db, { kind: 'shutoff', system: 'water', title: 'Water main', whereNote: 'Front yard' }, NOW);
    createFact(db, { kind: 'note', system: 'water', title: 'Hose bib', instructions: 'Turn off in winter' }, NOW);
    createFact(db, { kind: 'shutoff', system: 'electric', title: 'Breaker panel', whereNote: 'Garage' }, NOW);
    await post('/admin/protocols/new', { title: 'Burst pipe', tags: 'water, plumber', area: 'home' });
    await post('/admin/protocols/new', { title: 'Choking', tags: 'water' });
    const home = getProtocolBySlug(db, 'burst-pipe')!;
    const html = await (await get(`/admin/protocols/${home.id}`)).text();
    expect(html).toContain('Linked: 2 house facts · Emergency plumber');
    const health = getProtocolBySlug(db, 'choking')!;
    expect(await (await get(`/admin/protocols/${health.id}`)).text()).not.toContain('Linked:');
  });
});

describe('Find places: grouped by area', () => {
  const rank = (categoryId: number, name: string) =>
    db
      .insert(locations)
      .values({
        categoryId, name, status: 'candidate', shortAddress: '1 Main St', rating: 4.5, ratingCount: 50, distanceMi: 2,
        rankVerdict: 'pick', rankPosition: 1, rankReason: 'Why', rankFlags: [], rankedBy: 'rules', rankedAt: NOW,
        createdAt: NOW, updatedAt: NOW,
      })
      .run();

  it('only health categories: no group headings', async () => {
    createCategory(db, { name: 'Dentist', searchTerms: ['dentist'] });
    const html = await (await get('/admin/places/find')).text();
    expect(html).not.toContain('<h3 class="label">Health</h3>');
  });

  it('with both areas the picker and the results sit under Health and Home headings', async () => {
    const dentist = createCategory(db, { name: 'Dentist', searchTerms: ['dentist'] });
    const plumber = createCategory(db, { name: 'Emergency plumber', searchTerms: ['plumber'], area: 'home' });
    rank(dentist.id, 'Sample Dental');
    rank(plumber.id, 'Sample Plumbing');
    const html = await (await get('/admin/places/find')).text();
    const pickerHealth = html.indexOf('<h3 class="label">Health</h3>');
    const pickerHome = html.indexOf('<h3 class="label">Home</h3>');
    expect(pickerHealth).toBeGreaterThan(-1);
    expect(pickerHome).toBeGreaterThan(pickerHealth);
    expect(html.indexOf(`value="${dentist.id}"`)).toBeLessThan(pickerHome);
    expect(html.indexOf(`value="${plumber.id}"`)).toBeGreaterThan(pickerHome);
    // Results: a heading before the first section of each area.
    const resHealth = html.indexOf('<h2 class="area-h label">Health</h2>');
    const resHome = html.indexOf('<h2 class="area-h label">Home</h2>');
    expect(resHealth).toBeGreaterThan(pickerHome);
    expect(resHome).toBeGreaterThan(resHealth);
    expect(html.indexOf('id="dentist"')).toBeGreaterThan(resHealth);
    expect(html.indexOf('id="dentist"')).toBeLessThan(resHome);
    expect(html.indexOf('id="emergency-plumber"')).toBeGreaterThan(resHome);
  });
});
