/**
 * builtin:workflow：subagent / SubagentWorkflow / cleanup_worktree 编排插件。
 *
 * 职责：
 * - 封装编排引擎（engine/：DSL runtime + journal 重放 + WorkflowService），
 *   引擎为插件自有资产（内核不 import 本目录）；跨 spawn 通用边界在
 *   runtime/spawn（内核侧）；
 * - 私有 state 经 ctx.doc 私有文档 `records`（插件 docs 命名空间，state.sqlite
 *   持久）；公共 `runs` 投影按会话分片（ctx.sessionDoc，每会话分片含自身及
 *   后代发起的 run——沿真实会话父链防环/缺父，run.conversationId 保持原始
 *   归属；不进全局首帧/全局 SSE，会话新增/删除经宿主事件重投影）；全局仅
 *   保留紧凑 `run-badges` 角标文档（每会话聚合 count/tone/footerText，按
 *   run.id 去重，无完整 run 摘要）；
 *   无进程内 Map fallback、无 kernel.documentStore 注入；
 * - 后台 run 结算（kind=subagent 恒后台；kind=workflow 经工具 background 启动
 *   时同样置 notifyParentOnSettle）经 submitInput(requestId) 向父会话投递
 *   汇报（跨重启幂等；父会话已删除时 notification 通知）；级联取消边界内的
 *   下级父会话不投递（防取消后复活），只向边界外拥有者单次结算汇报；
 *   background 缺省以内核权威归属到 ownership=human 判定（不按 profileId/
 *   runtime 角色硬编码）：人类交互会话缺省后台，自动化会话（bot/helm）缺省
 *   同步且显式 background=true 显式拒绝（防子代理/驻留 Worker 早结算）；
 * - 级联取消：turn_settled（outcome=aborted）时取消该会话子树内属于它的
 *   全部在途 run（completed/failed 不取消合法后台任务）；受管子会话中止一律
 *   经 ctx.host.abortConversationGuarded 内核原子复核（human 红线），绝不
 *   回退普通 abortConversation；
 * - 生命周期：service.prepare 执行 prepareRecovery（只落 abort 标记，不唤醒
 *   调度器，必须在任何服务 start 之前——宿主全局 prepare 屏障保证）；
 *   service.start 执行 init（终止遗留任务、标 failed、补发通知）与 close；
 *   liveTasks/liveWorktrees 声明在途任务与工作树占用；
 * - 3 个模型工具（subagent / SubagentWorkflow / cleanup_worktree）与
 *   12 个动作（list/get/save/delete/run/runs/inspect/abort/steer/
 *   cleanup_worktree/list_worktrees/inspect_worktree）五端复用；
 * - 嵌套深度契约：受管子代理（经本插件派生的原生/外部子会话）默认可嵌套
 *   DEFAULT_MAX_SUBAGENT_DEPTH（2）层——主会话直接派生一层，一层子代理
 *   默认可继续派生二层，达到子树上限的会话即编排叶子。私有登记表持久
 *   depth / parentConversationId / 子树上限等事实，before_turn 剥离派工工具、工具/动作入口
 *   前置拒绝、agent_spawn 最高优先级兜底，三道防线显式报
 *   subagent_depth_exceeded；显式扩展到更深层经插件配置
 *   与 AgentSpawnRequest.maxSubagentDepth 请求字段（均校验在
 *   HARD_MAX_SUBAGENT_DEPTH 内，受管子代理不能提高继承的上限）
 *   （fork / SuperAgent worker 不在表内，不受影响）。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_SUBAGENT_DEPTH,
  HelmError,
  WORKFLOW_PLUGIN_ID,
  WORKFLOW_RUNS_DOC,
  WORKFLOW_RUN_BADGES_DOC,
  safeResultText,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type PluginDefinition,
  type WorkflowRunSummary,
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
} from '@helm/protocol'
import { WorkflowService } from './workflow/engine/index.js'
import { normalizeWorkflowArgs } from './workflow/engine/runtime.js'
import { steerBackgroundSubagent } from './workflow/steer.js'
import { WorktreeIsolation } from './workflow/isolation.js'
import { executionOf, subagentFooter } from './workflow/tool-result.js'

export { WORKFLOW_PLUGIN_ID }

/**
 * clientRoot 兼容 src / dist 运行路径：编译后 dist/builtin-plugins/workflow.js
 * 的同级目录无 client/（tsx 源目录有）；探测失败回退包内 src 源目录。
 */
function resolveClientRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  const local = join(here, 'workflow', 'client')
  if (existsSync(local)) return local
  // dist/builtin-plugins/workflow.js -> src/builtin-plugins/workflow/client
  const pkgRoot = dirname(dirname(here)) // dist -> package root 或 src -> package root
  const srcFallback = join(pkgRoot, 'src', 'builtin-plugins', 'workflow', 'client')
  if (existsSync(srcFallback)) return srcFallback
  throw new HelmError(
    'workflow_plugin_client_missing',
    `内置插件 ${WORKFLOW_PLUGIN_ID} 找不到 client 组件目录（期望 ${local} 或 ${srcFallback}）`,
    500,
  )
}

/** subagent 工具 effort 合法枚举（与内核原生 spawn 执行行同源）。 */
const SPAWN_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 深度超限统一错误（含事实细节，工具/动作入口与 agent_spawn 兜底共用）。 */
function depthExceededError(depth: number, maxSubagentDepth: number, conversationId: number): HelmError {
  return new HelmError(
    'subagent_depth_exceeded',
    `会话 ${conversationId} 是第 ${depth} 层受管子代理（子树派生上限 ${maxSubagentDepth} 层），已达上限，不能再派生子代理或启动嵌套工作流`,
    403,
    { conversationId, depth, maxSubagentDepth, attemptedChildDepth: depth + 1 },
  )
}

/** 受管子代理登记条目（插件私有 doc `subagent-conversations` 持久事实）。 */
interface ManagedSubagentEntry {
  agentType?: string
  runId?: string
  createdAt: number
  /** 自身派生深度：非受管会话直接派生 = 1，受管会话再派生 = 父深度 + 1。 */
  depth: number
  /** 派生时的父会话 ID（树位置事实；resume 续接不改变）。 */
  parentConversationId: number
  /** 该子代理子树的派生深度上限（派生时快照；配置后续变更不追溯）。 */
  maxSubagentDepth: number
}

const subagentOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    runId: { type: 'string' },
    status: { type: 'string' },
    result: {},
    execution: {
      type: 'object',
      properties: {
        conversationId: { type: 'number' },
        executionId: { type: 'string' },
        effectiveCwd: { type: 'string' },
        worktree: {
          type: 'object',
          properties: { path: { type: 'string' }, branch: { type: 'string' } },
          required: ['path', 'branch'],
        },
      },
    },
  },
  required: ['ok'],
} as const

const workflowOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    background: { type: 'boolean' },
    summary: {},
  },
  required: ['ok'],
} as const

/** cleanup 成功分支（removed/worktreeId/path/branch/nodeId/branchDeleted 全为真实值）。 */
const cleanupSuccessOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: true },
    removed: { type: 'boolean' },
    worktreeId: { type: 'string' },
    path: { type: 'string' },
    branch: { type: 'string' },
    nodeId: { type: 'string' },
    branchDeleted: { type: 'boolean' },
  },
  required: ['ok', 'removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
} as const

/** cleanup 失败分支：仅 ok:false + error，绝不伪造空 metadata。 */
const cleanupErrorOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean', const: false },
    error: { type: 'string' },
  },
  required: ['ok', 'error'],
  additionalProperties: false,
} as const

