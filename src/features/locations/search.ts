import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { categories } from '../../db/schema.js';
import { isOpenNow } from '../../domain/hours.js';
import type { FieldChange } from '../../domain/types.js';
import {
  getCategoryBySlug,
  getVisibleRow,
  listOpenChanges,
  listVisibleRows,
  type VisibleLocationRow,
} from './repo.js';

export type LocationView = VisibleLocationRow & {
  openNow: ReturnType<typeof isOpenNow>;
  openChanges: FieldChange[];
};
export type CategoryGroup = { category: typeof categories.$inferSelect; locations: LocationView[] };

export function toView(db: Db, row: VisibleLocationRow, now: Date, tz: string): LocationView {
  return { ...row, openNow: isOpenNow(row.hours, now, tz), openChanges: listOpenChanges(db, row.id) };
}

export function sortForFamily(views: LocationView[]): LocationView[] {
  const rank = (v: LocationView) => (v.businessStatus === 'CLOSED_PERMANENTLY' ? 1 : 0);
  return [...views].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.distanceMi === b.distanceMi) return 0;
    if (a.distanceMi === null) return 1;
    if (b.distanceMi === null) return -1;
    return a.distanceMi - b.distanceMi;
  });
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchLocations(db: Db, q: string, now: Date, tz: string): CategoryGroup[] {
  const term = q.trim();
  if (!term) return [];
  const pattern = `%${escapeLike(term.toLowerCase())}%`;

  const matchedCategoryIds = new Set(
    db
      .all<{ id: number }>(sql`
        SELECT c.id FROM categories c
        WHERE lower(c.name) LIKE ${pattern} ESCAPE '\\'
           OR EXISTS (
             SELECT 1 FROM json_each(c.search_terms) t
             WHERE lower(t.value) LIKE ${pattern} ESCAPE '\\'
           )
      `)
      .map((r) => r.id),
  );
  const matchedLocationIds = new Set(
    db
      .all<{ id: number }>(sql`SELECT id FROM locations WHERE lower(name) LIKE ${pattern} ESCAPE '\\'`)
      .map((r) => r.id),
  );

  const groups = new Map<number, CategoryGroup>();
  for (const row of listVisibleRows(db)) {
    if (!matchedCategoryIds.has(row.categoryId) && !matchedLocationIds.has(row.id)) continue;
    let group = groups.get(row.categoryId);
    if (!group) {
      group = { category: row.category, locations: [] };
      groups.set(row.categoryId, group);
    }
    group.locations.push(toView(db, row, now, tz));
  }
  return [...groups.values()]
    .sort((a, b) => a.category.name.localeCompare(b.category.name))
    .map((g) => ({ ...g, locations: sortForFamily(g.locations) }));
}

export function listVisibleByCategory(db: Db, slug: string, now: Date, tz: string): LocationView[] {
  const category = getCategoryBySlug(db, slug);
  if (!category) return [];
  return sortForFamily(listVisibleRows(db, { categoryId: category.id }).map((r) => toView(db, r, now, tz)));
}

export function getVisibleLocation(db: Db, id: number, now: Date, tz: string): LocationView | null {
  const row = getVisibleRow(db, id);
  return row ? toView(db, row, now, tz) : null;
}
