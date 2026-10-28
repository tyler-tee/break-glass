import { sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import type { categories } from '../../db/schema.js';
import { getCategoryBySlug } from '../categories/repo.js';
import { describeHours, isOpenNow, type HoursStatus } from '../../domain/hours.js';
import type { Area, FieldChange } from '../../domain/types.js';
import {
  getVisibleRow,
  listOpenChanges,
  listVisibleRows,
  type VisibleLocationRow,
} from './repo.js';

export type LocationView = VisibleLocationRow & {
  openNow: ReturnType<typeof isOpenNow>;
  hoursStatus: HoursStatus;
  openChanges: FieldChange[];
};
export type CategoryGroup = { category: typeof categories.$inferSelect; locations: LocationView[] };

export function toView(db: Db, row: VisibleLocationRow, now: Date, tz: string): LocationView {
  return {
    ...row,
    openNow: isOpenNow(row.hours, now, tz),
    hoursStatus: describeHours(row.hours, now, tz),
    openChanges: listOpenChanges(db, row.id),
  };
}

// A closure counts when the row says so or when refresh has an open change reporting it.
export function isReportedClosed(view: LocationView): boolean {
  return (
    view.businessStatus === 'CLOSED_PERMANENTLY' ||
    view.openChanges.some((c) => c.field === 'businessStatus' && c.newValue === 'CLOSED_PERMANENTLY')
  );
}

export function sortForFamily(views: LocationView[]): LocationView[] {
  const rank = (v: LocationView) => (isReportedClosed(v) ? 1 : 0);
  return [...views].sort((a, b) => {
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    if (a.distanceMi === b.distanceMi) return 0;
    if (a.distanceMi === null) return 1;
    if (b.distanceMi === null) return -1;
    return a.distanceMi - b.distanceMi;
  });
}

const escapeLike = (q: string) => q.replace(/[\\%_]/g, (c) => `\\${c}`);

export function searchLocations(db: Db, q: string, now: Date, tz: string, opts: { area?: Area } = {}): CategoryGroup[] {
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

  return groupRows(
    db,
    listVisibleRows(db)
      .filter((r) => !opts.area || r.category.area === opts.area)
      .filter((r) => matchedCategoryIds.has(r.categoryId) || matchedLocationIds.has(r.id)),
    now,
    tz,
  );
}

export function listVisibleGrouped(db: Db, now: Date, tz: string, opts: { area?: Area } = {}): CategoryGroup[] {
  const rows = listVisibleRows(db).filter((r) => !opts.area || r.category.area === opts.area);
  return groupRows(db, rows, now, tz);
}

function groupRows(db: Db, rows: VisibleLocationRow[], now: Date, tz: string): CategoryGroup[] {
  const groups = new Map<number, CategoryGroup>();
  for (const row of rows) {
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
