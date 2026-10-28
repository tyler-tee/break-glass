import type { HoursProfile } from './hours.js';
import type { BusinessStatus, HoursNeed, LatLng, RankVerdict } from './types.js';

/** Every category shows this many picks. */
export const PICKS_PER_CATEGORY = 3;

const EARTH_RADIUS_MI = 3958.8;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

export function haversineMi(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(h));
}

export const RANK_FLAGS = [
  'not_24h',
  'closed_temporarily',
  'poor_reviews',
  'few_reviews',
  'far',
  'wrong_kind',
  'referral_listing',
  'duplicate',
  'check_hours',
] as const;
export type RankFlag = (typeof RANK_FLAGS)[number];

/** One place's place in its category's ranking; `ref` is the caller's handle for the place. */
export type PlaceRanking = { ref: number; verdict: RankVerdict; rank: number; reason: string; flags: RankFlag[] };

/** The facts the fallback scorer reads; the pre-pass computes them. */
export type RankFacts = {
  ref: number;
  distanceMi: number | null;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: BusinessStatus | null;
  profile: HoursProfile;
};

const BACKUPS = 4;
// Bayesian prior: a rating pulled toward 3.8 as if from 20 extra reviews.
const PRIOR_RATING = 3.8;
const PRIOR_WEIGHT = 20;
const DECAY_MI: Record<HoursNeed, number> = { overnight: 12, daytime: 8 };
const FEW_REVIEWS = 15;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function factsReason(p: RankFacts, hoursNeed: HoursNeed): string {
  const parts: string[] = [];
  if (hoursNeed === 'overnight') parts.push('Open 24 hours');
  parts.push(p.rating !== null ? `${p.rating.toFixed(1)}★ across ${plural(p.ratingCount ?? 0, 'review')}` : 'No rating yet');
  if (p.distanceMi !== null) parts.push(`${p.distanceMi.toFixed(1)} mi`);
  const evenings = hoursNeed === 'daytime' && p.profile.eveningsOrWeekends ? ', open evenings & weekends' : '';
  return `${parts.join(', ')}${evenings}.`;
}

/**
 * Ranking without an LLM: Bayesian-smoothed rating × distance decay × hours, best first. The top 3 are picks,
 * the next 4 backups, the rest avoid; places that fail the hours gate or are temporarily closed are always avoid.
 */
export function fallbackRank(hoursNeed: HoursNeed, places: RankFacts[]): PlaceRanking[] {
  const scored = places.map((p, index) => {
    const flags: RankFlag[] = [];
    const votes = p.rating === null ? 0 : (p.ratingCount ?? 0);
    const smoothed = p.rating === null ? PRIOR_RATING : (votes * p.rating + PRIOR_WEIGHT * PRIOR_RATING) / (votes + PRIOR_WEIGHT);
    let score = (smoothed - 1) / 4;
    // An unknown distance counts as one decay length away.
    score *= p.distanceMi === null ? 0.5 : 1 / (1 + p.distanceMi / DECAY_MI[hoursNeed]);

    let gated = false;
    let reason: string | null = null;
    if (hoursNeed === 'overnight' && !p.profile.open24h) {
      score *= 0.05;
      flags.push('not_24h');
      gated = true;
      reason = 'Not open 24 hours.';
    }
    if (p.businessStatus === 'CLOSED_TEMPORARILY') {
      score *= 0.01;
      flags.push('closed_temporarily');
      gated = true;
      reason = 'Marked temporarily closed by Google.';
    }
    if (hoursNeed === 'daytime' && p.profile.eveningsOrWeekends) score *= 1.15;
    if (p.ratingCount === null) score *= 0.4;
    else if (p.ratingCount < FEW_REVIEWS) score *= 0.5;
    if (p.ratingCount === null || p.ratingCount < FEW_REVIEWS) flags.push('few_reviews');

    return { p, index, score, gated, flags, reason: reason ?? factsReason(p, hoursNeed) };
  });

  const byScore = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.score - a.score || a.index - b.index;
  const open = scored.filter((s) => !s.gated).sort(byScore);
  const gated = scored.filter((s) => s.gated).sort(byScore);
  return [...open, ...gated].map((s, i) => ({
    ref: s.p.ref,
    verdict: s.gated || i >= PICKS_PER_CATEGORY + BACKUPS ? 'avoid' : i < PICKS_PER_CATEGORY ? 'pick' : 'backup',
    rank: i + 1,
    reason: s.reason,
    flags: s.flags,
  }));
}
