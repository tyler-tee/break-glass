import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Area, Logger, TrackedFields } from '../../domain/types.js';
import { LlmRefusalError, LlmValidationError, type LlmProvider } from './provider.js';
import { fetchWebsiteText, type LookupFn } from './web.js';

const Field = z.object({ value: z.string().nullable(), sourceUrl: z.string().nullable() });

export const ExtractionSchema = z.object({
  afterHoursNotes: Field,
  walkIns: z.object({ value: z.boolean().nullable(), sourceUrl: z.string().nullable() }),
  insuranceNotes: Field,
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type ExtractResult = { extraction: Extraction | null; pageHash: string | null };
// When skipIfHash equals the fetched page hash, the LLM is not called and extraction is null.
export type Extractor = (website: string, opts?: { skipIfHash?: string | null; area?: Area }) => Promise<ExtractResult>;

export function hashPages(pages: { url: string; text: string }[]): string {
  const h = createHash('sha256');
  for (const p of pages) h.update(`${p.url}
${p.text}
`);
  return h.digest('hex');
}

const MAX_PROMPT_CHARS = 60_000;

const HEALTH_SYSTEM = [
  'You are extracting facts for a family emergency directory.',
  'Answer only from the page text given; never infer or invent.',
  'For each field return null unless the page explicitly states it.',
  'sourceUrl must be one of the given page URLs, or null.',
  'Keep notes under 200 characters, plain text.',
  'walkIns is true only if walk-ins are explicitly accepted, and false only if walk-ins are explicitly not accepted.',
].join('\n');

const HOME_SYSTEM = [
  'You are extracting facts for a family emergency directory of home-trade businesses (plumbers, electricians, HVAC, water damage, locksmiths).',
  'Answer only from the page text given; never infer or invent.',
  'For each field return null unless the page explicitly states it.',
  'sourceUrl must be one of the given page URLs, or null.',
  'Keep notes under 200 characters, plain text.',
  'afterHoursNotes: whether the business offers 24/7, emergency, or after-hours service, plus any after-hours, trip, or emergency-call fees, exactly as stated. Null if the page does not say.',
  'walkIns: always return null.',
  'insuranceNotes: always return null.',
].join('\n');

const SYSTEM_BY_AREA: Record<Area, string> = { health: HEALTH_SYSTEM, home: HOME_SYSTEM };

export function buildExtractionPrompt(
  pages: { url: string; text: string }[],
  area: Area = 'health',
): { system: string; prompt: string } {
  let prompt = '';
  for (const page of pages) {
    const block = `${prompt === '' ? '' : '\n\n'}### ${page.url}\n${page.text}`;
    const room = MAX_PROMPT_CHARS - prompt.length;
    if (block.length > room) {
      prompt += block.slice(0, room);
      break;
    }
    prompt += block;
  }
  return { system: SYSTEM_BY_AREA[area], prompt };
}

export function makeExtractor(deps: {
  llm: LlmProvider;
  fetch: typeof fetch;
  model: string;
  log: Logger;
  lookup?: LookupFn;
}): Extractor {
  const { llm, model, log } = deps;
  return async (website, opts) => {
    let pageHash: string | null = null;
    try {
      const pages = await fetchWebsiteText(website, {
        fetch: deps.fetch,
        log,
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
      if (pages.length === 0) return { extraction: null, pageHash };
      pageHash = hashPages(pages);
      if (opts?.skipIfHash != null && opts.skipIfHash === pageHash) return { extraction: null, pageHash };
      const { system, prompt } = buildExtractionPrompt(pages, opts?.area ?? 'health');
      const result = await llm.generateJson({
        model,
        system,
        prompt,
        schema: ExtractionSchema,
        maxTokens: 4000,
        effort: 'low',
      });
      log.info(
        `extraction sources for ${website}: ${JSON.stringify({
          afterHoursNotes: result.afterHoursNotes.sourceUrl,
          walkIns: result.walkIns.sourceUrl,
          insuranceNotes: result.insuranceNotes.sourceUrl,
        })}`,
      );
      return { extraction: result, pageHash };
    } catch (e) {
      if (e instanceof LlmValidationError) {
        log.warn(`extraction for ${website} failed validation: ${e.raw.slice(0, 200)}`);
      } else if (e instanceof LlmRefusalError) {
        log.warn(`extraction for ${website} refused (${e.category ?? 'no category'})`);
      } else {
        log.error(`extraction for ${website} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return { extraction: null, pageHash };
    }
  };
}

/** Home trades have no walk-ins or insurance notes, so those are never stored for them, whatever the model said. */
export function applyExtraction(tracked: TrackedFields, e: Extraction | null, area: Area = 'health'): TrackedFields {
  if (e === null) return { ...tracked };
  return {
    ...tracked,
    afterHoursNotes: e.afterHoursNotes.value,
    walkIns: area === 'home' ? null : e.walkIns.value,
    insuranceNotes: area === 'home' ? null : e.insuranceNotes.value,
  };
}
