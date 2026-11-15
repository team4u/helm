/**
 * builtin:workflow 动作注册（自 workflow.ts 入口拆出）。
 *
 * 12 个动作（五端复用：HTTP / CLI / run_action / Workflow / Web UI）：
 * 工作流库（list/get/save/delete）、运行（run/runs/inspect/abort/steer）、
 * 受管 Worktree（cleanup_worktree/list_worktrees/inspect_worktree）。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import { steerBackgroundSubagent } from './steer.js'
import type { WorktreeIsolation } from './isolation.js'
import type { WorkflowService } from './engine/index.js'

export interface WorkflowActionDeps {
  workflows: WorkflowService
  isolation: WorktreeIsolation
  /** 嵌套深度前置拒绝（防线二）：达到子树上限的会话是叶子。 */
  assertCanSpawn(conversationId: number): void
  /** run 启停后的 runs 投影刷新。 */
  syncRunsDoc(): void
}

export function registerWorkflowActions(ctx: HelmPluginContext, deps: WorkflowActionDeps): void {
  const { workflows, isolation, assertCanSpawn, syncRunsDoc } = deps

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
    id: 'run',
    description: '在指定或当前会话启动工作流运行；CLI 使用 --current 传入当前会话',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '已保存工作流名（与 script/scriptPath 择一）' },
        script: { type: 'string', description: '编排脚本源码（内联）' },
        scriptPath: { type: 'string', description: '编排脚本文件绝对路径' },
        args: { description: '原样传给脚本的任意 JSON args' },
        resumeFromRunId: { type: 'string', description: '断点恢复的既有 runId' },
        conversationId: { type: 'number', minimum: 1, description: '目标会话；新 run 必须指定，CLI 可用 --current' },
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
      description: '在指定或当前会话启动工作流运行（CLI 使用 --current）',
      positional: [{ field: 'name', readFileInto: 'script' }],
      timeoutMs: 0,
    },
    async handler(input, context) {
      const { wait, ...request } = input as { wait?: boolean } & Record<string, unknown>
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
      '向运行中的后台子代理补充指导：原生子会话经内核 guarded 端口按归属与 CAS 水位原子复核；外部执行按节点 controls.steer 委托插件，并如实返回 guardLevel（preflight 为发送前预检，cas 为提交点原子复核）。仅支持 kind=subagent、status=running 的运行；DSL 工作流、缺控制引用的外部执行及 human 归属拒绝。会话内仅发起会话自身或其祖先可控制。steered=true 仅表示已投递，不表示指导已执行；超时或断线不自动重试。',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: '后台子代理运行 ID（subagent 工具 background:true 返回的 runId）' },
        text: { type: 'string', description: '插话指导内容（非空；原样注入目标执行，附运行来源前缀）' },
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
            conversationId: { type: 'number', description: '被插话的原生子会话 ID' },
            ownership: { type: 'string', enum: ['bot', 'helm'] },
            stateChangeSeq: { type: 'number', description: '提交时复核通过的权威水位' },
            guardLevel: { type: 'string', const: 'cas', description: '守卫级别（内核 CAS 复核）' },
          },
          required: ['steered', 'runId', 'targetKind', 'conversationId', 'ownership', 'stateChangeSeq', 'guardLevel'],
          additionalProperties: false,
        },
        {
          properties: {
            steered: { type: 'boolean', const: true },
            runId: { type: 'string' },
            targetKind: { type: 'string', const: 'external' },
            executionId: { type: 'string', description: '被插话的外部执行标识' },
            nodeId: { type: 'string', description: '外部执行节点' },
            ownership: { type: 'string', const: 'helm' },
            stateChangeSeq: { type: 'number', minimum: 0, description: '预检或提交点复核时观测的权威水位' },
            guardLevel: { type: 'string', enum: ['preflight', 'cas'], description: '执行插件实际采用的守卫级别' },
          },
          required: ['steered', 'runId', 'targetKind', 'executionId', 'nodeId', 'ownership', 'stateChangeSeq', 'guardLevel'],
          additionalProperties: false,
        },
      ],
    },
    cli: {
      command: ['workflows', 'steer'],
      description: '向运行中的后台子代理插话纠偏（原生与外部（如 Herdr）执行按节点解析路由；无服务端原子守卫能力的外部目标显式拒绝）',
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
        mergedInto: { type: 'string', description: '已合入的目标分支或提交；缺省按记录 baseBranch 再回退主工作树 HEAD' },
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
      const a = input as Record<string, unknown>
      // 与工具同款语义：显式 conversationId 与上下文冲突拒绝；无任何显式
      // 选择器时（--current）以调用上下文会话为选择器；显式选择器不覆盖。
      if (
        a['conversationId'] !== undefined &&
        context.conversationId !== undefined &&
        a['conversationId'] !== context.conversationId
      ) {
        throw new HelmError(
          'validation_error',
          `conversationId 冲突：输入指定 ${String(a['conversationId'])} 与调用上下文 ${context.conversationId} 不一致，请显式统一`,
          400,
          { inputConversationId: a['conversationId'], contextConversationId: context.conversationId },
        )
      }
      const hasExplicit = a['worktreeId'] !== undefined || a['path'] !== undefined || a['conversationId'] !== undefined
      const selectorConversationId =
        a['conversationId'] !== undefined ? Number(a['conversationId']) : hasExplicit ? undefined : context.conversationId
      return isolation.cleanup(
        {
          ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
          ...(selectorConversationId !== undefined ? { conversationId: selectorConversationId } : {}),
          ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
          ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
          ...(a['deleteBranch'] !== undefined ? { deleteBranch: a['deleteBranch'] === true } : {}),
          ...(a['mergedInto'] !== undefined ? { mergedInto: String(a['mergedInto']) } : {}),
          ...(a['force'] !== undefined ? { force: a['force'] === true } : {}),
        } as Record<string, never>,
        context.signal,
      )
    },
  })

  ctx.action({
    id: 'list_worktrees',
    description: '列出受管 Git 工作树登记（含已清理记录的元数据）',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { worktrees: { type: 'array', items: { type: 'object' } } },
      required: ['worktrees'],
      additionalProperties: false,
    },
    cli: { command: ['worktrees', 'list'], description: '列出受管 Git 工作树登记' },
    async handler() {
      return { worktrees: isolation.allocator.list() }
    },
  })

  ctx.action({
    id: 'inspect_worktree',
    description: '只读检视一个受管 Git 工作树：登记元数据 + 目标节点真实 git 只读探测（状态/统计/有上限 diff 预览）；仅登记记录可检视',
    inputSchema: {
      type: 'object',
      properties: {
        worktreeId: { type: 'string', description: '受管 worktree 登记 ID（node:path；与 conversationId/path 互斥）' },
        conversationId: { type: 'number', minimum: 1, description: '子会话 ID（与 worktreeId/path 互斥）' },
        path: { type: 'string', description: 'worktree 绝对路径（与 conversationId 互斥；多节点同名路径需另附 nodeId）' },
        nodeId: { type: 'string', description: '目标节点 ID（仅可与 path 搭配，跨节点同名路径消歧）' },
        diff: { type: 'boolean', description: '是否包含 diff 预览（默认包含；登记元数据与统计始终返回）' },
      },
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        record: { type: 'object' },
        exists: { type: 'boolean' },
        unavailableReason: { type: 'string', enum: ['removed', 'directory_missing'] },
        currentBranch: { type: 'string' },
        currentHead: { type: 'string' },
        branchChanged: { type: 'boolean' },
        dirtyFiles: { type: 'array', items: { type: 'string' } },
        dirtyFileCount: { type: 'number' },
        dirtyFilesTruncated: { type: 'boolean' },
        commitsAhead: { type: 'number' },
        diffStat: { type: 'string' },
        diffPreview: { type: 'string' },
        diffTruncated: { type: 'boolean' },
        diffBase: { type: 'string', enum: ['baseCommit', 'HEAD'] },
      },
      required: ['record', 'exists', 'dirtyFiles', 'dirtyFileCount', 'dirtyFilesTruncated', 'diffTruncated', 'diffBase'],
      additionalProperties: false,
    },
    cli: {
      command: ['worktrees', 'inspect'],
      description: '只读检视受管 Git 工作树（登记元数据 + 状态/统计/diff 预览）',
      positional: [{ field: 'worktreeId', required: true }],
    },
    async handler(input, context) {
      const a = input as Record<string, unknown>
      return isolation.allocator.inspect(
        {
          ...(a['worktreeId'] !== undefined ? { worktreeId: String(a['worktreeId']) } : {}),
          ...(a['conversationId'] !== undefined ? { conversationId: Number(a['conversationId']) } : {}),
          ...(a['path'] !== undefined ? { path: String(a['path']) } : {}),
          ...(a['nodeId'] !== undefined ? { nodeId: String(a['nodeId']) } : {}),
          ...(a['diff'] !== undefined ? { diff: a['diff'] === true } : {}),
        },
        context.signal,
      )
    },
  })
}
