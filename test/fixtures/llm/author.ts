// One-off generator: files here are hand-authored to the shape fixtureProvider replays because no LLM key was available; recording with a real key replaces them. Run: npx tsx test/fixtures/llm/author.ts
import path from 'node:path';
import { buildExtractionPrompt } from '../../../src/services/llm/extract.js';
import { buildDraftPrompt } from '../../../src/services/llm/draft.js';
import { fetchPage, fetchWebsiteText } from '../../../src/services/llm/web.js';
import { buildRankPrompt, prepass, rankPlaceFromCandidate } from '../../../src/services/llm/rankPlaces.js';
import { CallBudget, richSearch } from '../../../src/services/places/client.js';
import type { PlaceCandidate } from '../../../src/services/places/types.js';
import { HOME_DRAFT_SOURCES, HOME_DRAFT_TITLE, HOME_EXTRACT_URL, HOME_RANK_CATEGORY } from './homeInputs.js';
import { recordingFetch } from '../../helpers/recordingFetch.js';
import { authorLlmFixture } from '../../helpers/authorLlmFixture.js';
import { fakeSiteFetch } from '../../helpers/fakeSiteFetch.js';

const LLM_DIR = import.meta.dirname;
const WEB_FIXTURES = path.resolve(import.meta.dirname, '../web');
const MODEL = 'claude-haiku-5-5';
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function author(url: string, raw: string): Promise<void> {
  const pages = await fetchWebsiteText(url, { fetch: fakeSiteFetch(WEB_FIXTURES), lookup: publicLookup });
  const { system, prompt } = buildExtractionPrompt(pages);
  console.log(authorLlmFixture(LLM_DIR, { model: MODEL, system, prompt }, raw));
}

const DRAFT_MODEL = 'claude-opus-5-5';
const CHOKING_BODY = [
  '## Title and scope',
  'Choking (adult): what to do when an adult cannot cough, speak or breathe because something blocks the airway.',
  '',
  '## Steps',
  '1. Encourage the person to keep coughing if they can cough forcefully.',
  '2. If they cannot cough, speak or breathe, give 5 back blows between the shoulder blades.',
  '3. If that fails, give 5 abdominal thrusts, pressing inward and upward above the navel.',
  '4. Alternate 5 back blows and 5 abdominal thrusts until the object comes out.',
  '5. Call 911 if the person becomes unresponsive.',
  '',
  '## Escalation criteria',
  '- Call 911 if the person becomes unresponsive or loses consciousness.',
  '- Call 911 if the object has not come out after three cycles.',
  '',
  '## Do not',
  '- Do not give abdominal thrusts to a person who is pregnant or to an infant.',
  '- Do not leave the person alone while they are choking.',
].join('\n');

async function authorDraft(): Promise<void> {
  const fetchImpl = fakeSiteFetch(WEB_FIXTURES);
  const sources = [];
  for (const url of ['https://redcross.example/choking', 'https://nhs.example/choking']) {
    const page = await fetchPage(url, { fetch: fetchImpl, lookup: publicLookup });
    if (!page) throw new Error(`fixture page missing: ${url}`);
    sources.push(page);
  }
  const { system, prompt } = buildDraftPrompt('Choking (adult)', sources);
  console.log(
    authorLlmFixture(LLM_DIR, { model: DRAFT_MODEL, system, prompt }, JSON.stringify({ bodyMd: CHOKING_BODY })),
  );
}

// The 24-hour pharmacy ranking, built from the replayed Places fixtures exactly as a find run builds it.
export const RANK_HOME = { lat: 40.7608, lng: -111.891 };
async function authorRanking(): Promise<void> {
  const places = {
    fetch: recordingFetch(path.resolve(import.meta.dirname, '../places'), 'replay'),
    apiKey: 'test',
    budget: new CallBudget(10),
  };
  const merged = new Map<string, PlaceCandidate>();
  for (const term of ['24 hour pharmacy', 'late night pharmacy']) {
    for (const c of await richSearch(term, { center: RANK_HOME, radiusMi: 15 }, places)) {
      if (!merged.has(c.placeId)) merged.set(c.placeId, c);
    }
  }
  const { kept } = prepass([...merged.values()].map(rankPlaceFromCandidate), { home: RANK_HOME, radiusMi: 15 });
  const { system, prompt } = buildRankPrompt({ name: '24-hour pharmacy', hoursNeed: 'overnight' }, kept);
  const ref = (name: string) => kept.find((k) => k.place.name === name)!.ref;
  const raw = JSON.stringify({
    places: [
      { ref: ref('Walgreens Pharmacy'), verdict: 'pick', rank: 1, reason: 'Nearest true 24-hour pharmacy, 4.1★ over 412 reviews.', flags: [] },
      { ref: ref('CVS Pharmacy'), verdict: 'pick', rank: 2, reason: 'Open 24 hours apart from a 1:30–2 PM pharmacist break; mixed reviews.', flags: [] },
      { ref: ref('Walgreens'), verdict: 'avoid', rank: 3, reason: 'Same store as the Walgreens Pharmacy listing.', flags: ['duplicate'] },
      { ref: ref('Main Street Pharmacy'), verdict: 'avoid', rank: 4, reason: 'Well rated but closes at 9 PM.', flags: ['not_24h'] },
      { ref: ref("Smith's Pharmacy"), verdict: 'avoid', rank: 5, reason: 'Google lists it as temporarily closed.', flags: ['closed_temporarily'] },
      { ref: ref('Pharma Anabolics Shop'), verdict: 'avoid', rank: 6, reason: 'Not a pharmacy, and no reviews.', flags: ['wrong_kind', 'few_reviews'] },
    ],
  });
  console.log(authorLlmFixture(LLM_DIR, { model: DRAFT_MODEL, system, prompt }, raw));
}

