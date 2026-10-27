import type { AppDeps } from '../app.js';
import { getSettings } from './admin/settingsRepo.js';

export function requestClock(deps: AppDeps): { now: () => Date; tz: () => string } {
  return {
    now: () => (deps.now ?? (() => new Date()))(),
    tz: () => getSettings(deps.db).homeTz,
  };
}
