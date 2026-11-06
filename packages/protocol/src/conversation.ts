/**
 * 通用会话契约：五态状态机、单调序列号与输入来源。
 * 零业务角色硬编码——会话职责一律通过 profileId 与 tags 表达。
 */

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
  /** 如 ['assistant']、['worker']、['watchdog']，由插件自由打标。 */
  tags: string[]
  /** 派生来源会话 ID；根会话无此字段。 */
  parentConversationId?: number
  /** 本机工作目录绝对路径。 */
  cwd: string
  /** 当前生效模型 'provider/model'。 */
  model: string
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
  cwd?: string
  /** 当前生效模型 'provider/model'；缺省用 Profile 默认。 */
  model?: string
}

/** 部分更新会话（`PATCH /api/conversations/:id`）；undefined 字段不变。 */
export interface ConversationPatch {
  title?: string
  tags?: string[]
  cwd?: string
  model?: string
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
