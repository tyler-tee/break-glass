import type { Db } from '../../db/client.js';
import { getPublished } from '../protocols/repo.js';
import { listFacts, listPhotos, type HouseFact } from './repo.js';

/** The family home page shows its House banner only when there is something behind it. */
export function hasHomeContent(db: Db): boolean {
  return getPublished(db, { area: 'home' }).length > 0 || listFacts(db).length > 0;
}

/** The oldest check across these facts, so "Checked <date>" holds for every one of them. */
export function oldestChecked(facts: readonly Pick<HouseFact, 'checkedAt'>[]): Date | null {
  const times = facts.map((f) => f.checkedAt?.getTime()).filter((t): t is number => typeof t === 'number');
  return times.length === 0 ? null : new Date(Math.min(...times));
}

/** First photo (no bytes) of each fact that has one. */
export function firstPhotos(db: Db, facts: readonly HouseFact[]): Map<number, { id: number; caption: string | null }> {
  const out = new Map<number, { id: number; caption: string | null }>();
  for (const f of facts) {
    const first = listPhotos(db, f.id)[0];
    if (first) out.set(f.id, { id: first.id, caption: first.caption });
  }
  return out;
}

/** "Oct 28, 2026" in the household's time zone. */
export function formatDay(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz }).format(d);
}
