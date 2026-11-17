/**
 * HTTP layer dependency kernel runtime contract (structure type).
 *
 * each service by parallel proxy implement and already then (services/*); this file constraint HTTP consume shape.
 * KernelRuntime instance pass when structure compatibility i.e. can ( structural typing ).
 */
import type {
  ActionManifest,
  ArtifactKind,
  ArtifactMetadata,
  AskSpec,
  ConversationCompactResponse,
  ConversationDetail,
  ConversationInit,
  ConversationInputResult,
  ConversationEntry,
  ConversationListFilter,
  ConversationPatch,
  ConversationSummary,
  ConversationWithdrawResponse,
  EnvExecRequest,
  EnvExecResponse,
  ModelCatalogEntry,
  ModelCatalog,
  NodeInfo,
  NodeIssuedToken,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeInput,
  NodeUpgradeResult,
  ModelProviderSummary,
  ModelProvidersRefreshResult,
  PluginConfigFieldSchema,
  PluginConfigFieldSource,
  PluginConfigResponse,
  PluginDiagnosticError,
  PluginDoctorReport,
  PluginInstallResult,
  PluginInUseItem,
  PluginReloadResult,
  PluginRemoveResult,
  PluginRescanResult,
  PluginStatus,
  PluginSummary,
  PluginUpdateResult,
  ProviderConfig,
  PublicPluginDoc,
  PublicPluginSessionDoc,
  SearchHit,
  SessionDocSubscription,
  SkillSummary,
  Profile,
} from '@helm/protocol'
import type {
  AuthService as RealAuthService,
  ArtifactService as RealArtifactService,
  CredentialService as RealCredentialService,
  ProfileService as RealProfileService,
  ProviderService as RealProviderService,
  SkillService as RealSkillService,
} from '../services/index.js'
import type { EnvFabric } from '../env/index.js'
import type { NodeForwardEvent, NodeForwardSession } from '../env/forward.js'

export type { RealAuthService }
export type {
  RealArtifactService,
  RealCredentialService,
  RealProfileService,
  RealProviderService,
  RealSkillService,
}

// re- export real service type supply HTTP consumer use
export type AuthService = RealAuthService
export type ArtifactService = RealArtifactService
export type CredentialService = RealCredentialService
export type ProfileService = RealProfileService
export type ProviderService = RealProviderService
export type SkillService = RealSkillService

// ---------------------------------------------------------------------------
// Events / Plugins
// ---------------------------------------------------------------------------

/**
 * global event hub (kernel.events).HTTP layer only consume response(): by runtime
 * provide Web Standard SSE Response(streaming, frame inside self row redaction), client disconnect
 * (request.signal abort) by implement negative duty clean up.HTTP layer does not cache/convert/fall back.
 */
export interface EventHub {
  /** SSE response: immediately return Response(streaming), client disconnect automatically clean up. */
  response(request: Request): Response
}

export interface PluginRouteInfo {
  pluginId: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** complete mount path (such as '/api/plugins/<id>/webhook/:t'); declaration when force dedicated belong prefix. */
  path: string
  public?: boolean
  handler(req: Request): Response | Promise<Response>
}

