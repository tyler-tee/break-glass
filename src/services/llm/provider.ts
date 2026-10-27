import { createHash } from 'node:crypto';
import type { z } from 'zod';

export interface LlmProvider {
  generateJson<T>(req: {
    model: string;
    system: string;
    prompt: string;
    schema: z.ZodType<T>;
    maxTokens?: number;
    effort?: 'low' | 'medium' | 'high';
  }): Promise<T>;
}

export class LlmValidationError extends Error {
  constructor(
    public raw: string,
    public issues: unknown,
  ) {
    super(`LLM output failed validation: ${raw.slice(0, 200)}`);
    this.name = 'LlmValidationError';
  }
}

export class LlmRefusalError extends Error {
  constructor(public category: string | null) {
    super(`LLM refused the request${category ? ` (${category})` : ''}`);
    this.name = 'LlmRefusalError';
  }
}

// Single gate every provider path goes through: JSON parse, then schema check.
export function parseOrReject<T>(schema: z.ZodType<T>, rawText: string): T {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (err) {
    throw new LlmValidationError(rawText, err instanceof Error ? err.message : String(err));
  }
  const result = schema.safeParse(json);
  if (!result.success) throw new LlmValidationError(rawText, result.error.issues);
  return result.data;
}

export function llmFixtureKey(model: string, system: string, prompt: string): string {
  return createHash('sha1').update(`${model}\n${system}\n${prompt}`).digest('hex');
}
