/**
 * PluginHost:helm unique strong type plugin host (definePlugin(ctx)).
 *
 * responsibility boundary:
 * - coordinate tune register (register), enable (enable), deactivate (disable), deregister (unregister) lifecycle;
 * - coordinate tune service start screen fault (prepare -> start) and subject to control stop (controlled stop);
 * - coordinate tune model Provider mount and unload (PluginProviderPort),HookPipeline and config persist;
 * - coordinate tune sub- register table (DocRegistry,CapabilityRegistry,UiRegistry) and task trace (PluginTaskTracker);
 * - concurrency gate control, dependency graph, service screen fault, lifecycle transaction, external DX and transition state rollback respectively delegate same directory sub- module implement.
 */
import {
  HelmError,
  type ActionManifest,
  type ConversationSummary,
  type HookName,
  type HookPayloadMap,
  type HookResult,
  type PluginActionContext,
  type PluginBuildProvider,
  type PluginClientBundle,
  type PluginConfigFieldSchema,
  type PluginConfigFieldSource,
  type PluginDefinition,
  type PluginDiagnosticError,
  type PluginDoctorReport,
  type PluginInstallResult,
  type LocalizedText,
  type PluginReloadResult,
  type PluginRemoveResult,
  type PluginRescanResult,
  type PluginSummary,
  type PluginToolContext,
  type PluginUiContribution,
  type PluginUpdateResult,
  type PublicPluginDoc,
  type PublicPluginSessionDoc,
} from '@helm/protocol';
import { HOOK_ALLOWED_ACTIONS, HookPipeline } from './hooks.js';
import { PluginTaskTracker } from './tracking.js';
import type { PluginPackageManager, PackageManagerHost } from './package-manager.js';
import type { PluginPackageManagerStore } from './package-store.js';
import { PluginDocRegistry } from './doc-registry.js';
import {
  CapabilityRegistry,
  type DerivedToolSpec,
  type PluginRouteEntry,
  parseQualifiedActionId,
} from './capability-registry.js';
import { UiRegistry } from './ui-registry.js';
import { jsonClone } from './shared.js';
import type {
  PluginConfigStore,
  PluginHostOptions,
  PluginState,
} from './types.js';
import { createPluginContext } from './plugin-context.js';
import { assertProviderAvailable } from './provider-coordinator.js';
import {
  assertActive,
  assertContextUsable,
  assertDefinition,
  disposePlugins,
  getActiveEnabledPluginIds,
  getIdleActivePluginIds,
} from './lifecycle-helpers.js';
import { PluginHostGate } from './plugin-host-gate.js';
import { enabledStatesInDependencyOrder } from './plugin-host-deps.js';
import { runServiceStartBarrier, stopEnabledPluginServices } from './plugin-host-barrier.js';
import { dispatchPluginHook, dispatchPluginHookAround } from './plugin-host-hooks.js';
import {
  registerFailedPlaceholder,
  removePluginRegistries,
  requirePlugin,
  rollbackIsolatedPlugin,
  summaryWithManagedPackage,
  teardownPluginState,
  type PluginHostRegistries,
} from './plugin-host-transitions.js';
import {
  runDisableTransaction,
  runEnableTransaction,
  runRegisterTransaction,
  runUnregisterTransaction,
  type PluginLifecycleContext,
} from './plugin-host-lifecycle.js';
import {
  createPackageManagerHost,
  doctorExternalPluginDir,
  reloadExternalPluginFlow,
  rescanExternalPluginDirs,
  type DxCoordinatorDeps,
} from './plugin-host-dx.js';

export type { PluginDocStore, PluginSessionDocStore, PluginDocRegistryOptions } from './doc-registry.js';
export { PLUGIN_DOC_MAX_JSON_BYTES } from './doc-registry.js';
export {
  type DerivedToolSpec,
  type PluginRouteEntry,
  PROVIDER_SAFE_TOOL_NAME,
  actionToolAlias,
} from './capability-registry.js';
export type {
  PluginConfigStore,
  PluginHostBackend,
  PluginHostOptions,
  PluginPhase,
  PluginProviderPort,
  PluginState,
} from './types.js';

