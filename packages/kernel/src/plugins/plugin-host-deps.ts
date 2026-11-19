/**
 * Plugin dependency graph validation, dependent lookup, and topological sorting.
 */
import { HelmxError } from '@helmx/protocol';
import {
  findDependencyCycle,
  topoSortByDependencies,
} from './lifecycle-helpers.js';
import type { PluginState } from './types.js';

/** Detects dependency cycles at registration time, including indirect cycles through registered plugins. */
export function assertNoDependencyCycle(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  dependencies: readonly string[],
): void {
  const cycle = findDependencyCycle(
    pluginId,
    dependencies,
    (id) => plugins.get(id)?.dependencies,
  );
  if (cycle !== undefined) {
    throw new HelmxError(
      'plugin_dependency_cycle',
      `Plugin ${pluginId} declared a dependency cycle: ${cycle.join(' -> ')}`,
      409,
      { pluginId, cycle },
    );
  }
}

/**
 * Validates that all dependencies are registered, enabled, and idle before commit
 * (`defining` / `deactivating` states do not satisfy).
 */
export function assertDependenciesSatisfied(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  dependencies: readonly string[],
): void {
  for (const dep of dependencies) {
    const depState = plugins.get(dep);
    if (depState === undefined) {
      throw new HelmxError(
        'plugin_dependency_missing',
        `Plugin ${pluginId} depends on ${dep}, which is not registered (install/register and enable it first)`,
        409,
        { pluginId, dependency: dep },
      );
    }
    if (!depState.enabled || depState.phase !== 'idle') {
      throw new HelmxError(
        'plugin_dependency_not_enabled',
        `Plugin ${pluginId} depends on ${dep}, which is not enabled (dependencies must be registered and enabled)`,
        409,
        { pluginId, dependency: dep, dependencyEnabled: depState.enabled, dependencyPhase: depState.phase },
      );
    }
  }
}

/** Collects enabled or currently-defining plugins that depend on `pluginId` (BFS in registration order). */
export function collectDependents(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): PluginState[] {
  const out: PluginState[] = [];
  const seen = new Set<string>([pluginId]);
  const queue = [pluginId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const [id, s] of plugins) {
      if (seen.has(id)) continue;
      if ((!s.enabled && s.phase !== 'defining') || !s.dependencies.includes(current)) continue;
      seen.add(id);
      out.push(s);
      queue.push(id);
    }
  }
  return out;
}

/** Rejects unregistering when active dependents still hold a reference (no `--force` bypass). */
export function assertNoEnabledDependents(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): void {
  const dependents = collectDependents(plugins, pluginId);
  if (dependents.length === 0) return;
  throw new HelmxError(
    'plugin_in_use',
    `Plugin ${pluginId} is required by ${dependents.length} plugin(s) (${dependents.map((s) => s.definition.id).join(', ')}); disable or remove dependents first`,
    409,
    {
      pluginId,
      usages: dependents.map((s) => ({
        kind: 'plugin_dependency',
        id: s.definition.id,
        label: `Plugin ${s.definition.id} depends on ${pluginId} (${s.enabled ? 'enabled' : 'enabling'})`,
      })),
    },
  );
}

/** Records structured diagnostics on dependents after `--force` disable (never disables dependents automatically). */
export function markDependentsBroken(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  emitChanged: (dependent: PluginState) => void,
): void {
  for (const dependent of collectDependents(plugins, pluginId)) {
    if (!dependent.enabled) continue;
    dependent.lastError = {
      code: 'plugin_dependency_not_enabled',
      message: `Dependency ${pluginId} was force-disabled; disable this plugin, re-enable ${pluginId}, then re-enable this plugin`,
      stage: 'enable',
      details: { pluginId: dependent.definition.id, dependency: pluginId, forced: true },
    };
    emitChanged(dependent);
  }
}

/** Returns enabled plugins in dependency topological order (dependencies first, preserving registration order). */
export function enabledStatesInDependencyOrder(
  plugins: ReadonlyMap<string, PluginState>,
): PluginState[] {
  return topoSortByDependencies(
    [...plugins.values()].filter((s) => s.enabled),
    (s) => s.definition.id,
    (s) => s.dependencies,
  );
}
