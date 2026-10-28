import { asc, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import type { Db } from '../../src/db/client.js';
import { locationChanges, locationSnapshots, locations } from '../../src/db/schema.js';
import { hashTracked, trackedFromLocation } from '../../src/domain/snapshot.js';
import { loadEnv } from '../../src/env.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { neverSuggest, savePicks } from '../../src/features/locations/picks.js';
import { getLocation } from '../../src/features/locations/repo.js';
import { LocationError } from '../../src/features/locations/service.js';
import type { Extractor } from '../../src/services/llm/extract.js';
import { createTestDb } from '../helpers/testDb.js';

const now = new Date('2026-10-28T16:00:00Z');
const earlier = new Date('2026-10-01T16:00:00Z');
let db: Db;
let categoryId: number;

const add = (values: Partial<typeof locations.$inferInsert> & { name: string }) =>
  db.insert(locations).values({ categoryId, status: 'candidate', createdAt: earlier, updatedAt: earlier, ...values }).returning().get().id;
const statusOf = (id: number) => getLocation(db, id)!.status;
const snapshotsOf = (id: number) =>
  db.select().from(locationSnapshots).where(eq(locationSnapshots.locationId, id)).orderBy(asc(locationSnapshots.id)).all();

beforeEach(() => {
  db = createTestDb();
  categoryId = createCategory(db, { name: '24-hour pharmacy', searchTerms: ['24 hour pharmacy'] }).id;
});

describe('savePicks', () => {
  it('approves new picks and demotes former picks that were not selected', () => {
    const a = add({ name: 'A' });
    const b = add({ name: 'B', status: 'approved' });
    const c = add({ name: 'C', status: 'approved' });
    const d = add({ name: 'D' });

    expect(savePicks(db, categoryId, [a, b], now)).toEqual({ added: [a], removed: [c] });
    expect([a, b, c, d].map(statusOf)).toEqual(['approved', 'approved', 'candidate', 'candidate']);
    expect(getLocation(db, a)).toMatchObject({ lastVerifiedAt: now, updatedAt: now });
    // approveLocation records the baseline snapshot refresh compares against.
    expect(snapshotsOf(a)).toHaveLength(1);
    // A demoted pick keeps everything but its status.
    expect(getLocation(db, c)).toMatchObject({ name: 'C', updatedAt: now });
  });

  it('re-approves a selected warn place (adopting its latest details) and demotes an unselected one', () => {
    const warned = add({ name: 'Warned', status: 'warn', phone: '(801) 555-0001' });
    const fetched = { ...trackedFromLocation(getLocation(db, warned)!), phone: '(801) 555-0002' };
    db.insert(locationSnapshots).values({ locationId: warned, fetchedAt: earlier, payload: fetched, hash: hashTracked(fetched) }).run();
    db.insert(locationChanges)
      .values({ locationId: warned, detectedAt: earlier, field: 'phone', oldValue: '(801) 555-0001', newValue: '(801) 555-0002' })
      .run();
    const otherWarn = add({ name: 'Other warn', status: 'warn' });

    expect(savePicks(db, categoryId, [warned], now)).toEqual({ added: [], removed: [otherWarn] });
    expect(getLocation(db, warned)).toMatchObject({ status: 'approved', phone: '(801) 555-0002' });
    expect(db.select().from(locationChanges).where(eq(locationChanges.locationId, warned)).get()!.resolvedAt).toEqual(now);
    expect(statusOf(otherWarn)).toBe('candidate');
  });

  it('leaves an already approved pick alone and saving no picks demotes them all', () => {
    const a = add({ name: 'A', status: 'approved' });
    expect(savePicks(db, categoryId, [a, a], now)).toEqual({ added: [], removed: [] });
    expect(snapshotsOf(a)).toHaveLength(0);
    expect(savePicks(db, categoryId, [], now)).toEqual({ added: [], removed: [a] });
    expect(statusOf(a)).toBe('candidate');
  });

  it('refuses more than three picks, places from another category, rejected places and unknown categories', () => {
    const ids = [add({ name: '1' }), add({ name: '2' }), add({ name: '3' }), add({ name: '4' })];
    const kept = add({ name: 'Kept', status: 'approved' });
    const expectInvalid = (fn: () => unknown, message: RegExp) => {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(LocationError);
      expect((err as LocationError).message).toMatch(message);
    };
    expectInvalid(() => savePicks(db, categoryId, ids, now), /at most 3/);

    const other = createCategory(db, { name: 'Urgent care', searchTerms: ['urgent care'] }).id;
    const elsewhere = db
      .insert(locations)
      .values({ categoryId: other, name: 'Elsewhere', status: 'candidate', createdAt: earlier, updatedAt: earlier })
      .returning()
      .get().id;
    expectInvalid(() => savePicks(db, categoryId, [ids[0]!, elsewhere], now), /not in this category/);
    expectInvalid(() => savePicks(db, categoryId, [424242], now), /not in this category/);

    const rejected = add({ name: 'Never', status: 'rejected' });
    expectInvalid(() => savePicks(db, categoryId, [rejected], now), /Never is set to never be suggested/);
    expect(() => savePicks(db, 9999, [], now)).toThrow(LocationError);

    // Nothing changed.
    expect(ids.map(statusOf)).toEqual(['candidate', 'candidate', 'candidate', 'candidate']);
    expect(statusOf(kept)).toBe('approved');
  });

  it('a new pick shows up for the family, and a demoted one disappears', async () => {
    const a = add({ name: 'Picked Pharmacy' });
    const b = add({ name: 'Dropped Pharmacy', status: 'approved' });
    const app = createApp({ db, env: loadEnv({ SESSION_SECRET: 's'.repeat(32), ADMIN_PASSWORD_HASH: 'x' }), now: () => now });
    savePicks(db, categoryId, [a], now);
    const html = await (await app.request('/search?q=pharmacy')).text();
    expect(html).toContain('Picked Pharmacy');
    expect(html).not.toContain('Dropped Pharmacy');
    expect(statusOf(b)).toBe('candidate');
  });

  it('reads website notes for the new picks in the background, and refreshes their snapshot', async () => {
    const a = add({ name: 'A', website: 'https://a.example' });
    const noSite = add({ name: 'No site' });
    const already = add({ name: 'Already', status: 'approved', website: 'https://already.example' });
    const extract = vi.fn<Extractor>(async () => ({
      extraction: {
        afterHoursNotes: { value: 'Call the on-call line', sourceUrl: null },
        walkIns: { value: true, sourceUrl: null },
        insuranceNotes: { value: 'Accepts Delta Dental', sourceUrl: null },
      },
      pageHash: 'hash-a',
    }));

    const result = savePicks(db, categoryId, [a, noSite, already], now, { extract });
    // savePicks returns before the extractor has run.
    expect(result.added).toEqual([a, noSite]);
    expect(getLocation(db, a)!.afterHoursNotes).toBeNull();

    await vi.waitFor(() => expect(getLocation(db, a)!.websiteHash).toBe('hash-a'));
    expect(extract.mock.calls.map(([w]) => w)).toEqual(['https://a.example']);
    expect(getLocation(db, a)).toMatchObject({ afterHoursNotes: 'Call the on-call line', walkIns: true, insuranceNotes: 'Accepts Delta Dental' });
    const snaps = snapshotsOf(a);
    expect(snaps).toHaveLength(2);
    expect(snaps[1]!.payload.afterHoursNotes).toBe('Call the on-call line');
  });

  it('a failing extractor is logged and leaves the picks saved', async () => {
    const a = add({ name: 'A', website: 'https://a.example' });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const extract = vi.fn<Extractor>(async () => {
      throw new Error('site down');
    });
    savePicks(db, categoryId, [a], now, { extract, log });
    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('site down')));
    expect(statusOf(a)).toBe('approved');
  });
});

describe('neverSuggest', () => {
  it('rejects a candidate or a current pick for good', () => {
    const a = add({ name: 'A' });
    const b = add({ name: 'B', status: 'approved' });
    expect(neverSuggest(db, a, now).status).toBe('rejected');
    expect(neverSuggest(db, b, now).status).toBe('rejected');
    expect(() => neverSuggest(db, a, now)).toThrow(LocationError);
    expect(() => neverSuggest(db, 9999, now)).toThrow(LocationError);
  });
});
