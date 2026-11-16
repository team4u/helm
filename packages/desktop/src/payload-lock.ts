/**
 * across process install mutual exclusion lock (fail-closed):O_CREAT|O_EXCL atomic create lock file is get semantics, holder
 * record pid and get time. lock already by occupy when only has boundary wait for holder normal release (delete lock file),
 * never take over any lock - -pid already die, hold has timeout, content illegal one rule do not construct into take over by: install timeout
 * (10min) far over history stale threshold (5min), automatically take over will stealthily away store process lock and mutual delete for way
 * creates new lock, break for way staging. crash legacy lock file by tool/user by diagnose information confirm after manually
 * remove (explicit diagnose optimal at static default self-heal). process inside another has promise chain mutual exclusion, same process concurrency invoke determinism serial.
 */
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { DesktopError } from './errors.js';

export interface PayloadLockOptions {
  /** has boundary while waiting long (ms); timeout throw updater_lock_timeout(attach holder diagnose). */
  acquireTimeoutMs?: number;
}

interface LockHolder {
  pid: number;
  at: number;
}

function describeHolder(holder: LockHolder | null): string {
  if (holder === null) return 'unknown (lock file store in but cannot read)';
  const heldMs = holder.at > 0 ? Math.max(0, Math.round(Date.now() - holder.at)) : null;
  return `pid=${holder.pid > 0 ? holder.pid : 'unknown'}, already hold has ${heldMs !== null ? `${heldMs}ms` : 'unknown'}`;
}

export class PayloadFileLock {
  private readonly acquireTimeoutMs: number;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    readonly lockPath: string,
    options: PayloadLockOptions = {},
  ) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 120_000;
  }

  /** serial execute fn: process inside queue up + across process lock file mutual exclusion;fn throws when lock must however release. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.tail.then(() => this.runLocked(fn));
    this.tail = job.catch(() => {});
    return await job;
  }

  private async runLocked<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** has boundary wait for get: other person hold lock when polling direct until release or timeout; timeout explicit errors and attach diagnose, never delete other person lock. */
  private async acquire(): Promise<void> {
    const startedAt = Date.now();
    const deadline = startedAt + this.acquireTimeoutMs;
    let delay = 25;
    let lastHolder: LockHolder | null = null;
    for (;;) {
      if (this.tryCreate()) return;
      const holder = this.readHolder();
      if (holder !== null) lastHolder = holder;
      if (Date.now() >= deadline) {
        throw new DesktopError(
          'updater_lock_timeout',
          `payload install lock by occupy, wait for ${this.acquireTimeoutMs}ms not release: ${this.lockPath}` +
            `(holder ${describeHolder(lastHolder)}; this lock fail-closed do not automatically take over,` +
            'please confirm without install process still in run after manually delete the lock file again retry)',
          { lockPath: this.lockPath, holder: lastHolder, waitedMs: Date.now() - startedAt },
        );
      }
      await sleep(Math.min(delay, 200));
      delay = Math.min(delay * 2, 200);
    }
  }

  /** release: only delete belongs to itself lock file (pid match), never trigger touch other person hold has lock. */
  private release(): void {
    const holder = this.readHolder();
    if (holder === null || holder.pid !== process.pid) return;
    try {
      rmSync(this.lockPath, { force: true });
    } catch {
      // release failed do not mask fn original result; leftover lock file by fail-closed diagnose by human where placement
    }
  }

  private tryCreate(): boolean {
    const payload: LockHolder = { pid: process.pid, at: Date.now() };
    try {
      mkdirSync(path.dirname(this.lockPath), { recursive: true });
      const fh = openSync(this.lockPath, 'wx');
      try {
        writeSync(fh, JSON.stringify(payload));
      } finally {
        closeSync(fh);
      }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  }

  private readHolder(): LockHolder | null {
    try {
      const parsed = JSON.parse(readFileSync(this.lockPath, 'utf8')) as Partial<LockHolder>;
      const pid = parsed.pid;
      const at = parsed.at;
      if (typeof pid === 'number' && Number.isInteger(pid) && typeof at === 'number' && Number.isFinite(at)) {
        return { pid, at };
      }
      // content illegal but file store in: still fail-closed, only with mtime provide hold has when long diagnose.
      return { pid: -1, at: statSync(this.lockPath).mtimeMs };
    } catch {
      return null; // lock file disappear = already release, directly retry
    }
  }
}
