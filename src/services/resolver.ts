import type { Db } from '../db/client.js';
import type { Logger } from '../domain/types.js';
import type { Env } from '../env.js';
import type { SecretsStore } from '../features/admin/secrets.js';
import { makeExtractor, type Extractor } from './llm/extract.js';
import { createProvider, effectiveLlmProvider } from './llm/index.js';
import type { LlmProvider } from './llm/provider.js';

export type PlacesDep = { fetch: typeof fetch; apiKey: string };

/** Builds places/llm/extract from the current effective keys, so a key saved at runtime is used on the next call. */
export type ServiceResolver = {
  places(): PlacesDep | undefined;
  llm(): LlmProvider | undefined;
  extract(): Extractor | undefined;
};

type Memo<K, V> = { key: K; value: V } | undefined;

export function makeServiceResolver(
  _db: Db,
  env: Env,
  secrets: SecretsStore,
  opts: { fetch?: typeof fetch; log?: Logger } = {},
): ServiceResolver {
  const fetchFn = (): typeof fetch => opts.fetch ?? globalThis.fetch;
  const log = opts.log ?? console;
  let places: Memo<string, PlacesDep>;
  let llm: Memo<string, LlmProvider>;
  let extract: Memo<LlmProvider, Extractor>;

  const resolveLlm = (): LlmProvider | undefined => {
    const key = secrets.getAnthropicKey();
    // LLM_PROVIDER=anthropic with no key anywhere leaves the LLM off rather than failing the request.
    if (!key || effectiveLlmProvider(env.LLM_PROVIDER, key) === 'none') return undefined;
    if (llm?.key !== key) {
      const provider = createProvider({ LLM_PROVIDER: 'anthropic', LLM_API_KEY: key });
      if (!provider) return undefined;
      llm = { key, value: provider };
    }
    return llm.value;
  };

  return {
    places: () => {
      const key = secrets.getPlacesKey();
      if (!key) return undefined;
      if (places?.key !== key) places = { key, value: { fetch: fetchFn(), apiKey: key } };
      return places.value;
    },
    llm: resolveLlm,
    extract: () => {
      const current = resolveLlm();
      if (!current) return undefined;
      if (extract?.key !== current) {
        extract = {
          key: current,
          value: makeExtractor({ llm: current, fetch: fetchFn(), model: env.LLM_EXTRACT_MODEL, log }),
        };
      }
      return extract.value;
    },
  };
}

type ServiceDeps = {
  resolve?: ServiceResolver;
  places?: PlacesDep;
  llm?: LlmProvider;
  extract?: Extractor;
};

// The resolver wins; static deps remain for tests (and callers) that inject fakes.
export const placesOf = (deps: ServiceDeps): PlacesDep | undefined => deps.resolve?.places() ?? deps.places;
export const llmOf = (deps: ServiceDeps): LlmProvider | undefined => deps.resolve?.llm() ?? deps.llm;
export const extractOf = (deps: ServiceDeps): Extractor | undefined => deps.resolve?.extract() ?? deps.extract;
