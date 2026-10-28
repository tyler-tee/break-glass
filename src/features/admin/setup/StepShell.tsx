import type { Child, FC } from 'hono/jsx';
import { STEPS, STEP_LABELS, nextStep, prevStep, stepNumber, stepPath, type Step } from './steps.js';

export type Notice = { kind: 'status' | 'alert'; text: Child };

export type StepShellProps = {
  step: Step;
  heading: string;
  intro?: Child;
  /** A page-level message under the heading: role=status for success, role=alert for problems. */
  notice?: Notice;
  /** Steps to mark as done in the indicator (derived by the caller via stepDone). */
  doneSteps?: readonly Step[];
  /** Rendered before the main form, e.g. a separate lookup form (forms cannot nest). */
  before?: Child;
  /** Rendered after the main form, e.g. an empty form that out-of-form buttons target via form="…". */
  after?: Child;
  /** Label of the primary button (default Save and continue). */
  nextLabel?: string;
  /** Demote the next button to secondary when something else on the page is the one primary action. */
  nextSecondary?: boolean;
  /** The step's fields; they sit inside the main form, above the navigation buttons. */
  children?: Child;
};

/**
 * The wizard frame: "Step N of 7", the step list, and one main form whose buttons carry name="go":
 * next (Save and continue, the only primary and first in DOM so Enter picks it), skip, back, later.
 */
export const StepShell: FC<StepShellProps> = ({ step, heading, intro, notice, doneSteps = [], before, after, nextLabel = 'Save and continue', nextSecondary = false, children }) => {
  const next = nextStep(step);
  const prev = prevStep(step);
  return (
    <div class="wizard">
      <nav class="wizard-progress" aria-label="Setup steps">
        <p class="wizard-count">
          Step {stepNumber(step)} of {STEPS.length}
        </p>
        <ol class="wizard-steps">
          {STEPS.map((s) =>
            s === step ? (
              <li aria-current="step" class="is-current">
                <span>{STEP_LABELS[s]}</span>
              </li>
            ) : (
              <li class={doneSteps.includes(s) ? 'is-done' : undefined}>
                <a href={stepPath(s)}>
                  {STEP_LABELS[s]}
                  {doneSteps.includes(s) && <span class="sr-only"> (done)</span>}
                </a>
              </li>
            ),
          )}
        </ol>
      </nav>
      <h1>{heading}</h1>
      {intro}
      {notice && (
        <p class={`notice notice-${notice.kind}`} role={notice.kind}>
          {notice.text}
        </p>
      )}
      {before}
      <form method="post" action={stepPath(step)} class="admin-form wizard-form" id="step-form">
        {children}
        <div class="wizard-actions">
          <button type="submit" name="go" value="next" class={nextSecondary ? 'btn-secondary' : undefined}>
            {nextLabel}
          </button>
          {next && (
            <button type="submit" name="go" value="skip" class="btn-secondary" formnovalidate>
              Skip for now
            </button>
          )}
          {prev && (
            <button type="submit" name="go" value="back" class="btn-secondary" formnovalidate>
              Back
            </button>
          )}
          <button type="submit" name="go" value="later" class="btn-secondary">
            Finish later
          </button>
        </div>
        <p class="field-hint">
          {next && prev ? "Skip for now and Back don't save this page. " : next ? "Skip for now doesn't save this page. " : ''}
          Finish later saves it and returns to the overview.
        </p>
      </form>
      {after}
    </div>
  );
};
