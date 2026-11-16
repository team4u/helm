/**
 * PluginHost 并发控制门：per-plugin 生命周期串行队列 + 写者优先服务屏障读写锁。
 *
 * Why: 启动屏障（prepare 可耗时）必须与跨插件生命周期操作互斥，否则屏障期
 * 并发 enable 的服务会漏启动、并发 disable 会被复活、stop() 会因未置位而空跑。
 * 读门保持跨插件并发，写门保证屏障与全量停止原子性；锁序恒为「per-plugin
 * 队列 → 读门」，写门不经插件队列，不存在死锁环。
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
   * 按 pluginId 串行执行生命周期操作，并在执行期间持有服务屏障读门。
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

  /** 等待所有已入队的生命周期任务收敛并清空队列索引（dispose 时调用）。 */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.lifecycle.values()]);
    this.lifecycle.clear();
  }

  private gateWakeAll(): void {
    const waiters = this.gateWaiters.splice(0);
    for (const wake of waiters) wake();
  }
}
