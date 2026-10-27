import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.js';
import { settings } from './schema.js';

// Works from src/db (tsx) and dist/db (build): two levels up is the repo root.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}

/** A fresh database has no settings row; create the singleton with column defaults (home unset until the admin geocodes it). */
export function ensureSettingsRow(db: Db): void {
  db.insert(settings).values({ id: 1 }).onConflictDoNothing().run();
}
