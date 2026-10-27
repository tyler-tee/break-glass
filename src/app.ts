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
import { createSecretsStore, type SecretsStore } from './features/admin/secrets.js';
import { makeServiceResolver, type PlacesDep, type ServiceResolver } from './services/resolver.js';

export type AppDeps = { db: Db; env: Env; now?: () => Date; scheduler?: SchedulerHandle;
  // Static service deps (tests inject fakes); read them via placesOf/llmOf/extractOf so the resolver wins.
  places?: PlacesDep;
  extract?: Extractor;
  llm?: LlmProvider;
  siteFetch?: typeof fetch;
  lookup?: LookupFn;
  secrets?: SecretsStore;
  resolve?: ServiceResolver;
};

/** AppDeps after createApp has filled in the secrets store and service resolver. */
export type ResolvedAppDeps = AppDeps & { secrets: SecretsStore; resolve: ServiceResolver };

export function createApp(input: AppDeps): Hono {
  // Fill in place (not a copy) so sub-routers and the caller share one deps object, as before.
  input.secrets ??= createSecretsStore(input.db, input.env);
  input.resolve ??= makeServiceResolver(input.db, input.env, input.secrets);
  const deps = input as ResolvedAppDeps;
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
