/**
 * 内核工具工厂：subagent / SubagentWorkflow / run_action 元工具。
 *
 * 从 runtime.ts 拆出。工具经宿主能力面（KernelToolHost）闭包到 runtime 的
 * spawnAgent / runWorkflow / pluginHost；execute 层的 handled 接管包装由
 * 宿主统一施加（与插件工具同一 registry 机制）。
 */
import type { JsonValue } from '@earendil-works/chord'
import { defineTool, type ToolRegistration } from '@earendil-works/pi-durable'
import type { AgentExecutionInfo, AgentSpawnRequest, WorkflowRunSummary } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { redactJsonValue } from '../redact.js'
import { executionOf, safeResultText, subagentFooter } from './runtime-helpers.js'

/**
 * subagent 工具 effort 合法枚举（与 spawn.ts 原生执行行 THINKING_LEVELS 同源：
 * pi-ai ModelThinkingLevel）。声明处直接校验，拒绝任意字符串且不静默丢弃。
 */
const SPAWN_EFFORT_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 工具工厂的宿主能力面。 */
export interface KernelToolHost {
  /** agent_spawn 管道入口（hook 链 + 原生默认行）。 */
  spawnAgent(request: AgentSpawnRequest): Promise<unknown>
  /** 后台子代理运行服务（未挂接时 subagent background 显式报错）。 */
  readonly backgroundAgentRunner: ((request: AgentSpawnRequest) => Promise<{ run: WorkflowRunSummary; execution?: AgentExecutionInfo }>) | undefined
  /** Workflow 引擎执行入口（未挂接时显式报错）。 */
  runWorkflow(
    request: Record<string, unknown>,
    conversationId: number,
    signal?: AbortSignal,
    context?: { parentToolCallId?: string },
  ): Promise<unknown>
  /** 插件动作调用（run_action 元工具）。 */
  invokePluginAction(
    pluginId: string,
    actionId: string,
    input: unknown,
    context: { conversationId: number; signal?: AbortSignal },
  ): Promise<unknown>
  /** 出站文本脱敏（受管 token / stash 明文）。 */
  redact(text: string): string
}

