import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Env } from './env.js';
import { familyRoutes } from './features/family/routes.js';

export type AppDeps = { db: Db; env: Env; now?: () => Date };

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', familyRoutes(deps));
  return app;
}
