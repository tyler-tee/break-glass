import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import type { SecretsStore } from './secrets.js';

export type InstallState = 'unclaimed' | 'incomplete' | 'ready';

/** Derived per request: no admin hash anywhere -> unclaimed; hash but setup not finished -> incomplete; else ready. */
export function installState(deps: { db: Db; secrets: SecretsStore }): InstallState {
  if (deps.secrets.getAdminHash() === undefined) return 'unclaimed';
  const row = deps.db
    .select({ setupCompletedAt: settings.setupCompletedAt })
    .from(settings)
    .where(eq(settings.id, 1))
    .get();
  return row?.setupCompletedAt ? 'ready' : 'incomplete';
}
