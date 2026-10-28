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
