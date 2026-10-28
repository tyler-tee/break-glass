import { pathToFileURL } from 'node:url';
import { openDb, type Db } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import type { Logger } from '../domain/types.js';
import { loadDotEnvFiles, loadEnv, type Env } from '../env.js';
import { createSecretsStore } from '../features/admin/secrets.js';

/**
 * Clears the DB-held admin password so the install is unclaimed again. Session cookies are signed with a key
 * derived from the admin hash (sessionKey), so sessions from before the reset stop working whatever the source
 * of SESSION_SECRET; an app-managed secret is rotated as well. Never prints hashes or secrets.
 */
export function resetAdmin(db: Db, env: Env, log: Logger = console): 'reset' | 'env-managed' {
  const secrets = createSecretsStore(db, env);
  if (secrets.isEnvProvided('adminHash')) {
    log.info('The admin password is set by the server environment (ADMIN_PASSWORD_HASH); this command will not touch an env-provided hash.');
    log.info('To change it, edit ADMIN_PASSWORD_HASH in your server configuration and restart.');
    return 'env-managed';
  }
  secrets.clearAdminHash();
  if (!secrets.isEnvProvided('sessionSecret')) secrets.rotateSessionSecret();
  log.info('Admin password cleared and all existing admin sessions signed out.');
  log.info('Next: open http://<server>:3000/setup in a browser, then run `docker compose logs app` to find the new setup code.');
  return 'reset';
}

function main(): void {
  loadDotEnvFiles();
  const env = loadEnv(process.env);
  const db = openDb(env.DATABASE_PATH);
  try {
    runMigrations(db);
    resetAdmin(db, env);
  } finally {
    (db as unknown as { $client: { close(): void } }).$client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (e) {
    console.error(`reset-admin failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
