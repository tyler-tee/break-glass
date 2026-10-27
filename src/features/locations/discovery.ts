import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { locations } from '../../db/schema.js';
import { haversineMi, rankByDistanceThenRating } from '../../domain/ranking.js';
import type { LatLng, Logger } from '../../domain/types.js';
import {
  BudgetExhausted,
  PlacesError,
  detailsToTracked,
  placeDetails,
  textSearch,
  type PlacesDeps,
} from '../../services/places/client.js';
import type { Extractor } from '../../services/llm/extract.js';
import type { PlaceDetails, PlaceSummary } from '../../services/places/types.js';
import { getSettings } from '../admin/settingsRepo.js';
import { getCategory } from '../categories/repo.js';
import { insertLocation } from './repo.js';
import { LocationError } from './service.js';

export class NoHomeLocation extends Error {}

export type DiscoveryReport = {
  searched: number;
  found: number;
  inserted: number;
  skipped: number;
  detailsFetched: number;
  extracted: number;
  callsUsed: number;
  stoppedEarly: boolean;
  stopReason: 'run' | 'month' | null;
};

export async function runDiscovery(
  db: Db,
  categoryId: number,
  deps: { places: PlacesDeps; now: () => Date; log: Logger; extract?: Extractor },
): Promise<DiscoveryReport> {
  const { places, now, log, extract } = deps;
  const { homeLat, homeLng, defaultRadiusMi } = getSettings(db);
  if (homeLat === null || homeLng === null) throw new NoHomeLocation('Home location is not set');
  const category = getCategory(db, categoryId);
  if (!category) throw new LocationError('not_found', 'Category not found');

  const home: LatLng = { lat: homeLat, lng: homeLng };
  const radiusMi = defaultRadiusMi ?? 15;
  const report: DiscoveryReport = {
    searched: 0,
    found: 0,
    inserted: 0,
    skipped: 0,
    detailsFetched: 0,
    extracted: 0,
    callsUsed: 0,
    stoppedEarly: false,
    stopReason: null,
  };
  const stop = (e: BudgetExhausted): void => {
    report.stoppedEarly = true;
    report.stopReason = e.reason;
    log.warn(`Discovery stopped early (${e.reason} cap): ${e.message}`);
  };
  const finish = (): DiscoveryReport => ({ ...report, callsUsed: places.budget.used });

  try {
    const byPlaceId = new Map<string, PlaceSummary>();
    for (const term of category.searchTerms) {
      const results = await textSearch(term, { center: home, radiusMi }, places);
      report.searched++;
      for (const p of results) if (!byPlaceId.has(p.placeId)) byPlaceId.set(p.placeId, p);
    }
    report.found = byPlaceId.size;

    const known = new Set(
      db
        .select({ placeId: locations.placeId })
        .from(locations)
        .all()
        .map((r) => r.placeId),
    );
    const fresh = [...byPlaceId.values()]
      .filter((p) => {
        if (known.has(p.placeId)) {
          report.skipped++;
          return false;
        }
        return true;
      })
      .map((p) => ({ ...p, distanceMi: haversineMi(home, { lat: p.lat, lng: p.lng }) }))
      .filter((p) => p.distanceMi <= radiusMi);

    // Search no longer returns ratings (cheaper SKU), so fetch details nearest-first and
    // rank by distance then rating once the ratings are known.
    const enriched: { summary: (typeof fresh)[number]; details: PlaceDetails }[] = [];
    try {
      for (const summary of [...fresh].sort((a, b) => a.distanceMi - b.distanceMi)) {
        let details: PlaceDetails;
        try {
          details = await placeDetails(summary.placeId, places);
          report.detailsFetched++;
        } catch (e) {
          if (!(e instanceof PlacesError)) throw e;
          log.warn(`Place details failed for ${summary.placeId}: ${e.message}`);
          details = { ...summary, phone: null, website: null, hours: null };
        }
        enriched.push({ summary, details });
      }
    } catch (e) {
      if (!(e instanceof BudgetExhausted)) throw e;
      stop(e);
    }

    const ranked = rankByDistanceThenRating(
      enriched.map((x) => ({ ...x, distanceMi: x.summary.distanceMi, rating: x.details.rating })),
    );
    for (const { summary, details } of ranked) {
      const { address, phone, website, hours, businessStatus, rating, ratingCount } = detailsToTracked(details);
      const inserted = insertLocation(db, {
        categoryId,
        placeId: details.placeId,
        name: details.name,
        address,
        phone,
        website,
        lat: details.lat,
        lng: details.lng,
        distanceMi: summary.distanceMi,
        rating,
        ratingCount,
        businessStatus,
        hours,
        status: 'candidate',
        createdAt: now(),
        updatedAt: now(),
      });
      report.inserted++;

      if (extract && website) {
        try {
          const { extraction: e, pageHash } = await extract(website);
          if (e) {
            db.update(locations)
              .set({
                afterHoursNotes: e.afterHoursNotes.value,
                walkIns: e.walkIns.value,
                insuranceNotes: e.insuranceNotes.value,
                websiteHash: pageHash,
              })
              .where(eq(locations.id, inserted.id))
              .run();
            report.extracted++;
          }
        } catch (err) {
          log.warn(`Extraction failed for ${website}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    stop(e);
  }
  return finish();
}
