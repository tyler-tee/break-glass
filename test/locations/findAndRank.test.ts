import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { findRuns, locations, settings } from '../../src/db/schema.js';
import { createCategory } from '../../src/features/categories/repo.js';
import {
  FindRunActive,
  NoHomeLocation,
  latestRun,
  rankedView,
  recoverInterruptedRuns,
  runFindRun,
  startFindRun,
  type FindRunDeps,
} from '../../src/features/locations/findAndRank.js';
import { LocationError } from '../../src/features/locations/service.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import { CallBudget } from '../../src/services/places/client.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const PLACES_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const LLM_DIR = path.resolve(import.meta.dirname, '../fixtures/llm');
const now = new Date('2026-10-28T16:00:00Z');
const earlier = new Date('2026-10-01T16:00:00Z');
const MODEL = 'claude-opus-5-5';

let db: Db;
let pharmacy: number;
let urgent: number;

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const runDeps = (over: Partial<FindRunDeps> & { cap?: number; fetch?: typeof fetch } = {}): FindRunDeps => {
  const { cap = 10, fetch, ...rest } = over;
  return {
    places: { fetch: fetch ?? recordingFetch(PLACES_DIR, 'replay'), apiKey: 'test-key', budget: new CallBudget(cap) },
    model: MODEL,
    now: () => now,
    log: logger(),
    ...rest,
  };
};
const withLlm = (over: Parameters<typeof runDeps>[0] = {}) => runDeps({ llm: fixtureProvider(LLM_DIR), ...over });

/** Starts and awaits a run the way the routes do, minus the fire-and-forget. */
async function run(categoryIds: number[], deps: FindRunDeps) {
  const id = db
    .insert(findRuns)
    .values({
      startedAt: now,
      status: 'running',
      categoryIds,
      progress: Object.fromEntries(categoryIds.map((c) => [String(c), { state: 'waiting' as const }])),
    })
    .returning()
    .get().id;
  return runFindRun(db, id, deps);
}

const rowsOf = (categoryId: number) => db.select().from(locations).where(eq(locations.categoryId, categoryId)).all();
const byName = (categoryId: number, name: string) => rowsOf(categoryId).find((r) => r.name === name)!;
const add = (values: Partial<typeof locations.$inferInsert> & { categoryId: number; name: string }) =>
  db.insert(locations).values({ status: 'candidate', createdAt: earlier, updatedAt: earlier, ...values }).returning().get();

beforeEach(() => {
  db = createTestDb();
  pharmacy = createCategory(db, { name: '24-hour pharmacy', searchTerms: ['24 hour pharmacy', 'late night pharmacy'] }).id;
  urgent = createCategory(db, { name: 'Urgent care', searchTerms: ['urgent care'], hoursNeed: 'daytime' }).id;
});

