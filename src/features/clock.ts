import type { AppDeps } from '../app.js';
import { getSettings } from './locations/repo.js';

export function requestClock(deps: AppDeps): { now: () => Date; tz: () => string } {
  return {
    now: () => (deps.now ?? (() => new Date()))(),
    tz: () => getSettings(deps.db).homeTz,
  };
}
