/**
 * builtin:workflow 深度守卫与受管子代理登记（自 workflow.ts 入口拆出）。
 *
 * 职责：
 * - 受管子代理登记表（插件私有 doc `subagent-conversations`，跨重启持久的
 *   事实来源）：「workflow 子代理」= 经 agent_spawn 管道成功派生、onResolved
 *   回传 conversationId 的子会话（本插件 subagent 工具与编排引擎是当前全部
 *   调用方）。fork 会话与 SuperAgent worker（经 createConversation 创建，
 *   不经 spawn 管道）天然不进表——嵌套限制绝不以 parentConversationId 或
 *   tags 一刀切，也不依赖 ownership 猜测；
 * - 嵌套深度契约：受管子代理默认可嵌套 DEFAULT_MAX_SUBAGENT_DEPTH（2）层
 *   ——主会话直接派生一层，一层子代理默认可继续派生二层，达到子树上限的
 *   会话即编排叶子。before_turn 剥离派工工具、工具/动作入口前置拒绝、
 *   agent_spawn 最高优先级兜底，三道防线显式报 subagent_depth_exceeded；
 *   显式扩展到更深层经插件配置与 spawn meta 的本插件命名空间
 *   maxSubagentDepth 字段（均校验在 HARD_MAX_SUBAGENT_DEPTH 内，受管子代理
 *   不能提高继承的上限）。
 */
import { HelmError, type PluginDocHandle } from '@helm/protocol'
import { HARD_MAX_SUBAGENT_DEPTH } from '../contracts.js'

/** 受管子代理登记条目（插件私有 doc `subagent-conversations` 持久事实）。 */
export interface ManagedSubagentEntry {
  agentType?: string
  runId?: string
  createdAt: number
  /** 自身派生深度：非受管会话直接派生 = 1，受管会话再派生 = 父深度 + 1。 */
  depth: number
  /** 派生时的父会话 ID（树位置事实；resume 续接不改变）。 */
  parentConversationId: number
  /** 该子代理子树的派生深度上限（派生时快照；配置后续变更不追溯）。 */
  maxSubagentDepth: number
}

/** 深度超限统一错误（含事实细节，工具/动作入口与 agent_spawn 兜底共用）。 */
export function depthExceededError(depth: number, maxSubagentDepth: number, conversationId: number): HelmError {
  return new HelmError(
    'subagent_depth_exceeded',
    `会话 ${conversationId} 是第 ${depth} 层受管子代理（子树派生上限 ${maxSubagentDepth} 层），已达上限，不能再派生子代理或启动嵌套工作流`,
    403,
    { conversationId, depth, maxSubagentDepth, attemptedChildDepth: depth + 1 },
  )
}

/** 受管子代理登记与深度守卫（深度事实的单一读写入口）。 */
export interface ManagedSubagentRegistry {
  /** 非受管会话从 depth=0 开始（上限取当前配置）；受管会话严格采用派生时的持久事实。 */
  depthFactsOf(conversationId: number): { managed: boolean; depth: number; maxSubagentDepth: number }
  /** 幂等登记（resume 续接不覆盖既有树位置事实；落盘失败显式诊断不静默）。 */
  registerManagedSubagent(
    conversationId: number,
    meta: {
      agentType?: string
      runId?: string
      depth: number
      parentConversationId: number
      maxSubagentDepth: number
      /** maxSubagentDepth 是否来自本次显式请求（resume 续接时才改写既有上限）。 */
      ceilingExplicit: boolean
    },
  ): void
  /** 派生前置拒绝（防线二共用入口）：受管会话达到子树上限后不能再派生。 */
  assertCanSpawn(conversationId: number): void
}

/**
 * 创建登记表：构造即全量校验持久条目（坏记录在插件定义阶段显式失败，
 * 不带病运行）。configuredMaxSubagentDepth 按调用现读配置（仅非受管会话
 * 生效；受管会话严格用派生时快照，配置变更不追溯）。
 */
export function createManagedSubagentRegistry(deps: {
  doc: PluginDocHandle<Record<string, ManagedSubagentEntry>>
  configuredMaxSubagentDepth: () => number
}): ManagedSubagentRegistry {
  const { doc } = deps

  function depthFactsOf(conversationId: number): { managed: boolean; depth: number; maxSubagentDepth: number } {
    const entry = doc.get()[String(conversationId)]
    if (entry === undefined) {
      return { managed: false, depth: 0, maxSubagentDepth: deps.configuredMaxSubagentDepth() }
    }
    if (
      !Number.isInteger(entry.depth) || entry.depth < 1 ||
      !Number.isInteger(entry.maxSubagentDepth) || entry.maxSubagentDepth < entry.depth ||
      entry.maxSubagentDepth > HARD_MAX_SUBAGENT_DEPTH ||
      !Number.isSafeInteger(entry.parentConversationId) || entry.parentConversationId < 1 ||
      entry.parentConversationId === conversationId
    ) {
      throw new HelmError('subagent_record_invalid', `受管子代理 ${conversationId} 的深度登记无效`, 500, { conversationId })
    }
    return { managed: true, depth: entry.depth, maxSubagentDepth: entry.maxSubagentDepth }
  }

  // 启动即全量校验持久登记（坏记录在插件定义阶段显式失败，不带病运行）。
  for (const id of Object.keys(doc.get())) depthFactsOf(Number(id))

  function registerManagedSubagent(
    conversationId: number,
    meta: {
      agentType?: string
      runId?: string
      depth: number
      parentConversationId: number
      maxSubagentDepth: number
      /** maxSubagentDepth 是否来自本次显式请求（resume 续接时才改写既有上限）。 */
      ceilingExplicit: boolean
    },
  ): void {
    doc.update((current) => {
      const existing = current[String(conversationId)]
      return {
        ...current,
        [String(conversationId)]: {
          ...(existing ?? {}),
          ...(meta.agentType !== undefined ? { agentType: meta.agentType } : {}),
          ...(meta.runId !== undefined ? { runId: meta.runId } : {}),
          // 树位置事实幂等保真：resume 续接重复登记不覆盖既有 depth/父链；
          // 子树上限仅在显式请求时更新，否则保留原快照（配置后续变更不追溯）。
          depth: existing?.depth ?? meta.depth,
          parentConversationId: existing?.parentConversationId ?? meta.parentConversationId,
          maxSubagentDepth: meta.ceilingExplicit
            ? meta.maxSubagentDepth
            : (existing?.maxSubagentDepth ?? meta.maxSubagentDepth),
          createdAt: existing?.createdAt ?? Date.now(),
        },
      }
    })
    // 登记落盘失败显式诊断（不静默）：崩溃窗口内重启可能短暂放行。
    void doc.flush().catch((error: unknown) => {
      process.stderr.write(
        `builtin:workflow: 受管子代理会话 ${conversationId} 登记落盘失败：${
          error instanceof Error ? error.message : String(error)
        }\n`,
      )
    })
  }

  /**
   * 派生前置拒绝（防线二共用入口）：受管会话达到子树上限后不能再派生；
   * 一层子代理（depth=1，上限 2）默认放行——可继续派二层。
   */
  function assertCanSpawn(conversationId: number): void {
    const facts = depthFactsOf(conversationId)
    if (!facts.managed || facts.depth + 1 <= facts.maxSubagentDepth) return
    throw depthExceededError(facts.depth, facts.maxSubagentDepth, conversationId)
  }

  return { depthFactsOf, registerManagedSubagent, assertCanSpawn }
}
