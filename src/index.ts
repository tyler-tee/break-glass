import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { openDb } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { loadEnv } from './env.js';

try {
  process.loadEnvFile('.env');
} catch {
  // .env is optional
}

const env = loadEnv(process.env);
const db = openDb(env.DATABASE_PATH);
runMigrations(db);
const app = createApp({ db, env });

serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' });
console.log(`Listening on http://0.0.0.0:${env.PORT}`);
