import { eq, sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { categories, locationChanges, locations, locationSnapshots } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';
import { hashTracked, trackedFromLocation } from '../../src/domain/snapshot.js';
import { loadEnv } from '../../src/env.js';
import { hashPassword } from '../../src/features/admin/auth.js';
import {
  LocationError,
  approveLocation,
  canTransition,
  createManualLocation,
  demoteLocation,
  rejectLocation,
} from '../../src/features/locations/service.js';
import { adminLogin } from '../helpers/adminLogin.js';
import { createTestDb } from '../helpers/testDb.js';

let app: ReturnType<typeof createApp>;
let db: Db;
let cookie: string;
const now = new Date('2026-10-27T16:00:00Z');

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
const fresh = () =>
  createManualLocation(db, { categoryId: dentistId(), name: 'Fresh Dental', lat: 40.78, lng: -111.89 }, now);
const search = async (q: string) => (await app.request(`/search?q=${q}`)).text();

const post = (path: string, body = '') =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    body,
  });

describe('status transitions', () => {
  it('candidate → approved makes it searchable', async () => {
    const loc = fresh();
    expect(loc.status).toBe('candidate');
    expect(await search('fresh')).not.toContain('Fresh Dental');
    approveLocation(db, loc.id, now);
    expect(await search('fresh')).toContain('Fresh Dental');
    const snaps = db.select().from(locationSnapshots).where(eq(locationSnapshots.locationId, loc.id)).all();
    expect(snaps).toHaveLength(1);
    const after = row(loc.id);
    expect(snaps[0]!.hash).toBe(hashTracked(trackedFromLocation(after)));
    expect(snaps[0]!.payload).toEqual(trackedFromLocation(after));
    expect(after.lastVerifiedAt).toEqual(now);
    expect(after.consecutiveFetchFailures).toBe(0);
  });

  it('approved → rejected removes it', async () => {
    const loc = fresh();
    approveLocation(db, loc.id, now);
    rejectLocation(db, loc.id, now);
    expect(row(loc.id).status).toBe('rejected');
    expect(await search('fresh')).not.toContain('Fresh Dental');
  });

  it('rejected → approved throws invalid_transition', () => {
    const loc = fresh();
    rejectLocation(db, loc.id, now);
    let code: string | undefined;
    try {
      approveLocation(db, loc.id, now);
    } catch (e) {
      expect(e).toBeInstanceOf(LocationError);
      code = (e as LocationError).code;
    }
    expect(code).toBe('invalid_transition');
    expect(row(loc.id).status).toBe('rejected');
  });

  it('approve resolves open changes', () => {
    const loc = fresh();
    db.insert(locationChanges)
      .values({ locationId: loc.id, detectedAt: now, field: 'phone', oldValue: 'a', newValue: 'b' })
      .run();
    approveLocation(db, loc.id, now);
    const changes = db.select().from(locationChanges).where(eq(locationChanges.locationId, loc.id)).all();
    expect(changes).toHaveLength(1);
    expect(changes[0]!.resolvedAt).toEqual(now);
  });
});

describe('demotion', () => {
  it('approved → candidate keeps everything else', () => {
    const loc = fresh();
    approveLocation(db, loc.id, now);
    const before = row(loc.id);
    const later = new Date('2026-10-28T09:00:00Z');
    const after = demoteLocation(db, loc.id, later);
    expect(after).toEqual({ ...before, status: 'candidate', updatedAt: later });
    expect(row(loc.id).lastVerifiedAt).toEqual(now);
  });

  it('warn → candidate is allowed', () => {
    const t = new Date();
    const warn = db
      .insert(locations)
      .values({ categoryId: dentistId(), name: 'Warn Dental', status: 'warn', createdAt: t, updatedAt: t })
      .returning()
      .get();
    expect(demoteLocation(db, warn.id, now).status).toBe('candidate');
  });

  it('candidate and rejected cannot be demoted', () => {
    const loc = fresh();
    expect(() => demoteLocation(db, loc.id, now)).toThrow(LocationError);
    rejectLocation(db, loc.id, now);
    expect(() => demoteLocation(db, loc.id, now)).toThrow(LocationError);
    expect(row(loc.id).status).toBe('rejected');
  });

  it('unknown id is not_found', () => {
    expect(() => demoteLocation(db, 9999, now)).toThrow(/not found/i);
  });

  it('only approved and warn can move to candidate', () => {
    expect(canTransition('approved', 'candidate')).toBe(true);
    expect(canTransition('warn', 'candidate')).toBe(true);
    expect(canTransition('candidate', 'candidate')).toBe(false);
    expect(canTransition('rejected', 'candidate')).toBe(false);
  });
});

