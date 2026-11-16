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
 * 3. optional connect line (not connect line when ctx.host invoke explicit 501, never static default fall back):nodeIpc /
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
  /** host close state (ctx.host.isClosing getter source). */
  isClosing(): boolean
  /** skill data port;ensureSkill extra carry caller pluginId(managed register ownership). */
  skills: Pick<HelmHostApi['skills'], 'list' | 'readFile' | 'directory'> & {
    ensureSkill(asset: PluginSkillAsset, pluginId: string): Promise<void>
  }
  /** plugin private secrets backend (PluginHost in this of on wrap pluginId naming empty between). */
  secrets: {
    get(pluginId: string, key: string): Promise<string | undefined>
    set(pluginId: string, key: string, value: string): Promise<void>
    delete(pluginId: string, key: string): Promise<void>
    addRedaction(value: string): () => void
  }
  /** plugin config after write end (PluginHost validate target pluginId after forwarding; value already by schema validate). */
  setPluginConfig(pluginId: string, value: Record<string, unknown>): Promise<void>
  /** node IPC mechanism port (EnvFabric channel; not connect line when ctx.host invoke explicit 501).nodePlatform is NodeRegistry register on report can message node platform, missing seat i.e. unknown. */
  nodeIpc?: HelmHostNodeIpcPort
  /** node local machine HTTP fetch port (EnvFabric.nodeFetch; not connect line when explicit 501, does not fall back local). */
  nodeFetch?: HelmHostNodeFetchPort
  /** any TCP pass-through tunnel port (EnvFabric.openTunnel; not connect line when explicit 501, does not fall back local). */
  openTunnel?: HelmHostOpenTunnelPort
  /**
   * host plugin governance backend (ctx.host.plugins write side; not connect line when modify operation explicit 501,
   * not silently fall back). real implement by runtime directly delegate PluginHost and
   * PluginPackageManager since has public method.
   */
  plugins?: BackendPluginsLifecyclePort
  /** automatically guarded commit (kernel atomic guard port): not connect line when ctx.host invoke explicit 501, never static default fall back ordinary submitInput. */
  submitInputGuarded?(
    conversationId: number,
    text: string,
    opts?: Parameters<HelmHostApi['submitInputGuarded']>[2],
    guard?: GuardedMutationExpectation,
  ): Promise<void>
  /** automatically guarded abort (contains scheduler paused each other durable mark record path); not connect line when explicit 501, never static default fall back ordinary abortConversation. */
  abortConversationGuarded?(id: number, guard: GuardedMutationExpectation): Promise<void>
  /** declaration pluginId for conversation manage right; return release function (managed during delete protect). */
  manageConversation(id: number, pluginId: string): () => void
}

export interface PluginHostOptions {
  dataDir: string;
  host: PluginHostBackend;
  docs: PluginDocStore;
  /** conversation shard durable layer; missing when declaration sessionDoc explicit failed, does not use memory or global document fall back. */
  sessionDocs?: PluginSessionDocStore;
  config?: PluginConfigStore;
  /**
   * optional plugin Provider mount port (runtime provide): plugin via ctx.provider declaration
   * self carries model Provider in enable when mount, deactivate/unload when unload.
   */
  providers?: PluginProviderPort;
  /**
   * host unify text redaction (SecretStash plaintext -> marker):ctx.host.invokeAction
   * return action output via this value level redaction (honor protocol contract"host unify redaction",
   * independent of caller plugin self carries redactor). not provide when original return (host pattern/test).
   */
  redactText?: (text: string) => string;
  /**
   * plugin build port (client.tsx compile + backend TS transpile): mechanism in kernel, build tool by
   * composition root inject (produce product in hub inject @helm/plugin-build by default implement). missing when kernel
   * explicit reject related capability (client UI contribution unsupported_client_build, external TS source
   * unsupported_backend_ts_build), never static default lose UI or fall back, also do not motion state import
   * by default implement.
   */
  buildProvider?: PluginBuildProvider;
  /**
   * latency service start screen fault (runtime self create host when use):true when register/enable 
   * enable plugin only complete define collect,provider mount and service prepare register, do not execute service
   * start(); by combine layer in all plugin register after completion unify invoke PluginHost.start(),
   * first global execute all prepare again one by one plugin start. by default false:register i.e. when prepare+start.
   */
  deferServices?: boolean;
}

