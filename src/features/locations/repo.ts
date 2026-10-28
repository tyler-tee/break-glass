import { and, asc, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { categories, locationChanges, locationSnapshots, locations } from '../../db/schema.js';
import type { Area, FieldChange, TrackedFields } from '../../domain/types.js';

export type Location = typeof locations.$inferSelect;
export type LocationWithCategory = Location & { categoryName: string };

export type VisibleLocationRow = typeof locations.$inferSelect & { category: typeof categories.$inferSelect };

const VISIBLE = ['approved', 'warn'] as const;

export function listVisibleRows(db: Db, where: { categoryId?: number } = {}): VisibleLocationRow[] {
  const conditions = [inArray(locations.status, [...VISIBLE])];
  if (where.categoryId !== undefined) conditions.push(eq(locations.categoryId, where.categoryId));
  return db
    .select({ location: locations, category: categories })
    .from(locations)
    .innerJoin(categories, eq(locations.categoryId, categories.id))
    .where(and(...conditions))
    .all()
    .map((r) => ({ ...r.location, category: r.category }));
}

export function getVisibleRow(db: Db, id: number): VisibleLocationRow | null {
  const r = db
    .select({ location: locations, category: categories })
    .from(locations)
    .innerJoin(categories, eq(locations.categoryId, categories.id))
    .where(and(eq(locations.id, id), inArray(locations.status, [...VISIBLE])))
    .get();
  return r ? { ...r.location, category: r.category } : null;
}

export function listOpenChanges(db: Db, locationId: number): FieldChange[] {
  return db
    .select()
    .from(locationChanges)
    .where(and(eq(locationChanges.locationId, locationId), isNull(locationChanges.resolvedAt)))
    .all()
    .map((c) => ({
      field: c.field as FieldChange['field'],
      oldValue: c.oldValue,
      newValue: c.newValue,
    }));
}

export function getLocation(db: DbOrTx, id: number): Location | null {
  return db.select().from(locations).where(eq(locations.id, id)).get() ?? null;
}

export function listLocations(db: Db): LocationWithCategory[] {
  return db
    .select({ location: locations, categoryName: categories.name })
    .from(locations)
    .innerJoin(categories, eq(locations.categoryId, categories.id))
    .orderBy(locations.name)
    .all()
    .map((r) => ({ ...r.location, categoryName: r.categoryName }));
}

export function insertLocation(db: Db, values: typeof locations.$inferInsert): Location {
  return db.insert(locations).values(values).returning().get();
}

export function updateLocationRow(db: DbOrTx, id: number, values: Partial<typeof locations.$inferInsert>): Location {
  return db.update(locations).set(values).where(eq(locations.id, id)).returning().get();
}

export function insertSnapshot(
  db: DbOrTx,
  snapshot: { locationId: number; fetchedAt: Date; payload: TrackedFields; hash: string },
): void {
  db.insert(locationSnapshots).values(snapshot).run();
}

export function resolveOpenChanges(db: DbOrTx, locationId: number, resolvedAt: Date): number {
  return db
    .update(locationChanges)
    .set({ resolvedAt })
    .where(and(eq(locationChanges.locationId, locationId), isNull(locationChanges.resolvedAt)))
    .run().changes;
}

export function listRefreshable(db: Db): (Location & { area: Area })[] {
  return db
    .select({ location: locations, area: categories.area })
    .from(locations)
    .innerJoin(categories, eq(locations.categoryId, categories.id))
    .where(and(inArray(locations.status, [...VISIBLE]), isNotNull(locations.placeId)))
    .orderBy(asc(locations.id))
    .all()
    .map((r) => ({ ...r.location, area: r.area }));
}

export function latestSnapshot(
  db: DbOrTx,
  locationId: number,
): { payload: TrackedFields; hash: string; fetchedAt: Date } | null {
  const row = db
    .select()
    .from(locationSnapshots)
    .where(eq(locationSnapshots.locationId, locationId))
    .orderBy(desc(locationSnapshots.fetchedAt), desc(locationSnapshots.id))
    .limit(1)
    .get();
  return row ? { payload: row.payload, hash: row.hash, fetchedAt: row.fetchedAt } : null;
}

export function insertChanges(db: DbOrTx, locationId: number, detectedAt: Date, changes: FieldChange[]): void {
  if (changes.length === 0) return;
  db.insert(locationChanges)
    .values(changes.map((c) => ({ locationId, detectedAt, field: c.field, oldValue: c.oldValue, newValue: c.newValue })))
    .run();
}