export function createWorkflowPlugin(): PluginDefinition {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: '工作流与子代理编排',
    description: '多智能体确定性编排：subagent / SubagentWorkflow 工具、受管 Git Worktree、运行记录与任务面板。',
    icon: 'workflow',
    version: '0.1.0',
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      // ---- 会话分片公共文档：runs（每父会话只写自己的 run 列表） ----
      // 不进全局首帧/全局 SSE；前端经专用订阅流按会话拉取与增量更新。
      const runsDoc = ctx.sessionDoc<WorkflowRunSessionDocState>(WORKFLOW_RUNS_DOC, { runs: [] }, { public: true })

      // ---- 全局紧凑角标文档：run-badges（仅 count/tone/footerText，有意全局） ----
      // 工作台导航角标需要跨会话可见；完整 run 摘要绝不进入此文档/全局流。
      const badgesDoc = ctx.doc<WorkflowRunBadgesDocState>(
        WORKFLOW_RUN_BADGES_DOC,
        { byConversation: {} },
        { public: true },
      )

      // ---- 引擎私有 records 文档（键值 store：run 索引 + 每 run 记录） ----
      // 私有 doc：不进公共快照/事件；引擎经此持久化，重启恢复读同一命名空间。
      const records = ctx.doc<Record<string, unknown>>('records', {})

      // ---- worktree 隔离资产文档（受管登记 + durable 租约；停用保留可重读） ----
      // 与 records 同层：allocator 登记表 + 租约表 + agentId 绑定表。插件停用
      // 期间不清除，重新启用后 cleanup 可继续定位（不丢 metadata）。
      const worktreeDocs = ctx.doc<Record<string, unknown>>('worktree-state', {})
      const worktreeDocStore = {
        get<T>(key: string, initial: T): T {
          const all = worktreeDocs.get()
          const raw = all[key]
          return raw === undefined ? initial : (structuredClone(raw) as T)
        },
        set<T>(key: string, value: T): void {
          worktreeDocs.update((current) => ({ ...current, [key]: structuredClone(value) }))
        },
        flush: (): Promise<void> => worktreeDocs.flush(),
      }

      // ---- 受管子代理登记表（私有 doc；跨重启持久的事实来源） ----
      // 「workflow 子代理」= 经 agent_spawn 管道成功派生、onResolved 回传
      // conversationId 的子会话（本插件 subagent 工具与编排引擎是当前全部
      // 调用方）。fork 会话与 SuperAgent worker（经 createConversation 创建，
      // 不经 spawn 管道）天然不进表——嵌套限制绝不以 parentConversationId
      // 或 tags 一刀切，也不依赖 ownership 猜测。
      const subagentConvDoc = ctx.doc<Record<string, ManagedSubagentEntry>>('subagent-conversations', {})

      // 复用宿主配置入口：插件中心与 helm plugins config 同权读写。
      ctx.configSchema({
        maxSubagentDepth: {
          type: 'number',
          label: '子代理最大层级',
          minimum: 1,
          maximum: HARD_MAX_SUBAGENT_DEPTH,
          integer: true,
          description: `1..${HARD_MAX_SUBAGENT_DEPTH} 的整数，默认 2。主会话为第 0 层；变更影响新派生的任务树，现有任务沿用其上限。`,
          default: DEFAULT_MAX_SUBAGENT_DEPTH,
        },
      })
      function configuredMaxSubagentDepth(): number {
        const raw = ctx.getConfig().maxSubagentDepth
        if (raw === undefined) return DEFAULT_MAX_SUBAGENT_DEPTH
        if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_SUBAGENT_DEPTH) {
          throw new HelmError(
            'validation_error',
            `builtin:workflow 配置 maxSubagentDepth 非法：${JSON.stringify(raw)}（需 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数）`,
            500,
            { configured: raw },
          )
        }
        return raw
      }

      // 启动即校验配置：非法值在插件定义阶段显式失败，不带病运行。
      configuredMaxSubagentDepth()

      /** 非受管会话从 depth=0 开始；受管会话严格采用派生时的持久事实。 */
      function depthFactsOf(conversationId: number): { managed: boolean; depth: number; maxSubagentDepth: number } {
        const entry = subagentConvDoc.get()[String(conversationId)]
        if (entry === undefined) {
          return { managed: false, depth: 0, maxSubagentDepth: configuredMaxSubagentDepth() }
        }
        if (
          !Number.isInteger(entry.depth) || entry.depth < 1 ||
          !Number.isInteger(entry.maxSubagentDepth) || entry.maxSubagentDepth < entry.depth ||
          entry.maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH ||
          !Number.isSafeInteger(entry.parentConversationId) || entry.parentConversationId < 1 ||
          entry.parentConversationId === conversationId
        ) {
          throw new HelmError('subagent_record_invalid', `受管子代理 ${conversationId} 的深度登记无效`, 500, { conversationId })
        }
        return { managed: true, depth: entry.depth, maxSubagentDepth: entry.maxSubagentDepth }
      }
      for (const id of Object.keys(subagentConvDoc.get())) depthFactsOf(Number(id))

      function registerManagedSubagent(
        conversationId: number,
        meta: {
          agentType?: string
          runId?: string
          depth: number
          parentConversationId: number
          maxSubagentDepth: number
          /** maxSubagentDepth 是否来自本次显式请求（resume 续接时才改写既有上限）。 */
          ceilingExplicit: boolean
        },
      ): void {
        subagentConvDoc.update((current) => {
          const existing = current[String(conversationId)]
          return {
            ...current,
            [String(conversationId)]: {
              ...(existing ?? {}),
              ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
              ...(meta.runId !== undefined ? { runId: meta.runId } : {}),
              // 树位置事实幂等保真：resume 续接重复登记不覆盖既有 depth/父链；
              // 子树上限仅在显式请求时更新，否则保留原快照（配置后续变更不追溯）。
              depth: existing?.depth ?? meta.depth,
              parentConversationId: existing?.parentConversationId ?? meta.parentConversationId,
              maxSubagentDepth: meta.ceilingExplicit
                ? meta.maxSubagentDepth
                : (existing?.maxSubagentDepth ?? meta.maxSubagentDepth),
              createdAt: existing?.createdAt ?? Date.now(),
            },
          }
        })
        // 登记落盘失败显式诊断（不静默）：崩溃窗口内重启可能短暂放行。
        void subagentConvDoc.flush().catch((error: unknown) => {
          process.stderr.write(
            `builtin:workflow: 受管子代理会话 ${conversationId} 登记落盘失败：${
              error instanceof Error ? error.message : String(error)
            }\n`,
          )
        })
      }

      /**
       * 派生前置拒绝（防线二共用入口）：受管会话达到子树上限后不能再派生；
       * 一层子代理（depth=1，上限 2）默认放行——可继续派二层。
       */
      function assertCanSpawn(conversationId: number): void {
        const facts = depthFactsOf(conversationId)
        if (!facts.managed || facts.depth + 1 <= facts.maxSubagentDepth) return
        throw depthExceededError(facts.depth, facts.maxSubagentDepth, conversationId)
      }

      /**
       * 会话是否人类交互会话（subagent / SubagentWorkflow 的 background 缺省
       * 依据）：以内核权威归属 getConversationOwnership 为准——受管子代理/
       * 驻留 Worker 派生登记即标 helm，触发会话标 helm/bot；人类接管（归属翻
       * 转 human）后即按人类交互对待。不叠加 profileId / runtime kind / 受管
       * 登记表条件（登记表只表达派生深度事实，人类接管后强制同步会误伤），
       * 也不按 router/worker 等角色枚举便裁。
       */
      function isHumanInteractionSession(conversationId: number): boolean {
        return ctx.host.getConversationOwnership(conversationId) === 'human'
      }

      /**
       * background 缺省与显式拒绝：人类交互会话缺省后台（父回合不阻塞，完成后
       * followUp 汇报）；自动化会话（bot/helm：受管子代理、驻留 Worker、触发
       * 会话）缺省同步等待——后台完成汇报会驱动自动化会话早结算（把「后台已
       * 启动」当终态消费），显式 background=true 一律显式拒绝，绝不静默改写。
       */
      function resolveBackground(
        conversationId: number,
        explicit: boolean | undefined,
      ): { ok: true; background: boolean } | { ok: false; message: string; reason: string } {
        const human = isHumanInteractionSession(conversationId)
        if (explicit === undefined) return { ok: true, background: human }
        if (explicit && !human) {
          const ownership = ctx.host.getConversationOwnership(conversationId)
          return {
            ok: false,
            reason: 'background_not_allowed',
            message:
              `background=true 仅允许人类交互会话使用；当前会话 ${conversationId} 归属 ${ownership}` +
              '（自动化会话缺省同步等待最终结果，后台完成汇报会驱动早结算）；如需同步等待请省略 background',
          }
        }
        return { ok: true, background: explicit }
      }

      /**
       * worktree 隔离生命周期（本插件自有 Git 能力）：
       * - agent_spawn around（continuation）包襄完整派生：分配/续接/占用/租约；
       * - priority 200（先于外部运行时接管器如 herdr 的 100 执行 = 更外层），
       *   保证外部执行也被租约与登记包襄；
       * - Git 命令经 ctx.host.execEnv（argv 直跑）在真实最终节点执行。
       */
      const isolation = new WorktreeIsolation({
        host: {
          resolveSpawnTarget: (input) => ctx.host.resolveSpawnTarget(input),
          execEnv: (req, opts) => ctx.host.execEnv(req, opts),
          probeNodeFs: (input) => ctx.host.probeNodeFs(input),
          listActiveSpawnExecutions: () => ctx.host.listActiveSpawnExecutions(),
          redactText: (text) => ctx.host.redactText(text),
          getConversation: (id) => {
            const conv = ctx.host.getConversation(id)
            return { cwd: conv.cwd, nodeId: conv.nodeId, status: conv.status }
          },
        },
        docStore: worktreeDocStore,
      })

      // ---- agent_spawn 深度守卫（兜底防线；priority 300 = 最外层） ----
      // 先于 isolation（200）执行：受管子代理的派生请求在 worktree 分配之前
      // 显式拒绝；成功派生（onResolved 回传 conversationId）登记进事实表——
      // 任何入口（同步工具 / 后台 run / 引擎节点 / 未来调用方）派生的子会话
      // 都被记账，重启后依旧生效。
      ctx.hook.onAgentSpawn(async (request, next) => {
        const parentFacts = depthFactsOf(request.parentConversationId)
        const childDepth = parentFacts.depth + 1
        if (parentFacts.managed && childDepth > parentFacts.maxSubagentDepth) {
          throw depthExceededError(parentFacts.depth, parentFacts.maxSubagentDepth, request.parentConversationId)
        }
        // 显式扩展请求字段：无效值显式拒绝（不静默丢弃、不擅自锐化）。
        const explicitCeiling = request.maxSubagentDepth
        if (
          explicitCeiling !== undefined &&
          (!Number.isInteger(explicitCeiling) || explicitCeiling < 1 || explicitCeiling > HARD_MAX_SUBAGENT_DEPTH)
        ) {
          throw new HelmError(
            'validation_error',
            `maxSubagentDepth 必须是 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数（收到 ${JSON.stringify(explicitCeiling)}）`,
            400,
            { maxSubagentDepth: explicitCeiling },
          )
        }
        const childCeiling = explicitCeiling ?? parentFacts.maxSubagentDepth
        if (childCeiling < childDepth || (parentFacts.managed && childCeiling > parentFacts.maxSubagentDepth)) {
          throw new HelmError(
            'validation_error',
            `maxSubagentDepth 必须至少为目标层级 ${childDepth}，受管子代理不能提高继承的上限 ${parentFacts.maxSubagentDepth}`,
            400,
            { depth: parentFacts.depth, maxSubagentDepth: childCeiling, inheritedLimit: parentFacts.maxSubagentDepth },
          )
        }
        const original = request.onResolved
        // continuation 契约：已调 next 的 handler 返回 void（next 的结果即
        // 它的结果）；此处仅包裹 onResolved 记账，不得透传下游产物。
        await next({
          ...request,
          onResolved: (info) => {
            if (info.conversationId !== undefined) {
              registerManagedSubagent(info.conversationId, {
                ...(request.agentType !== undefined ? { agentType: request.agentType } : {}),
                ...(request.workflowRunId !== undefined ? { runId: request.workflowRunId } : {}),
                depth: childDepth,
                parentConversationId: request.parentConversationId,
                maxSubagentDepth: childCeiling,
                ceilingExplicit: explicitCeiling !== undefined,
              })
            }
            original?.(info)
          },
        })
      }, { priority: 300 })

      // ---- agent_spawn around（continuation）：worktree 隔离完整生命周期 ----
      // priority 200：先于外部运行时接管器（如 herdr 的 100）执行 = 更外层，
      // 外部执行同样被租约与登记包襄；不调 next 的接管器（handled）不受影响。
      ctx.hook.onAgentSpawn(async (request, next) => {
        await isolation.aroundSpawn(request, next)
      }, { priority: 200 })

      // ---- before_turn：达到子树上限的受管子代理回合剥离派工工具（防线一） ----
      // 一层子代理默认未达上限（depth=1 < 2），保留 subagent / SubagentWorkflow
      // 可继续派二层；仅叶子（depth ≥ 子树上限）剥离。默认优先级先于 profile
      // 协作目录钩子（-100）：目录钩子看到的是剥离后的工具清单，叶子回合自然
      // 不注入协作目录；fork / SuperAgent worker 不在登记表内，不受影响。
      ctx.hook.onBeforeTurn((turn) => {
        const facts = depthFactsOf(turn.conversation.id)
        if (!facts.managed || facts.depth < facts.maxSubagentDepth) return
        const tools = turn.tools.filter((t) => t.name !== 'subagent' && t.name !== 'SubagentWorkflow')
        if (tools.length === turn.tools.length) return
        return { action: 'transform', value: { ...turn, tools } }
      })

      // ---- turn_settled（outcome=aborted）：级联取消该会话子树内属于它的 run ----
      // 只在 aborted 时级联（completed/failed 不取消合法后台任务）；fire-and-forget：
      // 会话结算链绝不 await 取消完成——run 结算链会经守卫端口中止子会话并等待
      // 其结算，若在此处相互等待会死锁（取消经引擎幂等门与重入共享收敛；子会话
      // 被守卫中止触发的 turn_settled 递归进入时命中同一批 run，不再扩散）。
      ctx.hook.onTurnSettled((payload) => {
        if (payload.outcome !== 'aborted') return
        const conversationId = payload.conversation.id
        void workflows
          .cancelRunsUnderConversation(conversationId)
          .then(
            () => syncRunsDoc(),
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error)
              process.stderr.write(
                `builtin:workflow: 会话 ${conversationId} 中止后的后台运行级联取消失败: ${message}\n`,
              )
              syncRunsDoc()
            },
          )
      })

      // 受控 stop 时序：teardown 先置 deactivating 会废黜 doc 句柄，但 service.stop
      // 属宿主受控调用链——本插件在 stop 内最后再同步 runs 投影。为使 stop 期间的
      // 最终落盘可写，引擎持有本周期 doc 句柄的直接引用（句柄在 stop 返回前仍由
      // 本闭包保证不再被外部触发写）；旧周期（epoch 已递增）句柄被 ctx.doc 边界
      // 拒绝，防停用残留写。
      const stateStore = {
        get<T>(key: string, initial: T): T {
          const all = records.get()
          const raw = all[key]
          return raw === undefined ? initial : (structuredClone(raw) as T)
        },
        set<T>(key: string, value: T): void {
          records.update((current) => ({ ...current, [key]: structuredClone(value) }))
        },
        flush: (): Promise<void> => records.flush(),
      }

      /** 停止中标记：stop 之后的引擎回调不再触碰 runs 投影（doc 句柄已交还）。 */
      let stopping = false

      // ---- WorkflowService 实例（host 能力全部经 ctx.host 受信通道） ----
      const workflows = new WorkflowService({
        dataDir: ctx.dataDir,
        state: stateStore,
        host: {
          spawnAgent: (request) => ctx.host.spawnAgent(request),
          prepareInterruptedConversations: (ids) => ctx.host.prepareInterruptedConversations(ids),
          invokeAction: async (pluginId, actionId, input, invokeContext) => {
            // ctx.host.invokeAction 已是宿主统一脱敏出口（protocol 契约）。
            return ctx.host.invokeAction(pluginId, actionId, input, invokeContext)
          },
          // 真实宿主接完整 prepareAction preflight（插件状态/scope/inputSchema +
          // 定义端 idempotent）；失败显式上抛，绝不退回 listActions 清单冒充。
          prepareAction: (pluginId, actionId, input, prepareContext) =>
            ctx.host.prepareAction(pluginId, actionId, input, prepareContext),
          // 跨节点命令执行：取消信号透传，失败由引擎显式上抛（不吞、不假成功）。
          execEnv: (req, signal) => ctx.host.execEnv(req, { signal }),
          listActions: () => ctx.host.listActions(),
          getConversation: (id) => ctx.host.getConversation(id),
          // 守卫式子会话中止（自动化取消唯一入口）：现读归属与权威水位作守卫
          // 事实，经内核 abortConversationGuarded 原子复核；human 红线由内核在
          // 串行域内兜底拒绝。事实读取不可用（如受控停止窗口）时携空守卫调用
          // ——内核仍拒 human，绝不因此回退普通 abortConversation；守卫拒绝
          // （归属翻转/水位推进/目标删除）确定性放弃并诊断，不重试不掩盖。
          abortConversationGuarded: async (id) => {
            let guard: { expectedOwnership?: 'bot' | 'helm'; expectedStateSeq?: number } = {}
            try {
              const ownership = ctx.host.getConversationOwnership(id)
              guard =
                ownership === 'human'
                  ? {}
                  : {
                      expectedOwnership: ownership,
                      expectedStateSeq: ctx.host.getConversation(id).stateChangeSeq,
                    }
            } catch (error) {
              if (error instanceof HelmError && error.code === 'not_found') return
              // 事实读取不可用：空守卫仍经内核原子复核（human 仍被拒）。
              guard = {}
            }
            try {
              await ctx.host.abortConversationGuarded(id, guard)
            } catch (error) {
              if (error instanceof HelmError && error.code === 'not_found') return
              const message = error instanceof Error ? error.message : String(error)
              process.stderr.write(
                `builtin:workflow: 守卫中止子会话 ${id} 被内核拒绝（human 红线或事实过期；确定性放弃，不回退普通中止）: ${message}\n`,
              )
            }
          },
          // 引擎侧签名是 void（各调用点 fire-and-forget 不 await）：适配器必须
          // 自吞异常——runs 投影（listRuns 可抛 workflow_index_corrupt）与广播
          // 失败只能诊断，逃逸会变成 unhandledRejection 拖垮进程（stop 路径
          // 同款纪律：stderr + 显式 notification，绝不静默）。
          emitEvent: async (type, payload) => {
            try {
              if (type === 'workflow.updated') {
                syncRunsDoc()
                // 全局只发布状态失效提示，详情经会话投影订阅，不旁路广播节点输出。
                const run = (payload as { run: WorkflowRunSummary }).run
                await ctx.host.emitEvent(type, { run: { id: run.id, conversationId: run.conversationId, status: run.status } })
                return
              }
              await ctx.host.emitEvent(type, payload)
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error)
              process.stderr.write(`builtin:workflow: emitEvent ${type} 投影/广播失败（run 状态以 records 持久层为准）: ${message}\n`)
              Promise.resolve(
                ctx.host.emitEvent('notification', {
                  type: 'notification',
                  level: 'warning',
                  title: '工作流事件投影未同步',
                  body: `同步 runs 投影或广播 ${type} 事件失败（运行终态以任务面板重查为准）：${message}`,
                }),
              ).catch(() => {})
            }
          },
          onRunSettled: async (summary) => {
            syncRunsDoc()
            // workflow.settled：herdr 双轨保活清理等插件监听；emitEvent 可等待，
            // 清理监听器的错误经此上抛给引擎结算链（写入 run 诊断，不吞成
            // 后台 notification）。
            await ctx.host.emitEvent('workflow.settled', summary, { broadcast: false })
          },
          onBackgroundAgentSettled: async (summary, info) => {
            syncRunsDoc()
            // stop 期间不投递（notifiedAt 未置位，下次 init 按 outbox 补发）。
            if (!stopping) await deliverBackgroundReport(summary, info)
          },
          runGate: (command, gateOptions) =>
            ctx.host.runGate(command, {
              ...(gateOptions.cwd !== undefined ? { cwd: gateOptions.cwd } : {}),
              ...(gateOptions.conversationId !== undefined ? { conversationId: gateOptions.conversationId } : {}),
              ...(gateOptions.signal !== undefined ? { signal: gateOptions.signal } : {}),
            }),
        },
      })

      /**
       * 同步 runs 会话分片投影与全局紧凑角标（含按会话聚合的角标统计）。
       * stopping 拦截的只有运行期后台回调（引擎事件链里的投影刷新）；受控 stop
       * 链内的最终同步走 syncRunsDocFinal（不受 stopping 拦截，写入经宿主
       * 受控停止 doc 作用域放行，失败如实上抛）。
       */
      function syncRunsDoc(): void {
        if (stopping) return
        writeRunsDoc()
      }

      /** 受控 stop 末尾的最终投影：禁止被 stopping 拦截；写失败上抛（不吞）。 */
      function syncRunsDocFinal(): void {
        writeRunsDoc()
      }

      // ---- 会话事实变化（新增/删除）→ 重投影 runs 分片与角标 ----
      // 分片是会话子树聚合：会话删除会让「后代发起」的 run 失去投影目标，
      // 新会话成为既有 run 的祖先时聚合面改变。conversation.upsert 高频
      //（状态/doing 均广播）：以树形指纹（id + 父链）比对，树未变则跳过
      //（无写放大）；投影本身仍幂等（值比对写入）。父链只在创建时落定
      //（PATCH 不可改），指纹即完整树事实。
      let conversationTreeFingerprint = ''
      function reprojectOnConversationTreeChange(): void {
        if (stopping) return
        try {
          const fingerprint = JSON.stringify(
            ctx.host
              .listConversations()
              .map((c) => [c.id, c.parentConversationId ?? null] as const)
              .sort((a, b) => a[0] - b[0]),
          )
          if (fingerprint === conversationTreeFingerprint) return
          writeRunsDoc()
          conversationTreeFingerprint = fingerprint
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`builtin:workflow: 会话树变化后的 runs 投影失败: ${message}\n`)
        }
      }
      ctx.host.onEvent('conversation.upsert', () => {
        reprojectOnConversationTreeChange()
      })
      ctx.host.onEvent('conversation.deleted', () => {
        if (stopping) return
        try {
          writeRunsDoc()
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          process.stderr.write(`builtin:workflow: 会话删除后的 runs 投影失败: ${message}\n`)
        }
      })

      /** 上一轮已写分片的值缓存（值相等时跳过写入，不发重复事件）。 */
      const writtenRunsByConv = new Map<number, string>()
      /** 上一轮已写角标摘要（值相等时跳过写入）。 */
      let writtenBadgesJson = ''
      /**
       * 已持久化过 runs 分片的会话 ID 集合（start 时从持久层快照一次，此后
       * 增量维护）。不复用句柄 listConversationIds 的原因：受控 stop 窗口内
       * 该只读端口会被 assertNotDisposed 拒绝，而最终投影必须能在 stop 链内
       * 写入；快照语义等价（分片只由本插件写入）。
       */
      const persistedRunsConvs = new Set<number>()

      /** 序列化稳定性键：runs 顺序即引擎返回顺序，JSON 直比（字段由引擎结构化产出）。 */
      function runsProjectionKey(runs: WorkflowRunSummary[]): string {
        return JSON.stringify(runs)
      }

      function writeRunsDoc(): void {
        const runs = workflows.listRuns()
        // 会话存在集合：删除的父会话不重建孤儿 doc（store 已级联清理）。
        const existing = new Map<number, { parentConversationId?: number }>()
        for (const conversation of ctx.host.listConversations()) {
          existing.set(conversation.id, conversation)
        }

        /**
         * 发起会话的祖先链（仅含仍存在的会话）：沿真实会话 parent 链上行，
         * visited 防环（父链环按链断处理，不性深入），缺父即止（不虚构祖先）。
         */
        const ancestorChains = new Map<number, number[]>()
        const ancestorsOf = (id: number): number[] => {
          const cached = ancestorChains.get(id)
          if (cached !== undefined) return cached
          const chain: number[] = []
          const visited = new Set<number>([id])
          let current = existing.get(id)
          while (current !== undefined) {
            const parent = current.parentConversationId
            if (parent === undefined || visited.has(parent)) break
            visited.add(parent)
            if (!existing.has(parent)) break
            chain.push(parent)
            current = existing.get(parent)
          }
          ancestorChains.set(id, chain)
          return chain
        }

        // 1) 会话分片：自身 + 后代发起的 runs（run.conversationId 保持原始
        //    归属，不改写为投影目标）；按 run.id 去重（防御索引异常形状），
        //    顺序保持引擎全局序（createdAt 倒序）。发起会话已删除的 run 父链
        //    事实不可达（父链存在子会话上），不投影到任何分片。
        const runsByConversation = new Map<number, WorkflowRunSummary[]>()
        for (const run of runs) {
          if (!existing.has(run.conversationId)) continue
          const targets = new Set<number>([run.conversationId, ...ancestorsOf(run.conversationId)])
          for (const target of targets) {
            const list = runsByConversation.get(target) ?? []
            if (list.some((r) => r.id === run.id)) continue
            list.push(run)
            runsByConversation.set(target, list)
          }
        }
        for (const convId of persistedRunsConvs) {
          if (!existing.has(convId)) {
            persistedRunsConvs.delete(convId)
            continue
          }
          // 已持久会话：无可见 runs 时清到空（不保留旧投影）；尚未写入的不重建。
          if (!runsByConversation.has(convId)) runsByConversation.set(convId, [])
        }
        for (const [convId, convRuns] of runsByConversation) {
          const key = runsProjectionKey(convRuns)
          if (writtenRunsByConv.get(convId) === key) continue
          runsDoc.set(convId, { runs: convRuns })
          writtenRunsByConv.set(convId, key)
          persistedRunsConvs.add(convId)
        }

        // 2) 全局紧凑角标（有意全局：仅导航元数据，无完整 run 摘要）：与分片
        //    同源的后代聚合（分片本身已按 run.id 去重），幂等值比对写入。
        const byConversation: WorkflowRunBadgesDocState['byConversation'] = {}
        for (const [convId, convRuns] of runsByConversation) {
          if (convRuns.length === 0) continue
          const running = convRuns.filter((r) => r.status === 'running').length
          const failed = convRuns.filter((r) => r.status === 'failed').length
          byConversation[String(convId)] = {
            count: convRuns.length,
            tone: running > 0 ? 'accent' : failed > 0 ? 'warn' : 'neutral',
            footerText: [
              running > 0 ? `${running} 运行中` : '',
              failed > 0 ? `${failed} 失败` : '',
            ].filter((s) => s !== '').join(' · '),
          }
        }
        const badgesJson = JSON.stringify(byConversation)
        if (badgesJson !== writtenBadgesJson) {
          badgesDoc.set({ byConversation })
          writtenBadgesJson = badgesJson
        }
      }

      /** 后台子代理结算汇报（幂等 requestId；父会话已删时 notification）。 */
      async function deliverBackgroundReport(
        run: WorkflowRunSummary,
        info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
      ): Promise<void> {
        // 级联取消边界内不投递：取消结果已落 run 记录（UI/任务面板可查），
        // 向同样被取消的下级父会话 submitInput 会唤醒新回合再派工（复活）；
        // 只向本次取消边界外的拥有者做单次结算汇报（边界判断以引擎取消窗口
        // 为准，投递决策发生在 run done 之前——无标记释放后的窗口）。
        if (workflows.isConversationCancelling(info.parentConversationId)) {
          process.stderr.write(
            `builtin:workflow: 运行 ${run.id} 已${run.status}；父会话 ${info.parentConversationId} 在取消边界内，跳过汇报投递（结果见任务面板）\n`,
          )
          return
        }
        let parentExists = false
        try {
          ctx.host.getConversation(info.parentConversationId)
          parentExists = true
        } catch (error) {
          // 仅「会话不存在」走 notification 降级；其他故障（store/IO/权限）上抛，
          // 由引擎 outbox（notifiedAt 不置位）下次 init 补发，绝不吞错。
          if (error instanceof HelmError && error.code === 'not_found') {
            parentExists = false
          } else {
            throw error
          }
        }
        if (!parentExists) {
          await ctx.host.emitEvent('notification', {
            type: 'notification',
            level: 'warning',
            title: '后台任务已结束',
            body: `运行 ${run.id} 已${run.status}，父会话已删除；可在任务列表检查结果。`,
          })
          return
        }
        const isSubagent = run.kind === 'subagent'
        const requestId = `helm:${isSubagent ? 'subagent' : 'workflow'}-report:${run.id}`
        const otherRunningTasks = workflows.listRuns()
          .filter((candidate) => candidate.id !== run.id && candidate.conversationId === info.parentConversationId && candidate.status === 'running')
          .map((candidate) => ({ runId: candidate.id, name: candidate.name, kind: candidate.kind ?? 'workflow' }))
        const report = {
          runId: run.id,
          status: run.status,
          otherRunningTasks,
          ...(run.result !== undefined ? { result: run.result } : {}),
          ...(run.error !== undefined ? { error: run.error } : {}),
          ...(info.execution !== undefined ? { execution: executionOf(info.execution) } : {}),
        }
        await ctx.host.submitInput(
          info.parentConversationId,
          `${isSubagent ? '后台子代理任务' : '后台工作流任务'}已结算。以下为运行 ${run.id} 的结果数据（仅代表本次任务；otherRunningTasks 是投递时其余在途运行的快照）：\n${safeResultText(report)}`,
          {
            origin: 'agent',
            whenBusy: 'followUp',
            requestId,
            meta: { backgroundRunId: run.id, kind: isSubagent ? 'subagent_report' : 'workflow_report' },
          },
        )
      }

      // ---- service：workflow-engine 生命周期 ----
      ctx.service({
        id: 'workflow-engine',
        async prepare() {
          // 恢复阶段一（全局 prepare 屏障，先于任何服务 start）：只读遗留记录并
          // 经 prepareInterruptedConversations 落持久 abort 标记，不唤醒 SDK
          // 调度器、不提交输入——此时其他插件（assistant/herdr/外部）与工具尚未
          // 注册完成，任何输入提交都会产生 orphan 回合。
          await workflows.prepareRecovery()
        },
        async start() {
          // 恢复阶段二（全部插件 prepare 完成后）：init 终止遗留子任务、把
          // running 显式标 failed(interrupted)、补发父会话通知（此刻工具已注册，
          // 补发输入消费安全）。随后快照已持久分片集合并同步投影。
          await workflows.init()
          for (const convId of runsDoc.listConversationIds()) persistedRunsConvs.add(convId)
          syncRunsDoc()
        },
        async stop() {
          // 受控停止：先置 stopping 拦截运行期后台回调（引擎事件链的投影刷新与
          // 父会话投递），再 await 引擎 close（在途 run 终态写入私有 records doc；
          // 写入经宿主受控停止 doc 写入窗口放行，失败如实上抛）。随后做最终 runs
          // 分片与角标投影（不受 stopping 拦截）并 await records.flush 真实落盘
          // （真实 runtime 中全局 doc 与会话 doc 共享同一事务队列：records.flush
          // 等待 tail 链即含会话分片与角标的排队写；不重复调 runsDoc.flush——
          // dispose 窗口内 sessionDoc 句柄 flush 守卫拒绝已拆除宿主）。
          // close/flush 失败直接上抛（真实持久化故障，不吞）；最终投影是派生观察面：
          // 读取失败（如持久层损坏）发布显式 notification 诊断后不阻断拆毁——
          // 引擎终态已在 records，损坏也会在任何业务读取路径显式报错，不静默。
          stopping = true
          await workflows.close()
          try {
            syncRunsDocFinal()
            await records.flush()
          } catch (error) {
            if (error instanceof HelmError && (error.code === 'workflow_index_corrupt' || error.code === 'workflow_record_corrupt')) {
              const message = error instanceof Error ? error.message : String(error)
              process.stderr.write(`builtin:workflow stop: 最终 runs 投影失败（终态已持久于 records）: ${message}\n`)
              // 显式诊断事件（非静默）：前端与日志可见投影未同步及原因。
              await ctx.host.emitEvent('notification', {
                type: 'notification',
                level: 'warning',
                title: '工作流最终投影未同步',
                body: `关停时读取 runs 快照失败（运行终态已持久化）：${message}`,
              })
              return
            }
            throw error
          }
        },
        liveTasks() {
          return workflows
            .listRuns()
            .filter((r) => r.status === 'running')
            .map((r) => `workflow:${r.id}`)
        },
        liveWorktrees() {
          const out: Array<{ nodeId: string; path: string }> = []
          for (const run of workflows.listRuns()) {
            if (run.status !== 'running') continue
            for (const node of run.nodes ?? []) {
              if (node.status !== 'running') continue
              if (node.worktree?.path !== undefined && node.nodeId !== undefined) {
                out.push({ nodeId: node.nodeId, path: node.worktree.path })
              }
            }
          }
          return out
        },
      })

      // ---- 模型工具：subagent ----
      ctx.tool({
        name: 'subagent',
        promptGuidelines: [
          '后台任务启动后可继续响应用户或处理其他工作；完成汇报会自动到达本会话，不要使用 sleep 或循环查询等待结果。',
          '只有紧接着的下一步必须依赖子代理结果、期间没有其他工作时，才显式指定 background:false 同步等待。',
        ],
        description:
          '派生一个子代理。人类交互会话缺省后台执行：执行环境就绪后立即返回 runId，后台完成后向本会话 followUp 汇报；自动化会话（受管子代理/驻留 Worker/触发会话，归属 bot/helm）缺省同步等待最终结果，显式 background=true 会被拒绝——后台汇报会驱动自动化调用方早结算。显式 background:false 可强制同步等待。agentType 为 Profile ID 或外部运行时标识（如 herdr:agy）；schema 校验输出，gate 在实际节点和工作目录中验收。支持 cwd、isolation:worktree、model、effort、maxSubagentDepth（显式授予子树派生深度上限，1..5，缺省继承当前上限 2）；凭 execution.conversationId/executionId 作为 resume 续接。result 与执行元数据独立；检视或合入后可用 cleanup_worktree 清理受管工作树。',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '子代理任务指令' },
            agentType: { type: 'string', description: 'Profile ID 或外部运行时标识（缺省 assistant）' },
            cwd: { type: 'string', description: '子代理工作目录（绝对路径；缺省用 Profile/会话缺省）' },
            background: {
              type: 'boolean',
              description: '后台执行（执行环境就绪后返回运行句柄，完成后向本会话汇报）。人类交互会话缺省 true；自动化会话缺省 false 且显式 true 被拒绝',
            },
            isolation: {
              type: 'string',
              enum: ['worktree'],
              description: '在目标节点分配独立 Git Worktree；原生执行与支持此能力的运行时插件均可用',
            },
            schema: { type: 'object', description: '结构化输出 JSON Schema（可选）' },
            gate: { type: 'string', description: '验收 shell 命令（可选，exit≠0 失败）' },
            resume: { type: 'string', description: '上次 execution.conversationId 或 execution.executionId，续接同一执行上下文' },
            model: { type: 'string', description: "模型覆盖 'provider/model'（可选）" },
            effort: {
              type: 'string',
              enum: [...SPAWN_EFFORT_LEVELS],
              description: '思考力度（可选）',
            },
            maxSubagentDepth: {
              type: 'number',
              minimum: 1,
              maximum: HARD_MAX_SUBAGENT_DEPTH,
              description: `显式授予该子代理子树的派生深度上限（1..${HARD_MAX_SUBAGENT_DEPTH}；缺省继承当前上限，默认 ${DEFAULT_MAX_SUBAGENT_DEPTH}）`,
            },
            attachments: { type: 'array', items: { type: 'string' }, description: '随任务传递给子代理的产物 ID 列表（可选）' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        structuredOutputSchema: subagentOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
          // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何后台 run。
          assertCanSpawn(context.conversationId)
          if (a['maxSubagentDepth'] !== undefined) {
            const raw = a['maxSubagentDepth']
            if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1 || raw > HARD_MAX_SUBAGENT_DEPTH) {
              return envelopeError(
                `subagent_failed: maxSubagentDepth 必须是 1..${HARD_MAX_SUBAGENT_DEPTH} 的整数（收到 ${JSON.stringify(raw)}）`,
                `invalid maxSubagentDepth: ${JSON.stringify(raw)}`,
              )
            }
          }
          if (a['isolation'] !== undefined && a['isolation'] !== 'worktree') {
            return envelopeError(`subagent_failed: isolation 仅允许 'worktree'（收到 ${JSON.stringify(a['isolation'])}），不合法值绝不静默丢弃`, `invalid isolation: ${JSON.stringify(a['isolation'])}`)
          }
          if (a['attachments'] !== undefined) {
            const list = a['attachments']
            if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.length === 0)) {
              return envelopeError('subagent_failed: attachments 需为非空字符串数组（产物 ID 列表）', 'invalid attachments: 需为非空字符串数组')
            }
          }
          if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
            return envelopeError('subagent_failed: background 必须为 boolean', 'invalid background: 必须为 boolean')
          }
          // background 缺省与显式拒绝（权威 ownership 判定，非角色枚举）。
          const backgroundChoice = resolveBackground(
            context.conversationId,
            a['background'] === undefined ? undefined : a['background'] === true,
          )
          if (!backgroundChoice.ok) {
            return envelopeError(`subagent_failed: ${backgroundChoice.message}`, backgroundChoice.reason)
          }
          let resolved: AgentExecutionInfo | undefined
          const request: AgentSpawnRequest = {
            parentConversationId: context.conversationId,
            ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
            prompt: String(a['prompt']),
            ...(a['agentType'] !== undefined ? { agentType: String(a['agentType']) } : {}),
            ...(a['cwd'] !== undefined ? { cwd: String(a['cwd']) } : {}),
            ...(a['isolation'] !== undefined ? { isolation: 'worktree' } : {}),
            ...(a['schema'] !== undefined ? { schema: a['schema'] as Record<string, unknown> } : {}),
            ...(a['gate'] !== undefined ? { gate: String(a['gate']) } : {}),
            ...(a['resume'] !== undefined ? { resume: String(a['resume']) } : {}),
            ...(a['model'] !== undefined ? { model: String(a['model']) } : {}),
            ...(a['effort'] !== undefined ? { effort: String(a['effort']) } : {}),
            ...(a['maxSubagentDepth'] !== undefined ? { maxSubagentDepth: Number(a['maxSubagentDepth']) } : {}),
            ...(Array.isArray(a['attachments']) ? { attachments: a['attachments'] as string[] } : {}),
            onResolved: (info) => {
              resolved = info
            },
            signal: context.signal,
          }
          try {
            if (backgroundChoice.background) {
              const started = await workflows.startBackgroundAgent(request, {
                parentToolCallId: context.callId,
                notifyParentOnSettle: true,
              })
              syncRunsDoc()
              const payload = {
                ok: true,
                background: true,
                runId: started.run.id,
                status: started.run.status,
                ...(started.execution !== undefined ? { execution: executionOf(started.execution) } : {}),
              }
              const footer = subagentFooter(undefined, started.execution)
              return {
                output: [{ type: 'text', text: `${safeResultText(payload)}${footer === '' ? '' : `\n${footer}`}` }],
                structuredOutput: payload,
              }
            }
            const result = await ctx.host.spawnAgent(request)
            const payload = {
              ok: true,
              result,
              ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
            }
            const body = safeResultText(payload)
            const footer = subagentFooter(a['resume'] !== undefined ? String(a['resume']) : undefined, resolved)
            return {
              output: [{ type: 'text', text: footer === '' ? body : `${body}\n${footer}` }],
              structuredOutput: payload,
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const footer = subagentFooter(a['resume'] !== undefined ? String(a['resume']) : undefined, resolved)
            return {
              output: [{ type: 'text', text: footer === '' ? `subagent_failed: ${message}` : `subagent_failed: ${message}\n${footer}` }],
              isError: true,
              structuredOutput: {
                ok: false,
                result: message,
                ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
              },
            }
          }
        },
      })

      // ---- 模型工具：SubagentWorkflow ----
      ctx.tool({
        name: 'SubagentWorkflow',
        promptGuidelines: [
          '后台工作流启动后可继续响应用户或处理其他工作；完成汇报会自动到达本会话，不要使用 sleep 或循环查询等待结果。',
          '工作流返回运行句柄时表示已启动；必须等终态汇报后才能交付最终结果。',
        ],
        description:
          '在当前会话执行 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本（字符串形 JSON 自动解包）。人类交互会话缺省后台执行（background 缺省 true）：启动后立即返回运行中 summary，完成后向本会话 followUp 汇报；自动化会话（归属 bot/helm：受管子代理/驻留 Worker/触发会话）缺省同步等待终态（runId/status/nodes/result），显式 background=true 会被拒绝。',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: '编排脚本源码（内联）' },
            scriptPath: { type: 'string', description: '编排脚本文件路径（与 script、name 择一）' },
            name: { type: 'string', description: '已保存工作流名（与 script、scriptPath 择一）' },
            args: { description: '传给脚本的任意 JSON args（对象/数组/标量均可，字符串形 JSON 自动解包）' },
            resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId（可选）' },
            background: {
              type: 'boolean',
              description: '后台执行：启动后立即返回运行句柄，完成后向本会话 followUp 汇报。人类交互会话缺省 true；自动化会话缺省 false 且显式 true 被拒绝（防早结算）',
            },
          },
          additionalProperties: false,
        },
        structuredOutputSchema: workflowOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
          // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何 run 记录。
          assertCanSpawn(context.conversationId)
          if (a['background'] !== undefined && typeof a['background'] !== 'boolean') {
            return {
              output: [{ type: 'text', text: 'workflow_failed: background 必须为 boolean' }],
              isError: true,
              structuredOutput: { ok: false, summary: 'invalid background: 必须为 boolean' },
            }
          }
          // background 缺省与显式拒绝（与 subagent 同款权威 ownership 判定）。
          const backgroundChoice = resolveBackground(
            context.conversationId,
            a['background'] === undefined ? undefined : a['background'] === true,
          )
          if (!backgroundChoice.ok) {
            return {
              output: [{ type: 'text', text: `workflow_failed: ${backgroundChoice.message}` }],
              isError: true,
              structuredOutput: { ok: false, summary: backgroundChoice.reason },
            }
          }
          const input: Record<string, unknown> = {}
          if (a['script'] !== undefined) input['script'] = String(a['script'])
          if (a['scriptPath'] !== undefined) input['scriptPath'] = String(a['scriptPath'])
          if (a['name'] !== undefined) input['name'] = String(a['name'])
          // 工具 args 归一化（原内核 kernel-tools 行为迁入插件）：模型常把 JSON
          // 对象序列化成字符串传入，这里统一解包（双层/标量原样语义不变）。
          if (a['args'] !== undefined) input['args'] = normalizeWorkflowArgs(a['args'])
          if (a['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(a['resumeFromRunId'])
          const runContext = {
            ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
            // 仅后台启动的 run 参与父会话通知与重启恢复的守卫中止。
            ...(backgroundChoice.background ? { notifyParentOnSettle: true } : {}),
          }
          try {
            const started = await workflows.run({ ...input, conversationId: context.conversationId }, runContext)
            if (backgroundChoice.background) {
              // 后台模式：durable running 快照落盘即返回，不绑定父回合 signal
              //（父回合结束不误杀；中止仅经 abort(runId)/级联取消）；完成后经
              // notifyParentOnSettle outbox 向父会话幂等 followUp 汇报。
              syncRunsDoc()
              const payload = { ok: true, background: true, summary: started }
              return {
                output: [{ type: 'text', text: safeResultText(payload) }],
                structuredOutput: payload,
              }
            }
            const onAbort = () => {
              void workflows.abort(started.id).catch(() => {})
            }
            context.signal?.addEventListener('abort', onAbort, { once: true })
            try {
              await workflows.wait(started.id).catch(() => {})
              return workflowResultEnvelope(workflows.getRun(started.id))
            } finally {
              context.signal?.removeEventListener('abort', onAbort)
              syncRunsDoc()
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return {
              output: [{ type: 'text', text: `workflow_failed: ${message}` }],
              isError: true,
              structuredOutput: { ok: false, summary: message },
            }
          }
        },
      })

      // ---- 模型工具：cleanup_worktree ----
      ctx.tool({
        name: 'cleanup_worktree',
        description:
          "清理一个受管的隔离 Git Worktree（isolation: 'worktree' 派生的子会话工作区）。按 worktreeId（node:path）、conversationId 或 worktree 路径（可附 nodeId 消歧）定位；工作区含未提交修改或未合入提交时默认拒绝（先检视/合入，或显式 force: true；force 不可越过占用/归属/locked 校验）；可选 deleteBranch: true 一并删除 helm/spawn-* 分支（分支删除失败可重试）。仅清理 helm 登记的受管 worktree，绝不触碰未登记目录。",
        inputSchema: {
          type: 'object',
          properties: {
            worktreeId: { type: 'string', description: '受管 worktree 登记 ID（node:path；精确选择器，与 conversationId/path/nodeId 互斥）' },
            conversationId: { type: 'number', description: '子会话 ID（与 path 择一）' },
            path: { type: 'string', description: 'worktree 绝对路径（与 conversationId 择一；多节点同名路径需另附 nodeId）' },
            nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配，跨节点同名路径消歧）' },
            deleteBranch: { type: 'boolean', description: '同时删除 helm/spawn-* 分支（默认保留）' },
            force: { type: 'boolean', description: '强制清理（仅越过未提交修改/未合入提交保护；不可越过占用/归属/locked 校验）' },
          },
          additionalProperties: false,
        },
        structuredOutputSchema: { anyOf: [cleanupSuccessOutputSchema, cleanupErrorOutputSchema] } as unknown as typeof cleanupSuccessOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
          // --current 语义：无任何显式选择器时以当前会话为选择器（子会话自身
          // 的 worktree）；显式 worktreeId/path/nodeId 永不被上下文覆盖。
          const hasExplicit = a['worktreeId'] !== undefined || a['path'] !== undefined || a['conversationId'] !== undefined
          const selectorConversationId =
            a['conversationId'] !== undefined ? Number(a['conversationId']) : hasExplicit ? undefined : context.conversationId
          try {
            const result = await isolation.cleanup(
              {
                ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
                ...(selectorConversationId !== undefined ? { conversationId: selectorConversationId } : {}),
                ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
                ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
                ...(a['deleteBranch'] !== undefined ? { deleteBranch: a['deleteBranch'] === true } : {}),
                ...(a['force'] !== undefined ? { force: a['force'] === true } : {}),
              },
              context.signal,
            )
            const summary = result.removed
              ? `已移除受管 worktree ${result.path}（branch: ${result.branch}，节点 ${result.nodeId}${result.branchDeleted ? '，分支已删除' : '，分支保留'}）`
              : `受管 worktree ${result.path} 此前已清理（幂等跳过；branch: ${result.branch}${result.branchDeleted ? '，分支已删除' : ''}）`
            return {
              output: [{ type: 'text', text: summary }],
              structuredOutput: { ok: true, ...result },
            }
          } catch (error) {
            // 错误分支仅 ok:false + error：绝不伪造空 worktreeId/path/branch/nodeId。
            const message = error instanceof Error ? error.message : String(error)
            return {
              output: [{ type: 'text', text: `cleanup_worktree 失败：${message}` }],
              isError: true,
              structuredOutput: { ok: false, error: message },
            }
          }
        },
      })

      // ---- 动作（五端复用：HTTP / CLI / run_action / Workflow / Web UI） ----
      ctx.action({
        id: 'list',
        description: '列出已保存的工作流定义',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { workflows: { type: 'array', items: { type: 'object' } } },
          required: ['workflows'],
          additionalProperties: false,
        },
        cli: { command: ['workflows', 'list'], description: '列出已保存的工作流定义' },
        async handler() {
          return { workflows: workflows.list() }
        },
      })

      ctx.action({
        id: 'get',
        description: '读取已保存工作流的完整定义（只读源码与元数据；Web/AI 只读，不提供编辑）',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '已保存工作流名' } },
          required: ['name'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { workflow: { type: 'object' } },
          required: ['workflow'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'get'],
          description: '读取已保存工作流定义（只读源码与元数据）',
          positional: [{ field: 'name', required: true }],
        },
        async handler(input) {
          const { name } = input as { name: string }
          try {
            return { workflow: workflows.get(name) }
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') {
              throw new HelmError('not_found', `工作流 ${name} 不存在`, 404, { name })
            }
            throw error
          }
        },
      })

      ctx.action({
        id: 'save',
        description: '保存工作流定义为跨会话资产（script 或 fromRunId 二选一；缺省名用 meta.name；默认拒绝覆盖，overwrite: true 才覆盖）',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: '完整脚本源码（与 fromRunId 二选一）' },
            fromRunId: { type: 'string', description: '把既有运行持久化的脚本源固化为定义（与 script 二选一；不可用于后台子代理运行）' },
            name: { type: 'string', description: '保存名称（可选；缺省用 meta.name，与 meta.name 不一致时拒绝）' },
            overwrite: { type: 'boolean', description: '覆盖同名定义（默认拒绝）' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            created: { type: 'boolean' },
            workflow: { type: 'object' },
          },
          required: ['created', 'workflow'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'save'],
          description: '保存工作流定义（位置参数为本地脚本文件或目标名称；也可 --from-run-id 固化既有运行）',
          positional: [{ field: 'name', readFileInto: 'script' }],
        },
        async handler(input) {
          const a = input as Record<string, unknown>
          return workflows.save({
            ...(a['script'] !== undefined ? { script: String(a['script']) } : {}),
            ...(a['fromRunId'] !== undefined ? { fromRunId: String(a['fromRunId']) } : {}),
            ...(a['name'] !== undefined ? { name: String(a['name']) } : {}),
            ...(a['overwrite'] !== undefined ? { overwrite: a['overwrite'] === true } : {}),
          })
        },
      })

      ctx.action({
        id: 'delete',
        description: '删除已保存工作流定义文件（历史运行记录不受影响）',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string', description: '已保存工作流名' } },
          required: ['name'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            deleted: { type: 'boolean', const: true },
            name: { type: 'string' },
            path: { type: 'string' },
          },
          required: ['deleted', 'name', 'path'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'delete'],
          description: '删除已保存工作流定义文件（历史运行记录不受影响）',
          positional: [{ field: 'name', required: true }],
        },
        async handler(input) {
          const { name } = input as { name: string }
          return workflows.delete(name)
        },
      })

      ctx.action({
        id: 'run',
        description: '在指定或当前会话启动工作流运行；CLI 使用 --current 传入当前会话',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '已保存工作流名（与 script/scriptPath 择一）' },
            script: { type: 'string', description: '编排脚本源码（内联）' },
            scriptPath: { type: 'string', description: '编排脚本文件绝对路径' },
            args: { description: '原样传给脚本的任意 JSON args' },
            resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId' },
            conversationId: { type: 'number', minimum: 1, description: '目标会话；新 run 必须指定，CLI 可用 --current' },
            wait: { type: 'boolean', description: '等待终态后返回最新 run（failed/aborted 抛错）' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { run: { type: 'object' } },
          required: ['run'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'run'],
          description: '在指定或当前会话启动工作流运行（CLI 使用 --current）',
          positional: [{ field: 'name', readFileInto: 'script' }],
          timeoutMs: 0,
        },
        async handler(input, context) {
          const { wait, ...request } = input as { wait?: boolean } & Record<string, unknown>
          // 显式 input.conversationId 与调用上下文（--current / run_action / workflow）
          // 同时存在且不一致时显式拒绝：静默选边等于在调用方不知情下改投目标。
          if (
            request.conversationId !== undefined &&
            context.conversationId !== undefined &&
            request.conversationId !== context.conversationId
          ) {
            throw new HelmError(
              'validation_error',
              `conversationId 冲突：输入指定 ${String(request.conversationId)} 与调用上下文 ${context.conversationId} 不一致，请显式统一`,
              400,
              { inputConversationId: request.conversationId, contextConversationId: context.conversationId },
            )
          }
          // 会话上下文缺省作为目标会话；显式 input.conversationId 优先。
          if (request.conversationId === undefined && context.conversationId !== undefined) {
            request.conversationId = context.conversationId
          }
          // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，在创建 run 记录前拦截。
          // 显式 conversationId 优先；缺省用调用上下文；两者皆无时 workflows.run
          // 会在落任何记录前报 validation_error，不属深度拦截职责。
          const depthTarget =
            typeof request.conversationId === 'number'
              ? request.conversationId
              : context.conversationId
          if (depthTarget !== undefined) assertCanSpawn(depthTarget)
          const started = await workflows.run(request)
          syncRunsDoc()
          if (wait === true) {
            await workflows.wait(started.id)
            const terminal = workflows.getRun(started.id)
            if (terminal.status === 'failed' || terminal.status === 'aborted') {
              throw new HelmError(
                `workflow_${terminal.status}`,
                terminal.error ?? `工作流运行 ${started.id} 终态为 ${terminal.status}`,
                500,
                { runId: started.id, status: terminal.status },
              )
            }
            return { run: terminal }
          }
          return { run: started }
        },
      })

      ctx.action({
        id: 'runs',
        description: '列出工作流运行记录',
        inputSchema: {
          type: 'object',
          properties: {
            conversationId: { type: 'number', minimum: 1, description: '按会话过滤' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { runs: { type: 'array', items: { type: 'object' } } },
          required: ['runs'],
          additionalProperties: false,
        },
        cli: { command: ['workflows', 'runs'], description: '列出工作流运行记录' },
        async handler(input, context) {
          const { conversationId } = input as { conversationId?: number }
          // 会话上下文（--current / run_action）缺省作为过滤器：与 CLI 历史语义一致。
          const filter = conversationId ?? context.conversationId
          const runs = workflows.listRuns()
          return { runs: filter !== undefined ? runs.filter((r) => r.conversationId === filter) : runs }
        },
      })

      ctx.action({
        id: 'inspect',
        description: '查看单个工作流运行详情',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string', description: '运行 ID' } },
          required: ['runId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { run: { type: 'object' } },
          required: ['run'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'inspect'],
          description: '查看单个工作流运行详情',
          positional: [{ field: 'runId', required: true }],
        },
        async handler(input) {
          const { runId } = input as { runId: string }
          try {
            return { run: workflows.getRun(runId) }
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') {
              throw new HelmError('not_found', `工作流运行不存在: ${runId}`, 404, { runId })
            }
            throw error
          }
        },
      })

      ctx.action({
        id: 'abort',
        description: '中止工作流运行',
        inputSchema: {
          type: 'object',
          properties: { runId: { type: 'string', description: '运行 ID' } },
          required: ['runId'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { run: { type: 'object' } },
          required: ['run'],
          additionalProperties: false,
        },
        cli: {
          command: ['workflows', 'abort'],
          description: '中止工作流运行',
          positional: [{ field: 'runId', required: true }],
        },
        async handler(input) {
          const { runId } = input as { runId: string }
          await workflows.abort(runId)
          syncRunsDoc()
          return { run: workflows.getRun(runId) }
        },
      })

      // ---- 动作 steer：后台子代理安全插话（exposeAsTool 直投 Agent 工具） ----
      // 授权证明与守卫细节见 ./workflow/steer.ts：caller → run → target 全程
      // 沿真实会话父链推导；仅 kind=subagent + running 的运行可插话：原生节点
      // （conversationId）经 ctx.host.submitInputGuarded 内核原子复核归属与
      // CAS 水位（human 红线执行层兜底）；外部节点（controls.steer + executionId
      // + nodeId）动态 invokeAction 委托目标插件动作（零硬编码插件 ID，混合
      // 候选歧义拒绝）；DSL 工作流与未回传控制引用的外部执行显式拒绝。
      // 控制动作非幂等：超时/断线不重试不伪造成功；steered 仅代表投递成功。
      ctx.action({
        id: 'steer',
        description:
          '向运行中的后台子代理插话纠偏（steer）：原生节点经内核 guarded 提交按归属与 CAS 水位原子复核；外部执行（如带原子守卫能力的 Herdr 窗格）按节点 controls.steer 委托对应插件动作，同样要求服务端守卫（guardLevel=cas），未通告守卫能力的目标显式拒绝。仅支持 kind=subagent、status=running 的运行；DSL 编排工作流、未回传控制引用的外部执行、human 归属或模型回合已结束时显式拒绝。会话上下文调用仅允许 run 发起会话自身或其祖先，不可跨树控制；事实过期（如子会话已推进）返回 409 可重读重试。steered=true 仅代表投递成功，不代表指导已执行完成。',
        inputSchema: {
          type: 'object',
          properties: {
            runId: { type: 'string', description: '后台子代理运行 ID（subagent 工具 background:true 返回的 runId）' },
            text: { type: 'string', description: '插话指导内容（非空；原样注入目标执行，附运行来源前缀）' },
          },
          required: ['runId', 'text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          oneOf: [
            {
              properties: {
                steered: { type: 'boolean', const: true },
                runId: { type: 'string' },
                targetKind: { type: 'string', const: 'native' },
                conversationId: { type: 'number', description: '被插话的原生子会话 ID' },
                ownership: { type: 'string', enum: ['bot', 'helm'] },
                stateChangeSeq: { type: 'number', description: '提交时复核通过的权威水位' },
                guardLevel: { type: 'string', const: 'cas', description: '守卫级别（内核 CAS 复核）' },
              },
              required: ['steered', 'runId', 'targetKind', 'conversationId', 'ownership', 'stateChangeSeq', 'guardLevel'],
              additionalProperties: false,
            },
            {
              properties: {
                steered: { type: 'boolean', const: true },
                runId: { type: 'string' },
                targetKind: { type: 'string', const: 'external' },
                executionId: { type: 'string', description: '被插话的外部执行标识' },
                nodeId: { type: 'string', description: '外部执行节点' },
                ownership: { type: 'string', const: 'helm' },
                stateChangeSeq: { type: 'number', minimum: 0, description: '服务端守卫核验通过的权威水位' },
                guardLevel: { type: 'string', const: 'cas', description: '守卫级别（服务端原子守卫）' },
              },
              required: ['steered', 'runId', 'targetKind', 'executionId', 'nodeId', 'ownership', 'stateChangeSeq', 'guardLevel'],
              additionalProperties: false,
            },
          ],
        },
        cli: {
          command: ['workflows', 'steer'],
          description: '向运行中的后台子代理插话纠偏（原生与外部（如 Herdr）执行按节点解析路由；无服务端原子守卫能力的外部目标显式拒绝）',
          positional: [{ field: 'runId', required: true }],
        },
        exposeAsTool: true,
        async handler(input, context) {
          const { runId, text } = input as { runId: string; text: string }
          return steerBackgroundSubagent(
            {
              getRun: (id) => workflows.getRun(id),
              isConversationCancelling: (id) => workflows.isConversationCancelling(id),
              getConversation: (id) => ctx.host.getConversation(id),
              getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
              submitInputGuarded: (id, prompt, opts, guard) =>
                ctx.host.submitInputGuarded(id, prompt, opts, guard),
              invokeAction: (pluginId, actionId, invokeInput, invokeContext) =>
                ctx.host.invokeAction(pluginId, actionId, invokeInput, invokeContext),
            },
            { runId, text },
            {
              ...(context.conversationId !== undefined
                ? { conversationId: context.conversationId }
                : {}),
              ...(context.signal !== undefined ? { signal: context.signal } : {}),
            },
          )
        },
      })

      ctx.action({
        id: 'cleanup_worktree',
        description: '清理受管 Git 工作树',
        inputSchema: {
          type: 'object',
          properties: {
            worktreeId: { type: 'string', description: '受管 worktree 登记 ID（与 conversationId/path 互斥）' },
            conversationId: { type: 'number', minimum: 1, description: '子会话 ID（与 worktreeId/path 互斥）' },
            path: { type: 'string', description: 'worktree 绝对路径（可附 nodeId 消歧）' },
            nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配）' },
            deleteBranch: { type: 'boolean', description: '同时删除 helm/spawn-* 分支（默认保留）' },
            force: { type: 'boolean', description: '强制清理（脏工作区默认拒绝）' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            removed: { type: 'boolean' },
            worktreeId: { type: 'string' },
            path: { type: 'string' },
            branch: { type: 'string' },
            nodeId: { type: 'string' },
            branchDeleted: { type: 'boolean' },
          },
          required: ['removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
          additionalProperties: false,
        },
        cli: { command: ['worktrees', 'cleanup'], description: '清理受管 Git 工作树' },
        async handler(input, context) {
          const a = input as Record<string, unknown>
          // 与工具同款语义：显式 conversationId 与上下文冲突拒绝；无任何显式
          // 选择器时（--current）以调用上下文会话为选择器；显式选择器不覆盖。
          if (
            a['conversationId'] !== undefined &&
            context.conversationId !== undefined &&
            a['conversationId'] !== context.conversationId
          ) {
            throw new HelmError(
              'validation_error',
              `conversationId 冲突：输入指定 ${String(a['conversationId'])} 与调用上下文 ${context.conversationId} 不一致，请显式统一`,
              400,
              { inputConversationId: a['conversationId'], contextConversationId: context.conversationId },
            )
          }
          const hasExplicit = a['worktreeId'] !== undefined || a['path'] !== undefined || a['conversationId'] !== undefined
          const selectorConversationId =
            a['conversationId'] !== undefined ? Number(a['conversationId']) : hasExplicit ? undefined : context.conversationId
          return isolation.cleanup(
            {
              ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
              ...(selectorConversationId !== undefined ? { conversationId: selectorConversationId } : {}),
              ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
              ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
              ...(a['deleteBranch'] !== undefined ? { deleteBranch: a['deleteBranch'] === true } : {}),
              ...(a['force'] !== undefined ? { force: a['force'] === true } : {}),
            } as Record<string, never>,
            context.signal,
          )
        },
      })

      ctx.action({
        id: 'list_worktrees',
        description: '列出受管 Git 工作树登记（含已清理记录的元数据）',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: {
          type: 'object',
          properties: { worktrees: { type: 'array', items: { type: 'object' } } },
          required: ['worktrees'],
          additionalProperties: false,
        },
        cli: { command: ['worktrees', 'list'], description: '列出受管 Git 工作树登记' },
        async handler() {
          return { worktrees: isolation.allocator.list() }
        },
      })

      ctx.action({
        id: 'inspect_worktree',
        description: '只读检视一个受管 Git 工作树：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览）；仅登记记录可检视',
        inputSchema: {
          type: 'object',
          properties: {
            worktreeId: { type: 'string', description: '受管 worktree 登记 ID（node:path；与 conversationId/path 互斥）' },
            conversationId: { type: 'number', minimum: 1, description: '子会话 ID（与 worktreeId/path 互斥）' },
            path: { type: 'string', description: 'worktree 绝对路径（与 conversationId 互斥；多节点同名路径需另附 nodeId）' },
            nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配，跨节点同名路径消歧）' },
            diff: { type: 'boolean', description: '是否包含 diff 预览（默认包含；登记元数据与统计始终返回）' },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            record: { type: 'object' },
            exists: { type: 'boolean' },
            unavailableReason: { type: 'string', enum: ['removed', 'directory_missing'] },
            currentBranch: { type: 'string' },
            currentHead: { type: 'string' },
            branchChanged: { type: 'boolean' },
            dirtyFiles: { type: 'array', items: { type: 'string' } },
            dirtyFileCount: { type: 'number' },
            dirtyFilesTruncated: { type: 'boolean' },
            commitsAhead: { type: 'number' },
            diffStat: { type: 'string' },
            diffPreview: { type: 'string' },
            diffTruncated: { type: 'boolean' },
            diffBase: { type: 'string', enum: ['baseCommit', 'HEAD'] },
          },
          required: ['record', 'exists', 'dirtyFiles', 'dirtyFileCount', 'dirtyFilesTruncated', 'diffTruncated', 'diffBase'],
          additionalProperties: false,
        },
        cli: {
          command: ['worktrees', 'inspect'],
          description: '只读检视受管 Git 工作树（登记元数据 + 状态/统计/diff 预览）',
          positional: [{ field: 'worktreeId', required: true }],
        },
        async handler(input, context) {
          const a = input as Record<string, unknown>
          return isolation.allocator.inspect(
            {
              ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
              ...(a['conversationId'] !== undefined ? { conversationId: Number(a['conversationId']) } : {}),
              ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
              ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
              ...(a['diff'] !== undefined ? { diff: a['diff'] === true } : {}),
            },
            context.signal,
          )
        },
      })

      // ---- UI 扩展点（client.tsx 轨道；组件经 usePluginSessionDoc 自行订阅 runs 分片） ----
      ctx.ui.toolView({
        id: 'subagent-card',
        toolNames: ['subagent'],
        replaceRow: true,
        client: { module: 'index.tsx', export: 'SubagentToolView' },
      })
      ctx.ui.toolView({
        id: 'workflow-card',
        toolNames: ['SubagentWorkflow'],
        replaceRow: true,
        client: { module: 'index.tsx', export: 'WorkflowToolView' },
      })
      ctx.ui.workbenchPanel({
        id: 'tasks',
        label: '工作流与子代理',
        icon: 'git-branch',
        order: 10,
        badge: { doc: WORKFLOW_RUN_BADGES_DOC, byConversationField: 'byConversation' },
        client: { module: 'index.tsx', export: 'WorkflowWorkbenchPanel' },
      })
      // 工作流库：跨会话可复用资产的独立视图空间（定义管理不属会话 workbench）。
      ctx.ui.sidebarItem({
        id: 'workflow-library',
        label: '工作流库',
        icon: 'workflow',
        target: `screen:${WORKFLOW_PLUGIN_ID}/library`,
        order: 16,
      })
      ctx.ui.screen({
        id: 'library',
        label: '工作流库',
        icon: 'workflow',
        client: { module: 'index.tsx', export: 'WorkflowLibraryScreen' },
      })
    },
  }
}

/** 工具错误信封：文本 + structuredOutput.ok=false（isError）。 */
function envelopeError(text: string, result: string): {
  output: Array<{ type: 'text'; text: string }>
  isError: boolean
  structuredOutput: unknown
} {
  return {
    output: [{ type: 'text', text }],
    isError: true,
    structuredOutput: { ok: false, result },
  }
}

/** workflow run -> 工具结果信封（failed/aborted 置 isError）。 */
function workflowResultEnvelope(run: WorkflowRunSummary): {
  output: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredOutput: unknown
} {
  const failed = run.status === 'failed' || run.status === 'aborted'
  return {
    output: [{ type: 'text', text: safeResultText(run) }],
    ...(failed ? { isError: true } : {}),
    structuredOutput: { ok: !failed, summary: run },
  }
}

