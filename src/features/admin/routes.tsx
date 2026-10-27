import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { ResolvedAppDeps } from '../../app.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { page } from '../../web/Layout.js';
import { categoriesRoutes } from '../categories/routes.js';
import { candidatesRoutes, locationsAdminRoutes, warnRoutes } from '../locations/adminRoutes.js';
import { protocolsAdminRoutes } from '../protocols/adminRoutes.js';
import { settingsRoutes } from './settingsRoutes.js';
import type { JobName, RunResult } from '../../jobs/scheduler.js';
import { newPlacesBudget } from '../../services/places/budget.js';
import { SESSION_COOKIE, createSession, requireAdmin, requireSameOrigin, verifyPassword } from './auth.js';

const JOB_NAMES: readonly string[] = ['refreshLocations', 'recheckProtocols'];

const safeNext = (next: unknown): string =>
  typeof next === 'string' && (next === '/admin' || next.startsWith('/admin/')) ? next : '/admin';

export function adminRoutes(deps: ResolvedAppDeps): Hono {
  const { env, secrets } = deps;
  const now = deps.now ?? (() => new Date());
  const app = new Hono();

  const loginPage = (c: Parameters<typeof page>[0], next: string, status: 200 | 401 = 200) =>
    page(
      c,
      'Admin login',
      <>
        <h1>Admin login</h1>
        {status === 401 && <p role="alert">Wrong password</p>}
        <form method="post" action="/admin/login">
          <input type="hidden" name="next" value={next} />
          <label>
            Password <input type="password" name="password" autofocus />
          </label>
          <button type="submit">Log in</button>
        </form>
      </>,
      status,
    );

  app.get('/login', (c) => loginPage(c, safeNext(c.req.query('next'))));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const next = safeNext(body['next']);
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    // No hash yet (unclaimed install) verifies against '' and always fails.
    if (!(await verifyPassword(password, secrets.getAdminHash() ?? ''))) {
      return loginPage(c, next, 401);
    }
    await createSession(c, secrets.getSessionSecret(), now());
    return c.redirect(next, 302);
  });

  app.use('*', requireAdmin(() => secrets.getSessionSecret(), now));
  app.use('*', requireSameOrigin);

  app.get('/', (c) => {
    const job = c.req.query('job');
    const result = c.req.query('result');
    const monthUsed = newPlacesBudget(deps.db, env, now).monthUsed();
    const monthlyCap = env.PLACES_MONTHLY_CAP;
    return page(
      c,
      'Admin',
      <>
        <h1>Admin</h1>
        <AdminNav />
        {job && result && (
          <p role="status">
            {job}: {result}
          </p>
        )}
        <p>
          Places calls this month: {monthUsed} / {monthlyCap}
        </p>
        {monthUsed >= monthlyCap * 0.8 && (
          <p role="alert">Places usage is nearing the monthly cap; discovery and refresh stop once it is reached.</p>
        )}
        <form method="post" action="/admin/jobs/refreshLocations/run">
          <button type="submit">Run location refresh now</button>
        </form>
        <form method="post" action="/admin/jobs/recheckProtocols/run">
          <button type="submit">Re-check protocols now</button>
        </form>
      </>,
    );
  });

  app.post('/jobs/:name/run', async (c) => {
    const name = c.req.param('name');
    if (!JOB_NAMES.includes(name as JobName)) return c.notFound();
    if (!deps.scheduler) return page(c, 'Scheduler not running', <h1>Scheduler not running</h1>, 503);
    const result: RunResult = await deps.scheduler.runNow(name as JobName);
    return c.redirect(`/admin?job=${name}&result=${result}`, 302);
  });

  app.route('/settings', settingsRoutes(deps));
  app.route('/categories', categoriesRoutes(deps));
  app.route('/locations', locationsAdminRoutes(deps));
  app.route('/candidates', candidatesRoutes(deps));
  app.route('/warn', warnRoutes(deps));
  app.route('/protocols', protocolsAdminRoutes(deps));

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/admin/login', 302);
  });

  return app;
}
