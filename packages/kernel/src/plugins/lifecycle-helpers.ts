/**
 * plugin lifecycle auxiliary function: define validate, start stop persist decide, asset clean up and terminal state error aggregate.
 */
import {
  HelmError,
  parseNonEmptyLocalizedText,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helm/protocol';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginTaskTracker } from './tracking.js';
import type { UiRegistry } from './ui-registry.js';
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
    throw new HelmError('invalid_plugin_definition', 'plugin define missing id', 400);
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(definition.id)) {
    throw new HelmError('invalid_plugin_definition', `plugin id only allows character parent number : _ -:${definition.id}`, 400);
  }
  // Display copy boundary guard: a plain string or a per-locale map with
  // supported locale keys and non-blank copy (same rule for builtin and
  // external plugins — no ID special-casing).
  for (const field of ['name', 'description'] as const) {
    const value = definition[field];
    if (value !== undefined && parseNonEmptyLocalizedText(value) === undefined) {
      throw new HelmError(
        'invalid_plugin_definition',
        `plugin ${definition.id}  ${field} must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`,
        400,
        { pluginId: definition.id, field },
      );
    }
  }
  if (typeof definition.definePlugin !== 'function') {
    throw new HelmError('invalid_plugin_definition', `plugin ${definition.id} missing definePlugin function`, 400);
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
      `plugin ${definition.id}  clientRoot must be excludes .. segment across platform absolute directory path (POSIX /,Windows symbol or UNC)`,
      400,
      { pluginId: definition.id },
    );
  }
}

/** plugin between dependency ID character collection (and plugin id same collection: character parent number : _ -). */
const PLUGIN_DEPENDENCY_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * dependency declaration boundary archive one: optional array, one by one items must be non-empty and match plugin id character collection string;
 * by declaration order dedupe (duplicate is not error, but diagram and manifest only keep a); self dependency is length 1 
 * ring route, in this directly explicit reject. return archive one after list (without dependency when is empty array).
 */
export function normalizeDependencies(definition: PluginDefinition): string[] {
  const deps = definition.dependencies;
  if (deps === undefined) return [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !PLUGIN_DEPENDENCY_ID_PATTERN.test(d))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `plugin ${definition.id}  dependencies must be plugin ID string array (only allows character parent number : _ -, unsupported version note symbol)`,
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
        `plugin ${definition.id} declaration self dependency (dependency graph ring route)`,
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
 * dependency graph ring route detect: from start point plugin dependency declaration starting from, along registered plugin dependency edge deep takes precedence,
 * back to start point i.e. into ring. return ring route on plugin ID sequence (do not into ring return undefined). only append trace
 * registered node (start point dependency via startDependencies inject; not registered dependency is enable phase
 * missing error, is not ring).
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
 * dependency topology sort (determinism Kahn): input keep register order, only count set inside dependency edge (dependency
 * set outside/not registered plugin edge does not participate sort); same layer point by register order out queue, by dependency first out.
 * input already without ring (register boundary reject ring route); guard against defend honor bottom: if detect to ring, throw
 * plugin_dependency_cycle while is not infinite loop.
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
        // same layer keep register order: queue items by original register order insert (dependentsOf itself by register order append,
        // and queued guard against duplicate; many source also unlock when out queue order by unlock order decide, determinism is enough).
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
      `plugin dependency graph store in ring route, cannot topology sort:${stuck.join(' -> ')}`,
      409,
      { pluginIds: stuck },
    );
  }
  return out;
}

export function assertNotLocked(state: PluginState): void {
  if (state.definition.locked === true) {
    throw new HelmError('plugin_locked', `plugin ${state.definition.id} already lock, forbidden deactivate/unload`, 403, {
      pluginId: state.definition.id,
    });
  }
}

/** for outside available = enabled and do not in definePlugin / deactivate transition state. */
export function assertActive(state: PluginState): void {
  if (!state.enabled || state.phase !== 'idle') {
    throw new HelmError('plugin_disabled', `plugin ${state.definition.id} not enabled or is now switch enable state`, 409, {
      pluginId: state.definition.id,
      phase: state.phase,
    });
  }
}

