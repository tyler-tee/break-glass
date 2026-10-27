import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db/client.js';
import { ensureSettingsRow, runMigrations } from './db/migrate.js';
import { loadDotEnvFiles, loadEnv } from './env.js';
import { recheckProtocols } from './jobs/recheckProtocols.js';
import { refreshLocations } from './jobs/refreshLocations.js';
import { startScheduler } from './jobs/scheduler.js';
import { installState } from './features/admin/install.js';
import { createSecretsStore } from './features/admin/secrets.js';
import { createSetupCodeManager } from './features/admin/setupCode.js';
import { newPlacesBudget } from './services/places/budget.js';
import { makeServiceResolver } from './services/resolver.js';
import { createShutdown } from './shutdown.js';

loadDotEnvFiles();

const env = loadEnv(process.env);
const db = openDb(env.DATABASE_PATH);
runMigrations(db);
ensureSettingsRow(db);
const secrets = createSecretsStore(db, env);
secrets.getSessionSecret(); // without SESSION_SECRET in env, generate and persist one on first boot
const resolve = makeServiceResolver(db, env, secrets, { fetch: globalThis.fetch, log: console });
if (env.LLM_PROVIDER === 'anthropic' && !secrets.getAnthropicKey()) {
  console.warn('LLM_PROVIDER=anthropic but no Anthropic key is set; drafting and extraction stay off until one is saved');
}

const scheduler = startScheduler({
  db,
  jobs: {
    // Resolve services at run time so a key saved in the admin UI is used by the next scheduled run.
    refreshLocations: () => {
      const places = resolve.places();
      if (!places) return Promise.resolve({ skipped: 'GOOGLE_PLACES_API_KEY not set' });
      const extract = resolve.extract();
      return refreshLocations(db, {
        places: { ...places, budget: newPlacesBudget(db, env) },
        env,
        now: () => new Date(),
        log: console,
        ...(extract ? { extract } : {}),
      });
    },
    recheckProtocols: () =>
      recheckProtocols(db, { fetch: globalThis.fetch, now: () => new Date(), log: console }),
  },
  log: console,
});

// One manager for the whole process, shared with the app, so the code printed here is the one /setup accepts.
const setupCode = createSetupCodeManager({ log: console });
const app = createApp({
  db,
  env,
  secrets,
  resolve,
  scheduler,
  siteFetch: globalThis.fetch,
  setupCode,
});

const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
console.log(`Listening on http://0.0.0.0:${env.PORT}`);
// Unclaimed (no admin password in env or DB): print the one-time setup code. Never prints the password or hashes.
if (installState({ db, secrets }) === 'unclaimed') setupCode.ensure();

const shutdown = createShutdown({
  stopScheduler: () => scheduler.stop(),
  closeServer: () =>
    new Promise<void>((resolve) => {
      const http = server as unknown as Server;
      http.close(() => resolve());
      http.closeAllConnections();
    }),
  closeDb: () => (db as unknown as { $client: { close(): void } }).$client.close(),
  log: console,
  exit: (code) => process.exit(code),
});
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
