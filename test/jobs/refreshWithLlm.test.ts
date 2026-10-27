import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { locationChanges, locationSnapshots, locations } from '../../src/db/schema.js';
import { hashTracked, normalizeTracked } from '../../src/domain/snapshot.js';
import type { TrackedFields } from '../../src/domain/types.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { refreshLocations } from '../../src/jobs/refreshLocations.js';
import { makeExtractor, type Extraction, type Extractor } from '../../src/services/llm/extract.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import { CallBudget } from '../../src/services/places/client.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';
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
beforeEach(() => {
  db = createTestDb();
  categoryId = createCategory(db, { name: 'Test Dentist', searchTerms: ['emergency dentist'] }).id;
});

const deps = (extract: Extractor) => ({
  places: { fetch: recordingFetch(FIXTURE_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(10) },
  env: { REFRESH_FAILURE_THRESHOLD: 3, RATING_WARN_DELTA: 0.5 },
  now: () => now,
  log: silent,
  extract,
});

function seedRow(): number {
  const snapshot = nearPayload({ afterHoursNotes: 'Call first' });
  const row = db
    .insert(locations)
    .values({
      categoryId,
      status: 'approved',
      createdAt: earlier,
      updatedAt: earlier,
      name: 'Near Dental Group',
      placeId: 'ChIJnear',
      website: 'https://near-dental.example',
      afterHoursNotes: 'Call first',
    })
    .returning()
    .get();
  db.insert(locationSnapshots)
    .values({ locationId: row.id, fetchedAt: earlier, payload: snapshot, hash: hashTracked(snapshot) })
    .run();
  return row.id;
}

describe('refreshLocations with extraction', () => {
  it('refresh with malformed extraction completes and keeps notes unchanged', async () => {
    const id = seedRow();
    const report = await refreshLocations(db, deps(async () => ({ extraction: null, pageHash: null })));
    expect(report).toMatchObject({ checked: 1, failed: 0, extracted: 0 });
    expect(db.select().from(locationChanges).where(eq(locationChanges.locationId, id)).all()).toHaveLength(0);
    const row = db.select().from(locations).where(eq(locations.id, id)).get()!;
    expect(row.status).toBe('approved');
    expect(row.afterHoursNotes).toBe('Call first');
  });

  it('refresh with extraction records note changes', async () => {
    const id = seedRow();
    const extraction: Extraction = {
      afterHoursNotes: { value: 'Call first', sourceUrl: null },
      walkIns: { value: null, sourceUrl: null },
      insuranceNotes: { value: 'Now accepts Aetna', sourceUrl: 'https://near-dental.example/insurance' },
    };
    const report = await refreshLocations(db, deps(async () => ({ extraction, pageHash: 'h1' })));
    expect(report).toMatchObject({ checked: 1, warned: 1, extracted: 1 });
    const changes = db.select().from(locationChanges).where(eq(locationChanges.locationId, id)).all();
    expect(changes.map((c) => c.field)).toEqual(['insuranceNotes']);
    expect(db.select().from(locations).where(eq(locations.id, id)).get()!.status).toBe('warn');
  });

  describe('page-hash gating', () => {
    const WEB_DIR = path.resolve(import.meta.dirname, '../fixtures/web');
    const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
    let call = 0;
    const generateJson = vi.fn(async () => {
      call++;
      return {
        afterHoursNotes: { value: `Reworded note ${call}`, sourceUrl: null },
        walkIns: { value: null, sourceUrl: null },
        insuranceNotes: { value: null, sourceUrl: null },
      };
    });
    const llm = { generateJson } as unknown as LlmProvider;
    const extractorOver = (siteFetch: typeof fetch) =>
      makeExtractor({ llm, fetch: siteFetch, model: 'm', log: silent, lookup: publicLookup });
    const changed = (base: typeof fetch): typeof fetch =>
      (async (input: string | URL | Request, init?: RequestInit) => {
        const res = await base(input, init);
        const text = await res.text();
        return new Response(text.replace('</body>', '<p>New hours notice</p></body>'), {
          status: res.status,
          headers: res.headers,
        });
      }) as typeof fetch;

    beforeEach(() => {
      call = 0;
      generateJson.mockClear();
    });

    it('refresh skips extraction when the page is unchanged', async () => {
      const id = seedRow();
      const extract = extractorOver(fakeSiteFetch(WEB_DIR));
      await refreshLocations(db, deps(extract));
      expect(generateJson).toHaveBeenCalledTimes(1);
      const hash = db.select().from(locations).where(eq(locations.id, id)).get()!.websiteHash;
      expect(hash).toMatch(/^[0-9a-f]{64}$/);

      const changesAfterFirst = db.select().from(locationChanges).where(eq(locationChanges.locationId, id)).all().length;
      const report = await refreshLocations(db, deps(extract));
      expect(generateJson).toHaveBeenCalledTimes(1);
      expect(report.extracted).toBe(0);
      expect(db.select().from(locationChanges).where(eq(locationChanges.locationId, id)).all()).toHaveLength(
        changesAfterFirst,
      );
    });

    it('refresh re-extracts when the page changed', async () => {
      const id = seedRow();
      await refreshLocations(db, deps(extractorOver(fakeSiteFetch(WEB_DIR))));
      const firstHash = db.select().from(locations).where(eq(locations.id, id)).get()!.websiteHash;
      const report = await refreshLocations(db, deps(extractorOver(changed(fakeSiteFetch(WEB_DIR)))));
      expect(generateJson).toHaveBeenCalledTimes(2);
      expect(report.extracted).toBe(1);
      const secondHash = db.select().from(locations).where(eq(locations.id, id)).get()!.websiteHash;
      expect(secondHash).not.toBe(firstHash);
    });
  });
});
