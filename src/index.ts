import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';
import { refreshLocations } from './jobs/refreshLocations.js';
import { startScheduler } from './jobs/scheduler.js';
import { makeExtractor } from './services/llm/extract.js';
import { createProvider } from './services/llm/index.js';
import { CallBudget } from './services/places/client.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional
}

const env = loadEnv(process.env);
const db = openDb(env.DATABASE_PATH);
runMigrations(db);
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
            places: { ...places, budget: new CallBudget(env.PLACES_CALL_CAP) },
            env,
            now: () => new Date(),
            log: console,
            ...(extract ? { extract } : {}),
          })
        : (console.info('refreshLocations skipped: GOOGLE_PLACES_API_KEY not set'),
          Promise.resolve()),
    // Task 24 replaces this stub.
    recheckProtocols: async () => {
      console.info('recheckProtocols: not implemented yet');
    },
  },
  log: console,
});

const app = createApp({ db, env, places, scheduler, ...(extract ? { extract } : {}) });

serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
console.log(`Listening on http://0.0.0.0:${env.PORT}`);
