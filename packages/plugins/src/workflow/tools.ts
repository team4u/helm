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
    replay: 'safe',
    promptGuidelines: [
      'Load the workflow skill before writing a non-trivial script: load_skill({ skillId: "workflow", path: "references/dsl.md" }).',
      'For inline scripts, set a concise meta.name or pass label (about 4-40 characters) so the run has a readable title in the task list.',
      'After a background workflow starts, keep responding to the user or work on other things; the completion report arrives in this conversation automatically — do not sleep or poll for the result.',
      'A workflow returning a run handle means it has started; wait for the terminal-state report before delivering the final result.',
    ],
    description:
      'Run a SubagentWorkflow deterministic orchestration script in the current conversation. script is inline DSL source, scriptPath points to a script file, and name references a saved workflow (exactly one of the three); providing only resumeFromRunId reuses the original script. args is any JSON passed to the script as-is (string-shaped JSON is auto-unwrapped). Human conversations default to background execution (background defaults to true): the call returns a running summary immediately and the completion arrives as a steer follow-up in this conversation; automated conversations (owned by bot/helm: managed subagents/resident workers/trigger sessions) default to waiting synchronously for the terminal state (runId/status/nodes/result), and an explicit background=true is rejected. While a synchronous run blocks, the workflows detach action (or the UI "move to background") can move it background by runId: the call immediately returns a background handle (ok/background/summary) and the terminal state arrives as a steer follow-up.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Orchestration script source (inline)' },
        scriptPath: { type: 'string', description: 'Orchestration script file path (exactly one of script / scriptPath / name)' },
        name: { type: 'string', description: 'Saved workflow name (exactly one of script / scriptPath / name)' },
        label: { type: 'string', description: 'Optional display label for this run (overrides meta.name / scriptPath basename; non-empty string)' },
        args: { description: 'Any JSON args passed to the script (object/array/scalar; string-shaped JSON is auto-unwrapped)' },
        resumeFromRunId: { type: 'string', description: 'Existing runId to resume from the last checkpoint (optional)' },
        background: {
          type: 'boolean',
          description: 'Background execution: returns a run handle immediately and reports back to this conversation via a steer follow-up on completion. Defaults to true in human conversations; false in automated conversations, where an explicit true is rejected (prevents early settlement)',
        },
      },
      additionalProperties: false,
    },
    structuredOutputSchema: workflowOutputSchema,
    async execute(args, context) {
      const a = args as Record<string, unknown>
      if (a['label'] !== undefined && (typeof a['label'] !== 'string' || a['label'].trim() === '')) {
        return {
          output: [{ type: 'text', text: 'workflow_failed: label 必须为非空字符串' }],
          isError: true,
          structuredOutput: { ok: false, summary: 'invalid label: 必须为非空字符串' },
        }
      }
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

      const waitAndFinishForeground = async (runId: string) => {
        const current = workflows.getRun(runId)
        if (current.detachedAt !== undefined) {
          syncRunsDoc()
          const payload = { ok: true, background: true, summary: current }
          return {
            output: [{ type: 'text', text: safeResultText(payload) }],
            structuredOutput: payload,
          }
        }
        if (current.status !== 'running') {
          syncRunsDoc()
          return workflowResultEnvelope(current)
        }
        const onAbort = () => {
          if (workflows.isAutoRecoverOnRestart() && workflows.isHostClosing()) return
          void workflows.abort(runId).catch(() => {})
        }
        context.signal?.addEventListener('abort', onAbort, { once: true })
        if (context.signal?.aborted) onAbort()
        try {
          const outcome = await workflows.waitForeground(runId, {
            onDetached: () => context.signal?.removeEventListener('abort', onAbort),
            ...(context.signal !== undefined ? { signal: context.signal } : {}),
          })
          if (outcome === 'detached') {
            syncRunsDoc()
            const payload = { ok: true, background: true, summary: workflows.getRun(runId) }
            return {
              output: [{ type: 'text', text: safeResultText(payload) }],
              structuredOutput: payload,
            }
          }
          return workflowResultEnvelope(workflows.getRun(runId))
        } finally {
          context.signal?.removeEventListener('abort', onAbort)
          syncRunsDoc()
        }
      }

      try {
        // 跨重启/工具重放幂等：以受信 (conversationId, callId) 查既有 Run，绝不重复派生。
        if (typeof context.callId === 'string' && context.callId !== '') {
          const existing = workflows.findRunByParentToolCall(context.conversationId, context.callId)
          if (existing !== undefined) {
            if (backgroundChoice.background || existing.detachedAt !== undefined) {
              syncRunsDoc()
              const payload = { ok: true, background: true, summary: workflows.getRun(existing.id) }
              return {
                output: [{ type: 'text', text: safeResultText(payload) }],
                structuredOutput: payload,
              }
            }
            return await waitAndFinishForeground(existing.id)
          }
        }

        // 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子，不创建任何 run 记录。
        assertCanSpawn(context.conversationId)
        const input: Record<string, unknown> = {}
        if (a['script'] !== undefined) input['script'] = String(a['script'])
        if (a['scriptPath'] !== undefined) input['scriptPath'] = String(a['scriptPath'])
        if (a['name'] !== undefined) input['name'] = String(a['name'])
        if (a['label'] !== undefined) input['label'] = (a['label'] as string).trim()
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
        return await waitAndFinishForeground(started.id)
      } catch (error) {
        // 宿主优雅关停挂起期间父回合 abortSignal 触发：必须原样上抛拒绝，让
        // pi-durable 保持 ToolTask 未结算并在重启后按 replay: 'safe' 幂等重放。
        if (workflows.isHostClosing() && workflows.isAutoRecoverOnRestart() && context.signal?.aborted) {
          throw error
        }
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
      "Clean up one managed isolated Git worktree (the workspace of a sub-conversation spawned with isolation: 'worktree'). Locate it by worktreeId (node:path), conversationId, or worktree path (may attach nodeId to disambiguate); refused by default when the workspace has uncommitted changes or unmerged commits (inspect/merge first, or pass force: true; force cannot bypass occupancy/ownership/locked checks); optionally pass deleteBranch: true to also delete the helm/spawn-* branch (branch deletion failures can be retried). Only worktrees registered by helm are cleaned; unregistered directories are never touched.",
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: 'Managed worktree registration ID (node:path; exact selector, mutually exclusive with conversationId/path/nodeId)' },
        conversationId: { type: 'number', description: 'Sub-conversation ID (mutually exclusive with path)' },
        path: { type: 'string', description: 'Worktree absolute path (mutually exclusive with conversationId; same-name paths across nodes need nodeId)' },
        nodeId: { type: 'string', description: 'Target node ID (only combinable with path, disambiguating same-name paths across nodes)' },
        deleteBranch: { type: 'boolean', description: 'Also delete the helm/spawn-* branch (kept by default)' },
        mergedInto: { type: 'string', description: 'Target branch or commit already merged into; defaults to the recorded baseBranch, falling back to the main worktree HEAD' },
        force: { type: 'boolean', description: 'Force cleanup (only bypasses the uncommitted-changes/unmerged-commits protection; never bypasses occupancy/ownership/locked checks)' },
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
