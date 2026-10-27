import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/shutdown.js';

function fakes() {
  const order: string[] = [];
  return {
    order,
    deps: {
      stopScheduler: vi.fn(() => void order.push('stop')),
      closeServer: vi.fn(async () => void order.push('server')),
      closeDb: vi.fn(() => void order.push('db')),
      log: { info: vi.fn() },
      exit: vi.fn(),
    },
  };
}

describe('createShutdown', () => {
  it('stops the scheduler, closes the server, then the database, then exits 0', async () => {
    const { order, deps } = fakes();
    await createShutdown(deps)('SIGTERM');
    expect(order).toEqual(['stop', 'server', 'db']);
    expect(deps.log.info).toHaveBeenLastCalledWith('shutdown complete');
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('is idempotent on a second signal', async () => {
    const { deps } = fakes();
    const shutdown = createShutdown(deps);
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    await shutdown('SIGTERM');
    expect(deps.stopScheduler).toHaveBeenCalledTimes(1);
    expect(deps.closeServer).toHaveBeenCalledTimes(1);
    expect(deps.closeDb).toHaveBeenCalledTimes(1);
    expect(deps.exit).toHaveBeenCalledTimes(1);
  });
});
