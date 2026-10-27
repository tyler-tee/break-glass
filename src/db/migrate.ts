import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Db } from './client.js';

// Works from src/db (tsx) and dist/db (build): two levels up is the repo root.
const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

export function runMigrations(db: Db): void {
  migrate(db, { migrationsFolder });
}
