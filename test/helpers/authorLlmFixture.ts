import fs from 'node:fs';
import path from 'node:path';
import { llmFixtureKey } from '../../src/services/llm/provider.js';

// Writes a fixture in the exact shape fixtureProvider replays. Used where no live key exists to record from.
export function authorLlmFixture(
  dir: string,
  req: { model: string; system: string; prompt: string },
  raw: string,
): string {
  const key = llmFixtureKey(req.model, req.system, req.prompt);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...req, raw }, null, 2));
  return file;
}
