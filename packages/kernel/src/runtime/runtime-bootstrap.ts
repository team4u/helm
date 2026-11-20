/**
 * RuntimeBootstrap: startup environment bootstrapping for `KernelRuntime` (extracted from `KernelRuntime`).
 *
 * Responsibilities:
 * - Resolve and ensure the data directory (`dataDir`);
 * - Open the SQLite database (`HelmxDatabase`) and load global metadata (`HelmxStore`);
 * - Instantiate `ProviderService` and `CredentialService`, warming the API key cache;
 * - Construct the dynamic model catalog (`Models`) and cache store (`ModelsStore`);
 * - Open the underlying durable execution `Harness` and wire dynamic `models`/`redact` slots.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models, ModelsStore, Provider } from '@earendil-works/pi-ai'
import { Harness, createRegistry, type Registry, type SessionEnd } from '@earendil-works/pi-durable'
import { HelmxError } from '@helmx/protocol'
import { CredentialService, ProviderService, ensureDataDir, resolveDataDir } from '../services/index.js'
import type { PluginBuildProvider } from '@helmx/protocol'
import {
  createDiagnosticEmitter,
  type KernelDiagnosticEmitter,
  type KernelDiagnosticSink,
} from './diagnostics.js'
import { buildModels, wrapModelsForCompaction, type CompactionModelResolution } from './models.js'
import { createFileModelsStore } from './models-store.js'
import { assertModelsStoreHealthyAtBoot } from './runtime-helpers.js'
import { openHelmxDatabase, type HelmxDatabase } from './sqlite.js'
import { HelmxStore } from './store.js'
import type { ConversationTracker } from './conversations.js'

export interface KernelBootOptions {
  /** Injected Hub platform fact (for tests; defaults to `process.platform`). */
  hubPlatform?: () => string | undefined
  dataDir?: string
  model?: string
  cwd?: string
  hubUrl?: string
  autoResume?: boolean
  /**
   * Startup node-join grace budget (ms), bounded wait before recovery for registered remote nodes the
   * startup recovery depends on; `0` disables the wait entirely. Defaults from `resolveNodeJoinGraceMs()`
   * (env `HELMX_NODE_JOIN_GRACE_MS`, default 10s). Only effective on the explicit `kernel.start()` path
   * (the composition root listens before starting); `autoResume` startup skips it (no socket can be open yet).
   */
  nodeJoinGraceMs?: number
  models?: Models
  /**
   * Initial runtime providers injected alongside built-in providers before plugin activation
   * (mutually exclusive with `models`).
   */
  providers?: ReadonlyArray<Provider>
  nodeUpgradeTimeoutMs?: number
  /** Machine-level shared skill roots scanned together (defaults to `defaultExternalSkillRoots()`, i.e.
   * `~/.agents/skills`; pass `[]` for full test isolation). */
  externalSkillRoots?: readonly string[]
  /**
   * Plugin build port (`client.tsx` bundling + external plugin TS transpilation): injected with default
   * implementation (`@helmx/plugin-build`) by the composition root (`hub`); kernel carries no bundler.
   * Rejects explicitly when missing (`unsupported_client_build` / `unsupported_backend_ts_build`).
   */
  buildProvider?: PluginBuildProvider
  /** Optional diagnostic sink (receives redacted internal errors/warnings; defaults to `console.error`). */
  onDiagnostic?: KernelDiagnosticSink
}

export interface BootstrappedKernelContext {
  dataDir: string
  database: HelmxDatabase
  store: HelmxStore
  harness: Harness
  registry: Registry
  providersSvc: ProviderService
  credentials: CredentialService
  modelsInstance: Models
  modelsStore: ModelsStore
  apiKeyCache: Record<string, string>
  onDiagnostic?: KernelDiagnosticSink
  emitDiagnostic: KernelDiagnosticEmitter
  setModels(m: Models): void
  setCompactionModelResolver(fn: () => CompactionModelResolution): void
  redactReport(fn: (text: string) => string): void
  setFatalStorageHandler(
    fn: (source: 'harness' | 'store', error: unknown) => void,
    isClosing: () => boolean,
  ): void
}

/**
 * Bootstrap durable kernel storage and the `Harness` execution engine.
 */
