/**
 * 插件依赖图约束、依赖者收集与拓扑排序。
 */
import { HelmError } from '@helm/protocol';
import {
  findDependencyCycle,
  topoSortByDependencies,
} from './lifecycle-helpers.js';
import type { PluginState } from './types.js';

/** 注册边界依赖环路校验：含经已注册插件间接回到本插件的环。 */
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
      `插件 ${pluginId} 的依赖声明成环：${cycle.join(' -> ')}，拒绝注册`,
      409,
      { pluginId, cycle },
    );
  }
}

/**
 * 依赖满足性校验（enable / 注册即启用的提交门）：逐项依赖必须已注册且
 * 已启用并处于稳定态（defining / deactivating 过渡态均视为不满足）。
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
        `插件 ${pluginId} 依赖的插件 ${dep} 未注册（请先安装/注册并启用它）`,
        409,
        { pluginId, dependency: dep },
      );
    }
    if (!depState.enabled || depState.phase !== 'idle') {
      throw new HelmError(
        'plugin_dependency_not_enabled',
        `插件 ${pluginId} 依赖的插件 ${dep} 未启用（依赖必须已注册且已启用，仅注册不满足）`,
        409,
        { pluginId, dependency: dep, dependencyEnabled: depState.enabled, dependencyPhase: depState.phase },
      );
    }
  }
}

/**
 * 依赖本插件且仍占用它的插件：已启用或正处于 defining 窗口（按注册序BFS）。
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

/** 注销前依赖者硬保护：存在占用依赖者时拒绝（无 force 逃生门）。 */
export function assertNoEnabledDependents(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): void {
  const dependents = collectDependents(plugins, pluginId);
  if (dependents.length === 0) return;
  throw new HelmError(
    'plugin_in_use',
    `插件 ${pluginId} 被 ${dependents.length} 个插件依赖（${dependents.map((s) => s.definition.id).join(', ')}），拒绝注销；请先停用或移除依赖它的插件`,
    409,
    {
      pluginId,
      usages: dependents.map((s) => ({
        kind: 'plugin_dependency',
        id: s.definition.id,
        label: `插件 ${s.definition.id} 依赖 ${pluginId}（${s.enabled ? '当前已启用' : '正在启用'}）`,
      })),
    },
  );
}

/**
 * force 停用后的依赖者显式标记：不自动停用依赖者，而是写入结构化诊断并广播变更。
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
      message: `其依赖插件 ${pluginId} 已被强制停用，依赖不再满足；请停用本插件后先启用 ${pluginId} 再重新启用`,
      stage: 'enable',
      details: { pluginId: dependent.definition.id, dependency: pluginId, forced: true },
    };
    emitChanged(dependent);
  }
}

/** 已启用插件的依赖拓扑序（被依赖者在前；同层保持注册序）。 */
export function enabledStatesInDependencyOrder(
  plugins: ReadonlyMap<string, PluginState>,
): PluginState[] {
  return topoSortByDependencies(
    [...plugins.values()].filter((s) => s.enabled),
    (s) => s.definition.id,
    (s) => s.dependencies,
  );
}
