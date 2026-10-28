import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { HoursProfile } from '../../src/domain/hours.js';
import { fallbackRank, haversineMi, type RankFacts } from '../../src/domain/ranking.js';
import type { BusinessStatus, HoursNeed, LatLng, WeeklyHours } from '../../src/domain/types.js';
import { prepass } from '../../src/services/llm/rankPlaces.js';

describe('haversineMi', () => {
  it('haversine SLC→Provo ≈ 38 mi ±1', () => {
    const slc = { lat: 40.7608, lng: -111.891 };
    const provo = { lat: 40.2338, lng: -111.6585 };
    // great-circle value computed by hand: 38.41 mi
    expect(Math.abs(haversineMi(slc, provo) - 38.41)).toBeLessThan(1.5);
  });
});

type RealRow = {
  name: string;
  address: string;
  distanceMi: number;
  rating: number | null;
  ratingCount: number | null;
  businessStatus: BusinessStatus;
  hours: WeeklyHours | null;
};
const real = JSON.parse(
  fs.readFileSync(path.resolve(import.meta.dirname, '../fixtures/ranking/st-cloud.json'), 'utf8'),
) as { home: LatLng; radiusMi: number; pharmacy: RealRow[]; pediatrician: RealRow[] };

// Real rows carry a stored distance and no coordinates, as old homelab rows do.
function rankReal(rows: RealRow[], hoursNeed: HoursNeed) {
  const { kept } = prepass(
    rows.map((r) => ({ ...r, shortAddress: null, lat: null, lng: null, primaryType: null, openNow: null, reviews: [] })),
    { home: real.home, radiusMi: real.radiusMi },
  );
  const ranked = fallbackRank(hoursNeed, kept);
  const byRef = new Map(kept.map((k) => [k.ref, k.place]));
  return ranked.map((r) => ({ ...r, name: byRef.get(r.ref)!.name, address: byRef.get(r.ref)!.address }));
}

describe('fallbackRank on the real St Cloud data', () => {
  it('pharmacy top 3: CVS y más Pleasant Hill, Navarro, CVS W Sand Lake', () => {
    const ranked = rankReal(real.pharmacy, 'overnight');
    expect(ranked.filter((r) => r.verdict === 'pick').map((r) => `${r.name} @ ${r.address.split(',')[0]}`)).toEqual([
      'CVS Pharmacy y más @ 4500 Pleasant Hill Rd',
      'Navarro Discount Pharmacy @ 1205 W Vine St',
      'CVS Pharmacy @ 7599 W Sand Lake Rd',
    ]);
    expect(ranked[0]!.reason).toBe('Open 24 hours, 3.8★ across 121 reviews, 12.5 mi.');
  });

  it('pharmacy: places not open 24 hours are avoided with not_24h; a 2 AM–1:30 AM Walgreens is not', () => {
    const ranked = rankReal(real.pharmacy, 'overnight');
    const of = (name: string, street: string) => ranked.find((r) => r.name === name && r.address.startsWith(street))!;
    expect(of('Lake Buena Vista Pharmacy', '13401')).toMatchObject({ verdict: 'avoid', flags: ['not_24h', 'few_reviews'], reason: 'Not open 24 hours.' });
    expect(of('Walgreens Pharmacy', '7650')).toMatchObject({ verdict: 'avoid', flags: ['not_24h'] });
    expect(of('Peptide Therapist Store', '300')).toMatchObject({ verdict: 'avoid' });
    expect(of('Walgreens Pharmacy', '395').verdict).toBe('backup');
    expect(of('Pharma Anabolics Shop', '726').flags).toEqual(['few_reviews']);
    expect(ranked.filter((r) => r.verdict === 'backup')).toHaveLength(4);
    expect(ranked.map((r) => r.rank)).toEqual(ranked.map((_, i) => i + 1));
  });

  it('pediatrician top 3: Osceola Community Health, All Around Peds, BVL Peds', () => {
    const ranked = rankReal(real.pediatrician, 'daytime');
    expect(ranked.filter((r) => r.verdict === 'pick').map((r) => r.name)).toEqual([
      'Osceola Community Health Services (Primary Care / Pediatrics)',
      'All Around Pediatrics',
      'BVL Pediatrics',
    ]);
    expect(ranked[0]!.reason).toBe('4.4★ across 286 reviews, 0.6 mi.');
    expect(ranked[2]!.reason).toBe('4.7★ across 138 reviews, 3.4 mi, open evenings & weekends.');
    // Daytime categories never gate on 24 hours.
    expect(ranked.some((r) => r.flags.includes('not_24h'))).toBe(false);
  });
});

