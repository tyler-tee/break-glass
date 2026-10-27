export type ShutdownDeps = {
  stopScheduler: () => void;
  closeServer: () => Promise<void>;
  closeDb: () => void;
  log: { info: (msg: string) => void };
  exit: (code: number) => void;
};

// Returns a signal handler that runs the shutdown sequence once; later signals are ignored.
export function createShutdown(deps: ShutdownDeps): (signal: string) => Promise<void> {
  let started = false;
  return async (signal) => {
    if (started) return;
    started = true;
    deps.log.info(`${signal} received, shutting down`);
    deps.stopScheduler();
    await deps.closeServer();
    // Closing better-sqlite3 checkpoints the WAL so app.db is current on disk.
    deps.closeDb();
    deps.log.info('shutdown complete');
    deps.exit(0);
  };
}
