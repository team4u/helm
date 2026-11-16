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
 *   liveTasks 声明在途任务（停用硬阻断）；
 * - 3 个模型工具（subagent / SubagentWorkflow / cleanup_worktree）与
 *   13 个动作（list/get/save/delete/run/runs/inspect/abort/steer/detach/
 *   cleanup_worktree/list_worktrees/inspect_worktree）五端复用；
 * - 嵌套深度契约：受管子代理（经本插件派生的原生/外部子会话）默认可嵌套
 *   DEFAULT_MAX_SUBAGENT_DEPTH（2）层——主会话直接派生一层，一层子代理
 *   默认可继续派生二层，达到子树上限的会话即编排叶子。私有登记表持久
 *   depth / parentConversationId / 子树上限等事实，before_turn 剥离派工工具、工具/动作入口
 *   前置拒绝、agent_spawn 最高优先级兜底，三道防线显式报
 *   subagent_depth_exceeded；显式扩展到更深层经插件配置与 spawn meta 的
 *   本插件命名空间 maxSubagentDepth 字段（均校验在
 *   HARD_MAX_SUBAGENT_DEPTH 内，受管子代理不能提高继承的上限）
 *   （fork / SuperAgent worker 不在表内，不受影响）。
 *
 * 模块化拆分架构（入口只做组装，注册顺序与依赖注入见 definePlugin）：
 * - ./workflow/config.ts: 插件配置 Schema 与现读校验（启动即校验，不带病运行）
 * - ./workflow/depth.ts: 受管子代理登记表与嵌套深度守卫（三道防线共用事实）
 * - ./workflow/projection.ts: runs 会话分片投影与全局紧凑角标（幂等写入）
 * - ./workflow/background.ts: background 缺省策略与后台结算汇报投递
 * - ./workflow/engine-host.ts: HelmHostApi 端口 -> WorkflowServiceHost 适配
 *   （守卫式中止 / emitEvent 收口两条安全纪律）
 * - ./workflow/hooks.ts: agent_spawn 双钩（深度守卫 300 / worktree 隔离 200）、
 *   before_turn 工具剥离、turn_settled 级联取消与宿主事件订阅
 * - ./workflow/tools.ts: subagent / SubagentWorkflow / cleanup_worktree 工具
 * - ./workflow/actions.ts: 13 个动作（五端复用）
 * - ./workflow/ui.ts: 前端 UI 扩展点声明
 */
