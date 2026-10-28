import { Hono, type Context } from 'hono';
import type { Child } from 'hono/jsx';
import type { ResolvedAppDeps } from '../../../app.js';
import { page } from '../../../web/Layout.js';
import { installState } from '../install.js';
import { registerCategoriesStep } from './categoriesStep.js';
import { registerHomeStep } from './homeStep.js';
import { registerPlacesStep } from './placesStep.js';
import { registerServicesStep } from './servicesStep.js';
import type { SetupContext, Status } from './shared.js';
import { STEPS, STEP_LABELS, resumeTarget, stepDone, stepPath, type Step } from './steps.js';
import { registerWelcomeStep } from './welcomeStep.js';

export function setupRoutes(deps: ResolvedAppDeps): Hono {
  const { db } = deps;
  const app = new Hono();

  const ctx: SetupContext = {
    deps,
    db,
    render: (c: Context, step: Step, body: Child, status: Status = 200) =>
      page(c, `Setup: ${STEP_LABELS[step]}`, body, status, { layout: 'admin', activeNav: 'setup' }),
    doneSteps: () => STEPS.filter((s) => s !== 'services' && stepDone({ db }, s)),
    now: deps.now ?? (() => new Date()),
  };

  // A finished install re-runs from the start ("Run setup again"); an unfinished one resumes where it left off.
  app.get('/', (c) => c.redirect(installState(deps) === 'ready' ? stepPath('welcome') : resumeTarget({ db }), 302));

  registerWelcomeStep(app, ctx);
  registerServicesStep(app, ctx);
  registerHomeStep(app, ctx);
  registerCategoriesStep(app, ctx);
  registerPlacesStep(app, ctx);

  return app;
}
