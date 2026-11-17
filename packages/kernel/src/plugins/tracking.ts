/**
 * Per-plugin in-flight task tracking: action/tool execution, pending `agent_spawn` continuations, and host tasks.
 *
 * Used to reject `disable` / `unregister` while tasks remain active (`409 plugin_has_live_tasks`),
 * preventing dangling handlers from referencing torn-down registries.
 */

export class PluginTaskTracker {
  /** `pluginId -> (label -> active count)` */
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

  /** Wraps an async operation as a tracked in-flight task. */
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
