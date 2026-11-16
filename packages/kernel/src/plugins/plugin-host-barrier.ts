/**
 * plugin service start screen fault (prepare -> start, contains external fault isolated fall back) and inverse topology stop.
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

/** non- isolated plugin screen fault on failure atomic rollback:stop failed static default, do not mask original diagnose. */
async function rollbackStartBarrier(started: PluginState[]): Promise<void> {
  for (const prev of [...started].reverse()) {
    try {
      await stopServicesQuietly(prev);
    } catch {
      // rollback failed do not mask original start diagnose
    }
  }
}

/**
 * global service start screen fault: without isolated type plugin when along use atomic screen fault (any one failed all rollback and throws);
 * contains external isolated type plugin when phase start - - external plugin failed fall back is failed do not block assert host,
 * built-in plugin failed still atomic rollback and block assert.
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

/** by dependency inverse topology order stop all enabled plugin service, aggregate and on report failed items. */
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
      `part plugin service stop failed:${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}
