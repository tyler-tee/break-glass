import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db/client.js';
import { ensureSettingsRow, runMigrations } from './db/migrate.js';
import { loadDotEnvFiles, loadEnv } from './env.js';
import { recheckProtocols } from './jobs/recheckProtocols.js';
import { refreshLocations } from './jobs/refreshLocations.js';
import { startScheduler } from './jobs/scheduler.js';
import { makeExtractor } from './services/llm/extract.js';
import { createProvider } from './services/llm/index.js';
import { newPlacesBudget } from './services/places/budget.js';

loadDotEnvFiles();

const env = loadEnv(process.env);
const db = openDb(env.DATABASE_PATH);
runMigrations(db);
ensureSettingsRow(db);
const places = env.GOOGLE_PLACES_API_KEY
  ? { fetch: globalThis.fetch, apiKey: env.GOOGLE_PLACES_API_KEY }
  : undefined;

const llm = createProvider(env);
const extract = llm
  ? makeExtractor({ llm, fetch: globalThis.fetch, model: env.LLM_EXTRACT_MODEL, log: console })
  : undefined;

const scheduler = startScheduler({
  db,
  jobs: {
    refreshLocations: () =>
      places
        ? refreshLocations(db, {
            places: { ...places, budget: newPlacesBudget(db, env) },
            env,
            now: () => new Date(),
            log: console,
            ...(extract ? { extract } : {}),
          })
        : Promise.resolve({ skipped: 'GOOGLE_PLACES_API_KEY not set' }),
    recheckProtocols: () =>
      recheckProtocols(db, { fetch: globalThis.fetch, now: () => new Date(), log: console }),
  },
  log: console,
});

const app = createApp({
  db,
  env,
  places,
  scheduler,
  siteFetch: globalThis.fetch,
  ...(extract ? { extract } : {}),
  ...(llm ? { llm } : {}),
});

serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
console.log(`Listening on http://0.0.0.0:${env.PORT}`);
