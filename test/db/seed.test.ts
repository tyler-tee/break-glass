import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../helpers/testDb.js';
import { categories, locations } from '../../src/db/schema.js';
import { seed } from '../../src/db/seed.js';

describe('seed', () => {
  it('seed twice yields same row counts', () => {
    const db = createTestDb();
    seed(db);
    const first = {
      categories: db.select().from(categories).all().length,
      locations: db.select().from(locations).all().length,
    };
    seed(db);
    expect(db.select().from(categories).all().length).toBe(first.categories);
    expect(db.select().from(locations).all().length).toBe(first.locations);
  });

  it('approved dentists have distance_mi > 0', () => {
    const db = createTestDb();
    seed(db);
    const approved = db
      .select()
      .from(locations)
      .where(eq(locations.status, 'approved'))
      .all();
    expect(approved).toHaveLength(3);
    for (const l of approved) expect(l.distanceMi).toBeGreaterThan(0);
    const dist = (name: string) => approved.find((l) => l.name === name)!.distanceMi!;
    expect(dist('Near Dental')).toBeLessThan(dist('Mid Dental'));
    expect(dist('Mid Dental')).toBeLessThan(dist('Far Dental'));
    const near = db
      .select()
      .from(locations)
      .where(eq(locations.name, 'Near Dental'))
      .get();
    expect(near?.phone).toBe('+1 801-555-0100');
  });
});
