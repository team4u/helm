/**
 * PluginHost concurrency gate: per-plugin serial lifecycle queue + writer-preferring service barrier RWLock.
 *
 * Why: the startup barrier (`prepare`) can be asynchronous and must exclude concurrent cross-plugin lifecycle
 * mutations so newly enabled services aren't skipped, disabled services aren't revived, and `stop()` never
 * no-ops mid-barrier. Lock ordering is always `per-plugin queue -> read gate` so writes never deadlock.
 */
export class PluginHostGate {
  private lifecycle = new Map<string, Promise<unknown>>();
  private gateReaders = 0;
  private gateWriterActive = false;
  private gateWritersWaiting = 0;
  private gateWaiters: Array<() => void> = [];

  get readerCount(): number {
    return this.gateReaders;
  }

  get isWriterActive(): boolean {
    return this.gateWriterActive;
  }

  get waitingWriterCount(): number {
    return this.gateWritersWaiting;
  }

  get queuedPluginCount(): number {
    return this.lifecycle.size;
  }

  /** Executes `op` serially per `pluginId` while holding the service barrier read lock. */
  enqueue<T>(pluginId: string, op: () => Promise<T>): Promise<T> {
    const prev = this.lifecycle.get(pluginId) ?? Promise.resolve();
    const run = prev.then(async () => {
      await this.acquireGateRead();
      try {
        return await op();
      } finally {
        this.releaseGateRead();
      }
    });
    const tail = run.then(
      () => {},
      () => {},
    );
    this.lifecycle.set(pluginId, tail);
    void tail.then(() => {
      if (this.lifecycle.get(pluginId) === tail) this.lifecycle.delete(pluginId);
    });
    return run;
  }

  async acquireGateRead(): Promise<void> {
    while (this.gateWriterActive || this.gateWritersWaiting > 0) {
      await new Promise<void>((resolve) => this.gateWaiters.push(resolve));
    }
    this.gateReaders += 1;
  }

  releaseGateRead(): void {
    if (this.gateReaders <= 0) {
      throw new Error('PluginHostGate.releaseGateRead called with no active readers');
    }
    this.gateReaders -= 1;
    if (this.gateReaders === 0) this.gateWakeAll();
  }

  async acquireGateWrite(): Promise<void> {
    this.gateWritersWaiting += 1;
    try {
      while (this.gateWriterActive || this.gateReaders > 0) {
        await new Promise<void>((resolve) => this.gateWaiters.push(resolve));
      }
      this.gateWriterActive = true;
    } finally {
      this.gateWritersWaiting -= 1;
      this.gateWakeAll();
    }
  }

  releaseGateWrite(): void {
    if (!this.gateWriterActive) {
      throw new Error('PluginHostGate.releaseGateWrite called without active writer');
    }
    this.gateWriterActive = false;
    this.gateWakeAll();
  }

  async withWriteLock<T>(op: () => Promise<T>): Promise<T> {
    await this.acquireGateWrite();
    try {
      return await op();
    } finally {
      this.releaseGateWrite();
    }
  }

  /** Awaits all queued lifecycle operations and clears queue entries (called on `dispose()`). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.lifecycle.values()]);
    this.lifecycle.clear();
  }

  private gateWakeAll(): void {
    const waiters = this.gateWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
