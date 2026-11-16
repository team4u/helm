/**
 * 通用会话契约：五态状态机、单调序列号与输入来源。
 * 零业务角色硬编码——会话职责一律通过 profileId 与 tags 表达。
 */

import type { ConversationAttachmentRef } from './artifact.js'

export type { ConversationAttachmentRef }

/** 五态状态机；任何状态变化均推进 stateChangeSeq。 */
export type ConversationStatus =
  | 'working' // 正在执行推理、工具调用或等待子代理
  | 'blocked' // 等待人类审批（pending AskDoc）或子代理终端确认
  | 'done' // 本轮任务已完成，尚待人类查看（unread = true）
  | 'idle' // 空闲且已读
  | 'error' // 最近一轮因未捕获异常终止

/** 输入来源，附着在每次提交的 `helm.input` entry 上。 */
export type InputOrigin = 'human' | 'agent' | 'trigger'

/** 会话正忙时新输入的处理策略；省略时内核默认 steer（插话引导）。 */
export type WhenBusy = 'steer' | 'followUp' | 'reject'

/** 会话上下文用量（派生展示数据；内核异步刷新，可能短暂滞后于真实上下文）。
 *
 * 估算语义对齐 pi agent 1.5.2 的 `getContextUsage`：优先采用最近一次有效
 * assistant usage 实测值（stopReason 非 aborted/error 且上下文 tokens > 0）
 * 加上其后消息的字符估算；head（pi.compaction / pi.reset）与 rewind 之后的
 * 失效锚点自动退化为当前有效消息全量估算；最近一次压缩后尚无新的有效
 * usage 时 tokens 为 null——真实上下文规模未知，不拿摘要字符估算冒充。
 *
 * 响应速率类只读指标不随用量携带：那是可选插件（如 builtin:token-speed）
 * 的策略职责，经 COMPOSER_STATUS_SLOT 插槽与专用会话文档展示。 */
export interface ConversationContextUsage {
  /** 当前有效上下文的估算 tokens；null = 未知（压缩后尚无新的有效 assistant usage）。 */
  tokens: number | null
  /** 模型上下文窗口；仅当模型解析得到真实已知窗口时携带，未知不伪造。 */
  contextWindow?: number
  /** 压缩任务进行中（pi.live compactions 非空透传；展示「精简中…」）。 */
  compacting?: boolean
}

