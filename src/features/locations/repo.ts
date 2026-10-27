import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db, DbOrTx } from '../../db/client.js';
import { categories, locationChanges, locationSnapshots, locations } from '../../db/schema.js';
import type { FieldChange, TrackedFields } from '../../domain/types.js';

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