export class PluginHost {
  private plugins = new Map<string, PluginState>();
  private pipelines = new Map<HookName, HookPipeline<HookName>>();
  private tracker = new PluginTaskTracker();
  private docRegistry: PluginDocRegistry;
  private capabilityRegistry = new CapabilityRegistry();
  private uiRegistry: UiRegistry;
  private configStore?: PluginConfigStore;
  private disposed = false;
  private registerSeq = 0;
  private servicesStarted: boolean;
  private startPromise?: Promise<void>;
  private gate = new PluginHostGate();
  private packageManager?: PluginPackageManager;
  private packageStore?: PluginPackageManagerStore;

  constructor(private readonly options: PluginHostOptions) {
    this.configStore = options.config;
    this.uiRegistry = new UiRegistry(options.buildProvider);
    this.servicesStarted = options.deferServices !== true;
    for (const name of Object.keys(HOOK_ALLOWED_ACTIONS) as HookName[]) {
      this.pipelines.set(name, new HookPipeline(name));
    }
    this.docRegistry = new PluginDocRegistry(
      options.docs,
      (pluginId, name, val) => this.emitDocUpdated(pluginId, name, val),
      {
        sessionStore: options.sessionDocs,
        assertConversationExists: (conversationId) => options.host.getConversation(conversationId),
        emitSessionDocUpdated: (doc) => {
          options.host.emitEvent('plugin.session_doc.updated', {
            type: 'plugin.session_doc.updated',
            doc,
          });
        },
      },
    );
  }

  // --- register and lifecycle -------------------------------------------------------

