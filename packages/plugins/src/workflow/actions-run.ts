/**
 * builtin:workflow 运行族动作（自 actions.ts 按域拆出）。
 *
 * 2 个动作：
 * - run：启动工作流运行（会话目标显式优先、上下文冲突拒绝、深度前置拦截、
 *   wait 终态等待）；
 * - steer：后台子代理安全插话（授权证明与守卫细节见 ./steer.ts）。
 */
import { HelmError, type HelmPluginContext } from '@helm/protocol'
import { steerBackgroundSubagent } from './steer.js'
import type { WorkflowActionDeps } from './actions.js'

export function registerWorkflowRunActions(
  ctx: HelmPluginContext,
  deps: Pick<WorkflowActionDeps, 'workflows' | 'assertCanSpawn' | 'syncRunsDoc'>,
): void {
  const { workflows, assertCanSpawn, syncRunsDoc } = deps

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
}
