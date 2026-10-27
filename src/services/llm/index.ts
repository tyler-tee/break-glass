import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../../env.js';
import { anthropicProvider } from './anthropic.js';
import type { LlmProvider } from './provider.js';

/** An explicit LLM_PROVIDER wins; unset means on exactly when an Anthropic key exists (env or saved in the DB). */
export function effectiveLlmProvider(
  envProvider: Env['LLM_PROVIDER'],
  anthropicKey: string | undefined,
): 'anthropic' | 'none' {
  return envProvider ?? (anthropicKey ? 'anthropic' : 'none');
}

export function createProvider(env: Pick<Env, 'LLM_PROVIDER' | 'LLM_API_KEY'>): LlmProvider | null {
  if (effectiveLlmProvider(env.LLM_PROVIDER, env.LLM_API_KEY) === 'none') return null;
  if (!env.LLM_API_KEY) throw new Error('LLM_API_KEY is required when LLM_PROVIDER=anthropic');
  return anthropicProvider(new Anthropic({ apiKey: env.LLM_API_KEY }));
}
