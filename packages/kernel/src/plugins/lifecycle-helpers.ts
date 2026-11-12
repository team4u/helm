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
  for (const state of [...plugins.values()].reverse()) {
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
