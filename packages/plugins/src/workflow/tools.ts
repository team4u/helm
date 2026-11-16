/**
 * builtin:workflow 模型工具注册（自 workflow.ts 入口拆出；签名不变）。
 *
 * 3 个模型工具（五端复用的执行面）按域分治：
 * - subagent：派生子代理（在 tool-subagent.ts）；
 * - SubagentWorkflow：DSL 确定性编排脚本（内联 / 文件 / 已保存定义）；
 * - cleanup_worktree：清理受管隔离 Git Worktree（错误分支绝不伪造 metadata）。
 */
import { safeResultText, type HelmPluginContext } from '@helm/protocol'
import type { WorkflowRunSummary } from '../contracts.js'
import { normalizeWorkflowArgs } from './engine/runtime.js'
import type { WorktreeIsolation } from './isolation.js'
import type { WorkflowService } from './engine/index.js'
import type { BackgroundPolicy } from './background.js'
import { registerSubagentTool } from './tool-subagent.js'

export interface WorkflowToolDeps {
  workflows: WorkflowService
  isolation: WorktreeIsolation
  /** 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子。 */
  assertCanSpawn(conversationId: number): void
  /** background 缺省与显式拒绝（权威 ownership 判定）。 */
  resolveBackground: BackgroundPolicy['resolveBackground']
  /** run 启停后的 runs 投影刷新。 */
  syncRunsDoc(): void
}

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

export function registerWorkflowTools(ctx: HelmPluginContext, deps: WorkflowToolDeps): void {
  const { workflows, isolation, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

  // ---- 模型工具：subagent（见 tool-subagent.ts） ----
  registerSubagentTool(ctx, { workflows, assertCanSpawn, resolveBackground, syncRunsDoc })

  // ---- 模型工具：SubagentWorkflow ----
  ctx.tool({
    name: 'SubagentWorkflow',
    promptGuidelines: [
      '后台工作流启动后可继续响应用户或处理其他工作；完成汇报会自动到达本会话，不要使用 sleep 或循环查询等待结果。',
      '工作流返回运行句柄时表示已启动；必须等终态汇报后才能交付最终结果。',
    ],
    description:
      '在当前会话执行 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本（字符串形 JSON 自动解包）。人类交互会话缺省后台执行（background 缺省 true）：启动后立即返回运行中 summary，完成后向本会话 steer 插话汇报；自动化会话（归属 bot/helm：受管子代理/驻留 Worker/触发会话）缺省同步等待终态（runId/status/nodes/result），显式 background=true 会被拒绝。同步运行阻塞期间可经 workflows detach 动作或界面「转入后台」按 runId 转后台：调用立即返回后台句柄（ok/background/summary），终态 steer 插话汇报。',
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
          description: '后台执行：启动后立即返回运行句柄，完成后向本会话 steer 插话汇报。人类交互会话缺省 true；自动化会话缺省 false 且显式 true 被拒绝（防早结算）',
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
        // 同步启动：前台同步标记（syncForeground）——同步工具阻塞等待期间可
        // 被 detach 动作按 runId 转后台；通知链在 detach 置位后才接入。
        ...(backgroundChoice.background ? {} : { foreground: true }),
      }
      try {
        const started = await workflows.run({ ...input, conversationId: context.conversationId }, runContext)
        if (backgroundChoice.background) {
          // 后台模式：durable running 快照落盘即返回，不绑定父回合 signal
          //（父回合结束不误杀；中止仅经 abort(runId)/级联取消）；完成后经
          // notifyParentOnSettle outbox 向父会话幂等 steer 汇报。
          syncRunsDoc()
          const payload = { ok: true, background: true, summary: started }
          return {
            output: [{ type: 'text', text: safeResultText(payload) }],
            structuredOutput: payload,
          }
        }
        // 同步模式：父 signal abort 中止本 run（保留同步语义）；等待 detach
        // 唤醒或终态。onDetached 在 detach 临界段同步解绑父 signal（转后台后
        // 父回合 signal 不再杀 run，与 subagent 前台模式的引擎解绑同语义），
        // 工具随即返回后台句柄。
        const onAbort = () => {
          void workflows.abort(started.id).catch(() => {})
        }
        context.signal?.addEventListener('abort', onAbort, { once: true })
        // run 启动本身包含异步准备；父回合可能在 listener 注册前已中止，
        // AbortSignal 不会重放旧事件，故先装 listener 再检查当前状态。
        if (context.signal?.aborted) onAbort()
        try {
          const outcome = await workflows.waitForeground(started.id, {
            onDetached: () => context.signal?.removeEventListener('abort', onAbort),
          })
          if (outcome === 'detached') {
            syncRunsDoc()
            // 与后台返回形状兼容：ok/background/summary（summary.id 即 runId）。
            const payload = { ok: true, background: true, summary: workflows.getRun(started.id) }
            return {
              output: [{ type: 'text', text: safeResultText(payload) }],
              structuredOutput: payload,
            }
          }
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
        mergedInto: { type: 'string', description: '已合入的目标分支或提交；缺省按记录 baseBranch 再回退主工作树 HEAD' },
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
            ...(a['mergedInto'] !== undefined ? { mergedInto: String(a['mergedInto']) } : {}),
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
}