export function createSubagentTool(host: KernelToolHost): ToolRegistration {
  return defineTool({
    name: 'subagent',
    description:
      '派生一个子代理；默认等待最终结果，background:true 在实际环境就绪后返回 runId，后台完成后向父会话汇报。agentType 为 Profile ID 或外部运行时标识（如 herdr:agy）；schema 校验输出，gate 在实际节点和工作目录中验收。支持 cwd、isolation:worktree、model、effort；凭 execution.conversationId/executionId 作为 resume 续接。result 与执行元数据独立；检视或合入后可用 cleanup_worktree 清理受管工作树。',
    parameters: {
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
    } as Record<string, unknown>,
    structuredOutputSchema: {
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
    } as Record<string, unknown>,
    async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
      // 防御性二次校验（SDK 已按 parameters 校验；直调路径同样拒绝非法值，
      // 绝不静默丢弃字段后降级执行）。
      if (args['isolation'] !== undefined && args['isolation'] !== 'worktree') {
        return {
          output: [
            {
              type: 'text',
              text: `subagent_failed: isolation 仅允许 'worktree'（收到 ${JSON.stringify(args['isolation'])}），不合法值绝不静默丢弃`,
            },
          ],
          isError: true,
          structuredOutput: { ok: false, result: `invalid isolation: ${JSON.stringify(args['isolation'])}` } as JsonValue,
        }
      }
      // 附件参数防御性校验：非空字符串数组之外一律显式拒绝（不静默丢弃）。
      if (args['attachments'] !== undefined) {
        const list = args['attachments']
        if (
          !Array.isArray(list) ||
          list.some((item) => typeof item !== 'string' || item.length === 0)
        ) {
          return {
            output: [
              {
                type: 'text',
                text: 'subagent_failed: attachments 需为非空字符串数组（产物 ID 列表）',
              },
            ],
            isError: true,
            structuredOutput: { ok: false, result: 'invalid attachments: 需为非空字符串数组' } as JsonValue,
          }
        }
      }
      let resolved: AgentExecutionInfo | undefined
      // 父会话本次工具调用 ID：随派生请求透传，子会话登记时写入镜像，
      // 前端在 subagent 运行期即可实时关联子会话（无需等工具返回）。
      const parentCallId = (api as { conversationId: number; callId?: string }).callId
      try {
        if (args['background'] !== undefined && typeof args['background'] !== 'boolean') {
          throw new HelmError('validation_error', 'background 必须为 boolean', 400)
        }
        const request: AgentSpawnRequest = {
          parentConversationId: api.conversationId,
          ...(typeof parentCallId === 'string' && parentCallId !== ''
            ? { parentToolCallId: parentCallId }
            : {}),
          prompt: String(args['prompt']),
          ...(args['agentType'] !== undefined ? { agentType: String(args['agentType']) } : {}),
          ...(args['cwd'] !== undefined ? { cwd: String(args['cwd']) } : {}),
          ...(args['isolation'] !== undefined ? { isolation: 'worktree' } : {}),
          ...(args['schema'] !== undefined ? { schema: args['schema'] as Record<string, unknown> } : {}),
          ...(args['gate'] !== undefined ? { gate: String(args['gate']) } : {}),
          ...(args['resume'] !== undefined ? { resume: String(args['resume']) } : {}),
          ...(args['model'] !== undefined ? { model: String(args['model']) } : {}),
          ...(args['effort'] !== undefined ? { effort: String(args['effort']) } : {}),
          ...(Array.isArray(args['attachments'])
            ? { attachments: args['attachments'] as string[] }
            : {}),
          onResolved: (info) => {
            resolved = info
          },
          signal: context.abortSignal,
        }
        if (args['background'] === true) {
          const runner = host.backgroundAgentRunner
          if (runner === undefined) {
            throw new HelmError('unsupported_runtime', '后台子代理运行服务尚未挂接', 503)
          }
          const started = await runner(request)
          const payload = {
            ok: true, background: true, runId: started.run.id, status: started.run.status,
            ...(started.execution !== undefined ? { execution: executionOf(started.execution) } : {}),
          }
          const footer = host.redact(subagentFooter(undefined, started.execution))
          return {
            output: [{ type: 'text', text: `${safeResultText(payload, (text) => host.redact(text))}${footer === '' ? '' : `\n${footer}`}` }],
            structuredOutput: redactJsonValue(payload, (text) => host.redact(text)) as JsonValue,
          }
        }
        const result = await host.spawnAgent(request)
        // 元数据独立于业务 result 回报：文本尾行带续接标识（模型可复制为 resume）。
        const payload = {
          ok: true, result,
          ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
        }
        const body = safeResultText(payload, (text) => host.redact(text))
        const footer = host.redact(subagentFooter(args['resume'] !== undefined ? String(args['resume']) : undefined, resolved))
        return {
          output: [{ type: 'text', text: footer === '' ? body : `${body}\n${footer}` }],
          structuredOutput: redactJsonValue(payload, (text) => host.redact(text)) as JsonValue,
        }
      } catch (error) {
        const message = host.redact(error instanceof Error ? error.message : String(error))
        // 失败也可能发生在子会话已创建/已回传元数据之后（resume 已更新
        // parentToolCallId）：附同一 footer + execution，失败卡仍可持续查看
        // 子会话，不与真实关联失联。isError / ok:false 语义不变。
        const footer = host.redact(subagentFooter(args['resume'] !== undefined ? String(args['resume']) : undefined, resolved))
        return {
          output: [{ type: 'text', text: footer === '' ? `subagent_failed: ${message}` : `subagent_failed: ${message}\n${footer}` }],
          isError: true,
          structuredOutput: redactJsonValue({
            ok: false,
            result: message,
            ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
          }, (text) => host.redact(text)) as JsonValue,
        }
      }
    },
  } as never)
}

/**
 * SubagentWorkflow 工具：确定性编排（真实 WorkflowService，不假完成）。
 * 入参完整支持 script / scriptPath / name / args（任意 JSON，原样透传不
 * String 化）/ resumeFromRunId，全部转发 runWorkflow。
 */
