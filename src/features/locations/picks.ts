import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { locations } from '../../db/schema.js';
import type { Logger } from '../../domain/types.js';
import type { Extractor } from '../../services/llm/extract.js';
import { getCategory } from '../categories/repo.js';
import type { Location } from './repo.js';
import { LocationError, approveLocation, demoteLocation, reapproveLocation, rejectLocation } from './service.js';
import { extractWebsiteNotes } from './websiteNotes.js';

export type SavePicksResult = {
  /** Candidates that became picks. */
  added: number[];
  /** Former picks (approved or warn) moved back to candidates. */
  removed: number[];
};

/**
 * Makes exactly these places the category's picks, in one transaction: candidates are approved, a selected warn
 * place is re-approved (adopting its latest fetched details), and approved or warn places not selected are
 * demoted to candidates. Website notes for the new picks are then read in the background when an extractor is given.
 */
export function savePicks(
  db: Db,
  categoryId: number,
  locationIds: number[],
  now: Date,
  opts: { extract?: Extractor; log?: Logger } = {},
): SavePicksResult {
  if (!getCategory(db, categoryId)) throw new LocationError('not_found', 'Category not found');
  const ids = [...new Set(locationIds)];
  const rows = db.select().from(locations).where(eq(locations.categoryId, categoryId)).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const id of ids) {
    const row = byId.get(id);
    if (!row) throw new LocationError('invalid', 'That place is not in this category');
    if (row.status === 'rejected') throw new LocationError('invalid', `${row.name} is set to never be suggested`);
  }

  const selected = new Set(ids);
  const result = db.transaction(() => {
    const added: number[] = [];
    const removed: number[] = [];
    for (const id of ids) {
      const row = byId.get(id)!;
      if (row.status === 'candidate') {
        approveLocation(db, id, now);
        added.push(id);
      } else if (row.status === 'warn') {
        reapproveLocation(db, id, now);
      }
    }
    for (const row of rows) {
      if ((row.status === 'approved' || row.status === 'warn') && !selected.has(row.id)) {
        demoteLocation(db, row.id, now);
        removed.push(row.id);
      }
    }
    return { added, removed };
  });

  const { extract } = opts;
  if (extract && result.added.length > 0) {
    const log = opts.log ?? console;
    void extractWebsiteNotes(db, result.added, { extract, log, now: () => now }).catch((e: unknown) =>
      log.error(`Website notes for new picks failed: ${e instanceof Error ? e.message : String(e)}`),
    );
  }
  return result;
}

/** "Never suggest": rejects the place for good in its category; find runs skip it from then on. */
export function neverSuggest(db: Db, locationId: number, now: Date): Location {
  return rejectLocation(db, locationId, now);
}
