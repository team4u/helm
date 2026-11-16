/**
 * plugin register, deregister, enable and deactivate lifecycle transaction stream process.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { HelmError, type HelmPluginContext, type PluginDefinition } from '@helm/protocol';
import {
  assertNotLocked,
  getActiveEnabledPluginIds,
  normalizeDependencies,
  persistEnabled,
  resolveInitialEnabled,
  settleLifecycleChanged,
} from './lifecycle-helpers.js';
import { pluginDataDirName } from './plugin-dir-name.js';
import { activatePluginServices } from './plugin-host-barrier.js';
import {
  assertDependenciesSatisfied,
  assertNoDependencyCycle,
  assertNoEnabledDependents,
  markDependentsBroken,
} from './plugin-host-deps.js';
import { collectPluginInUse } from './plugin-host-inuse.js';
import {
  clearPluginRegistrations,
  purgePluginEntries,
  requirePlugin,
  rollbackAndRemovePlugin,
  rollbackEnablePlugin,
  rollbackIsolatedPlugin,
  teardownPluginState,
  validateUiDeclarations,
  type PluginTransitionContext,
} from './plugin-host-transitions.js';
import { assertProvidersIdle, registerProviders } from './provider-coordinator.js';
import { assertNoLiveTasks } from './service-coordinator.js';
import type { PluginHostBackend, PluginProviderPort, PluginState } from './types.js';

export interface PluginLifecycleContext extends PluginTransitionContext {
  host: PluginHostBackend;
  providers?: PluginProviderPort;
  servicesStarted: boolean;
  createPluginContext: (state: PluginState, epoch: number) => HelmPluginContext;
}

function assertPluginIdle(
  pluginId: string,
  state: PluginState,
  ctx: Pick<PluginLifecycleContext, 'tracker' | 'providers'>,
): void {
  assertNoLiveTasks(pluginId, state, ctx.tracker);
  assertProvidersIdle(pluginId, state, ctx.providers);
}

async function handleRegisterFailure(
  state: PluginState,
  seq: number,
  err: unknown,
  opts: { isolate: boolean; stage: 'define' | 'enable'; stopServices: boolean },
  ctx: PluginLifecycleContext,
): Promise<void> {
  if (opts.isolate) {
    await rollbackIsolatedPlugin(state, err, opts.stage, ctx);
    return;
  }
  await rollbackAndRemovePlugin(state, seq, err, opts.stopServices, ctx);
}

async function runDefinition(state: PluginState, ctx: PluginLifecycleContext): Promise<void> {
  await state.definition.definePlugin(ctx.createPluginContext(state, state.epoch));
  validateUiDeclarations(state.definition.id, false, ctx);
}

function assertEnableCommitChecks(state: PluginState, ctx: PluginLifecycleContext): void {
  const pluginId = state.definition.id;
  ctx.uiRegistry.assertCrossPluginUnique(pluginId, getActiveEnabledPluginIds(ctx.plugins));
  validateUiDeclarations(pluginId, true, ctx);
  assertDependenciesSatisfied(ctx.plugins, pluginId, state.dependencies);
}

function commitEnabled(state: PluginState): void {
  state.enabled = true;
  state.phase = 'idle';
}

export async function runRegisterTransaction(
  definition: PluginDefinition,
  options: { enabled?: boolean; isolateFailure?: boolean },
  seq: number,
  isolate: boolean,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const pluginId = definition.id;
  if (ctx.plugins.has(pluginId)) {
    throw new HelmError('plugin_already_registered', `plugin registered:${pluginId}`, 409, { pluginId });
  }
  const dependencies = normalizeDependencies(definition);
  assertNoDependencyCycle(ctx.plugins, pluginId, dependencies);

  const wantsEnabled = resolveInitialEnabled(definition, ctx.configStore, options);
  if (wantsEnabled) assertDependenciesSatisfied(ctx.plugins, pluginId, dependencies);
  const dataDir = join(ctx.dataDir, 'plugins', pluginDataDirName(pluginId));
  mkdirSync(dataDir, { recursive: true });

  const state: PluginState = {
    definition,
    dependencies,
    enabled: false,
    phase: 'defining',
    epoch: 1,
    dataDir,
    hooks: new Set(),
    services: [],
    providers: [],
    configSchema: null,
    hostReleases: new Set(),
    stopWindow: false,
    ...(isolate ? { isolateFailure: true } : {}),
  };
  ctx.plugins.set(pluginId, state);

  try {
    await runDefinition(state, ctx);
  } catch (err) {
    await handleRegisterFailure(state, seq, err, { isolate, stage: 'define', stopServices: false }, ctx);
    return;
  }

  if (wantsEnabled) {
    try {
      // commit point final inspect first at mount, then sync placement enabled+idle avoid manifest first expose out capability
      assertEnableCommitChecks(state, ctx);
      await registerProviders(state, ctx.providers);
      await activatePluginServices(state, ctx.servicesStarted);
      commitEnabled(state);
    } catch (err) {
      await handleRegisterFailure(state, seq, err, { isolate, stage: 'enable', stopServices: true }, ctx);
      return;
    }
  } else {
    try {
      await teardownPluginState(state, { stopServices: false }, ctx);
    } catch (err) {
      await handleRegisterFailure(state, seq, err, { isolate, stage: 'define', stopServices: false }, ctx);
      return;
    }
    state.epoch += 1;
    state.phase = 'idle';
  }
  ctx.emitPluginChanged(state);
}

export async function runUnregisterTransaction(
  pluginId: string,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  assertNotLocked(state);
  assertNoEnabledDependents(ctx.plugins, pluginId);
  if (!state.enabled) {
    await teardownPluginState(state, { stopServices: false }, ctx);
    purgePluginEntries(pluginId, ctx);
    ctx.emitPluginChanged(state);
    return;
  }
  assertPluginIdle(pluginId, state, ctx);
  state.phase = 'deactivating';
  let stopError: { err: unknown } | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (err) {
    stopError = { err };
  }
  state.enabled = false;
  purgePluginEntries(pluginId, ctx);
  settleLifecycleChanged(state, stopError, undefined, () => ctx.emitPluginChanged(state));
}

export async function runEnableTransaction(
  pluginId: string,
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  if (state.enabled) return;
  if (state.loadFailed === true) {
    throw new HelmError(
      'plugin_load_failed',
      `plugin ${pluginId} failed to load (${state.lastError?.message ?? 'unknown error'}), please fix plugin source code after use reload or restart Hub`,
      409,
      { pluginId, error: state.lastError },
    );
  }
  assertDependenciesSatisfied(ctx.plugins, pluginId, state.dependencies);
  const prevConfigSchema = state.configSchema;
  state.epoch += 1;
  clearPluginRegistrations(state, ctx);
  state.configSchema = null;
  state.phase = 'defining';
  let persistedEnabled = false;
  try {
    await runDefinition(state, ctx);
    ctx.uiRegistry.assertCrossPluginUnique(pluginId, getActiveEnabledPluginIds(ctx.plugins));
    await registerProviders(state, ctx.providers);
    await activatePluginServices(state, ctx.servicesStarted);
    await persistEnabled(ctx.configStore, state, true);
    persistedEnabled = true;
    // and enabled=true same where the same sync segment, close concurrency deactivate dependency TOCTOU window
    assertEnableCommitChecks(state, ctx);
    commitEnabled(state);
    state.lastError = undefined;
  } catch (err) {
    await rollbackEnablePlugin(state, prevConfigSchema, err, persistedEnabled, ctx);
  }
  ctx.emitPluginChanged(state);
}

export async function runDisableTransaction(
  pluginId: string,
  options: { force?: boolean },
  ctx: PluginLifecycleContext,
): Promise<void> {
  const state = requirePlugin(ctx.plugins, pluginId);
  assertNotLocked(state);
  if (!state.enabled) return;
  assertPluginIdle(pluginId, state, ctx);
  if (options.force !== true) {
    const usages = await collectPluginInUse(pluginId, state, {
      plugins: ctx.plugins,
      uiRegistry: ctx.uiRegistry,
      host: ctx.host,
    });
    if (usages.length > 0) {
      throw new HelmError(
        'plugin_in_use',
        `plugin ${pluginId} store in ${usages.length} where related asset occupy, deactivate after related feature can unavailable (confirm after can pass force force deactivate)`,
        409,
        { pluginId, usages },
      );
    }
  }
  // inUse contains async IO; return after second gate and sync placement deactivating, eliminate and new task TOCTOU
  assertPluginIdle(pluginId, state, ctx);
  state.phase = 'deactivating';
  let stopError: { err: unknown } | undefined;
  try {
    await teardownPluginState(state, { stopServices: true }, ctx);
  } catch (err) {
    stopError = { err };
  }
  state.enabled = false;
  state.epoch += 1;
  state.phase = 'idle';
  state.lastError = undefined;
  if (options.force === true) {
    markDependentsBroken(ctx.plugins, pluginId, (dep) => ctx.emitPluginChanged(dep));
  }
  let persistError: { err: unknown } | undefined;
  try {
    await persistEnabled(ctx.configStore, state, false);
  } catch (err) {
    persistError = { err };
  }
  settleLifecycleChanged(state, stopError, persistError, () => ctx.emitPluginChanged(state));
}
