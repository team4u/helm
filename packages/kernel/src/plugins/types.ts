/**
 * PluginHost type and interface define.
 */
import type {
  BackendPluginsLifecyclePort,
  GuardedMutationExpectation,
  HelmHostApi,
  HelmHostNodeIpcPort,
  HelmHostNodeFetchPort,
  HelmHostOpenTunnelPort,
  HookName,
  PluginBuildProvider,
  MaybePromise,
  ModelProvidersRefreshResult,
  NodePathUsage,
  PluginConfigFieldSchema,
  PluginDefinition,
  PluginDiagnosticError,
  PluginServiceSpec,
  PluginSkillAsset,
} from '@helm/protocol';
import type { Provider } from '@earendil-works/pi-ai';
import type { PluginDocStore, PluginSessionDocStore } from './doc-registry.js';

export type { PluginDocStore, PluginSessionDocStore } from './doc-registry.js';

export interface PluginConfigStore {
  get(pluginId: string): Record<string, unknown>;
  set(
    pluginId: string,
    value: Record<string, unknown>,
    schema: Record<string, PluginConfigFieldSchema>,
  ): Promise<void> | void;
  /**
   * optional: plugin start stop state persist read (sync, return cache state;undefined means not persisted).
   * not implemented when PluginHost is in-memory start stop mechanism, restart back to register when initial declaration.
   */
  getEnabled?(pluginId: string): boolean | undefined;
  /** optional: persist plugin start stop state; failed must explicit reject(by host wrap JSON-safe diagnose). */
  setEnabled?(pluginId: string, enabled: boolean): Promise<void> | void;
}

export interface PluginProviderPort {
  /** mount provider; return unload function (idempotency by port implement guarantee, reject when reject leaves no residue). */
  register(provider: Provider, pluginId: string): Promise<() => Promise<void>>;
  /** optional: deactivate/unload before preflight in-flight stream/refresh, busy when throws (such as plugin_has_live_tasks). */
  assertIdle?(pluginId: string): void;
}

/**
 * host backend port:ctx.host implement source (Runtime provide, see runtime-host-backend.ts).
 *
 * shape policy: and HelmHostApi one by one character same shape member use forward Pick member index re- use (contains
 * onEvent / emitEvent  MaybePromise<void> can await contract, never manually copy signature
 * drift into void; also do not use Omit huge type reverse choose or motion state Proxy); difference member one by one explicit:
 * 1. pluginId naming empty between:secrets / setPluginConfig / skills.ensureSkill /
 *    manageConversation(return release function by PluginHost wrap idempotent);
 * 2. archive one shape:isClosing is zero reference function (ctx.host expose getter);
 * 3. Optional connections (when unwired, `ctx.host` rejects explicitly with 501, never silently falling back): nodeIpc /
 *    nodeFetch / openTunnel / plugins / abortConversationGuarded /
 *    submitInputGuarded;
 * 4. do not via backend forwarding (PluginHost self supply, avoid two layer forwarding):listPlugins / listUi /
 *    listActions / invokeAction / prepareAction / setConfig.
 */
export interface PluginHostBackend
  extends Pick<
    HelmHostApi,
    | 'profiles'
    | 'dispatchTrigger'
    | 'submitInput'
    | 'createConversation'
    | 'forkConversation'
    | 'listConversations'
    | 'getConversation'
    | 'getConversationDetail'
    | 'updateConversation'
    | 'abortConversation'
    | 'getConversationOwnership'
    | 'markConversationOwnership'
    | 'buildSpawnEnv'
    | 'spawnAgent'
    | 'runGate'
    | 'resolveSpawnTarget'
    | 'listActiveSpawnExecutions'
    | 'inspectNodePathUsage'
    | 'withFileLock'
    | 'atomicWriteFile'
    | 'redact'
    | 'refreshModels'
    | 'completeText'
    | 'executionEnv'
    | 'execEnv'
    | 'withFileMutationQueue'
    | 'listArtifacts'
    | 'getArtifact'
    | 'createAsk'
    | 'cancelAsk'
    | 'registerAskSeqResolver'
    | 'onEvent'
    | 'emitEvent'
  > {
  /** Host closing status (backing `ctx.host.isClosing` getter). */
  isClosing(): boolean
  /** Skill catalog port; `ensureSkill` tags the owning `pluginId`. */
  skills: Pick<HelmHostApi['skills'], 'list' | 'readFile' | 'directory'> & {
    ensureSkill(asset: PluginSkillAsset, pluginId: string): Promise<void>
  }
  /** Plugin-private secrets backend (`PluginHost` scopes keys by `pluginId`). */
  secrets: {
    get(pluginId: string, key: string): Promise<string | undefined>
    set(pluginId: string, key: string, value: string): Promise<void>
    delete(pluginId: string, key: string): Promise<void>
    addRedaction(value: string): () => void
  }
  /** Plugin configuration writer (validated against schema by `PluginHost` before forwarding). */
  setPluginConfig(pluginId: string, value: Record<string, unknown>): Promise<void>
  /** Node IPC port (EnvFabric channel; 501 when unwired). `nodePlatform` is reported by `NodeRegistry` or `undefined` if unknown. */
  nodeIpc?: HelmHostNodeIpcPort
  /** Node-local HTTP fetch port (`EnvFabric.nodeFetch`; 501 when unwired, never falls back to local). */
  nodeFetch?: HelmHostNodeFetchPort
  /** Arbitrary TCP passthrough tunnel port (`EnvFabric.openTunnel`; 501 when unwired). */
  openTunnel?: HelmHostOpenTunnelPort
  /** Host plugin governance backend (`ctx.host.plugins`; write operations fail with 501 when unwired). */
  plugins?: BackendPluginsLifecyclePort
  /** Guarded input submission port (kernel atomic ownership/seq check; 501 when unwired). */
  submitInputGuarded?(
    conversationId: number,
    text: string,
    opts?: Parameters<HelmHostApi['submitInputGuarded']>[2],
    guard?: GuardedMutationExpectation,
  ): Promise<void>
  /** Guarded abort port (includes scheduler-paused durability path; 501 when unwired). */
  abortConversationGuarded?(id: number, guard: GuardedMutationExpectation): Promise<void>
  /** Claims exclusive management over conversation `id` for `pluginId`; returns release function. */
  manageConversation(id: number, pluginId: string): () => void
}

