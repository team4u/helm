/**
 * builtin:workflow：subagent / SubagentWorkflow / cleanup_worktree 编排插件。
 *
 * 职责：
 * - 封装编排引擎（engine/：DSL runtime + journal 重放 + WorkflowService），
 *   引擎为插件自有资产（内核不 import 本目录）；跨 spawn 通用边界在
 *   runtime/spawn（内核侧）；
 * - 私有 state 经 ctx.doc 私有文档 `records`（插件 docs 命名空间，state.sqlite
 *   持久），公共 `runs` 文档为 UI 投影（SSE 首帧直投 + tool.view/workbench 消费）；
 *   无进程内 Map fallback、无 kernel.documentStore 注入；
 * - 后台子代理结算（kind=subagent）经 submitInput(requestId) 向父会话投递
 *   汇报（跨重启幂等；父会话已删除时 notification 通知）；
 * - 生命周期：service.prepare 执行 prepareRecovery（只落 abort 标记，不唤醒
 *   调度器，必须在任何服务 start 之前——宿主全局 prepare 屏障保证）；
 *   service.start 执行 init（终止遗留任务、标 failed、补发通知）与 close；
 *   liveTasks/liveWorktrees 声明在途任务与工作树占用；
 * - 3 个模型工具（subagent / SubagentWorkflow / cleanup_worktree）与
 *   6 个动作（list/run/runs/inspect/abort/cleanup_worktree）五端复用。
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HelmError,
  WORKFLOW_PLUGIN_ID,
  WORKFLOW_RUNS_DOC,
  type AgentExecutionInfo,
  type AgentSpawnRequest,
  type PluginDefinition,
  type WorkflowRunSummary,
  type WorkflowRunsDocState,
} from '@helm/protocol'
import { WorkflowService } from './workflow/engine/index.js'
import { normalizeWorkflowArgs } from './workflow/engine/runtime.js'
import { safeResultText } from '../runtime/runtime-helpers.js'
import { executionOf, subagentFooter } from './workflow/tool-result.js'
import { redactJsonValue } from '../redact.js'

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
    version: '0.1.0',
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      // ---- 公共文档：runs（SSE 首帧直投 + tool.view/workbench 订阅） ----
      const runsDoc = ctx.doc<WorkflowRunsDocState>(WORKFLOW_RUNS_DOC, { runs: [], byConversation: {} }, { public: true })

      // ---- 引擎私有 records 文档（键值 store：run 索引 + 每 run 记录） ----
      // 私有 doc：不进公共快照/事件；引擎经此持久化，重启恢复读同一命名空间。
      const records = ctx.doc<Record<string, unknown>>('records', {})

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
        flush: async (): Promise<void> => {
          // ctx.doc 底层即 PluginDocStore（state.sqlite 排队持久化）；引擎各写点
          // 后续业务自然冲刷，无独立 flush 端口——保持无操作即可（写入已同步镜像）。
        },
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
          listActions: () => ctx.host.listActions(),
          getConversation: (id) => ctx.host.getConversation(id),
          abortConversation: (id) => ctx.host.abortConversation(id),
          emitEvent: async (type, payload) => {
            // 每次 workflow.updated（run 新增/节点状态变化）同步公共文档；
            // 事件继续向 SSE 透传（前端时间线与运行卡同帧更新）。
            if (type === 'workflow.updated') syncRunsDoc()
            await ctx.host.emitEvent(type, payload)
          },
          onRunSettled: async (summary) => {
            syncRunsDoc()
            // workflow.settled：herdr 双轨保活清理等插件监听；emitEvent 可等待，
            // 清理监听器的错误经此上抛给引擎结算链（写入 run 诊断，不吞成
            // 后台 notification）。
            await ctx.host.emitEvent('workflow.settled', summary)
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

      /** 同步 runs 公共文档（含按会话聚合的角标统计）。 */
      function syncRunsDoc(): void {
        if (stopping) return
        const runs = workflows.listRuns()
        const byConversation: Record<string, { count: number; tone: 'warn' | 'accent' | 'neutral'; footerText: string }> = {}
        for (const run of runs) {
          const key = String(run.conversationId)
          const entry = byConversation[key] ?? { count: 0, tone: 'neutral' as const, footerText: '' }
          entry.count += 1
          if (run.status === 'running') entry.tone = 'accent'
          else if (run.status === 'failed' && entry.tone !== 'accent') entry.tone = 'warn'
          byConversation[key] = entry
        }
        for (const [key, entry] of Object.entries(byConversation)) {
          const convRuns = runs.filter((r) => r.conversationId === Number(key))
          const running = convRuns.filter((r) => r.status === 'running').length
          const failed = convRuns.filter((r) => r.status === 'failed').length
          entry.footerText = [
            running > 0 ? `${running} 运行中` : '',
            failed > 0 ? `${failed} 失败` : '',
          ].filter((s) => s !== '').join(' · ')
        }
        runsDoc.set({ runs, byConversation })
      }

      /** 后台子代理结算汇报（幂等 requestId；父会话已删时 notification）。 */
      async function deliverBackgroundReport(
        run: WorkflowRunSummary,
        info: { parentConversationId: number; agentType?: string; execution?: AgentExecutionInfo },
      ): Promise<void> {
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
        const requestId = `helm:subagent-report:${run.id}`
        const report = {
          runId: run.id,
          status: run.status,
          ...(run.result !== undefined ? { result: run.result } : {}),
          ...(run.error !== undefined ? { error: run.error } : {}),
          ...(info.execution !== undefined ? { execution: executionOf(info.execution) } : {}),
        }
        await ctx.host.submitInput(
          info.parentConversationId,
          `后台子代理任务已结算。以下为运行 ${run.id} 的结果数据：\n${safeResultText(report)}`,
          {
            origin: 'agent',
            whenBusy: 'followUp',
            requestId,
            meta: { backgroundRunId: run.id, kind: 'subagent_report' },
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
          // 补发输入消费安全）。
          await workflows.init()
          syncRunsDoc()
        },
        async stop() {
          // 受控停止：先置 stopping 拦截新回调，引擎 close 等待在途 run 终态并
          // 落最终记录（写私有 records doc），随后最终同步 runs 投影——投影写入
          // 在 stop 返回前完成，teardown 之后的 deactivating 废黜不影响这些写。
          stopping = true
          try {
            await workflows.close()
          } finally {
            try {
              syncRunsDoc()
            } catch {
              // 投影是观察面：close 后引擎无新状态，失败仅意味着最终帧不同步；
              // 引擎终态已持久在 records，下次启动 init 后同步。不吞 close 错误。
            }
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
        description:
          '派生一个子代理；默认等待最终结果，background:true 在实际环境就绪后返回 runId，后台完成后向父会话汇报。agentType 为 Profile ID 或外部运行时标识（如 herdr:agy）；schema 校验输出，gate 在实际节点和工作目录中验收。支持 cwd、isolation:worktree、model、effort；凭 execution.conversationId/executionId 作为 resume 续接。result 与执行元数据独立；检视或合入后可用 cleanup_worktree 清理受管工作树。',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: '子代理任务指令' },
            agentType: { type: 'string', description: 'Profile ID 或外部运行时标识（缺省 assistant）' },
            cwd: { type: 'string', description: '子代理工作目录（绝对路径；缺省用 Profile/会话缺省）' },
            background: { type: 'boolean', description: '执行环境就绪后返回运行句柄，后台完成后向父会话汇报（默认 false）' },
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
            attachments: { type: 'array', items: { type: 'string' }, description: '随任务传递给子代理的产物 ID 列表（可选）' },
          },
          required: ['prompt'],
          additionalProperties: false,
        },
        structuredOutputSchema: subagentOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
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
            ...(Array.isArray(a['attachments']) ? { attachments: a['attachments'] as string[] } : {}),
            onResolved: (info) => {
              resolved = info
            },
            signal: context.signal,
          }
          try {
            if (a['background'] === true) {
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
        description:
          '执行一个 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本（字符串形 JSON 自动解包）。返回真实执行 summary（runId/status/nodes/result）。',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: '编排脚本源码（内联）' },
            scriptPath: { type: 'string', description: '编排脚本文件路径（与 script、name 择一）' },
            name: { type: 'string', description: '已保存工作流名（与 script、scriptPath 择一）' },
            args: { description: '传给脚本的任意 JSON args（对象/数组/标量均可，字符串形 JSON 自动解包）' },
            resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId（可选）' },
          },
          additionalProperties: false,
        },
        structuredOutputSchema: workflowOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
          const input: Record<string, unknown> = {}
          if (a['script'] !== undefined) input['script'] = String(a['script'])
          if (a['scriptPath'] !== undefined) input['scriptPath'] = String(a['scriptPath'])
          if (a['name'] !== undefined) input['name'] = String(a['name'])
          // 工具 args 归一化（原内核 kernel-tools 行为迁入插件）：模型常把 JSON
          // 对象序列化成字符串传入，这里统一解包（双层/标量原样语义不变）。
          if (a['args'] !== undefined) input['args'] = normalizeWorkflowArgs(a['args'])
          if (a['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(a['resumeFromRunId'])
          try {
            const started = await workflows.run(
              { ...input, conversationId: context.conversationId },
              context.callId !== undefined ? { parentToolCallId: context.callId } : undefined,
            )
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
            const result = await ctx.host.cleanupWorktree(
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
        id: 'run',
        description: '启动工作流运行',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '已保存工作流名（与 script/scriptPath 择一）' },
            script: { type: 'string', description: '编排脚本源码（内联）' },
            scriptPath: { type: 'string', description: '编排脚本文件绝对路径' },
            args: { description: '原样传给脚本的任意 JSON args' },
            resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId' },
            conversationId: { type: 'number', minimum: 1, description: '目标会话（缺省 #1）' },
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
          description: '启动工作流运行',
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
          return ctx.host.cleanupWorktree(
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

      // ---- UI 扩展点（client.tsx 轨道；docs 订阅 runs 公共文档） ----
      ctx.ui.toolView({
        id: 'subagent-card',
        toolNames: ['subagent'],
        replaceRow: true,
        docs: ['runs'],
        client: { module: 'index.tsx', export: 'SubagentToolView' },
      })
      ctx.ui.toolView({
        id: 'workflow-card',
        toolNames: ['SubagentWorkflow'],
        replaceRow: true,
        docs: ['runs'],
        client: { module: 'index.tsx', export: 'WorkflowToolView' },
      })
      ctx.ui.workbenchPanel({
        id: 'tasks',
        label: '工作流与子代理',
        icon: 'git-branch',
        order: 10,
        docs: ['runs'],
        badge: { doc: WORKFLOW_RUNS_DOC, byConversationField: 'byConversation' },
        client: { module: 'index.tsx', export: 'WorkflowWorkbenchPanel' },
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

// 引擎服务与运行时不再需要外部脱敏注入（宿主统一脱敏已覆盖边界）；
// redactJsonValue 保留供未来插件内投影使用（当前 runs 投影为纯 summary）。
void redactJsonValue