describe('runFindRun', () => {
  it('searches, stores and ranks every category; the LLM ranks one and rules rank the other when it fails', async () => {
    const deps = withLlm();
    const result = await run([pharmacy, urgent], deps);

    expect(result).toMatchObject({ status: 'done', callsUsed: 3, llmCalls: 2, finishedAt: now, error: null });
    expect(result.progress[String(pharmacy)]).toEqual({ state: 'done', found: 6 });
    // No fixture exists for the urgent care prompt, so the LLM "fails" and the rules take over.
    expect(result.progress[String(urgent)]).toMatchObject({ state: 'done', found: 2 });
    expect(result.progress[String(urgent)]!.message).toMatch(/^AI ranking failed, so these were ranked by rules: /);

    const stored = rowsOf(pharmacy);
    // Rite Aid (permanently closed) and the Provo pharmacy (past the radius) are never stored.
    expect(stored.map((r) => r.placeId).sort()).toEqual(['ChIJcvs24', 'ChIJday', 'ChIJjunk', 'ChIJsmiths', 'ChIJwag1', 'ChIJwag2']);
    expect(stored.every((r) => r.status === 'candidate' && r.rankedBy === 'llm' && r.rankedAt?.getTime() === now.getTime())).toBe(true);
    expect(byName(pharmacy, 'Walgreens Pharmacy')).toMatchObject({
      rankVerdict: 'pick',
      rankPosition: 1,
      rankReason: 'Nearest true 24-hour pharmacy, 4.1★ over 412 reviews.',
      rankFlags: [],
    });
    expect(byName(pharmacy, 'Walgreens')).toMatchObject({ rankVerdict: 'avoid', rankFlags: ['duplicate'] });
    expect(byName(pharmacy, 'CVS Pharmacy')).toMatchObject({
      rankVerdict: 'pick',
      rankPosition: 2,
      address: '1400 S 700 E, Salt Lake City, UT 84105, USA',
      shortAddress: '1400 S 700 E, Salt Lake City',
      primaryType: 'Pharmacy',
      mapsUri: 'https://maps.google.com/?cid=1001',
      phone: '(801) 555-0300',
      rating: 3.8,
      ratingCount: 121,
      lat: 40.75,
    });
    expect(byName(pharmacy, 'CVS Pharmacy').hours?.periods['1']).toEqual([{ open: '1400', close: '1330' }]);
    expect(byName(pharmacy, 'CVS Pharmacy').distanceMi).toBeCloseTo(0.75, 1);
    // Reviews feed the prompt only.
    expect(JSON.stringify(stored)).not.toContain('Lifesaver');

    const clinic = rowsOf(urgent);
    expect(clinic.every((r) => r.rankedBy === 'rules')).toBe(true);
    expect(byName(urgent, 'Instacare Downtown')).toMatchObject({ rankVerdict: 'pick', rankPosition: 1 });
    expect(deps.log.warn).toHaveBeenCalled();
  });

  it('ranks by rules without an LLM provider', async () => {
    const result = await run([pharmacy], runDeps());
    expect(result).toMatchObject({ status: 'done', llmCalls: 0, callsUsed: 2 });
    expect(result.progress[String(pharmacy)]).toEqual({ state: 'done', found: 6 });
    const stored = rowsOf(pharmacy);
    expect(stored.every((r) => r.rankedBy === 'rules')).toBe(true);
    expect(byName(pharmacy, 'Main Street Pharmacy')).toMatchObject({ rankVerdict: 'avoid', rankFlags: ['not_24h'] });
    expect(byName(pharmacy, "Smith's Pharmacy")).toMatchObject({ rankVerdict: 'avoid', rankFlags: ['closed_temporarily'] });
    expect(stored.filter((r) => r.rankVerdict === 'pick').map((r) => r.name).sort()).toEqual([
      'CVS Pharmacy',
      'Walgreens',
      'Walgreens Pharmacy',
    ]);
  });

  it('ranks stored places with the new results, keeps current picks approved and skips places rejected here', async () => {
    const picked = add({
      categoryId: pharmacy,
      placeId: 'ChIJcvs24',
      name: 'CVS Pharmacy',
      phone: '(801) 555-9999',
      rating: 4.9,
      status: 'approved',
    });
    const manual = add({ categoryId: pharmacy, name: 'Hospital Pharmacy', distanceMi: 3, rating: 4.4, ratingCount: 50, status: 'approved' });
    const rejected = add({ categoryId: pharmacy, placeId: 'ChIJjunk', name: 'Pharma Anabolics Shop', status: 'rejected', rankVerdict: 'pick', rankPosition: 1 });
    const closed = add({ categoryId: pharmacy, placeId: 'ChIJriteaid', name: 'Rite Aid', businessStatus: 'OPERATIONAL' });
    // Rejected in another category only: still a candidate here.
    const otherCategory = createCategory(db, { name: 'Emergency room', searchTerms: ['emergency room'] }).id;
    add({ categoryId: otherCategory, placeId: 'ChIJwag1', name: 'Walgreens Pharmacy', status: 'rejected' });

    await run([pharmacy], runDeps());

    const cvs = rowsOf(pharmacy).find((r) => r.id === picked.id)!;
    // An approved row keeps its tracked fields; refresh and review own those. Display facts and rank update.
    expect(cvs).toMatchObject({ status: 'approved', phone: '(801) 555-9999', rating: 4.9, shortAddress: '1400 S 700 E, Salt Lake City' });
    expect(cvs.rankVerdict).not.toBeNull();
    expect(rowsOf(pharmacy).filter((r) => r.placeId === 'ChIJcvs24')).toHaveLength(1);

    const hospital = rowsOf(pharmacy).find((r) => r.id === manual.id)!;
    expect(hospital.status).toBe('approved');
    expect(hospital.rankVerdict).not.toBeNull();

    const junk = rowsOf(pharmacy).find((r) => r.id === rejected.id)!;
    expect(junk).toMatchObject({ status: 'rejected', rankVerdict: null, rankPosition: null });
    expect(rowsOf(pharmacy).filter((r) => r.placeId === 'ChIJjunk')).toHaveLength(1);

    // A stored candidate now reported permanently closed: facts updated, shown last as avoid.
    const riteAid = rowsOf(pharmacy).find((r) => r.id === closed.id)!;
    expect(riteAid).toMatchObject({
      businessStatus: 'CLOSED_PERMANENTLY',
      rankVerdict: 'avoid',
      rankReason: 'Marked permanently closed by Google.',
      rankedBy: 'rules',
    });
    expect(riteAid.rankPosition).toBe(Math.max(...rowsOf(pharmacy).map((r) => r.rankPosition ?? 0)));

    expect(byName(pharmacy, 'Walgreens Pharmacy').status).toBe('candidate');
  });

  it('clears an old rank from a stored place that is no longer ranked', async () => {
    const gone = add({ categoryId: pharmacy, placeId: 'ChIJold', name: 'Old', status: 'rejected', rankVerdict: 'pick', rankPosition: 1, rankedBy: 'llm', rankedAt: earlier });
    await run([pharmacy], runDeps());
    expect(rowsOf(pharmacy).find((r) => r.id === gone.id)).toMatchObject({ rankVerdict: null, rankPosition: null, rankedBy: null, rankedAt: null });
  });

  it('a category with no results finishes with nothing found and no LLM call', async () => {
    const empty = createCategory(db, { name: 'Nothing', searchTerms: ['nothing open zzz'] }).id;
    const old = add({ categoryId: empty, placeId: 'ChIJx', name: 'X', status: 'rejected', rankVerdict: 'pick', rankPosition: 1 });
    const result = await run([empty], withLlm());
    expect(result).toMatchObject({ status: 'done', llmCalls: 0, callsUsed: 1 });
    expect(result.progress[String(empty)]).toEqual({ state: 'done', found: 0 });
    expect(rowsOf(empty).find((r) => r.id === old.id)!.rankVerdict).toBeNull();
  });

  it('stops later categories when the run budget runs out, and keeps finished results', async () => {
    const third = createCategory(db, { name: 'Dentist', searchTerms: ['emergency dentist'] }).id;
    const result = await run([pharmacy, urgent, third], runDeps({ cap: 2 }));
    expect(result.status).toBe('done');
    expect(result.callsUsed).toBe(2);
    expect(result.progress[String(pharmacy)]).toEqual({ state: 'done', found: 6 });
    const stop = 'Too many Places calls in one go. Try again in a moment.';
    expect(result.progress[String(urgent)]).toEqual({ state: 'stopped', message: stop });
    expect(result.progress[String(third)]).toEqual({ state: 'stopped', message: stop });
    expect(rowsOf(pharmacy)).toHaveLength(6);
    expect(rowsOf(urgent)).toHaveLength(0);
  });

  it('a category whose search fails is failed in plain words, and the next one still runs', async () => {
    const real = recordingFetch(PLACES_DIR, 'replay');
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) =>
      String(init?.body).includes('urgent care')
        ? new Response('{"error":{"message":"RAW BODY test-key"}}', { status: 403 })
        : real(input, init)) as typeof fetch;
    const result = await run([urgent, pharmacy], runDeps({ fetch: fetchFn }));
    expect(result.status).toBe('done');
    const failed = result.progress[String(urgent)]!;
    expect(failed.state).toBe('failed');
    expect(failed.message).toContain('Google rejected this key');
    expect(failed.message).not.toContain('test-key');
    expect(result.progress[String(pharmacy)]!.state).toBe('done');
  });

  it('marks a category of a deleted category as failed', async () => {
    const result = await run([9999, pharmacy], runDeps());
    expect(result.progress['9999']).toEqual({ state: 'failed', message: 'This category was deleted.' });
    expect(result.status).toBe('done');
  });

  it('an unexpected error fails the run and every unfinished category', async () => {
    const boom = (async () => {
      throw new RangeError('boom');
    }) as unknown as typeof fetch;
    await expect(run([pharmacy, urgent], runDeps({ fetch: boom }))).rejects.toThrow('boom');
    const failed = latestRun(db)!;
    expect(failed).toMatchObject({ status: 'failed', error: 'boom', finishedAt: now });
    expect(failed.progress[String(urgent)]).toEqual({ state: 'failed', message: 'boom' });
  });
});