export interface PluginHostOptions {
  dataDir: string;
  host: PluginHostBackend;
  docs: PluginDocStore;
  /** Durable store for per-conversation `sessionDoc`s (`durable !== false`); missing rejects durable declarations with 501. */
  sessionDocs?: PluginSessionDocStore;
  config?: PluginConfigStore;
  /** Optional model provider mount port (`ctx.provider`). */
  providers?: PluginProviderPort;
  /** Host text redactor (`SecretStash`) applied to `ctx.host.invokeAction` outputs. */
  redactText?: (text: string) => string;
  /** Plugin build port (`client.tsx` compilation + backend TS transpilation) injected by composition root (`@helm/plugin-build`). */
  buildProvider?: PluginBuildProvider;
  /**
   * Defer service `start()` until `PluginHost.start()` runs the global `prepare -> start` barrier.
   * Defaults to false (starts immediately on register/enable).
   */
  deferServices?: boolean;
}

export interface ServiceEntry extends PluginServiceSpec {
  pluginId: string;
  started: boolean;
  /** Tracks whether `prepare()` has already executed for this cycle. */
  prepared: boolean;
}

/** Provider entry collected during `definePlugin`, mounted on enable and unmounted in reverse order on disable. */
export interface ProviderEntry {
  provider: Provider;
  /** Unregister callback returned after mount; `null` when unmounted. */
  unregister: (() => Promise<void>) | null;
}

/**
 * Plugin lifecycle phase:
 * - `defining`: executing `definePlugin` (registration APIs enabled);
 * - `deactivating`: tearing down (blocks new tasks and stale doc writes);
 * - `idle`: settled state (`enabled` determines external availability).
 */
export type PluginPhase = 'idle' | 'defining' | 'deactivating';

/**
 * Subset of `ctx.host` calls permitted inside the controlled service shutdown window (`stopWindow === true`):
 * reads, cancellations, node cleanup IPC, and final events. New-work entry points remain rejected.
 */
export const STOP_WINDOW_HOST_CALLS: ReadonlySet<string> = new Set([
  'host.listConversations',
  'host.getConversation',
  'host.abortConversation',
  'host.abortConversationGuarded',
  'host.cancelAsk',
  'host.emitEvent',
  'host.redact',
  'host.nodeIpc.isOnline',
  'host.nodeIpc.call',
]);

/** Persistent resource usage item reported during pre-disable checks (matches protocol `PluginInUseItem`). */
export interface PluginInUseItem {
  kind: string;
  id: string;
  label: string;
}

export interface PluginState {
  definition: PluginDefinition;
  /** Normalized, deduplicated plugin dependency IDs in declaration order. */
  dependencies: string[];
  enabled: boolean;
  phase: PluginPhase;
  /** Monotonic cycle counter incremented on enable start and disable completion to invalidate stale handles. */
  epoch: number;
  dataDir: string;
  hooks: Set<HookName>;
  services: ServiceEntry[];
  /** Model providers declared in this cycle (mounted on enable, unmounted in reverse order on disable). */
  providers: ProviderEntry[];
  configSchema: Record<string, PluginConfigFieldSchema> | null;
  /** Host lifecycle resource release handles acquired during this enablement cycle. */
  hostReleases: Set<() => void>;
  /** True while awaiting service `stop()` chain; opens `STOP_WINDOW_HOST_CALLS` and final doc writes. */
  stopWindow: boolean;
  /** Most recent load/enable failure diagnostic (`status: 'failed'`). */
  lastError?: PluginDiagnosticError;
  /** Placeholder marker when scan/load failed without a valid definition (`enable` rejects with `409 plugin_load_failed`). */
  loadFailed?: boolean;
  /** Fault isolation flag (set for external loaders): transitions startup/define failures into `failed` rather than aborting host startup. */
  isolateFailure?: boolean;
}