export async function bootstrapKernelRuntime(
  options: KernelBootOptions = {},
): Promise<BootstrappedKernelContext> {
  if (options.models !== undefined && options.providers !== undefined) {
    throw new HelmxError(
      'validation_error',
      'KernelRuntimeOptions.models and KernelRuntimeOptions.providers are mutually exclusive',
      400,
    )
  }
  const dataDir = resolveDataDir(options.dataDir)
  await ensureDataDir(dataDir)
  const database = await openHelmxDatabase(dataDir)

  const redactSlot: { current: (text: string) => string } = { current: (t) => t }
  const emitDiagnostic = createDiagnosticEmitter({
    sink: options.onDiagnostic,
    redact: (text) => redactSlot.current(text),
  })
  const fatalHandlerSlot: { current: ((source: 'harness' | 'store', error: unknown) => void) | undefined } = {
    current: undefined,
  }
  const isClosingSlot: { current: () => boolean } = { current: () => false }
  const pendingBootFailures: Array<{ source: 'harness' | 'store'; error: unknown }> = []

  const dispatchFatalStorage = (source: 'harness' | 'store', error: unknown): void => {
    if (isClosingSlot.current()) return
    if (fatalHandlerSlot.current !== undefined) {
      fatalHandlerSlot.current(source, error)
      return
    }
    pendingBootFailures.push({ source, error })
    emitDiagnostic({
      level: 'error',
      source,
      message: source === 'store' ? 'HelmxStore persistence failed' : 'Harness closed due to fatal storage fault',
      error,
    })
  }

  const store = new HelmxStore(database, {
    onError: (error) => dispatchFatalStorage('store', error),
    onDiagnostic: options.onDiagnostic,
    redact: (text) => redactSlot.current(text),
  })
  await store.load()

  const providersSvc = new ProviderService(dataDir)
  const credentials = new CredentialService(dataDir)

  const providerConfigs = await providersSvc.list()
  const apiKeyCache: Record<string, string> = {}
  for (const id of await credentials.list()) {
    const key = await credentials.get(id)
    if (key) apiKeyCache[id] = key
  }

  const modelsExternal = options.models
  const modelsStore = createFileModelsStore(dataDir)
  const modelsInstance =
    modelsExternal ??
    buildModels({
      providers: providerConfigs,
      apiKeys: () => apiKeyCache,
      modelsStore,
    })

  if (!modelsExternal) {
    await assertModelsStoreHealthyAtBoot(modelsInstance)
  }

  const registry = createRegistry()
  const modelsSlot = { current: modelsInstance }
  const compactionResolverSlot: { current: () => CompactionModelResolution } = {
    current: () => ({ model: undefined, isDisabled: () => false }),
  }
  const compactionWrappedCache = new WeakMap<Models, Models>()

  const harness = await Harness.open(
    database.storage,
    {
      models: () =>
        wrapModelsForCompaction(
          modelsSlot.current,
          () => compactionResolverSlot.current(),
          compactionWrappedCache,
        ),
      registry,
      settings: {
        followUpMode: 'all',
        steeringMode: 'all',
      },
      onReport: (report) => {
        const description =
          report.kind === 'extension_error'
            ? `extension_error(${report.extension ?? 'unknown'})`
            : report.kind === 'task_faulted' || report.kind === 'task_interrupted'
              ? `${report.kind}(${report.task.kind})`
              : report.kind
        const convId =
          'conversationId' in report && typeof report.conversationId === 'number'
            ? (report.conversationId as number)
            : 'task' in report && report.task !== undefined && typeof report.task.conversationId === 'number'
              ? (report.task.conversationId as number)
              : undefined
        emitDiagnostic({
          level: 'error',
          source: 'durable',
          message: `durable report: ${description}`,
          error: (report as { error?: unknown }).error,
          ...(convId !== undefined ? { conversationId: convId } : {}),
        })
      },
    },
    BACKGROUND_CONTEXT,
  )

  void harness.closed.then(
    (end: SessionEnd) => {
      if (end.kind === 'closed' || isClosingSlot.current()) return
      dispatchFatalStorage('harness', end.error)
    },
    (error: unknown) => {
      if (isClosingSlot.current()) return
      dispatchFatalStorage('harness', error)
    },
  )

  return {
    dataDir,
    database,
    store,
    harness,
    registry,
    providersSvc,
    credentials,
    modelsInstance,
    modelsStore,
    apiKeyCache,
    onDiagnostic: options.onDiagnostic,
    emitDiagnostic,
    setModels: (m: Models) => {
      modelsSlot.current = m
    },
    setCompactionModelResolver: (fn: () => CompactionModelResolution) => {
      compactionResolverSlot.current = fn
    },
    redactReport: (fn: (text: string) => string) => {
      redactSlot.current = fn
    },
    setFatalStorageHandler: (fn, isClosing) => {
      fatalHandlerSlot.current = fn
      isClosingSlot.current = isClosing
      while (pendingBootFailures.length > 0) {
        const next = pendingBootFailures.shift()!
        if (!isClosing()) fn(next.source, next.error)
      }
    },
  }
}

