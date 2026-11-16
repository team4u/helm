/**
 * 插件服务启动屏障（prepare -> start，含外部故障隔离降级）与逆拓扑停止。
 */
import { HelmError } from '@helm/protocol';
import {
  prepareServices,
  startServiceBarrier,
  startServices,
  stopServicesQuietly,
} from './service-coordinator.js';
import { toJsonSafeError, type JsonSafeErrorInfo } from './shared.js';
import type { PluginState } from './types.js';

export async function activatePluginServices(
  state: PluginState,
  servicesStarted: boolean,
): Promise<void> {
  if (!servicesStarted) return;
  await prepareServices(state);
  await startServices(state);
}

/** 非隔离插件屏障失败时的原子回滚：stop 失败静默，不掩盖原始诊断。 */
async function rollbackStartBarrier(started: PluginState[]): Promise<void> {
  for (const prev of [...started].reverse()) {
    try {
      await stopServicesQuietly(prev);
    } catch {
      // 回滚失败不掩盖原始启动诊断
    }
  }
}

/**
 * 全局服务启动屏障：无隔离型插件时沿用原子屏障（任一失败全回滚并抛错）；
 * 含外部隔离型插件时阶段化启动——外部插件失败降级为 failed 不阻断宿主，
 * 内置插件失败仍原子回滚并阻断。
 */
export async function runServiceStartBarrier(
  enabledInOrder: PluginState[],
  onIsolatedFailure: (state: PluginState, err: unknown) => Promise<void>,
): Promise<void> {
  if (!enabledInOrder.some((s) => s.isolateFailure === true)) {
    await startServiceBarrier(enabledInOrder);
    return;
  }
  const prepared: PluginState[] = [];
  for (const state of enabledInOrder) {
    try {
      await prepareServices(state);
      prepared.push(state);
    } catch (err) {
      if (state.isolateFailure !== true) {
        await rollbackStartBarrier(prepared);
        throw err;
      }
      await onIsolatedFailure(state, err);
    }
  }
  let startedIdx = 0;
  for (const state of prepared) {
    try {
      await startServices(state);
      startedIdx += 1;
    } catch (err) {
      if (state.isolateFailure !== true) {
        await rollbackStartBarrier(prepared.slice(0, startedIdx));
        throw err;
      }
      await onIsolatedFailure(state, err);
    }
  }
}

/** 按依赖逆拓扑序停止全部已启用插件服务，聚合并上报失败项。 */
export async function stopEnabledPluginServices(enabledInOrder: PluginState[]): Promise<void> {
  const errors: Array<{ pluginId: string; error: JsonSafeErrorInfo }> = [];
  for (const state of [...enabledInOrder].reverse()) {
    if (!state.enabled) continue;
    try {
      await stopServicesQuietly(state);
    } catch (err) {
      errors.push({ pluginId: state.definition.id, error: toJsonSafeError(err) });
    }
  }
  if (errors.length > 0) {
    throw new HelmError(
      'plugin_service_stop_failed',
      `部分插件服务停止失败：${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}
