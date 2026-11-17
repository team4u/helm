/**
 * builtin:workflow 动作注册（自 workflow.ts 入口拆出；签名不变）。
 *
 * 13 个动作（五端复用：HTTP / CLI / run_action / Workflow / Web UI）按域分治：
 * - 工作流库（list/get/save/delete）与运行记录查询（runs/inspect/abort）
 *   保留在本模块；
 * - 运行族（run/steer/detach）在 actions-run.ts；
 * - 受管 Worktree（cleanup_worktree/list_worktrees/inspect_worktree）在
 *   actions-worktree.ts。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import type { WorktreeIsolation } from './isolation.js'
import type { WorkflowService } from './engine/index.js'
import { registerWorkflowRunActions } from './actions-run.js'
import { registerWorktreeActions } from './actions-worktree.js'

export interface WorkflowActionDeps {
  workflows: WorkflowService
  isolation: WorktreeIsolation
  /** 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子。 */
  assertCanSpawn(conversationId: number): void
  /** run 启停后的 runs 投影刷新。 */
  syncRunsDoc(): void
}

export function registerWorkflowActions(ctx: HelmPluginContext, deps: WorkflowActionDeps): void {
  const { workflows, syncRunsDoc } = deps

  ctx.action({
    id: 'list',
    description: 'List saved workflow definitions',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { workflows: { type: 'array', items: { type: 'object' } } },
      required: ['workflows'],
      additionalProperties: false,
    },
    cli: { command: ['workflows', 'list'], description: 'List saved workflow definitions' },
    async handler() {
      return { workflows: workflows.list() }
    },
  })

  ctx.action({
    id: 'get',
    description: 'Read the full definition of a saved workflow (read-only source and metadata; Web/AI are read-only, no editing)',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Saved workflow name' } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { workflow: { type: 'object' } },
      required: ['workflow'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'get'],
      description: 'Read a saved workflow definition (read-only source and metadata)',
      positional: [{ field: 'name', required: true }],
    },
    async handler(input) {
      const { name } = input as { name: string }
      try {
        return { workflow: workflows.get(name) }
      } catch (error) {
        if (error instanceof HelmError && error.code === 'not_found') {
          throw new HelmError('not_found', `工作流 ${name} 不存在`, 404, { name })
        }
        throw error
      }
    },
  })

  ctx.action({
    id: 'save',
    description: 'Save a workflow definition as a cross-conversation asset (script or fromRunId, exactly one; the default name comes from meta.name; overwriting is refused unless overwrite: true)',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'Full script source (exactly one of script / fromRunId)' },
        fromRunId: { type: 'string', description: 'Persist the script source of an existing run as a definition (exactly one of script / fromRunId; not available for background subagent runs)' },
        name: { type: 'string', description: 'Save name (optional; defaults to meta.name; rejected when it disagrees with meta.name)' },
        overwrite: { type: 'boolean', description: 'Overwrite a definition with the same name (refused by default)' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        created: { type: 'boolean' },
        workflow: { type: 'object' },
      },
      required: ['created', 'workflow'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'save'],
      description: 'Save a workflow definition (positional is a local script file or target name; --from-run-id persists an existing run)',
      positional: [{ field: 'name', readFileInto: 'script' }],
    },
    async handler(input) {
      const a = input as Record<string, unknown>
      return workflows.save({
        ...(a['script'] !== undefined ? { script: String(a['script']) } : {}),
        ...(a['fromRunId'] !== undefined ? { fromRunId: String(a['fromRunId']) } : {}),
        ...(a['name'] !== undefined ? { name: String(a['name']) } : {}),
        ...(a['overwrite'] !== undefined ? { overwrite: a['overwrite'] === true } : {}),
      })
    },
  })

  ctx.action({
    id: 'delete',
    description: 'Delete a saved workflow definition file (historical run records are unaffected)',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Saved workflow name' } },
      required: ['name'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        deleted: { type: 'boolean', const: true },
        name: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['deleted', 'name', 'path'],
      additionalProperties: false,
    },
    cli: {
      command: ['workflows', 'delete'],
      description: 'Delete a saved workflow definition file (historical run records are unaffected)',
      positional: [{ field: 'name', required: true }],
    },
    async handler(input) {
      const { name } = input as { name: string }
      return workflows.delete(name)
    },
  })

  ctx.action({
    id: 'runs',
    description: 'List workflow run records',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: { type: 'number', minimum: 1, description: 'Filter by conversation' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: { runs: { type: 'array', items: { type: 'object' } } },
      required: ['runs'],
      additionalProperties: false,
    },
    cli: { command: ['workflows', 'runs'], description: 'List workflow run records' },
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
    description: 'Inspect a single workflow run',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
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
      description: 'Inspect a single workflow run',
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
    description: 'Abort a workflow run',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string', description: 'Run ID' } },
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
      description: 'Abort a workflow run',
      positional: [{ field: 'runId', required: true }],
    },
    async handler(input) {
      const { runId } = input as { runId: string }
      await workflows.abort(runId)
      syncRunsDoc()
      return { run: workflows.getRun(runId) }
    },
  })

  // ---- 运行族（run / steer）与受管 Worktree（cleanup/list/inspect） ----
  registerWorkflowRunActions(ctx, deps)
  registerWorktreeActions(ctx, deps)
}
