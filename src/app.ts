import { count, eq, sql } from 'drizzle-orm';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import type { Db } from './db/client.js';
import type { Extractor } from './services/llm/extract.js';
import type { LlmProvider } from './services/llm/provider.js';
import type { LookupFn } from './services/llm/web.js';
import type { Env } from './env.js';
import { familyRoutes } from './features/family/routes.js';
import { UPLOAD_PATH, housePublicRoutes } from './features/house/routes.js';
import { apiRoutes } from './features/api/routes.js';
import type { SchedulerHandle } from './jobs/scheduler.js';
import { adminRoutes } from './features/admin/routes.js';
import { registerAssets } from './web/assets.js';
import type { LayoutContext, PageChrome } from './web/Layout.js';
import { notFoundPage, serverErrorPage } from './web/errorPages.js';
import { readSession, sessionKey } from './features/admin/auth.js';
import { installState } from './features/admin/install.js';
import { locations, settings } from './db/schema.js';
import { createSecretsStore, type SecretsStore } from './features/admin/secrets.js';
import { makeServiceResolver, type PlacesDep, type ServiceResolver } from './services/resolver.js';
import { createSetupCodeManager, type SetupCodeManager } from './features/admin/setupCode.js';
import { setupClaimRoutes } from './features/admin/setupClaim.js';

/** Cap for any request body. */
export const MAX_BODY_BYTES = 256 * 1024;
/** Cap for the public, unauthenticated POSTs (/setup and /admin/login). */
export const MAX_PUBLIC_BODY_BYTES = 16 * 1024;

export type AppDeps = { db: Db; env: Env; now?: () => Date; scheduler?: SchedulerHandle;
  // Static service deps (tests inject fakes); read them via placesOf/llmOf/extractOf so the resolver wins.
  places?: PlacesDep;
  extract?: Extractor;
  llm?: LlmProvider;
  siteFetch?: typeof fetch;
  lookup?: LookupFn;
  secrets?: SecretsStore;
  resolve?: ServiceResolver;
  /** One-time setup code + limiter. Shared with index.ts so the boot print and /setup see one code. */
  setupCode?: SetupCodeManager;
};

/** AppDeps after createApp has filled in the secrets store, service resolver and setup-code manager. */
export type ResolvedAppDeps = AppDeps & { secrets: SecretsStore; resolve: ServiceResolver; setupCode: SetupCodeManager };

export function createApp(input: AppDeps): Hono {
  // Fill in place (not a copy) so sub-routers and the caller share one deps object, as before.
  input.secrets ??= createSecretsStore(input.db, input.env);
  input.resolve ??= makeServiceResolver(input.db, input.env, input.secrets);
  input.setupCode ??= createSetupCodeManager(input.now ? { now: input.now } : {});
  const deps = input as ResolvedAppDeps;
  const app = new Hono();
  const now = deps.now ?? (() => new Date());

  // Lazy per-request layout values (household name, whether Setup is still pending). Read only when a page
  // renders a layout; page() reads them via readLayoutContext(c). New pages need not pass them.
  app.use('*', async (c, next) => {
    let memo: LayoutContext | undefined;
    c.set('layoutContext', () => {
      memo ??= {
        household:
          deps.db.select({ n: settings.householdName }).from(settings).where(eq(settings.id, 1)).get()?.n?.trim() ||
          undefined,
        setupIncomplete: installState(deps) === 'incomplete',
        warnCount: deps.db.select({ n: count() }).from(locations).where(eq(locations.status, 'warn')).get()?.n ?? 0,
      };
      return memo;
    });
    await next();
  });

  // Admin chrome only for an authenticated admin; logged-out visitors get the family layout.
  const chromeFor = async (c: Context): Promise<PageChrome> => {
    if (!c.req.path.startsWith('/admin')) return {};
    try {
      return (await readSession(c, sessionKey(deps.secrets), now())) ? { layout: 'admin' } : {};
    } catch {
      return {};
    }
  };
  app.notFound(async (c) => notFoundPage(c, await chromeFor(c)));
  app.onError(async (err, c) => {
    // Deliberate HTTP errors (e.g. bodyLimit's 413) keep their status instead of becoming a 500 page.
    if (err instanceof HTTPException) return err.getResponse();
    console.error('unhandled error', c.req.method, c.req.path, err);
    try {
      return serverErrorPage(c, await chromeFor(c));
    } catch {
      return c.text('Something went wrong', 500);
    }
  });
  app.get('/health', (c) => {
    try {
      deps.db.run(sql`select 1`);
      return c.json({ ok: true });
    } catch {
      return c.json({ ok: false }, 503);
    }
  });
  // Every request body is capped; the unauthenticated forms get a much tighter cap. The general limit leaves
  // room for the largest legitimate body, a protocol's markdown (tens of KB at most).
  // The photo upload route is exempt: it sets its own, larger limit after the admin auth checks have run.
  const generalLimit = bodyLimit({ maxSize: MAX_BODY_BYTES });
  app.use('*', (c, next) => (c.req.method === 'POST' && UPLOAD_PATH.test(c.req.path) ? next() : generalLimit(c, next)));
  app.post('/setup', bodyLimit({ maxSize: MAX_PUBLIC_BODY_BYTES }));
  app.post('/admin/login', bodyLimit({ maxSize: MAX_PUBLIC_BODY_BYTES }));
  registerAssets(app);
  app.route('/setup', setupClaimRoutes(deps)); // public; POST is same-origin checked inside
  app.route('/house', housePublicRoutes(deps)); // photos are unauthenticated, like the family side
  app.route('/', familyRoutes(deps));
  app.route('/api', apiRoutes(deps));
  app.route('/admin', adminRoutes(deps));
  return app;
}