export interface PluginHost {
  list(): PluginSummary[] | Promise<PluginSummary[]>
  enable(id: string): Promise<void> | void
  disable(id: string, options?: { force?: boolean }): Promise<void> | void
  listActions(): ActionManifest[] | Promise<ActionManifest[]>
  invokeAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context?: { conversationId?: number },
  ): Promise<unknown> | unknown
  /** raw config (may contains secret plaintext);HTTP output before must by schema redaction. */
  getConfig(id: string): Record<string, unknown> | Promise<Record<string, unknown>>
  /** declaration style config schema(contains secret mark record, supply HTTP redaction). */
  getConfigSchema(id: string): Record<string, PluginConfigFieldSchema> | Promise<Record<string, PluginConfigFieldSchema>>
  /** optional: config field source mapping (configured | default | unset). */
  getConfigSources?(id: string): Record<string, PluginConfigFieldSource> | Promise<Record<string, PluginConfigFieldSource>>
  setConfig(id: string, values: Record<string, unknown>): Promise<void> | void
  /** motion state routing manifest (actual mount naming empty between /api/plugins/<encodedId>/routes/...). */
  listRoutes(): PluginRouteInfo[]
  /**
   * single plugin summary now read: plugin routing dispatch before enable state re- inspect (listRoutes snapshot may
   * and deactivate complete hand over wrong; not provide when skip re- inspect). note summary excludes lifecycle phase,
   * teardown during (enabled still true) intercept need to PluginHost public phase aware
   * gate (across group).
   */
  get?(pluginId: string): PluginSummary | undefined
  /**
   * in-flight task trace wrap (and action/tool execute same source PluginTaskTracker):
   * route handler execute during count liveTasks, make disable deactivate gate
   * assertNoLiveTasks for in-flight route request visible (409 plugin_has_live_tasks
   * while non- half execute split destroy). not provide when do not wrap.
   */
  withTask?<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T>
  /** read plugin public document; private/deactivate/missing one rule 404(authentication cannot bypass visible). */
  getPublicDoc(pluginId: string, name: string): Promise<PublicPluginDoc> | PublicPluginDoc
  /**
   * read plugin public conversation document (GET /api/plugins/:id/docs/:name?conversationId=N
   * and dedicated use SSE first frame shared use); deactivate/private/not declaration/conversation missing one rule 404.
   */
  getPublicSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
  ): Promise<PublicPluginSessionDoc> | PublicPluginSessionDoc
  /**
   * get enabled plugin client.tsx compile artifact (GET /api/plugins/:id/client.mjs?module=...).
   * deactivate/not registered/not declaration clientRoot/exceeds/failed to compile explicit throws (HelmError semantics).
   */
  getClientModule(
    pluginId: string,
    moduleRef: string,
    options?: { chunk?: string; hash?: string },
  ): Promise<{ code: string; contentHash: string; gzipped?: Uint8Array; exports?: string[] }>
  /**
   * external plugin source code static self inspect (POST /api/plugins/doctor,body { path? , dir?, id? } choose one):
   * real proxy boundary import + temporary host real register + client real compile; result with report return
   * (plugin defect in checks inside, do not reject).id pattern parse the plugin source directory;
   * path/dir is directory absolute path (dir is path compatibility alias, etc. price). target missing/cannot
   * parse when 404 reject(is not plugin defect, is request target error).
   */
  doctorExternalPlugin?(target: { dir?: string; id?: string }): Promise<PluginDoctorReport>
  /**
   * external plugin subject to control hot reload (POST /api/plugins/:id/reload): preflight failed old instance keep do not motion;
   * in-flight task 409 reject; built-in plugin 403; enable state keep.
   */
  reloadExternalPlugin?(pluginId: string): Promise<PluginReloadResult>
  /** incremental heavy scan (POST /api/plugins/rescan): only register new external plugin, by default disabled. */
  rescanExternalPlugins?(): Promise<PluginRescanResult>
  /**
   * managed plugin package install (POST /api/plugins/install,body { source, enable? }):
   * npm/git/local unify staging copy + doctor all chain + atomic enter managed directory;
   * npm install forever do not run lifecycle scripts; failed clean up staging do not half artifact.
   * not connect line when HTTP 501.
   */
  installPluginPackage?(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult>
  /** managed plugin package update (POST /api/plugins/:id/update): heavy take source + doctor + atomic replace + reload semantics. */
  updatePluginPackage?(pluginId: string): Promise<PluginUpdateResult>
  /** managed plugin package remove (POST /api/plugins/:id/remove): protect builtin/in-flight task/providers;local only delete managed copy. */
  removePluginPackage?(pluginId: string): Promise<PluginRemoveResult>
}

export type { SearchHit }

/** conversation document event port (kernel side SessionDocEventHub structure shape). */
export interface SessionDocEventPort {
  readonly seq: number
  subscribe(
    doc: { pluginId: string; name: string; conversationId: number },
    listener: (frame: { seq: number; event: unknown }) => void,
  ): () => void
  response(
    request: Request,
    options: {
      /** sync snapshot provider: subscribe establish after invoke (avoid first snapshot after subscribe lose frame window),
       * fails sync throw (HTTP layer rotate structure error); internal again do public/conversation store in validate. */
      snapshot: () => { seq: number; doc: PublicPluginSessionDoc }
      target: { pluginId: string; name: string; conversationId: number }
    },
  ): Response
  multiplexResponse?(
    subs: readonly SessionDocSubscription[],
    request: Request,
    options: {
      snapshot: (sub: SessionDocSubscription) => { seq: number; doc: PublicPluginSessionDoc }
    },
  ): Response
}

