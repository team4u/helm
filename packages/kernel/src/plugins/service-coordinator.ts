/**
 * plugin service declaration, lifecycle screen fault (prepare -> start -> stop) and managed asset trace.
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
 * in subject to control stop doc write window inside execute service stop:stop during (contains engine close internal
 * by abort wake async settle chain) this plugin this cycle ctx.doc handle eventually persist write
 * and STOP_WINDOW_HOST_CALLS by let through (phase is deactivating when no longer reject);stop return (succeeded/failed) i.e.
 * re- window, after everything write restore common rule reject. window by PluginState mark record while non- async on under
 * text pass broadcast: engine settle chain promise in stop before create,AsyncLocalStorage cannot
 * across exceeds already exists promise boundary.
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

/** plugin inside all service prepare(by declaration order; without prepare service skip; each service only execute once). */
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
            `plugin ${state.definition.id} service ${svc.id} prepare failed:${err instanceof Error ? err.message : String(err)}`,
            500,
            { pluginId: state.definition.id, serviceId: svc.id },
          );
    }
  }
}

/** by declaration order start service; any one failed for already start inverse to stop(stop failed aggregate enter diagnose). */
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
      `plugin ${state.definition.id} service failed to start:${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, stopErrors },
    );
  }
}

/**
 * after startup failed inverse to stop: aggregate each service stop error (teardown same style aggregate),
 * deactivated item skip; used to start screen fault phase 2 rollback.
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
      `rollback stop plugin ${state.definition.id} service when failed:${errors.map((e) => e.serviceId).join(', ')}`,
      500,
      { pluginId: state.definition.id, stopErrors: errors },
    );
  }
}

/**
 * clean up when inverse to stop plugin already start service, return aggregate stop error list.
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
 * explicit start screen fault: first for all enabled plugin one by one execute service prepare,
 * again one by one plugin by declaration order start(atomicity screen fault: any one failed i.e. moment rollback and explicit throws).
 */
export async function startServiceBarrier(
  enabledPlugins: PluginState[],
): Promise<void> {
  // phase 1: global prepare first row
  for (const state of enabledPlugins) {
    await prepareServices(state);
  }

  // phase 2: global start(atomicity rollback: any one failed inverse order stop already start plugin service)
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
        `plugin service failed to start:${err instanceof Error ? err.message : String(err)}`,
        500,
        { rollbackStopErrors },
      );
    }
    throw err;
  }
}

/**
 * deactivate/unload before durable asset occupy aggregate: iterate already start and declaration inUse service, merge
 * return value. service inUse throws or return illegal shape when explicit plugin_in_use_check_failed
 * (unknown i.e. occupy principle), never static default when empty let through.
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
        `plugin ${pluginId} service ${svc.id}  inUse check throw exception, by occupy handle reject deactivate`,
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
        `plugin ${pluginId} service ${svc.id}  inUse must return { kind, id, label } all is non-empty string array`,
        500,
        { pluginId, serviceId: svc.id, returned: String(declared) },
      );
    }
    out.push(...declared);
  }
  return out;
}

/**
 * deactivate/unload before in-flight task gate:tracker task + already start service declaration liveTasks tag
 * take and collection, has any one i.e. 409 reject (does not enter stop, do not change durable switch).liveTasks exception or
 * return non- string array when exception/illegal output such as explicit errors, never static default when empty - - plugin declaration
 * keep-alive check broken then must fix, cannot rely guess let through.
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
        throw new HelmError(
          'plugin_live_tasks_check_failed',
          `plugin ${pluginId} service ${svc.id}  liveTasks check throw exception, reject deactivate/unload`,
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
          `plugin ${pluginId} service ${svc.id}  liveTasks must return string array, actual:${Object.prototype.toString.call(declared)}`,
          500,
          { pluginId, serviceId: svc.id, returned: String(declared) },
        );
      }
      labels.push(...declared);
    }
  }
  // tracker tag finally read:svc.liveTasks is any sync plugin code, during sync start task
  //(such as sync invoke invokeAction) also will by tail read catch; read completely after until caller placement deactivating
  // without await, gate closed together without window.
  labels.push(...tracker.activeLabels(pluginId));
  if (labels.length > 0) {
    throw new HelmError(
      'plugin_has_live_tasks',
      `plugin ${pluginId} still has ${labels.length} in-flight task (${labels.join(', ')}), reject deactivate/unload`,
      409,
      { pluginId, activeTasks: labels },
    );
  }
}
