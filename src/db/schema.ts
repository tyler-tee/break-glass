import { sql } from 'drizzle-orm';
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  BusinessStatus,
  LocationStatus,
  ProtocolStatus,
  TrackedFields,
  WeeklyHours,
} from '../domain/types.js';

export const settings = sqliteTable(
  'settings',
  {
    id: integer('id').primaryKey(),
    homeLabel: text('home_label'),
    homeLat: real('home_lat'),
    homeLng: real('home_lng'),
    homeTz: text('home_tz').notNull().default('America/Denver'),
    defaultRadiusMi: real('default_radius_mi').default(15),
    locationRefreshCron: text('location_refresh_cron').default('0 3 * * 0'),
    protocolRefreshCron: text('protocol_refresh_cron').default('0 4 1 * *'),
  },
  () => [check('settings_single_row', sql`id = 1`)],
);

export const categories = sqliteTable('categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  searchTerms: text('search_terms', { mode: 'json' }).$type<string[]>().notNull(),
  targetCount: integer('target_count').default(5),
});

export const locations = sqliteTable(
  'locations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    placeId: text('place_id').unique(),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    website: text('website'),
    lat: real('lat'),
    lng: real('lng'),
    distanceMi: real('distance_mi'),
    rating: real('rating'),
    ratingCount: integer('rating_count'),
    businessStatus: text('business_status').$type<BusinessStatus>(),
    hours: text('hours', { mode: 'json' }).$type<WeeklyHours>(),
    afterHoursNotes: text('after_hours_notes'),
    walkIns: integer('walk_ins', { mode: 'boolean' }),
    insuranceNotes: text('insurance_notes'),
    adminNotes: text('admin_notes'),
    status: text('status').$type<LocationStatus>().notNull().default('candidate'),
    lastVerifiedAt: integer('last_verified_at', { mode: 'timestamp_ms' }),
    consecutiveFetchFailures: integer('consecutive_fetch_failures').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('locations_category_status_idx').on(t.categoryId, t.status),
    check('locations_status_check', sql`${t.status} in ('candidate','approved','warn','rejected')`),
    check(
      'locations_business_status_check',
      sql`${t.businessStatus} is null or ${t.businessStatus} in ('OPERATIONAL','CLOSED_TEMPORARILY','CLOSED_PERMANENTLY')`,
    ),
  ],
);

export const locationSnapshots = sqliteTable(
  'location_snapshots',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    locationId: integer('location_id')
      .notNull()
      .references(() => locations.id),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<TrackedFields>().notNull(),
    hash: text('hash').notNull(),
  },
  (t) => [index('location_snapshots_location_fetched_idx').on(t.locationId, t.fetchedAt)],
);

export const locationChanges = sqliteTable(
  'location_changes',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    locationId: integer('location_id')
      .notNull()
      .references(() => locations.id),
    detectedAt: integer('detected_at', { mode: 'timestamp_ms' }).notNull(),
    field: text('field').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }),
  },
  (t) => [index('location_changes_location_resolved_idx').on(t.locationId, t.resolvedAt)],
);

export const protocols = sqliteTable('protocols', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  tags: text('tags', { mode: 'json' }).$type<string[]>(),
  needsRereview: integer('needs_rereview', { mode: 'boolean' }).notNull().default(false),
  rereviewReason: text('rereview_reason'),
});

export const protocolVersions = sqliteTable(
  'protocol_versions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    protocolId: integer('protocol_id')
      .notNull()
      .references(() => protocols.id),
    version: integer('version').notNull(),
    status: text('status').$type<ProtocolStatus>().notNull(),
    bodyMd: text('body_md').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    submittedAt: integer('submitted_at', { mode: 'timestamp_ms' }),
    reviewedAt: integer('reviewed_at', { mode: 'timestamp_ms' }),
    reviewNotes: text('review_notes'),
  },
  (t) => [
    uniqueIndex('protocol_versions_protocol_version_idx').on(t.protocolId, t.version),
    uniqueIndex('one_published').on(t.protocolId).where(sql`status = 'published'`),
    check(
      'protocol_versions_status_check',
      sql`${t.status} in ('draft','in_review','published','superseded','rejected')`,
    ),
  ],
);

export const protocolSources = sqliteTable('protocol_sources', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  protocolVersionId: integer('protocol_version_id')
    .notNull()
    .references(() => protocolVersions.id),
  url: text('url').notNull(),
  title: text('title'),
  fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
  contentHash: text('content_hash'),
});

export const placesUsage = sqliteTable('places_usage', {
  month: text('month').primaryKey(),
  calls: integer('calls').notNull().default(0),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});
