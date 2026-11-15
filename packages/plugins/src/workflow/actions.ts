/**
 * builtin:workflow 动作注册（自 workflow.ts 入口拆出；签名不变）。
 *
 * 12 个动作（五端复用：HTTP / CLI / run_action / Workflow / Web UI）按域分治：
 * - 工作流库（list/get/save/delete）与运行记录查询（runs/inspect/abort）
 *   保留在本模块；
 * - 运行族（run/steer）在 actions-run.ts；
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
    id: 'get',
    description: '读取已保存工作流的完整定义（只读源码与元数据；Web/AI 只读，不提供编辑）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '已保存工作流名' } },
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
      description: '读取已保存工作流定义（只读源码与元数据）',
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
    description: '保存工作流定义为跨会话资产（script 或 fromRunId 二选一；缺省名用 meta.name；默认拒绝覆盖，overwrite: true 才覆盖）',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: '完整脚本源码（与 fromRunId 二选一）' },
        fromRunId: { type: 'string', description: '把既有运行持久化的脚本源固化为定义（与 script 二选一；不可用于后台子代理运行）' },
        name: { type: 'string', description: '保存名称（可选；缺省用 meta.name，与 meta.name 不一致时拒绝）' },
        overwrite: { type: 'boolean', description: '覆盖同名定义（默认拒绝）' },
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
      description: '保存工作流定义（位置参数为本地脚本文件或目标名称；也可 --from-run-id 固化既有运行）',
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
    description: '删除已保存工作流定义文件（历史运行记录不受影响）',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: '已保存工作流名' } },
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
      description: '删除已保存工作流定义文件（历史运行记录不受影响）',
      positional: [{ field: 'name', required: true }],
    },
    async handler(input) {
      const { name } = input as { name: string }
      return workflows.delete(name)
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

  // ---- 运行族（run / steer）与受管 Worktree（cleanup/list/inspect） ----
  registerWorkflowRunActions(ctx, deps)
  registerWorktreeActions(ctx, deps)
}
