/**
 * 插件服务声明、生命周期屏障（prepare -> start -> stop）与受管资源跟踪。
 */
import {
  HelmError,
  type MaybePromise,
} from '@helm/protocol';
import {
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginInUseItem, PluginState, ServiceEntry } from './types.js';

/**
 * 在受控停止 doc 写入窗口内执行服务 stop：stop 期间（含引擎 close 内部
 * 由 abort 唤醒的异步 settle 链）本插件本周期 ctx.doc 句柄的最终持久化写入
 * 与 STOP_WINDOW_HOST_CALLS 被放行（phase 为 deactivating 时不再拒绝）；stop 返回（成功/失败）即
 * 复位窗口，之后一切写入恢复常规拒绝。窗口按 PluginState 标记而非异步上下
 * 文传播：引擎 settle 链的 promise 在 stop 之前创建，AsyncLocalStorage 无法
 * 跨越已存在的 promise 边界。
 */
export async function runControlledStop(
  state: PluginState,
  stop: () => MaybePromise<void>,
): Promise<void> {
  state.stopWindow = true;
  try {
    await stop();
  } finally {
    state.stopWindow = false;
  }
}

/** 插件内全部服务 prepare（按声明顺序；无 prepare 的服务跳过；每服务仅执行一次）。 */
export async function prepareServices(state: PluginState): Promise<void> {
  for (const svc of state.services) {
    if (svc.prepare === undefined || svc.prepared) continue;
    try {
      await svc.prepare();
      svc.prepared = true;
    } catch (err) {
      throw err instanceof HelmError
        ? err
        : new HelmError(
            'plugin_service_prepare_failed',
            `插件 ${state.definition.id} 服务 ${svc.id} prepare 失败：${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: state.definition.id, serviceId: svc.id },
          );
    }
  }
}

/** 按声明顺序 start 服务；任一失败对已启动者逆向 stop（stop 失败聚合进诊断）。 */
export async function startServices(state: PluginState): Promise<void> {
  const started: ServiceEntry[] = [];
  try {
    for (const svc of state.services) {
      await svc.start();
      svc.started = true;
      started.push(svc);
    }
  } catch (err) {
    const stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
    for (const svc of started.reverse()) {
      try {
        await runControlledStop(state, () => svc.stop());
      } catch (stopErr) {
        stopErrors.push({ serviceId: svc.id, error: toJsonSafeError(stopErr) });
      } finally {
        svc.started = false;
      }
    }
    if (err instanceof HelmError) {
      if (stopErrors.length > 0) {
        throw new HelmError(err.code, err.message, err.status, {
          ...(err.details as object),
          stopErrors,
        });
      }
      throw err;
    }
    throw new HelmError(
      'plugin_service_start_failed',
      `插件 ${state.definition.id} 服务启动失败：${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, stopErrors },
    );
  }
}

/**
 * 启动后失败的逆向 stop：聚合各服务 stop 错误（teardown 同款聚合），
 * 已停用条目跳过；用于 start 屏障阶段 2 的回滚。
 */
export async function stopServicesQuietly(state: PluginState): Promise<void> {
  const errors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
  for (const svc of [...state.services].reverse()) {
    if (!svc.started) continue;
    try {
      await runControlledStop(state, () => svc.stop());
      svc.started = false;
    } catch (err) {
      svc.started = false;
      errors.push({ serviceId: svc.id, error: toJsonSafeError(err) });
    }
  }
  if (errors.length > 0) {
    throw new HelmError(
      'plugin_service_stop_failed',
      `回滚停止插件 ${state.definition.id} 服务时失败：${errors.map((e) => e.serviceId).join(', ')}`,
      500,
      { pluginId: state.definition.id, stopErrors: errors },
    );
  }
}

/**
 * 清理时逆向停止插件已启动服务，返回聚合的 stop 错误列表。
 */
export async function stopPluginServices(
  state: PluginState,
): Promise<Array<{ serviceId: string; error: JsonSafeErrorInfo }>> {
  const stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }> = [];
  for (const svc of [...state.services].reverse()) {
    if (!svc.started) continue;
    try {
      await runControlledStop(state, () => svc.stop());
    } catch (err) {
      stopErrors.push({ serviceId: svc.id, error: toJsonSafeError(err) });
    } finally {
      svc.started = false;
    }
  }
  return stopErrors;
}

