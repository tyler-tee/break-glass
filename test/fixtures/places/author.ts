// One-off generator: files here are hand-authored to the Places API (New) shape because no key was available; FIXTURE_MODE=record with a real key replaces them. Run: npx tsx test/fixtures/places/author.ts
import { authorFixture } from '../../helpers/authorFixture.js';

const FIXTURE_DIR = import.meta.dirname;
const BASE = 'https://places.googleapis.com/v1';
const CENTER = { lat: 40.7608, lng: -111.891 };

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

const weekdayText = [
  'Monday: 8:00 AM – 5:00 PM',
  'Tuesday: 8:00 AM – 5:00 PM',
  'Wednesday: 8:00 AM – 5:00 PM',
  'Thursday: 8:00 AM – 5:00 PM',
  'Friday: 8:00 AM – 5:00 PM',
];

const weekday = [1, 2, 3, 4, 5].map((day) => ({
  open: { day, hour: 8, minute: 0 },
  close: { day, hour: 17, minute: 0 },
}));

function main(): void {
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
    { method: 'POST', url: `${BASE}/places:searchText`, body: searchBody('gone dentist') },
    {
      status: 200,
      json: {
        places: [
          {
            id: 'ChIJgone',
            displayName: { text: 'Gone Dental', languageCode: 'en' },
            formattedAddress: '1 Gone St, Salt Lake City, UT 84101, USA',
            location: { latitude: 40.77, longitude: -111.89 },
            rating: 4.0,
            userRatingCount: 10,
            businessStatus: 'OPERATIONAL',
          },
          {
            id: 'ChIJnear',
            displayName: { text: 'Near Dental Group', languageCode: 'en' },
            formattedAddress: '100 S Main St, Salt Lake City, UT 84101, USA',
            location: { latitude: 40.775, longitude: -111.891 },
            rating: 4.6,
            userRatingCount: 120,
            businessStatus: 'OPERATIONAL',
          },
        ],
      },
    },
  );
  authorFixture(
    FIXTURE_DIR,
    { method: 'GET', url: `${BASE}/places/ChIJfar` },
    {
      status: 200,
      json: {
        id: 'ChIJfar',
        displayName: { text: 'Far Dental', languageCode: 'en' },
        formattedAddress: '900 N State St, Bountiful, UT 84010, USA',
        nationalPhoneNumber: '(801) 555-0102',
        websiteUri: 'https://far-dental.example',
        location: { latitude: 40.9055, longitude: -111.891 },
        rating: 4.2,
        userRatingCount: 80,
        businessStatus: 'OPERATIONAL',
        regularOpeningHours: { periods: weekday, weekdayDescriptions: weekdayText },
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
  // Separate address from the one above so places.test.ts keeps its own expected coordinates.
  authorFixture(
    FIXTURE_DIR,
    {
      method: 'POST',
      url: `${BASE}/places:searchText`,
      body: JSON.stringify({ textQuery: '200 S Main St, Salt Lake City', pageSize: 10 }),
    },
    {
      status: 200,
      json: {
        places: [
          {
            id: 'ChIJhome',
            displayName: { text: 'Home Address' },
            location: { latitude: 40.7684, longitude: -111.8898 },
          },
        ],
      },
    },
  );
}

main();