describe('startFindRun', () => {
  it('returns at once with a running run, refuses a second one, and finishes in the background', async () => {
    const id = startFindRun(db, [pharmacy, urgent], runDeps());
    const started = latestRun(db)!;
    expect(started).toMatchObject({ id, status: 'running', categoryIds: [pharmacy, urgent], startedAt: now });
    expect(Object.values(started.progress).map((p) => p.state)).toContain('waiting');
    expect(() => startFindRun(db, [pharmacy], runDeps())).toThrow(FindRunActive);

    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
    expect(db.select().from(findRuns).all()).toHaveLength(1);
    expect(rowsOf(pharmacy)).toHaveLength(6);
    // Once finished, another run may start.
    expect(startFindRun(db, [pharmacy], runDeps())).toBe(id + 1);
    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('done'));
  });

  it('marks the run failed when the background work throws', async () => {
    const boom = (async () => {
      throw new RangeError('boom');
    }) as unknown as typeof fetch;
    const deps = runDeps({ fetch: boom });
    startFindRun(db, [pharmacy], deps);
    await vi.waitFor(() => expect(latestRun(db)!.status).toBe('failed'));
    expect(latestRun(db)!.error).toBe('boom');
    await vi.waitFor(() => expect(deps.log.error).toHaveBeenCalled());
  });

  it('refuses without a home location, an unknown category, or no categories, and records nothing', () => {
    expect(() => startFindRun(db, [9999], runDeps())).toThrow(LocationError);
    expect(() => startFindRun(db, [], runDeps())).toThrow(LocationError);
    db.update(settings).set({ homeLat: null, homeLng: null }).run();
    expect(() => startFindRun(db, [pharmacy], runDeps())).toThrow(NoHomeLocation);
    expect(latestRun(db)).toBeNull();
  });
});

