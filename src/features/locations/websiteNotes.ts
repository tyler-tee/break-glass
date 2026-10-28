import type { Db } from '../../db/client.js';
import { hashTracked, trackedFromLocation } from '../../domain/snapshot.js';
import type { Area, Logger } from '../../domain/types.js';
import type { Extractor } from '../../services/llm/extract.js';
import { getCategory } from '../categories/repo.js';
import { getLocation, insertSnapshot, latestSnapshot, updateLocationRow } from './repo.js';

/** Health keeps its original call shape (no options without a hash to skip on); home also names its area. */
export function extractOpts(area: Area, skipIfHash: string | null | undefined): { skipIfHash?: string | null; area?: Area } | undefined {
  if (area === 'home') return { ...(skipIfHash !== undefined ? { skipIfHash } : {}), area };
  return skipIfHash !== undefined ? { skipIfHash } : undefined;
}

/**
 * Reads each place's website for after-hours, walk-in and insurance notes and stores them. An approved place
 * also gets a fresh snapshot so refresh compares against the notes. Returns how many places got notes.
 */
export async function extractWebsiteNotes(
  db: Db,
  locationIds: number[],
  deps: { extract: Extractor; log: Logger; now: () => Date },
): Promise<number> {
  let extracted = 0;
  for (const id of locationIds) {
    const row = getLocation(db, id);
    if (!row?.website) continue;
    const area = getCategory(db, row.categoryId)?.area ?? 'health';
    const hasNotes = row.afterHoursNotes !== null || row.walkIns !== null || row.insuranceNotes !== null;
    try {
      const { extraction: e, pageHash } = await deps.extract(row.website, extractOpts(area, hasNotes ? row.websiteHash : undefined));
      if (!e) continue;
      const at = deps.now();
      db.transaction((tx) => {
        const updated = updateLocationRow(tx, id, {
          afterHoursNotes: e.afterHoursNotes.value,
          walkIns: area === 'home' ? null : e.walkIns.value,
          insuranceNotes: area === 'home' ? null : e.insuranceNotes.value,
          websiteHash: pageHash,
          updatedAt: at,
        });
        if (updated.status === 'approved' && latestSnapshot(tx, id)) {
          const payload = trackedFromLocation(updated);
          insertSnapshot(tx, { locationId: id, fetchedAt: at, payload, hash: hashTracked(payload) });
        }
      });
      extracted++;
    } catch (err) {
      deps.log.warn(`Extraction failed for ${row.website}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return extracted;
}
