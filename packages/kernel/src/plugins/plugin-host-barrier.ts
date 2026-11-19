/**
 * Plugin service start barrier (`prepare -> start`, with fault isolation for external plugins) and reverse-topology shutdown.
 */
import { HelmxError } from '@helmx/protocol';
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

/** Atomic rollback when a non-isolated barrier step fails; ignores stop errors to preserve original diagnostics. */
async function rollbackStartBarrier(started: PluginState[]): Promise<void> {
  for (const prev of [...started].reverse()) {
    try {
      await stopServicesQuietly(prev);
    } catch {
      // Do not mask the original startup failure during rollback.
    }
  }
}

/**
 * Global service startup barrier: runs atomically when no isolated plugins exist (any failure rolls back all),
 * or in phased mode when external isolated plugins are present (isolated failures transition to `failed`
 * without blocking the host, whereas built-in failures still roll back and fail startup).
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

/** Stops all enabled plugin services in reverse dependency order and aggregates any errors. */
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
    throw new HelmxError(
      'plugin_service_stop_failed',
      `Failed to stop plugin services: ${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}
