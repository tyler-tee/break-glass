import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { ResolvedAppDeps } from '../../app.js';
import { page } from '../../web/Layout.js';
import { categoriesRoutes } from '../categories/routes.js';
import { candidatesRoutes, locationsAdminRoutes, warnRoutes } from '../locations/adminRoutes.js';
import { protocolsAdminRoutes } from '../protocols/adminRoutes.js';
import { installState } from './install.js';
import { listLocations } from '../locations/repo.js';
import { getPublished, listProtocols } from '../protocols/repo.js';
import { settingsRoutes } from './settingsRoutes.js';
import { setupRoutes } from './setup/routes.js';
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
      { layout: 'auth' },
    );

  // Unclaimed install: every /admin/* (login included) goes to the public claim page. ensure() makes sure a
  // code exists and is printed, e.g. after the reset CLI cleared the hash while this server kept running.
  app.use('*', async (c, next) => {
    if (installState(deps) === 'unclaimed') {
      deps.setupCode.ensure();
      return c.redirect('/setup', 302);
    }
    await next();
  });

  // An absent or empty next stays empty in the form so login can tell "no destination" from "/admin".
  const nextField = (raw: unknown): string => (typeof raw === 'string' && raw !== '' ? safeNext(raw) : '');

  app.get('/login', (c) => loginPage(c, nextField(c.req.query('next'))));

  app.post('/login', async (c) => {
    const body = await c.req.parseBody();
    const next = nextField(body['next']);
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (!(await verifyPassword(password, secrets.getAdminHash() ?? ''))) {
      return loginPage(c, next, 401);
    }
    await createSession(c, secrets.getSessionSecret(), now());
    // Resume the first-run wizard when the admin did not ask for a specific page.
    if (next === '' && installState(deps) === 'incomplete') return c.redirect('/admin/setup', 302);
    return c.redirect(next || '/admin', 302);
  });

  app.use('*', requireAdmin(() => secrets.getSessionSecret(), now));
  app.use('*', requireSameOrigin);

  app.get('/', (c) => {
    const job = c.req.query('job');
    const result = c.req.query('result');
    const monthUsed = newPlacesBudget(deps.db, env, now).monthUsed();
    const monthlyCap = env.PLACES_MONTHLY_CAP;
    const locs = listLocations(deps.db);
    const count = (status: string) => locs.filter((l) => l.status === status).length;
    const needsRereview = listProtocols(deps.db).filter((p) => p.needsRereview).length;
    const stats: { key: string; href: string; n: number; one: string; many: string }[] = [
      { key: 'approved', href: '/admin/locations', n: count('approved'), one: 'approved place', many: 'approved places' },
      { key: 'candidates', href: '/admin/candidates', n: count('candidate'), one: 'candidate awaiting review', many: 'candidates awaiting review' },
      { key: 'warnings', href: '/admin/warn', n: count('warn'), one: 'warning', many: 'warnings' },
      { key: 'published', href: '/admin/protocols', n: getPublished(deps.db).length, one: 'published protocol', many: 'published protocols' },
      { key: 'rereview', href: '/admin/protocols', n: needsRereview, one: 'protocol needing re-review', many: 'protocols needing re-review' },
    ];
    const incomplete = installState(deps) === 'incomplete';
    return page(
      c,
      'Admin',
      <>
        <h1>Admin</h1>
        {job && result && (
          <p role="status">
            {job}: {result}
          </p>
        )}
        {incomplete ? (
          <section class="setup-card" aria-labelledby="setup-card-title">
            <h2 id="setup-card-title">Finish setting up</h2>
            <p>A few steps are left before the family site is ready.</p>
            <a class="btn" href="/admin/setup">
              Continue setup
            </a>
          </section>
        ) : (
          <p class="setup-again">
            <a href="/admin/setup">Run setup again</a>
          </p>
        )}
        <section class="overview" aria-labelledby="overview-title">
          <h2 id="overview-title" class="sr-only">
            At a glance
          </h2>
          <div class="stat-grid">
            {stats.map((s) => (
              <a href={s.href} data-stat={s.key} class="stat">
                <span class="stat-num">{s.n}</span>
                <span class="stat-label">{s.n === 1 ? s.one : s.many}</span>
              </a>
            ))}
          </div>
        </section>
        <section class="panel">
          <h2>Places usage</h2>
          <p>
            Places calls this month: {monthUsed} / {monthlyCap}
          </p>
          {monthUsed >= monthlyCap * 0.8 && (
            <p role="alert">Places usage is nearing the monthly cap; discovery and refresh stop once it is reached.</p>
          )}
        </section>
        <section class="panel">
          <h2>Background jobs</h2>
          <div class="button-row">
            <form method="post" action="/admin/jobs/refreshLocations/run">
              <button type="submit">Run location refresh now</button>
            </form>
            <form method="post" action="/admin/jobs/recheckProtocols/run">
              <button type="submit">Re-check protocols now</button>
            </form>
          </div>
        </section>
      </>,
      200,
      { layout: 'admin', activeNav: 'overview' },
    );
  });

  app.post('/jobs/:name/run', async (c) => {
    const name = c.req.param('name');
    if (!JOB_NAMES.includes(name as JobName)) return c.notFound();
    if (!deps.scheduler) return page(c, 'Scheduler not running', <h1>Scheduler not running</h1>, 503, { layout: 'admin', activeNav: 'overview' });
    const result: RunResult = await deps.scheduler.runNow(name as JobName);
    return c.redirect(`/admin?job=${name}&result=${result}`, 302);
  });

  // Mounted after requireAdmin/requireSameOrigin, so every wizard GET and POST is authenticated and origin-checked.
  app.route('/setup', setupRoutes(deps));
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
