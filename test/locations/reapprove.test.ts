import { and, eq, isNull } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { categories, locationChanges, locations, locationSnapshots } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { hashTracked, trackedFromLocation } from '../../src/domain/snapshot.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import { safeReturnTo } from '../../src/features/locations/adminRoutes.js';
import { LocationError, reapproveLocation } from '../../src/features/locations/service.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

let app: ReturnType<typeof createApp>;
let db: Db;
let cookie: string;
const now = new Date('2026-10-27T16:00:00Z');
const earlier = new Date('2026-10-20T16:00:00Z');

beforeEach(async () => {
  db = createTestDb();
  seed(db);
  app = createApp({
    db,
    env: loadEnv({
      SESSION_SECRET: 's'.repeat(32),
      ADMIN_PASSWORD_HASH: await hashPassword('correct horse'),
    }),
    now: () => now,
  });
  cookie = await adminLogin(app, 'correct horse');
});

const dentistId = () => db.select().from(categories).where(eq(categories.slug, 'dentist')).get()!.id;
const row = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;
const post = (path: string, body = '') =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });
const get = (path: string) => app.request(path, { headers: { cookie } });
const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

function warnRow(name = 'Drifted Dental') {
  const loc = db
    .insert(locations)
    .values({
      categoryId: dentistId(),
      name,
      status: 'warn',
      phone: '(801) 555-0199',
      businessStatus: 'OPERATIONAL',
      consecutiveFetchFailures: 2,
      createdAt: earlier,
      updatedAt: earlier,
    })
    .returning()
    .get();
  const old = trackedFromLocation(loc);
  db.insert(locationSnapshots).values({ locationId: loc.id, fetchedAt: earlier, payload: old, hash: hashTracked(old) }).run();
  const fresh = trackedFromLocation({ ...loc, phone: '(801) 555-0100' });
  db.insert(locationSnapshots)
    .values({ locationId: loc.id, fetchedAt: new Date('2026-10-26T16:00:00Z'), payload: fresh, hash: hashTracked(fresh) })
    .run();
  db.insert(locationChanges)
    .values({ locationId: loc.id, detectedAt: earlier, field: 'phone', oldValue: '(801) 555-0199', newValue: '(801) 555-0100' })
    .run();
  return loc;
}

const approvedRow = () =>
  db
    .insert(locations)
    .values({ categoryId: dentistId(), name: 'Fine Dental', status: 'approved', createdAt: now, updatedAt: now })
    .returning()
    .get();

describe('re-approve', () => {
  it('re-approve clears warn, resolves changes, adopts new phone', () => {
    const loc = warnRow();
    expect(reapproveLocation(db, loc.id, now).status).toBe('approved');
    const after = row(loc.id);
    expect(after.status).toBe('approved');
    expect(after.phone).toBe('(801) 555-0100');
    expect(after.consecutiveFetchFailures).toBe(0);
    expect(after.lastVerifiedAt).toEqual(now);
    const changes = db.select().from(locationChanges).where(eq(locationChanges.locationId, loc.id)).all();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.resolvedAt).toEqual(now);
    expect(
      db.select().from(locationChanges).where(and(eq(locationChanges.locationId, loc.id), isNull(locationChanges.resolvedAt))).all(),
    ).toHaveLength(0);
    const snaps = db.select().from(locationSnapshots).where(eq(locationSnapshots.locationId, loc.id)).all();
    expect(snaps).toHaveLength(3);
    const newest = snaps.find((s) => s.fetchedAt.getTime() === now.getTime())!;
    expect(newest.hash).toBe(hashTracked(trackedFromLocation(after)));
  });

  it('throws invalid_transition unless warn', () => {
    const loc = approvedRow();
    expect(() => reapproveLocation(db, loc.id, now)).toThrow(LocationError);
  });

  it('re-approve of an approved row is 409 via the route', async () => {
    const loc = approvedRow();
    const res = await post(`/admin/locations/${loc.id}/reapprove`);
    expect(res.status).toBe(409);
    expect(row(loc.id).status).toBe('approved');
  });

  it('warn queue lists changes and re-approve returns to the queue', async () => {
    const loc = warnRow();
    const html = await (await get('/admin/warn')).text();
    expect(html).toContain('Drifted Dental');
    expect(html).toContain('phone:');
    expect(html).toContain('0199');
    expect(html).toContain('0100');
    expect(html).toContain(`action="/admin/locations/${loc.id}/reapprove"`);
    expect(html).toContain('name="return_to" value="/admin/warn"');

    const res = await post(`/admin/locations/${loc.id}/reapprove`, form({ return_to: '/admin/warn' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/warn');
    expect(row(loc.id).status).toBe('approved');
    expect(await (await get('/admin/warn')).text()).not.toContain('Drifted Dental');
  });

  it('reject from the warn queue hides it from family search', async () => {
    const loc = warnRow();
    expect(await (await app.request('/search?q=Drifted')).text()).toContain('Drifted Dental');
    const res = await post(`/admin/locations/${loc.id}/reject`, form({ return_to: '/admin/warn' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/warn');
    expect(row(loc.id).status).toBe('rejected');
    expect(await (await app.request('/search?q=Drifted')).text()).not.toContain('Drifted Dental');
  });

  it('return_to outside /admin/ falls back', async () => {
    const loc = warnRow();
    const res = await post(`/admin/locations/${loc.id}/reapprove`, form({ return_to: '//evil.example' }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/locations');
  });

  it('safeReturnTo accepts only /admin/ paths', () => {
    expect(safeReturnTo('/admin/warn')).toBe('/admin/warn');
    expect(safeReturnTo('/adminx')).toBeNull();
    expect(safeReturnTo('https://evil.example/admin/')).toBeNull();
    expect(safeReturnTo('//evil.example')).toBeNull();
    expect(safeReturnTo(undefined)).toBeNull();
  });

  it.each([
    ['/adminx', '/admin/locations'],
    ['https://evil.example/admin/', '/admin/locations'],
    ['/admin/warn', '/admin/warn'],
  ])('return_to %s redirects to %s', async (returnTo, expected) => {
    const loc = warnRow();
    const res = await post(`/admin/locations/${loc.id}/reapprove`, form({ return_to: returnTo }));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(expected);
  });

  it('reapprove throws invalid_transition for candidate and rejected rows', () => {
    for (const status of ['candidate', 'rejected'] as const) {
      const loc = db
        .insert(locations)
        .values({ categoryId: dentistId(), name: `${status} Dental`, status, createdAt: now, updatedAt: now })
        .returning()
        .get();
      expect(() => reapproveLocation(db, loc.id, now)).toThrow(expect.objectContaining({ code: 'invalid_transition' }));
      expect(row(loc.id).status).toBe(status);
    }
  });

  it('reapprove route is 409 for a candidate', async () => {
    const loc = db
      .insert(locations)
      .values({ categoryId: dentistId(), name: 'Cand Dental', status: 'candidate', createdAt: now, updatedAt: now })
      .returning()
      .get();
    const res = await post(`/admin/locations/${loc.id}/reapprove`);
    expect(res.status).toBe(409);
    expect(row(loc.id).status).toBe('candidate');
  });
});
