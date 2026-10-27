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
  callsUsed: number;
  stoppedEarly: boolean;
};

export async function runDiscovery(
  db: Db,
  categoryId: number,
  deps: { places: PlacesDeps; now: () => Date; log: Logger },
): Promise<DiscoveryReport> {
  const { places, now, log } = deps;
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
    callsUsed: 0,
    stoppedEarly: false,
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

    for (const summary of rankByDistanceThenRating(fresh)) {
      let details: PlaceDetails;
      try {
        details = await placeDetails(summary.placeId, places);
        report.detailsFetched++;
      } catch (e) {
        if (!(e instanceof PlacesError)) throw e;
        log.warn(`Place details failed for ${summary.placeId}: ${e.message}`);
        details = { ...summary, phone: null, website: null, hours: null };
      }
      const { address, phone, website, hours, businessStatus, rating, ratingCount } = detailsToTracked(details);
      insertLocation(db, {
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
    }
  } catch (e) {
    if (!(e instanceof BudgetExhausted)) throw e;
    report.stoppedEarly = true;
  }
  return finish();
}
