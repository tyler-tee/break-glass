import { z } from 'zod';
import { hoursProfile } from '../../domain/hours.js';
import {
  PICKS_PER_CATEGORY,
  RANK_FLAGS,
  haversineMi,
  type PlaceRanking,
  type RankFacts,
  type RankFlag,
} from '../../domain/ranking.js';
import type { BusinessStatus, HoursNeed, LatLng, WeeklyHours } from '../../domain/types.js';
import type { PlaceCandidate, PlaceReview } from '../places/types.js';
import type { LlmProvider } from './provider.js';

/** A place as ranking sees it: a fresh search result, or a stored row the search did not return. */
export type RankPlace = {
  name: string;
  address: string | null;
  shortAddress: string | null;
  lat: number | null;
  lng: number | null;
  /** Stored distance, used only when there are no coordinates. */
  distanceMi: number | null;
  businessStatus: BusinessStatus | null;
  rating: number | null;
  ratingCount: number | null;
  primaryType: string | null;
  hours: WeeklyHours | null;
  openNow: boolean | null;
  reviews: PlaceReview[];
};

export const rankPlaceFromCandidate = (c: PlaceCandidate): RankPlace => ({
  name: c.name,
  address: c.address,
  shortAddress: c.shortAddress,
  lat: c.lat,
  lng: c.lng,
  distanceMi: null,
  businessStatus: c.businessStatus,
  rating: c.rating,
  ratingCount: c.ratingCount,
  primaryType: c.primaryTypeDisplay ?? c.primaryType,
  hours: c.hours,
  openNow: c.openNow,
  reviews: c.reviews,
});

/** A place that survived the pre-pass, with the facts the LLM and the fallback scorer are given. */
export type Prepared<T extends RankPlace = RankPlace> = RankFacts & {
  place: T;
  shortAddress: string | null;
  openNow: boolean | null;
  duplicateOfRef?: number;
};
export type DropReason = 'closed_permanently' | 'outside_radius';
export type Dropped<T extends RankPlace = RankPlace> = { place: T; reason: DropReason; distanceMi: number | null };

const DUPLICATE_METERS = 50;
const METERS_PER_MILE = 1609.344;