/** 会话列表 / SSE 快照中的通用会话摘要。 */
export interface ConversationSummary {
  id: number
  title: string
  profileId: string
  /** Profile 表达角色；tags 由插件或用户声明运行态和生命周期标记。 */
  tags: string[]
  /** 派生来源会话 ID；根会话无此字段。 */
  parentConversationId?: number
  /** 派生或最近一次续接本子会话的父会话工具调用 ID（供前端在 subagent 运行期即刻关联子会话）。 */
  parentToolCallId?: string
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
  /** 当前未清除失败的诊断摘要（如 'model_error: <detail>'）；仅在 status === 'error' 时出现，
   * 随下一回合开始（run 重新启动）自动清除。 */
  lastError?: string
  /** 任何状态/doing/Ask 变化均单调递增（SSE 水位线与 CAS 校验）。 */
  stateChangeSeq: number
  /** 每次回合结束单调递增。 */
  completionSeq: number
  /** 上下文用量（派生展示数据）：由内核异步刷新；其变化发布 conversation.upsert
   * 但不推进 stateChangeSeq（水位线专属于状态机/doing/Ask 的 CAS 语义）。 */
  contextUsage?: ConversationContextUsage
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

/** 会话列表过滤器（`GET /api/conversations` 查询与 `host.listConversations` 共用）。
 * 提供的字段之间 AND 组合；缺省字段不限。
 * HTTP 入口在未显式指定 `parent`/`all` 时默认 `topLevelOnly: true`（降噪）；
 * 进程内调用方（插件 host 端口）不受该默认影响，仍全量列出。 */
export interface ConversationListFilter {
  profileId?: string
  tag?: string
  status?: ConversationStatus
  /** 精确匹配直接子会话（parentConversationId === 该值）。 */
  parentConversationId?: number
  /** 仅顶层会话（无 parentConversationId）；进程内缺省为 false。 */
  topLevelOnly?: boolean
}

/** 单条会话输入（`POST /api/conversations/:id/input` 请求体）。 */
export interface ConversationInput {
  id: string
  text: string
  origin: InputOrigin
  /** 会话正忙策略；省略时内核在提交前应用有效默认 steer（插话引导）。 */
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
 *
 * HTTP 详情投影约定（仅详情分页端点；SSE 与单条端点不带）：
 * - `pi.system` 条目被过滤，不外发；
 * - model 消息内容块上的供应商签名载荷（thinkingSignature /
 *   textSignature / thoughtSignature）被剥离（仅限 assistant 消息的
 *   content 块；toolResult 的 details 等业务对象不触碰）；
 * - 超限的纯文本 toolResult 消息被显式截断（保留头尾），并在该消息对象上
 *   追加 `truncated: true` / `totalChars` / `totalLines` 标记，供前端与
 *   每条 pi.tool-result 精确配对；结构化 JSON 信封（含尾部 footer 行）与
 *   已携带 `[Artifact] id=` 产物入口的 spill 预览文本豁免（全文以产物为准）。
 *   单条端点 `GET /api/conversations/:id/entries/:entryId` 返回未截断原文
 *   （仅剥离签名，且签名剥离仅作用于 model 载荷），数据库原文永不改变。
 */
/** HTTP 详情投影对 tool-result 纯文本预览的显式截断事实。 */
export interface ToolResultTruncation {
  truncated: true
  /** 截断前完整文本字符数；缺省表示服务端未提供该计数。 */
  totalChars?: number
  /** 截断前完整文本行数；缺省表示服务端未提供该计数。 */
  totalLines?: number
}

export interface ConversationEntry {
  id: string
  kind: string
  data?: unknown
  /** 模型上下文消息（如 assistant 文本）；纯展示/簿记 entry 无此字段。 */
  model?: unknown[]
  /** 追加该 entry 的执行任务（SDK byTaskId；scheduler 上下文等无归属时缺省）。
   * assistant 条目可据它与 ConversationLiveGeneration.taskId 关联；其他
   * 条目也可能来自工具等任务，缺省时不可猜测归属。 */
  taskId?: number
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

/** 当前在 pi.inbox 中排队待生效的输入（steer 优先于 followUp；时间线尾部胶囊）。 */
export interface QueuedConversationInput {
  id: string
  submissionId: string
  text: string
  mode: 'steer' | 'followUp'
  origin: InputOrigin
  createdAt: number
  attachments?: ConversationAttachmentRef[]
}

/** 会话实时增量视图（SSE `conversation.live` 事件载荷）。 */
export interface ConversationLive {
  conversationId: number
  /** 当前流式助手文本的累计快照；客户端直接替换此前实时文本。 */
  text: string
  /** 当前流式思考块（thinking）的累计快照；无思考块时省略。 */
  thinking?: string
  tools: Array<{
    callId: string
    toolName: string
    input?: unknown
    status: 'running' | 'done' | 'error'
    result?: unknown
  }>
  /** 插件策略（如实时解码速率）所需的通用流式事实；generation 进行中且
   * 快照可投影时携带（idle/终态帧省略）。内核只透传事实，不做任何速率计算。 */
  generation?: ConversationLiveGeneration
  /** 当前在 pi.inbox 中排队待生效的输入（steer 优先于 followUp）；无排队项时省略或为空。 */
  queuedInputs?: QueuedConversationInput[]
  updatedAt: number
}

/** 当前 generation 的通用流式执行事实（内核仅透传观察事实，绝不计算速率；
 * 解码速率 / TTFT / 对账等策略由消费方（如 builtin:token-speed 插件）自行推导）。
 *
 * 时间口径诚实性：SDK LiveState 不提供请求开始的 wall/monotonic 锚点，
 * 内核不伪造；消费方只能以「首次观测到 generation 的帧时间」为 TTFT 起点
 * 近似（受 live 节流与 partial 提交节流双重限制），展示端必须如实标注。 */
export interface ConversationLiveGeneration {
  /** generation 所属生成任务（SDK live.run.taskId；每工具轮 handOver 换新
   * 任务，同任务内重试不变）。与 entry.taskId 同源，是流式快照与最终落库
   * 结果精确关联的连接键——内核只透传，绝不伪造。 */
  taskId: number
  /** 同一生成任务内的 attempt 序号（重试时递增；每工具轮新任务重置为 1）。 */
  attempt: number
  /** 当前累计 assistant message 快照（受限投影；message 尚无内容时省略）。 */
  message?: ConversationLiveMessage
}

/** 流式 assistant message 的受限 JSON-safe 投影（只含生成内容事实）。
 *
 * - text / thinking 块：字符串快照；
 * - toolCall 块：name 与 arguments（partial 为解析中的 JSON 值；参数是模型
 *   生成 token，速率策略不得漏计）；
 * - usage：仅供应商累计上报口径（无上报省略）——绝不用字符估算冒充；
 * - 不透传内容与 usage 之外的字段（不泄露 provider request 私有数据；
 *   内容与既有 text/thinking/tools 字段同源同类）。 */
export interface ConversationLiveMessage {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'thinking'; thinking: string }
    | { type: 'toolCall'; name: string; arguments?: unknown }
  >
  /** 供应商累计输出 tokens（partial.usage.output；正有限数才携带）。 */
  usage?: { output: number }
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