import { HelmError, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'
import {
  WORKFLOW_PLUGIN_ID,
  WORKFLOW_RUNS_DOC,
  WORKFLOW_RUN_BADGES_DOC,
  type WorkflowRunBadgesDocState,
  type WorkflowRunSessionDocState,
} from './contracts.js'
import { WorkflowService } from './workflow/engine/index.js'
import { WorktreeIsolation } from './workflow/isolation.js'
import { registerWorkflowConfigSchema, readMaxConcurrentAgents, readMaxSubagentDepth } from './workflow/config.js'
import { createManagedSubagentRegistry, type ManagedSubagentEntry } from './workflow/depth.js'
import { createRunsProjection } from './workflow/projection.js'
import { createBackgroundPolicy, createBackgroundReporter } from './workflow/background.js'
import { createWorkflowEngineHost } from './workflow/engine-host.js'
import { registerWorkflowHooks } from './workflow/hooks.js'
import { registerWorkflowTools } from './workflow/tools.js'
import { registerWorkflowActions } from './workflow/actions.js'
import { registerWorkflowUi } from './workflow/ui.js'

export { WORKFLOW_PLUGIN_ID }

export function createWorkflowPlugin(): PluginDefinition {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: '工作流与子代理编排',
    description: '多智能体确定性编排：subagent / SubagentWorkflow 工具、受管 Git Worktree、运行记录与任务面板。',
    icon: 'workflow',
    version: '0.1.0',
    clientRoot: resolvePluginClientRoot(WORKFLOW_PLUGIN_ID, 'workflow', 'workflow_plugin_client_missing'),
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
      const subagentConvDoc = ctx.doc<Record<string, ManagedSubagentEntry>>('subagent-conversations', {})

      // ---- 插件配置：Schema 注册 + 启动即校验（非法值在定义阶段显式失败） ----
      registerWorkflowConfigSchema(ctx)
      readMaxConcurrentAgents(ctx)
      readMaxSubagentDepth(ctx)

      // ---- 深度守卫与受管子代理登记（构造即全量校验持久条目） ----
      const registry = createManagedSubagentRegistry({
        doc: subagentConvDoc,
        configuredMaxSubagentDepth: () => readMaxSubagentDepth(ctx),
      })

      // ---- background 缺省策略与后台结算汇报（workflows 延迟注入，无环） ----
      const backgroundPolicy = createBackgroundPolicy({
        getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
      })
      const backgroundReporter = createBackgroundReporter({
        getConversation: (id) => ctx.host.getConversation(id),
        emitEvent: (type, payload) => ctx.host.emitEvent(type, payload),
        submitInput: (conversationId, text, opts) => ctx.host.submitInput(conversationId, text, opts),
        isConversationCancelling: (id) => workflows.isConversationCancelling(id),
        listRuns: () => workflows.listRuns(),
      })

      // ---- runs 会话分片投影与全局角标（stopping 门在投影内部） ----
      const projection = createRunsProjection({
        runsDoc,
        badgesDoc,
        listRuns: () => workflows.listRuns(),
        listConversations: () => ctx.host.listConversations(),
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

      // ---- worktree 隔离生命周期（本插件自有 Git 能力） ----
      // agent_spawn around（continuation）包襄完整派生：分配/续接/占用/租约；
      // priority 200（先于外部运行时接管器如 herdr 的 100 执行 = 更外层），
      // 保证外部执行也被租约与登记包襄；Git 命令经 ctx.host.execEnv
      // （argv 直跑）在真实最终节点执行。
      const isolation = new WorktreeIsolation({
        host: {
          resolveSpawnTarget: (input) => ctx.host.resolveSpawnTarget(input),
          execEnv: (req, opts) => ctx.host.execEnv(req, opts),
          executionEnv: (nodeId, cwd) => ctx.host.executionEnv(nodeId, cwd),
          inspectNodePathUsage: (input) => ctx.host.inspectNodePathUsage(input),
          listActiveSpawnExecutions: () => ctx.host.listActiveSpawnExecutions(),
          redact: (text) => ctx.host.redact(text),
          getConversation: (id) => {
            const conv = ctx.host.getConversation(id)
            return { cwd: conv.cwd, nodeId: conv.nodeId, status: conv.status }
          },
        },
        docStore: worktreeDocStore,
      })

      // ---- WorkflowService 实例（host 能力全部经 ctx.host 受信通道） ----
      const workflows = new WorkflowService({
        dataDir: ctx.dataDir,
        state: stateStore,
        concurrency: readMaxConcurrentAgents(ctx),
        // 持久面值级脱敏钩子（契约声明主 app 注入；实际唯一来源是宿主统一
        // redact 端口）：run 记录/账本写入前过 stash 脱敏，防机密落库。
        redact: (text) => ctx.host.redact(text),
        host: createWorkflowEngineHost({
          host: {
            spawnAgent: (request) => ctx.host.spawnAgent(request),
            invokeAction: (pluginId, actionId, input, invokeContext) =>
              ctx.host.invokeAction(pluginId, actionId, input, invokeContext),
            prepareAction: (pluginId, actionId, input, prepareContext) =>
              ctx.host.prepareAction(pluginId, actionId, input, prepareContext),
            execEnv: (req, opts) => ctx.host.execEnv(req, opts),
            listActions: () => ctx.host.listActions(),
            getConversation: (id) => ctx.host.getConversation(id),
            getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
            abortConversationGuarded: (id, guard) => ctx.host.abortConversationGuarded(id, guard),
            emitEvent: (type, payload, options) => ctx.host.emitEvent(type, payload, options),
            runGate: (command, options) => ctx.host.runGate(command, options),
            get isClosing() {
              return ctx.host.isClosing
            },
          },
          projection,
          deliverBackgroundReport: (run, info) => backgroundReporter.deliver(run, info),
        }),
      })

      // ---- 生命周期 Hook 与宿主事件订阅（agent_spawn 300/200、before_turn、
      //      turn_settled 级联取消、conversation 重投影、diagnostics 探针） ----
      registerWorkflowHooks(ctx, { registry, isolation, workflows, projection })

      // ---- service：workflow-engine 生命周期 ----
      ctx.service({
        id: 'workflow-engine',
        async prepare() {
          // 恢复阶段一（全局 prepare 屏障，先于任何服务 start、先于 SDK 调度器
          // resume）：只读遗留记录并经 abortConversationGuarded（paused 相位）
          // 落持久 abort 标记，不唤醒 SDK 调度器、不提交输入——此时其他插件
          // （assistant/herdr/外部）与工具尚未注册完成，任何输入提交都会产生
          // orphan 回合。
          await workflows.prepareRecovery()
        },
        async start() {
          // 恢复阶段二（全部插件 prepare 完成后）：init 终止遗留子任务、把
          // running 显式标 failed(interrupted)、补发父会话通知（此刻工具已注册，
          // 补发输入消费安全）。随后快照已持久分片集合并同步投影。
          await workflows.init()
          projection.adoptPersistedConversations(runsDoc.listConversationIds())
          projection.sync()
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
          projection.beginStopping()
          await workflows.close()
          try {
            projection.syncFinal()
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
      })

      // ---- 模型工具：subagent / SubagentWorkflow / cleanup_worktree ----
      registerWorkflowTools(ctx, {
        workflows,
        isolation,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
        resolveBackground: (conversationId, explicit) => backgroundPolicy.resolveBackground(conversationId, explicit),
        syncRunsDoc: () => projection.sync(),
      })

      // ---- 动作（五端复用：HTTP / CLI / run_action / Workflow / Web UI） ----
      registerWorkflowActions(ctx, {
        workflows,
        isolation,
        assertCanSpawn: (conversationId) => registry.assertCanSpawn(conversationId),
        syncRunsDoc: () => projection.sync(),
      })

      // ---- UI 扩展点（client.tsx 轨道；组件经 usePluginSessionDoc 自行订阅 runs 分片） ----
      registerWorkflowUi(ctx)
    },
  }
}
