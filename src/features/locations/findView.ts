import { PICKS_PER_CATEGORY, type RankFlag } from '../../domain/ranking.js';
import type { HoursNeed } from '../../domain/types.js';
import type { RankedRow } from './findAndRank.js';

/** The words a flag chip shows; every flag the ranker can set has one. */
export const FLAG_LABELS: Record<RankFlag, string> = {
  not_24h: 'Not 24 hours',
  closed_temporarily: 'Temporarily closed',
  poor_reviews: 'Poor reviews',
  few_reviews: 'Few reviews',
  far: 'Far',
  wrong_kind: 'Wrong kind of place',
  referral_listing: 'Referral listing',
  duplicate: 'Duplicate',
  check_hours: 'Check hours',
};

export const flagLabel = (flag: string): string => FLAG_LABELS[flag as RankFlag] ?? flag.replace(/_/g, ' ');

/** "A", "A and B", "A, B and C". */
export function listWords(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const street = (row: Pick<RankedRow, 'shortAddress' | 'address'>): string =>
  (row.shortAddress ?? row.address ?? '').split(',')[0]!.replace(/^[\d-]+[A-Za-z]?\s+/, '').trim();

/**
 * Names for the change summary. Two "CVS Pharmacy y más" rows are told apart by street:
 * "CVS Pharmacy y más (Pleasant Hill Rd)".
 */
export function shortNames(rows: RankedRow[]): Map<number, string> {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.name, (counts.get(r.name) ?? 0) + 1);
  return new Map(
    rows.map((r) => {
      const s = street(r);
      return [r.id, (counts.get(r.name) ?? 0) > 1 && s ? `${r.name} (${s})` : r.name];
    }),
  );
}

export type ChangeSummary = { text: string; error: boolean; changed: boolean; count: number };

/** The line under a section header: what saving these checks would do to the family site. */
export function changeSummary(rows: RankedRow[], checked: ReadonlySet<number>, names = shortNames(rows)): ChangeSummary {
  const count = rows.filter((r) => checked.has(r.id)).length;
  const adds = rows.filter((r) => checked.has(r.id) && !r.currentPick).map((r) => names.get(r.id)!);
  const removes = rows.filter((r) => r.currentPick && !checked.has(r.id)).map((r) => names.get(r.id)!);
  const changed = adds.length > 0 || removes.length > 0;
  if (count === 0) return { text: 'Pick at least 1 place.', error: true, changed, count };
  if (!changed) return { text: 'Same as what the family site shows now.', error: false, changed, count };
  const parts: string[] = [];
  if (adds.length) parts.push(`adds ${listWords(adds)}`);
  if (removes.length) parts.push(`takes off ${listWords(removes)}`);
  let text = `Saving ${parts.join(' and ')}.`;
  return { text, error: false, changed, count };
}

export const saveLabel = (s: Pick<ChangeSummary, 'changed' | 'count'>): string =>
  s.changed ? `Save ${s.count} pick${s.count === 1 ? '' : 's'}` : 'No changes';

/** The AI's picks, in rank order, at most 3: what the checkboxes start as. */
export const defaultPicks = (rows: RankedRow[]): Set<number> =>
  new Set(rows.filter((r) => r.rankVerdict === 'pick').slice(0, PICKS_PER_CATEGORY).map((r) => r.id));

export type HoursCell = { pill: 'open' | 'closed' | 'unknown'; text: string; note?: string };

/**
 * The Hours column: the weekly schedule (not open-now), green when it fits what the category needs:
 * open 24 hours for an overnight category, some evenings or weekends for a daytime one.
 */
export function hoursCell(row: Pick<RankedRow, 'hoursProfile' | 'businessStatus'>, need: HoursNeed): HoursCell {
  const p = row.hoursProfile;
  if (row.businessStatus === 'CLOSED_TEMPORARILY') return { pill: 'closed', text: 'Temporarily closed', note: 'Per Google' };
  if (p.summary === 'Hours unknown') return { pill: 'unknown', text: 'Hours unknown', note: 'Call to check' };
  const fits = need === 'overnight' ? p.open24h : p.eveningsOrWeekends || p.open24h;
  const note =
    p.dailyGapNote ?? (need === 'daytime' && p.eveningsOrWeekends && !p.open24h && p.summary === 'Varies by day' ? 'Some evenings or weekends' : undefined);
  return { pill: fits ? 'open' : 'closed', text: p.summary, ...(note ? { note } : {}) };
}

export function ratingText(row: Pick<RankedRow, 'rating' | 'ratingCount'>): { rating: string; reviews: string } {
  const n = row.ratingCount ?? 0;
  return {
    rating: row.rating === null ? 'No rating' : `${row.rating.toFixed(1)} ★`,
    reviews: n === 0 ? 'No reviews' : `${n.toLocaleString('en-US')} review${n === 1 ? '' : 's'}`,
  };
}

/** "just now", "4 min ago", "3 h ago", else "Oct 12". */
export function agoText(then: Date, now: Date, timeZone?: string): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  let date: string;
  try {
    date = then.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(timeZone ? { timeZone } : {}) });
  } catch {
    date = then.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return `on ${date}`;
}

/** "40 s ago" for the run card, where seconds matter. */
export function startedText(then: Date, now: Date): string {
  const s = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (s < 60) return `${s} s ago`;
  return `${Math.floor(s / 60)} min ago`;
}

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