// Home-area fixtures. Run alone (leaving the health fixtures untouched) with: npx tsx test/fixtures/llm/author.ts home
const GAS_BODY = [
  '## Title and scope',
  'Gas smell or CO alarm: what a family member or sitter does when the home may have a gas leak or carbon monoxide.',
  '',
  '## Steps',
  '1. Leave the house right away and take everyone, including pets.',
  '2. From outside, call 911 or the gas utility emergency line.',
  '3. For the location of the gas shutoff and the utility number, see House facts.',
  '4. Stay outside until the gas utility or fire department says it is safe.',
  '',
  '## Escalation criteria',
  '- Call 911 for any gas smell, CO alarm, or anyone feeling dizzy or sick.',
  '- Get everyone out first; call from outside.',
  '',
  '## Do not',
  '- Do not turn lights or appliances on or off.',
  '- Do not go back inside before the utility or fire department says it is safe.',
  '- Do not try to repair gas pipes or appliances.',
].join('\n');

async function authorHomeDraft(): Promise<void> {
  const fetchImpl = fakeSiteFetch(WEB_FIXTURES);
  const sources = [];
  for (const url of HOME_DRAFT_SOURCES) {
    const page = await fetchPage(url, { fetch: fetchImpl, lookup: publicLookup });
    if (!page) throw new Error(`fixture page missing: ${url}`);
    sources.push(page);
  }
  const { system, prompt } = buildDraftPrompt(HOME_DRAFT_TITLE, sources, 'home');
  console.log(authorLlmFixture(LLM_DIR, { model: DRAFT_MODEL, system, prompt }, JSON.stringify({ bodyMd: GAS_BODY })));
}

async function authorHomeRanking(): Promise<void> {
  const places = {
    fetch: recordingFetch(path.resolve(import.meta.dirname, '../places'), 'replay'),
    apiKey: 'test',
    budget: new CallBudget(10),
  };
  const merged = new Map<string, PlaceCandidate>();
  for (const c of await richSearch('emergency electrician', { center: RANK_HOME, radiusMi: 15 }, places)) {
    if (!merged.has(c.placeId)) merged.set(c.placeId, c);
  }
  const { kept } = prepass([...merged.values()].map(rankPlaceFromCandidate), {
    home: RANK_HOME,
    radiusMi: 15,
    dedupePhone: true,
  });
  const { system, prompt } = buildRankPrompt(HOME_RANK_CATEGORY, kept);
  const ref = (name: string) => kept.find((k) => k.place.name === name)!.ref;
  const raw = JSON.stringify({
    places: [
      { ref: ref('Beehive Electric Services'), verdict: 'pick', rank: 1, reason: 'Sent a tech at 2am on a Sunday in reviews, 4.7 over 15k.', flags: ['far'] },
      { ref: ref('Spark Line Electric'), verdict: 'pick', rank: 2, reason: 'Only one to answer on a Sunday per reviews, 4.6 over 540.', flags: [] },
      { ref: ref('Canyon Peak Electric'), verdict: 'backup', rank: 3, reason: 'Decent 4.4 over 96 but no callout evidence; no map location.', flags: [] },
      { ref: ref('Volt Crew Electric'), verdict: 'backup', rank: 4, reason: 'Nearest, but 5.0 is only 17 reviews.', flags: ['few_reviews'] },
      { ref: ref('Handyman and Electric'), verdict: 'avoid', rank: 5, reason: 'Weekday hours and reviews say no after-hours callouts.', flags: ['wrong_kind', 'check_hours'] },
      { ref: ref('Spark Line 24/7 Emergency Electrician'), verdict: 'avoid', rank: 6, reason: 'Same phone as Spark Line Electric.', flags: ['duplicate', 'referral_listing'] },
    ],
  });
  console.log(authorLlmFixture(LLM_DIR, { model: DRAFT_MODEL, system, prompt }, raw));
}

async function authorHomeExtraction(): Promise<void> {
  const pages = await fetchWebsiteText(HOME_EXTRACT_URL, { fetch: fakeSiteFetch(WEB_FIXTURES), lookup: publicLookup });
  const { system, prompt } = buildExtractionPrompt(pages, 'home');
  // The page mentions walk-ins and insurance; the home prompt says to ignore them, and applying the result drops them anyway.
  const raw = JSON.stringify({
    afterHoursNotes: {
      value: '24/7 emergency service including weekends and holidays; $150 after-hours trip fee.',
      sourceUrl: 'https://rapid-rooter.example/emergency',
    },
    walkIns: { value: true, sourceUrl: 'https://rapid-rooter.example/emergency' },
    insuranceNotes: { value: 'Accepts all major insurance plans.', sourceUrl: 'https://rapid-rooter.example/emergency' },
  });
  console.log(authorLlmFixture(LLM_DIR, { model: MODEL, system, prompt }, raw));
}

async function main(): Promise<void> {
  if (process.argv[2] !== 'home') await mainHealth();
  await authorHomeDraft();
  await authorHomeRanking();
  await authorHomeExtraction();
}

async function mainHealth(): Promise<void> {
  await author(
    'https://near-dental.example/',
    JSON.stringify({
      afterHoursNotes: {
        value: 'After hours call (801) 555-0100 for the on-call dentist.',
        sourceUrl: 'https://near-dental.example/hours',
      },
      walkIns: { value: null, sourceUrl: null },
      insuranceNotes: {
        value: 'Accepts Delta Dental and Cigna; does not accept Medicaid.',
        sourceUrl: 'https://near-dental.example/insurance',
      },
    }),
  );
  await author('https://bad-dental.example/', 'not json at all');
  await authorDraft();
  await authorRanking();
}

await main();
