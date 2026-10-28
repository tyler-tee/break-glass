import { z } from 'zod';
import type { Area } from '../../domain/types.js';
import { LlmValidationError, type LlmProvider } from './provider.js';

export const DraftSchema = z.object({ bodyMd: z.string().min(1) });

export const SOP_HEADINGS = ['## Title and scope', '## Steps', '## Escalation criteria', '## Do not'] as const;

const MAX_PROMPT_CHARS = 80_000;

const HEALTH_SYSTEM = [
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

const HOME_SYSTEM = [
  'You write a short household emergency SOP in markdown for a family, so a spouse, teen, or sitter can act safely when the homeowner is away, using only the sources provided.',
  'The body must contain exactly these four headings, in this order, and nothing else at heading level 2:',
  ...SOP_HEADINGS.map((h) => `- ${h}`),
  'Steps are numbered, short, and imperative.',
  "Put people's safety first: get everyone to safety, then stop the source at a shutoff or breaker, then call for help, then limit damage.",
  'For a gas smell or CO alarm, tell the reader to leave first and call 911 or the gas utility from outside; do not touch light switches, appliances, or the gas meter unless the sources say to.',
  'Never tell the reader to repair gas, electrical, or HVAC equipment. Go no further than closing a shutoff, resetting a breaker once, or cleanup.',
  "Refer to the household's own shutoffs, valves, and numbers generically (for example \"see House facts\"); never guess where they are.",
  'Escalation criteria say when to call 911 or the gas or utility emergency line and when to get everyone out.',
  'The "Do not" section lists common mistakes.',
  'Cite only facts found in the sources.',
  'Do not add a Sources section; the app renders it.',
].join('\n');

const SYSTEM_BY_AREA: Record<Area, string> = { health: HEALTH_SYSTEM, home: HOME_SYSTEM };

type DraftSource = { url: string; title: string | null; text: string };

export function buildDraftPrompt(
  title: string,
  sources: DraftSource[],
  area: Area = 'health',
): { system: string; prompt: string } {
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
  return { system: SYSTEM_BY_AREA[area], prompt: `Protocol title: ${title}\n\nSources:\n\n${body}` };
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
  input: { title: string; sources: DraftSource[]; area?: Area },
): Promise<string> {
  const { system, prompt } = buildDraftPrompt(input.title, input.sources, input.area ?? 'health');
  const { bodyMd } = await llm.generateJson({
    model,
    system,
    prompt,
    schema: DraftSchema,
    maxTokens: 16000,
    effort: 'high',
  });
  assertSopHeadings(bodyMd);
  return bodyMd;
}
