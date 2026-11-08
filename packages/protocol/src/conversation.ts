/**
 * 通用会话契约：五态状态机、单调序列号与输入来源。
 * 零业务角色硬编码——会话职责一律通过 profileId 与 tags 表达。
 */

import type { ConversationAttachmentRef } from './artifact.js'

export type { ConversationAttachmentRef }

/** 常驻个人助理根会话 ID，固定不可删除（`DELETE /api/conversations/1` 返回 403）。 */
export const ROOT_CONVERSATION_ID = 1

/** 五态状态机；任何状态变化均推进 stateChangeSeq。 */
export type ConversationStatus =
  | 'working' // 正在执行推理、工具调用或等待子代理
  | 'blocked' // 等待人类审批（pending AskDoc）或子代理终端确认
  | 'done' // 本轮任务已完成，尚待人类查看（unread = true）
  | 'idle' // 空闲且已读
  | 'error' // 最近一轮因未捕获异常终止

/** 输入来源，附着在每次提交的 `helm.input` entry 上。 */
export type InputOrigin = 'human' | 'agent' | 'trigger'

/** 会话正忙时新输入的处理策略。 */
export type WhenBusy = 'steer' | 'followUp' | 'reject'

/** 会话列表 / SSE 快照中的通用会话摘要。 */
export interface ConversationSummary {
  id: number
  title: string
  profileId: string
  /** Profile 表达角色；tags 由插件或用户声明运行态和生命周期标记。 */
  tags: string[]
  /** 派生来源会话 ID；根会话无此字段。 */
  parentConversationId?: number
  /** 会话归属权（缺省 'human'；插件或内核创建的常驻/后台会话标为 'helm' | 'bot'）。 */
  ownedBy?: 'human' | 'helm' | 'bot'
  /** 绑定的计算节点 ID（缺省为 'local'）。 */
  nodeId?: string
  /** 目标节点视角下的工作目录绝对路径。 */
  cwd: string
  /** 当前生效模型 'provider/model'。 */
  model: string
  /** 当前思考档位（off/minimal/low/medium/high/xhigh/max）；空串未设置。 */
  thinkingLevel: string
  /** 显式思考档位覆盖；省略时继承 Profile / 全局默认。 */
  thinkingLevelOverride?: string
  status: ConversationStatus
  /** 零 Token 实时动作摘要，如 'bash: pnpm test' 或 'thinking…'。 */
  doing?: string
  /** 任何状态/doing/Ask 变化均单调递增（SSE 水位线与 CAS 校验）。 */
  stateChangeSeq: number
  /** 每次回合结束单调递增。 */
  completionSeq: number
  /** 仅人类在 Web/CLI 显式聚焦或 PATCH 时清零，API 读取不清零。 */
  unread: boolean
  pinned: boolean
  pendingAskCount: number
  createdAt: number
  updatedAt: number
}

/** 创建会话入参（`POST /api/conversations` / `ctx.host.createConversation`）。 */
export interface ConversationInit {
  title?: string
  profileId?: string
  tags?: string[]
  parentConversationId?: number
  /** 绑定的计算节点 ID（缺省继承 Profile.nodeId 或 'local'）。 */
  nodeId?: string
  cwd?: string
  /** 当前生效模型 'provider/model'；缺省用 Profile 默认。 */
  model?: string
}
/** 部分更新会话（`PATCH /api/conversations/:id`）；undefined 字段不变。 */
export interface ConversationPatch {
  profileId?: string
  title?: string
  tags?: string[]
  nodeId?: string
  cwd?: string
  model?: string
  /** 思考档位（off/minimal/low/medium/high/xhigh/max）；空串清除跟随默认。 */
  thinkingLevel?: string
  unread?: boolean
  pinned?: boolean
}

/** 单条会话输入（`POST /api/conversations/:id/input` 请求体）。 */
export interface ConversationInput {
  id: string
  text: string
  origin: InputOrigin
  whenBusy?: WhenBusy
  createdAt: number
  /** 边界已校验/脱敏的自由元数据；从 CLI --meta / HTTP 一路传到 turn_settled。 */
  meta?: Record<string, unknown>
  /** 随输入挂载的产物指针（经授权校验后写入 helm.input entry；仅轻量元数据，不含字节）。 */
  attachments?: ConversationAttachmentRef[]
}