/**
 * 显式启动屏障：先对所有已启用插件逐个执行服务 prepare，
 * 再逐插件按声明顺序 start（原子性屏障：任一失败即刻回滚并显式抛错）。
 */
export async function startServiceBarrier(
  enabledPlugins: PluginState[],
): Promise<void> {
  // 阶段 1：全局 prepare 先行
  for (const state of enabledPlugins) {
    await prepareServices(state);
  }

  // 阶段 2：全局 start（原子性回滚：任一失败逆序 stop 已启动插件的服务）
  const started: PluginState[] = [];
  try {
    for (const state of enabledPlugins) {
      await startServices(state);
      started.push(state);
    }
  } catch (err) {
    const rollbackStopErrors: Array<{
      pluginId: string;
      stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }>;
    }> = [];
    for (const state of started.reverse()) {
      try {
        await stopServicesQuietly(state);
      } catch (rollbackErr) {
        rollbackStopErrors.push({
          pluginId: state.definition.id,
          stopErrors:
            rollbackErr instanceof HelmError &&
            Array.isArray((rollbackErr.details as { stopErrors?: unknown })?.stopErrors)
              ? (rollbackErr.details as {
                  stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }>;
                }).stopErrors
              : [{ serviceId: '<unknown>', error: toJsonSafeError(rollbackErr) }],
        });
      }
    }
    if (rollbackStopErrors.length > 0) {
      if (err instanceof HelmError) {
        throw new HelmError(err.code, err.message, err.status, {
          ...((err.details as object) ?? {}),
          rollbackStopErrors,
        });
      }
      throw new HelmError(
        'plugin_service_start_failed',
        `插件服务启动失败：${err instanceof Error ? err.message : String(err)}`,
        500,
        { rollbackStopErrors },
      );
    }
    throw err;
  }
}

/**
 * 全部已启用且已启动服务声明的工作树占用清单（WorktreeAllocator 的
 * isPathInUse 探测源）：合并各服务 liveWorktrees() 返回值。
 * 服务声明函数抛错或返回非法形状时如实显式报错，绝不静默当空——
 * 占用检查坏了就必须修，不能靠猜放行清理在途工作树。
 */
export function listLiveWorktrees(
  plugins: Iterable<PluginState>,
): Array<{ nodeId: string; path: string }> {
  const out: Array<{ nodeId: string; path: string }> = [];
  for (const state of plugins) {
    if (!state.enabled) continue;
    for (const svc of state.services) {
      if (!svc.started || svc.liveWorktrees === undefined) continue;
      let declared: Array<{ nodeId: string; path: string }>;
      try {
        declared = svc.liveWorktrees();
      } catch (err) {
        throw new HelmError(
          'plugin_live_worktrees_check_failed',
          `插件 ${state.definition.id} 服务 ${svc.id} 的 liveWorktrees 检查抛出异常`,
          500,
          { pluginId: state.definition.id, serviceId: svc.id, error: toJsonSafeError(err) },
        );
      }
      if (
        !Array.isArray(declared) ||
        declared.some(
          (item) =>
            typeof item !== 'object' ||
            item === null ||
            Array.isArray(item) ||
            typeof (item as { nodeId?: unknown }).nodeId !== 'string' ||
            typeof (item as { path?: unknown }).path !== 'string',
        )
      ) {
        throw new HelmError(
          'plugin_live_worktrees_check_failed',
          `插件 ${state.definition.id} 服务 ${svc.id} 的 liveWorktrees 必须返回 { nodeId, path } 数组`,
          500,
          { pluginId: state.definition.id, serviceId: svc.id },
        );
      }
      out.push(...declared);
    }
  }
  return out;
}

