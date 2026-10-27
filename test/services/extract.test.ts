import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { TrackedFields } from '../../src/domain/types.js';
import { fixtureProvider } from '../../src/services/llm/fixture.js';
import { applyExtraction, makeExtractor, type Extraction } from '../../src/services/llm/extract.js';
import { LlmRefusalError, type LlmProvider } from '../../src/services/llm/provider.js';
import { fakeSiteFetch } from '../helpers/fakeSiteFetch.js';

const LLM_DIR = path.resolve(import.meta.dirname, '../fixtures/llm');
const WEB_DIR = path.resolve(import.meta.dirname, '../fixtures/web');
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
const MODEL = 'claude-haiku-5-5';

const logger = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });
const extractor = (over: { llm?: LlmProvider; fetch?: typeof fetch; log?: ReturnType<typeof logger> } = {}) => {
  const log = over.log ?? logger();
  return makeExtractor({
    llm: over.llm ?? fixtureProvider(LLM_DIR),
    fetch: over.fetch ?? fakeSiteFetch(WEB_DIR),
    model: MODEL,
    log,
    lookup: publicLookup,
  });
};

const snapshot = (): string =>
  fs
    .readdirSync(LLM_DIR)
    .sort()
    .map((f) => `${f}:${fs.statSync(path.join(LLM_DIR, f)).mtimeMs}`)
    .join(',');
let before = '';
beforeAll(() => {
  before = snapshot();
});

const tracked = (over: Partial<TrackedFields> = {}): TrackedFields => ({
  name: 'N',
  address: null,
  phone: null,
  website: null,
  hours: null,
  businessStatus: null,
  rating: null,
  ratingCount: null,
  afterHoursNotes: 'old after',
  walkIns: true,
  insuranceNotes: 'old ins',
  ...over,
});

describe('makeExtractor', () => {
  it('asks the LLM for 4000 max tokens', async () => {
    const inner = fixtureProvider(LLM_DIR);
    const spy = vi.fn(inner.generateJson.bind(inner));
    await extractor({ llm: { generateJson: spy } as LlmProvider })('https://near-dental.example/');
    expect(spy.mock.calls[0]![0].maxTokens).toBe(4000);
  });

  it('populates notes from fixture pages', async () => {
    const e = await extractor()('https://near-dental.example/');
    expect(e.extraction?.afterHoursNotes.value).toContain('on-call');
    expect(e.extraction?.insuranceNotes.value).toContain('Delta Dental');
  });

  it('returns null fields for unstated items', async () => {
    const e = await extractor()('https://near-dental.example/');
    expect(e.extraction?.walkIns.value).toBeNull();
  });

  it('malformed LLM fixture → extractor returns null and logs', async () => {
    const log = logger();
    expect((await extractor({ log })('https://bad-dental.example/')).extraction).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('not json'));
  });

  it('refusal → null and logs', async () => {
    const log = logger();
    const llm: LlmProvider = {
      generateJson: async () => {
        throw new LlmRefusalError('cyber');
      },
    };
    expect((await extractor({ llm, log })('https://near-dental.example/')).extraction).toBeNull();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('cyber'));
  });

  it('unexpected provider error → null and error log', async () => {
    const log = logger();
    const llm: LlmProvider = {
      generateJson: async () => {
        throw new Error('boom');
      },
    };
    expect((await extractor({ llm, log })('https://near-dental.example/')).extraction).toBeNull();
    expect(log.error).toHaveBeenCalled();
  });

  it('no website pages → null without calling llm', async () => {
    const generateJson = vi.fn();
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const out = await extractor({ llm: { generateJson } as LlmProvider, fetch: failing })('https://near-dental.example/');
    expect(out).toEqual({ extraction: null, pageHash: null });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('returns a stable page hash and skips the LLM when it matches skipIfHash', async () => {
    const first = await extractor()('https://near-dental.example/');
    expect(first.pageHash).toMatch(/^[0-9a-f]{64}$/);
    const generateJson = vi.fn();
    const llm = { generateJson } as LlmProvider;
    const again = await extractor({ llm })('https://near-dental.example/', { skipIfHash: first.pageHash });
    expect(again).toEqual({ extraction: null, pageHash: first.pageHash });
    expect(generateJson).not.toHaveBeenCalled();
  });

  it('fixture directory is not written during replay', () => {
    expect(snapshot()).toBe(before);
  });
});

describe('applyExtraction', () => {
  it('applyExtraction null leaves tracked unchanged', () => {
    const t = tracked();
    const out = applyExtraction(t, null);
    expect(out).toEqual(t);
    expect(out).not.toBe(t);
  });

  it('applyExtraction overwrites notes including null', () => {
    const e: Extraction = {
      afterHoursNotes: { value: 'new after', sourceUrl: 'https://x.example/' },
      walkIns: { value: null, sourceUrl: null },
      insuranceNotes: { value: null, sourceUrl: null },
    };
    expect(applyExtraction(tracked(), e)).toEqual(
      tracked({ afterHoursNotes: 'new after', walkIns: null, insuranceNotes: null }),
    );
  });
});
