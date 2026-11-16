/**
 * plugin state migration auxiliary: register clean up, fault isolated/rollback, occupy register,UI declaration validate and hosting summary group install.
 */
import { join } from 'node:path';
import {
  HelmError,
  type HookName,
  type LocalizedText,
  type PluginConfigFieldSchema,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginSummary,
} from '@helm/protocol';
import type { CapabilityRegistry } from './capability-registry.js';
import type { PluginDocRegistry } from './doc-registry.js';
import type { HookPipeline } from './hooks.js';
import {
  persistEnabled,
  pluginSummaryOf,
  teardownPlugin,
  toDiagnosticError,
  wrapEnableError,
  wrapRegistrationError,
} from './lifecycle-helpers.js';
import type { PluginPackageManagerStore } from './package-store.js';
import { pluginDataDirName } from './plugin-dir-name.js';
import { toJsonSafeError, type JsonSafeErrorInfo } from './shared.js';
import type { PluginTaskTracker } from './tracking.js';
import type { PluginConfigStore, PluginState } from './types.js';
import type { UiRegistry } from './ui-registry.js';
import { assertUiCompleterActionBindings, assertUiDocsRegistered } from './ui-validation.js';

export interface PluginHostRegistries {
  pipelines: ReadonlyMap<HookName, HookPipeline<HookName>>;
  capabilityRegistry: CapabilityRegistry;
  uiRegistry: UiRegistry;
  docRegistry: PluginDocRegistry;
}

export interface PluginTransitionContext extends PluginHostRegistries {
  plugins: Map<string, PluginState>;
  tracker: PluginTaskTracker;
  configStore?: PluginConfigStore;
  dataDir: string;
  emitPluginChanged: (state: PluginState) => void;
}

export function requirePlugin(
  plugins: ReadonlyMap<string, PluginState>,
  pluginId: string,
): PluginState {
  const state = plugins.get(pluginId);
  if (!state) throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId });
  return state;
}

export function removePluginRegistries(
  pluginId: string,
  registries: Pick<PluginHostRegistries, 'capabilityRegistry' | 'uiRegistry' | 'docRegistry'>,
): void {
  registries.capabilityRegistry.removePlugin(pluginId);
  registries.uiRegistry.removePlugin(pluginId);
  registries.docRegistry.removePlugin(pluginId);
}

export function clearPluginRegistrations(
  state: PluginState,
  registries: PluginHostRegistries,
): void {
  const pluginId = state.definition.id;
  for (const pipeline of registries.pipelines.values()) {
    pipeline.removeByPlugin(pluginId);
  }
  state.hooks.clear();
  state.services.length = 0;
  state.providers.length = 0;
  state.hostReleases.clear();
  removePluginRegistries(pluginId, registries);
}

export async function teardownPluginState(
  state: PluginState,
  opts: { stopServices: boolean },
  registries: PluginHostRegistries,
): Promise<void> {
  await teardownPlugin(state, opts, (s) => clearPluginRegistrations(s, registries));
}

/**
 * external plugin isolated rollback: clean up already register capability and mount asset, keep failed occupy do not to on throws.
 */
export async function rollbackIsolatedPlugin(
  state: PluginState,
  err: unknown,
  stage: PluginDiagnosticError['stage'],
  ctx: PluginTransitionContext,
): Promise<void> {
  try {
    await teardownPluginState(state, { stopServices: stage === 'enable' }, ctx);
  } catch {
    // clean up failed do not mask original diagnose
  }
  clearPluginRegistrations(state, ctx);
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  state.lastError = toDiagnosticError(err, stage);
  ctx.emitPluginChanged(state);
}

export function purgePluginEntries(
  pluginId: string,
  ctx: Pick<PluginTransitionContext, 'plugins' | 'tracker' | 'capabilityRegistry' | 'uiRegistry' | 'docRegistry'>,
): void {
  ctx.plugins.delete(pluginId);
  ctx.tracker.removePlugin(pluginId);
  removePluginRegistries(pluginId, ctx);
}