describe('recoverInterruptedRuns', () => {
  it('fails runs left running by a restart and leaves finished ones alone', () => {
    db.insert(findRuns)
      .values({ startedAt: earlier, status: 'done', categoryIds: [pharmacy], progress: { [pharmacy]: { state: 'done', found: 1 } } })
      .run();
    db.insert(findRuns)
      .values({
        startedAt: earlier,
        status: 'running',
        categoryIds: [pharmacy, urgent],
        progress: { [pharmacy]: { state: 'done', found: 4 }, [urgent]: { state: 'searching' } },
      })
      .run();
    expect(recoverInterruptedRuns(db, now)).toBe(1);
    expect(recoverInterruptedRuns(db, now)).toBe(0);
    const runs = db.select().from(findRuns).all();
    expect(runs[0]).toMatchObject({ status: 'done', error: null });
    expect(runs[1]).toMatchObject({ status: 'failed', error: 'Interrupted by a restart', finishedAt: now });
    expect(runs[1]!.progress).toEqual({
      [pharmacy]: { state: 'done', found: 4 },
      [urgent]: { state: 'failed', message: 'Interrupted by a restart' },
    });
  });
});

describe('rankedView', () => {
  it('lists picks, backups, avoid, then unranked, without rejected places', async () => {
    await run([pharmacy], withLlm());
    add({ categoryId: pharmacy, name: 'Manual unranked', distanceMi: 1, status: 'approved' });
    add({ categoryId: pharmacy, name: 'Rejected', status: 'rejected' });
    const view = rankedView(db, pharmacy);
    expect(view.map((r) => [r.name, r.rankVerdict])).toEqual([
      ['Walgreens Pharmacy', 'pick'],
      ['CVS Pharmacy', 'pick'],
      ['Walgreens', 'avoid'],
      ['Main Street Pharmacy', 'avoid'],
      ["Smith's Pharmacy", 'avoid'],
      ['Pharma Anabolics Shop', 'avoid'],
      ['Manual unranked', null],
    ]);
    expect(view.map((r) => r.currentPick)).toEqual([false, false, false, false, false, false, true]);
    expect(view[1]!.hoursProfile).toMatchObject({ open24h: true, dailyGapNote: 'Closed 1:30–2 PM daily' });
    expect(rankedView(db, urgent)).toEqual([]);
  });
});
