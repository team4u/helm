/**
 * builtin:superagent：实验性双层中枢（Router + Worker + RecallGraph）。
 *
 * 模块化拆分架构：
 * - ./superagent/contracts.ts: 领域模型、状态机契约、边界守卫与配置校验
 * - ./superagent/recall.ts: RecallGraph 记忆图谱断言、增删检与 rewind 联动
 * - ./superagent/settlement.ts: Worker 回合终态摘要提取、时间线摘要与脱敏
 * - ./superagent/ui.ts: 前端侧栏、挂件、药丸、工具视图与全屏视图声明
 * - ./superagent/runtime-bootstrap.ts: 按需动态加载的运行时装配根（actions /
 *   hooks / assets / watchdog 及 8 个 watchdog-* 子模块），仅在插件启用时加载，
 *   默认停用注册零重模块解析开销。
 */
import {
  type ConversationScope,
  type HelmPluginContext,
  type PluginDefinition,
} from '@helm/protocol'
import { resolvePluginClientAssets } from './asset-paths.js'
import {
  DEFAULT_CONFIG,
  INDEX_DOC_NAME,
  RECALL_DOC_NAME,
  ROUTER_TOOL_SCOPE,
  ROUTING_DOC_NAME,
  SUBSCRIPTIONS_DOC_NAME,
  SUPERAGENT_PLUGIN_ID,
  WATCHDOG_PROFILE_ID,
  type RecallGraphDoc,
  type RouterModeDoc,
  type SuperAgentDocs,
  type SuperAgentIndexDoc,
  type ThreadSubscriptionDoc,
} from './superagent/contracts.js'
import { registerSuperAgentUi } from './superagent/ui.js'
import type { WatchdogDedupDoc } from './superagent/watchdog-dedup.js'
import type {
  SuperAgentRuntimeController,
  SuperAgentRuntimeModule,
} from './superagent/runtime-bootstrap.js'

// ---------------------------------------------------------------------------
// 声明期轻量元数据（工具与动作 Schema；执行期委托至懒加载运行时）
// ---------------------------------------------------------------------------

const WORKER_ID_SCHEMA: Record<string, unknown> = { type: 'integer', minimum: 1 }

const WORKER_ID_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { workerConversationId: WORKER_ID_SCHEMA },
  required: ['workerConversationId'],
  additionalProperties: false,
}

const DISPATCH_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: { type: 'string', minLength: 1 },
    profileId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
    title: { type: 'string', minLength: 1, maxLength: 80 },
    threadKey: { type: 'string', minLength: 1, maxLength: 200 },
    cwd: { type: 'string', minLength: 1 },
    nodeId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[^\\s/\\\\]+$' },
  },
  required: ['prompt'],
  additionalProperties: false,
}

const RECALL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
  additionalProperties: false,
}

const SUBSCRIBE_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { threadKey: { type: 'string', minLength: 1, maxLength: 200 }, workerConversationId: WORKER_ID_SCHEMA },
  required: ['threadKey', 'workerConversationId'],
  additionalProperties: false,
}

const WATCHDOG_SCOPE: ConversationScope = { profileIds: [WATCHDOG_PROFILE_ID] }

const WATCHDOG_INSPECT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conversationId: { type: 'integer', minimum: 1, description: 'Native target conversation ID (positive integer)' },
    probe: {
      type: 'object',
      properties: {
        targetKind: { type: 'string', enum: ['external'] },
        nodeId: { type: 'string', minLength: 1, description: "External target node ID (defaults to 'local')" },
        targetId: { type: 'string', minLength: 1 },
      },
      required: ['targetKind', 'targetId'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
}

const WATCHDOG_INSPECT_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['conversation', 'external'] },
    conversation: {
      type: 'object',
      properties: {
        activeProcesses: {
          type: 'array',
          description: 'Process-occupancy snapshot of the conversation working directory (nodeId ?? local, cwd) (redacted; omitted when probing fails)',
          items: {
            type: 'object',
            properties: {
              pid: { type: 'integer', minimum: 1 },
              name: { type: 'string', description: 'Process name (omitted when reading fails)' },
              source: { type: 'string', enum: ['cwd', 'fd'] },
              path: { type: 'string', description: 'Referrer absolute path (redacted)' },
            },
            required: ['pid', 'source', 'path'],
            additionalProperties: false,
          },
        },
      },
    },
    entries: { type: 'array', items: { type: 'object' } },
    probe: { type: 'object' },
  },
  required: ['kind'],
  additionalProperties: false,
}

