import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BudgetExhausted,
  CallBudget,
  PlacesError,
  detailsToTracked,
  geocode,
  placeDetails,
  textSearch,
  type PlacesDeps,
} from '../../src/services/places/client.js';
import { authorFixture } from '../helpers/authorFixture.js';
import { recordingFetch } from '../helpers/recordingFetch.js';

const FIXTURE_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const BASE = 'https://places.googleapis.com/v1';
const CENTER = { lat: 40.7608, lng: -111.891 };
const BIAS = { center: CENTER, radiusMi: 15 };

const searchBody = (query: string) =>
  JSON.stringify({
    textQuery: query,
    pageSize: 10,
    locationBias: {
      circle: {
        center: { latitude: CENTER.lat, longitude: CENTER.lng },
        radius: Math.min(Math.round(15 * 1609.344), 50000),
      },
    },
  });

const weekday = [1, 2, 3, 4, 5].map((day) => ({
  open: { day, hour: 8, minute: 0 },
  close: { day, hour: 17, minute: 0 },
}));

beforeAll(() => {
  authorFixture(
    FIXTURE_DIR,
    { method: 'POST', url: `${BASE}/places:searchText`, body: searchBody('emergency dentist') },
    {
      status: 200,
      json: {
        places: [
          {
            id: 'ChIJnear',
            displayName: { text: 'Near Dental Group', languageCode: 'en' },
            formattedAddress: '100 S Main St, Salt Lake City, UT 84101, USA',
            location: { latitude: 40.775, longitude: -111.891 },
            rating: 4.6,
            userRatingCount: 120,
            businessStatus: 'OPERATIONAL',
          },
          {
            id: 'ChIJfar',
            displayName: { text: 'Far Dental', languageCode: 'en' },
            formattedAddress: '900 N State St, Bountiful, UT 84010, USA',
            location: { latitude: 40.9055, longitude: -111.891 },
            rating: 4.2,
            userRatingCount: 80,
            businessStatus: 'OPERATIONAL',
          },
        ],
      },
    },
  );
  authorFixture(
    FIXTURE_DIR,
    { method: 'GET', url: `${BASE}/places/ChIJnear` },
    {
      status: 200,
      json: {
        id: 'ChIJnear',
        displayName: { text: 'Near Dental Group', languageCode: 'en' },
        formattedAddress: '100 S Main St, Salt Lake City, UT 84101, USA',
        nationalPhoneNumber: '(801) 555-0100',
        websiteUri: 'https://near-dental.example',
        location: { latitude: 40.775, longitude: -111.891 },
        rating: 4.6,
        userRatingCount: 120,
        businessStatus: 'OPERATIONAL',
        regularOpeningHours: {
          periods: weekday,
          weekdayDescriptions: [
            'Monday: 8:00 AM – 5:00 PM',
            'Tuesday: 8:00 AM – 5:00 PM',
            'Wednesday: 8:00 AM – 5:00 PM',
            'Thursday: 8:00 AM – 5:00 PM',
            'Friday: 8:00 AM – 5:00 PM',
          ],
        },
      },
    },
  );
  authorFixture(
    FIXTURE_DIR,
    { method: 'GET', url: `${BASE}/places/ChIJgone` },
    { status: 404, json: { error: { code: 404, message: 'Place not found', status: 'NOT_FOUND' } } },
  );
  authorFixture(
    FIXTURE_DIR,
    { method: 'POST', url: `${BASE}/places:searchText`, body: searchBody('nothing here zzz') },
    { status: 200, json: {} },
  );
  // geocode sends no locationBias (same pageSize 10), so it has its own request shape.
  authorFixture(
    FIXTURE_DIR,
    {
      method: 'POST',
      url: `${BASE}/places:searchText`,
      body: JSON.stringify({ textQuery: '100 S Main St, Salt Lake City', pageSize: 10 }),
    },
    {
      status: 200,
      json: {
        places: [
          {
            id: 'ChIJnear',
            displayName: { text: 'Near Dental Group' },
            location: { latitude: 40.775, longitude: -111.891 },
          },
        ],
      },
    },
  );
  authorFixture(
    FIXTURE_DIR,
    {
      method: 'POST',
      url: `${BASE}/places:searchText`,
      body: JSON.stringify({ textQuery: 'nowhere zzz', pageSize: 10 }),
    },
    { status: 200, json: {} },
  );
});

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
      rating: 4.6,
      ratingCount: 120,
      businessStatus: 'OPERATIONAL',
    });
    expect(typeof out[1].lat).toBe('number');
    expect(out[1].lng).toBe(-111.891);
    const h = captured as Record<string, string>;
    expect(h['X-Goog-FieldMask']).toBe(
      'places.id,places.displayName,places.formattedAddress,places.location,places.rating,places.userRatingCount,places.businessStatus',
    );
    expect(h['X-Goog-Api-Key']).toBe('test-key');
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
});
