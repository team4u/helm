/**
 * AskDoc 提问审批契约：支持 expectedStateSeq CAS 乐观锁与机密答案自动入库。
 */

export type AskFieldType = 'text' | 'select' | 'confirm'

/** 单个提问字段定义。 */
export interface AskFieldSpec {
  name: string
  label: string
  type: AskFieldType
  /** type 为 select 时的候选列表。 */
  options?: Array<{ label: string; value: string }>
  /** true 时答案写入内存 SecretStash，持久层与上下文仅存 [REDACTED:stash:<uuid>]。 */
  secret?: boolean
  required?: boolean
}

export type AskStatus = 'pending' | 'answered' | 'cancelled' | 'superseded'

/** 提问文档（`GET /api/asks` 列表项）。 */
export interface AskSpec {
  id: string
  conversationId: number
  ownerPluginId?: string
  title: string
  description?: string
  fields: AskFieldSpec[]
  /**
   * 可选 CAS 水位线（供 herdr 终端状态同步防竞态）：提交答案时目标对象
   * stateChangeSeq 已推进则自动流转为 superseded 销单。
   */
  expectedStateSeq?: number
  status: AskStatus
  createdAt: number
}

/** 创建 AskDoc 入参（`ctx.host.createAsk`；id/status/createdAt 由宿主分配）。 */
export type AskCreateSpec = Omit<AskSpec, 'id' | 'status' | 'createdAt'>

/** 人类提交的答案（`POST /api/asks/:id/answer`）；secret 字段仅存 stash 引用。 */
export interface AskAnswer {
  askId: string
  /** fieldName -> 答案值。 */
  answers: Record<string, string>
  answeredAt: number
}
