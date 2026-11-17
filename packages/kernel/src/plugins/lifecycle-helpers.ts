/**
 * Plugin lifecycle helpers: definition validation, enablement persistence, cleanup,
 * terminal error projection, and PluginSummary construction.
 */
import {
  HelmError,
  parseNonEmptyLocalizedText,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helm/protocol';
import { redactJsonValue } from '../redact.js';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginTaskTracker } from './tracking.js';
import type { UiRegistry } from './ui-registry.js';
import {
  isCrossPlatformAbsolutePath,
  jsonClone,
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
    throw new HelmError('invalid_plugin_definition', 'Plugin definition is missing id', 400);
  }
  if (!/^[A-Za-z0-9:_-]+$/.test(definition.id)) {
    throw new HelmError('invalid_plugin_definition', `Plugin id may only contain letters, digits, :, _, or -: ${definition.id}`, 400);
  }
  // Display copy boundary guard: a plain string or a per-locale map with
  // supported locale keys and non-blank copy (same rule for builtin and
  // external plugins — no ID special-casing).
  for (const field of ['name', 'description'] as const) {
    const value = definition[field];
    if (value !== undefined && parseNonEmptyLocalizedText(value) === undefined) {
      throw new HelmError(
        'invalid_plugin_definition',
        `Plugin ${definition.id} ${field} must be display copy (non-empty string or { en, 'zh-CN' } map with non-blank values)`,
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

/** Allowed characters for plugin dependency identifiers (`[A-Za-z0-9:_-]+`). */
const PLUGIN_DEPENDENCY_ID_PATTERN = /^[A-Za-z0-9:_-]+$/;

/**
 * Normalizes and validates plugin `dependencies`: deduplicates in declaration order and rejects
 * invalid identifiers or self-dependencies (`cycle` of length 1).
 */
export function normalizeDependencies(definition: PluginDefinition): string[] {
  const deps = definition.dependencies;
  if (deps === undefined) return [];
  if (!Array.isArray(deps) || deps.some((d) => typeof d !== 'string' || !PLUGIN_DEPENDENCY_ID_PATTERN.test(d))) {
    throw new HelmError(
      'invalid_plugin_definition',
      `Plugin ${definition.id} dependencies must be an array of plugin IDs (letters, digits, :, _, - only; version specifiers not supported)`,
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
        `Plugin ${definition.id} declared a self-dependency cycle`,
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
 * Detects dependency cycles via DFS along already-registered plugins; returns the cycle path
 * or `undefined` if acyclic. Unregistered dependencies are ignored here and validated on enable.
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
 * Deterministic Kahn topological sort preserving registration order within each layer (dependencies first).
 * Defensive cycle check throws `plugin_dependency_cycle` instead of spinning forever.
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
      `Plugin dependency graph contains a cycle and cannot be sorted: ${stuck.join(' -> ')}`,
      409,
      { pluginIds: stuck },
    );
  }
  return out;
}

export function assertNotLocked(state: PluginState): void {
  if (state.definition.locked === true) {
    throw new HelmError('plugin_locked', `Plugin ${state.definition.id} is locked and cannot be disabled or unregistered`, 403, {
      pluginId: state.definition.id,
    });
  }
}

/** Active for external callers = enabled and idle (not in `defining` or `deactivating` transitions). */
export function assertActive(state: PluginState): void {
  if (!state.enabled || state.phase !== 'idle') {
    throw new HelmError('plugin_disabled', `Plugin ${state.definition.id} is disabled or transitioning`, 409, {
      pluginId: state.definition.id,
      phase: state.phase,
    });
  }
}

/** Guards epoch-bound handles (`doc`, `sessionDoc`, `host` ports) against stale/disabled/disposed cycles. */
export function assertContextUsable(
  state: PluginState,
  epoch: number,
  what: string,
  currentState: PluginState | undefined,
  isDisposed: boolean,
): void {
  if (isDisposed) {
    throw new HelmError('plugin_host_disposed', 'PluginHost has already been disposed', 409);
  }
  if (
    currentState !== state ||
    epoch !== state.epoch ||
    state.phase === 'deactivating' ||
    !(state.phase === 'defining' || state.enabled)
  ) {
    throw new HelmError(
      'plugin_context_expired',
      `Plugin ${state.definition.id} ${what} has expired (plugin disabled or cycled)`,
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
      `Plugin ${definition.id} registration failed while reading persisted enablement state: ${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: definition.id },
    );
  }
  if (persisted !== undefined && typeof persisted !== 'boolean') {
    throw new HelmError(
      'plugin_enabled_state_invalid',
      `Plugin ${definition.id} has invalid persisted enablement state (expected boolean, got ${typeof persisted})`,
      500,
      { pluginId: definition.id, persisted: String(persisted) },
    );
  }
  if (persisted !== undefined) return persisted;
  return options.enabled !== false;
}

/** Persists enablement state when `setEnabled` is wired; rejects on write failure so callers roll back or surface diagnostics. */
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
      `Failed to persist enablement state for plugin ${state.definition.id}: ${err instanceof Error ? err.message : String(err)}`,
      500,
      { pluginId: state.definition.id, enabled, persistError: toJsonSafeError(err) },
    );
  }
}

/** Stops services, unregisters providers, releases host handles, and clears registries during disable/cleanup. */
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
      `Plugin ${state.definition.id} failed to stop services during cleanup: ${stopErrors.map((e) => e.serviceId).join(', ')}`,
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
      `Plugin ${state.definition.id} failed to unregister providers during cleanup: ${providerErrors.map((e) => e.providerId).join(', ')}`,
      500,
      { pluginId: state.definition.id, providerErrors },
    );
  }
  if (releaseErrors.length > 0) {
    throw new HelmError(
      'plugin_resource_release_failed',
      `Plugin ${state.definition.id} failed to release host resources during cleanup (guards/listeners may remain; check kernel logs)`,
      500,
      { pluginId: state.definition.id, releaseErrors },
    );
  }
}

/** Normalizes any thrown error into a JSON-safe `PluginDiagnosticError` preserving HelmError code/status/details. */
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
    `Plugin ${pluginId} registration failed: ${err instanceof Error ? err.message : String(err)}`,
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
    `Failed to enable plugin ${pluginId}: ${err instanceof Error ? err.message : String(err)}`,
    500,
    { pluginId, ...(rollbackError ? { rollbackError } : {}) },
  );
}

/** Projects non-secret effective config fields declared in `state.configSchema` (with redaction). */
export function buildPublicConfig(
  state: PluginState,
  rawConfig: Record<string, unknown>,
  redactText?: (text: string) => string,
): Record<string, unknown> | undefined {
  const schema = state.configSchema;
  if (!schema) return undefined;
  let hasPublicField = false;
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema)) {
    if (field.secret === true) continue;
    hasPublicField = true;
    if (Object.hasOwn(rawConfig, key) && rawConfig[key] !== undefined) {
      out[key] = jsonClone(rawConfig[key]);
    }
  }
  if (!hasPublicField) return undefined;
  return redactText ? (redactJsonValue(out, redactText) as Record<string, unknown>) : out;
}

export function pluginSummaryOf(
  state: PluginState,
  capabilityRegistry: CapabilityRegistry,
  uiRegistry?: UiRegistry,
  publicConfig?: Record<string, unknown>,
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
    ...(publicConfig !== undefined ? { publicConfig } : {}),
  };
}

export function getActiveEnabledPluginIds(plugins: Map<string, PluginState>): string[] {
  const ids: string[] = [];
  for (const [id, s] of plugins) {
    // External catalog visibility requires enabled + idle: during disable teardown (`phase === 'deactivating'`
    // before `clearRegistrations`), plugins leave tool/action/route/UI lists immediately.
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
  // Tear down in reverse dependency order so dependents stop before their dependencies.
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
      `Failed to clean up some plugins during dispose: ${errors.map((e) => e.pluginId).join(', ')}`,
      500,
      { errors },
    );
  }
}

/**
 * Aggregates stop errors, enablement persistence errors, and `plugin.changed` broadcast errors
 * without masking primary diagnostics.
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
      `Plugin ${state.definition.id} was disabled, but persisting enablement state failed: ${persistError.err instanceof Error ? persistError.err.message : String(persistError.err)}`,
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
      `Plugin ${state.definition.id} completed disable/removal, but both service stop and plugin.changed emission failed`,
      500,
      { pluginId: state.definition.id, stopError: toJsonSafeError(stopError!.err), ...extras },
    );
  }
  throw primary!.err;
}
