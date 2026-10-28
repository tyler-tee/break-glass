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

// richSearch: one Text Search per term with the ranking field mask (pageSize 20, relevance, same bias circle).
const richBody = (query: string) =>
  JSON.stringify({
    textQuery: query,
    pageSize: 20,
    rankPreference: 'RELEVANCE',
    locationBias: {
      circle: {
        center: { latitude: CENTER.lat, longitude: CENTER.lng },
        radius: Math.min(Math.round(15 * 1609.344), 50000),
      },
    },
  });

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const daily = (open: [number, number], close: [number, number], nextDay: boolean) =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({
    open: { day, hour: open[0], minute: open[1] },
    close: { day: nextDay ? (day + 1) % 7 : day, hour: close[0], minute: close[1] },
  }));
const allDay = {
  periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
  weekdayDescriptions: DAY_NAMES.map((d) => `${d}: Open 24 hours`),
};
const review = (text: string, rating: number, when: string) => ({
  text: { text, languageCode: 'en' },
  rating,
  relativePublishTimeDescription: when,
});
const pharmacyType = { primaryType: 'pharmacy', primaryTypeDisplayName: { text: 'Pharmacy', languageCode: 'en' } };

const cvs = {
  id: 'ChIJcvs24',
  displayName: { text: 'CVS Pharmacy', languageCode: 'en' },
  formattedAddress: '1400 S 700 E, Salt Lake City, UT 84105, USA',
  shortFormattedAddress: '1400 S 700 E, Salt Lake City',
  location: { latitude: 40.75, longitude: -111.891 },
  businessStatus: 'OPERATIONAL',
  ...pharmacyType,
  googleMapsUri: 'https://maps.google.com/?cid=1001',
  rating: 3.8,
  userRatingCount: 121,
  // Open around the clock except the pharmacist's 1:30–2 PM lunch, as CVS reports it.
  regularOpeningHours: {
    periods: daily([14, 0], [13, 30], true),
    weekdayDescriptions: DAY_NAMES.map((d) => `${d}: 12:00 AM – 1:30 PM, 2:00 PM – 12:00 AM`),
  },
  currentOpeningHours: { openNow: true },
  nationalPhoneNumber: '(801) 555-0300',
  websiteUri: 'https://cvs.example/store/1400',
  reviews: [
    review('Pharmacist stayed late to fill an antibiotic for my son at 2am. Lifesaver.', 5, 'a month ago'),
    review(
      'The drive-thru line is always long and the pharmacy staff seem overwhelmed, but they did get my "urgent" prescription right eventually after a fairly long wait of nearly forty minutes on a weeknight.',
      3,
      '3 months ago',
    ),
    review('Rude at the counter.', 1, '5 months ago'),
    review('Open all night, that is what matters.', 4, 'a year ago'),
    review('Clean store.', 4, 'a year ago'),
    review('Sixth review that must be dropped from the prompt.', 5, '2 years ago'),
  ],
};
const walgreensSuite = {
  id: 'ChIJwag1',
  displayName: { text: 'Walgreens Pharmacy', languageCode: 'en' },
  formattedAddress: '350 E 400 S #2, Salt Lake City, UT 84111, USA',
  shortFormattedAddress: '350 E 400 S #2, Salt Lake City',
  location: { latitude: 40.76, longitude: -111.879 },
  businessStatus: 'OPERATIONAL',
  ...pharmacyType,
  googleMapsUri: 'https://maps.google.com/?cid=1002',
  rating: 4.1,
  userRatingCount: 412,
  regularOpeningHours: allDay,
  currentOpeningHours: { openNow: true },
  nationalPhoneNumber: '(801) 555-0301',
  websiteUri: 'https://walgreens.example/store/350',
  reviews: [review('Always someone at the pharmacy counter, even overnight.', 5, '2 weeks ago')],
};
// The same building listed again without the suite: the duplicate the pre-pass must catch.
const walgreensDup = {
  ...walgreensSuite,
  id: 'ChIJwag2',
  displayName: { text: 'Walgreens', languageCode: 'en' },
  formattedAddress: '350 E 400 S, Salt Lake City, UT 84111, USA',
  shortFormattedAddress: '350 E 400 S, Salt Lake City',
  location: { latitude: 40.76005, longitude: -111.87905 },
  primaryType: 'drugstore',
  primaryTypeDisplayName: { text: 'Drugstore', languageCode: 'en' },
  googleMapsUri: 'https://maps.google.com/?cid=1003',
  rating: 3.9,
  userRatingCount: 38,
  reviews: [],
};
// A junk listing: 24/7 on paper, no ratings, not a pharmacy.
const junk = {
  id: 'ChIJjunk',
  displayName: { text: 'Pharma Anabolics Shop', languageCode: 'en' },
  formattedAddress: '726 Grove Ave, Salt Lake City, UT 84104, USA',
  shortFormattedAddress: '726 Grove Ave, Salt Lake City',
  location: { latitude: 40.73, longitude: -111.9 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'store',
  primaryTypeDisplayName: { text: 'Store', languageCode: 'en' },
  googleMapsUri: 'https://maps.google.com/?cid=1004',
  regularOpeningHours: allDay,
};
const riteAid = {
  id: 'ChIJriteaid',
  displayName: { text: 'Rite Aid', languageCode: 'en' },
  formattedAddress: '200 S State St, Salt Lake City, UT 84111, USA',
  shortFormattedAddress: '200 S State St, Salt Lake City',
  location: { latitude: 40.765, longitude: -111.888 },
  businessStatus: 'CLOSED_PERMANENTLY',
  ...pharmacyType,
  rating: 4.0,
  userRatingCount: 90,
};
// About 38 miles out, past the 15-mile radius.
const provo = {
  id: 'ChIJprovo',
  displayName: { text: 'Provo 24 Hour Pharmacy', languageCode: 'en' },
  formattedAddress: '1 N University Ave, Provo, UT 84601, USA',
  shortFormattedAddress: '1 N University Ave, Provo',
  location: { latitude: 40.2338, longitude: -111.6585 },
  businessStatus: 'OPERATIONAL',
  ...pharmacyType,
  rating: 4.5,
  userRatingCount: 300,
  regularOpeningHours: allDay,
};
const dayPharmacy = {
  id: 'ChIJday',
  displayName: { text: 'Main Street Pharmacy', languageCode: 'en' },
  formattedAddress: '50 W Broadway, Salt Lake City, UT 84101, USA',
  shortFormattedAddress: '50 W Broadway, Salt Lake City',
  location: { latitude: 40.762, longitude: -111.893 },
  businessStatus: 'OPERATIONAL',
  ...pharmacyType,
  rating: 4.8,
  userRatingCount: 240,
  regularOpeningHours: {
    periods: daily([9, 0], [21, 0], false),
    weekdayDescriptions: DAY_NAMES.map((d) => `${d}: 9:00 AM – 9:00 PM`),
  },
  currentOpeningHours: { openNow: false },
  nationalPhoneNumber: '(801) 555-0310',
};
const smiths = {
  id: 'ChIJsmiths',
  displayName: { text: "Smith's Pharmacy", languageCode: 'en' },
  formattedAddress: '455 S 500 E, Salt Lake City, UT 84102, USA',
  shortFormattedAddress: '455 S 500 E, Salt Lake City',
  location: { latitude: 40.758, longitude: -111.877 },
  businessStatus: 'CLOSED_TEMPORARILY',
  ...pharmacyType,
  rating: 4.3,
  userRatingCount: 150,
  regularOpeningHours: allDay,
};
const instacare = {
  id: 'ChIJinstacare',
  displayName: { text: 'Instacare Downtown', languageCode: 'en' },
  formattedAddress: '389 S 900 E, Salt Lake City, UT 84102, USA',
  shortFormattedAddress: '389 S 900 E, Salt Lake City',
  location: { latitude: 40.761, longitude: -111.865 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'medical_clinic',
  primaryTypeDisplayName: { text: 'Medical clinic', languageCode: 'en' },
  rating: 4.2,
  userRatingCount: 300,
  regularOpeningHours: {
    periods: daily([8, 0], [20, 0], false),
    weekdayDescriptions: DAY_NAMES.map((d) => `${d}: 8:00 AM – 8:00 PM`),
  },
  nationalPhoneNumber: '(801) 555-0400',
  websiteUri: 'https://instacare.example',
};
const weekdayClinic = {
  id: 'ChIJclinic',
  displayName: { text: 'Avenues Family Clinic', languageCode: 'en' },
  formattedAddress: '100 N E St, Salt Lake City, UT 84103, USA',
  shortFormattedAddress: '100 N E St, Salt Lake City',
  location: { latitude: 40.772, longitude: -111.878 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'doctor',
  primaryTypeDisplayName: { text: 'Doctor', languageCode: 'en' },
  rating: 4.9,
  userRatingCount: 12,
  regularOpeningHours: { periods: weekday, weekdayDescriptions: weekdayText },
};

// The dentists the older discovery tests used, as richSearch returns them.
const nearDentalRich = {
  id: 'ChIJnear',
  displayName: { text: 'Near Dental Group', languageCode: 'en' },
  formattedAddress: '100 S Main St, Salt Lake City, UT 84101, USA',
  shortFormattedAddress: '100 S Main St, Salt Lake City',
  location: { latitude: 40.775, longitude: -111.891 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'dentist',
  primaryTypeDisplayName: { text: 'Dentist', languageCode: 'en' },
  googleMapsUri: 'https://maps.google.com/?cid=2001',
  rating: 4.6,
  userRatingCount: 120,
  regularOpeningHours: { periods: weekday, weekdayDescriptions: weekdayText },
  nationalPhoneNumber: '(801) 555-0100',
  websiteUri: 'https://near-dental.example',
  reviews: [review('Saw me the same day for a cracked tooth.', 5, '2 months ago')],
};
const farDentalRich = {
  id: 'ChIJfar',
  displayName: { text: 'Far Dental', languageCode: 'en' },
  formattedAddress: '900 N State St, Bountiful, UT 84010, USA',
  shortFormattedAddress: '900 N State St, Bountiful',
  location: { latitude: 40.9055, longitude: -111.891 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'dentist',
  primaryTypeDisplayName: { text: 'Dentist', languageCode: 'en' },
  googleMapsUri: 'https://maps.google.com/?cid=2002',
  rating: 4.2,
  userRatingCount: 80,
  regularOpeningHours: { periods: weekday, weekdayDescriptions: weekdayText },
  nationalPhoneNumber: '(801) 555-0102',
  websiteUri: 'https://far-dental.example',
};

function authorRich(): void {
  const rich = (query: string, places: unknown[]) =>
    authorFixture(
      FIXTURE_DIR,
      { method: 'POST', url: `${BASE}/places:searchText`, body: richBody(query) },
      { status: 200, json: places.length > 0 ? { places } : {} },
    );
  rich('24 hour pharmacy', [cvs, walgreensSuite, walgreensDup, junk, riteAid, provo]);
  rich('late night pharmacy', [cvs, dayPharmacy, smiths]);
  rich('urgent care', [instacare, weekdayClinic]);
  rich('nothing open zzz', []);
  rich('emergency dentist', [nearDentalRich, farDentalRich]);
}

// Home-trade results for the "Emergency electrician" category, hand-authored around CENTER. Run alone with: npx tsx test/fixtures/places/author.ts home
const electricianType = { primaryType: 'electrician', primaryTypeDisplayName: { text: 'Electrician', languageCode: 'en' } };
const voltCrew = {
  // 5.0 over only 17 reviews, 1.6 mi out.
  id: 'ChIJvolt',
  displayName: { text: 'Volt Crew Electric', languageCode: 'en' },
  formattedAddress: '720 E 900 S, Salt Lake City, UT 84105, USA',
  shortFormattedAddress: '720 E 900 S, Salt Lake City',
  location: { latitude: 40.784, longitude: -111.891 },
  businessStatus: 'OPERATIONAL',
  ...electricianType,
  googleMapsUri: 'https://maps.google.com/?cid=3001',
  rating: 5.0,
  userRatingCount: 17,
  regularOpeningHours: allDay,
  currentOpeningHours: { openNow: true },
  nationalPhoneNumber: '(801) 555-0601',
  websiteUri: 'https://volt-crew.example',
  reviews: [review('Fast and friendly, fixed our outlet.', 5, '3 months ago')],
};
const beehiveElectric = {
  // 4.7 over 15k reviews, about 14.5 mi out (inside the 15-mile radius).
  id: 'ChIJbeehive',
  displayName: { text: 'Beehive Electric Services', languageCode: 'en' },
  formattedAddress: '4400 S Redwood Rd, Taylorsville, UT 84123, USA',
  shortFormattedAddress: '4400 S Redwood Rd, Taylorsville',
  location: { latitude: 40.9695, longitude: -111.891 },
  businessStatus: 'OPERATIONAL',
  ...electricianType,
  googleMapsUri: 'https://maps.google.com/?cid=3002',
  rating: 4.7,
  userRatingCount: 15200,
  regularOpeningHours: allDay,
  currentOpeningHours: { openNow: true },
  nationalPhoneNumber: '(801) 555-0602',
  websiteUri: 'https://beehive-electric.example',
  reviews: [
    review('Panel tripped at 2am on a Sunday and they sent a tech within the hour.', 5, 'a month ago'),
    review('Called at 8am to avoid the after-hours price, as the dispatcher suggested.', 4, '4 months ago'),
  ],
};
const sparkLine = {
  // Two listings, one phone, different addresses: the pair the phone dedupe must catch.
  id: 'ChIJspark1',
  displayName: { text: 'Spark Line Electric', languageCode: 'en' },
  formattedAddress: '310 S 200 W, Salt Lake City, UT 84101, USA',
  shortFormattedAddress: '310 S 200 W, Salt Lake City',
  location: { latitude: 40.7567, longitude: -111.9 },
  businessStatus: 'OPERATIONAL',
  ...electricianType,
  googleMapsUri: 'https://maps.google.com/?cid=3003',
  rating: 4.6,
  userRatingCount: 540,
  regularOpeningHours: allDay,
  currentOpeningHours: { openNow: true },
  nationalPhoneNumber: '(801) 555-0603',
  websiteUri: 'https://spark-line.example',
  reviews: [review('Only company that answered on Sunday, here in 40 minutes.', 5, '2 months ago')],
};
const sparkLineDup = {
  ...sparkLine,
  id: 'ChIJspark2',
  displayName: { text: 'Spark Line 24/7 Emergency Electrician', languageCode: 'en' },
  formattedAddress: '88 N 600 E, Salt Lake City, UT 84103, USA',
  shortFormattedAddress: '88 N 600 E, Salt Lake City',
  location: { latitude: 40.7745, longitude: -111.8815 },
  googleMapsUri: 'https://maps.google.com/?cid=3004',
  rating: 4.2,
  userRatingCount: 26,
  reviews: [],
};
const handymanElectric = {
  id: 'ChIJhandy',
  displayName: { text: 'Handyman and Electric', languageCode: 'en' },
  formattedAddress: '1550 S State St, Salt Lake City, UT 84115, USA',
  shortFormattedAddress: '1550 S State St, Salt Lake City',
  location: { latitude: 40.738, longitude: -111.888 },
  businessStatus: 'OPERATIONAL',
  primaryType: 'general_contractor',
  primaryTypeDisplayName: { text: 'General contractor', languageCode: 'en' },
  googleMapsUri: 'https://maps.google.com/?cid=3005',
  rating: 4.5,
  userRatingCount: 210,
  regularOpeningHours: {
    periods: weekday,
    weekdayDescriptions: weekdayText,
  },
  currentOpeningHours: { openNow: false },
  nationalPhoneNumber: '(801) 555-0604',
  reviews: [review('Good for small jobs around the house, not a 2am callout kind of outfit.', 4, '6 months ago')],
};
// No location field at all: Google sometimes omits it.
const noLocationElectric = {
  id: 'ChIJnoloc',
  displayName: { text: 'Canyon Peak Electric', languageCode: 'en' },
  formattedAddress: '2 Canyon Rd, Salt Lake City, UT 84108, USA',
  businessStatus: 'OPERATIONAL',
  ...electricianType,
  rating: 4.4,
  userRatingCount: 96,
  regularOpeningHours: allDay,
  nationalPhoneNumber: '(801) 555-0605',
  reviews: [],
};

function authorHome(): void {
  authorFixture(
    FIXTURE_DIR,
    { method: 'POST', url: `${BASE}/places:searchText`, body: richBody('emergency electrician') },
    {
      status: 200,
      json: { places: [voltCrew, beehiveElectric, sparkLine, sparkLineDup, handymanElectric, noLocationElectric] },
    },
  );
}

function main(): void {
  authorRich();
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
    { method: 'GET', url: `${BASE}/places/ChIJshut` },
    {
      status: 200,
      json: {
        id: 'ChIJshut',
        displayName: { text: 'Shut Dental', languageCode: 'en' },
        formattedAddress: '5 Shut St, Salt Lake City, UT 84101, USA',
        nationalPhoneNumber: '(801) 555-0111',
        location: { latitude: 40.762, longitude: -111.891 },
        rating: 4.1,
        userRatingCount: 30,
        businessStatus: 'CLOSED_PERMANENTLY',
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

if (process.argv[2] !== 'home') main();
authorHome();
