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

function hasAllHeadingsInOrder(body: string): boolean {
  const lines = body.split(/\r?\n/).map((l) => l.trimEnd());
  let from = 0;
  for (const h of SOP_HEADINGS) {
    const i = lines.indexOf(h, from);
    if (i < 0) return false;
    from = i + 1;
  }
  return true;
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
  if (!hasAllHeadingsInOrder(bodyMd)) {
    throw new LlmValidationError(bodyMd, null, 'draft missing required SOP headings');
  }
  return bodyMd;
}
