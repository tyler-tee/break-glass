import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlaceRanking } from '../../src/domain/ranking.js';
import type { WeeklyHours } from '../../src/domain/types.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import {
  buildRankPrompt,
  normAddr,
  prepass,
  rankPlaceFromCandidate,
  rankWithLlm,
  repairRanking,
  type Prepared,
  type RankOutput,
  type RankPlace,
} from '../../src/services/llm/rankPlaces.js';
import { CallBudget, richSearch } from '../../src/services/places/client.js';
import type { PlaceCandidate } from '../../src/services/places/types.js';
import { recordingFetch } from '../helpers/recordingFetch.js';

const PLACES_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const LLM_DIR = path.resolve(import.meta.dirname, '../fixtures/llm');
const HOME = { lat: 40.7608, lng: -111.891 };
const MODEL = 'claude-opus-5-5';
const PHARMACY = { name: '24-hour pharmacy', hoursNeed: 'overnight' as const };

const allDay = (): WeeklyHours => {
  const iv = () => [{ open: '0000', close: '2400' }];
  return { periods: { '0': iv(), '1': iv(), '2': iv(), '3': iv(), '4': iv(), '5': iv(), '6': iv() }, weekdayText: [] };
};
const place = (over: Partial<RankPlace> & { name: string }): RankPlace => ({
  address: null,
  shortAddress: null,
  lat: null,
  lng: null,
  distanceMi: 1,
  businessStatus: 'OPERATIONAL',
  rating: 4.5,
  ratingCount: 100,
  primaryType: 'Pharmacy',
  hours: allDay(),
  openNow: null,
  reviews: [],
  ...over,
});

