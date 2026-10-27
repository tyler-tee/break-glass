import { sql } from 'drizzle-orm';
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
import { registerAssets } from './web/assets.js';

export type AppDeps = { db: Db; env: Env; now?: () => Date; scheduler?: SchedulerHandle;
  places?: { fetch: typeof fetch; apiKey: string };
  extract?: Extractor;
  llm?: LlmProvider;
  siteFetch?: typeof fetch;
  lookup?: LookupFn;
};

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  app.get('/health', (c) => {
    try {
      deps.db.run(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  registerAssets(app);
  app.route('/', familyRoutes(deps));
  app.route('/api', apiRoutes(deps));
  app.route('/admin', adminRoutes(deps));
  return app;
}
