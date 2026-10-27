import { z } from 'zod';
import { LlmValidationError, type LlmProvider } from './provider.js';

export const DraftSchema = z.object({ bodyMd: z.string().min(1) });

export const SOP_HEADINGS = ['## Title and scope', '## Steps', '## Escalation criteria', '## Do not'] as const;

const MAX_PROMPT_CHARS = 80_000;

const SYSTEM = [
  'You write a short household first-aid SOP in markdown for a family, using only the sources provided.',
  'The body must contain exactly these four headings, in this order, and nothing else at heading level 2:',
  ...SOP_HEADINGS.map((h) => `- ${h}`),
  'Steps are numbered, short, and imperative.',
  'Escalation criteria say when to call 911 or go to the ER.',
  'The "Do not" section lists common mistakes.',
  'Cite only facts found in the sources.',
  'Do not add a Sources section; the app renders it.',
  'Make no medical claims beyond the sources.',
].join('\n');

type DraftSource = { url: string; title: string | null; text: string };

export function buildDraftPrompt(title: string, sources: DraftSource[]): { system: string; prompt: string } {
  let body = '';
  for (const s of sources) {
    const block = `${body === '' ? '' : '\n\n'}### ${s.url} — ${s.title ?? ''}\n${s.text}`;
    const room = MAX_PROMPT_CHARS - body.length;
    if (block.length > room) {
      body += block.slice(0, room);
      break;
    }
    body += block;
  }
  return { system: SYSTEM, prompt: `Protocol title: ${title}\n\nSources:\n\n${body}` };
}

function level2Headings(body: string): string[] {
  return body
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => /^##\s/.test(l));
}

export function assertSopHeadings(body: string): void {
  const found = level2Headings(body);
  if (found.length === SOP_HEADINGS.length && SOP_HEADINGS.every((h, i) => found[i] === h)) return;
  const missing = SOP_HEADINGS.some((h) => !found.includes(h));
  throw new LlmValidationError(
    body,
    null,
    missing
      ? 'draft missing required SOP headings'
      : `draft has unexpected level-2 headings: ${found.join(' | ')}`,
  );
}

export async function draftProtocol(
  llm: LlmProvider,
  model: string,
  input: { title: string; sources: DraftSource[] },
): Promise<string> {
  const { system, prompt } = buildDraftPrompt(input.title, input.sources);
  const { bodyMd } = await llm.generateJson({
    model,
    system,
    prompt,
    schema: DraftSchema,
    maxTokens: 4096,
    effort: 'high',
  });
  assertSopHeadings(bodyMd);
  return bodyMd;
}
