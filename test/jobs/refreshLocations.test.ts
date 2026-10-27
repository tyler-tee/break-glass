import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { locationChanges, locationSnapshots, locations } from '../../src/db/schema.js';
import { hashTracked, normalizeTracked } from '../../src/domain/snapshot.js';
import type { TrackedFields } from '../../src/domain/types.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { refreshLocations } from '../../src/jobs/refreshLocations.js';
import { CallBudget } from '../../src/services/places/client.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const now = new Date('2026-10-27T16:00:00Z');
const earlier = new Date('2026-10-20T16:00:00Z');
const silent = { info: () => {}, warn: () => {}, error: () => {} };

const day = [{ open: '0800', close: '1700' }];
const nearHours = {
  periods: { '0': [], '1': day, '2': day, '3': day, '4': day, '5': day, '6': [] },
  weekdayText: [
    'Monday: 8:00 AM – 5:00 PM',
    'Tuesday: 8:00 AM – 5:00 PM',
    'Wednesday: 8:00 AM – 5:00 PM',
    'Thursday: 8:00 AM – 5:00 PM',
    'Friday: 8:00 AM – 5:00 PM',
  ],
};

const nearPayload = (over: Partial<TrackedFields> = {}): TrackedFields =>
  normalizeTracked({
    name: 'Near Dental Group',
    address: '100 S Main St, Salt Lake City, UT 84101, USA',
    phone: '(801) 555-0100',
    website: 'https://near-dental.example',
    hours: nearHours,
    businessStatus: 'OPERATIONAL',
    rating: 4.6,
    ratingCount: 120,
    ...over,
  });

let db: Db;
let categoryId: number;

const deps = (cap = 10) => ({
  places: { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(cap) },
  env: { REFRESH_FAILURE_THRESHOLD: 3, RATING_WARN_DELTA: 0.5 },
  now: () => now,
  log: silent,
});

function addLocation(values: Partial<typeof locations.$inferInsert> & { name: string }, snapshot?: TrackedFields): number {
  const row = db
    .insert(locations)
    .values({ categoryId, status: 'approved', createdAt: earlier, updatedAt: earlier, ...values })
    .returning()
    .get();
  if (snapshot) {
    db.insert(locationSnapshots)
      .values({ locationId: row.id, fetchedAt: earlier, payload: snapshot, hash: hashTracked(snapshot) })
      .run();
  }
  return row.id;
}
const rowOf = (id: number) => db.select().from(locations).where(eq(locations.id, id)).get()!;
const snapshotsOf = (id: number) =>
  db.select().from(locationSnapshots).where(eq(locationSnapshots.locationId, id)).orderBy(asc(locationSnapshots.id)).all();
const changesOf = (id: number) => db.select().from(locationChanges).where(eq(locationChanges.locationId, id)).all();

beforeEach(() => {
  db = createTestDb();
  categoryId = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] }).id;
});

describe('refreshLocations', () => {
  it('approved -> warn with change row phone old->new', async () => {
    const id = addLocation(
      { name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0199' },
      nearPayload({ phone: '(801) 555-0199' }),
    );
    const report = await refreshLocations(db, deps());
    expect(report).toMatchObject({ checked: 1, warned: 1, unchanged: 0, failed: 0, baselined: 0, stoppedEarly: false });
    const row = rowOf(id);
    expect(row.status).toBe('warn');
    expect(row.phone).toBe('(801) 555-0199');
    expect(row.lastVerifiedAt).toEqual(now);
    const changes = changesOf(id);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ field: 'phone', resolvedAt: null, detectedAt: now });
    expect(changes[0]!.oldValue).toContain('0199');
    expect(changes[0]!.newValue).toContain('0100');
    const snaps = snapshotsOf(id);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.payload.phone).toBe('(801) 555-0100');
    expect(snaps[1]!.fetchedAt).toEqual(now);
  });

  it('unchanged fixture bumps last_verified_at only', async () => {
    const id = addLocation({ name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0100' }, nearPayload());
    const report = await refreshLocations(db, deps());
    expect(report).toMatchObject({ checked: 1, unchanged: 1, warned: 0, failed: 0, callsUsed: 1 });
    expect(rowOf(id)).toMatchObject({ status: 'approved', lastVerifiedAt: now });
    expect(snapshotsOf(id)).toHaveLength(1);
    expect(changesOf(id)).toHaveLength(0);
  });

  it('404 increments failures, status unchanged', async () => {
    const id = addLocation({ name: 'Gone Dental', placeId: 'ChIJgone' }, nearPayload());
    const first = await refreshLocations(db, deps());
    expect(first).toMatchObject({ checked: 1, failed: 1, warned: 0 });
    expect(rowOf(id)).toMatchObject({ status: 'approved', consecutiveFetchFailures: 1, lastVerifiedAt: null });
    expect(changesOf(id)).toHaveLength(0);

    await refreshLocations(db, deps());
    await refreshLocations(db, deps());
    expect(rowOf(id)).toMatchObject({ status: 'warn', consecutiveFetchFailures: 3 });
    const changes = changesOf(id);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.field).toBe('verification');

    await refreshLocations(db, deps());
    expect(rowOf(id).consecutiveFetchFailures).toBe(4);
    expect(changesOf(id)).toHaveLength(1);
    expect(snapshotsOf(id)).toHaveLength(1);
  });

  it('budget exhaustion stops the run with partial report', async () => {
    const a = addLocation({ name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0100' }, nearPayload());
    const b = addLocation({ name: 'Gone Dental', placeId: 'ChIJgone' }, nearPayload());
    const report = await refreshLocations(db, deps(1));
    expect(report).toMatchObject({ checked: 1, unchanged: 1, stoppedEarly: true, callsUsed: 1 });
    expect(rowOf(a).lastVerifiedAt).toEqual(now);
    expect(rowOf(b)).toMatchObject({ consecutiveFetchFailures: 0, lastVerifiedAt: null });
  });

  it('seeded location without snapshot gets baseline snapshot, no warn', async () => {
    const id = addLocation({ name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0199' });
    const report = await refreshLocations(db, deps());
    expect(report).toMatchObject({ checked: 1, baselined: 1, warned: 0, unchanged: 0 });
    const snaps = snapshotsOf(id);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.hash).toBe(hashTracked(snaps[0]!.payload));
    expect(snaps[0]!.payload.phone).toBe('(801) 555-0100');
    expect(rowOf(id)).toMatchObject({ status: 'approved', lastVerifiedAt: now, consecutiveFetchFailures: 0 });
    expect(changesOf(id)).toHaveLength(0);
  });

  it('manual locations without place_id are skipped', async () => {
    const manual = addLocation({ name: 'Manual Clinic', phone: '(801) 555-0123' });
    addLocation({ name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0100' }, nearPayload());
    const report = await refreshLocations(db, deps());
    expect(report).toMatchObject({ checked: 1, callsUsed: 1 });
    expect(rowOf(manual)).toMatchObject({ lastVerifiedAt: null, updatedAt: earlier, consecutiveFetchFailures: 0 });
    expect(snapshotsOf(manual)).toHaveLength(0);
  });

  it('note fields are carried forward not diffed', async () => {
    const id = addLocation(
      { name: 'Near Dental Group', placeId: 'ChIJnear', phone: '(801) 555-0100', afterHoursNotes: 'Call first' },
      nearPayload({ afterHoursNotes: 'Call first' }),
    );
    const report = await refreshLocations(db, deps());
    expect(report).toMatchObject({ checked: 1, unchanged: 1, warned: 0 });
    expect(changesOf(id)).toHaveLength(0);
    expect(rowOf(id).status).toBe('approved');
  });
});
