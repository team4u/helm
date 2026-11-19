/**
 * Coordinates plugin service declarations, lifecycle barriers (`prepare -> start -> stop`), and resource tracking.
 */
import {
  HelmxError,
  type MaybePromise,
} from '@helmx/protocol';
import {
  toJsonSafeError,
  type JsonSafeErrorInfo,
} from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginInUseItem, PluginState, ServiceEntry } from './types.js';

/**
 * Executes service `stop()` inside a controlled write window so final `ctx.doc` writes and
 * `STOP_WINDOW_HOST_CALLS` (including internal settled continuations) are permitted even though
 * `phase === 'deactivating'`, then closes the window unconditionally on completion/error.
 */
async function runControlledStop(
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

/** Runs `prepare()` sequentially in declaration order (skips services without `prepare` or already prepared). */
export async function prepareServices(state: PluginState): Promise<void> {
  for (const svc of state.services) {
    if (svc.prepare === undefined || svc.prepared) continue;
    try {
      await svc.prepare();
      svc.prepared = true;
    } catch (err) {
      throw err instanceof HelmxError
        ? err
        : new HelmxError(
            'plugin_service_prepare_failed',
            `Plugin ${state.definition.id} service ${svc.id} prepare failed: ${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: state.definition.id, serviceId: svc.id },
          );
    }
  }
}

/** Starts services in declaration order; rolls back started services in reverse order on error. */
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
    if (err instanceof HelmxError) {
      if (stopErrors.length > 0) {
        throw new HelmxError(err.code, err.message, err.status, {
          ...(err.details as object),
          stopErrors,
        });
      }
      throw err;
    }
    throw new HelmxError(
      'plugin_service_start_failed',
      `Plugin ${state.definition.id} service failed to start: ${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, stopErrors },
    );
  }
}

/**
 * Stops already-started services in reverse declaration order during startup-barrier rollback,
 * aggregating all stop errors cleanly.
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
    throw new HelmxError(
      'plugin_service_stop_failed',
      `Failed to stop plugin ${state.definition.id} services during rollback: ${errors.map((e) => e.serviceId).join(', ')}`,
      500,
      { pluginId: state.definition.id, stopErrors: errors },
    );
  }
}

/** Stops started services in reverse declaration order during cleanup, returning collected stop errors. */
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
 * Global startup barrier: prepares all enabled plugins first, then starts each plugin in order;
 * rolls back started services atomically on any failure.
 */
export async function startServiceBarrier(
  enabledPlugins: PluginState[],
): Promise<void> {
  // Phase 1: global prepare pass
  for (const state of enabledPlugins) {
    await prepareServices(state);
  }

  // Phase 2: global start pass (rollback in reverse order on failure)
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
            rollbackErr instanceof HelmxError &&
            Array.isArray((rollbackErr.details as { stopErrors?: unknown })?.stopErrors)
              ? (rollbackErr.details as {
                  stopErrors: Array<{ serviceId: string; error: JsonSafeErrorInfo }>;
                }).stopErrors
              : [{ serviceId: '<unknown>', error: toJsonSafeError(rollbackErr) }],
        });
      }
    }
    if (rollbackStopErrors.length > 0) {
      if (err instanceof HelmxError) {
        throw new HelmxError(err.code, err.message, err.status, {
          ...((err.details as object) ?? {}),
          rollbackStopErrors,
        });
      }
      throw new HelmxError(
        'plugin_service_start_failed',
        `Plugin service failed to start: ${err instanceof Error ? err.message : String(err)}`,
        500,
        { rollbackStopErrors },
      );
    }
    throw err;
  }
}

/**
 * Collects persistent resource usages declared by started services before disable/unregister.
 * Rejects explicitly (`500 plugin_in_use_check_failed`) if `inUse()` throws or returns an invalid shape.
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
      throw new HelmxError(
        'plugin_in_use_check_failed',
        `Plugin ${pluginId} service ${svc.id} inUse check threw an error; refusing disable`,
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
      throw new HelmxError(
        'plugin_in_use_check_failed',
        `Plugin ${pluginId} service ${svc.id} inUse must return an array of { kind, id, label } non-empty strings`,
        500,
        { pluginId, serviceId: svc.id, returned: String(declared) },
      );
    }
    out.push(...declared);
  }
  return out;
}

/**
 * Pre-disable/unregister gate for in-flight tasks: aggregates `PluginTaskTracker` active labels
 * with `service.liveTasks()` labels (`409 plugin_has_live_tasks` if non-empty; `500` if `liveTasks` throws/is invalid).
 */
export function assertNoLiveTasks(
  pluginId: string,
  state: PluginState | undefined,
  tracker: PluginTaskTracker,
): void {
  const labels: string[] = [];
  if (state) {
    for (const svc of state.services) {
      if (!svc.started || svc.liveTasks === undefined) continue;
      let declared: string[];
      try {
        declared = svc.liveTasks();
      } catch (err) {
        throw new HelmxError(
          'plugin_live_tasks_check_failed',
          `Plugin ${pluginId} service ${svc.id} liveTasks check threw an error; refusing disable/unregister`,
          500,
          { pluginId, serviceId: svc.id, error: toJsonSafeError(err) },
        );
      }
      if (
        !Array.isArray(declared) ||
        declared.some((item) => typeof item !== 'string')
      ) {
        throw new HelmxError(
          'plugin_live_tasks_check_failed',
          `Plugin ${pluginId} service ${svc.id} liveTasks must return a string array, got ${Object.prototype.toString.call(declared)}`,
          500,
          { pluginId, serviceId: svc.id, returned: String(declared) },
        );
      }
      labels.push(...declared);
    }
  }
  // Check tracker after synchronous `svc.liveTasks()` so any task spawned during that call is also caught.
  labels.push(...tracker.activeLabels(pluginId));
  if (labels.length > 0) {
    throw new HelmxError(
      'plugin_has_live_tasks',
      `Plugin ${pluginId} still has ${labels.length} live task(s) (${labels.join(', ')}); refusing disable/unregister`,
      409,
      { pluginId, activeTasks: labels },
    );
  }
}
