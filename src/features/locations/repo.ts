import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { categories, locationChanges, locations } from '../../db/schema.js';
import type { FieldChange } from '../../domain/types.js';

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
