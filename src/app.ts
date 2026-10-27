import { Hono } from 'hono';
import type { Db } from './db/client.js';
import type { Extractor } from './services/llm/extract.js';
import type { LlmProvider } from './services/llm/provider.js';
import type { LookupFn } from './services/llm/web.js';
import type { Env } from './env.js';
import { familyRoutes } from './features/family/routes.js';
import { apiRoutes } from './features/api/routes.js';
import type { SchedulerHandle } from './jobs/scheduler.js';
import { adminRoutes } from './features/admin/routes.js';

export type AppDeps = { db: Db; env: Env; now?: () => Date; scheduler?: SchedulerHandle;
  places?: { fetch: typeof fetch; apiKey: string };
  extract?: Extractor;
  llm?: LlmProvider;
  siteFetch?: typeof fetch;
  lookup?: LookupFn;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.route('/', familyRoutes(deps));
  app.route('/api', apiRoutes(deps));
  app.route('/admin', adminRoutes(deps));
  return app;
}
