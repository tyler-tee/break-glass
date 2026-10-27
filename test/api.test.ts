import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { locations } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import { loadEnv } from '../src/env.js';
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

type Group = { category: { id: number; name: string; slug: string }; locations: Record<string, unknown>[] };

describe('JSON read API', () => {
  it('/api/locations?q=dentist returns only approved/warn with the required fields', async () => {
    const res = await app.request('/api/locations?q=dentist');
    const body = (await res.json()) as { categories: Group[] };
    expect(res.status).toBe(200);
    expect(body.categories[0].category.slug).toBe('dentist');
    const names = body.categories[0].locations.map((l) => l.name);
    expect(names).toContain('Near Dental');
    expect(names).not.toContain('Candidate Dental');
    expect(names).not.toContain('Rejected Dental');
    expect(names.indexOf('Near Dental')).toBeLessThan(names.indexOf('Far Dental'));
    expect(Object.keys(body.categories[0].locations[0])).toEqual(
      expect.arrayContaining(['id', 'name', 'phone', 'distanceMi', 'status', 'openNow']),
    );
    for (const l of body.categories[0].locations) expect(['approved', 'warn']).toContain(l.status);
  });

  it('/api/locations/:id returns the location', async () => {
    const row = db.select().from(locations).where(eq(locations.name, 'Near Dental')).get()!;
    const res = await app.request(`/api/locations/${row.id}`);
    const body = (await res.json()) as { location: { id: number; name: string } };
    expect(res.status).toBe(200);
    expect(body.location.name).toBe('Near Dental');
  });

  it('/api/locations/:id is 404 for a candidate', async () => {
    const row = db.select().from(locations).where(eq(locations.name, 'Candidate Dental')).get()!;
    const res = await app.request(`/api/locations/${row.id}`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('/api/categories lists four categories', async () => {
    const res = await app.request('/api/categories');
    const body = (await res.json()) as { categories: { name: string; slug: string }[] };
    expect(res.status).toBe(200);
    expect(body.categories).toHaveLength(4);
    expect(body.categories.map((c) => c.name)).toEqual(['Dentist', 'Emergency room', 'Urgent care', 'Veterinarian']);
  });

  it('/api/locations?category=dentist returns one group', async () => {
    const res = await app.request('/api/locations?category=dentist');
    const body = (await res.json()) as { categories: Group[] };
    expect(res.status).toBe(200);
    expect(body.categories).toHaveLength(1);
    expect(body.categories[0].category.slug).toBe('dentist');
    expect(body.categories[0].locations.map((l) => l.name)).not.toContain('Candidate Dental');
  });

  it('/api/locations?category=nope is 404', async () => {
    const res = await app.request('/api/locations?category=nope');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not found' });
  });

  it('/api/locations with no params groups every category with visible locations', async () => {
    const body = (await (await app.request('/api/locations')).json()) as { categories: Group[] };
    expect(body.categories.map((g) => g.category.slug)).toEqual(['dentist']);
  });
});
