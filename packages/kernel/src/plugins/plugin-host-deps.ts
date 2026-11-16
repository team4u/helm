/**
 * plugin dependency graph constraint, dependency collect and topology sort.
 */
import { HelmError } from '@helm/protocol';
import {
  findDependencyCycle,
  topoSortByDependencies,
} from './lifecycle-helpers.js';
import type { PluginState } from './types.js';

/** register boundary dependency ring route validate: contains via registered plugin indirectly back to this plugin ring. */
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
    throw new HelmError(
      'plugin_dependency_cycle',
      `plugin ${pluginId} dependency declaration into ring:${cycle.join(' -> ')}, reject register`,
      409,
      { pluginId, cycle },
    );
  }
}

/**
 * dependency satisfy validate (enable / register i.e. enable commit gate): one by one items dependency must registered and
 * enabled and where at stable state (defining / deactivating transition state all treated as do not satisfy).
 */
export function assertDependenciesSatisfied(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  dependencies: readonly string[],
): void {
  for (const dep of dependencies) {
    const depState = plugins.get(dep);
    if (depState === undefined) {
      throw new HelmError(
        'plugin_dependency_missing',
        `plugin ${pluginId} dependency plugin ${dep} not registered (please first install/register and enable it)`,
        409,
        { pluginId, dependency: dep },
      );
    }
    if (!depState.enabled || depState.phase !== 'idle') {
      throw new HelmError(
        'plugin_dependency_not_enabled',
        `plugin ${pluginId} dependency plugin ${dep} not enabled (dependency must registered and enabled, only register do not satisfy)`,
        409,
        { pluginId, dependency: dep, dependencyEnabled: depState.enabled, dependencyPhase: depState.phase },
      );
    }
  }
}

/**
 * dependency this plugin and still occupy it plugin: enabled or correct where at defining window (by register orderBFS).
 */
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

/** deregister before dependency hard protect: store in occupy dependency when reject (without force escape generate gate). */
export function assertNoEnabledDependents(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): void {
  const dependents = collectDependents(plugins, pluginId);
  if (dependents.length === 0) return;
  throw new HelmError(
    'plugin_in_use',
    `plugin ${pluginId} by ${dependents.length} plugin dependency (${dependents.map((s) => s.definition.id).join(', ')}), reject deregister; please first deactivate or remove dependency it plugin`,
    409,
    {
      pluginId,
      usages: dependents.map((s) => ({
        kind: 'plugin_dependency',
        id: s.definition.id,
        label: `plugin ${s.definition.id} dependency ${pluginId}(${s.enabled ? 'when before enabled' : 'is now enable'})`,
      })),
    },
  );
}

/**
 * force deactivate after dependency explicit mark record: do not automatically deactivate dependency, but rather write structure diagnose and broadcast change.
 */
export function markDependentsBroken(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
  emitChanged: (dependent: PluginState) => void,
): void {
  for (const dependent of collectDependents(plugins, pluginId)) {
    if (!dependent.enabled) continue;
    dependent.lastError = {
      code: 'plugin_dependency_not_enabled',
      message: `its dependency plugin ${pluginId} already by force deactivate, dependency no longer satisfy; please deactivate this plugin after first enable ${pluginId} again re- enable`,
      stage: 'enable',
      details: { pluginId: dependent.definition.id, dependency: pluginId, forced: true },
    };
    emitChanged(dependent);
  }
}

/** enabled plugin dependency topology order (by dependency in before; same layer keep register order). */
export function enabledStatesInDependencyOrder(
  plugins: ReadonlyMap<string, PluginState>,
): PluginState[] {
  return topoSortByDependencies(
    [...plugins.values()].filter((s) => s.enabled),
    (s) => s.definition.id,
    (s) => s.dependencies,
  );
}