// ---------------------------------------------------------------------------
// 会话作用域（插件工具/动作的会话级可见性策略）
// ---------------------------------------------------------------------------

/**
 * 会话作用域过滤器：不同字段之间 AND，同字段内多值 OR。
 * 字段缺省（undefined）表示该维度不限；显式空数组匹配不到任何会话。
 * 这是会话策略而非用户鉴权——无 conversationId 的人工 HTTP/CLI 调用不受限。
 */
export interface ConversationScope {
  conversationIds?: number[]
  tags?: string[]
  profileIds?: string[]
  /** 按会话当前模型供应商筛选；与其它维度取 AND。 */
  modelProviders?: string[]
}

/** Scope 判定所需的最小会话形状（ConversationSummary 的结构子集即可）。 */
export interface ConversationScopeTarget {
  id: number
  profileId: string
  tags: string[]
  model?: string
}

/**
 * 纯函数：判断会话是否落入 scope。
 * - scope 为 undefined 时一律匹配（不限）。
 * - 提供的字段之间 AND；字段内多值 OR。
 * - 显式空数组 = 该维度显式排除一切（匹配不到）。
 */
export function matchesConversationScope(
  scope: ConversationScope | undefined,
  conversation: ConversationScopeTarget,
): boolean {
  if (!scope) return true
  const { conversationIds, tags, profileIds, modelProviders } = scope
  if (modelProviders !== undefined && !modelProviders.includes(conversation.model?.split('/')[0] ?? '')) return false
  if (conversationIds !== undefined && !conversationIds.includes(conversation.id)) return false
  if (profileIds !== undefined && !profileIds.includes(conversation.profileId)) return false
  if (tags !== undefined) {
    let hit = false
    for (const t of tags) {
      if (conversation.tags.includes(t)) {
        hit = true
        break
      }
    }
    if (!hit) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// 会话详情与实时视图
// ---------------------------------------------------------------------------

/**
 * 会话时间线条目（pi-durable EntryRecord 的跨端子集）。
 * `model` 是面向模型上下文的消息数组（assistant 文本在 model 中，非 data）；
 * `data` 是应用侧 JSON 载荷，display/bookkeeping entry 可能缺省。
 */
export interface ConversationEntry {
  id: string
  kind: string
  data?: unknown
  /** 模型上下文消息（如 assistant 文本）；纯展示/簿记 entry 无此字段。 */
  model?: unknown[]
  createdAt?: number
}

/** `GET /api/conversations/:id` 响应：摘要 + 分页时间线。 */
export interface ConversationDetail extends ConversationSummary {
  entries: ConversationEntry[]
  /** 还有更早条目时的分页游标（客户端原样回传 `?cursor=`）。 */
  nextCursor?: string
}

/** `send --wait` / `POST /api/conversations/:id/input?wait=1` 的本次输入结果。 */
export interface ConversationInputResult {
  conversationId: number
  submissionId: string
  text: string
  /** 精确对应本次提交的回答条目。 */
  entry: ConversationEntry
}

/** 会话实时增量视图（SSE `conversation.live` 事件载荷）。 */
export interface ConversationLive {
  conversationId: number
  /** 当前流式助手文本的累计快照；客户端直接替换此前实时文本。 */
  text: string
  tools: Array<{
    callId: string
    toolName: string
    input?: unknown
    status: 'running' | 'done' | 'error'
    result?: unknown
  }>
  updatedAt: number
}

/** 回合终态；turn_settled 钩子统一覆盖三态。 */
export type TurnOutcome = 'completed' | 'failed' | 'aborted'

/** 回合结算载荷（turn_settled 钩子与 turn.settled 事件共用）。 */
export interface TurnSettledPayload {
  conversation: ConversationSummary
  inputs: ConversationInput[]
  outcome: TurnOutcome
  /** outcome 为 failed 时的错误摘要。 */
  error?: string
  settledAt: number
}
