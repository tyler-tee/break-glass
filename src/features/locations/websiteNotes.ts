import type { Db } from '../../db/client.js';
import { hashTracked, trackedFromLocation } from '../../domain/snapshot.js';
import type { Logger } from '../../domain/types.js';
import type { Extractor } from '../../services/llm/extract.js';
import { getLocation, insertSnapshot, latestSnapshot, updateLocationRow } from './repo.js';

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
    const hasNotes = row.afterHoursNotes !== null || row.walkIns !== null || row.insuranceNotes !== null;
    try {
      const { extraction: e, pageHash } = await deps.extract(row.website, hasNotes ? { skipIfHash: row.websiteHash } : undefined);
      if (!e) continue;
      const at = deps.now();
      db.transaction((tx) => {
        const updated = updateLocationRow(tx, id, {
          afterHoursNotes: e.afterHoursNotes.value,
          walkIns: e.walkIns.value,
          insuranceNotes: e.insuranceNotes.value,
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
