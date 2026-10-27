import { openDb, type Db } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { settings } from '../../src/db/schema.js';

export function createTestDb(): Db {
  const db = openDb(':memory:');
  runMigrations(db);
  db.insert(settings)
    .values({
      id: 1,
      homeLabel: 'Home',
      homeLat: 40.7608,
      homeLng: -111.891,
      defaultRadiusMi: 15,
      homeTz: 'America/Denver',
      locationRefreshCron: '0 3 * * 0',
      protocolRefreshCron: '0 4 1 * *',
    })
    .run();
  return db;
}
