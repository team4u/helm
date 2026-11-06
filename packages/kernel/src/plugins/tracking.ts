/**
 * 每插件在途任务计数：action / tool 执行、钩子返回的挂起 agent_spawn、自定义 task。
 *
 * 用途：disable / unregister 遇任一在途任务时拒绝（409 plugin_has_live_tasks），
 * 防止停用产生悬空状态（执行中的 handler 引用已释放的注册表）。
 */

export class PluginTaskTracker {
  /** pluginId -> (label -> 并发计数)。 */
  private counts = new Map<string, Map<string, number>>();

  begin(pluginId: string, label: string): void {
    let labels = this.counts.get(pluginId);
    if (!labels) {
      labels = new Map();
      this.counts.set(pluginId, labels);
    }
    labels.set(label, (labels.get(label) ?? 0) + 1);
  }

  end(pluginId: string, label: string): void {
    const labels = this.counts.get(pluginId);
    if (!labels) return;
    const n = labels.get(label) ?? 0;
    if (n <= 1) labels.delete(label);
    else labels.set(label, n - 1);
    if (labels.size === 0) this.counts.delete(pluginId);
  }

  activeCount(pluginId: string): number {
    let sum = 0;
    for (const n of this.counts.get(pluginId)?.values() ?? []) sum += n;
    return sum;
  }

  activeLabels(pluginId: string): string[] {
    return [...(this.counts.get(pluginId)?.keys() ?? [])];
  }

  /** 包装一个异步任务为受跟踪任务。 */
  async withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> {
    this.begin(pluginId, label);
    try {
      return await fn();
    } finally {
      this.end(pluginId, label);
    }
  }

  removePlugin(pluginId: string): void {
    this.counts.delete(pluginId);
  }
}
