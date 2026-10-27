import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { createTestDb } from '../helpers/testDb.js';
import { protocols, protocolVersions } from '../../src/db/schema.js';

describe('migrations', () => {
  it('creates all tables and the one_published index', () => {
    const db = createTestDb();
    const names = db
      .all<{ name: string }>(sql`select name from sqlite_master where type in ('table','index')`)
      .map((r) => r.name);
    for (const t of [
      'settings', 'categories', 'locations', 'location_snapshots',
      'location_changes', 'protocols', 'protocol_versions', 'protocol_sources',
    ]) {
      expect(names).toContain(t);
    }
    expect(names).toContain('one_published');
  });

  it('rejects a second published version for the same protocol', () => {
    const db = createTestDb();
    const [p] = db.insert(protocols).values({ slug: 'cpr', title: 'CPR' }).returning().all();
    const now = new Date();
    db.insert(protocolVersions)
      .values({ protocolId: p!.id, version: 1, status: 'published', bodyMd: 'a', createdAt: now })
      .run();
    expect(() =>
      db.insert(protocolVersions)
        .values({ protocolId: p!.id, version: 2, status: 'published', bodyMd: 'b', createdAt: now })
        .run(),
    ).toThrow(/UNIQUE/);
  });
});
