/**
 * 插件生命周期辅助函数：定义校验、启停持久化判定、资源清理与终态错误聚合。
 */
import {
  HelmError,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helm/protocol';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginTaskTracker } from './tracking.js';
import {
  isCrossPlatformAbsolutePath,
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js';
import type {
  PluginConfigStore,
  PluginState,
} from './types.js';
import { stopPluginServices } from './service-coordinator.js';
import { unregisterProviders } from './provider-coordinator.js';

export function assertDefinition(definition: PluginDefinition): void {
  if (!definition || typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new HelmError('invalid_plugin_definition', '插件定义缺少 id', 400);
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(definition.id)) {
    throw new HelmError('invalid_plugin_definition', `插件 id 仅允许字母数字 : _ -：${definition.id}`, 400);
  }
  if (typeof definition.definePlugin !== 'function') {
    throw new HelmError('invalid_plugin_definition', `插件 ${definition.id} 缺少 definePlugin 函数`, 400);
  }
  normalizeDependencies(definition);
  if (
    definition.clientRoot !== undefined &&
    (typeof definition.clientRoot !== 'string' ||
      !isCrossPlatformAbsolutePath(definition.clientRoot) ||
      definition.clientRoot.split(/[\\/]/).includes('..'))
  ) {
    throw new HelmError(
      'invalid_plugin_definition',
      `插件 ${definition.id} 的 clientRoot 必须是不含 .. 段的跨平台绝对目录路径（POSIX /、Windows 盘符或 UNC）`,
      400,
      { pluginId: definition.id },
    );
  }
}

/** 插件间依赖 ID 字符集（与插件 id 同集：字母数字 : _ -）。 */
const PLUGIN_DEPENDENCY_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * 依赖声明边界归一：可选数组，逐项必须是非空且匹配插件 id 字符集的字符串；
 * 按声明序去重（重复不是错误，但图与清单只保留一份）；自依赖是长度 1 的
 * 环路，在此直接显式拒绝。返回归一后的列表（无依赖时为空数组）。
 */
export function normalizeDependencies(definition: PluginDefinition): string[] {
  const deps = definition.dependencies;
  if (deps === undefined) return [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !PLUGIN_DEPENDENCY_ID_PATTERN.test(d))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `插件 ${definition.id} 的 dependencies 必须是插件 ID 字符串数组（仅允许字母数字 : _ -，不支持版本说明符）`,
      400,
      { pluginId: definition.id, dependencies: Array.isArray(deps) ? deps.map((d) => String(d)) : String(deps) },
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const dep of deps) {
    if (dep === definition.id) {
      throw new HelmError(
        'plugin_dependency_cycle',
        `插件 ${definition.id} 声明了自依赖（依赖图环路）`,
        409,
        { pluginId: definition.id, cycle: [definition.id, definition.id] },
      );
    }
    if (seen.has(dep)) continue;
    seen.add(dep);
    out.push(dep);
  }
  return out;
}

/**
 * 依赖图环路检测：从起点插件的依赖声明出发，沿已注册插件的依赖边深度优先，
 * 回到起点即成环。返回环路上的插件 ID 序列（不成环返回 undefined）。只追踪
 * 已注册节点（起点依赖经 startDependencies 注入；未注册依赖是 enable 阶段的
 * 缺失错误，不是环）。
 */
export function findDependencyCycle(
  startPluginId: string,
  startDependencies: readonly string[],
  dependenciesOf: (pluginId: string) => string[] | undefined,
): string[] | undefined {
  const path: string[] = [startPluginId];
  const onPath = new Set<string>([startPluginId]);
  const visited = new Set<string>();
  const walk = (pluginId: string, deps: readonly string[]): string[] | undefined => {
    for (const dep of deps) {
      if (dep === startPluginId) {
        return [...path, startPluginId];
      }
      if (onPath.has(dep) || visited.has(dep)) continue;
      const depDeps = dependenciesOf(dep);
      if (depDeps === undefined) continue;
      path.push(dep);
      onPath.add(dep);
      const found = walk(dep, depDeps);
      if (found !== undefined) return found;
      path.pop();
      onPath.delete(dep);
      visited.add(dep);
    }
    return undefined;
  };
  return walk(startPluginId, startDependencies);
}

/**
 * 依赖拓扑排序（确定性 Kahn）：输入保持注册序，仅统计集合内依赖边（依赖
 * 集合外/未注册插件的边不参与排序）；同层结点按注册序出队，被依赖者先出。
 * 输入已无环（注册边界拒绝环路）；防御性兑底：若检测到环，抛
 * plugin_dependency_cycle 而不是死循环。
 */
export function topoSortByDependencies<T>(
  items: T[],
  idOf: (item: T) => string,
  dependenciesOf: (item: T) => readonly string[],
): T[] {
  const inSet = new Set(items.map(idOf));
  const depsOf = new Map<string, Set<string>>();
  const dependentsOf = new Map<string, string[]>();
  for (const item of items) {
    const id = idOf(item);
    const deps = new Set(dependenciesOf(item).filter((d) => inSet.has(d) && d !== id));
    depsOf.set(id, deps);
    for (const dep of deps) {
      const list = dependentsOf.get(dep) ?? [];
      list.push(id);
      dependentsOf.set(dep, list);
    }
  }
  const pending = items.filter((item) => (depsOf.get(idOf(item))?.size ?? 0) === 0);
  const queued = new Set(pending.map(idOf));
  const out: T[] = [];
  while (pending.length > 0) {
    const item = pending.shift()!;
    out.push(item);
    const id = idOf(item);
    for (const dependentId of dependentsOf.get(id) ?? []) {
      const deps = depsOf.get(dependentId)!;
      deps.delete(id);
      if (deps.size === 0 && !queued.has(dependentId)) {
        // 同层保持注册序：入队项按原注册序插入（dependentsOf 本身按注册序追加，
        // 且 queued 防重复；多源同时解锁时出队顺序由解锁顺序决定，确定性是够的）。
        queued.add(dependentId);
        const source = items.find((i) => idOf(i) === dependentId)!;
        pending.push(source);
      }
    }
  }
  if (out.length !== items.length) {
    const stuck = items.filter((i) => !out.includes(i)).map(idOf);
    throw new HelmError(
      'plugin_dependency_cycle',
      `插件依赖图存在环路，无法拓扑排序：${stuck.join(' -> ')}`,
      409,
      { pluginIds: stuck },
    );
  }
  return out;
}

export function assertNotLocked(state: PluginState): void {
  if (state.definition.locked === true) {
    throw new HelmError('plugin_locked', `插件 ${state.definition.id} 已锁定，禁止停用/卸载`, 403, {
      pluginId: state.definition.id,
    });
  }
}

/** 对外可用 = 已启用且不在 definePlugin / 停用过渡态。 */
export function assertActive(state: PluginState): void {
  if (!state.enabled || state.phase !== 'idle') {
    throw new HelmError('plugin_disabled', `插件 ${state.definition.id} 未启用或正在切换启用状态`, 409, {
      pluginId: state.definition.id,
      phase: state.phase,
    });
  }
}

/** 周期内可用性守卫：周期更替/停用中/已停用一律失效（doc 句柄与宿主资源共用）。 */
export function assertContextUsable(
  state: PluginState,
  epoch: number,
  what: string,
  currentState: PluginState | undefined,
  isDisposed: boolean,
): void {
  if (isDisposed) {
    throw new HelmError('plugin_host_disposed', 'PluginHost 已 dispose', 409);
  }
  if (
    currentState !== state ||
    epoch !== state.epoch ||
    state.phase === 'deactivating' ||
    !(state.phase === 'defining' || state.enabled)
  ) {
    throw new HelmError(
      'plugin_context_expired',
      `插件 ${state.definition.id} 的 ${what} 已失效（插件已停用或进入新启用周期）`,
      409,
    );
  }
}

export function resolveInitialEnabled(
  definition: PluginDefinition,
  store: PluginConfigStore | undefined,
  options: { enabled?: boolean },
): boolean {
  if (definition.locked === true) return true;
  let persisted: boolean | undefined;
  try {
    persisted = store?.getEnabled?.(definition.id);
  } catch (err) {
    if (err instanceof HelmError) throw err;
    throw new HelmError(
      'plugin_registration_failed',
      `插件 ${definition.id} 注册失败：读取持久启停状态时出错：${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: definition.id },
    );
  }
  if (persisted !== undefined && typeof persisted !== 'boolean') {
    throw new HelmError(
      'plugin_enabled_state_invalid',
      `插件 ${definition.id} 的持久启停状态非法（期望布尔值，实际：${typeof persisted}），拒绝注册`,
      500,
      { pluginId: definition.id, persisted: String(persisted) },
    );
  }
  if (persisted !== undefined) return persisted;
  return options.enabled !== false;
}

/**
 * 持久化启停状态（store 未实现 setEnabled 时为无副作用的内存机制）。
 * 失败显式 reject，由调用方决定回滚（enable）或聚合诊断（disable）。
 */
export async function persistEnabled(
  store: PluginConfigStore | undefined,
  state: PluginState,
  enabled: boolean,
): Promise<void> {
  if (!store?.setEnabled) return;
  try {
    await store.setEnabled(state.definition.id, enabled);
  } catch (err) {
    throw new HelmError(
      'plugin_enabled_persist_failed',
      `插件 ${state.definition.id} 启停状态持久化失败：${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, enabled, persistError: toJsonSafeError(err) },
    );
  }
}

/**
 * 停用时清理服务与 Provider，释放宿主生命周期资源，清空能力注册表。
 */
export async function teardownPlugin(
  state: PluginState,
  opts: { stopServices: boolean },
  clearRegistrations?: (state: PluginState) => void,
): Promise<void> {
  const pluginId = state.definition.id;
  const stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = opts.stopServices
    ? await stopPluginServices(state)
    : [];

  let providerErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> = [];
  try {
    await unregisterProviders(state);
  } catch (err) {
    providerErrors =
      err instanceof HelmError && Array.isArray((err.details as { unregisterErrors?: unknown } | undefined)?.unregisterErrors)
        ? ((err.details as { unregisterErrors: Array<{ providerId: string; error: JsonSafeErrorInfo }> }).unregisterErrors)
        : [{ providerId: '<unknown>', error: toJsonSafeError(err) }];
  }

  const releaseErrors: Array<{ error: JsonSafeErrorInfo }> = [];
  for (const release of [...state.hostReleases]) {
    state.hostReleases.delete(release);
    try {
      release();
    } catch (err) {
      releaseErrors.push({ error: toJsonSafeError(err) });
    }
  }

  clearRegistrations?.(state);

  if (stopErrors.length > 0) {
    throw new HelmError(
      'plugin_service_stop_failed',
      `插件 ${state.definition.id} 清理时服务 stop 失败：${stopErrors.map((e) => e.serviceId).join(', ')}`,
      500,
      {
        pluginId: state.definition.id,
        stopErrors,
        ...(releaseErrors.length > 0 ? { releaseErrors } : {}),
        ...(providerErrors.length > 0 ? { providerErrors } : {}),
      },
    );
  }
  if (providerErrors.length > 0) {
    throw new HelmError(
      'plugin_provider_unregister_failed',
      `插件 ${state.definition.id} 清理时 provider 卸载失败：${providerErrors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, providerErrors },
    );
  }
  if (releaseErrors.length > 0) {
    throw new HelmError(
      'plugin_resource_release_failed',
      `插件 ${state.definition.id} 清理时宿主资源释放失败（管理保护/监听可能残留，需人工核查）`,
      500,
      { pluginId: state.definition.id, releaseErrors },
    );
  }
}

/**
 * 异常归一为结构化插件诊断（PluginDiagnosticError）：HelmError 保留
 * code/status 与 details，其他异常包装为 plugin_execution_failed。
 */
export function toDiagnosticError(
  err: unknown,
  stage: PluginDiagnosticError['stage'],
): PluginDiagnosticError {
  if (err instanceof HelmError) {
    return {
      code: err.code,
      message: err.message,
      stage,
      ...((err.details as Record<string, unknown> | undefined) !== undefined
        ? { details: err.details as Record<string, unknown> }
        : {}),
    };
  }
  return {
    code: 'plugin_execution_failed',
    message: err instanceof Error ? err.message : String(err),
    stage,
  };
}

export function wrapRegistrationError(
  pluginId: string,
  seq: number,
  err: unknown,
  rollbackError?: JsonSafeErrorInfo,
): HelmError {
  if (err instanceof HelmError) {
    if (rollbackError) {
      return new HelmError(err.code, err.message, err.status, {
        ...((err.details as object) ?? {}),
        rollbackError,
      });
    }
    return err;
  }
  return new HelmError(
    'plugin_registration_failed',
    `插件 ${pluginId} 注册失败：${err instanceof Error ? err.message : String(err)}`,
    500,
    { pluginId, registerSeq: seq, ...(rollbackError ? { rollbackError } : {}) },
  );
}

export function wrapEnableError(
  pluginId: string,
  err: unknown,
  rollbackError?: JsonSafeErrorInfo,
): HelmError {
  if (err instanceof HelmError) {
    if (rollbackError) {
      return new HelmError(err.code, err.message, err.status, {
        ...((err.details as object) ?? {}),
        rollbackError,
      });
    }
    return err;
  }
  return new HelmError(
    'plugin_enable_failed',
    `插件 ${pluginId} 启用失败：${err instanceof Error ? err.message : String(err)}`,
    500,
    { pluginId, ...(rollbackError ? { rollbackError } : {}) },
  );
}

export function pluginSummaryOf(
  state: PluginState,
  capabilityRegistry: CapabilityRegistry,
): PluginSummary {
  const failed = state.lastError !== undefined;
  return {
    id: state.definition.id,
    name: state.definition.name ?? state.definition.id,
    description: state.definition.description,
    ...(state.definition.icon ? { icon: state.definition.icon } : {}),
    version: state.definition.version,
    ...(state.dependencies.length > 0 ? { dependencies: [...state.dependencies] } : {}),
    locked: state.definition.locked === true,
    enabled: state.enabled,
    status: failed ? 'failed' : state.enabled ? 'active' : 'disabled',
    ...(failed ? { error: state.lastError } : {}),
    hooks: state.enabled ? [...state.hooks] : [],
    actions: state.enabled ? capabilityRegistry.getActionIds(state.definition.id) : [],
    tools: state.enabled ? capabilityRegistry.getToolNames(state.definition.id) : [],
  };
}

export function getActiveEnabledPluginIds(plugins: Map<string, PluginState>): string[] {
  const ids: string[] = [];
  for (const [id, s] of plugins) {
    // 清单可见性要求 enabled+idle：拆毁期（disable 已置 phase=deactivating 而
    // enabled 尚未落 false，teardown 至 clearRegistrations 之间）的插件必须从
    // 工具/动作/路由/UI 清单即时消失，不再向已停服务派发新请求。register 与
    // enable 的 enabled 与 idle 为同步相邻置位，不存在「enabled 已置而 phase
    // 未 idle」的启动期窗口，清单出现时机不变。
    if (s.enabled && s.phase === 'idle') ids.push(id);
  }
  return ids;
}

export function getIdleActivePluginIds(plugins: Map<string, PluginState>): string[] {
  const ids: string[] = [];
  for (const [id, s] of plugins) {
    if (s.enabled && s.phase === 'idle') ids.push(id);
  }
  return ids;
}

export async function disposePlugins(
  plugins: Map<string, PluginState>,
  teardown: (state: PluginState) => Promise<void>,
  tracker: PluginTaskTracker,
  removeRegistries: (pluginId: string) => void,
): Promise<void> {
  const errors: Array<{ pluginId: string; error: JsonSafeErrorInfo }> = [];
  // 逆依赖拓扑序拆毁：依赖者先干依赖它的插件停止（依赖它的插件先停，被依赖
  // 者后停）；无依赖关系的插件保持注册序的逆序，与既有行为一致。
  const ordered = topoSortByDependencies(
    [...plugins.values()],
    (s) => s.definition.id,
    (s) => s.dependencies,
  ).reverse();
  for (const state of ordered) {
    state.phase = 'deactivating';
    try {
      await teardown(state);
      state.enabled = false;
    } catch (err) {
      errors.push({ pluginId: state.definition.id, error: toJsonSafeError(err) });
    } finally {
      state.phase = 'idle';
      tracker.removePlugin(state.definition.id);
      removeRegistries(state.definition.id);
    }
  }
  plugins.clear();
  if (errors.length > 0) {
    throw new HelmError(
      'plugin_dispose_failed',
      `dispose 时部分插件清理失败：${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}

/**
 * settleLifecycleChanged：启停持久化失败（persistError）与 stop 错误
 * 同层聚合。三重失败（stop + 持久化 + 事件发布）时以 stop 诊断为主链，其余
 * JSON-safe 归一后附入 details，绝不静默变成功，也绝不让后发错误掩盖先发诊断。
 */
export function settleLifecycleChanged(
  state: PluginState,
  stopError: { err: unknown } | undefined,
  persistError: { err: unknown } | undefined,
  emitChanged: () => void,
): void {
  if (!stopError && !persistError) {
    emitChanged();
    return;
  }
  let eventError: JsonSafeErrorInfo | undefined;
  try {
    emitChanged();
  } catch (err) {
    eventError = toJsonSafeError(err);
  }
  const primary = stopError ?? persistError;
  const extras: Record<string, unknown> = {};
  if (stopError && persistError) extras.persistError = toJsonSafeError(persistError.err);
  if (eventError) extras.eventError = eventError;
  if (primary!.err instanceof HelmError) {
    throw new HelmError(primary!.err.code, primary!.err.message, primary!.err.status, {
      ...((primary!.err.details as Record<string, unknown>) ?? {}),
      ...extras,
    });
  }
  if (persistError && !stopError) {
    throw new HelmError(
      'plugin_enabled_persist_failed',
      `插件 ${state.definition.id} 已停用，但启停状态持久化失败：${persistError.err instanceof Error ? persistError.err.message : String(persistError.err)}`,
      500,
      {
        pluginId: state.definition.id,
        persistError: toJsonSafeError(persistError.err),
        ...(extras.eventError ? { eventError: extras.eventError } : {}),
      },
    );
  }
  if (eventError) {
    throw new HelmError(
      'plugin_changed_emit_failed',
      `插件 ${state.definition.id} 已完成实际停用/移除，但服务 stop 与 plugin.changed 事件发布双双失败`,
      500,
      { pluginId: state.definition.id, stopError: toJsonSafeError(stopError!.err), ...extras },
    );
  }
  throw primary!.err;
}
