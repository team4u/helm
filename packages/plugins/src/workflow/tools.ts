/**
 * builtin:workflow 模型工具注册（自 workflow.ts 入口拆出）。
 *
 * 3 个模型工具（五端复用的执行面）：
 * - subagent：派生子代理（原生 Profile / 外部运行时；background 缺省按
 *   权威 ownership 判定；isolation:worktree / schema 校验输出 / gate 验收）；
 * - SubagentWorkflow：DSL 确定性编排脚本（内联 / 文件 / 已保存定义）；
 * - cleanup_worktree：清理受管隔离 Git Worktree（错误分支绝不伪造 metadata）。
 */
import { HelmError, safeResultText, type AgentExecutionInfo, type AgentSpawnRequest, type HelmPluginContext } from '@helm/protocol'
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_SUBAGENT_DEPTH,
  withWorkflowSpawnMeta,
  type WorkflowRunSummary,
} from '../contracts.js'
import { normalizeWorkflowArgs } from './engine/runtime.js'
import { executionOf, subagentFooter } from './tool-result.js'
import type { WorktreeIsolation } from './isolation.js'
import type { WorkflowService } from './engine/index.js'
import type { BackgroundPolicy } from './background.js'

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

export function registerWorkflowTools(ctx: HelmPluginContext, deps: WorkflowToolDeps): void {
  const { workflows, isolation, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

  // ---- 模型工具：subagent ----
  ctx.tool({
    name: 'subagent',
    promptGuidelines: [
      '后台任务启动后可继续响应用户或处理其他工作；完成汇报会自动到达本会话，不要使用 sleep 或循环查询等待结果。',
      '只有紧接着的下一步必须依赖子代理结果、期间没有其他工作时，才显式指定 background:false 同步等待。',
    ],
    description:
      '派生一个子代理。人类交互会话缺省后台执行：执行环境就绪后立即返回 runId，后台完成后向本会话 followUp 汇报；自动化会话（受管子代理/驻留 Worker/触发会话，归属 bot/helm）缺省同步等待最终结果，显式 background=true 会被拒绝——后台汇报会驱动自动化调用方早结算。显式 background:false 可强制同步等待。agentType 为 Profile ID 或外部运行时标识（如 herdr:agy）；schema 校验输出，gate 在实际节点和工作目录中验收。支持 cwd、isolation:worktree、model、effort、maxSubagentDepth（显式授予子树派生深度上限，1..5，缺省继承当前上限 2）；凭 execution.conversationId/executionId 作为 resume 续接。外部运行时窗格缺省不携带任何父会话机密，需注入时用 secretNames 逐名授予。result 与执行元数据独立；检视或合入后可用 cleanup_worktree 清理受管工作树。',
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
        secretNames: {
          type: 'array',
          items: { type: 'string' },
          description: '显式授予外部运行时窗格注入的父会话机密环境变量名列表（可选；需为合法环境变量名且在父会话 stash 内现存）。缺省不携带任何父会话机密；仅外部运行时（如 herdr:）消费，原生 Profile 子会话不支持——非空授予到达原生执行行显式报错 unsupported_secret_grant；空数组等同未授予；按次授予，resume 不自动沿用',
        },
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
      if (a['secretNames'] !== undefined) {
        const list = a['secretNames']
        if (!Array.isArray(list) || list.some((item) => typeof item !== 'string' || item.length === 0)) {
          return envelopeError(
            'subagent_failed: secretNames 需为非空字符串数组（机密环境变量名；缺省不携带任何父会话机密）',
            'invalid secretNames: 需为非空字符串数组',
          )
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
        ...(a['maxSubagentDepth'] !== undefined
          ? { meta: withWorkflowSpawnMeta(undefined, { maxSubagentDepth: Number(a['maxSubagentDepth']) }) }
          : {}),
        ...(Array.isArray(a['attachments']) ? { attachments: a['attachments'] as string[] } : {}),
        ...(Array.isArray(a['secretNames']) ? { secretNames: a['secretNames'] as string[] } : {}),
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
