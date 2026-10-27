import { count, eq, inArray } from 'drizzle-orm';
import type { Db } from '../../../db/client.js';
import { categories, locations, protocolVersions, settings } from '../../../db/schema.js';

export const STEPS = ['welcome', 'services', 'home', 'categories', 'places', 'protocol', 'done'] as const;
export type Step = (typeof STEPS)[number];

export const STEP_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  services: 'Services',
  home: 'Home',
  categories: 'Categories',
  places: 'Places',
  protocol: 'Protocol',
  done: 'Done',
};

export type StepDeps = { db: Db };

export const stepPath = (step: Step): string => `/admin/setup/${step}`;

export const stepNumber = (step: Step): number => STEPS.indexOf(step) + 1;

export const nextStep = (step: Step): Step | undefined => STEPS[STEPS.indexOf(step) + 1];

export const prevStep = (step: Step): Step | undefined => STEPS[STEPS.indexOf(step) - 1];

const settingsRow = (db: Db) => db.select().from(settings).where(eq(settings.id, 1)).get();

const countOf = (n: { n: number } | undefined): number => n?.n ?? 0;

/** Done-state is derived from data, never stored, except the final setupCompletedAt. */
export function stepDone(deps: StepDeps, step: Step): boolean {
  const { db } = deps;
  switch (step) {
    case 'welcome':
      return settingsRow(db)?.householdName != null;
    case 'services':
      return true; // optional; never a resume target
    case 'home': {
      const s = settingsRow(db);
      return s?.homeLat != null && s.homeLng != null;
    }
    case 'categories':
      return countOf(db.select({ n: count() }).from(categories).get()) >= 1;
    case 'places':
      // 'warn' rows were approved and are still shown to the family, so they count too.
      return countOf(db.select({ n: count() }).from(locations).where(inArray(locations.status, ['approved', 'warn'])).get()) >= 1;
    case 'protocol':
      return countOf(db.select({ n: count() }).from(protocolVersions).where(eq(protocolVersions.status, 'published')).get()) >= 1;
    case 'done':
      return settingsRow(db)?.setupCompletedAt != null;
  }
}

const RESUMABLE: readonly Step[] = ['welcome', 'home', 'categories', 'places', 'protocol'];

/** The first required step that is not done yet, else the Done step. */
export function resumeTarget(deps: StepDeps): string {
  const step = RESUMABLE.find((s) => !stepDone(deps, s));
  return stepPath(step ?? 'done');
}
