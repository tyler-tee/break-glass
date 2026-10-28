import type { Db } from '../db/client.js';
import { decideTransition, diffTracked, hashTracked, normalizeTracked } from '../domain/snapshot.js';
import type { Logger, TrackedFields } from '../domain/types.js';
import type { Env } from '../env.js';
import {
  insertChanges,
  insertSnapshot,
  latestSnapshot,
  listRefreshable,
  updateLocationRow,
} from '../features/locations/repo.js';
import { extractOpts } from '../features/locations/websiteNotes.js';
import { applyExtraction } from '../services/llm/extract.js';
import type { Extractor } from '../services/llm/extract.js';
import {
  BudgetExhausted,
  PlacesError,
  detailsToTracked,
  placeDetails,
  type PlacesDeps,
} from '../services/places/client.js';
import type { PlaceDetails } from '../services/places/types.js';

export type RefreshReport = {
  checked: number;
  warned: number;
  unchanged: number;
  failed: number;
  baselined: number;
  extracted: number;
  callsUsed: number;
  stoppedEarly: boolean;
  stopReason: 'run' | 'month' | null;
};

export async function refreshLocations(
  db: Db,
  deps: {
    places: PlacesDeps;
    env: Pick<Env, 'REFRESH_FAILURE_THRESHOLD' | 'RATING_WARN_DELTA'>;
    now: () => Date;
    log: Logger;
    extract?: Extractor;
  },
): Promise<RefreshReport> {
  const { places, env, now, log, extract } = deps;
  const report: RefreshReport = {
    checked: 0,
    warned: 0,
    unchanged: 0,
    failed: 0,
    baselined: 0,
    extracted: 0,
    callsUsed: 0,
    stoppedEarly: false,
    stopReason: null,
  };
  const finish = (): RefreshReport => ({ ...report, callsUsed: places.budget.used });

  // A place may be picked in more than one category; fetch its details once per run.
  const fetched = new Map<string, PlaceDetails>();
  const detailsOf = async (placeId: string): Promise<PlaceDetails> => {
    const hit = fetched.get(placeId);
    if (hit) return hit;
    const details = await placeDetails(placeId, places);
    fetched.set(placeId, details);
    return details;
  };

  for (const row of listRefreshable(db)) {
    let counted = false;
    try {
      let next: TrackedFields | null = null;
      let newHash: string | undefined;
      const prevSnapshot = latestSnapshot(db, row.id);
      try {
        const details = await detailsOf(row.placeId!);
        // LLM note fields are carried forward from the row unless extraction returns something.
        let tracked: TrackedFields = {
          ...detailsToTracked(details),
          afterHoursNotes: row.afterHoursNotes,
          walkIns: row.walkIns,
          insuranceNotes: row.insuranceNotes,
        };
        const website = tracked.website ?? row.website;
        if (extract && website) {
          const hasNotes = row.afterHoursNotes !== null || row.walkIns !== null || row.insuranceNotes !== null;
          const result = await extract(website, extractOpts(row.area, hasNotes ? row.websiteHash : undefined));
          if (hasNotes && result.pageHash !== null && result.pageHash === row.websiteHash) {
            // Page text unchanged: carry the notes forward from the last snapshot instead of re-extracting.
            if (prevSnapshot) {
              const p = prevSnapshot.payload;
              tracked = {
                ...tracked,
                afterHoursNotes: p.afterHoursNotes ?? null,
                walkIns: p.walkIns ?? null,
                insuranceNotes: p.insuranceNotes ?? null,
              };
            }
          } else {
            if (result.extraction) {
              report.extracted++;
              // Only remember the hash once extraction succeeded, so a failed run is retried.
              if (result.pageHash !== null) newHash = result.pageHash;
            }
            tracked = applyExtraction(tracked, result.extraction, row.area);
          }
        }
        next = normalizeTracked(tracked);
      } catch (e) {
        if (!(e instanceof PlacesError || e instanceof TypeError)) throw e;
        log.warn(`Place details failed for ${row.placeId}: ${e.message}`);
      }
      report.checked++;
      counted = true;

      const at = now();
      const base = {
        current: row.status,
        failures: row.consecutiveFetchFailures,
        failureThreshold: env.REFRESH_FAILURE_THRESHOLD,
        ratingWarnDelta: env.RATING_WARN_DELTA,
      };

      if (next === null) {
        const decision = decideTransition({ ...base, fetchOk: false, changes: [] });
        db.transaction((tx) => {
          insertChanges(tx, row.id, at, decision.changeRows);
          updateLocationRow(tx, row.id, {
            status: decision.status,
            consecutiveFetchFailures: decision.failures,
            updatedAt: at,
          });
        });
        report.failed++;
        if (decision.status === 'warn' && decision.changeRows.length > 0) report.warned++;
        continue;
      }

      const snapshot = next;
      if (prevSnapshot === null) {
        db.transaction((tx) => {
          insertSnapshot(tx, { locationId: row.id, fetchedAt: at, payload: snapshot, hash: hashTracked(snapshot) });
          updateLocationRow(tx, row.id, {
            lastVerifiedAt: at,
            consecutiveFetchFailures: 0,
            updatedAt: at,
            ...(newHash !== undefined && { websiteHash: newHash }),
          });
        });
        report.baselined++;
        continue;
      }

      const changes = diffTracked(normalizeTracked(prevSnapshot.payload), snapshot);
      const decision = decideTransition({ ...base, fetchOk: true, changes });
      db.transaction((tx) => {
        if (decision.writeSnapshot) {
          insertSnapshot(tx, { locationId: row.id, fetchedAt: at, payload: snapshot, hash: hashTracked(snapshot) });
        }
        insertChanges(tx, row.id, at, decision.changeRows);
        updateLocationRow(tx, row.id, {
          status: decision.status,
          consecutiveFetchFailures: decision.failures,
          updatedAt: at,
          ...(decision.touchVerified && { lastVerifiedAt: at }),
          ...(newHash !== undefined && { websiteHash: newHash }),
        });
      });
      if (decision.status === 'warn' && decision.changeRows.length > 0) report.warned++;
      else if (decision.touchVerified && decision.changeRows.length === 0) report.unchanged++;
    } catch (e) {
      if (e instanceof BudgetExhausted) {
        report.stoppedEarly = true;
        report.stopReason = e.reason;
        log.warn(`Refresh stopped early (${e.reason} cap): ${e.message}`);
        return finish();
      }
      log.error(`Refresh failed for location ${row.id}: ${e instanceof Error ? e.message : String(e)}`);
      if (!counted) report.checked++;
      report.failed++;
    }
  }
  return finish();
}