/** HTTP consume KernelRuntime shape (real KernelRuntime structure compatibility at it). */
export interface KernelRuntimeLike {
  readonly dataDir: string
  readonly auth: AuthService
  readonly events: EventHub
  /** conversation document dedicated use event stream port (not provide when dedicated use SSE 501). */
  readonly sessionDocEvents?: SessionDocEventPort
  readonly profiles: ProfileService
  readonly skills: SkillService
  readonly credentials: CredentialService
  readonly providers: ProviderService
  readonly artifacts: ArtifactService
  readonly plugins: PluginHost
  /**
   * secret redaction hook (real kernel  SecretStash). out station JSON string value and
   * server side error log all first via it erase already register secret, never outside plaintext or restore marker.
   */
  readonly stash?: {
    redact(text: string): string
    createStreamingRedactor?(): { push(text: string): string; flush(): string }
  }
  /**
   * model hot reload port:providers/credentials change after await, make after continue
   * listModels reverse reflect new config (only persist JSON while do not reload equals hot config invalid).
   * optional:runtime not provide when HTTP layer non-blocking write path.
   */
  reloadModels?(): Promise<void>

  /**
   * actual Hub URL hot update port:startHub(port:0) listen after call back, make shell inside
   * CLI/tool end point points to real address. not provide when HTTP layer non-blocking.
   */
  setHubUrl?(url: string): void

