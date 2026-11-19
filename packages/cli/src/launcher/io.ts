/**
 * Shared CLI primitives for the Hub launcher: injectable I/O hooks and the usage error type.
 * Mirrors `@helmx/node`'s `cli-context.ts` pattern (pure mechanism, no command business logic).
 */
import process from 'node:process';

/** Usage or input validation error; its `code` is emitted in `--json` error envelopes. */
export class UsageError extends Error {
  constructor(
    message: string,
    readonly code = 'usage_error',
  ) {
    super(message);
  }
}

/** Injectable I/O hooks allowing tests to swap real stdio, environment, and liveness probing. */
export interface LauncherIo {
  /** Environment used for config resolution and child-process spawning (defaults to `process.env`). */
  env: NodeJS.ProcessEnv;
  out: (text: string) => void;
  err: (text: string) => void;
  /** Liveness probe (defaults to `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean;
}

export function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isAliveOf(io: LauncherIo): (pid: number) => boolean {
  return io.isAlive ?? defaultIsAlive;
}
