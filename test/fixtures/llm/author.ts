// One-off generator: files here are hand-authored to the shape fixtureProvider replays because no LLM key was available; recording with a real key replaces them. Run: npx tsx test/fixtures/llm/author.ts
import path from 'node:path';
import { buildExtractionPrompt } from '../../../src/services/llm/extract.js';
import { buildDraftPrompt } from '../../../src/services/llm/draft.js';
import { fetchPage, fetchWebsiteText } from '../../../src/services/llm/web.js';
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

async function main(): Promise<void> {
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
}

await main();
