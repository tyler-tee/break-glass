import { z } from 'zod';
import type { Logger, TrackedFields } from '../../domain/types.js';
import { LlmRefusalError, LlmValidationError, type LlmProvider } from './provider.js';
import { fetchWebsiteText, type LookupFn } from './web.js';

const Field = z.object({ value: z.string().nullable(), sourceUrl: z.string().nullable() });

export const ExtractionSchema = z.object({
  afterHoursNotes: Field,
  walkIns: z.object({ value: z.boolean().nullable(), sourceUrl: z.string().nullable() }),
  insuranceNotes: Field,
});

export type Extraction = z.infer<typeof ExtractionSchema>;
export type Extractor = (website: string) => Promise<Extraction | null>;

const MAX_PROMPT_CHARS = 60_000;

const SYSTEM = [
  'You are extracting facts for a family emergency directory.',
  'Answer only from the page text given; never infer or invent.',
  'For each field return null unless the page explicitly states it.',
  'sourceUrl must be one of the given page URLs, or null.',
  'Keep notes under 200 characters, plain text.',
  'walkIns is true only if walk-ins are explicitly accepted, and false only if walk-ins are explicitly not accepted.',
].join('\n');

export function buildExtractionPrompt(pages: { url: string; text: string }[]): { system: string; prompt: string } {
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
  return { system: SYSTEM, prompt };
}

export function makeExtractor(deps: {
  llm: LlmProvider;
  fetch: typeof fetch;
  model: string;
  log: Logger;
  lookup?: LookupFn;
}): Extractor {
  const { llm, model, log } = deps;
  return async (website) => {
    try {
      const pages = await fetchWebsiteText(website, {
        fetch: deps.fetch,
        log,
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
      if (pages.length === 0) return null;
      const { system, prompt } = buildExtractionPrompt(pages);
      const result = await llm.generateJson({
        model,
        system,
        prompt,
        schema: ExtractionSchema,
        maxTokens: 1024,
        effort: 'low',
      });
      log.info(
        `extraction sources for ${website}: ${JSON.stringify({
          afterHoursNotes: result.afterHoursNotes.sourceUrl,
          walkIns: result.walkIns.sourceUrl,
          insuranceNotes: result.insuranceNotes.sourceUrl,
        })}`,
      );
      return result;
    } catch (e) {
      if (e instanceof LlmValidationError) {
        log.warn(`extraction for ${website} failed validation: ${e.raw.slice(0, 200)}`);
      } else if (e instanceof LlmRefusalError) {
        log.warn(`extraction for ${website} refused (${e.category ?? 'no category'})`);
      } else {
        log.error(`extraction for ${website} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return null;
    }
  };
}

export function applyExtraction(tracked: TrackedFields, e: Extraction | null): TrackedFields {
  if (e === null) return { ...tracked };
  return {
    ...tracked,
    afterHoursNotes: e.afterHoursNotes.value,
    walkIns: e.walkIns.value,
    insuranceNotes: e.insuranceNotes.value,
  };
}
