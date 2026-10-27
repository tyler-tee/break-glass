import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { Env } from '../env.js';
import { anthropicProvider } from './llm/anthropic.js';
import { LlmRefusalError, LlmValidationError, type LlmProvider } from './llm/provider.js';
import { BudgetExhausted, CallBudget } from './places/budget.js';
import { PLACES_BASE_URL, PlacesError, placesRequest } from './places/client.js';

export type ProbeResult = { ok: true } | { ok: false; message: string };

/** Replaces every occurrence of the key with an ellipsis so no probe message can carry it to a page or log. */
export function scrubKey(text: string, key: string | undefined): string {
  return key ? text.split(key).join('…') : text;
}

const detailOf = (body: string): string => {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === 'string') return parsed.error.message;
  } catch {
    // not JSON; fall through to the raw text
  }
  return body;
};

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Plain-words explanation of a failed Places call, safe to show: the key is scrubbed from any detail. */
export function describePlacesError(e: unknown, key: string | undefined): string {
  if (e instanceof BudgetExhausted) {
    return e.reason === 'month'
      ? "This month's Places call limit has been reached. Lookups start working again next month."
      : 'Too many Places calls in one go. Try again in a moment.';
  }
  if (!(e instanceof PlacesError)) {
    return `Something went wrong while talking to Google: ${scrubKey(errorText(e), key).slice(0, 200)}`;
  }
  if (e.status === 0) return `We couldn't reach Google. Check that the server is connected to the internet, then try again.`;
  if (e.status === 400 && /API key not valid|API_KEY_INVALID/i.test(e.body)) {
    return `Google says this key isn't valid. Copy it again from the Google Cloud console and paste the whole key.`;
  }
  if (e.status === 401 || e.status === 403) {
    return `Google rejected this key. Make sure "Places API (New)" is turned on for its project and the key isn't restricted to other APIs or websites.`;
  }
  if (e.status === 429) return 'Google says this key is over its quota right now. Try again later, or check the quota in the Google Cloud console.';
  return `Google returned an error (status ${e.status}): ${scrubKey(detailOf(e.body), key).slice(0, 200)}`;
}

/**
 * One IDs-only Text Search (the cheapest Places request) with a throwaway budget and no usage ledger, so a
 * test never counts against the monthly cap.
 */
export async function testPlacesKey(key: string, deps: { fetch: typeof fetch }): Promise<ProbeResult> {
  try {
    await placesRequest(
      `${PLACES_BASE_URL}/places:searchText`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': 'places.id' },
        body: JSON.stringify({ textQuery: 'pharmacy', pageSize: 1 }),
      },
      { fetch: deps.fetch, apiKey: key, budget: new CallBudget(1) },
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, message: describePlacesError(e, key) };
  }
}

function describeAnthropicError(e: unknown, key: string, model: string): string {
  if (e instanceof APIConnectionError) {
    return `We couldn't reach Anthropic. Check that the server is connected to the internet, then try again.`;
  }
  if (e instanceof APIError) {
    const text = scrubKey(errorText(e), key);
    if (e.status === 401) return 'Anthropic rejected this key. Copy it again from console.anthropic.com and paste the whole key.';
    if (e.status === 403) return `Anthropic says this key isn't allowed to do this. Check its workspace in the Anthropic console.`;
    if (e.status === 404) return `The model ${model} isn't available to this key.`;
    if (e.status === 429) return 'Anthropic says this key is rate limited right now. Try again in a minute.';
    if (e.status === 400 && /credit balance/i.test(text)) {
      return 'Anthropic says this account is out of credit. Add credit in the Anthropic console, then try again.';
    }
    if (typeof e.status === 'number' && e.status >= 500) return 'Anthropic is having trouble right now. Try again in a few minutes.';
    return `Anthropic returned an error: ${text.slice(0, 200)}`;
  }
  return `Something went wrong while testing the key: ${scrubKey(errorText(e), key).slice(0, 200)}`;
}

/** A minimal structured call on the extract model. Any reply at all (even one that fails validation) proves the key works. */
export async function testAnthropicKey(
  key: string,
  env: Pick<Env, 'LLM_EXTRACT_MODEL'>,
  opts: { provider?: LlmProvider } = {},
): Promise<ProbeResult> {
  try {
    const provider = opts.provider ?? anthropicProvider(new Anthropic({ apiKey: key, maxRetries: 0, timeout: 20_000 }));
    await provider.generateJson({
      model: env.LLM_EXTRACT_MODEL,
      system: 'You are a connectivity check. Reply with JSON only.',
      prompt: 'Reply with {"ok": true}.',
      schema: z.object({ ok: z.boolean() }),
      maxTokens: 16,
    });
    return { ok: true };
  } catch (e) {
    if (e instanceof LlmValidationError || e instanceof LlmRefusalError) return { ok: true };
    return { ok: false, message: describeAnthropicError(e, key, env.LLM_EXTRACT_MODEL) };
  }
}
