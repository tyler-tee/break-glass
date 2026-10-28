import { describe, expect, it } from 'vitest';
import { HOUSE_SYSTEMS } from '../../src/domain/types.js';
import { CATEGORY_PRESETS, HOME_CATEGORY_PRESETS, HOME_GUIDE_PRESETS } from '../../src/features/admin/setup/presets.js';

describe('home presets', () => {
  it('have slugs unique across health and home', () => {
    const slugs = [...CATEGORY_PRESETS, ...HOME_CATEGORY_PRESETS].map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('are all overnight, with only the locksmith unchecked', () => {
    expect(HOME_CATEGORY_PRESETS.every((p) => p.hoursNeed === 'overnight')).toBe(true);
    expect(HOME_CATEGORY_PRESETS.filter((p) => !p.checked).map((p) => p.slug)).toEqual(['locksmith']);
  });

  it('tag every guide with a house system or a home category slug that exists', () => {
    const known = new Set<string>([...HOUSE_SYSTEMS, ...HOME_CATEGORY_PRESETS.map((p) => p.slug)]);
    for (const g of HOME_GUIDE_PRESETS) {
      expect(g.tags.length, g.title).toBeGreaterThan(0);
      for (const t of g.tags) expect(known.has(t), `${g.title}: ${t}`).toBe(true);
      expect(g.tags.some((t) => (HOUSE_SYSTEMS as readonly string[]).includes(t)), g.title).toBe(true);
    }
  });
});
