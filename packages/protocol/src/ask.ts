/**
 * AskDoc 提问审批契约：支持 expectedStateSeq CAS 乐观锁与机密答案自动入库。
 */

export type AskFieldType = 'text' | 'select' | 'confirm'

/** select 字段的单个候选选项。 */
export interface AskFieldOption {
  label: string
  value: string
}

/** 单个提问字段定义。 */
export interface AskFieldSpec {
  name: string
  label: string
  type: AskFieldType
  /** type 为 select 时的候选列表。 */
  options?: Array<AskFieldOption>
  /** true 时答案写入内存 SecretStash，持久层与上下文仅存 [REDACTED:stash:<uuid>]。 */
  secret?: boolean
  /**
   * secret 答案的生命周期（仅 secret: true 字段允许；缺省会话级、不过期）。
   * 到期或回合结算只停止环境注入，脱敏永不停止（旧值仍用于全部输出脱敏）。
   */
  secretLifetime?: SecretLifetime
  required?: boolean
}

/**
 * 机密生命周期（AskFieldSpec.secretLifetime 与 SecretStash.put 共用同一表达）：
 * - ttlMs：注入有效期毫秒，有限正 safe integer，上限 24 小时；按惰性判定失效
 *   （读取时对表，不设额外定时器）；
 * - scope：'conversation'（缺省，会话存续期注入）/ 'turn'（随下一次回合结算
 *   completed | failed | aborted 停止注入；idle 不清扫，异步落地的答案属于下一次回合）。
 */
export interface SecretLifetime {
  ttlMs?: number
  scope?: 'conversation' | 'turn'
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

/** 创建 AskDoc 入参（`ctx.host.createAsk`）；未提供 id 时由宿主分配，status/createdAt 由宿主管理。 */
export interface AskCreateSpec extends Omit<AskSpec, 'id' | 'status' | 'createdAt'> {
  /** 可选预定义 ID（调用方幂等重试/外部引用）；缺省由宿主生成。 */
  id?: string
}

/**
 * createAsk 的终态结果：正常三态（answered/cancelled/superseded）均 resolve，
 * 只有验证/I/O/宿主失败才 reject。superseded 即 CAS 销单，调用方应视为未获答案。
 */
export interface AskResult {
  id: string
  status: 'answered' | 'cancelled' | 'superseded'
  /** fieldName -> 答案值（secret 字段为 stash 引用）；非 answered 状态为空对象。 */
  answers: Record<string, string>
}

/** 人类提交的答案（`POST /api/asks/:id/answer`）；secret 字段仅存 stash 引用。 */
export interface AskAnswer {
  askId: string
  /** fieldName -> 答案值。 */
  answers: Record<string, string>
  answeredAt: number
}
