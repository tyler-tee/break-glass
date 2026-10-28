import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, locationChanges, locations, settings } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadEnv } from '../src/env.js';
import { eq } from 'drizzle-orm';
import { createTestDb } from './helpers/testDb.js';

let db: Db;
let app: ReturnType<typeof createApp>;

beforeEach(() => {
  db = createTestDb();
  seed(db);
  app = createApp({
    db,
    env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' }),
    now: () => new Date('2026-10-27T16:00:00Z'),
  });
});

const dentistId = () => db.select().from(categories).where(eq(categories.slug, 'dentist')).get()!.id;

function insertDentist(values: Partial<typeof locations.$inferInsert> & { name: string }) {
  const now = new Date();
  return db
    .insert(locations)
    .values({ categoryId: dentistId(), status: 'approved', createdAt: now, updatedAt: now, ...values })
    .returning()
    .get();
}

describe('family pages', () => {
  it('search "dentist" lists approved sorted by distance with tel links', async () => {
    const res = await app.request('/search?q=dentist');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html.indexOf('Near Dental')).toBeGreaterThan(-1);
    expect(html.indexOf('Near Dental')).toBeLessThan(html.indexOf('Far Dental'));
    expect(html).toContain('href="tel:+18015550100"');
    expect(html).not.toContain('Candidate Dental');
    expect(html).not.toContain('Rejected Dental');
  });

  it('home orders search, protocols banner, call buttons, then tiles', async () => {
    const html = await (await app.request('/')).text();
    expect(html).toContain('<h1>Preparedness kit</h1>');
    expect(html).toContain('action="/search"');
    expect(html).toContain('Find a provider');
    expect(html).toContain('href="/emergency"');
    expect(html).toContain('Emergency protocols');
    expect(html).toContain('href="tel:911"');
    expect(html).toContain('Call 911');
    expect(html).toContain('href="tel:18002221222"');
    expect(html).toContain('Vetted providers');
    expect(html).toContain('href="/c/dentist"');
    expect(html).toMatch(/\d+ vetted/);
    expect(html).toContain('href="/categories"');
    expect(html).toContain('All categories');
    const search = html.indexOf('role="search"');
    const banner = html.indexOf('href="/emergency"');
    const call = html.indexOf('href="tel:911"');
    const tiles = html.indexOf('class="tiles"');
    expect(search).toBeGreaterThan(-1);
    expect(search).toBeLessThan(banner);
    expect(banner).toBeLessThan(call);
    expect(call).toBeLessThan(tiles);
    expect(html).not.toContain('<script');
  });

  it('home tile shows how many vetted places need review', async () => {
    insertDentist({ name: 'Review Dental', status: 'warn' });
    const html = await (await app.request('/')).text();
    expect(html).toMatch(/\d+ vetted · 1 to review/);
  });

  it('search escapes LIKE wildcards', async () => {
    for (const q of ['%', '_']) {
      const html = await (await app.request(`/search?q=${encodeURIComponent(q)}`)).text();
      expect(html).not.toContain('Near Dental');
    }
  });

  it('blank or unmatched query shows an empty state and categories, no cards', async () => {
    for (const q of ['', '%20%20', 'zzzznomatch']) {
      const html = await (await app.request(`/search?q=${q}`)).text();
      expect(html).toContain('class="empty"');
      expect(html).toContain('href="/c/dentist"');
      expect(html).not.toContain('Near Dental');
      expect(html).not.toContain('class="provider"');
    }
  });

  it('card renders without coords', async () => {
    insertDentist({
      name: 'Bare Dental',
      lat: null,
      lng: null,
      distanceMi: null,
      hours: null,
      phone: null,
    });
    const res = await app.request('/search?q=Bare');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Bare Dental');
    expect(html).toContain('Hours unknown');
    expect(html).not.toContain(' mi');
    expect(html).toContain('Directions');
  });

  it('provider card has Call and Directions links and after-hours notes', async () => {
    const row = insertDentist({
      name: 'Detail Dental',
      phone: '+1 801 555 0199',
      address: '1 Main St',
      afterHoursNotes: 'Ring bell',
    });
    const html = await (await app.request('/c/dentist')).text();
    expect(html).toContain(`<article class="provider" id="place-${row.id}">`);
    expect(html).toContain('href="tel:+18015550199"');
    expect(html).toMatch(/<a class="btn sm btn-outline" href="https:\/\/[^"]+"[^>]*>[\s\S]*?Directions/);
    expect(html).toContain('Ring bell');
    expect(html).toContain('Hours unknown');
  });

  it('/l/:id redirects to the place card in its category; unknown id is 404', async () => {
    const row = insertDentist({ name: 'Redirect Dental' });
    const res = await app.request(`/l/${row.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`/c/dentist#place-${row.id}`);
    expect((await app.request('/l/999999')).status).toBe(404);
  });

  it('home falls back to 911 when the stored number has no digits', async () => {
    db.update(settings).set({ emergencyNumber: 'abc' }).where(eq(settings.id, 1)).run();
    const html = await (await app.request('/')).text();
    expect(html).toContain('href="tel:911"');
    expect(html).toContain('Call 911');
  });

  it('closed permanently is hidden from family pages', async () => {
    insertDentist({ name: 'Shut Dental', businessStatus: 'CLOSED_PERMANENTLY', distanceMi: 0.1 });
    for (const path of ['/search?q=dentist', '/c/dentist']) {
      const html = await (await app.request(path)).text();
      expect(html).toContain('Far Dental');
      expect(html).not.toContain('Shut Dental');
    }
  });

  it('warn card says needs re-approval with the change sentence', async () => {
    const row = insertDentist({ name: 'Shifty Dental', status: 'warn' });
    db.insert(locationChanges)
      .values({ locationId: row.id, detectedAt: new Date(), field: 'phone', oldValue: '1', newValue: '2' })
      .run();
    const html = await (await app.request('/search?q=Shifty')).text();
    expect(html).toContain('Shifty Dental');
    expect(html).toContain('Needs re-approval');
    expect(html).toContain('Phone number is now 2.');
  });

  it('category page lists its visible dentists and unknown slug is 404', async () => {
    const res = await app.request('/c/dentist');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Near Dental');
    expect(html).toContain('Far Dental');
    expect(html).not.toContain('Candidate Dental');
    expect(html).not.toContain('Rejected Dental');
    expect((await app.request('/c/nope')).status).toBe(404);
  });

  it('home page is a full document', async () => {
    const res = await app.request('/');
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html.toLowerCase().startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('name="viewport"');
    expect(html).toContain('href="/emergency"');
  });

  it('location names are HTML-escaped', async () => {
    insertDentist({ name: '<script>alert(1)</script> Dental', distanceMi: 0.5 });
    const html = await (await app.request('/search?q=dental')).text();
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>alert');
  });
});
