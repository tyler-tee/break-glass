import { sql } from 'drizzle-orm';
import { blob, check, index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type {
  Area,
  BusinessStatus,
  FindRunProgress,
  FindRunStatus,
  HoursNeed,
  HouseFactKind,
  HouseSystem,
  PhotoMime,
  LocationStatus,
  ProtocolStatus,
  RankedBy,
  RankVerdict,
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
    householdName: text('household_name'),
    emergencyNumber: text('emergency_number').notNull().default('911'),
    // Set when the First Run wizard finishes; null means setup is incomplete.
    setupCompletedAt: integer('setup_completed_at', { mode: 'timestamp_ms' }),
  },
  () => [check('settings_single_row', sql`id = 1`)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    searchTerms: text('search_terms', { mode: 'json' }).$type<string[]>().notNull(),
    // Whether the family would go only in the daytime or at any hour, overnight included.
    hoursNeed: text('hours_need').$type<HoursNeed>().notNull().default('overnight'),
    // Which family section the category belongs to; 'home' is not shown on the family side yet.
    area: text('area').$type<Area>().notNull().default('health'),
  },
  (t) => [
    check('categories_hours_need_check', sql`${t.hoursNeed} in ('overnight','daytime')`),
    check('categories_area_check', sql`${t.area} in ('health','home')`),
  ],
);

export const locations = sqliteTable(
  'locations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    categoryId: integer('category_id')
      .notNull()
      .references(() => categories.id),
    // Unique per category, not globally: one hospital can be both an ER pick and a Children's ER pick.
    placeId: text('place_id'),
    name: text('name').notNull(),
    address: text('address'),
    phone: text('phone'),
    website: text('website'),
    // Hash of the website page text last sent to the extractor; gates re-extraction on refresh.
    websiteHash: text('website_hash'),
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
    // Ranking result for the category's picks; all null until the location has been ranked.
    rankVerdict: text('rank_verdict').$type<RankVerdict>(),
    rankPosition: integer('rank_position'),
    rankReason: text('rank_reason'),
    rankFlags: text('rank_flags', { mode: 'json' }).$type<string[]>(),
    rankedBy: text('ranked_by').$type<RankedBy>(),
    rankedAt: integer('ranked_at', { mode: 'timestamp_ms' }),
    shortAddress: text('short_address'),
    primaryType: text('primary_type'),
    mapsUri: text('maps_uri'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('locations_category_status_idx').on(t.categoryId, t.status),
    uniqueIndex('locations_category_place_idx').on(t.categoryId, t.placeId),
    check('locations_status_check', sql`${t.status} in ('candidate','approved','warn','rejected')`),
    check(
      'locations_business_status_check',
      sql`${t.businessStatus} is null or ${t.businessStatus} in ('OPERATIONAL','CLOSED_TEMPORARILY','CLOSED_PERMANENTLY')`,
    ),
    check('locations_rank_verdict_check', sql`${t.rankVerdict} is null or ${t.rankVerdict} in ('pick','backup','avoid')`),
    check('locations_ranked_by_check', sql`${t.rankedBy} is null or ${t.rankedBy} in ('llm','rules')`),
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

export const protocols = sqliteTable(
  'protocols',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    needsRereview: integer('needs_rereview', { mode: 'boolean' }).notNull().default(false),
    rereviewReason: text('rereview_reason'),
    area: text('area').$type<Area>().notNull().default('health'),
  },
  (t) => [check('protocols_area_check', sql`${t.area} in ('health','home')`)],
);

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

// Key/value store for secrets set from the admin UI. Env vars always take precedence (see features/admin/secrets.ts).
export const appSecrets = sqliteTable('app_secrets', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

// One row per "find places" run; progress is keyed by category id.
export const findRuns = sqliteTable(
  'find_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    status: text('status').$type<FindRunStatus>().notNull(),
    categoryIds: text('category_ids', { mode: 'json' }).$type<number[]>().notNull(),
    progress: text('progress', { mode: 'json' }).$type<FindRunProgress>().notNull(),
    callsUsed: integer('calls_used').notNull().default(0),
    llmCalls: integer('llm_calls').notNull().default(0),
    error: text('error'),
  },
  (t) => [check('find_runs_status_check', sql`${t.status} in ('running','done','failed')`)],
);

export type FindRun = typeof findRuns.$inferSelect;
export type NewFindRun = typeof findRuns.$inferInsert;

// Facts the household writes about its own home (shutoffs, utility lines, its own contractors).
export const houseFacts = sqliteTable(
  'house_facts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind').$type<HouseFactKind>().notNull(),
    // Validated in app code against HOUSE_SYSTEMS (no CHECK, so the list can grow without a migration).
    system: text('system').$type<HouseSystem>().notNull().default('general'),
    title: text('title').notNull(),
    whereNote: text('where_note'),
    instructions: text('instructions'),
    org: text('org'),
    phone: text('phone'),
    // Only set on contacts, and only to a category with area 'home'.
    categoryId: integer('category_id').references(() => categories.id),
    sortOrder: integer('sort_order').notNull().default(0),
    checkedAt: integer('checked_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [check('house_facts_kind_check', sql`${t.kind} in ('shutoff','utility','contact','note')`)],
);

export const houseFactPhotos = sqliteTable(
  'house_fact_photos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    factId: integer('fact_id')
      .notNull()
      .references(() => houseFacts.id, { onDelete: 'cascade' }),
    mime: text('mime').$type<PhotoMime>().notNull(),
    bytes: blob('bytes', { mode: 'buffer' }).notNull(),
    byteSize: integer('byte_size').notNull(),
    sha256: text('sha256').notNull(),
    caption: text('caption'),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('house_fact_photos_fact_sort_idx').on(t.factId, t.sortOrder),
    check('house_fact_photos_mime_check', sql`${t.mime} in ('image/jpeg','image/png','image/webp')`),
  ],
);

export type HouseFact = typeof houseFacts.$inferSelect;
export type HouseFactPhoto = typeof houseFactPhotos.$inferSelect;