const WATCHDOG_RECOVER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conversationId: { type: 'integer', minimum: 1 },
    hint: { type: 'string', minLength: 1, description: 'Recovery hint text (submitted to the target conversation with agent origin)' },
    expectedStateSeq: {
      type: 'integer',
      minimum: 0,
      description: 'Optional CAS watermark (live stateChangeSeq from watchdog_inspect); when provided, rejects if the target state has advanced',
    },
  },
  required: ['conversationId', 'hint'],
  additionalProperties: false,
}

const WATCHDOG_ABORT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conversationId: { type: 'integer', minimum: 1 },
    reason: { type: 'string', minLength: 1 },
    expectedStateSeq: {
      type: 'integer',
      minimum: 0,
      description: 'Optional CAS watermark (live stateChangeSeq from watchdog_inspect); when provided, rejects if the target state has advanced',
    },
  },
  required: ['conversationId'],
  additionalProperties: false,
}

const WATCHDOG_MUTATION_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    conversationId: { type: 'integer', minimum: 1 },
    submitted: { type: 'boolean' },
    aborted: { type: 'boolean' },
  },
  required: ['conversationId'],
  additionalProperties: false,
}

interface DeclarativeToolSpec {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  scope: ConversationScope
}

interface DeclarativeActionSpec {
  id: string
  description: string
  idempotent?: boolean
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  scope?: ConversationScope
}

