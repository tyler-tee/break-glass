import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import {
  LlmRefusalError,
  LlmValidationError,
  parseOrReject,
} from '../../src/services/llm/provider.js';
import { LlmFixtureMissing, fixtureProvider } from '../../src/services/llm/fixture.js';
import { anthropicProvider } from '../../src/services/llm/anthropic.js';
import { createProvider } from '../../src/services/llm/index.js';
import { authorLlmFixture } from '../helpers/authorLlmFixture.js';

const schema = z.object({ answer: z.number() });
const req = { model: 'm', system: 's', prompt: 'p', schema };

function mockClient(response: unknown) {
  const create = vi.fn(async (_params: unknown) => response);
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

describe('parseOrReject', () => {
  it('returns typed value for valid JSON', () => {
    expect(parseOrReject(schema, '{"answer":4}')).toEqual({ answer: 4 });
  });

  it('throws LlmValidationError with raw text for schema miss', () => {
    const raw = '{"answer":"four"}';
    try {
      parseOrReject(schema, raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LlmValidationError);
      expect((e as LlmValidationError).raw).toBe(raw);
    }
  });

  it('throws LlmValidationError for non-JSON text and truncates message', () => {
    const raw = 'x'.repeat(500);
    try {
      parseOrReject(schema, raw);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(LlmValidationError);
      expect((e as LlmValidationError).raw).toBe(raw);
      expect((e as Error).message).not.toContain('x'.repeat(201));
    }
  });
});

describe('fixtureProvider', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-fixture-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('replays by prompt hash', async () => {
    authorLlmFixture(dir, { model: 'm', system: 's', prompt: 'p' }, '{"answer":7}');
    const provider = fixtureProvider(dir);
    await expect(provider.generateJson(req)).resolves.toEqual({ answer: 7 });
    await expect(provider.generateJson({ ...req, prompt: 'other' })).rejects.toBeInstanceOf(
      LlmFixtureMissing,
    );
  });

  it('rejects malformed fixture through the same gate', async () => {
    authorLlmFixture(dir, { model: 'm', system: 's', prompt: 'p' }, 'not json');
    await expect(fixtureProvider(dir).generateJson(req)).rejects.toBeInstanceOf(LlmValidationError);
  });
});

describe('anthropicProvider', () => {
  it('maps refusal stop_reason to LlmRefusalError', async () => {
    const { client } = mockClient({
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
      content: [{ type: 'text', text: '{"answ' }],
    });
    const err = await anthropicProvider(client).generateJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRefusalError);
    expect((err as LlmRefusalError).category).toBe('cyber');
  });

  it('returns validated value from text blocks', async () => {
    const { client } = mockClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"answer":4}' }],
    });
    await expect(anthropicProvider(client).generateJson(req)).resolves.toEqual({ answer: 4 });
  });

  it('malformed model text becomes LlmValidationError with raw text', async () => {
    const { client } = mockClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"nope":' }],
    });
    const err = await anthropicProvider(client).generateJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect((err as LlmValidationError).raw).toBe('{"nope":');
  });

  it('truncated output at max_tokens is LlmValidationError', async () => {
    const { client } = mockClient({
      stop_reason: 'max_tokens',
      content: [{ type: 'text', text: '{"answer":' }],
    });
    const err = await anthropicProvider(client).generateJson(req).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmValidationError);
    expect((err as LlmValidationError).raw).toBe('{"answer":');
    expect((err as Error).message).toContain('output truncated at max_tokens');
  });

  it('passes model, system, prompt, max_tokens and effort', async () => {
    const { client, create } = mockClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"answer":1}' }],
    });
    await anthropicProvider(client).generateJson({ ...req, maxTokens: 123, effort: 'high' });
    const arg = create.mock.calls[0]![0] as Record<string, any>;
    expect(arg.model).toBe('m');
    expect(arg.system).toBe('s');
    expect(arg.messages).toEqual([{ role: 'user', content: 'p' }]);
    expect(arg.max_tokens).toBe(123);
    expect(arg.output_config.effort).toBe('high');
    expect(arg.output_config.format.type).toBe('json_schema');
    expect(arg.output_config.format).not.toHaveProperty('parse');
    expect(arg).not.toHaveProperty('tool_choice');
    expect(arg).not.toHaveProperty('thinking');
    expect(arg).not.toHaveProperty('temperature');
  });
});

describe('createProvider', () => {
  it('returns null for none and throws without key for anthropic', () => {
    expect(createProvider({ LLM_PROVIDER: 'none', LLM_API_KEY: undefined })).toBeNull();
    expect(() => createProvider({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: undefined })).toThrow(
      /LLM_API_KEY/,
    );
    expect(createProvider({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: 'k' })).not.toBeNull();
  });

  it('with LLM_PROVIDER unset, is on exactly when a key is present', () => {
    expect(createProvider({ LLM_PROVIDER: undefined, LLM_API_KEY: undefined })).toBeNull();
    expect(createProvider({ LLM_PROVIDER: undefined, LLM_API_KEY: 'k' })).not.toBeNull();
    expect(createProvider({ LLM_PROVIDER: 'none', LLM_API_KEY: 'k' })).toBeNull();
  });
});
