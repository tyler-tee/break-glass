import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import type { AppDeps } from '../../app.js';
import { AdminNav } from '../../web/components/AdminNav.js';
import { page } from '../../web/Layout.js';
import { categoriesRoutes } from '../categories/routes.js';
import { candidatesRoutes, locationsAdminRoutes } from '../locations/adminRoutes.js';
import { settingsRoutes } from './settingsRoutes.js';
import { SESSION_COOKIE, createSession, requireAdmin, verifyPassword } from './auth.js';

const safeNext = (next: unknown): string =>
  typeof next === 'string' && (next === '/admin' || next.startsWith('/admin/')) ? next : '/admin';

export function adminRoutes(deps: AppDeps): Hono {
  const { env } = deps;
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
    if (!(await verifyPassword(password, env.ADMIN_PASSWORD_HASH))) {
      return loginPage(c, next, 401);
    }
    await createSession(c, env.SESSION_SECRET, now());
    return c.redirect(next, 302);
  });

  app.use('*', requireAdmin(env.SESSION_SECRET, now));

  app.get('/', (c) =>
    page(
      c,
      'Admin',
      <>
        <h1>Admin</h1>
        <AdminNav />
      </>,
    ),
  );

  app.route('/settings', settingsRoutes(deps));
  app.route('/categories', categoriesRoutes(deps));
  app.route('/locations', locationsAdminRoutes(deps));
  app.route('/candidates', candidatesRoutes(deps));

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.redirect('/admin/login', 302);
  });

  return app;
}
