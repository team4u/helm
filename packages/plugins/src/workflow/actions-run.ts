/**
 * builtin:workflow 运行族动作（自 actions.ts 按域拆出）。
 *
 * 3 个动作：
 * - run：启动工作流运行（会话目标显式优先、上下文冲突拒绝、深度前置拦截、
 *   wait 终态等待）；
 * - steer：后台子代理安全插话（授权证明与守卫细节见 ./steer.ts）；
 * - detach：前台同步 run 转后台（授权与状态纪律见 ./detach.ts）。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import { steerBackgroundSubagent } from './steer.js'
import { detachForegroundSyncRun } from './detach.js'
import type { WorkflowActionDeps } from './actions.js'

export function registerWorkflowRunActions(
  ctx: HelmPluginContext,
  deps: Pick<WorkflowActionDeps, 'workflows' | 'assertCanSpawn' | 'syncRunsDoc'>,
): void {
  const { workflows, assertCanSpawn, syncRunsDoc } = deps

  ctx.action({
    id: 'run',
    description: 'Start a workflow run in the specified or current conversation; the CLI passes the current conversation via --current',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Saved workflow name (exactly one of name / script / scriptPath)' },
        script: { type: 'string', description: 'Orchestration script source (inline)' },
        scriptPath: { type: 'string', description: 'Absolute path of the orchestration script file' },
        label: { type: 'string', minLength: 1, description: 'Optional display label for this run (overrides meta.name / scriptPath basename)' },
        args: { description: 'Arbitrary JSON args passed to the script as-is' },
        resumeFromRunId: { type: 'string', description: 'Existing runId to resume from the last checkpoint' },
        conversationId: { type: 'number', minimum: 1, description: 'Target conversation; a new run must specify one, the CLI can use --current' },
        wait: { type: 'boolean', description: 'Wait for the terminal state and return the latest run (failed/aborted throw)' },
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
      description: 'Start a workflow run in the specified or current conversation (CLI uses --current)',
      positional: [{ field: 'name', readFileInto: 'script' }],
      timeoutMs: 0,
    },
    async handler(input, context) {
      const { wait, ...request } = input as { wait?: boolean } & Record<string, unknown>
      if (request.label !== undefined && (typeof request.label !== 'string' || request.label.trim() === '')) {
        throw new HelmError('validation_error', 'label 必须为非空字符串', 400, { label: request.label })
      }
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

  // ---- 动作 steer：后台子代理安全插话（exposeAsTool 直投 Agent 工具） ----
  // 授权证明与守卫细节见 ./steer.ts：caller → run → target 全程
  // 沿真实会话父链推导；仅 kind=subagent + running 的运行可插话：原生节点
  // （conversationId）经 ctx.host.submitInputGuarded 内核原子复核归属与
  // CAS 水位（human 红线执行层兜底）；外部节点（controls.steer + executionId
  // + nodeId）动态 invokeAction 委托目标插件动作（零硬编码插件 ID，混合
  // 候选歧义拒绝）；DSL 工作流与未回传控制引用的外部执行显式拒绝。
  // 控制动作非幂等：超时/断线不重试不伪造成功；steered 仅代表投递成功。
  ctx.action({
    id: 'steer',
    description:
      'Add mid-run guidance to a running background subagent: native sub-conversations go through the kernel guarded port with atomic ownership and CAS watermark rechecks; external executions are delegated to the node controls.steer plugin action, honestly reporting guardLevel (preflight is a pre-send check, cas is an atomic recheck at the commit point). Only runs with kind=subagent and status=running are supported; DSL workflows, external executions without control references, and human ownership are rejected. Within a conversation only the initiating conversation itself or its ancestors may steer. steered=true only means delivery succeeded, not that the guidance was executed; timeouts and disconnects are not retried automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Background subagent run ID (the runId returned by the subagent tool with background:true)' },
        text: { type: 'string', description: 'Guidance text to inject (non-empty; delivered verbatim into the target execution with a run-source prefix)' },
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
            conversationId: { type: 'number', description: 'Steered native sub-conversation ID' },
            ownership: { type: 'string', enum: ['bot', 'helm'] },
            stateChangeSeq: { type: 'number', description: 'Authoritative watermark that passed the recheck at commit' },
            guardLevel: { type: 'string', const: 'cas', description: 'Guard level (kernel CAS recheck)' },
          },
          required: ['steered', 'runId', 'targetKind', 'conversationId', 'ownership', 'stateChangeSeq', 'guardLevel'],
          additionalProperties: false,
        },
        {
          properties: {
            steered: { type: 'boolean', const: true },
            runId: { type: 'string' },
            targetKind: { type: 'string', const: 'external' },
            executionId: { type: 'string', description: 'Steered external execution identifier' },
            nodeId: { type: 'string', description: 'External execution node' },
            ownership: { type: 'string', const: 'helm' },
            stateChangeSeq: { type: 'number', minimum: 0, description: 'Authoritative watermark observed at the preflight or commit-point recheck' },
            guardLevel: { type: 'string', enum: ['preflight', 'cas'], description: 'Guard level actually applied by the execution plugin' },
          },
          required: ['steered', 'runId', 'targetKind', 'executionId', 'nodeId', 'ownership', 'stateChangeSeq', 'guardLevel'],
          additionalProperties: false,
        },
      ],
    },
    cli: {
      command: ['workflows', 'steer'],
      description: 'Steer a running background subagent back on course (native and external (e.g. Herdr) executions route by node; external targets without server-side atomic guard support are explicitly rejected)',
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

  // ---- 动作 detach：前台同步 run 转后台（同步工具阻塞等待的唯一放行口） ----
  // 授权与状态纪律见 ./detach.ts：仅前台同步标记（record.syncForeground）且
  // running 的 run；run 发起会话必须 human-owned（自动化同步等待是防早结算
  // 策略，一律拒绝）；会话上下文调用须为发起会话自身或祖先。引擎在同步
  // 临界段原子置位 detachedAt/notifyParentOnSettle 并唤醒阻塞中的工具调用
  // （立即返回后台句柄），自然完成与 detach 竞态只能有一个终态/通知路径。
  ctx.action({
    id: 'detach',
    description:
      'Move a running foreground-sync run (the subagent / SubagentWorkflow synchronous-wait path) into the background: the blocked tool call immediately returns a background handle, the run keeps executing and reports via a steer follow-up on settle. Only runs marked foreground-sync and running can be moved (background-started and already-detached runs are rejected); the initiating conversation must be human-owned — synchronous waiting is the fixed policy for automated (bot/helm) conversations, which are refused; within a conversation only the initiating conversation itself or its ancestors may call.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Foreground-sync run ID (a run started by a synchronous tool call)' },
      },
      required: ['runId'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        detached: { type: 'boolean', const: true },
        runId: { type: 'string' },
        run: { type: 'object' },
      },
      required: ['detached', 'runId', 'run'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'detach'],
      description: 'Move a running foreground-sync run into the background (the blocked tool call immediately returns a background handle)',
      positional: [{ field: 'runId', required: true }],
    },
    async handler(input, context) {
      const { runId } = input as { runId: string }
      const output = await detachForegroundSyncRun(
        {
          getRun: (id) => workflows.getRun(id),
          detach: (id) => workflows.detachForegroundRun(id),
          getConversation: (id) => ctx.host.getConversation(id),
          getConversationOwnership: (id) => ctx.host.getConversationOwnership(id),
        },
        { runId },
        {
          ...(context.conversationId !== undefined
            ? { conversationId: context.conversationId }
            : {}),
        },
      )
      syncRunsDoc()
      return output
    },
  })

  // ---- Action resume_failed: batch resume recoverable failed runs per conversation or globally ----
  ctx.action({
    id: 'resume_failed',
    description:
      'Batch resume recoverable failed workflows and background subagents for a conversation or across all conversations; non-recoverable items (non-failed, missing handle/spec, workflow_action_uncertain, [crash_recovery_limit], secret_grant_expired_on_restart, already superseded by resumedByRunId, or still-active child conversation) are recorded in skipped without fabricating recovery.',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'number',
          minimum: 1,
          description: 'Target conversation ID (CLI supports --current auto-injection; mutually exclusive with all)',
        },
        all: {
          type: 'boolean',
          description: 'Scan recoverable failed tasks across all conversations (mutually exclusive with conversationId)',
        },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        resumed: { type: 'array', items: { type: 'object' } },
        skipped: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              reason: { type: 'string' },
            },
            required: ['runId', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['resumed', 'skipped'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'resume-failed'],
      description: 'Batch resume recoverable failed workflows and background subagents for a conversation or globally',
    },
    async handler(input, context) {
      const { conversationId: requestedConvId, all } = input as {
        conversationId?: number
        all?: boolean
      }
      if (requestedConvId !== undefined && (!Number.isInteger(requestedConvId) || requestedConvId < 1)) {
        throw new HelmError(
          'validation_error',
          `conversationId 必须是正整数（收到 ${String(requestedConvId)}）`,
          400,
          { conversationId: requestedConvId },
        )
      }
      if (all !== undefined && typeof all !== 'boolean') {
        throw new HelmError('validation_error', `all 必须为 boolean（收到 ${String(all)}）`, 400, { all })
      }
      if (requestedConvId !== undefined && all === true) {
        throw new HelmError('validation_error', 'conversationId 与 all 互斥，请仅指定其一', 400, {
          conversationId: requestedConvId,
          all,
        })
      }
      if (
        requestedConvId !== undefined &&
        context.conversationId !== undefined &&
        requestedConvId !== context.conversationId
      ) {
        throw new HelmError(
          'validation_error',
          `conversationId 冲突：输入指定 ${requestedConvId} 与调用上下文 ${context.conversationId} 不一致，请显式统一`,
          400,
          { conversationId: requestedConvId, contextConversationId: context.conversationId },
        )
      }
      const targetConvId = all === true ? undefined : (requestedConvId ?? context.conversationId)
      if (all !== true && targetConvId === undefined) {
        throw new HelmError(
          'validation_error',
          '缺少目标范围：需要提供 conversationId、all: true 或在 CLI 使用 --current',
          400,
        )
      }

      const summaries = workflows
        .listRuns()
        .filter((item) => item.status === 'failed' && (all === true || item.conversationId === targetConvId))
        .sort((a, b) => a.createdAt - b.createdAt)

      const resumed: Array<Record<string, unknown>> = []
      const skipped: Array<{ runId: string; reason: string }> = []

      for (const item of summaries) {
        const record = workflows.loadRunRecord(item.id)
        const verdict = workflows.inspectResumability(record)
        if (!verdict.resumable) {
          skipped.push({ runId: record.id, reason: verdict.reason })
          continue
        }
        try {
          assertCanSpawn(record.conversationId)
          const runSummary = await workflows.run({ resumeFromRunId: record.id })
          resumed.push(runSummary as unknown as Record<string, unknown>)
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          skipped.push({ runId: record.id, reason })
        }
      }
      syncRunsDoc()
      return { resumed, skipped }
    },
  })
}