/** Address key for spotting the same building listed twice: no country, no suite/unit, one space. */
export function normAddr(address: string): string {
  return address
    .toLowerCase()
    .replace(/,\s*(usa|united states)\s*$/, '')
    .replace(/#\s*\w+/g, ' ')
    .replace(/\b(ste|suite|apt|unit|bldg)\b\.?\s*[\w-]+/g, ' ')
    .replace(/\s*,\s*/g, ', ')
    .replace(/(, )+/g, ', ')
    .replace(/\s+/g, ' ')
    .trim();
}

const coordsOf = (p: RankPlace): LatLng | null => (p.lat !== null && p.lng !== null ? { lat: p.lat, lng: p.lng } : null);

/**
 * Deterministic work before ranking: drops permanently closed places and anything past the radius, computes
 * distance and the hours profile, numbers the rest nearest first, and marks later listings of the same place.
 */
export function prepass<T extends RankPlace>(
  places: T[],
  opts: { home: LatLng; radiusMi: number },
): { kept: Prepared<T>[]; dropped: Dropped<T>[] } {
  const dropped: Dropped<T>[] = [];
  const near: { place: T; distanceMi: number | null }[] = [];
  for (const place of places) {
    const at = coordsOf(place);
    const distanceMi = at ? haversineMi(opts.home, at) : place.distanceMi;
    if (place.businessStatus === 'CLOSED_PERMANENTLY') dropped.push({ place, reason: 'closed_permanently', distanceMi });
    else if (distanceMi !== null && distanceMi > opts.radiusMi) dropped.push({ place, reason: 'outside_radius', distanceMi });
    else near.push({ place, distanceMi });
  }
  near.sort((a, b) => (a.distanceMi ?? Infinity) - (b.distanceMi ?? Infinity));

  const kept: Prepared<T>[] = [];
  for (const [i, { place, distanceMi }] of near.entries()) {
    const prepared: Prepared<T> = {
      ref: i + 1,
      place,
      distanceMi,
      rating: place.rating,
      ratingCount: place.ratingCount,
      businessStatus: place.businessStatus,
      profile: hoursProfile(place.hours),
      shortAddress: place.shortAddress,
      openNow: place.openNow,
    };
    const key = place.address ? normAddr(place.address) : null;
    const at = coordsOf(place);
    const original = kept.find((k) => {
      if (k.duplicateOfRef !== undefined) return false;
      if (key !== null && k.place.address && normAddr(k.place.address) === key) return true;
      const there = coordsOf(k.place);
      return at !== null && there !== null && haversineMi(at, there) * METERS_PER_MILE <= DUPLICATE_METERS;
    });
    if (original) prepared.duplicateOfRef = original.ref;
    kept.push(prepared);
  }
  return { kept, dropped };
}

const Flag = z.enum(RANK_FLAGS);
export const RankSchema = z.object({
  places: z.array(
    z.object({
      ref: z.number().int(),
      verdict: z.enum(['pick', 'backup', 'avoid']),
      rank: z.number().int(),
      // Asked for <=140 characters; a longer one is clipped in repair rather than failing the whole category.
      reason: z.string(),
      flags: z.array(Flag).default([]),
    }),
  ),
});
export type RankOutput = z.infer<typeof RankSchema>;

const MAX_REASON = 140;
const MAX_REVIEWS = 5;
const MAX_REVIEW_CHARS = 160;

const systemPrompt = (category: { name: string; hoursNeed: HoursNeed }) =>
  [
    `You rank places for a household emergency directory. In an emergency only three things matter: is it OPEN when we'd need it, is it any GOOD, and is it NEAR. Pick at most ${PICKS_PER_CATEGORY}, mark others backup or avoid.`,
    '',
    `The category is "${category.name}". This category's hours need is "${category.hoursNeed}".`,
    `- overnight: it MUST be open 24 hours. Mark anything not open 24h as avoid with flag not_24h. A ~30-min daily pharmacist/lunch gap still counts as 24h (open24h=true is given to you).`,
    `- daytime: 24h is not required. Evening and weekend hours are a plus, not a must. For a pediatrician, a pediatric urgent care or a primary-care practice both qualify.`,
    '',
    'Rules:',
    '- Weigh rating WITH review count. A 5.0 from 3 reviews is weaker than a 4.3 from 800 (flag few_reviews under ~15). Flag poor_reviews for low ratings or clearly bad review text.',
    "- Flag wrong_kind when the listing is the wrong type (a general vet in Emergency vet; a non-pharmacy in a pharmacy category; an adult-only ER in Children's ER — a dedicated pediatric ER or children's hospital should rank ABOVE a nearer adult ER).",
    '- Flag referral_listing for lead-gen/aggregator entries: generic names like "Emergency Dentist 24/7", few reviews, often repeated across addresses.',
    '- When two entries share an address (dup of #N given), keep the better one and flag the other duplicate.',
    '- Flag far when distance makes it a weak pick given closer equals.',
    '- Flag check_hours when listed hours look implausible for the kind of place (e.g. a regular dental practice listed 24h).',
    `- reason: <=${MAX_REASON} chars, plain, written FOR the household admin ("Nearest 24h option, strong reviews"). No marketing.`,
    'Return only the schema.',
  ].join('\n');

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s);

function reviewText(r: PlaceReview): string | null {
  if (!r.text) return null;
  const meta = [r.rating !== null ? `${r.rating}★` : null, r.relativePublishTime].filter(Boolean).join(', ');
  const quoted = `"${clip(oneLine(r.text).replace(/"/g, "'"), MAX_REVIEW_CHARS)}"`;
  return meta ? `${quoted} (${meta})` : quoted;
}