/**
 * 停用/卸载前的持久资源占用聚合：遍历已启动且声明 inUse 的服务，合并
 * 返回值。服务 inUse 抛错或返回非法形状时显式 plugin_in_use_check_failed
 * （未知即占用原则），绝不静默当空放行。
 */
export async function collectServiceInUse(
  pluginId: string,
  state: PluginState,
): Promise<PluginInUseItem[]> {
  const out: PluginInUseItem[] = [];
  for (const svc of state.services) {
    if (!svc.started || svc.inUse === undefined) continue;
    let declared: PluginInUseItem[];
    try {
      declared = (await svc.inUse()) as PluginInUseItem[];
    } catch (err) {
      throw new HelmError(
        'plugin_in_use_check_failed',
        `插件 ${pluginId} 服务 ${svc.id} 的 inUse 检查抛出异常，按占用处理拒绝停用`,
        500,
        { pluginId, serviceId: svc.id, error: toJsonSafeError(err) },
      );
    }
    if (
      !Array.isArray(declared) ||
      declared.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          Array.isArray(item) ||
          typeof (item as { kind?: unknown }).kind !== 'string' ||
          (item as { kind: string }).kind.length === 0 ||
          typeof (item as { id?: unknown }).id !== 'string' ||
          (item as { id: string }).id.length === 0 ||
          typeof (item as { label?: unknown }).label !== 'string' ||
          (item as { label: string }).label.length === 0,
      )
    ) {
      throw new HelmError(
        'plugin_in_use_check_failed',
        `插件 ${pluginId} 服务 ${svc.id} 的 inUse 必须返回 { kind, id, label } 均为非空字符串的数组`,
        500,
        { pluginId, serviceId: svc.id, returned: String(declared) },
      );
    }
    out.push(...declared);
  }
  return out;
}

/**
 * 停用/卸载前的在途任务闸门：tracker 任务 + 已启动服务声明的 liveTasks 标签
 * 取并集，有任一即 409 拒绝（不进入 stop、不改持久开关）。liveTasks 异常或
 * 返回非字符串数组时把异常/非法输出如实显式报错，绝不静默当空——插件声明
 * 的保活检查坏了就必须修，不能靠猜放行。
 */
export function assertNoLiveTasks(
  pluginId: string,
  state: PluginState | undefined,
  tracker: PluginTaskTracker,
): void {
  const labels = tracker.activeLabels(pluginId);
  if (state) {
    for (const svc of state.services) {
      if (!svc.started || svc.liveTasks === undefined) continue;
      let declared: string[];
      try {
        declared = svc.liveTasks();
      } catch (err) {
        throw new HelmError(
          'plugin_live_tasks_check_failed',
          `插件 ${pluginId} 服务 ${svc.id} 的 liveTasks 检查抛出异常，拒绝停用/卸载`,
          500,
          { pluginId, serviceId: svc.id, error: toJsonSafeError(err) },
        );
      }
      if (
        !Array.isArray(declared) ||
        declared.some((item) => typeof item !== 'string')
      ) {
        throw new HelmError(
          'plugin_live_tasks_check_failed',
          `插件 ${pluginId} 服务 ${svc.id} 的 liveTasks 必须返回字符串数组，实际：${Object.prototype.toString.call(declared)}`,
          500,
          { pluginId, serviceId: svc.id, returned: String(declared) },
        );
      }
      labels.push(...declared);
    }
  }
  if (labels.length > 0) {
    throw new HelmError(
      'plugin_has_live_tasks',
      `插件 ${pluginId} 仍有 ${labels.length} 个在途任务（${labels.join(', ')}），拒绝停用/卸载`,
      409,
      { pluginId, activeTasks: labels },
    );
  }
}
