import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BudgetExhausted,
  CallBudget,
  PlacesError,
  RICH_SEARCH_MASK,
  candidateToTracked,
  detailsToTracked,
  geocode,
  placeDetails,
  richSearch,
  textSearch,
  type PlacesDeps,
} from '../../src/services/places/client.js';
import { recordingFetch } from '../helpers/recordingFetch.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');

const snapshot = (): string =>
  fs
    .readdirSync(FIXTURE_DIR)
    .sort()
    .map((f) => `${f}:${fs.statSync(path.join(FIXTURE_DIR, f)).mtimeMs}`)
    .join(',');

let before = '';
beforeAll(() => {
  before = snapshot();
});

const CENTER = { lat: 40.7608, lng: -111.891 };
const BIAS = { center: CENTER, radiusMi: 15 };

const deps = (over: Partial<PlacesDeps> = {}): PlacesDeps => ({
  fetch: recordingFetch(FIXTURE_DIR, 'replay'),
  apiKey: 'test-key',
  budget: new CallBudget(10),
  ...over,
});

describe('places client', () => {
  it('textSearch parses summaries and sends the field mask header', async () => {
    const real = recordingFetch(FIXTURE_DIR, 'replay');
    let captured: HeadersInit | undefined;
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      captured = init?.headers;
      return real(input, init);
    }) as typeof fetch;

    const out = await textSearch('emergency dentist', BIAS, deps({ fetch: spy }));

    expect(out.map((p) => p.placeId)).toEqual(['ChIJnear', 'ChIJfar']);
    expect(out[0]).toMatchObject({
      name: 'Near Dental Group',
      lat: 40.775,
      lng: -111.891,
      rating: null,
      ratingCount: null,
      businessStatus: 'OPERATIONAL',
    });
    expect(typeof out[1].lat).toBe('number');
    expect(out[1].lng).toBe(-111.891);
    const h = captured as Record<string, string>;
    expect(h['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.businessStatus',
    );
    expect(h['X-Goog-Api-Key']).toBe('test-key');
  });

  it('textSearch mask excludes rating', async () => {
    const real = recordingFetch(FIXTURE_DIR, 'replay');
    let mask = '';
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      mask = (init?.headers as Record<string, string>)['X-Goog-FieldMask'] ?? '';
      return real(input, init);
    }) as typeof fetch;
    const out = await textSearch('emergency dentist', BIAS, deps({ fetch: spy }));
    expect(mask).not.toContain('rating');
    expect(mask).not.toContain('userRatingCount');
    expect(out.every((p) => p.rating === null && p.ratingCount === null)).toBe(true);
  });

  it('textSearch with no results returns []', async () => {
    expect(await textSearch('nothing here zzz', BIAS, deps())).toEqual([]);
  });

  it('placeDetails maps hours into WeeklyHours', async () => {
    const d = await placeDetails('ChIJnear', deps());
    expect(d.phone).toBe('(801) 555-0100');
    expect(d.website).toBe('https://near-dental.example');
    expect(d.hours?.periods['1']).toEqual([{ open: '0800', close: '1700' }]);
    expect(d.hours?.periods['0']).toEqual([]);
    expect(d.hours?.weekdayText).toHaveLength(5);
  });

  it('budget exhausted throws before fetch', async () => {
    const real = recordingFetch(FIXTURE_DIR, 'replay');
    let calls = 0;
    const counting = ((input: string | URL | Request, init?: RequestInit) => {
      calls++;
      return real(input, init);
    }) as typeof fetch;
    const d = deps({ fetch: counting, budget: new CallBudget(1) });

    await expect(textSearch('emergency dentist', BIAS, d)).resolves.toHaveLength(2);
    await expect(textSearch('emergency dentist', BIAS, d)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(1);
    expect(d.budget.used).toBe(1);
    expect(d.budget.remaining()).toBe(0);
  });

  it('404 throws PlacesError with status', async () => {
    const err = await placeDetails('ChIJgone', deps()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlacesError);
    expect((err as PlacesError).status).toBe(404);
    expect((err as PlacesError).body).toContain('NOT_FOUND');
  });

  it('detailsToTracked maps every tracked field and nulls the note fields', async () => {
    const d = await placeDetails('ChIJnear', deps());
    expect(d.hours).not.toBeNull();
    expect(detailsToTracked(d)).toEqual({
      name: 'Near Dental Group',
      address: '100 S Main St, Salt Lake City, UT 84101, USA',
      phone: '(801) 555-0100',
      website: 'https://near-dental.example',
      hours: d.hours,
      businessStatus: 'OPERATIONAL',
      rating: 4.6,
      ratingCount: 120,
      afterHoursNotes: null,
      walkIns: null,
      insuranceNotes: null,
    });
  });

  it('geocode returns first hit or null', async () => {
    expect(await geocode('100 S Main St, Salt Lake City', deps())).toEqual({ lat: 40.775, lng: -111.891 });
    expect(await geocode('nowhere zzz', deps())).toBeNull();
  });

  it('richSearch sends one enterprise search with the ranking mask and maps every field', async () => {
    const real = recordingFetch(FIXTURE_DIR, 'replay');
    const seen: { headers: Record<string, string>; body: unknown }[] = [];
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      seen.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return real(input, init);
    }) as typeof fetch;
    const d = deps({ fetch: spy });

    const out = await richSearch('24 hour pharmacy', BIAS, d);

    expect(d.budget.used).toBe(1);
    expect(seen[0]!.body).toEqual({
      textQuery: '24 hour pharmacy',
      pageSize: 20,
      rankPreference: 'RELEVANCE',
      locationBias: { circle: { center: { latitude: 40.7608, longitude: -111.891 }, radius: 24140 } },
    });
    const mask = seen[0]!.headers['X-Goog-FieldMask']!;
    expect(mask).toBe(RICH_SEARCH_MASK);
    for (const f of ['places.reviews.text', 'places.rating', 'places.currentOpeningHours.openNow', 'places.googleMapsUri']) {
      expect(mask.split(',')).toContain(f);
    }
    expect(out.map((p) => p.placeId)).toEqual(['ChIJcvs24', 'ChIJwag1', 'ChIJwag2', 'ChIJjunk', 'ChIJriteaid', 'ChIJprovo']);
    const cvs = out[0]!;
    expect(cvs).toMatchObject({
      name: 'CVS Pharmacy',
      address: '1400 S 700 E, Salt Lake City, UT 84105, USA',
      shortAddress: '1400 S 700 E, Salt Lake City',
      lat: 40.75,
      lng: -111.891,
      businessStatus: 'OPERATIONAL',
      rating: 3.8,
      ratingCount: 121,
      phone: '(801) 555-0300',
      website: 'https://cvs.example/store/1400',
      primaryType: 'pharmacy',
      primaryTypeDisplay: 'Pharmacy',
      mapsUri: 'https://maps.google.com/?cid=1001',
      openNow: true,
    });
    // The pharmacist's lunch break: 2 PM to 1:30 PM the next day, every day.
    expect(cvs.hours?.periods['3']).toEqual([{ open: '1400', close: '1330' }]);
    expect(cvs.reviews).toHaveLength(6);
    expect(cvs.reviews[0]).toEqual({
      text: 'Pharmacist stayed late to fill an antibiotic for my son at 2am. Lifesaver.',
      rating: 5,
      relativePublishTime: 'a month ago',
    });
  });

  it('richSearch leaves missing fields null and keeps closed places for the pre-pass to judge', async () => {
    const out = await richSearch('24 hour pharmacy', BIAS, deps());
    const junk = out.find((p) => p.placeId === 'ChIJjunk')!;
    expect(junk).toMatchObject({ rating: null, ratingCount: null, phone: null, website: null, openNow: null, reviews: [] });
    expect(junk.hours?.periods['0']).toEqual([{ open: '0000', close: '2400' }]);
    const gone = out.find((p) => p.placeId === 'ChIJriteaid')!;
    expect(gone).toMatchObject({ businessStatus: 'CLOSED_PERMANENTLY', hours: null, mapsUri: null });
    expect(await richSearch('nothing open zzz', BIAS, deps())).toEqual([]);
  });

  it('richSearch is budgeted like textSearch', async () => {
    const d = deps({ budget: new CallBudget(0) });
    await expect(richSearch('24 hour pharmacy', BIAS, d)).rejects.toBeInstanceOf(BudgetExhausted);
  });

  it('candidateToTracked keeps the tracked fields and drops reviews', async () => {
    const [cvs] = await richSearch('24 hour pharmacy', BIAS, deps());
    const tracked = candidateToTracked(cvs!);
    expect(tracked).toEqual({
      name: 'CVS Pharmacy',
      address: '1400 S 700 E, Salt Lake City, UT 84105, USA',
      phone: '(801) 555-0300',
      website: 'https://cvs.example/store/1400',
      hours: cvs!.hours,
      businessStatus: 'OPERATIONAL',
      rating: 3.8,
      ratingCount: 121,
      afterHoursNotes: null,
      walkIns: null,
      insuranceNotes: null,
    });
    expect(JSON.stringify(tracked)).not.toContain('Lifesaver');
  });

  it('fixture directory is not written during replay', () => {
    expect(snapshot()).toBe(before);
  });
});
