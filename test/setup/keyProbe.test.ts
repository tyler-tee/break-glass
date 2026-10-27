import { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { loadEnv } from '../../src/env.js';
import { LlmValidationError, type LlmProvider } from '../../src/services/llm/provider.js';
import { testAnthropicKey, testPlacesKey } from '../../src/services/keyProbe.js';

const PLACES_KEY = 'AIzaSyPROBE-test-key-1234';
const ANTHROPIC_KEY = 'sk-ant-api03-probe-test-key-9876';

const jsonFetch = (status: number, body: unknown) =>
  vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );

describe('testPlacesKey', () => {
  // Cap safety (no placesUsage writes) is pinned at the route level in wizard.test.ts.
  it('ok on a 200 IDs-only searchText', async () => {
    const fetch = jsonFetch(200, { places: [{ id: 'ChIJ-probe' }] });
    const result = await testPlacesKey(PLACES_KEY, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe('https://places.googleapis.com/v1/places:searchText');
    const headers = init!.headers as Record<string, string>;
    expect(headers['X-Goog-Api-Key']).toBe(PLACES_KEY);
    // IDs-only field mask: the cheapest Text Search request.
    expect(headers['X-Goog-FieldMask']).toBe('places.id');
  });

  it('403 is reported in plain words as rejected by Google, without the key', async () => {
    const fetch = jsonFetch(403, { error: { code: 403, message: `Requests from key ${PLACES_KEY} are blocked.` } });
    const result = await testPlacesKey(PLACES_KEY, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Google rejected this key/);
    expect(result.message).not.toContain(PLACES_KEY);
    expect(result.message).not.toContain('PROBE-test');
  });

  it('400 "API key not valid" says the key is not valid', async () => {
    const fetch = jsonFetch(400, { error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } });
    const result = await testPlacesKey(PLACES_KEY, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/isn't valid/) });
  });

  it('network failure says Google could not be reached and scrubs the key from the error', async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError(`fetch failed for header value ${PLACES_KEY}`);
    });
    const result = await testPlacesKey(PLACES_KEY, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/couldn't reach Google/i);
    expect(result.message).not.toContain(PLACES_KEY);
  });

  it('an unexpected status includes a scrubbed detail', async () => {
    const fetch = jsonFetch(500, `boom ${PLACES_KEY} boom`);
    const result = await testPlacesKey(PLACES_KEY, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('500');
    expect(result.message).not.toContain(PLACES_KEY);
  });
});

describe('testAnthropicKey', () => {
  const env = loadEnv({ LLM_EXTRACT_MODEL: 'claude-test-extract' });
  const fakeProvider = (impl: LlmProvider['generateJson']) => ({ generateJson: vi.fn(impl) }) as unknown as LlmProvider & {
    generateJson: ReturnType<typeof vi.fn>;
  };

  it('ok on success, using the extract model and a 16-token cap', async () => {
    const provider = fakeProvider((async () => ({ ok: true })) as LlmProvider['generateJson']);
    const result = await testAnthropicKey(ANTHROPIC_KEY, env, { provider });
    expect(result).toEqual({ ok: true });
    expect(provider.generateJson).toHaveBeenCalledTimes(1);
    const req = provider.generateJson.mock.calls[0]![0] as { model: string; maxTokens: number; schema: unknown };
    expect(req.model).toBe('claude-test-extract');
    expect(req.maxTokens).toBe(16);
  });

  it('a reply that fails validation still proves the key works', async () => {
    const provider = fakeProvider((async () => {
      throw new LlmValidationError('{"ok":', null, 'output truncated at max_tokens');
    }) as LlmProvider['generateJson']);
    expect(await testAnthropicKey(ANTHROPIC_KEY, env, { provider })).toEqual({ ok: true });
  });

  it('401 is reported as rejected, without the key', async () => {
    const provider = fakeProvider((async () => {
      throw new APIError(401, { type: 'error' }, `invalid x-api-key ${ANTHROPIC_KEY}`, new Headers());
    }) as LlmProvider['generateJson']);
    const result = await testAnthropicKey(ANTHROPIC_KEY, env, { provider });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toMatch(/Anthropic rejected this key/);
    expect(result.message).not.toContain(ANTHROPIC_KEY);
  });

  it('connection failure says Anthropic could not be reached', async () => {
    const provider = fakeProvider((async () => {
      throw new APIConnectionError({ message: 'Connection error.' });
    }) as LlmProvider['generateJson']);
    const result = await testAnthropicKey(ANTHROPIC_KEY, env, { provider });
    expect(result).toEqual({ ok: false, message: expect.stringMatching(/couldn't reach Anthropic/i) });
  });

  it('any other error is scrubbed of the key', async () => {
    const provider = fakeProvider((async () => {
      throw new Error(`weird failure mentioning ${ANTHROPIC_KEY} twice ${ANTHROPIC_KEY}`);
    }) as LlmProvider['generateJson']);
    const result = await testAnthropicKey(ANTHROPIC_KEY, env, { provider });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('weird failure');
    expect(result.message).not.toContain(ANTHROPIC_KEY);
  });
});