const TOOL_SPECS: ReadonlyArray<DeclarativeToolSpec> = [
  {
    name: 'dispatch_worker',
    description:
      'Spawn a background worker conversation to execute a task without blocking (returns workerConversationId immediately, without waiting for the model turn to finish). Optionally pin an expert Profile via profileId and bind an event subscription via threadKey.',
    inputSchema: DISPATCH_INPUT_SCHEMA,
    scope: ROUTER_TOOL_SCOPE,
  },
  {
    name: 'inspect_worker',
    description: "Read a background worker's recent timeline summary and artifact list.",
    inputSchema: WORKER_ID_INPUT_SCHEMA,
    scope: ROUTER_TOOL_SCOPE,
  },
  {
    name: 'recall_context',
    description: 'Search the RecallGraph memory graph (filters historical task-summary nodes by keywords, multiple words AND-combined).',
    inputSchema: RECALL_INPUT_SCHEMA,
    scope: ROUTER_TOOL_SCOPE,
  },
  {
    name: 'subscribe_thread',
    description: 'Bind a threadKey event subscription to the given background worker (conflicts are explicitly rejected, never preempted).',
    inputSchema: SUBSCRIBE_INPUT_SCHEMA,
    scope: ROUTER_TOOL_SCOPE,
  },
  {
    name: 'watchdog_inspect',
    description:
      'Read the real details of an inspection target: conversationId returns the native conversation summary and recent timeline (ownership checked live); probe returns the latest external-target probe facts (read-only; never pretends to control external panes).',
    inputSchema: WATCHDOG_INSPECT_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
  {
    name: 'watchdog_recover',
    description:
      'Submit a recovery hint to an owned (helm/bot) native conversation (agent origin, without waiting for a model turn); ownership is atomically rechecked at the effect point via the kernel guarded port; human targets are rejected.',
    inputSchema: WATCHDOG_RECOVER_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
  {
    name: 'watchdog_abort',
    description:
      'Abort an owned (helm/bot) native conversation; ownership is atomically rechecked at the effect point via the kernel guarded port; human/root/hub/watchdog-itself are rejected. External panes can only be aborted indirectly via their owned parent conversation.',
    inputSchema: WATCHDOG_ABORT_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
]

const ACTION_SPECS: ReadonlyArray<DeclarativeActionSpec> = [
  {
    id: 'dispatch_worker',
    description: 'Spawn a background worker without blocking (hub conversation or manual HTTP/CLI calls).',
    inputSchema: DISPATCH_INPUT_SCHEMA,
    outputSchema: {
      type: 'object',
      properties: { workerConversationId: { type: 'number' } },
      required: ['workerConversationId'],
      additionalProperties: false,
    },
  },
  {
    id: 'inspect_worker',
    description: "Read a background worker's recent timeline summary and artifact list.",
    idempotent: true,
    inputSchema: WORKER_ID_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
  },
  {
    id: 'recall_context',
    description: 'Search the RecallGraph memory graph.',
    idempotent: true,
    inputSchema: RECALL_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
  },
  {
    id: 'subscribe_thread',
    description: 'Bind a threadKey event subscription to the given background worker.',
    inputSchema: SUBSCRIBE_INPUT_SCHEMA,
    outputSchema: { type: 'object' },
  },
  {
    id: 'archive_worker',
    description: 'Archive a finished worker: unbinds subscriptions and swaps the worker tag for worker-archived (hub conversation or manual calls).',
    inputSchema: WORKER_ID_INPUT_SCHEMA,
    outputSchema: {
      type: 'object',
      properties: { archived: { type: 'boolean' } },
      required: ['archived'],
      additionalProperties: false,
    },
  },
  {
    id: 'set_router_mode',
    description: 'Persistently change the hub router convergence mode (writes the plugin config routerMode, effective immediately).',
    inputSchema: {
      type: 'object',
      properties: { enabled: { type: 'boolean' } },
      required: ['enabled'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { routerMode: { type: 'boolean' } },
      required: ['routerMode'],
      additionalProperties: false,
    },
  },
  {
    id: 'watchdog_inspect',
    description: 'Read the real details of an inspection target (native conversation or the latest external probe facts, read-only)',
    idempotent: true,
    inputSchema: WATCHDOG_INSPECT_SCHEMA,
    outputSchema: WATCHDOG_INSPECT_OUTPUT_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
  {
    id: 'watchdog_recover',
    description: 'Submit a recovery hint to an owned native conversation (agent origin, without waiting for a model turn; ownership atomically rechecked via the kernel guarded port)',
    inputSchema: WATCHDOG_RECOVER_SCHEMA,
    outputSchema: WATCHDOG_MUTATION_OUTPUT_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
  {
    id: 'watchdog_abort',
    description: 'Abort an owned native conversation (human/root/hub/watchdog-itself rejected; ownership atomically rechecked via the kernel guarded port)',
    inputSchema: WATCHDOG_ABORT_SCHEMA,
    outputSchema: WATCHDOG_MUTATION_OUTPUT_SCHEMA,
    scope: WATCHDOG_SCOPE,
  },
  {
    id: 'watchdog_tick',
    description: 'Manually trigger one watchdog inspection round (collects native-conversation and external probe facts and runs the rule table)',
    idempotent: false,
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        timestamp: { type: 'number' },
        conversations: { type: 'integer', minimum: 0 },
        probes: { type: 'integer', minimum: 0 },
        skipped: { type: 'boolean' },
      },
      required: ['timestamp', 'conversations', 'probes'],
      additionalProperties: false,
    },
    scope: WATCHDOG_SCOPE,
  },
]

let runtimeModulePromise: Promise<SuperAgentRuntimeModule> | undefined

function loadSuperAgentRuntimeModule(): Promise<SuperAgentRuntimeModule> {
  runtimeModulePromise ??= import('./superagent/runtime-bootstrap.js').catch((err) => {
    runtimeModulePromise = undefined
    throw err
  })
  return runtimeModulePromise
}

function registerDeclarativeCapabilities(
  ctx: HelmPluginContext,
  ensureRuntime: () => Promise<SuperAgentRuntimeController>,
): void {
  for (const spec of TOOL_SPECS) {
    ctx.tool({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      scope: spec.scope,
      execute: async (input, context) => (await ensureRuntime()).executeTool(spec.name, input, context),
    })
  }
  for (const spec of ACTION_SPECS) {
    ctx.action({
      id: spec.id,
      description: spec.description,
      ...(spec.idempotent !== undefined ? { idempotent: spec.idempotent } : {}),
      inputSchema: spec.inputSchema,
      outputSchema: spec.outputSchema,
      ...(spec.scope !== undefined ? { scope: spec.scope } : {}),
      handler: async (input, context) => (await ensureRuntime()).invokeAction(spec.id, input, context),
    })
  }
}

// ---------------------------------------------------------------------------
// 插件工厂
// ---------------------------------------------------------------------------

export function createSuperAgentPlugin(): PluginDefinition {
  return {
    id: SUPERAGENT_PLUGIN_ID,
    name: { en: 'SuperAgent Hub', 'zh-CN': 'SuperAgent 中枢' },
    description: {
      en: 'Two-tier hub: the router dispatches expert-Profile background workers by name, with archived reporting and a two-layer inspection watchdog.',
      'zh-CN': '双层中枢：总控路由点名专家 Profile 派生后台 Worker，附归档汇报与两层巡检看门狗。',
    },
    icon: 'sparkles',
    version: '0.1.0',
    ...resolvePluginClientAssets(SUPERAGENT_PLUGIN_ID, 'superagent', 'superagent_plugin_client_missing'),
    definePlugin(ctx) {
      let runtime: SuperAgentRuntimeController | undefined
      let runtimePromise: Promise<SuperAgentRuntimeController> | undefined

      const docs: SuperAgentDocs = {
        index: ctx.doc<SuperAgentIndexDoc>(INDEX_DOC_NAME, { version: 1, workers: [] }, { public: true }),
        subscriptions: ctx.doc<ThreadSubscriptionDoc>(SUBSCRIPTIONS_DOC_NAME, { version: 1, subscriptions: [] }, { public: true }),
        recall: ctx.doc<RecallGraphDoc>(RECALL_DOC_NAME, { version: 1, nodes: [] }, { public: true }),
        routing: ctx.doc<RouterModeDoc>(ROUTING_DOC_NAME, { version: 1, routerMode: DEFAULT_CONFIG.routerMode }, { public: true }),
      }
      const watchdogDedupDoc = ctx.doc<WatchdogDedupDoc>('watchdog-dedup', { version: 1, fired: {} })

      async function ensureRuntime(): Promise<SuperAgentRuntimeController> {
        if (runtime !== undefined) return runtime
        runtimePromise ??= loadSuperAgentRuntimeModule()
          .then((mod) => {
            runtime = mod.createSuperAgentRuntime({ ctx, docs, watchdogDedupDoc })
            return runtime
          })
          .catch((err) => {
            runtimePromise = undefined
            throw err
          })
        return runtimePromise
      }

      // 声明 UI、配置、工具、动作与 Hook 壳（零重模块静态导入）
      registerSuperAgentUi(ctx)
      registerDeclarativeCapabilities(ctx, ensureRuntime)

      // 核心路由/结算 Hook（未启动前 active=false，直接放行）
      ctx.hook.onTrigger((envelope) => runtime?.runTrigger(envelope))
      ctx.hook.onBeforeTurn((turn) => runtime?.runCoreBeforeTurn(turn))
      ctx.hook.onToolCall((payload) => runtime?.runCoreToolCall(payload))
      ctx.hook.onTurnSettled(async (payload) => {
        await runtime?.runCoreTurnSettled(payload)
      })

      // Watchdog 会话守卫 Hook（按原注册顺序挂载于核心 Hook 之后）
      ctx.hook.onTurnSettled(async (payload) => {
        const rt = await ensureRuntime()
        await rt.runWatchdogTurnSettled(payload)
      })
      ctx.hook.onBeforeTurn(async (turn) => {
        const rt = await ensureRuntime()
        return rt.runWatchdogBeforeTurn(turn)
      })
      ctx.hook.onToolCall(async (payload) => {
        const rt = await ensureRuntime()
        return rt.runWatchdogToolCall(payload)
      })

      // 注册配置 Schema
      ctx.configSchema({
        routerMode: {
          type: 'boolean',
          label: { en: 'Router convergence mode', 'zh-CN': '中枢路由收敛模式' },
          description: {
            en: 'When on, the hub conversation sheds heavyweight blocking tools, keeping only dispatch and memory tools',
            'zh-CN': '开启后中枢会话剥离重度阻塞工具，仅保留派工与记忆工具',
          },
          default: true,
        },
        mutedSources: {
          type: 'string',
          label: { en: 'Muted event sources', 'zh-CN': '静默事件源' },
          description: {
            en: 'Exact source names separated by commas or newlines; matches are dropped at zero token cost',
            'zh-CN': '逗号或换行分隔的精确 source 名称，命中即 0-Token 丢弃',
          },
          default: '',
        },
        watchdogEnabled: {
          type: 'boolean',
          label: { en: 'Enable watchdog', 'zh-CN': '启用看门狗' },
          description: { en: 'Turn off to skip the watchdog inspection policy', 'zh-CN': '关闭后不执行 Watchdog 巡检策略' },
          default: true,
        },
        stalledAfterMs: {
          type: 'number',
          label: { en: 'Stall threshold (ms)', 'zh-CN': '停滞判定（毫秒）' },
          description: { en: 'Idle longer than this is treated as stalled', 'zh-CN': '超过此时长视为停滞' },
          default: 300_000,
        },
        abortAfterMs: {
          type: 'number',
          label: { en: 'Auto-abort (ms)', 'zh-CN': '自动中止（毫秒）' },
          description: { en: 'Must be greater than or equal to the stall threshold', 'zh-CN': '必须大于等于停滞判定' },
          default: 1_800_000,
        },
        errorThreshold: {
          type: 'number',
          label: { en: 'Consecutive error threshold', 'zh-CN': '连续报错阈值' },
          description: { en: 'This many consecutive errors wakes the watchdog', 'zh-CN': '达到阈值唤醒看门狗' },
          default: 3,
        },
      })

      // 注册双服务（按原声明顺序：superagent-core 先于 superagent-watchdog）
      ctx.service({
        id: 'superagent-core',
        liveTasks() {
          return runtime ? runtime.coreLiveTasks() : []
        },
        async prepare() {
          await ensureRuntime()
        },
        async start() {
          const rt = await ensureRuntime()
          await rt.startCore()
        },
        async stop() {
          if (runtime === undefined && runtimePromise !== undefined) {
            await runtimePromise.catch(() => undefined)
          }
          await runtime?.stopCore()
        },
      })

      ctx.service({
        id: 'superagent-watchdog',
        liveTasks() {
          return runtime ? runtime.watchdogLiveTasks() : []
        },
        async start() {
          const rt = await ensureRuntime()
          await rt.startWatchdog()
        },
        async stop() {
          if (runtime === undefined && runtimePromise !== undefined) {
            await runtimePromise.catch(() => undefined)
          }
          await runtime?.stopWatchdog()
        },
      })
    },
  }
}

// ---------------------------------------------------------------------------
// 契约与纯函数重导出（保证所有公开消费方与单元测试 100% 契约保真）
// ---------------------------------------------------------------------------

export {
  SUPERAGENT_PLUGIN_ID,
  SUPERAGENT_PROFILE_ID,
  WATCHDOG_PROFILE_ID,
  WORKER_TAG,
  WORKER_ARCHIVED_TAG,
  RECALL_DOC_NAME,
  WORKER_REPORT_RENDERER,
  INDEX_DOC_NAME,
  SUBSCRIPTIONS_DOC_NAME,
  ROUTING_DOC_NAME,
  SUPERAGENT_PROFILE_IDS,
  REWIND_REPLAY_PAGE_SIZE,
  asConversationEntryEvent,
  isAbsoluteTargetPath,
  parseMutedSources,
  resolveSuperAgentConfig,
  assertIndexDoc,
  assertSubscriptionsDoc,
} from './superagent/contracts.js'

export {
  assertRecallDoc,
  rewindOmittedInputIds,
  removeRecallNodesByInputs,
  recallHasNode,
  updateRecallDoc,
  searchRecallNodes,
  type RecallNodeInput,
} from './superagent/recall.js'

export {
  collectWorkerSettlement,
  recentEntrySummaries,
} from './superagent/settlement.js'
