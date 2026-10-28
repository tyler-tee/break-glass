import { slugify } from '../../../domain/slug.js';

export type CategoryPreset = {
  name: string;
  slug: string;
  searchTerms: readonly string[];
  targetCount: number;
};

const preset = (name: string, searchTerms: readonly string[], targetCount: number): CategoryPreset => ({
  name,
  slug: slugify(name),
  searchTerms,
  targetCount,
});

/** The kinds of places most households want on hand; the wizard offers these as checkboxes. */
export const CATEGORY_PRESETS: readonly CategoryPreset[] = [
  preset('Urgent care', ['urgent care', 'walk-in clinic'], 3),
  preset('Emergency room', ['emergency room', 'hospital emergency department'], 2),
  preset('24-hour pharmacy', ['24 hour pharmacy', 'late night pharmacy'], 2),
  preset('Dentist (emergency)', ['emergency dentist', '24 hour dentist'], 3),
  preset('Emergency vet', ['emergency vet', '24 hour animal hospital'], 2),
  preset('Pediatrician', ['pediatrician', 'childrens urgent care'], 3),
];