/**
 * Ensure the initial entry conversation (`#1` host assistant) is created and registered for tracking.
 * Note: initial title `'person assist'` is preserved for existing integration test compatibility.
 */
export async function ensureInitialConversation(deps: {
  harness: Harness
  store: HelmxStore
  tracker: ConversationTracker
  conversations: {
    resolveEffectiveThinkingLevel(levelOverride?: string, profileId?: string, modelRef?: { provider: string; modelId: string }): Promise<string | undefined>
    resolveEffectiveModel(modelOverride?: string, profileId?: string): Promise<string | undefined>
  }
  modelsRegistry: {
    parseModelRefOrThrow(ref: string): { provider: string; modelId: string }
  }
  cwd: string
}): Promise<void> {
  const effective = await deps.conversations.resolveEffectiveModel(undefined, 'assistant')
  const modelRef = effective ? deps.modelsRegistry.parseModelRefOrThrow(effective) : undefined
  const thinking = await deps.conversations.resolveEffectiveThinkingLevel(undefined, 'assistant', modelRef)
  const root = await deps.harness.root(BACKGROUND_CONTEXT, {
    agent: {
      ...(modelRef ? { model: { provider: modelRef.provider, modelId: modelRef.modelId } } : {}),
      ...(thinking ? { thinkingLevel: thinking as never } : {}),
    },
  })
  const id = root.id as number
  if (deps.store.isDeleted(id)) return
  if (!deps.store.getConv(id)) {
    deps.store.upsertConv({
      id,
      title: 'person assist',
      profileId: 'assistant',
      tags: ['assistant'],
      nodeId: 'local',
      cwd: deps.cwd,
      model: effective ?? '',
      thinkingLevel: thinking ?? '',
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
  }
  await deps.tracker.observe(id)
}

/**
 * Recover and align metadata for incomplete conversations on startup.
 */
export async function recoverExistingConversations(deps: {
  conversations: {
    recover(syncConv: (id: number, parentConversationId?: number) => Promise<void>): Promise<void>
  }
  harness: Harness
  store: HelmxStore
  defaultCwd: string
}): Promise<void> {
  await deps.conversations.recover(async (id, parentConversationId) => {
    const now = Date.now()
    const conversation = await deps.harness.conversation(id as never, BACKGROUND_CONTEXT)
    const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined) : undefined
    deps.store.upsertConv({
      id,
      title: `conversation ${id}`,
      profileId: 'assistant',
      tags: [],
      parentConversationId,
      cwd: agent?.cwd ?? deps.defaultCwd,
      model:
        agent?.model !== undefined
          ? `${agent.model.provider}/${agent.model.modelId}`
          : '',
      thinkingLevel: (agent as { thinkingLevel?: string } | undefined)?.thinkingLevel ?? '',
      nodeId: 'local',
      unread: false,
      pinned: false,
      stateChangeSeq: 1,
      completionSeq: 0,
      createdAt: now,
      updatedAt: now,
    })
  })
}

/**
 * Shutdown resource cleanup and persistence flush pipeline.
 */
export async function teardownKernelRuntime(deps: {
  modelsRegistry: {
    abortRefresh(err: Error): void
    dispose(): Promise<void>
  }
  assetReloader: {
    stop(): void
    waitForInflight(): Promise<void>
  }
  nodes: {
    dispose(): Promise<void>
  }
  settledInflight: () => Promise<void>
  store: HelmxStore
  harness: Harness
  tracker: ConversationTracker
  pluginHost?: {
    dispose(): Promise<void>
  }
  envFabric: {
    dispose(): Promise<void>
  }
  nodeForward?: {
    close(): Promise<void>
  }
  processTokenHandle?: {
    dispose(): void
  }
  database: HelmxDatabase
  events: {
    close(): void
  }
  sessionDocStreams: {
    close(): void
  }
  sessionDocLifecycleRelease?: () => void
  stashService: {
    clear(): void
  }
  emitDiagnostic?: KernelDiagnosticEmitter
}): Promise<void> {
  // Each step is isolated: a failure in one step is recorded while teardown continues closing remaining
  // resources (preventing skipped harness/store/database/events closes and SQLite handle leaks). All failures
  // surface together at the end so shutdown never silently claims success.
  const emitDiagnostic = deps.emitDiagnostic ?? createDiagnosticEmitter()
  const failures: string[] = []
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      failures.push(`${name}: ${String(error)}`)
      emitDiagnostic({
        level: 'error',
        source: 'teardown',
        message: `Teardown step '${name}' failed (continuing to close remaining resources)`,
        error,
      })
    }
  }

  deps.modelsRegistry.abortRefresh(new Error('kernel closing'))
  deps.assetReloader.stop()
  await step('nodes.dispose', () => deps.nodes.dispose())
  await step('assetReloader.waitForInflight', () => deps.assetReloader.waitForInflight())
  await step('modelsRegistry.dispose', () => deps.modelsRegistry.dispose())
  // Close Harness first while pluginHost, envFabric, HelmxStore, and managed tokens are still online:
  // in-flight GenerationTask/ToolTask revert cleanly to pending via writeAtClose() (not marked aborted,
  // and not counted toward restarts) so they resume cleanly on next startup.
  await step('harness.close', () => deps.harness.close(BACKGROUND_CONTEXT))
  await step('settledInflight', () => deps.settledInflight())
  deps.tracker.close()
  await step('pluginHost.dispose', () => deps.pluginHost?.dispose() ?? Promise.resolve())
  // Drain callbacks scheduled during the pluginHost stop window to avoid racing store.close.
  await step('settledInflight#2', () => deps.settledInflight())
  await step('nodeForward.close', () => deps.nodeForward?.close() ?? Promise.resolve())
  await step('envFabric.dispose', () => deps.envFabric.dispose())
  deps.processTokenHandle?.dispose()
  let storeError: unknown
  try {
    storeError = await deps.store.close()
  } catch (error) {
    storeError = error
    failures.push(`store.close: ${String(error)}`)
    emitDiagnostic({
      level: 'error',
      source: 'teardown',
      message: `Teardown step 'store.close' failed (continuing to close remaining resources)`,
      error,
    })
  }
  await step('database.close', () => deps.database.close())
  deps.events.close()
  deps.sessionDocLifecycleRelease?.()
  deps.sessionDocStreams.close()
  deps.stashService.clear()
  if (storeError !== undefined || failures.length > 0) {
    const detail = failures.join('; ')
    if (storeError !== undefined) {
      throw new HelmxError(
        'store_flush_failed',
        `Persistence flush failed on close: ${String(storeError)}` + (detail === '' ? '' : `; additional teardown failures: ${detail}`),
        500,
        { error: String(storeError), ...(detail === '' ? {} : { failures: detail }) },
      )
    }
    throw new HelmxError('teardown_failed', `Partial failure during shutdown teardown: ${detail}`, 500, { failures: detail })
  }
}


/**
 * Default startup node-join grace budget (ms): bounded wait before recovery for registered remote nodes
 * that startup recovery depends on (0 disables). Sourced from `HELMX_NODE_JOIN_GRACE_MS`; invalid values
 * (non-numeric / negative) fail startup explicitly rather than being silently coerced.
 */
export const DEFAULT_NODE_JOIN_GRACE_MS = 10_000

export function resolveNodeJoinGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env['HELMX_NODE_JOIN_GRACE_MS']
  if (raw === undefined || raw === '') return DEFAULT_NODE_JOIN_GRACE_MS
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) {
    throw new HelmxError(
      'config_corrupt',
      `HELMX_NODE_JOIN_GRACE_MS must be a non-negative integer (received '${raw}')`,
      500,
      { value: raw },
    )
  }
  return value
}