/** cycle inside availability guard: cycle more replace/deactivate in/deactivated one rule expires (doc handle and host asset shared use). */
export function assertContextUsable(
  state: PluginState,
  epoch: number,
  what: string,
  currentState: PluginState | undefined,
  isDisposed: boolean,
): void {
  if (isDisposed) {
    throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
  }
  if (
    currentState !== state ||
    epoch !== state.epoch ||
    state.phase === 'deactivating' ||
    !(state.phase === 'defining' || state.enabled)
  ) {
    throw new HelmError(
      'plugin_context_expired',
      `plugin ${state.definition.id}  ${what} already expires (plugin deactivated or enter new enable cycle)`,
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
      `plugin ${definition.id} register failed: read durable start stop state when fails:${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: definition.id },
    );
  }
  if (persisted !== undefined && typeof persisted !== 'boolean') {
    throw new HelmError(
      'plugin_enabled_state_invalid',
      `plugin ${definition.id} durable start stop state illegal (expectation boolean value, actual:${typeof persisted}), reject register`,
      500,
      { pluginId: definition.id, persisted: String(persisted) },
    );
  }
  if (persisted !== undefined) return persisted;
  return options.enabled !== false;
}

/**
 * persist start stop state (store not implemented setEnabled when is no side effects memory mechanism).
 * failed explicit reject, by caller decide rollback (enable) or aggregate diagnose (disable).
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
      `plugin ${state.definition.id} start stop state persist failed:${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, enabled, persistError: toJsonSafeError(err) },
    );
  }
}

/**
 * deactivate when clean up service and Provider, release host lifecycle asset, empty capability register table.
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
      `plugin ${state.definition.id} clean up when service stop failed:${stopErrors.map((e) => e.serviceId).join(', ')}`,
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
      `plugin ${state.definition.id} clean up when provider failed to uninstall:${providerErrors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, providerErrors },
    );
  }
  if (releaseErrors.length > 0) {
    throw new HelmError(
      'plugin_resource_release_failed',
      `plugin ${state.definition.id} clean up when host asset release failed (manage protect/listen may leftover, must human core inspect)`,
      500,
      { pluginId: state.definition.id, releaseErrors },
    );
  }
}

/**
 * exception archive one is structure plugin diagnose (PluginDiagnosticError):HelmError keep
 * code/status and details, other exception wrap is plugin_execution_failed.
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
    `plugin ${pluginId} register failed:${err instanceof Error ? err.message : String(err)}`,
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
    `plugin ${pluginId} enable failed:${err instanceof Error ? err.message : String(err)}`,
    500,
    { pluginId, ...(rollbackError ? { rollbackError } : {}) },
  );
}

export function pluginSummaryOf(
  state: PluginState,
  capabilityRegistry: CapabilityRegistry,
  uiRegistry?: UiRegistry,
): PluginSummary {
  const failed = state.lastError !== undefined;
  const active = state.enabled && state.phase === 'idle';
  const clientHashes = active ? uiRegistry?.getClientHashes(state.definition.id) : undefined;
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
    ...(clientHashes !== undefined ? { clientHashes } : {}),
  };
}

export function getActiveEnabledPluginIds(plugins: Map<string, PluginState>): string[] {
  const ids: string[] = [];
  for (const [id, s] of plugins) {
    // manifest visible want seek enabled+idle: split destroy phase (disable already placement phase=deactivating while
    // enabled not yet false,teardown until clearRegistrations between) plugin must from
    // tool/action/routing/UI manifest i.e. when disappear, no longer to already stop service dispatch new request.register and
    // enable  enabled and idle is sync adjacent placement, missingenabled already placement while phase
    // not idlestartup phase window, manifest appear when machine do not change.
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
  // inverse dependency topology order split destroy: dependency first dry dependency it plugin stop (dependency it plugin first stop, by dependency
  // after stop); without dependency closure system plugin keep register order inverse order, and since has behavior consistent.
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
      `dispose when part plugin clean up failed:${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}

/**
 * settleLifecycleChanged: start stop persist failed (persistError) and stop error
 * same layer aggregate. three heavy failed (stop + persist + event publish) when with stop diagnose is main chain, the rest
 * JSON-safe archive one after attach details, never static default becomes feature, also never let after error mask first diagnose.
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
      `plugin ${state.definition.id} deactivated, but start stop state persist failed:${persistError.err instanceof Error ? persistError.err.message : String(persistError.err)}`,
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
      `plugin ${state.definition.id} completed actual deactivate/remove, but service stop and plugin.changed event publish double double failed`,
      500,
      { pluginId: state.definition.id, stopError: toJsonSafeError(stopError!.err), ...extras },
    );
  }
  throw primary!.err;
}
