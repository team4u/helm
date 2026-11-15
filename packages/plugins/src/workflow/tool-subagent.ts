/**
 * builtin:workflow 模型工具 subagent（自 tools.ts 拆出）。
 *
 * 派生子代理（原生 Profile / 外部运行时）：入参逐项强校验（非法值显式
 * 拒绝、绝不静默丢弃）、background 缺省按权威 ownership 判定、执行元数据
 * （conversationId / executionId / worktree）独立于业务 result 回报。
 */
import { safeResultText, type AgentExecutionInfo, type AgentSpawnRequest, type HelmPluginContext } from '@helm/protocol'
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  HARD_MAX_SUBAGENT_DEPTH,
  withWorkflowSpawnMeta,
} from '../contracts.js'
import { executionOf, subagentFooter } from './tool-result.js'
import type { WorkflowService } from './engine/index.js'
import type { BackgroundPolicy } from './background.js'
import type { WorkflowToolDeps } from './tools.js'

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

export function registerSubagentTool(
  ctx: HelmPluginContext,
  deps: Pick<WorkflowToolDeps, 'workflows' | 'assertCanSpawn' | 'resolveBackground' | 'syncRunsDoc'>,
): void {
  const { workflows, assertCanSpawn, resolveBackground, syncRunsDoc } = deps

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
}