export async function rollbackAndRemovePlugin(
  state: PluginState,
  seq: number,
  err: unknown,
  stopServices: boolean,
  ctx: PluginTransitionContext,
): Promise<never> {
  let rollbackError: JsonSafeErrorInfo | undefined;
  try {
    await teardownPluginState(state, { stopServices }, ctx);
  } catch (rollbackErr) {
    rollbackError = toJsonSafeError(rollbackErr);
  }
  state.enabled = false;
  const pluginId = state.definition.id;
  purgePluginEntries(pluginId, ctx);
  throw wrapRegistrationError(pluginId, seq, err, rollbackError);
}

export async function rollbackEnablePlugin(
  state: PluginState,
  prevConfigSchema: Record<string, PluginConfigFieldSchema> | null,
  err: unknown,
  persistedEnabled: boolean,
  ctx: PluginTransitionContext,
): Promise<never> {
  let rollbackError: JsonSafeErrorInfo | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (teardownErr) {
    rollbackError = toJsonSafeError(teardownErr);
  }
  clearPluginRegistrations(state, ctx);
  state.configSchema = prevConfigSchema;
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  if (persistedEnabled && ctx.configStore?.setEnabled) {
    try {
      await persistEnabled(ctx.configStore, state, false);
    } catch (persistErr) {
      rollbackError = rollbackError ?? toJsonSafeError(persistErr);
    }
  }
  const pluginId = state.definition.id;
  if (!pluginId.startsWith('builtin:')) {
    state.lastError = toDiagnosticError(err, 'enable');
    ctx.emitPluginChanged(state);
  }
  throw wrapEnableError(pluginId, err, rollbackError);
}

/**
 * external plugin fault occupy register (scan / load phase failed, without valid definition):
 * in plugins in register (or update)loadFailed occupy item, never override same name real plugin.
 */
export function registerFailedPlaceholder(
  spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  },
  ctx: PluginTransitionContext,
): void {
  const existing = ctx.plugins.get(spec.id);
  if (existing !== undefined && !existing.loadFailed) {
    throw new HelmError(
      'plugin_already_registered',
      `plugin ${spec.id} registered (and fault occupy conflict), reject override`,
      409,
      { pluginId: spec.id },
    );
  }
  const definition: PluginDefinition = {
    id: spec.id,
    name: spec.name ?? spec.id,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.version !== undefined ? { version: spec.version } : {}),
    definePlugin() {},
  };
  const state: PluginState =
    existing ??
    ({
      definition,
      dependencies: [],
      enabled: false,
      phase: 'idle',
      epoch: 1,
      dataDir: join(ctx.dataDir, 'plugins', pluginDataDirName(spec.id)),
      hooks: new Set(),
      services: [],
      providers: [],
      configSchema: null,
      hostReleases: new Set(),
      stopWindow: false,
    } satisfies PluginState);
  state.definition = definition;
  state.dependencies = [];
  state.enabled = false;
  state.phase = 'idle';
  state.epoch += 1;
  state.loadFailed = true;
  state.lastError = spec.error;
  clearPluginRegistrations(state, ctx);
  ctx.plugins.set(spec.id, state);
  ctx.emitPluginChanged(state);
}

export function validateUiDeclarations(
  pluginId: string,
  crossPlugin: boolean,
  deps: Pick<PluginHostRegistries, 'uiRegistry' | 'docRegistry' | 'capabilityRegistry'> & {
    plugins: Map<string, PluginState>;
  },
): void {
  assertUiDocsRegistered(
    pluginId,
    deps.uiRegistry,
    (name) => deps.docRegistry.hasPublicDoc(pluginId, name),
    (name) => deps.docRegistry.hasPublicSessionDoc(pluginId, name),
  );
  assertUiCompleterActionBindings(
    pluginId,
    deps.uiRegistry,
    deps.capabilityRegistry,
    deps.plugins,
    crossPlugin,
  );
}

export function summaryWithManagedPackage(
  state: PluginState,
  capabilityRegistry: CapabilityRegistry,
  uiRegistry: UiRegistry,
  packageStore?: PluginPackageManagerStore,
): PluginSummary {
  const base = pluginSummaryOf(state, capabilityRegistry, uiRegistry);
  const record = packageStore?.getRecord(base.id);
  if (record === undefined || base.id.startsWith('builtin:')) return base;
  return {
    ...base,
    managed: {
      source: record.source,
      installId: record.id,
      installedVersion: record.version,
      installedAt: record.updatedAt,
    },
  };
}
