/**
 * PluginHost concurrency control gate:per-plugin lifecycle serial queue + write takes precedence service screen fault read write lock.
 *
 * Why: start screen fault (prepare can time cost) must and across plugin lifecycle operation mutual exclusion, otherwise screen fault phase
 * concurrency enable service will leak start, concurrency disable will by re-,stop() will because not placement while empty run.
 * read gate keep across plugin concurrency, write gate guarantee screen fault and all amount stop atomicity; lock order constant isper-plugin
 * queue → read gate, write gate do not via plugin queue, missing deadlock ring.
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

  /**
   * by pluginId serial execute lifecycle operation, and in execute during hold has service screen fault read gate.
   */
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

  /** wait for all already queue lifecycle task converge and empty queue index (dispose when invoke). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.lifecycle.values()]);
    this.lifecycle.clear();
  }

  private gateWakeAll(): void {
    const waiters = this.gateWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
