/**
 * builtin:workflow：subagent / SubagentWorkflow / cleanup_worktree 编排插件。
 *
 * 职责：
 * - 封装 WorkflowService（DSL 编排引擎 + 后台单子代理运行记录），
 *   run 生命周期与公共文档 `runs`（WORKFLOW_RUNS_DOC）同步：前端 tool.view
 *   运行卡、workbench.panel 角标与 SSE 首帧 pluginDocs 都消费同一快照；
 * - 后台子代理结算（kind=subagent）经 submitInput(requestId) 向父会话投递
 *   汇报（跨重启幂等；父会话已删除时 notification 通知）；
 * - 服务生命周期：start 执行 prepareRecovery + init（重启恢复遗留 running
 *   显式标 failed），stop 关停引擎；liveTasks/liveWorktrees 声明在途任务与
 *   工作树占用（阻断运行期停用 409 plugin_has_live_tasks 与误清理）；
 * - 3 个模型工具（subagent / SubagentWorkflow / cleanup_worktree）与
 *   6 个动作（list/run/runs/inspect/abort/cleanup_worktree）五端复用。
 *
 * 恢复顺序纪律：prepareRecovery 必须在任何插件服务 start 提交输入唤醒
 * SDK 调度器之前执行——本插件在 createHelm 组合层首个注册（先于会提交
 * 输入的 assistant 等插件启用），service.start 内先 prepareRecovery 再 init。
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
  type WorkflowRunsDocState,
  type WorkflowRunSummary,
} from '@helm/protocol'
import { WorkflowService, type WorkflowStateStore } from '../workflow/index.js'
import { executionOf, safeResultText, subagentFooter } from '../runtime/runtime-helpers.js'
import { redactJsonValue } from '../redact.js'

export { WORKFLOW_PLUGIN_ID }

/** 插件可注入项；state 为 run 索引/summary 持久层（app 注入 kernel.documentStore）。 */
export interface WorkflowPluginOptions {
  redact?: (text: string) => string
  /** run 索引/summary 持久层（app 注入 kernel.documentStore）；缺省为进程内不持久存储，仅供最小测试）。 */
  state?: WorkflowStateStore
}

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

const cleanupOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    removed: { type: 'boolean' },
    worktreeId: { type: 'string' },
    path: { type: 'string' },
    branch: { type: 'string' },
    nodeId: { type: 'string' },
    branchDeleted: { type: 'boolean' },
  },
  required: ['ok', 'removed', 'worktreeId', 'path', 'branch', 'nodeId', 'branchDeleted'],
} as const