  async register(
    definition: PluginDefinition,
    options: { enabled?: boolean; isolateFailure?: boolean } = {},
  ): Promise<void> {
    this.assertNotDisposed();
    assertDefinition(definition);
    const seq = ++this.registerSeq;
    const pluginId = definition.id;
    // built-in plugin failed one rule block assert, only external plugin explicit want seek when isolated fall back
    const isolate = options.isolateFailure === true && !pluginId.startsWith('builtin:');

    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runRegisterTransaction(definition, options, seq, isolate, this.lifecycleContext());
    });
  }

  registerFailed(spec: {
    id: string;
    name?: LocalizedText;
    description?: LocalizedText;
    version?: string;
    error: PluginDiagnosticError;
  }): void {
    this.assertNotDisposed();
    registerFailedPlaceholder(spec, this.lifecycleContext());
  }

  async unregister(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runUnregisterTransaction(pluginId, this.lifecycleContext());
    });
  }

  async enable(pluginId: string): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runEnableTransaction(pluginId, this.lifecycleContext());
    });
  }

  async disable(pluginId: string, options: { force?: boolean } = {}): Promise<void> {
    this.assertNotDisposed();
    await this.gate.enqueue(pluginId, async () => {
      this.assertNotDisposed();
      await runDisableTransaction(pluginId, options, this.lifecycleContext());
    });
  }

  async start(): Promise<void> {
    this.assertNotDisposed();
    if (this.servicesStarted) return;
    if (this.startPromise) return this.startPromise;
    const run = this.gate.withWriteLock(async () => {
      if (this.servicesStarted) return;
      await runServiceStartBarrier(
        enabledStatesInDependencyOrder(this.plugins),
        (state, err) => rollbackIsolatedPlugin(state, err, 'enable', this.lifecycleContext()),
      );
      this.servicesStarted = true;
    });
    this.startPromise = run;
    try {
      await run;
    } finally {
      this.startPromise = undefined;
    }
  }

  async stop(): Promise<void> {
    this.assertNotDisposed();
    await this.gate.withWriteLock(async () => {
      if (!this.servicesStarted) return;
      try {
        await stopEnabledPluginServices(enabledStatesInDependencyOrder(this.plugins));
      } finally {
        this.servicesStarted = false;
      }
    });
  }

  // --- query and capability manifest -------------------------------------------------------

  list(): PluginSummary[] {
    this.assertNotDisposed();
    return [...this.plugins.values()].map((s) =>
      summaryWithManagedPackage(s, this.capabilityRegistry, this.uiRegistry, this.packageStore),
    );
  }

  get(pluginId: string): PluginSummary | undefined {
    this.assertNotDisposed();
    const s = this.plugins.get(pluginId);
    return s ? summaryWithManagedPackage(s, this.capabilityRegistry, this.uiRegistry, this.packageStore) : undefined;
  }

  assertProviderAvailable(pluginId: string): void {
    assertProviderAvailable(this.plugins.get(pluginId), pluginId);
  }

  listTools(conversation?: ConversationSummary): DerivedToolSpec[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listTools(getActiveEnabledPluginIds(this.plugins), conversation);
  }

  listRoutes(): PluginRouteEntry[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listRoutes(getActiveEnabledPluginIds(this.plugins));
  }

  listActions(): ActionManifest[] {
    this.assertNotDisposed();
    return this.capabilityRegistry.listActions(getActiveEnabledPluginIds(this.plugins));
  }

  listUi(): PluginUiContribution[] {
    this.assertNotDisposed();
    return this.uiRegistry.listUi(getActiveEnabledPluginIds(this.plugins));
  }

  // --- external plugin DX and managed package -------------------------------------------------

  async doctorExternalPlugin(target: { dir?: string; id?: string }): Promise<PluginDoctorReport> {
    this.assertNotDisposed();
    return doctorExternalPluginDir(
      { dataDir: this.options.dataDir, buildProvider: this.options.buildProvider },
      target,
    );
  }

  getBuildProvider(): PluginBuildProvider | undefined {
    return this.options.buildProvider;
  }

  async reloadExternalPlugin(pluginId: string, options: { doctor?: boolean } = {}): Promise<PluginReloadResult> {
    this.assertNotDisposed();
    return reloadExternalPluginFlow(this.dxDeps(), pluginId, options);
  }

  async rescanExternalPlugins(): Promise<PluginRescanResult> {
    this.assertNotDisposed();
    return rescanExternalPluginDirs(this.options.dataDir, this);
  }

  attachPackageManager(manager: PluginPackageManager, store: PluginPackageManagerStore): void {
    this.packageManager = manager;
    this.packageStore = store;
  }

  asPackageManagerHost(): PackageManagerHost {
    return createPackageManagerHost(this.dxDeps());
  }

  private requirePackageManager(): PluginPackageManager {
    if (this.packageManager === undefined) {
      throw new HelmError(
        'not_supported',
        'when before kernel not connect line plugin package install (managed install/update/remove unavailable)',
        501,
      );
    }
    return this.packageManager;
  }

  installPluginPackage(source: string, options: { enable?: boolean } = {}): Promise<PluginInstallResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().install(source, options);
  }

  updatePluginPackage(pluginId: string): Promise<PluginUpdateResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().update(pluginId);
  }

  removePluginPackage(pluginId: string): Promise<PluginRemoveResult> {
    this.assertNotDisposed();
    return this.requirePackageManager().remove(pluginId);
  }

  // --- client.tsx compile artifact and public document ----------------------------------------

  private getPluginLifecycle = (id: string) => {
    const s = this.plugins.get(id);
    if (!s) return undefined;
    return {
      identity: s,
      enabled: s.enabled,
      phase: s.phase,
      epoch: s.epoch,
      clientRoot: s.definition.clientRoot,
      npmDependencies: s.definition.npmDependencies,
    };
  };

  async getClientModule(
    pluginId: string,
    moduleRef: string,
    options?: { chunk?: string; hash?: string },
  ): Promise<PluginClientBundle> {
    this.assertNotDisposed();
    return this.uiRegistry.getClientModule(pluginId, moduleRef, {
      chunk: options?.chunk,
      hash: options?.hash,
      getPluginLifecycle: this.getPluginLifecycle,
      dataDir: this.options.dataDir,
      isDisposed: () => this.disposed,
    });
  }

  getPublicDoc(pluginId: string, name: string): PublicPluginDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicDoc(pluginId, name, !!state && state.enabled && state.phase === 'idle');
  }

  getPublicSessionDoc(pluginId: string, name: string, conversationId: number): PublicPluginSessionDoc {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    return this.docRegistry.getPublicSessionDoc(pluginId, name, conversationId, !!state && state.enabled && state.phase === 'idle');
  }

  listPublicDocs(): PublicPluginDoc[] {
    this.assertNotDisposed();
    return this.docRegistry.listPublicDocs(getIdleActivePluginIds(this.plugins));
  }

  // --- Hook / Action / Tool execute --------------------------------------------

  async runHook<K extends HookName>(name: K, payload: HookPayloadMap[K]): Promise<HookResult<HookPayloadMap[K]>> {
    this.assertNotDisposed();
    return dispatchPluginHook(name, payload, {
      plugins: this.plugins,
      pipelines: this.pipelines,
      tracker: this.tracker,
      host: this.options.host,
      redactText: this.options.redactText,
    });
  }

  async runHookAround(
    name: 'agent_spawn',
    payload: HookPayloadMap['agent_spawn'],
    defaultRun: (finalPayload: HookPayloadMap['agent_spawn']) => Promise<unknown>,
  ): Promise<unknown> {
    this.assertNotDisposed();
    return dispatchPluginHookAround(name, payload, defaultRun, {
      plugins: this.plugins,
      pipelines: this.pipelines,
      tracker: this.tracker,
      host: this.options.host,
      redactText: this.options.redactText,
    });
  }

  static parseQualifiedActionId(qualified: string): { pluginId: string; actionId: string } {
    return parseQualifiedActionId(qualified);
  }

  private getCapabilityExecutionOptions() {
    return {
      assertActive: (pluginId: string) => {
        this.assertNotDisposed();
        assertActive(requirePlugin(this.plugins, pluginId));
      },
      getConversation: (id: number) => this.options.host.getConversation(id),
      tracker: this.tracker,
      isPluginRegistered: (pluginId: string) => this.plugins.has(pluginId),
    };
  }

  prepareAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): { idempotent: boolean } {
    this.assertNotDisposed();
    return this.capabilityRegistry.prepareAction(
      pluginId,
      actionId,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  async invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: PluginActionContext = {},
  ): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.invokeAction(
      pluginId,
      actionId,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  async executeTool(name: string, input: unknown, context: PluginToolContext): Promise<unknown> {
    this.assertNotDisposed();
    return this.capabilityRegistry.executeTool(
      name,
      input,
      context,
      this.getCapabilityExecutionOptions(),
    );
  }

  // --- config ----------------------------------------------------------------

  getConfig(pluginId: string): Record<string, unknown> {
    this.assertNotDisposed();
    const state = this.plugins.get(pluginId);
    // schema.default fill bottom, disk explicit value override (not store field motion state reverse reflect most new default)
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    const schema = state?.configSchema ?? {};
    const merged: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema)) {
      if (field.default !== undefined) {
        merged[key] = field.secret === true ? String(field.default) : field.default;
      }
    }
    return { ...merged, ...stored };
  }

  getConfigSchema(pluginId: string): Record<string, PluginConfigFieldSchema> {
    this.assertNotDisposed();
    const state = requirePlugin(this.plugins, pluginId);
    return state.configSchema ? { ...state.configSchema } : {};
  }

  /** config field source mapping:configured(disk explicit)/ default(schema fall back)/ unset. */
  getConfigSources(pluginId: string): Record<string, PluginConfigFieldSource> {
    this.assertNotDisposed();
    const schema = requirePlugin(this.plugins, pluginId).configSchema ?? {};
    const stored = this.configStore ? this.configStore.get(pluginId) : {};
    const sources: Record<string, PluginConfigFieldSource> = {};
    for (const [key, field] of Object.entries(schema)) {
      const has = Object.hasOwn(stored, key) && stored[key] !== undefined;
      const configured =
        field.secret === true
          ? has && typeof stored[key] === 'string' && (stored[key] as string).length > 0
          : has;
      if (configured) sources[key] = 'configured';
      else if (field.default !== undefined) sources[key] = 'default';
      else sources[key] = 'unset';
    }
    return sources;
  }

  async setConfig(pluginId: string, value: Record<string, unknown>): Promise<void> {
    this.assertNotDisposed();
    const state = requirePlugin(this.plugins, pluginId);
    const schema = state.configSchema ?? {};
    if (!this.configStore) {
      throw new HelmError(
        'config_store_unavailable',
        'PluginHost not provide persist PluginConfigStore, modify plugin config do not by support',
        501,
        { pluginId },
      );
    }
    await this.configStore.set(pluginId, value, schema);
  }

  // --- destroy and in-flight task trace ---------------------------------------------------

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.gate.drain();
    await disposePlugins(
      this.plugins,
      (state) => teardownPluginState(state, { stopServices: true }, this.registries()),
      this.tracker,
      (id) => removePluginRegistries(id, this.registries()),
    );
  }

  beginSpawnTask(pluginId: string, spawnId: string): void { this.tracker.begin(pluginId, `spawn:${spawnId}`); }
  endSpawnTask(pluginId: string, spawnId: string): void { this.tracker.end(pluginId, `spawn:${spawnId}`); }
  withTask<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T> { return this.tracker.withTask(pluginId, label, fn); }
  activeTaskCount(pluginId: string): number { this.assertNotDisposed(); return this.tracker.activeCount(pluginId); }

  // --- internal install match and guard -------------------------------------------------------

  private registries(): PluginHostRegistries {
    return {
      pipelines: this.pipelines,
      capabilityRegistry: this.capabilityRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
    };
  }

  private lifecycleContext(): PluginLifecycleContext {
    return {
      ...this.registries(),
      plugins: this.plugins,
      tracker: this.tracker,
      configStore: this.configStore,
      dataDir: this.options.dataDir,
      host: this.options.host,
      providers: this.options.providers,
      servicesStarted: this.servicesStarted,
      emitPluginChanged: (state) => this.emitPluginChanged(state),
      createPluginContext: (state, epoch) => this.createContext(state, epoch),
      getPluginLifecycle: this.getPluginLifecycle,
      isDisposed: () => this.disposed,
    };
  }

  private dxDeps(): DxCoordinatorDeps {
    return {
      dataDir: this.options.dataDir,
      buildProvider: this.options.buildProvider,
      plugins: this.plugins,
      tracker: this.tracker,
      providers: this.options.providers,
      docRegistry: this.docRegistry,
      host: this,
    };
  }

  private createContext(state: PluginState, epoch: number) {
    return createPluginContext({
      state,
      epoch,
      pipelines: this.pipelines,
      capabilityRegistry: this.capabilityRegistry,
      uiRegistry: this.uiRegistry,
      docRegistry: this.docRegistry,
      configStore: this.configStore,
      hostDeps: {
        backend: this.options.host,
        tracker: this.tracker,
        options: this.options,
        plugins: this.plugins,
        getConfig: (id) => this.getConfig(id),
        setConfig: (id, val) => this.setConfig(id, val),
        list: () => this.list(),
        listUi: () => this.listUi(),
        listActions: () => this.listActions(),
        invokeAction: (target, action, input, ctx) => this.invokeAction(target, action, input, ctx),
        prepareAction: (target, action, input, ctx) => this.prepareAction(target, action, input, ctx),
        assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      },
      assertNotDisposed: () => this.assertNotDisposed(),
      assertContextUsable: (s, ep, what) => this.assertContextUsable(s, ep, what),
      isRegisteredState: (s) => this.plugins.get(s.definition.id) === s,
    });
  }

  private assertContextUsable(state: PluginState, epoch: number, what: string): void {
    assertContextUsable(state, epoch, what, this.plugins.get(state.definition.id), this.disposed);
  }

  private emitDocUpdated(pluginId: string, name: string, value: unknown): void {
    const doc: PublicPluginDoc = { pluginId, name, value: jsonClone(value) };
    this.options.host.emitEvent('plugin.doc.updated', { type: 'plugin.doc.updated', doc });
  }

  private emitPluginChanged(state: PluginState): void {
    this.options.host.emitEvent('plugin.changed', {
      type: 'plugin.changed',
      plugin: summaryWithManagedPackage(state, this.capabilityRegistry, this.uiRegistry, this.packageStore),
      ui: state.enabled && state.phase === 'idle' ? this.uiRegistry.getUiByPlugin(state.definition.id) : [],
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new HelmError('plugin_host_disposed', 'PluginHost already dispose', 409);
    }
  }
}