  listConversations(
    filter?: ConversationListFilter,
  ): Promise<ConversationSummary[]> | ConversationSummary[]
  /** GET /api/conversations/:id consume: summary + page timeline. */
  getConversationDetail(
    id: number,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> | ConversationDetail
  /** GET /api/conversations/:id/entries/:entryId consume: single not truncate but already redaction
   * (signature strip) item;rewind override old item and detail situation visible consistent ground 404.
   * optional:runtime not provide when HTTP 501(and withdrawQueuedInput same style). */
  getConversationEntry?(
    id: number,
    entryId: number,
  ): Promise<ConversationEntry> | ConversationEntry
  createConversation(init?: ConversationInit): Promise<ConversationSummary> | ConversationSummary
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> | ConversationSummary
  deleteConversation(id: number): Promise<void> | void
  submitInput(
    id: number,
    text: string,
    opts?: {
      origin?: 'human' | 'agent' | 'trigger'
      /** conversation correct busy policy; omit when kernel by default steer. */
      whenBusy?: 'steer' | 'followUp' | 'reject'
      meta?: Record<string, unknown>
      attachments?: string[]
      /** from designate history item start original ground override heavy (truncate the and after continue context after write new input). */
      replaceFromEntryId?: number
    },
  ): Promise<{ submissionId: string }> | { submissionId: string }
  /** withdraw back queue up in input (POST /api/conversations/:id/withdraw). */
  withdrawQueuedInput?(
    id: number,
    opts: { submissionId: number },
  ): Promise<ConversationWithdrawResponse> | ConversationWithdrawResponse
  /** ?wait=1: wait for single time commit terminal state and return this time input result; failed/abort throw explicit HelmError. */
  waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> | ConversationInputResult
  abortConversation(id: number): Promise<void> | void
  /** reset conversation context (new context with handoff text start); return update after summary. */
  resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> | ConversationSummary
  /** manually compress conversation context; return compress task ID and update after summary. */
  compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<ConversationCompactResponse> | ConversationCompactResponse
  /** from designate item fork new conversation (inherit profile/cwd/model, parent chain points to source conversation). */
  forkConversation(
    id: number,
    opts: { entryId: number; title?: string },
  ): Promise<ConversationSummary> | ConversationSummary

  listAsks(): Promise<AskSpec[]> | AskSpec[]
  answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<unknown> | unknown
  cancelAsk(id: string): Promise<void> | void

  search(query: string): Promise<SearchHit[]> | SearchHit[]
  listModels(): Promise<ModelCatalog> | ModelCatalog
  /** settings model disable collection (PUT /api/models/filter); not implemented when HTTP 501. */
  setDisabledModels?(provider: string | undefined, disabledModels: string[]): Promise<ModelCatalog>
  /**
   * model disable preflight (ModelRegistry.assertModelEnabled):HTTP save profile.model /
   * global by default model etc. entry in before invoke, disable model reject (409 model_disabled).
   * optional port:runtime not provide when HTTP layer non-blocking.
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** settings global by default model and think Profile (config.json); empty string clear. not implemented when HTTP 501. */
  setDefaultModel?(model?: string, thinkingLevel?: string): Promise<void>
  /** Profile save after sync bind set conversation model and think Profile. */
  alignProfileConversations?(profileId: string): Promise<void>
  listModelProviders(): Promise<ModelProviderSummary[]> | ModelProviderSummary[]
  /**
   * motion state model directory refresh (POST /api/models/refresh): target motion state provider allowNetwork
   * pull most new directory and persist models-store.json. optional port:runtime not provide when 501.
   */
  refreshModels?(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult>

  // ---------------------------------------------------------------------------
  // across platform node manage (EnvFabric / nodes / env exec)
  // ---------------------------------------------------------------------------

  /** node bottom seat (node-server connect WS gateway use); not provide when /ws/node do not hang connect. */
  readonly envFabric?: EnvFabric
  /** column out local + already register BYOM node and real-time online state (GET /api/nodes). */
  listNodes(): Promise<NodeInfo[]> | NodeInfo[]
  /** sign node access token (plaintext token only this time response return; server side only store sha256). */
  issueNodeToken(nodeId: string): Promise<NodeIssuedToken> | NodeIssuedToken
  /** remove node: from sign table delete and immediately pinch assert in-flight connect (DELETE /api/nodes/:id). */
  removeNode(nodeId: string): Promise<void> | void
  /** check node available update (GET /api/nodes/:id/upgrade/check). */
  checkNodeUpgrade?(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> | NodeUpgradeCheckResult
  /** trigger node upgrade and wait for commit confirm (POST /api/nodes/:id/upgrade). */
  upgradeNode?(nodeId: string, input?: NodeUpgradeInput): Promise<NodeUpgradeResult> | NodeUpgradeResult
  /**
   * start foreground port forwarding (POST /api/nodes/:id/forward):Hub side on demand listen
   * listenHost:listenPort, each station connect via any TCP tunnel reach target node
   * targetHost:targetPort; listener only in command lifecycle memory in (monitor stream disconnect /
   * stop / host close i.e. destroy).
   */
  startNodeForward?(
    nodeId: string,
    input: { listenHost: string; listenPort: number; targetHost?: string; targetPort: number },
  ): Promise<NodeForwardSession> | NodeForwardSession
  /** stop port forwarding (DELETE /api/nodes/forward/:forwardId); idempotent semantics by 404 express. */
  stopNodeForward?(forwardId: string): Promise<void> | void
  /** forwarding conversation now read (GET /api/nodes/forward/:forwardId). */
  getNodeForward?(forwardId: string): NodeForwardSession | undefined
  /** activity forwarding manifest (GET /api/nodes/forward). */
  listNodeForwards?(): NodeForwardSession[]
  /** forwarding event subscribe (GET /api/nodes/forward/:forwardId/events,NDJSON);stop terminal state stopped frame after normal close stream (monitor do not pending). */
  onNodeForwardEvent?(
    forwardId: string,
    listener: (event: NodeForwardEvent) => void,
  ): () => void
  /** forwarding terminate notify (terminal state stopped frame after invoke; already stop when immediately call back). */
  onNodeForwardStopped?(forwardId: string, listener: () => void): () => void
  /**
   * bind set foreground lease holder (events event stream establish when): clear create lease; return release
   * function (stream disconnect/cancel when invoke) - - finally a holder release i.e. stop forwarding.
   * only read list/get do not away this port (is not holder).
   */
  acquireNodeForwardLease?(forwardId: string): () => void
  /**
   * across node command execute (POST /api/env/exec): target parse is explicit nodeId/cwd >
   * conversation bind set > local; remote offline 409 node_offline;onChunk one by one chunk back put
   * (NDJSON streaming pattern);signal pass broadcast cancel.
   */
  execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> | EnvExecResponse
}

/** startHub option and return. */
export interface StartHubOptions {
  kernel: KernelRuntimeLike
  /** by default 3202(HELM_PORT convention; test please use 0). */
  port?: number
  /** by default 127.0.0.1. */
  hostname?: string
  /**
   * produce static hosting directory (packages/web/dist):false disable; default probe by default location
   * (store in index.html only then enable); string is explicit directory (expires when start explicit errors).
   * pass-through to createHubHandler same name option.
   */
  webDistDir?: string | false
}

export interface HubHandle {
  url: string
  close(): Promise<void>
}

// export supply test construct complete Profile
export type { Profile, ProviderConfig, SkillSummary, ArtifactKind, ArtifactMetadata, AskSpec, ConversationSummary, ConversationDetail, ConversationEntry, ConversationInputResult, PluginSummary, PluginStatus, PluginDiagnosticError, PluginInUseItem, PluginConfigFieldSource, PluginConfigResponse, ActionManifest, PublicPluginDoc, NodeInfo, NodeIssuedToken, NodeUpgradeCheckInput, NodeUpgradeCheckResult, NodeUpgradeInput, NodeUpgradeResult, EnvExecRequest, EnvExecResponse, ModelCatalogEntry, ModelCatalog, ConversationCompactResponse, ConversationWithdrawResponse, PluginDoctorReport, PluginReloadResult, PluginRescanResult, PluginInstallResult, PluginUpdateResult, PluginRemoveResult }
