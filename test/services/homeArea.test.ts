import path from 'node:path';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../../src/db/client.js';
import { findRuns, locations, protocols } from '../../src/db/schema.js';
import { RANK_FLAGS } from '../../src/domain/ranking.js';
import { createCategory } from '../../src/features/categories/repo.js';
import { runFindRun } from '../../src/features/locations/findAndRank.js';
import { savePicks } from '../../src/features/locations/picks.js';
import { getLocation, listRefreshable } from '../../src/features/locations/repo.js';
import { extractWebsiteNotes } from '../../src/features/locations/websiteNotes.js';
import { createProtocol, getVersion } from '../../src/features/protocols/repo.js';
import {
  PLACEHOLDER_MESSAGE,
  createManualDraft,
  generateDraft,
  hasTemplatePlaceholders,
  manualTemplate,
  publishVersion,
  saveAndPublish,
  submitForReview,
} from '../../src/features/protocols/service.js';
import { SOP_HEADINGS, assertSopHeadings, buildDraftPrompt } from '../../src/services/llm/draft.js';
import { applyExtraction, buildExtractionPrompt, makeExtractor, type Extractor } from '../../src/services/llm/extract.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import type { LlmProvider } from '../../src/services/llm/provider.js';
import {
  buildRankPrompt,
  normPhone,
  prepass,
  rankPlaceFromCandidate,
  rankWithLlm,
  type RankPlace,
} from '../../src/services/llm/rankPlaces.js';
import { CallBudget, richSearch } from '../../src/services/places/client.js';
import type { PlaceCandidate } from '../../src/services/places/types.js';
import { HOME_DRAFT_SOURCES, HOME_DRAFT_TITLE, HOME_EXTRACT_URL, HOME_RANK_CATEGORY } from '../fixtures/llm/homeInputs.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';
import { recordingFetch } from '../helpers/recordingFetch.js';
import { createTestDb } from '../helpers/testDb.js';

const PLACES_DIR = path.resolve(import.meta.dirname, '../fixtures/places');
const LLM_DIR = path.resolve(import.meta.dirname, '../fixtures/llm');
const WEB_DIR = path.resolve(import.meta.dirname, '../fixtures/web');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const HOME = { lat: 40.7608, lng: -111.891 };
const NOW = new Date('2026-10-28T16:00:00Z');
const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let db: Db;
beforeEach(() => {
  db = createTestDb();
});

