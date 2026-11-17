/**
 * Kernel runtime contract consumed by the HTTP layer (structural typing).
 *
 * Services are implemented in `services/*`; this file constrains the shape consumed by HTTP routes.
 * Any structurally compatible `KernelRuntime` instance satisfies it.
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
import type { ConversationFileContent } from '../runtime/workspace-files.js'

export type { ConversationFileContent }

export type { RealAuthService }
export type {
  RealArtifactService,
  RealCredentialService,
  RealProfileService,
  RealProviderService,
  RealSkillService,
}

// Re-export concrete service types for HTTP consumers
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
 * Global event hub (`kernel.events`). The HTTP layer only consumes `response()`: the runtime
 * provides a streaming Web Standard SSE Response (self-redacted per frame), and client disconnects
 * (`request.signal` abort) are cleaned up by the implementation. The HTTP layer performs no caching,
 * transformation, or fallback.
 */
export interface EventHub {
  /** SSE response: returns a streaming Response immediately; automatically cleans up on client disconnect. */
  response(request: Request): Response
}

interface PluginRouteInfo {
  pluginId: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  /** Full mount path (e.g. '/api/plugins/<id>/webhook/:t'); enforced to use the plugin's dedicated prefix on registration. */
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
  /** Raw config (may include plaintext secrets); must be schema-redacted before HTTP output. */
  getConfig(id: string): Record<string, unknown> | Promise<Record<string, unknown>>
  /** Declarative config schema (includes secret markers for HTTP redaction). */
  getConfigSchema(id: string): Record<string, PluginConfigFieldSchema> | Promise<Record<string, PluginConfigFieldSchema>>
  /** Optional: config field source map (configured | default | unset). */
  getConfigSources?(id: string): Record<string, PluginConfigFieldSource> | Promise<Record<string, PluginConfigFieldSource>>
  setConfig(id: string, values: Record<string, unknown>): Promise<void> | void
  /** Dynamic route list (actual mount namespace `/api/plugins/<encodedId>/routes/...`). */
  listRoutes(): PluginRouteInfo[]
  /**
   * Live read of a single plugin summary: re-checks enabled state before dispatching a plugin route
   * (`listRoutes` snapshots can race with disable completion; skipped if unprovided). Note that summaries
   * exclude lifecycle phase—blocking during teardown (while `enabled` is still true) requires PluginHost's
   * phase-aware gate.
   */
  get?(pluginId: string): PluginSummary | undefined
  /**
   * In-flight task tracking wrapper (shares PluginTaskTracker with action/tool execution):
   * counts route handler execution toward `liveTasks` so disable's `assertNoLiveTasks` sees in-flight
   * route requests (`409 plugin_has_live_tasks` rather than tearing down mid-request). No-op if unprovided.
   */
  withTask?<T>(pluginId: string, label: string, fn: () => Promise<T>): Promise<T>
  /** Read a plugin public document; private/disabled/missing all map to 404 (auth cannot bypass visibility). */
  getPublicDoc(pluginId: string, name: string): Promise<PublicPluginDoc> | PublicPluginDoc
  /**
   * Read a plugin public session document (shared by `GET /api/plugins/:id/docs/:name?conversationId=N`
   * and dedicated SSE initial frames); disabled/private/undeclared/missing conversation all map to 404.
   */
  getPublicSessionDoc(
    pluginId: string,
    name: string,
    conversationId: number,
  ): Promise<PublicPluginSessionDoc> | PublicPluginSessionDoc
  /**
   * Fetch compiled client.tsx bundle for an enabled plugin (`GET /api/plugins/:id/client.mjs?module=...`).
   * Disabled/unregistered/missing clientRoot/out-of-bounds/compile errors throw explicitly (`HelmError`).
   */
  getClientModule(
    pluginId: string,
    moduleRef: string,
    options?: { chunk?: string; hash?: string },
  ): Promise<{ code: string; contentHash: string; gzipped?: Uint8Array; exports?: string[] }>
  /**
   * Static self-check of external plugin source (`POST /api/plugins/doctor`, body `{ path?, dir?, id? }`):
   * runs real import in an isolated sandbox, registers against a temporary host, and compiles client code;
   * plugin defects are returned inside `report.checks` without throwing. `id` resolves an existing plugin's
   * source directory; `path`/`dir` are absolute directory paths (`dir` is an alias for `path`). Missing or
   * unresolvable targets reject with 404 (caller request error, not a plugin defect).
   */
  doctorExternalPlugin?(target: { dir?: string; id?: string }): Promise<PluginDoctorReport>
  /**
   * Controlled hot reload of an external plugin (`POST /api/plugins/:id/reload`): keeps the old instance
   * untouched on preflight failure; rejects with 409 on in-flight tasks; 403 for built-ins; preserves enabled state.
   */
  reloadExternalPlugin?(pluginId: string): Promise<PluginReloadResult>
  /** Incremental rescan (`POST /api/plugins/rescan`): registers newly discovered external plugins as disabled by default. */
  rescanExternalPlugins?(): Promise<PluginRescanResult>
  /**
   * Install a managed plugin package (`POST /api/plugins/install`, body `{ source, enable? }`):
   * stages npm/git/local copy, runs full doctor checks, and atomically installs into the managed directory;
   * npm install never runs lifecycle scripts; cleans up staging on failure without leaving partial artifacts.
   * Returns HTTP 501 when unwired.
   */
  installPluginPackage?(source: string, options?: { enable?: boolean }): Promise<PluginInstallResult>
  /** Update a managed plugin package (`POST /api/plugins/:id/update`): re-fetches source, runs doctor, atomically replaces, and reloads. */
  updatePluginPackage?(pluginId: string): Promise<PluginUpdateResult>
  /** Remove a managed plugin package (`POST /api/plugins/:id/remove`): protects built-ins, live tasks, and providers; only deletes managed local copies. */
  removePluginPackage?(pluginId: string): Promise<PluginRemoveResult>
}