describe('approve edge cases', () => {
  it('warn → approved is allowed and resolves changes', () => {
    const t = new Date();
    const warn = db
      .insert(locations)
      .values({
        categoryId: dentistId(),
        name: 'Warn Dental',
        status: 'warn',
        consecutiveFetchFailures: 2,
        createdAt: t,
        updatedAt: t,
      })
      .returning()
      .get();
    db.insert(locationChanges)
      .values({ locationId: warn.id, detectedAt: t, field: 'phone', oldValue: 'a', newValue: 'b' })
      .run();
    approveLocation(db, warn.id, now);
    const after = row(warn.id);
    expect(after.status).toBe('approved');
    expect(after.consecutiveFetchFailures).toBe(0);
    const changes = db.select().from(locationChanges).where(eq(locationChanges.locationId, warn.id)).all();
    expect(changes[0]!.resolvedAt).toEqual(now);
    expect(db.select().from(locationSnapshots).where(eq(locationSnapshots.locationId, warn.id)).all()).toHaveLength(1);
  });

  it('approve is atomic when the snapshot insert fails', () => {
    const loc = fresh();
    db.insert(locationChanges)
      .values({ locationId: loc.id, detectedAt: now, field: 'phone', oldValue: 'a', newValue: 'b' })
      .run();
    db.run(sql`CREATE TRIGGER fail_snapshot BEFORE INSERT ON location_snapshots BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => approveLocation(db, loc.id, now)).toThrow();
    expect(row(loc.id).status).toBe('candidate');
    expect(row(loc.id).lastVerifiedAt).toBeNull();
    const changes = db.select().from(locationChanges).where(eq(locationChanges.locationId, loc.id)).all();
    expect(changes[0]!.resolvedAt).toBeNull();
  });
});

describe('admin location routes', () => {
  it('admin create form inserts a candidate with distance', async () => {
    const res = await post(
      '/admin/locations',
      new URLSearchParams({
        category_id: String(dentistId()),
        name: 'Form Dental',
        lat: '40.78',
        lng: '-111.89',
        walk_ins: 'yes',
      }).toString(),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin/locations');
    const created = db.select().from(locations).where(eq(locations.name, 'Form Dental')).get()!;
    expect(created.status).toBe('candidate');
    expect(created.distanceMi).toBeGreaterThan(0);
    expect(created.walkIns).toBe(true);
  });

  it('admin approve route', async () => {
    const loc = fresh();
    const res = await post(`/admin/locations/${loc.id}/approve`);
    expect(res.status).toBe(302);
    expect(row(loc.id).status).toBe('approved');
  });

  it('admin reject route on rejected is 409', async () => {
    const loc = fresh();
    rejectLocation(db, loc.id, now);
    const res = await post(`/admin/locations/${loc.id}/reject`);
    expect(res.status).toBe(409);
    expect(row(loc.id).status).toBe('rejected');
  });

  it('lat without lng is 400', async () => {
    const res = await post(
      '/admin/locations',
      new URLSearchParams({ category_id: String(dentistId()), name: 'Half Dental', lat: '40.78' }).toString(),
    );
    expect(res.status).toBe(400);
    expect(db.select().from(locations).where(eq(locations.name, 'Half Dental')).all()).toHaveLength(0);
  });

  it('list page offers approve for candidates and a new link', async () => {
    const loc = fresh();
    const html = await (await app.request('/admin/locations', { headers: { cookie } })).text();
    expect(html).toContain('Fresh Dental');
    expect(html).toContain(`/admin/locations/${loc.id}/approve`);
    expect(html).toContain('/admin/locations/new');
  });
});