async function electricians(): Promise<PlaceCandidate[]> {
  const places = { fetch: recordingFetch(PLACES_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(10) };
  return richSearch('emergency electrician', { center: HOME, radiusMi: 15 }, places);
}
const nameOf = (k: { place: RankPlace }) => k.place.name;
const keptHome = async () =>
  prepass((await electricians()).map(rankPlaceFromCandidate), { home: HOME, radiusMi: 15, dedupePhone: true }).kept;

describe('home draft', () => {
  const homeProtocol = () => {
    const p = createProtocol(db, { slug: 'gas-smell', title: HOME_DRAFT_TITLE, tags: [] });
    db.update(protocols).set({ area: 'home' }).where(eq(protocols.id, p.id)).run();
    return p;
  };

  it('generateDraft uses the home prompt for a home protocol, replayed from a fixture', async () => {
    const p = homeProtocol();
    const inner = fixtureProvider(LLM_DIR);
    const spy = vi.fn(inner.generateJson.bind(inner));
    const v = await generateDraft(db, p.id, HOME_DRAFT_SOURCES, {
      llm: { generateJson: spy } as LlmProvider,
      fetch: fakeSiteFetch(WEB_DIR),
      model: 'claude-opus-5-5',
      allowlist: [],
      now: () => NOW,
      lookup: publicLookup,
      log: logger(),
    });
    expect(spy.mock.calls[0]![0].system).toContain('household emergency SOP');
    expect(v.status).toBe('draft');
    expect(v.bodyMd).toContain('see House facts');
    expect(() => assertSopHeadings(v.bodyMd)).not.toThrow();
  });

  it('the home system prompt carries the same headings lines as health, and a different intro', () => {
    const home = buildDraftPrompt('T', [], 'home').system.split('\n');
    const health = buildDraftPrompt('T', [], 'health').system.split('\n');
    for (const h of SOP_HEADINGS) expect(home).toContain(`- ${h}`);
    expect(home.slice(1, 6)).toEqual(health.slice(1, 6));
    expect(home[0]).not.toBe(health[0]);
    expect(home).toContain('Cite only facts found in the sources.');
    expect(home).toContain('Do not add a Sources section; the app renders it.');
  });

  it('a home protocol gets the home manual template, built from the household number', () => {
    const v = createManualDraft(db, homeProtocol().id, NOW);
    expect(v.bodyMd).toBe(manualTemplate('911', 'home'));
    expect(v.bodyMd).toContain('Call 911 or leave the house if ...');
    expect(v.bodyMd).not.toContain('go to the ER');
    expect(() => assertSopHeadings(v.bodyMd)).not.toThrow();
  });

  it('the home placeholder blocks submit, publish and save-and-publish', () => {
    const v = createManualDraft(db, homeProtocol().id, NOW);
    expect(hasTemplatePlaceholders(v.bodyMd)).toBe(true);
    expect(() => submitForReview(db, v.id, NOW)).toThrow(PLACEHOLDER_MESSAGE);
    expect(() => publishVersion(db, v.id, NOW)).toThrow(PLACEHOLDER_MESSAGE);
    expect(() => saveAndPublish(db, v.id, v.bodyMd, NOW)).toThrow(PLACEHOLDER_MESSAGE);
    expect(getVersion(db, v.id)!.status).toBe('draft');
  });

  it('placeholder detection catches both variants and lets real text through', () => {
    expect(hasTemplatePlaceholders('Call 112 or leave the house if ...')).toBe(true);
    expect(hasTemplatePlaceholders('Call 112 or go to the ER if ...')).toBe(true);
    expect(hasTemplatePlaceholders('Call 911 or leave the house if you smell gas.')).toBe(false);
  });
});

describe('home ranking', () => {
  it('normPhone keeps the last 10 digits and ignores short numbers', () => {
    expect(normPhone('(801) 555-0603')).toBe('8015550603');
    expect(normPhone('+1 801-555-0603')).toBe('8015550603');
    expect(normPhone('555-0603')).toBeNull();
    expect(normPhone(null)).toBeNull();
  });

  it('prepass matches the same phone at different addresses only when dedupePhone is on', async () => {
    const places = (await electricians()).map(rankPlaceFromCandidate);
    const off = prepass(places, { home: HOME, radiusMi: 15 }).kept;
    expect(off.filter((k) => k.duplicateOfRef !== undefined)).toEqual([]);

    const on = prepass(places, { home: HOME, radiusMi: 15, dedupePhone: true }).kept;
    const dups = on.filter((k) => k.duplicateOfRef !== undefined);
    expect(dups.map(nameOf)).toEqual(['Spark Line 24/7 Emergency Electrician']);
    expect(on.find((k) => k.ref === dups[0]!.duplicateOfRef)!.place.name).toBe('Spark Line Electric');
  });

  it('keeps a place with no location (distance unknown) instead of dropping it or crashing', async () => {
    const candidates = await electricians();
    expect(candidates.find((c) => c.placeId === 'ChIJnoloc')).toMatchObject({ lat: null, lng: null });
    const { kept, dropped } = prepass(candidates.map(rankPlaceFromCandidate), { home: HOME, radiusMi: 15, dedupePhone: true });
    const k = kept.find((x) => x.place.name === 'Canyon Peak Electric')!;
    expect(k.distanceMi).toBeNull();
    expect(dropped.map(nameOf)).not.toContain('Canyon Peak Electric');
    // Unknown distance sorts last.
    expect(kept.at(-1)!.place.name).toBe('Canyon Peak Electric');
    expect(buildRankPrompt(HOME_RANK_CATEGORY, kept).prompt).toContain('distance unknown');
  });

  it('the fixture has the patterns the home prompt is about', async () => {
    const kept = await keptHome();
    const by = (n: string) => kept.find((k) => k.place.name === n)!;
    expect(by('Volt Crew Electric')).toMatchObject({ rating: 5, ratingCount: 17 });
    expect(by('Volt Crew Electric').distanceMi!).toBeCloseTo(1.6, 1);
    expect(by('Beehive Electric Services')).toMatchObject({ rating: 4.7, ratingCount: 15200 });
    expect(by('Beehive Electric Services').distanceMi!).toBeGreaterThan(14);
    expect(by('Handyman and Electric').place.primaryType).toBe('General contractor');
  });

  it('home prompts list each phone; health prompts do not', async () => {
    const kept = await keptHome();
    const home = buildRankPrompt(HOME_RANK_CATEGORY, kept);
    expect(home.prompt).toContain('   phone: (801) 555-0603');
    expect(home.prompt).toMatch(/\n {3}rating: 5 \(17\)\n {3}phone: \(801\) 555-0601/);
    expect(home.system).toContain('The category is "Emergency electrician".');
    expect(home.system).toContain('hours need is "overnight".');
    const health = buildRankPrompt({ name: HOME_RANK_CATEGORY.name, hoursNeed: 'overnight' }, kept);
    expect(health.prompt).not.toContain('phone:');
    expect(health.system).not.toBe(home.system);
  });

  it('every flag the home prompt names is a real RANK_FLAG', async () => {
    const { system } = buildRankPrompt(HOME_RANK_CATEGORY, await keptHome());
    const named = ['not_24h', 'few_reviews', 'poor_reviews', 'wrong_kind', 'referral_listing', 'duplicate', 'far', 'check_hours'];
    for (const f of named) {
      expect(system).toMatch(new RegExp(`\\b${f}\\b`));
      expect(RANK_FLAGS).toContain(f);
    }
  });

  it('ranks a home category through its fixture', async () => {
    const kept = await keptHome();
    const ranking = await rankWithLlm(fixtureProvider(LLM_DIR), 'claude-opus-5-5', HOME_RANK_CATEGORY, kept);
    const name = (ref: number) => kept.find((k) => k.ref === ref)!.place.name;
    expect(ranking.filter((r) => r.verdict === 'pick').map((r) => name(r.ref))).toEqual([
      'Beehive Electric Services',
      'Spark Line Electric',
    ]);
    const handyman = ranking.find((r) => name(r.ref) === 'Handyman and Electric')!;
    expect(handyman.verdict).toBe('avoid');
    // not_24h is forced by repairRanking: weekday hours on an overnight category.
    expect(handyman.flags).toEqual(['wrong_kind', 'check_hours', 'not_24h']);
  });

  it('a find run for a home category dedupes by phone, ranks by the LLM and stores a place with no location', async () => {
    const cat = createCategory(db, { name: HOME_RANK_CATEGORY.name, searchTerms: ['emergency electrician'], area: 'home' });
    const id = db
      .insert(findRuns)
      .values({ startedAt: NOW, status: 'running', categoryIds: [cat.id], progress: { [String(cat.id)]: { state: 'waiting' } } })
      .returning()
      .get().id;
    const result = await runFindRun(db, id, {
      places: { fetch: recordingFetch(PLACES_DIR, 'replay'), apiKey: 'k', budget: new CallBudget(5) },
      llm: fixtureProvider(LLM_DIR),
      model: 'claude-opus-5-5',
      now: () => NOW,
      log: logger(),
    });
    expect(result.progress[String(cat.id)]).toEqual({ state: 'done', found: 6 });
    const rows = db.select().from(locations).where(eq(locations.categoryId, cat.id)).all();
    expect(rows.every((r) => r.rankedBy === 'llm')).toBe(true);
    expect(rows.find((r) => r.name === 'Canyon Peak Electric')).toMatchObject({ lat: null, lng: null, distanceMi: null });
    expect(rows.find((r) => r.name === 'Beehive Electric Services')).toMatchObject({ rankVerdict: 'pick', rankPosition: 1 });
  });
});

describe('home extraction', () => {
  const extractor = (llm: LlmProvider = fixtureProvider(LLM_DIR)) =>
    makeExtractor({ llm, fetch: fakeSiteFetch(WEB_DIR), model: 'claude-haiku-5-5', log: logger(), lookup: publicLookup });
  const homePlace = () => {
    const cat = createCategory(db, { name: 'Emergency plumber', searchTerms: ['plumber'], area: 'home' });
    const row = db
      .insert(locations)
      .values({ categoryId: cat.id, name: 'Rapid Rooter', status: 'candidate', website: HOME_EXTRACT_URL, createdAt: NOW, updatedAt: NOW })
      .returning()
      .get();
    return { cat, row };
  };

  it('the home prompt tells the model to leave walk-ins and insurance null', () => {
    const { system } = buildExtractionPrompt([{ url: 'https://a.example/', text: 'x' }], 'home');
    expect(system).toContain('walkIns: always return null.');
    expect(system).toContain('insuranceNotes: always return null.');
    expect(system).toContain('home-trade businesses');
  });

  it('extracts a home trade through its fixture; the extractor takes the area from its options', async () => {
    const out = await extractor()(HOME_EXTRACT_URL, { area: 'home' });
    expect(out.extraction!.afterHoursNotes.value).toContain('$150 after-hours trip fee');
  });

  it('without the home area the same page has no fixture, because the health prompt differs', async () => {
    const out = await extractor()(HOME_EXTRACT_URL);
    expect(out.extraction).toBeNull();
  });

  it('applyExtraction never stores walk-ins or insurance for home, even if the model returned them', async () => {
    const { extraction } = await extractor()(HOME_EXTRACT_URL, { area: 'home' });
    expect(extraction!.walkIns.value).toBe(true); // the fixture plays a model that ignored the prompt
    const tracked = {
      name: 'N',
      address: null,
      phone: null,
      website: null,
      hours: null,
      businessStatus: null,
      rating: null,
      ratingCount: null,
      afterHoursNotes: null,
      walkIns: null,
      insuranceNotes: null,
    };
    expect(applyExtraction(tracked, extraction, 'home')).toMatchObject({
      walkIns: null,
      insuranceNotes: null,
      afterHoursNotes: extraction!.afterHoursNotes.value,
    });
    expect(applyExtraction(tracked, extraction)).toMatchObject({ walkIns: true });
  });

  it('extractWebsiteNotes passes the category area and stores only after-hours notes for a home place', async () => {
    const { row } = homePlace();
    const extract = vi.fn<Extractor>(extractor());
    const n = await extractWebsiteNotes(db, [row.id], { extract, log: logger(), now: () => NOW });
    expect(n).toBe(1);
    expect(extract).toHaveBeenCalledWith(HOME_EXTRACT_URL, { area: 'home' });
    expect(getLocation(db, row.id)).toMatchObject({ walkIns: null, insuranceNotes: null });
    expect(getLocation(db, row.id)!.afterHoursNotes).toContain('24/7 emergency');
  });

  it('savePicks hands the home area to the extractor for new picks', async () => {
    const { cat, row } = homePlace();
    const extract = vi.fn<Extractor>(extractor());
    savePicks(db, cat.id, [row.id], NOW, { extract });
    await vi.waitFor(() => expect(getLocation(db, row.id)!.afterHoursNotes).not.toBeNull());
    expect(extract).toHaveBeenCalledWith(HOME_EXTRACT_URL, { area: 'home' });
    expect(getLocation(db, row.id)).toMatchObject({ walkIns: null, insuranceNotes: null });
  });

  it('listRefreshable returns each place with its category area', () => {
    const home = createCategory(db, { name: 'Emergency plumber', searchTerms: ['plumber'], area: 'home' });
    const health = createCategory(db, { name: 'Pharmacy', searchTerms: ['pharmacy'] });
    for (const [c, name] of [
      [home, 'H'],
      [health, 'P'],
    ] as const) {
      db.insert(locations)
        .values({ categoryId: c.id, name, placeId: `id-${name}`, status: 'approved', createdAt: NOW, updatedAt: NOW })
        .run();
    }
    expect(listRefreshable(db).map((r) => [r.name, r.area])).toEqual([
      ['H', 'home'],
      ['P', 'health'],
    ]);
  });
});
