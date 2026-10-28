import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';
import { loadDotEnvFiles } from '../env.js';
import { haversineMi } from '../domain/ranking.js';
import type { HoursNeed, LatLng, LocationStatus, WeeklyHours } from '../domain/types.js';
import { openDb, type Db } from './client.js';
import { runMigrations } from './migrate.js';
import { categories, locations, settings } from './schema.js';

const DEFAULT_HOME: LatLng = { lat: 40.7608, lng: -111.891 };

const CATEGORIES: { name: string; slug: string; searchTerms: string[]; hoursNeed: HoursNeed }[] = [
  { name: 'Dentist', slug: 'dentist', searchTerms: ['emergency dentist', 'dentist'], hoursNeed: 'overnight' },
  { name: 'Urgent care', slug: 'urgent-care', searchTerms: ['urgent care', 'walk-in clinic'], hoursNeed: 'daytime' },
  { name: 'Emergency room', slug: 'er', searchTerms: ['emergency room', 'hospital emergency department'], hoursNeed: 'overnight' },
  { name: 'Veterinarian', slug: 'vet', searchTerms: ['emergency vet', 'veterinarian'], hoursNeed: 'overnight' },
];

const weekdayHours: WeeklyHours = {
  periods: {
    '0': [],
    '1': [{ open: '0800', close: '1700' }],
    '2': [{ open: '0800', close: '1700' }],
    '3': [{ open: '0800', close: '1700' }],
    '4': [{ open: '0800', close: '1700' }],
    '5': [{ open: '0800', close: '1700' }],
    '6': [],
  },
  weekdayText: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(
    (d) => `${d}: 8:00 AM – 5:00 PM`,
  ),
};

type DentistSeed = {
  name: string;
  status: LocationStatus;
  phone: string;
  lat: number;
  lng: number;
  address?: string;
  website?: string;
  hours?: WeeklyHours;
  rating?: number;
  ratingCount?: number;
};

const DENTISTS: DentistSeed[] = [
  {
    name: 'Near Dental',
    status: 'approved',
    phone: '+1 801-555-0100',
    address: '100 S Main St, Salt Lake City, UT 84101',
    lat: 40.775,
    lng: -111.891,
    website: 'https://near-dental.example',
    hours: weekdayHours,
    rating: 4.6,
    ratingCount: 120,
  },
  {
    name: 'Mid Dental',
    status: 'approved',
    phone: '+1 801-555-0101',
    lat: 40.819,
    lng: -111.891,
    hours: weekdayHours,
    rating: 4.2,
    ratingCount: 80,
  },
  {
    name: 'Far Dental',
    status: 'approved',
    phone: '+1 801-555-0102',
    lat: 40.9055,
    lng: -111.891,
    hours: weekdayHours,
    rating: 4.8,
    ratingCount: 200,
  },
  { name: 'Candidate Dental', status: 'candidate', phone: '+1 801-555-0103', lat: 40.77, lng: -111.9 },
  { name: 'Rejected Dental', status: 'rejected', phone: '+1 801-555-0104', lat: 40.765, lng: -111.88 },
];

export function seed(db: Db, opts: { home?: LatLng } = {}): void {
  const home = opts.home ?? DEFAULT_HOME;

  db.insert(settings)
    .values({
      id: 1,
      homeLabel: 'Home',
      homeLat: home.lat,
      homeLng: home.lng,
      defaultRadiusMi: 15,
      homeTz: 'America/Denver',
      locationRefreshCron: '0 3 * * 0',
      protocolRefreshCron: '0 4 1 * *',
    })
    .onConflictDoNothing()
    .run();

  for (const c of CATEGORIES) {
    db.insert(categories)
      .values(c)
      .onConflictDoUpdate({
        target: categories.slug,
        set: { name: c.name, searchTerms: c.searchTerms },
      })
      .run();
  }

  const dentist = db.select().from(categories).where(eq(categories.slug, 'dentist')).get();
  if (!dentist) throw new Error('dentist category missing after upsert');

  const now = new Date();
  for (const d of DENTISTS) {
    const exists = db.select({ id: locations.id }).from(locations).where(eq(locations.name, d.name)).get();
    if (exists) continue;
    db.insert(locations)
      .values({
        categoryId: dentist.id,
        placeId: null,
        name: d.name,
        address: d.address ?? null,
        phone: d.phone,
        website: d.website ?? null,
        lat: d.lat,
        lng: d.lng,
        distanceMi: haversineMi(home, { lat: d.lat, lng: d.lng }),
        rating: d.rating ?? null,
        ratingCount: d.ratingCount ?? null,
        businessStatus: 'OPERATIONAL',
        hours: d.hours ?? null,
        status: d.status,
        lastVerifiedAt: d.status === 'approved' ? now : null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadDotEnvFiles();
  const db = openDb(process.env.DATABASE_PATH ?? './data/app.db');
  runMigrations(db);
  seed(db);
  console.log(
    `Seeded: ${db.select().from(categories).all().length} categories, ${db.select().from(locations).all().length} locations`,
  );
}