export function createWorkflowPlugin(options: WorkflowPluginOptions = {}): PluginDefinition {
  return {
    id: WORKFLOW_PLUGIN_ID,
    name: '工作流与子代理编排',
    version: '0.1.0',
    clientRoot: resolveClientRoot(),
    definePlugin(ctx) {
      const redact = options.redact ?? ((text: string) => text)

      // ---- 公共文档：runs（SSE 首帧直投 + tool.view/workbench 订阅） ----
      const runsDoc = ctx.doc<WorkflowRunsDocState>(WORKFLOW_RUNS_DOC, { runs: [], byConversation: {} }, { public: true })

      // stop 期间 doc 句柄已失效：跳过快照同步（引擎 close 后不再有新状态）。
      let stopping = false

      // ---- WorkflowService 实例（host 能力全部经 ctx.host 受信通道） ----
      // state 缺省为进程内 Map（仅最小测试场景；生产路径 app.ts 注入
      // kernel.documentStore——跨重启恢复依赖持久层，不注入即丢 run 历史）。
      const memoryState = new Map<string, unknown>()
      const workflows = new WorkflowService({
        dataDir: ctx.dataDir,
        state: options.state ?? {
          get: <T>(key: string, initial: T): T => (memoryState.has(key) ? (memoryState.get(key) as T) : initial),
          set: <T>(key: string, value: T): void => {
            memoryState.set(key, value)
          },
        },
        redact,
        host: {
          spawnAgent: (request) => ctx.host.spawnAgent(request),
          prepareInterruptedConversations: (ids) => ctx.host.prepareInterruptedConversations(ids),
          invokeAction: async (pluginId, actionId, input, invokeContext) => {
            const result = await ctx.host.invokeAction(pluginId, actionId, input, invokeContext)
            return redactJsonValue(result, redact)
          },
          listActions: () => ctx.host.listActions(),
          getConversation: (id) => ctx.host.getConversation(id),
          abortConversation: (id) => ctx.host.abortConversation(id),
          emitEvent: (type, payload) => {
            // 每次 workflow.updated（run 新增/节点状态变化）同步公共文档；
            // 事件继续向 SSE 透传（前端时间线与运行卡同帧更新）。
            if (type === 'workflow.updated') syncRunsDoc()
            ctx.host.emitEvent(type, payload)
          },
          onRunSettled: async (summary) => {
            syncRunsDoc()
            // workflow.settled：herdr 双轨保活清理等插件监听（错误在宿主事件
            // 派发层显式上报，绝不静默吞）。
            ctx.host.emitEvent('workflow.settled', summary)
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
        } catch {
          parentExists = false
        }
        if (!parentExists) {
          ctx.host.emitEvent('notification', {
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
          `后台子代理任务已结算。以下为运行 ${run.id} 的结果数据：\n${safeResultText(report, redact)}`,
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
        async start() {
          // prepareRecovery 先于 init（也先于任何会提交输入的插件服务 start——
          // 本插件在组合层首个注册启用，顺序由 createHelm 保证）。
          await workflows.prepareRecovery()
          await workflows.init()
          syncRunsDoc()
        },
        async stop() {
          stopping = true
          await workflows.close()
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
              const footer = redact(subagentFooter(undefined, started.execution))
              return {
                output: [{ type: 'text', text: `${safeResultText(payload, redact)}${footer === '' ? '' : `\n${footer}`}` }],
                structuredOutput: redactJsonValue(payload, redact),
              }
            }
            const result = await ctx.host.spawnAgent(request)
            const payload = {
              ok: true,
              result,
              ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
            }
            const body = safeResultText(payload, redact)
            const footer = redact(subagentFooter(a['resume'] !== undefined ? String(a['resume']) : undefined, resolved))
            return {
              output: [{ type: 'text', text: footer === '' ? body : `${body}\n${footer}` }],
              structuredOutput: redactJsonValue(payload, redact),
            }
          } catch (error) {
            const message = redact(error instanceof Error ? error.message : String(error))
            const footer = redact(subagentFooter(a['resume'] !== undefined ? String(a['resume']) : undefined, resolved))
            return {
              output: [{ type: 'text', text: footer === '' ? `subagent_failed: ${message}` : `subagent_failed: ${message}\n${footer}` }],
              isError: true,
              structuredOutput: redactJsonValue({
                ok: false,
                result: message,
                ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
              }, redact),
            }
          }
        },
      })

      // ---- 模型工具：SubagentWorkflow ----
      ctx.tool({
        name: 'SubagentWorkflow',
        description:
          '执行一个 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本。返回真实执行 summary（runId/status/nodes/result）。',
        inputSchema: {
          type: 'object',
          properties: {
            script: { type: 'string', description: '编排脚本源码（内联）' },
            scriptPath: { type: 'string', description: '编排脚本文件路径（与 script、name 择一）' },
            name: { type: 'string', description: '已保存工作流名（与 script、scriptPath 择一）' },
            args: { description: '传给脚本的任意 JSON args（对象/数组/标量均可，原样透传）' },
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
          if (a['args'] !== undefined) input['args'] = a['args']
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
              return workflowResultEnvelope(workflows.getRun(started.id), redact)
            } finally {
              context.signal?.removeEventListener('abort', onAbort)
              syncRunsDoc()
            }
          } catch (error) {
            const message = redact(error instanceof Error ? error.message : String(error))
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
        structuredOutputSchema: cleanupOutputSchema,
        async execute(args, context) {
          const a = args as Record<string, unknown>
          try {
            const result = await ctx.host.cleanupWorktree(
              {
                ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
                ...(a['conversationId'] !== undefined ? { conversationId: Number(a['conversationId']) } : {}),
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
            const message = redact(error instanceof Error ? error.message : String(error))
            return {
              output: [{ type: 'text', text: `cleanup_worktree 失败：${message}` }],
              isError: true,
              structuredOutput: { ok: false, removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false, error: message },
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
          // 会话上下文（--current / run_action / workflow）缺省作为目标会话；
          // 显式 input.conversationId 优先。
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
          return ctx.host.cleanupWorktree(input as Record<string, never>, context.signal)
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
        badge: { doc: 'runs', byConversationField: 'byConversation' },
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
function workflowResultEnvelope(run: WorkflowRunSummary, redact: (text: string) => string): {
  output: Array<{ type: 'text'; text: string }>
  isError?: boolean
  structuredOutput: unknown
} {
  const failed = run.status === 'failed' || run.status === 'aborted'
  return {
    output: [{ type: 'text', text: safeResultText(run, redact) }],
    ...(failed ? { isError: true } : {}),
    structuredOutput: { ok: !failed, summary: run },
  }
}
