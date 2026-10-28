import { slugify } from '../../../domain/slug.js';
import type { HoursNeed } from '../../../domain/types.js';

export type CategoryPreset = {
  name: string;
  slug: string;
  searchTerms: readonly string[];
  hoursNeed: HoursNeed;
};

const preset = (name: string, searchTerms: readonly string[], hoursNeed: HoursNeed): CategoryPreset => ({
  name,
  slug: slugify(name),
  searchTerms,
  hoursNeed,
});

/** The kinds of places most households want on hand; the wizard offers these as checkboxes. */
export const CATEGORY_PRESETS: readonly CategoryPreset[] = [
  preset('Urgent care', ['urgent care', 'walk-in clinic'], 'daytime'),
  preset('Emergency room', ['emergency room', 'hospital emergency department'], 'overnight'),
  preset("Children's ER", ["children's emergency room", 'pediatric emergency room', "children's hospital"], 'overnight'),
  preset('24-hour pharmacy', ['24 hour pharmacy', 'late night pharmacy'], 'overnight'),
  preset('Dentist (emergency)', ['emergency dentist', '24 hour dentist'], 'overnight'),
  preset('Emergency vet', ['emergency vet', '24 hour animal hospital'], 'overnight'),
  preset('Pediatrician', ['pediatrician', 'childrens urgent care'], 'daytime'),
];

export type HomeCategoryPreset = CategoryPreset & {
  /** Offered pre-checked. Locksmith is offered unchecked: lead-gen listings are worst in that trade. */
  checked: boolean;
};

/** Trades a household wants on hand for home emergencies. No gas category: a gas leak is the utility and 911. */
export const HOME_CATEGORY_PRESETS: readonly HomeCategoryPreset[] = [
  { ...preset('Emergency plumber', ['emergency plumber', '24 hour plumber'], 'overnight'), checked: true },
  { ...preset('Emergency electrician', ['emergency electrician', '24 hour electrician'], 'overnight'), checked: true },
  {
    ...preset('Heating & cooling repair', ['emergency hvac repair', '24 hour ac repair', 'emergency furnace repair'], 'overnight'),
    checked: true,
  },
  {
    ...preset('Water damage restoration', ['water damage restoration', 'emergency water removal'], 'overnight'),
    checked: true,
  },
  { ...preset('Locksmith', ['emergency locksmith', '24 hour locksmith'], 'overnight'), checked: false },
];

export type GuidePreset = { title: string; tags: readonly string[] };

/**
 * Starter home guides. Tags link each guide to house facts (by system: water, gas, electric, hvac) and to the
 * trade that fixes it (by category slug). The admin supplies and checks the sources. A gas-or-CO guide is on hold
 * (the household's call, 2026-10-28).
 */
export const HOME_GUIDE_PRESETS: readonly GuidePreset[] = [
  { title: 'Burst pipe or major leak', tags: ['water', 'emergency-plumber', 'water-damage-restoration'] },
  { title: 'Power out or breaker tripped', tags: ['electric', 'emergency-electrician'] },
  { title: 'AC out in the heat', tags: ['hvac', 'heating-cooling-repair'] },
  { title: 'Toilet overflow', tags: ['water', 'emergency-plumber'] },
];
