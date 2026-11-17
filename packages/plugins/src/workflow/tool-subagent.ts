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
import { executionOf } from './tool-result.js'
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
        nodeId: { type: 'string' },
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
    replay: 'safe',
    promptGuidelines: [
      'Provide a short descriptive label (about 4-40 characters) summarizing the task so users can identify the subagent in the task list and child conversation title.',
      'After a background task starts, keep responding to the user or work on other things; the completion report arrives in this conversation automatically — do not sleep or poll for the result.',
      'Only pass background:false for synchronous waiting when the very next step depends on the subagent result and there is no other work in between.',
    ],
    description:
      'Spawn a subagent. Human conversations default to background execution: the call returns a runId as soon as the execution environment is ready, and the completion arrives as a steer follow-up in this conversation; automated conversations (managed subagents/resident workers/trigger sessions, owned by bot/helm) default to waiting synchronously for the final result, and an explicit background=true is rejected — a background report would let the automated caller settle early. An explicit background:false forces synchronous waiting: a synchronous run still has a durable WorkflowRun (it can be moved background by runId via the workflows detach action or the UI "move to background", returning a background handle immediately). agentType is a Profile ID or an external runtime identifier (e.g. herdr:agy); outputs are validated against schema, and gate is accepted in the real node and working directory. Supports label (concise task name), cwd, fork (spawn a native sub-conversation forked from the parent conversation\'s currently completed context; the default agentType inherits the parent conversation\'s role and context/directory/model config; mutually exclusive with resume; unsupported for external runtimes), isolation:worktree, model, effort, maxSubagentDepth (explicitly grants the subtree spawn-depth ceiling, 1..5, default inherits the current ceiling of 2); resume continues the same execution context via execution.conversationId/executionId. External runtime panes carry no parent-conversation secrets by default; grant them individually with secretNames. result and execution metadata are separate; after inspecting or merging, cleanup_worktree can clean up the managed worktree.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Subagent task instructions' },
        label: { type: 'string', description: 'Concise descriptive task name (optional; recommended 4-40 characters, used as the run name and initial child conversation title)' },
        agentType: { type: 'string', description: 'Profile ID or external runtime identifier (defaults to assistant unless fork; fork=true inherits the parent conversation Profile)' },
        cwd: { type: 'string', description: 'Subagent working directory (absolute; defaults to the Profile/conversation default)' },
        fork: {
          type: 'boolean',
          description:
            'Spawn a native sub-conversation forked from the parent conversation\'s currently completed context (optional, default false; mutually exclusive with resume). Only native Profile sub-conversations support it; external runtimes (e.g. herdr:) reject it explicitly. With the default agentType it inherits the parent conversation\'s role and working-directory/model config; do not enable it when an independent blind review or a fresh perspective is needed',
        },
        background: {
          type: 'boolean',
          description: 'Background execution (returns a run handle once the execution environment is ready; reports back to this conversation on completion). Defaults to true in human conversations; false in automated conversations, where an explicit true is rejected',
        },
        isolation: {
          type: 'string',
          enum: ['worktree'],
          description: 'Allocate an isolated Git worktree on the target node; available for native execution and runtime plugins that support it',
        },
        schema: { type: 'object', description: 'Structured-output JSON Schema (optional)' },
        gate: { type: 'string', description: 'Acceptance shell command (optional; exit != 0 fails)' },
        resume: { type: 'string', description: 'Previous execution.conversationId or execution.executionId; continues the same execution context' },
        model: { type: 'string', description: "Model override 'provider/model' (optional)" },
        effort: {
          type: 'string',
          enum: [...SPAWN_EFFORT_LEVELS],
          description: 'Reasoning effort (optional)',
        },
        maxSubagentDepth: {
          type: 'number',
          minimum: 1,
          maximum: HARD_MAX_SUBAGENT_DEPTH,
          description: `Explicitly granted spawn-depth ceiling for this subagent's subtree (1..${HARD_MAX_SUBAGENT_DEPTH}; defaults to inheriting the current ceiling, default ${DEFAULT_MAX_SUBAGENT_DEPTH})`,
        },
        attachments: { type: 'array', items: { type: 'string' }, description: 'Artifact IDs passed to the subagent with the task (optional)' },
        secretNames: {
          type: 'array',
          items: { type: 'string' },
          description: 'Explicitly granted list of parent-conversation secret environment-variable names injected into the external runtime pane (optional; must be legal environment-variable names and still exist in the parent conversation stash). No parent-conversation secrets are carried by default; consumed only by external runtimes (e.g. herdr:) — native Profile sub-conversations do not support them: a non-empty grant reaching native execution fails explicitly with unsupported_secret_grant; an empty array is equivalent to no grant; granted per call, resume does not carry it over',
        },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
    structuredOutputSchema: subagentOutputSchema,
    async execute(args, context) {
      const a = args as Record<string, unknown>
      let label: string | undefined
      if (a['label'] !== undefined) {
        if (typeof a['label'] !== 'string') {
          return envelopeError('subagent_failed: label 必须为 string', 'invalid label: 必须为 string')
        }
        const trimmed = a['label'].trim()
        if (trimmed !== '') label = trimmed
      }
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
      if (a['fork'] !== undefined && typeof a['fork'] !== 'boolean') {
        return envelopeError('subagent_failed: fork 必须为 boolean', 'invalid fork: 必须为 boolean')
      }
      if (a['fork'] === true && a['resume'] !== undefined) {
        return envelopeError(
          'subagent_failed: fork 与 resume 互斥，不能同时从父会话分叉并续接既有子会话',
          'fork 与 resume 互斥',
        )
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

      const formatBackgroundHandle = (runId: string, exec?: AgentExecutionInfo) => {
        const summary = workflows.getRun(runId)
        const effectiveExec = exec ?? workflows.loadRunRecord(runId).subagentMeta?.execution
        const payload = {
          ok: true,
          background: true,
          runId: summary.id,
          status: summary.status,
          ...(effectiveExec !== undefined ? { execution: executionOf(effectiveExec) } : {}),
        }
        return {
          output: [{ type: 'text', text: safeResultText(payload) }],
          structuredOutput: payload,
        }
      }

      const formatTerminalResult = (runId: string, initialExec?: AgentExecutionInfo) => {
        const final = workflows.getRun(runId)
        const resolvedInfo = resolved ?? initialExec ?? workflows.loadRunRecord(runId).subagentMeta?.execution
        if (final.status === 'completed') {
          const payload = {
            ok: true,
            result: final.result,
            ...(resolvedInfo !== undefined ? { execution: executionOf(resolvedInfo) } : {}),
          }
          return {
            output: [{ type: 'text', text: safeResultText(payload) }],
            structuredOutput: payload,
          }
        }
        const message = final.error ?? `子代理运行 ${runId} 终态为 ${final.status}`
        return {
          output: [{ type: 'text', text: `subagent_failed: ${message}` }],
          isError: true,
          structuredOutput: {
            ok: false,
            result: message,
            ...(resolvedInfo !== undefined ? { execution: executionOf(resolvedInfo) } : {}),
          },
        }
      }

      const waitForegroundRunAndFormat = async (runId: string, initialExec?: AgentExecutionInfo, attachAbortOnReplay = false) => {
        const current = workflows.getRun(runId)
        if (current.detachedAt !== undefined) {
          syncRunsDoc()
          return formatBackgroundHandle(runId, initialExec)
        }
        if (current.status !== 'running') {
          syncRunsDoc()
          return formatTerminalResult(runId, initialExec)
        }
        const onAbort = () => {
          if (workflows.isAutoRecoverOnRestart() && workflows.isHostClosing()) return
          void workflows.abort(runId).catch(() => {})
        }
        if (attachAbortOnReplay) {
          context.signal?.addEventListener('abort', onAbort, { once: true })
          if (context.signal?.aborted) onAbort()
        }
        try {
          const outcome = await workflows.waitForeground(runId, {
            ...(attachAbortOnReplay
              ? { onDetached: () => context.signal?.removeEventListener('abort', onAbort) }
              : {}),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          })
          if (outcome === 'detached') {
            syncRunsDoc()
            return formatBackgroundHandle(runId, initialExec)
          }
          return formatTerminalResult(runId, initialExec)
        } finally {
          if (attachAbortOnReplay) context.signal?.removeEventListener('abort', onAbort)
        }
      }

      try {
        // 跨重启/工具重放幂等：以受信 (conversationId, callId) 查既有 Run，绝不重复派生。
        if (typeof context.callId === 'string' && context.callId !== '') {
          const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
          if (existing !== undefined) {
            if (backgroundChoice.background || existing.detachedAt !== undefined) {
              syncRunsDoc()
              return formatBackgroundHandle(existing.id, existing.subagentMeta?.execution)
            }
            return await waitForegroundRunAndFormat(existing.id, existing.subagentMeta?.execution, true)
          }
        }

        // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何后台 run。
        assertCanSpawn(context.conversationId)
        const request: AgentSpawnRequest = {
          parentConversationId: context.conversationId,
          ...(context.callId !== undefined ? { parentToolCallId: context.callId } : {}),
          prompt: String(a['prompt']),
          ...(label !== undefined && a['resume'] === undefined ? { title: label } : {}),
          ...(a['agentType'] !== undefined ? { agentType: String(a['agentType']) } : {}),
          ...(a['cwd'] !== undefined ? { cwd: String(a['cwd']) } : {}),
          ...(a['fork'] === true ? { fork: true } : {}),
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

        if (backgroundChoice.background) {
          const started = await workflows.startBackgroundAgent(request, {
            parentToolCallId: context.callId,
            ...(label !== undefined ? { label } : {}),
            notifyParentOnSettle: true,
          })
          syncRunsDoc()
          return formatBackgroundHandle(started.run.id, started.execution)
        }
        // 同步路径统一走受管后台单子代理启动：从启动起即有 durable WorkflowRun
        //（foreground 模式：record 标记 syncForeground、notifyParentOnSettle
        // 初始 false、父 signal 绑定至 detach 或终态），等待 detach 唤醒或终态；
        // 不再裸调 ctx.host.spawnAgent（生命周期与 SubagentWorkflow 同构，
        // UI/动作可按 runId detach 转后台）。
        const started = await workflows.startBackgroundAgent(request, {
          parentToolCallId: context.callId,
          ...(label !== undefined ? { label } : {}),
          notifyParentOnSettle: false,
          foreground: true,
        })
        syncRunsDoc()
        return await waitForegroundRunAndFormat(started.run.id, started.execution, false)
      } catch (error) {
        // 宿主优雅关停挂起期间父回合 abortSignal 触发：必须原样上抛拒绝，让
        // pi-durable 保持 ToolTask 未结算并在重启后按 replay: 'safe' 幂等重放，
        // 绝不能吞错伪装成已结算的失败 tool_result。
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
        const message = error instanceof Error ? error.message : String(error)
        return {
          output: [{ type: 'text', text: `subagent_failed: ${message}` }],
          isError: true,
          structuredOutput: {
            ok: false,
            result: message,
            ...(resolved !== undefined ? { execution: executionOf(resolved) } : {}),
          },
        }
      } finally {
        syncRunsDoc()
      }
    },
  })
}
