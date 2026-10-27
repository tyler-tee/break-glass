// One-off generator: files here are hand-authored to the shape fixtureProvider replays because no LLM key was available; recording with a real key replaces them. Run: npx tsx test/fixtures/llm/author.ts
import path from 'node:path';
import { buildExtractionPrompt } from '../../../src/services/llm/extract.js';
import { fetchWebsiteText } from '../../../src/services/llm/web.js';
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
}

await main();