export type { SearchHit }

/** Session document event port (kernel-side `SessionDocEventHub` structural shape). */
export interface SessionDocEventPort {
  readonly seq: number
  subscribe(
    doc: { pluginId: string; name: string; conversationId: number },
    listener: (frame: { seq: number; event: unknown }) => void,
  ): () => void
  response(
    request: Request,
    options: {
      /** Sync snapshot provider: invoked after subscription is registered (avoids missing frames between
       * initial snapshot and subscribe); failures throw synchronously (mapped to structured error by HTTP);
       * internally re-validates public visibility and conversation existence. */
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

/** KernelRuntime shape consumed by the HTTP layer (structurally satisfied by KernelRuntime). */
export interface KernelRuntimeLike {
  readonly dataDir: string
  readonly auth: AuthService
  readonly events: EventHub
  /** Dedicated SSE stream port for session documents (returns 501 if unprovided). */
  readonly sessionDocEvents?: SessionDocEventPort
  readonly profiles: ProfileService
  readonly skills: SkillService
  readonly credentials: CredentialService
  readonly providers: ProviderService
  readonly artifacts: ArtifactService
  readonly plugins: PluginHost
  /**
   * Secret redaction hook (`SecretStash` on the real kernel). Outbound JSON string values and
   * server-side error logs pass through this to scrub registered secrets so plaintext or recovery markers never leak.
   */
  readonly stash?: {
    redact(text: string): string
    createStreamingRedactor?(): { push(text: string): string; flush(): string }
  }
  /**
   * Model catalog hot-reload port: awaited after providers/credentials changes so subsequent
   * `listModels` reflects the new configuration (persisting JSON without reloading breaks hot config).
   * Optional: HTTP layer skips if unprovided.
   */
  reloadModels?(): Promise<void>

  /**
   * Live Hub URL update port: called back after `startHub` binds (for `port: 0`) so CLI/tool
   * endpoints in the shell point to the actual listening address. Skipped if unprovided.
   */
  setHubUrl?(url: string): void

  listConversations(
    filter?: ConversationListFilter,
  ): Promise<ConversationSummary[]> | ConversationSummary[]
  /** Consumed by `GET /api/conversations/:id`: summary + paginated timeline. */
  getConversationDetail(
    id: number,
    opts?: { limit?: number; cursor?: string },
  ): Promise<ConversationDetail> | ConversationDetail
  /** Consumed by `GET /api/conversations/:id/entries/:entryId`: full untruncated, redacted entry
   * (with signatures stripped); entries overwritten by rewind return 404 consistently with detail pagination.
   * Optional: returns HTTP 501 when unprovided (same style as `withdrawQueuedInput`). */
  getConversationEntry?(
    id: number,
    entryId: number,
  ): Promise<ConversationEntry> | ConversationEntry
  /** GET /api/conversations/:id/files/content consume: read workspace file strictly inside conversation cwd. */
  readConversationFile?(
    id: number,
    path: string,
    signal?: AbortSignal,
  ): Promise<ConversationFileContent>
  createConversation(init?: ConversationInit): Promise<ConversationSummary> | ConversationSummary
  updateConversation(id: number, patch: ConversationPatch): Promise<ConversationSummary> | ConversationSummary
  deleteConversation(id: number): Promise<void> | void
  submitInput(
    id: number,
    text: string,
    opts?: {
      origin?: 'human' | 'agent' | 'trigger'
      /** Policy when conversation is busy; kernel defaults to `'steer'` when omitted. */
      whenBusy?: 'steer' | 'followUp' | 'reject'
      meta?: Record<string, unknown>
      attachments?: string[]
      /** Overwrite history in place starting at the specified entry ID (truncates it and subsequent context before appending new input). */
      replaceFromEntryId?: number
    },
  ): Promise<{ submissionId: string }> | { submissionId: string }
  /** Withdraw a queued input (`POST /api/conversations/:id/withdraw`). */
  withdrawQueuedInput?(
    id: number,
    opts: { submissionId: number },
  ): Promise<ConversationWithdrawResponse> | ConversationWithdrawResponse
  /** `?wait=1`: wait for a single submission to settle and return its result; throws HelmError on failure/abort. */
  waitForInput(
    id: number,
    submissionId: string,
    signal?: AbortSignal,
  ): Promise<ConversationInputResult> | ConversationInputResult
  abortConversation(id: number): Promise<void> | void
  /** Reset conversation context (starts a new context with optional handoff text); returns updated summary. */
  resetConversation(id: number, opts?: { handoff?: string }): Promise<ConversationSummary> | ConversationSummary
  /** Manually compact conversation context; returns compaction task ID and updated summary. */
  compactConversation(
    id: number,
    opts?: { instructions?: string },
  ): Promise<ConversationCompactResponse> | ConversationCompactResponse
  /** Fork a new conversation from the specified entry or latest clean anchor (inherits profile/cwd/model; parent chain points to source). */
  forkConversation(
    id: number,
    opts?: { entryId?: number; title?: string },
  ): Promise<ConversationSummary> | ConversationSummary

  listAsks(): Promise<AskSpec[]> | AskSpec[]
  answerAsk(id: string, answers: Record<string, string>, expectedStateSeq?: number): Promise<unknown> | unknown
  cancelAsk(id: string): Promise<void> | void

  search(query: string): Promise<SearchHit[]> | SearchHit[]
  listModels(): Promise<ModelCatalog> | ModelCatalog
  /** Configure disabled model list (`PUT /api/models/filter`); HTTP 501 if unimplemented. */
  setDisabledModels?(provider: string | undefined, disabledModels: string[]): Promise<ModelCatalog>
  /**
   * Model-disabled preflight (`ModelRegistry.assertModelEnabled`): called before saving `profile.model`,
   * global default model, etc. to reject disabled models (`409 model_disabled`).
   * Optional port: HTTP layer skips if unprovided.
   */
  assertModelEnabled?(provider: string, modelId: string): void
  /** Configure global default model, thinking level, compaction model, and compaction thinking level (`config.json`); empty string clears. HTTP 501 if unimplemented. */
  setDefaultModel?(
    model?: string,
    thinkingLevel?: string,
    compactionModel?: string,
    compactionThinkingLevel?: string,
    modelThinkingLevels?: Record<string, string>,
    modelThinkingUpdate?: { model: string; level: string },
  ): Promise<void>
  /** Set or clear one per-model thinking default (`config.json.modelThinkingLevels`); empty level clears the entry. HTTP 501 if unimplemented. */
  setModelThinkingDefault?(model: string, level: string): Promise<void>
  /** Sync bound conversations' models and thinking levels after saving a Profile. */
  alignProfileConversations?(profileId: string): Promise<void>
  listModelProviders(): Promise<ModelProviderSummary[]> | ModelProviderSummary[]
  /**
   * Dynamic model catalog refresh (`POST /api/models/refresh`): fetches latest catalogs from enabled providers
   * when `allowNetwork` is set and persists `models-store.json`. HTTP 501 if unprovided.
   */
  refreshModels?(options?: {
    providers?: string[]
    allowNetwork?: boolean
    force?: boolean
  }): Promise<ModelProvidersRefreshResult>

  // ---------------------------------------------------------------------------
  // Cross-platform node management (EnvFabric / nodes / env exec)
  // ---------------------------------------------------------------------------

  /** Node fabric substrate (attached to `/ws/node` gateway by `node-server`); gateway disabled if unprovided. */
  readonly envFabric?: EnvFabric
  /** List `local` + registered BYOM nodes with live online status (`GET /api/nodes`). */
  listNodes(): Promise<NodeInfo[]> | NodeInfo[]
  /** Issue a node access token (plaintext returned once in this response; server stores sha256 only). */
  issueNodeToken(nodeId: string): Promise<NodeIssuedToken> | NodeIssuedToken
  /** Remove a node: deletes from token table and immediately closes live connections (`DELETE /api/nodes/:id`). */
  removeNode(nodeId: string): Promise<void> | void
  /** Check available node updates (`GET /api/nodes/:id/upgrade/check`). */
  checkNodeUpgrade?(nodeId: string, input?: NodeUpgradeCheckInput): Promise<NodeUpgradeCheckResult> | NodeUpgradeCheckResult
  /** Trigger node upgrade and wait for commit confirmation (`POST /api/nodes/:id/upgrade`). */
  upgradeNode?(nodeId: string, input?: NodeUpgradeInput): Promise<NodeUpgradeResult> | NodeUpgradeResult
  /**
   * Start foreground port forwarding (`POST /api/nodes/:id/forward`): Hub listens on `listenHost:listenPort`
   * on demand and bridges each connection through a TCP tunnel to `targetHost:targetPort` on the target node;
   * the listener exists only in memory for the command's lifetime (torn down on monitor disconnect / stop / host close).
   */
  startNodeForward?(
    nodeId: string,
    input: { listenHost: string; listenPort: number; targetHost?: string; targetPort: number },
  ): Promise<NodeForwardSession> | NodeForwardSession
  /** Stop port forwarding (`DELETE /api/nodes/forward/:forwardId`); returns 404 when idempotently already stopped. */
  stopNodeForward?(forwardId: string): Promise<void> | void
  /** Live read of a forwarding session (`GET /api/nodes/forward/:forwardId`). */
  getNodeForward?(forwardId: string): NodeForwardSession | undefined
  /** Active forwarding session list (`GET /api/nodes/forward`). */
  listNodeForwards?(): NodeForwardSession[]
  /** Subscribe to forwarding events (`GET /api/nodes/forward/:forwardId/events`, NDJSON); closes cleanly after terminal `stopped` frame. */
  onNodeForwardEvent?(
    forwardId: string,
    listener: (event: NodeForwardEvent) => void,
  ): () => void
  /** Notify when forwarding terminates (called after terminal `stopped` frame; invokes immediately if already stopped). */
  onNodeForwardStopped?(forwardId: string, listener: () => void): () => void
  /**
   * Bind a foreground lease holder (when the events stream opens): explicitly creates a lease and returns a release
   * function (called on stream disconnect/cancel)—stopping forwarding when the last holder leaves.
   * Read-only list/get calls do not use this port (they are not lease holders).
   */
  acquireNodeForwardLease?(forwardId: string): () => void
  /**
   * Cross-node command execution (`POST /api/env/exec`): target resolves as explicit nodeId/cwd >
   * conversation binding > local; offline remote fails with `409 node_offline`; `onChunk` streams chunks
   * (NDJSON mode); `signal` propagates cancellation.
   */
  execEnv(
    req: EnvExecRequest,
    onChunk?: (chunk: { stream: 'stdout' | 'stderr'; text: string }) => void,
    signal?: AbortSignal,
  ): Promise<EnvExecResponse> | EnvExecResponse
}

/** Options and handle returned by `startHub`. */
export interface StartHubOptions {
  kernel: KernelRuntimeLike
  /** Defaults to 3202 (`HELM_PORT` convention; tests should use 0). */
  port?: number
  /** Defaults to `127.0.0.1`. */
  hostname?: string
  /**
   * Production static hosting directory (`packages/web/dist`): `false` disables it; omitting probes the
   * default location (enabled only if `index.html` exists); a string sets an explicit directory (fails at startup if invalid).
   * Passed through to `createHubHandler` under the same option name.
   */
  webDistDir?: string | false
}

export interface HubHandle {
  url: string
  close(): Promise<void>
}

// Export types used by tests to construct complete Profiles
export type { Profile, ProviderConfig, SkillSummary, ArtifactKind, ArtifactMetadata, AskSpec, ConversationSummary, ConversationDetail, ConversationEntry, ConversationInputResult, PluginSummary, PluginStatus, PluginDiagnosticError, PluginInUseItem, PluginConfigFieldSource, PluginConfigResponse, ActionManifest, PublicPluginDoc, NodeInfo, NodeIssuedToken, NodeUpgradeCheckInput, NodeUpgradeCheckResult, NodeUpgradeInput, NodeUpgradeResult, EnvExecRequest, EnvExecResponse, ModelCatalogEntry, ModelCatalog, ConversationCompactResponse, ConversationWithdrawResponse, PluginDoctorReport, PluginReloadResult, PluginRescanResult, PluginInstallResult, PluginUpdateResult, PluginRemoveResult }