describe('fallbackRank', () => {
  const profile = (over: Partial<HoursProfile> = {}): HoursProfile => ({
    open24h: true,
    summary: '24 hours',
    eveningsOrWeekends: true,
    ...over,
  });
  const facts = (ref: number, over: Partial<RankFacts> = {}): RankFacts => ({
    ref,
    distanceMi: 1,
    rating: 4.5,
    ratingCount: 200,
    businessStatus: 'OPERATIONAL',
    profile: profile(),
    ...over,
  });

  it('weighs rating with review count: 5.0 from 3 reviews loses to 4.3 from 800', () => {
    const ranked = fallbackRank('overnight', [facts(1, { rating: 5, ratingCount: 3 }), facts(2, { rating: 4.3, ratingCount: 800 })]);
    expect(ranked.map((r) => r.ref)).toEqual([2, 1]);
    expect(ranked[1]!.flags).toEqual(['few_reviews']);
  });

  it('a temporarily closed place is avoided whatever its score', () => {
    const ranked = fallbackRank('daytime', [facts(1, { businessStatus: 'CLOSED_TEMPORARILY', rating: 5, ratingCount: 900 }), facts(2)]);
    expect(ranked.map((r) => [r.ref, r.verdict, r.reason])).toEqual([
      [2, 'pick', '4.5★ across 200 reviews, 1.0 mi, open evenings & weekends.'],
      [1, 'avoid', 'Marked temporarily closed by Google.'],
    ]);
    expect(ranked[1]!.flags).toEqual(['closed_temporarily']);
  });

  it('three picks, then backups: a clean place past the top 7 is still a backup, not ruled out', () => {
    const ranked = fallbackRank('overnight', Array.from({ length: 9 }, (_, i) => facts(i + 1, { distanceMi: i + 1 })));
    expect(ranked.map((r) => r.verdict)).toEqual(['pick', 'pick', 'pick', 'backup', 'backup', 'backup', 'backup', 'backup', 'backup']);
    expect(ranked.map((r) => r.ref)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ranked[8]!.reason).toBe('Open 24 hours, 4.5★ across 200 reviews, 9.0 mi.');
  });

  it('past the top 7, a flagged place is avoid; inside the top 7, few reviews alone never rule a place out', () => {
    const ranked = fallbackRank('overnight', [
      facts(1, { distanceMi: 1, rating: 4.9, ratingCount: 6 }), // few reviews, but still near the top
      ...Array.from({ length: 6 }, (_, i) => facts(i + 2, { distanceMi: i + 2 })),
      facts(9, { distanceMi: 30, rating: 4, ratingCount: 4 }),
    ]);
    const of = (ref: number) => ranked.find((r) => r.ref === ref)!;
    expect(ranked).toHaveLength(8);
    expect(ranked[7]!.ref).toBe(9);
    expect(of(1)).toMatchObject({ flags: ['few_reviews'] });
    expect(of(1).verdict).not.toBe('avoid');
    expect(of(9)).toMatchObject({ verdict: 'avoid', flags: ['few_reviews'], reason: 'Open 24 hours, 4.0★ across 4 reviews, 30.0 mi.' });
    expect(ranked.filter((r) => r.verdict === 'avoid').map((r) => r.ref)).toEqual([9]);
  });

  it('handles a missing rating and an unknown distance', () => {
    const [r] = fallbackRank('overnight', [facts(1, { rating: null, ratingCount: null, distanceMi: null })]);
    expect(r).toMatchObject({ verdict: 'pick', reason: 'Open 24 hours, No rating yet.', flags: ['few_reviews'] });
  });
});
