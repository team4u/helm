/**
 * RuntimeBootstrap：KernelRuntime 启动自举环境（从 KernelRuntime 拆出）。
 *
 * 职责：
 * - 解析与确保数据目录（dataDir）；
 * - 打开 SQLite 数据库（HelmDatabase）并加载全局元数据（HelmStore）；
 * - 实例化 ProviderService 与 CredentialService，预热 API Key 缓存；
 * - 构造动态模型集合（Models）与缓存存储（ModelsStore）；
 * - 打开底座持久执行 Harness 并连接 models/redact 动态插槽。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models, ModelsStore } from '@earendil-works/pi-ai'
import { Harness, createRegistry, type Registry } from '@earendil-works/pi-durable'
import { HelmError } from '@helm/protocol'
import { CredentialService, ProviderService, ensureDataDir, resolveDataDir } from '../services/index.js'
import { buildModels } from './models.js'
import { createFileModelsStore } from './models-store.js'
import { assertModelsStoreHealthyAtBoot } from './runtime-helpers.js'
import { openHelmDatabase, type HelmDatabase } from './sqlite.js'
import { HelmStore } from './store.js'
import type { ConversationTracker } from './conversations.js'

export interface KernelBootOptions {
  dataDir?: string
  model?: string
  cwd?: string
  hubUrl?: string
  autoResume?: boolean
  models?: Models
  nodeUpgradeTimeoutMs?: number
  /** 只读合入的机器级共享技能根（缺省 defaultExternalSkillRoots()，即
   * ~/.agents/skills；传空数组可完全隔离，测试用）。 */
  externalSkillRoots?: readonly string[]
}

export interface BootstrappedKernelContext {
  dataDir: string
  database: HelmDatabase
  store: HelmStore
  harness: Harness
  registry: Registry
  providersSvc: ProviderService
  credentials: CredentialService
  modelsInstance: Models
  modelsStore: ModelsStore
  apiKeyCache: Record<string, string>
  setModels(m: Models): void
  redactReport(fn: (text: string) => string): void
}

/**
 * 自举内核持久存储与 Harness 执行引擎。
 */
export async function bootstrapKernelRuntime(
  options: KernelBootOptions = {},
): Promise<BootstrappedKernelContext> {
  const dataDir = resolveDataDir(options.dataDir)
  await ensureDataDir(dataDir)
  const database = await openHelmDatabase(dataDir)
  const store = new HelmStore(database)
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
  const redactSlot: { current: (text: string) => string } = { current: (t) => t }

  const harness = await Harness.open(
    database.storage,
    {
      models: () => modelsSlot.current,
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
        const errorText = String((report as { error?: unknown }).error ?? '')
        console.error('[helm] durable report:', description, redactSlot.current(errorText))
      },
    },
    BACKGROUND_CONTEXT,
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
    setModels: (m: Models) => {
      modelsSlot.current = m
    },
    redactReport: (fn: (text: string) => string) => {
      redactSlot.current = fn
    },
  }
}

/**
 * 确保初始入口会话（#1 承载，个人助理）已创建并纳管。
 */
export async function ensureInitialConversation(deps: {
  harness: Harness
  store: HelmStore
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
      title: '个人助理',
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
 * 恢复并对齐未完成会话的状态机元数据。
 */
export async function recoverExistingConversations(deps: {
  conversations: {
    recover(syncConv: (id: number, parentConversationId?: number) => Promise<void>): Promise<void>
  }
  harness: Harness
  store: HelmStore
  defaultCwd: string
}): Promise<void> {
  await deps.conversations.recover(async (id, parentConversationId) => {
    const now = Date.now()
    const conversation = await deps.harness.conversation(id as never, BACKGROUND_CONTEXT)
    const agent = conversation ? await conversation.agent(BACKGROUND_CONTEXT).catch(() => undefined) : undefined
    deps.store.upsertConv({
      id,
      title: `会话 ${id}`,
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
 * 运行时关闭资源释放与持久化刷新流程。
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
  store: HelmStore
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
  database: HelmDatabase
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
}): Promise<void> {
  // 每步独立隔离：任一步失败只记录并继续关停其余资源（否则 harness/store/
  // database/events 的 close 被跳过，SQLite 句柄泄漏）；全部执行完后统一上抛，
  // 绝不流报成功关停。
  const failures: string[] = []
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run()
    } catch (error) {
      failures.push(`${name}: ${String(error)}`)
      console.error(`[helm] teardown 步骤 ${name} 失败（继续关停其余资源）:`, error)
    }
  }

  deps.modelsRegistry.abortRefresh(new Error('kernel closing'))
  deps.assetReloader.stop()
  await step('nodes.dispose', () => deps.nodes.dispose())
  await step('assetReloader.waitForInflight', () => deps.assetReloader.waitForInflight())
  await step('modelsRegistry.dispose', () => deps.modelsRegistry.dispose())
  await step('settledInflight', () => deps.settledInflight())
  const closeAborts: Array<Promise<void>> = []
  for (const meta of deps.store.listConvs()) {
    const conversation = await deps.harness
      .conversation(meta.id as never, BACKGROUND_CONTEXT)
      .catch(() => undefined)
    if (!conversation) continue
    const wasBusy = deps.tracker.hasLiveWork(meta.id)
    closeAborts.push(
      conversation
        .abort(BACKGROUND_CONTEXT)
        .then(() => {
          if (wasBusy) deps.tracker.settleAborted(meta.id)
        })
        .catch(() => {}),
    )
  }
  await Promise.allSettled(closeAborts)
  // abort 唤醒的回合在 settle 链上追加新的 turn_settled 回调：getter 现读
  // 最新链再等待一轮，防止中止触发的结算写入与 store.close 竞态。
  await step('settledInflight#2', () => deps.settledInflight())
  await step('settledInflight#3', () => deps.settledInflight())
  await step('pluginHost.dispose', () => deps.pluginHost?.dispose() ?? Promise.resolve())
  await step('nodeForward.close', () => deps.nodeForward?.close() ?? Promise.resolve())
  await step('envFabric.dispose', () => deps.envFabric.dispose())
  deps.processTokenHandle?.dispose()
  await step('harness.close', () => deps.harness.close(BACKGROUND_CONTEXT))
  let storeError: unknown
  try {
    storeError = await deps.store.close()
  } catch (error) {
    storeError = error
    failures.push(`store.close: ${String(error)}`)
    console.error('[helm] teardown 步骤 store.close 失败（继续关停其余资源）:', error)
  }
  await step('database.close', () => deps.database.close())
  deps.events.close()
  deps.sessionDocLifecycleRelease?.()
  deps.sessionDocStreams.close()
  deps.stashService.clear()
  if (storeError !== undefined || failures.length > 0) {
    const detail = failures.join('; ')
    if (storeError !== undefined) {
      throw new HelmError(
        'store_flush_failed',
        `退出时持久化失败：${String(storeError)}` + (detail === '' ? '' : `；其余关停失败：${detail}`),
        500,
        { error: String(storeError), ...(detail === '' ? {} : { failures: detail }) },
      )
    }
    throw new HelmError('teardown_failed', `退出关停部分失败：${detail}`, 500, { failures: detail })
  }
}