function placeBlock(p: Prepared): string {
  const { place, profile } = p;
  const name = p.duplicateOfRef !== undefined ? `${place.name} (dup of #${p.duplicateOfRef})` : place.name;
  const where = [
    place.primaryType ?? 'type unknown',
    p.distanceMi !== null ? `${p.distanceMi.toFixed(1)} mi` : 'distance unknown',
    p.shortAddress ?? place.address ?? 'no address',
  ].join(' | ');
  const hours = [profile.summary, profile.dailyGapNote].filter(Boolean).join('; ');
  const lines = [
    `#${p.ref} ${name}`,
    `   type: ${where}`,
    `   hours: ${hours} | open24h=${profile.open24h ? 'yes' : 'no'} | status=${place.businessStatus ?? 'unknown'}`,
    `   rating: ${place.rating !== null ? `${place.rating} (${place.ratingCount ?? 0})` : 'none'}`,
  ];
  const reviews = place.reviews
    .map(reviewText)
    .filter((r): r is string => r !== null)
    .slice(0, MAX_REVIEWS);
  if (reviews.length > 0) lines.push(`   reviews: ${reviews.join('; ')}`);
  return lines.join('\n');
}

/** The ranking prompt: integer refs only (never place ids), at most 5 reviews each, each clipped. */
export function buildRankPrompt(
  category: { name: string; hoursNeed: HoursNeed },
  places: Prepared[],
): { system: string; prompt: string } {
  const prompt = [
    `Category: ${category.name} (hours need: ${category.hoursNeed})`,
    `Places (${places.length}):`,
    '',
    places.map(placeBlock).join('\n\n'),
  ].join('\n');
  return { system: systemPrompt(category), prompt };
}

/**
 * Makes model output safe to store: unknown and repeated refs dropped, omitted places appended as backups,
 * hard flags forced from the facts, at most 3 picks, and ranks renumbered pick → backup → avoid.
 */
export function repairRanking(output: RankOutput, places: Prepared[], hoursNeed: HoursNeed): PlaceRanking[] {
  const byRef = new Map(places.map((p) => [p.ref, p]));
  const seen = new Set<number>();
  const rows: PlaceRanking[] = [];
  for (const r of output.places) {
    if (!byRef.has(r.ref) || seen.has(r.ref)) continue;
    seen.add(r.ref);
    rows.push({ ref: r.ref, verdict: r.verdict, rank: r.rank, reason: clip(oneLine(r.reason), MAX_REASON), flags: [...new Set(r.flags)] });
  }
  for (const p of places) {
    if (!seen.has(p.ref)) rows.push({ ref: p.ref, verdict: 'backup', rank: Number.MAX_SAFE_INTEGER, reason: 'Not ranked by the AI.', flags: [] });
  }

  for (const row of rows) {
    const p = byRef.get(row.ref)!;
    const force = (flag: RankFlag) => {
      if (!row.flags.includes(flag)) row.flags.push(flag);
    };
    if (p.businessStatus === 'CLOSED_TEMPORARILY') force('closed_temporarily');
    if (hoursNeed === 'overnight' && !p.profile.open24h) force('not_24h');
  }

  const picks = rows.filter((r) => r.verdict === 'pick');
  if (picks.length > PICKS_PER_CATEGORY) {
    // Keep the best-ranked picks; ties go to the one returned first.
    const keep = new Set([...picks].sort((a, b) => a.rank - b.rank || rows.indexOf(a) - rows.indexOf(b)).slice(0, PICKS_PER_CATEGORY));
    for (const r of picks) if (!keep.has(r)) r.verdict = 'backup';
  }

  const order = ['pick', 'backup', 'avoid'] as const;
  return order
    .flatMap((v) => rows.filter((r) => r.verdict === v))
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** One LLM call ranks one category; throws on any provider or validation error so the caller can fall back. */
export async function rankWithLlm(
  llm: LlmProvider,
  model: string,
  category: { name: string; hoursNeed: HoursNeed },
  places: Prepared[],
): Promise<PlaceRanking[]> {
  if (places.length === 0) return [];
  const { system, prompt } = buildRankPrompt(category, places);
  const output = await llm.generateJson({ model, system, prompt, schema: RankSchema, maxTokens: 3000, effort: 'medium' });
  return repairRanking(output, places, category.hoursNeed);
}
