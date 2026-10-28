import { readFileSync } from 'node:fs';
import Database from 'better-sqlite3';
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

  it('a fresh database has the ranking columns, hours_need and find_runs', () => {
    const db = createTestDb();
    const cols = (t: string) => db.all<{ name: string }>(sql.raw(`pragma table_info(${t})`)).map((r) => r.name);
    expect(cols('categories')).toContain('hours_need');
    expect(cols('categories')).not.toContain('target_count');
    for (const c of ['rank_verdict', 'rank_position', 'rank_reason', 'rank_flags', 'ranked_by', 'ranked_at', 'short_address', 'primary_type', 'maps_uri']) {
      expect(cols('locations')).toContain(c);
    }
    expect(cols('find_runs')).toEqual([
      'id', 'started_at', 'finished_at', 'status', 'category_ids', 'progress', 'calls_used', 'llm_calls', 'error',
    ]);
  });

  it('0004 keeps existing categories and sets hours_need from the slug', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const run = (file: string) => {
      const text = readFileSync(new URL(`../../drizzle/${file}.sql`, import.meta.url), 'utf8');
      for (const stmt of text.split('--> statement-breakpoint')) sqlite.exec(stmt);
    };
    for (const f of ['0000_keen_tusk', '0001_minor_odin', '0002_groovy_moonstone', '0003_outgoing_zuras']) run(f);
    const ins = sqlite.prepare(`insert into categories (name, slug, search_terms, target_count) values (?, ?, '["x"]', 4)`);
    for (const [name, slug] of [['Urgent care', 'urgent-care'], ['Pediatrician', 'pediatrician'], ['Dentist', 'dentist']]) ins.run(name, slug);
    sqlite
      .prepare("insert into locations (category_id, name, status, created_at, updated_at) values (1, 'Kept', 'approved', 1, 1)")
      .run();

    run('0004_wild_thunderbird');

    const rows = sqlite.prepare('select slug, search_terms, hours_need from categories order by id').all();
    expect(rows).toEqual([
      { slug: 'urgent-care', search_terms: '["x"]', hours_need: 'daytime' },
      { slug: 'pediatrician', search_terms: '["x"]', hours_need: 'daytime' },
      { slug: 'dentist', search_terms: '["x"]', hours_need: 'overnight' },
    ]);
    expect(sqlite.prepare('select name, status, rank_verdict from locations').all()).toEqual([
      { name: 'Kept', status: 'approved', rank_verdict: null },
    ]);
    expect(() => sqlite.prepare("update categories set hours_need = 'never'").run()).toThrow(/CHECK/);
    expect(() => sqlite.prepare("update locations set rank_verdict = 'best'").run()).toThrow(/CHECK/);
  });
});
