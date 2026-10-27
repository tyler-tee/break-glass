import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, locationChanges, locations } from '../src/db/schema.js';
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

  it('search escapes LIKE wildcards', async () => {
    for (const q of ['%', '_']) {
      const html = await (await app.request(`/search?q=${encodeURIComponent(q)}`)).text();
      expect(html).not.toContain('Near Dental');
    }
  });

  it('blank query returns no groups', async () => {
    for (const q of ['', '%20%20']) {
      const html = await (await app.request(`/search?q=${q}`)).text();
      expect(html).toContain('No matches');
      expect(html).not.toContain('Near Dental');
    }
  });

  it('card renders without coords', async () => {
    const row = insertDentist({
      name: 'Bare Dental',
      lat: null,
      lng: null,
      distanceMi: null,
      hours: null,
      phone: null,
    });
    const res = await app.request(`/l/${row.id}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain('Bare Dental');
    expect(html).toContain('Hours unknown');
    expect(html).not.toContain(' mi');
  });

  it('closed permanently sorts last', async () => {
    insertDentist({ name: 'Shut Dental', businessStatus: 'CLOSED_PERMANENTLY', distanceMi: 0.1 });
    const html = await (await app.request('/search?q=dentist')).text();
    expect(html.indexOf('Shut Dental')).toBeGreaterThan(html.indexOf('Far Dental'));
    expect(html).toContain('Reported closed');
  });

  it('warn card shows badge with "phone"', async () => {
    const row = insertDentist({ name: 'Shifty Dental', status: 'warn' });
    db.insert(locationChanges)
      .values({ locationId: row.id, detectedAt: new Date(), field: 'phone', oldValue: '1', newValue: '2' })
      .run();
    const html = await (await app.request('/search?q=Shifty')).text();
    expect(html).toContain('Shifty Dental');
    expect(html).toContain('⚠');
    expect(html).toContain('phone');
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
