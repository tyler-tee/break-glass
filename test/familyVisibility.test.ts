import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { Db } from '../src/db/client.js';
import { categories, locations } from '../src/db/schema.js';
import { seed } from '../src/db/seed.js';
import type { LocationStatus } from '../src/domain/types.js';
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

const STATUSES: LocationStatus[] = ['candidate', 'approved', 'warn', 'rejected'];
const VISIBLE = new Set<LocationStatus>(['approved', 'warn']);

describe('family visibility by status', () => {
  it('only approved and warn locations are visible everywhere', async () => {
    const categoryId = db.select().from(categories).where(eq(categories.slug, 'dentist')).get()!.id;
    const now = new Date();
    const ids = new Map<LocationStatus, number>();
    for (const status of STATUSES) {
      const r = db
        .insert(locations)
        .values({ categoryId, name: `${status} Vis Dental`, status, distanceMi: 1.0, createdAt: now, updatedAt: now })
        .returning()
        .get();
      ids.set(status, r.id);
    }

    const search = await (await app.request('/search?q=vis')).text();
    const category = await (await app.request('/c/dentist')).text();
    const api = await (await app.request('/api/locations?q=vis')).text();
    for (const status of STATUSES) {
      const name = `${status} Vis Dental`;
      const visible = VISIBLE.has(status);
      expect(search.includes(name), `search ${status}`).toBe(visible);
      expect(category.includes(name), `category ${status}`).toBe(visible);
      expect(api.includes(name), `api ${status}`).toBe(visible);
      const code = visible ? 200 : 404;
      expect((await app.request(`/l/${ids.get(status)}`)).status, `/l ${status}`).toBe(code);
      expect((await app.request(`/api/locations/${ids.get(status)}`)).status, `/api/locations/:id ${status}`).toBe(code);
    }
  });
});
