import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DraftSchema, buildDraftPrompt } from '../../../src/services/llm/draft.js';
import { ExtractionSchema, buildExtractionPrompt } from '../../../src/services/llm/extract.js';
import { fixtureProvider } from '../../../src/services/llm/fixture.js';
import { llmFixtureKey } from '../../../src/services/llm/provider.js';
import { RankSchema, buildRankPrompt, prepass, rankPlaceFromCandidate } from '../../../src/services/llm/rankPlaces.js';
import { fetchPage, fetchWebsiteText } from '../../../src/services/llm/web.js';
import { CallBudget, richSearch } from '../../../src/services/places/client.js';
import type { PlaceCandidate } from '../../../src/services/places/types.js';
import { fakeSiteFetch } from '../../helpers/fakeSiteFetch.js';
import { recordingFetch } from '../../helpers/recordingFetch.js';

// The health prompts are part of the fixture keys: any byte that changes in them orphans a committed fixture.
// These rebuild the three committed health fixtures exactly as test/fixtures/llm/author.ts does, with the area omitted.
const LLM_DIR = path.resolve(import.meta.dirname, '../../fixtures/llm');
const WEB_DIR = path.resolve(import.meta.dirname, '../../fixtures/web');
const PLACES_DIR = path.resolve(import.meta.dirname, '../../fixtures/places');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const EXTRACT_MODEL = 'claude-haiku-5-5';
const DRAFT_MODEL = 'claude-opus-5-5';
const HOME = { lat: 40.7608, lng: -111.891 };
const PHARMACY = { name: '24-hour pharmacy', hoursNeed: 'overnight' as const };

const keyOf = (model: string, p: { system: string; prompt: string }) => llmFixtureKey(model, p.system, p.prompt);
const committed = (key: string) => fs.existsSync(path.join(LLM_DIR, `${key}.json`));

async function draftInputs() {
  const sources = [];
  for (const url of ['https://redcross.example/choking', 'https://nhs.example/choking']) {
    const page = await fetchPage(url, { fetch: fakeSiteFetch(WEB_DIR), lookup: publicLookup });
    sources.push(page!);
  }
  return sources;
}

async function rankInputs() {
  const places = { fetch: recordingFetch(PLACES_DIR, 'replay'), apiKey: 'test', budget: new CallBudget(10) };
  const merged = new Map<string, PlaceCandidate>();
  for (const term of ['24 hour pharmacy', 'late night pharmacy']) {
    for (const c of await richSearch(term, { center: HOME, radiusMi: 15 }, places)) {
      if (!merged.has(c.placeId)) merged.set(c.placeId, c);
    }
  }
  return prepass([...merged.values()].map(rankPlaceFromCandidate), { home: HOME, radiusMi: 15 }).kept;
}

describe('health prompts are byte-identical to the committed fixtures', () => {
  it('draft', async () => {
    const built = buildDraftPrompt('Choking (adult)', await draftInputs());
    expect(committed(keyOf(DRAFT_MODEL, built))).toBe(true);
    const out = await fixtureProvider(LLM_DIR).generateJson({
      model: DRAFT_MODEL,
      ...built,
      schema: DraftSchema,
      maxTokens: 1,
    });
    expect(out.bodyMd).toContain('## Title and scope');
  });

  it('rank', async () => {
    const built = buildRankPrompt(PHARMACY, await rankInputs());
    expect(committed(keyOf(DRAFT_MODEL, built))).toBe(true);
    const out = await fixtureProvider(LLM_DIR).generateJson({
      model: DRAFT_MODEL,
      ...built,
      schema: RankSchema,
      maxTokens: 1,
    });
    expect(out.places.length).toBeGreaterThan(0);
  });

  it('rank prompt never mentions phone numbers for health', async () => {
    expect(buildRankPrompt(PHARMACY, await rankInputs()).prompt).not.toContain('phone:');
  });

  it('extract', async () => {
    const pages = await fetchWebsiteText('https://near-dental.example/', { fetch: fakeSiteFetch(WEB_DIR), lookup: publicLookup });
    const built = buildExtractionPrompt(pages);
    expect(committed(keyOf(EXTRACT_MODEL, built))).toBe(true);
    const out = await fixtureProvider(LLM_DIR).generateJson({
      model: EXTRACT_MODEL,
      ...built,
      schema: ExtractionSchema,
      maxTokens: 1,
    });
    expect(out.afterHoursNotes.value).toContain('on-call dentist');
  });
});

describe('area defaults', () => {
  it('draft: omitted and "health" give the same bytes; home differs in the system only', async () => {
    const sources = await draftInputs();
    const omitted = buildDraftPrompt('T', sources);
    expect(buildDraftPrompt('T', sources, 'health')).toEqual(omitted);
    const home = buildDraftPrompt('T', sources, 'home');
    expect(home.system).not.toBe(omitted.system);
    expect(home.prompt).toBe(omitted.prompt);
  });

  it('rank: omitted and "health" give the same bytes; home differs', async () => {
    const kept = await rankInputs();
    const omitted = buildRankPrompt(PHARMACY, kept);
    expect(buildRankPrompt({ ...PHARMACY, area: 'health' }, kept)).toEqual(omitted);
    const home = buildRankPrompt({ ...PHARMACY, area: 'home' }, kept);
    expect(home.system).not.toBe(omitted.system);
    expect(home.prompt).not.toBe(omitted.prompt);
  });

  it('extract: omitted and "health" give the same bytes; home differs in the system only', () => {
    const pages = [{ url: 'https://a.example/', text: 'hello' }];
    const omitted = buildExtractionPrompt(pages);
    expect(buildExtractionPrompt(pages, 'health')).toEqual(omitted);
    const home = buildExtractionPrompt(pages, 'home');
    expect(home.system).not.toBe(omitted.system);
    expect(home.prompt).toBe(omitted.prompt);
  });
});
