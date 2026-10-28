import type { Context } from 'hono';
import type { Child, FC } from 'hono/jsx';
import type { ResolvedAppDeps } from '../../../app.js';
import type { Db } from '../../../db/client.js';
import type { page } from '../../../web/Layout.js';
import { nextStep, prevStep, stepPath, type Step } from './steps.js';

export type Status = 200 | 400 | 429 | 502 | 503;
export type Errors = Partial<Record<string, string>>;
export type Go = 'next' | 'skip' | 'back' | 'later';

/** What every step module gets: the app deps plus the rendering and navigation helpers they share. */
export type SetupContext = {
  deps: ResolvedAppDeps;
  db: Db;
  /** Renders a step page inside the admin layout. */
  render: (c: Context, step: Step, body: Child, status?: Status) => ReturnType<typeof page>;
  /** Steps to mark done in the indicator (never Services). */
  doneSteps: () => Step[];
  /** The app clock (injected in tests). */
  now: () => Date;
};

export const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** First value of a possibly repeated form field (parseBody({ all: true })). */
export const one = (v: unknown): string => str(Array.isArray(v) ? v[0] : v);
/** All values of a possibly repeated form field. */
export const many = (v: unknown): string[] => (Array.isArray(v) ? v.map(str) : v === undefined ? [] : [str(v)]);
export const goOf = (v: unknown): Go => (v === 'skip' || v === 'back' || v === 'later' ? v : 'next');

/** Where Save and continue / Skip for now / Back / Finish later lead from a step. */
export function destination(step: Step, go: Go): string {
  if (go === 'later') return '/admin';
  const target = go === 'back' ? prevStep(step) : nextStep(step);
  return stepPath(target ?? step);
}

/** One labelled field with its hint and an error beside it; the first invalid field gets focus. */
export const Field: FC<{
  id: string;
  label: string;
  hint?: Child;
  error?: string;
  control: (describedBy: string | undefined, invalid: boolean) => Child;
}> = ({ id, label, hint, error, control }) => {
  const ids = [hint ? `${id}-hint` : '', error ? `${id}-error` : ''].filter(Boolean).join(' ');
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {hint && (
        <p class="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      {control(ids || undefined, Boolean(error))}
      {error && (
        <p class="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
};

/** Name of the first field with an error, in the order the fields appear on the page. */
export const firstError = (errors: Errors, order: readonly string[]): string | undefined => order.find((f) => errors[f]);
