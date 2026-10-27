import Anthropic from '@anthropic-ai/sdk';
import type { Env } from '../../env.js';
import { anthropicProvider } from './anthropic.js';
import type { LlmProvider } from './provider.js';

export function createProvider(env: Pick<Env, 'LLM_PROVIDER' | 'LLM_API_KEY'>): LlmProvider | null {
  if (env.LLM_PROVIDER === 'none') return null;
  if (!env.LLM_API_KEY) throw new Error('LLM_API_KEY is required when LLM_PROVIDER=anthropic');
  return anthropicProvider(new Anthropic({ apiKey: env.LLM_API_KEY }));
}
