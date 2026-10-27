import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { familyRoutes } from './features/family/routes.js';
import { apiRoutes } from './features/api/routes.js';
import { adminRoutes } from './features/admin/routes.js';

export type AppDeps = { db: Db; env: Env; now?: () => Date; scheduler?: { reschedule(): void };
  places?: { fetch: typeof fetch; apiKey: string };
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', familyRoutes(deps));
  app.route('/api', apiRoutes(deps));
  app.route('/admin', adminRoutes(deps));
  return app;
}