async function pharmacySearch(): Promise<PlaceCandidate[]> {
  const places = { fetch: recordingFetch(PLACES_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(10) };
  const merged = new Map<string, PlaceCandidate>();
  for (const term of ['24 hour pharmacy', 'late night pharmacy']) {
    for (const c of await richSearch(term, { center: HOME, radiusMi: 15 }, places)) {
      if (!merged.has(c.placeId)) merged.set(c.placeId, c);
    }
  }
  return [...merged.values()];
}

let kept: Prepared[] = [];
let dropped: { place: RankPlace; reason: string }[] = [];
beforeAll(async () => {
  ({ kept, dropped } = prepass((await pharmacySearch()).map(rankPlaceFromCandidate), { home: HOME, radiusMi: 15 }));
});
const refOf = (name: string) => kept.find((k) => k.place.name === name)!.ref;

describe('prepass', () => {
  it('drops permanently closed places and places past the radius, and keeps temporarily closed ones', () => {
    expect(dropped.map((d) => [d.place.name, d.reason])).toEqual([
      ['Rite Aid', 'closed_permanently'],
      ['Provo 24 Hour Pharmacy', 'outside_radius'],
    ]);
    expect(kept.find((k) => k.place.name === "Smith's Pharmacy")!.businessStatus).toBe('CLOSED_TEMPORARILY');
  });

  it('numbers places nearest first and attaches distance, hours profile, openNow and short address', () => {
    expect(kept.map((k) => k.ref)).toEqual([1, 2, 3, 4, 5, 6]);
    const distances = kept.map((k) => k.distanceMi!);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    const cvs = kept.find((k) => k.place.name === 'CVS Pharmacy')!;
    expect(cvs).toMatchObject({ shortAddress: '1400 S 700 E, Salt Lake City', openNow: true });
    expect(cvs.distanceMi).toBeCloseTo(0.75, 1);
    expect(cvs.profile).toEqual({ open24h: true, dailyGapNote: 'Closed 1:30–2 PM daily', summary: '24 hours', eveningsOrWeekends: true });
    expect(kept.find((k) => k.place.name === 'Main Street Pharmacy')!.profile.open24h).toBe(false);
  });

  it('marks the same building listed twice as a duplicate of the first listing', () => {
    const first = kept.find((k) => k.place.name === 'Walgreens')!;
    const second = kept.find((k) => k.place.name === 'Walgreens Pharmacy')!;
    expect(first.duplicateOfRef).toBeUndefined();
    expect(second.duplicateOfRef).toBe(first.ref);
    expect(kept.filter((k) => k.duplicateOfRef !== undefined)).toHaveLength(1);
  });

  it('normAddr ignores the country, suites and spacing', () => {
    expect(normAddr('350 E 400 S #2, Salt Lake City, UT 84111, USA')).toBe('350 e 400 s, salt lake city, ut 84111');
    expect(normAddr('9368 N Narcoossee Rd Ste 105,  Orlando, FL 32827, USA')).toBe('9368 n narcoossee rd, orlando, fl 32827');
    expect(normAddr('1 Main St Suite B-2, Town')).toBe(normAddr('1 Main St, Town'));
    expect(normAddr('1 Main St, Town')).not.toBe(normAddr('2 Main St, Town'));
  });

  it('places within 50 m are duplicates even when the addresses differ', () => {
    const { kept: k } = prepass(
      [
        place({ name: 'Hospital', address: '1 Main St', lat: 40.7603, lng: -111.89 }),
        place({ name: 'Hospital ER', address: '3 Side Rd', lat: 40.76, lng: -111.89 }),
        place({ name: 'Clinic', address: '9 Far Ave', lat: 40.77, lng: -111.89 }),
      ],
      { home: HOME, radiusMi: 15 },
    );
    expect(k.map((p) => [p.place.name, p.duplicateOfRef])).toEqual([
      ['Hospital', undefined],
      ['Hospital ER', 1],
      ['Clinic', undefined],
    ]);
  });

  it('uses the stored distance when a place has no coordinates, and keeps places of unknown distance last', () => {
    const { kept: k, dropped: d } = prepass(
      [place({ name: 'Unknown', distanceMi: null }), place({ name: 'Stored far', distanceMi: 40 }), place({ name: 'Stored', distanceMi: 3 })],
      { home: HOME, radiusMi: 15 },
    );
    expect(k.map((p) => [p.place.name, p.distanceMi])).toEqual([
      ['Stored', 3],
      ['Unknown', null],
    ]);
    expect(d.map((x) => x.place.name)).toEqual(['Stored far']);
  });
});

describe('buildRankPrompt', () => {
  it('uses integer refs, never place ids, and states the hours need', async () => {
    const { system, prompt } = buildRankPrompt(PHARMACY, kept);
    expect(system).toContain('This category\'s hours need is "overnight"');
    expect(system).toContain('"24-hour pharmacy"');
    for (const c of await pharmacySearch()) expect(prompt).not.toContain(c.placeId);
    expect(prompt).not.toContain('ChIJ');
    expect(prompt).toContain('#4 CVS Pharmacy\n   type: Pharmacy | 0.7 mi | 1400 S 700 E, Salt Lake City');
    expect(prompt).toContain('hours: 24 hours; Closed 1:30–2 PM daily | open24h=yes | status=OPERATIONAL');
    expect(prompt).toContain('#3 Walgreens Pharmacy (dup of #2)');
    expect(prompt).toContain('rating: none');
    expect(prompt).not.toContain('Rite Aid');
  });

  it('sends at most five reviews, each clipped to about 160 characters', () => {
    const { prompt } = buildRankPrompt(PHARMACY, kept);
    const line = prompt.split('\n').find((l) => l.includes('Lifesaver'))!;
    expect(line).not.toContain('Sixth review');
    expect(line.match(/★/g)).toHaveLength(5);
    const quotes = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
    expect(quotes).toHaveLength(5);
    expect(Math.max(...quotes.map((q) => q.length))).toBeLessThanOrEqual(160);
    expect(quotes[1]!.endsWith('…')).toBe(true);
  });
});

describe('repairRanking', () => {
  const prepared = (): Prepared[] =>
    prepass(
      [
        place({ name: 'A', distanceMi: 1 }),
        place({ name: 'B', distanceMi: 2 }),
        place({ name: 'C', distanceMi: 3 }),
        place({ name: 'D', distanceMi: 4 }),
        place({ name: 'Day only', distanceMi: 5, hours: { ...allDay(), periods: { ...allDay().periods, '0': [] } } }),
        place({ name: 'Shut', distanceMi: 6, businessStatus: 'CLOSED_TEMPORARILY' }),
      ],
      { home: HOME, radiusMi: 15 },
    ).kept;
  const out = (places: RankOutput['places']): RankOutput => ({ places });
  const row = (ref: number, verdict: PlaceRanking['verdict'], rank: number, flags: PlaceRanking['flags'] = []) => ({
    ref,
    verdict,
    rank,
    reason: `r${ref}`,
    flags,
  });

  it('drops unknown refs and keeps the first of a repeated ref', () => {
    const r = repairRanking(out([row(99, 'pick', 1), row(1, 'pick', 1), row(1, 'avoid', 2), row(2, 'backup', 3)]), prepared().slice(0, 2), 'daytime');
    expect(r.map((x) => [x.ref, x.verdict, x.rank])).toEqual([
      [1, 'pick', 1],
      [2, 'backup', 2],
    ]);
  });

  it('appends places the model left out as backups', () => {
    const r = repairRanking(out([row(1, 'pick', 1)]), prepared().slice(0, 3), 'daytime');
    expect(r.map((x) => [x.ref, x.verdict, x.rank])).toEqual([
      [1, 'pick', 1],
      [2, 'backup', 2],
      [3, 'backup', 3],
    ]);
    expect(r[1]!.reason).toBe('Not ranked by the AI.');
  });

  it('forces closed_temporarily and, for overnight categories, not_24h from the facts', () => {
    const all = prepared();
    const r = repairRanking(out(all.map((p, i) => row(p.ref, 'backup', i + 1))), all, 'overnight');
    const flagsOf = (ref: number) => r.find((x) => x.ref === ref)!.flags;
    expect(flagsOf(5)).toEqual(['not_24h']);
    expect(flagsOf(6)).toEqual(['closed_temporarily']);
    expect(flagsOf(1)).toEqual([]);
    const daytime = repairRanking(out(all.map((p, i) => row(p.ref, 'backup', i + 1))), all, 'daytime');
    expect(daytime.find((x) => x.ref === 5)!.flags).toEqual([]);
  });

  it('demotes the lowest-ranked extra picks to backup', () => {
    const r = repairRanking(
      out([row(1, 'pick', 4), row(2, 'pick', 1), row(3, 'pick', 2), row(4, 'pick', 3), row(5, 'avoid', 5)]),
      prepared().slice(0, 5),
      'daytime',
    );
    expect(r.filter((x) => x.verdict === 'pick').map((x) => x.ref)).toEqual([2, 3, 4]);
    expect(r.find((x) => x.ref === 1)!.verdict).toBe('backup');
  });

  it('renumbers ranks 1..n across pick, backup, avoid in the order returned', () => {
    const r = repairRanking(
      out([row(3, 'avoid', 1), row(1, 'backup', 7), row(2, 'pick', 9), row(4, 'pick', 2)]),
      prepared().slice(0, 4),
      'daytime',
    );
    expect(r.map((x) => [x.ref, x.verdict, x.rank])).toEqual([
      [2, 'pick', 1],
      [4, 'pick', 2],
      [1, 'backup', 3],
      [3, 'avoid', 4],
    ]);
  });

  it('clips an over-long reason to 140 characters', () => {
    const r = repairRanking(out([{ ...row(1, 'pick', 1), reason: 'x'.repeat(300) }]), prepared().slice(0, 1), 'daytime');
    expect(r[0]!.reason).toHaveLength(140);
  });
});

describe('rankWithLlm', () => {
  it('ranks the pharmacy fixture: two picks, the duplicate and the non-24h place avoided', async () => {
    const r = await rankWithLlm(fixtureProvider(LLM_DIR), MODEL, PHARMACY, kept);
    expect(r.map((x) => [x.ref, x.verdict, x.rank])).toEqual([
      [refOf('Walgreens Pharmacy'), 'pick', 1],
      [refOf('CVS Pharmacy'), 'pick', 2],
      [refOf('Walgreens'), 'avoid', 3],
      [refOf('Main Street Pharmacy'), 'avoid', 4],
      [refOf("Smith's Pharmacy"), 'avoid', 5],
      [refOf('Pharma Anabolics Shop'), 'avoid', 6],
    ]);
    expect(r.find((x) => x.ref === refOf('Walgreens'))!.flags).toEqual(['duplicate']);
    expect(r[0]!.reason).toBe('Nearest true 24-hour pharmacy, 4.1★ over 412 reviews.');
  });

  it('asks for medium effort on the given model and does not call for an empty category', async () => {
    const calls: { model: string; effort?: string; maxTokens?: number }[] = [];
    const spy: LlmProvider = {
      async generateJson(req) {
        calls.push(req);
        return req.schema.parse({ places: [] });
      },
    };
    await rankWithLlm(spy, MODEL, PHARMACY, kept);
    await rankWithLlm(spy, MODEL, PHARMACY, []);
    expect(calls).toEqual([expect.objectContaining({ model: MODEL, effort: 'medium', maxTokens: 3000 })]);
  });

  it('propagates provider errors so the caller can fall back', async () => {
    const failing: LlmProvider = {
      async generateJson() {
        throw new Error('overloaded');
      },
    };
    await expect(rankWithLlm(failing, MODEL, PHARMACY, kept)).rejects.toThrow('overloaded');
  });

  it('the fixture directory holds the pharmacy fixture', () => {
    const files = fs.readdirSync(LLM_DIR).filter((f) => f.endsWith('.json'));
    const ranking = files.map((f) => JSON.parse(fs.readFileSync(path.join(LLM_DIR, f), 'utf8')) as { prompt: string });
    expect(ranking.some((f) => f.prompt.startsWith('Category: 24-hour pharmacy'))).toBe(true);
  });
});
