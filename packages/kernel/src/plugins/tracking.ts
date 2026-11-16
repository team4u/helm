/**
 * each plugin in-flight task counter:action / tool execute, hook return suspended agent_spawn, self define task.
 *
 * purpose:disable / unregister encounter any one in-flight task when reject (409 plugin_has_live_tasks),
 * guard against deactivate produce dangling state (execute in handler reference already release register table).
 */

export class PluginTaskTracker {
  /** pluginId -> (label -> concurrency counter). */
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

  /** wrap a async task is subject to trace task. */
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