export function createWorkflowTool(host: KernelToolHost): ToolRegistration {
  return defineTool({
    name: 'SubagentWorkflow',
    description:
      '执行一个 SubagentWorkflow 确定性编排脚本。script 为内联 DSL 源码，scriptPath 指向脚本文件，name 引用已保存工作流（三者择一）；仅提供 resumeFromRunId 时可复用原脚本。args 为任意 JSON 原样传给脚本。返回真实执行 summary（runId/status/nodes/result）。编排引擎未挂接时显式报错。',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '编排脚本源码（内联）' },
        scriptPath: { type: 'string', description: '编排脚本文件路径（与 script、name 择一）' },
        name: { type: 'string', description: '已保存工作流名（与 script、scriptPath 择一）' },
        args: { description: '传给脚本的任意 JSON args（对象/数组/标量均可，原样透传）' },
        resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId（可选）' },
      },
      additionalProperties: false,
    } as Record<string, unknown>,
    structuredOutputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean' },
        summary: {},
      },
      required: ['ok'],
    } as Record<string, unknown>,
    async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
      const input: Record<string, unknown> = {}
      if (args['script'] !== undefined) input['script'] = String(args['script'])
      if (args['scriptPath'] !== undefined) input['scriptPath'] = String(args['scriptPath'])
      if (args['name'] !== undefined) input['name'] = String(args['name'])
      // args 任意 JSON：原样透传（绝不 String 化——脚本内 args.items.map 等用法依赖真实结构）。
      if (args['args'] !== undefined) input['args'] = args['args']
      if (args['resumeFromRunId'] !== undefined) input['resumeFromRunId'] = String(args['resumeFromRunId'])
      // 父会话本次工具调用 ID：内核受信注入 run 元数据（前端运行期精确关联，
      // 不猜同会话最新 run）；无 callId（异常环境）则无关联，绝不伪造。
      const parentCallId = (api as { conversationId: number; callId?: string }).callId
      try {
        const summary = await host.runWorkflow(
          input,
          api.conversationId,
          context.abortSignal,
          typeof parentCallId === 'string' && parentCallId !== ''
            ? { parentToolCallId: parentCallId }
            : undefined,
        )
        const status =
          typeof summary === 'object' && summary !== null && 'status' in summary
            ? (summary as { status?: unknown }).status
            : undefined
        const failed = status === 'failed' || status === 'aborted'
        return {
          output: [{ type: 'text', text: safeResultText(summary, (text) => host.redact(text)) }],
          ...(failed ? { isError: true } : {}),
          structuredOutput: { ok: !failed, summary: summary as JsonValue } as JsonValue,
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `workflow_failed: ${message}` }],
          isError: true,
          structuredOutput: { ok: false, summary: message } as JsonValue,
        }
      }
    },
  } as never)
}

/** run_action 元工具：按需调用插件动作（qualifiedId，输入输出 schema 边界校验）。 */
export function createRunActionTool(host: KernelToolHost): ToolRegistration {
  return defineTool({
    name: 'run_action',
    description:
      '调用插件声明的动作（pluginId.actionId 全限定 ID）。动作清单由系统提示注入；输入校验失败显式报错。',
    parameters: {
      type: 'object',
      properties: {
        actionId: { type: 'string', description: 'pluginId.actionId 全限定动作 ID' },
        input: { type: 'object', description: '动作输入（按动作 inputSchema）' },
      },
      required: ['actionId'],
      additionalProperties: false,
    } as Record<string, unknown>,
    async execute(args: Record<string, unknown>, api: { conversationId: number }, context: { abortSignal?: AbortSignal }) {
      const qualified = String(args['actionId'])
      const dot = qualified.indexOf('.')
      if (dot <= 0) {
        return {
          output: [{ type: 'text', text: `run_action_failed: 非法动作 ID（期望 pluginId.actionId）：${qualified}` }],
          isError: true,
        }
      }
      try {
        const result = await host.invokePluginAction(qualified.slice(0, dot), qualified.slice(dot + 1), args['input'] ?? {}, {
          conversationId: api.conversationId,
          signal: context.abortSignal,
        })
        return {
          output: [{ type: 'text', text: safeResultText(result, (text) => host.redact(text)) }],
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `run_action_failed: ${message}` }],
          isError: true,
        }
      }
    },
  } as never)
}