export interface ServiceEntry extends PluginServiceSpec {
  pluginId: string;
  started: boolean;
  /** prepare already execute mark record (avoid repeat execution; idempotent by service itself guarantee). */
  prepared: boolean;
}

/** provider declaration items:definePlugin phase collect, enable when mount (record mount order supply inverse order unload). */
export interface ProviderEntry {
  provider: Provider;
  /** mount after success unload function;null = not yet mount (declaration state/uninstalled). */
  unregister: (() => Promise<void>) | null;
}

/**
 * plugin lifecycle each other:
 * - defining:definePlugin execute in (register method only this each other available);
 * - deactivating: deactivate in (first at any await settings, isolated new task and old doc write);
 * - idle: stable state (enabled decide is otherwise for outside available).
 */
export type PluginPhase = 'idle' | 'defining' | 'deactivating';

/**
 * subject to control stop window inside still available ctx.host invoke (by wrapHostApi  what tag):
 * stop chain must must only read (listConversations/getConversation/redact/nodeIpc.isOnline),
 * cancel (abortConversation/cancelAsk), across node clean up IPC(nodeIpc.call) and eventually
 * event (emitEvent). set from real stop consumer (workflow close  runs throw shadow and
 * sub-conversation abort,herdr deregister single/pane clean up/notify,superagent  Ask cancel) and by capability
 * through use express, do not by plugin ID special judge. the rest invoke - - contains spawnAgent/submitInput/
 * createConversation/dispatchTrigger/createAsk/execEnv/executionEnv/
 * completeText etc. everything new work entry - - in window inside same reject: deactivate semantics is split destroy wrap-up,
 * is not continue dry wide limit phase.guarded abort follow ordinary abort one and let through (wrap-up cancel chain);
 * guarded commit belongs to new work entry, window inside per refuse.
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

/** durable asset occupy items (deactivate preflight aggregate use; and protocol PluginInUseItem same shape). */
export interface PluginInUseItem {
  kind: string;
  id: string;
  label: string;
}

export interface PluginState {
  definition: PluginDefinition;
  /** register boundary archive one after dependency plugin ID list (dedupe, keep declaration order; only registered dependency enter diagram). */
  dependencies: string[];
  enabled: boolean;
  phase: PluginPhase;
  /** enable cycle number: each time enable start and disable complete when pass increase, make old context/handle expires. */
  epoch: number;
  dataDir: string;
  hooks: Set<HookName>;
  services: ServiceEntry[];
  /** this cycle ctx.provider declaration model Provider(enable when mount, deactivate/unload when inverse order unload). */
  providers: ProviderEntry[];
  configSchema: Record<string, PluginConfigFieldSchema> | null;
  /**
   * this enable cycle via ctx.host get host lifecycle asset release handle
   * (manageConversation manage right / onEvent listen / askSeq parse).
   */
  hostReleases: Set<() => void>;
  /**
   * subject to control stop window: host is now await this plugin service stop chain during is true.
   * this window inside STOP_WINDOW_HOST_CALLS and doc write let through, the rest host invoke and new task per refuse.
   */
  stopWindow: boolean;
  /**
   * most near once load or enable failed diagnose (status: 'failed' decide source).
   * enable / disable on success empty;scan/load phase occupy item (loadFailed) constant keep
   * until fix after reload / restart re- register.
   */
  lastError?: PluginDiagnosticError;
  /**
   * scan / load phase failed occupy target record:definition is empty shell (definePlugin is
   * no-op), without valid capability register;enable directly 409 plugin_load_failed.
   */
  loadFailed?: boolean;
  /**
   * register when declaration fault isolated intent willing (external plugin load pass isolateFailure:true):
   * define / enable / start screen fault phase failed fall back is failed item while is not block assert host.
   */
  isolateFailure?: boolean;
}
