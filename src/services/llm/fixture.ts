import fs from 'node:fs';
import path from 'node:path';
import { llmFixtureKey, parseOrReject, type LlmProvider } from './provider.js';

export class LlmFixtureMissing extends Error {
  constructor(key: string, prompt: string) {
    super(`No LLM fixture ${key} for prompt: ${prompt.slice(0, 80)}`);
    this.name = 'LlmFixtureMissing';
  }
}

export function fixtureProvider(dir: string): LlmProvider {
  return {
    async generateJson({ model, system, prompt, schema }) {
      const key = llmFixtureKey(model, system, prompt);
      const file = path.join(dir, `${key}.json`);
      if (!fs.existsSync(file)) throw new LlmFixtureMissing(key, prompt);
      const { raw } = JSON.parse(fs.readFileSync(file, 'utf8')) as { raw: string };
      return parseOrReject(schema, raw);
    },
  };
}
