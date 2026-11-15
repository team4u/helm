/**
 * journal-entry.ts — 账本行契约：行类型、行级形状校验与调用 key 指纹。
 *
 * 自 journal.ts 拆出（语义逐行保持）：零文件 IO 的纯函数与类型模块——
 * - 行类型（JournalWriteInput / WorkflowJournalEntry 等）是引擎私有账本格式的
 *   唯一权威声明，行级形状校验器供 journal.ts 的 readJournal 逐行判定复用
 *   （hasValidScopeIdentity 同时是 replay / handler 边界的公共校验面）；
 * - agentJournalKey / actionJournalKey 计算 scope 内调用的重放指纹（canonical
 *   固定槽版本化规则见 agentJournalKey 头注释）。
 * 文件读写（readJournal / JournalWriter）与落盘脱敏仍归 journal.ts。
 */

import { createHash } from 'node:crypto'

/**
 * 追加写入的输入（seq/v 由写入器分配）。
 * 显式按 variant 声明而非 `Omit<Union, 'v'|'seq'>`——Omit 不分布，会把
 * agent/action 各自的合法字段（ok/text/result…）从联合上剥掉。
 */
export interface JournalScope {
  scopePath: string
  scopeCallIndex: number
}

export type JournalWriteInput = JournalScope & (
  | {
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      resumed?: true
      /** 执行元数据快照（agent.withMeta 失败保留面）：落盘前经 redactJournalEntry 脱敏。 */
      execution?: JournalAgentExecution
      /** 门禁结果（gate 失败/超时回传）：落盘前经 redactJournalEntry 脱敏。 */
      gate?: JournalGateResult
      /** 自动重试尝试序号；缺省表示第一次尝试。 */
      attempt?: number
      /** 本次 run 中所属调用的首个 index，用于审计和进度折叠。 */
      invocationIndex?: number
      prompt?: string
      /** 当前失败后由人工发起重试。自动重试按 maxAttempts 判断。 */
      retryKind?: 'manual'
      skipped?: boolean
      /** 失败原因（已脱敏）。 */
      error?: string
      timedOut?: boolean
      seq?: number
    }
  | {
      type: 'action_started'
      index: number
      key: string
      seq?: number
      idempotent?: true
    }
  | {
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      seq?: number
      idempotent?: true
    }
)

/**
 * agent 行附带的执行元数据（AgentWithMetaResult['execution'] 的持久形状）。
 * worktree 为插件契约对象，账本只做 JSON 对象边界校验不解释业务字段；
 * 重放命中缓存时原样还原给调用方（值已脱敏，秘密不得依赖重放还原）。
 */
export interface JournalAgentExecution {
  nodeId?: string
  conversationId?: number
  executionId?: string
  effectiveCwd?: string
  worktree?: Record<string, unknown>
}

/** agent 行附带的门禁结果（AgentGateResult 持久形状；exitCode/timedOut 为协议扩展预留槽）。 */
export interface JournalGateResult {
  ok: boolean
  output: string
  exitCode?: number | null
  timedOut?: boolean
}

/**
 * 引擎私有前缀重放账本行（`dataDir/artifacts/<convId>/workflow-<runId>.jsonl`，每行一个 JSON 对象）。
 *
 * 这是编排引擎的恢复账本，**不是公开 API 数据形状**（原 protocol 契约迁回引擎）：
 * - `seq` 是落盘顺序号（引擎内单调递增）；`index` 是调用发起位次（agent 与 action 共享同一全序）。
 * - `scopePath` / `scopeCallIndex` 是必需的恢复身份；`key` 校验实际载荷，`attempt` 区分重试。
 * - agent 失败行断链后 live 重试（沿用上游语义）；action 已确认的成败行重放时直接复用，
 *   绝不重执行副作用；`action_started` 无对应终态行 = 进程在动作执行中崩溃，恢复必须
 *   显式报 `workflow_action_uncertain`，由人类确认后再决定，禁止自动重放。
 *
 * HTTP / CLI 客户端不得依赖本类型的字段细节做任何重放决策；如需展示只应只读透传。
 */
export type WorkflowJournalEntry = JournalScope & (
  | {
      v: 1
      seq: number
      type: 'agent'
      index: number
      key: string
      ok: boolean
      text?: string
      /** 该调用续接了既有子会话；恢复时校验实际续接语义。 */
      resumed?: true
      /** 执行元数据快照（含 worktree；已脱敏）。maxAttempts 每次尝试各占独立 index 行。 */
      execution?: JournalAgentExecution
      /** 门禁结果（已脱敏）。 */
      gate?: JournalGateResult
      attempt?: number
      invocationIndex?: number
      prompt?: string
      retryKind?: 'manual'
      skipped?: boolean
      error?: string
      timedOut?: boolean
    }
  | {
      v: 1
      seq: number
      /** 动作意图先于执行落盘（fsync 成功后才允许执行 handler）。 */
      type: 'action_started'
      index: number
      key: string
      /** 声明幂等的动作：中断/失败后允许安全重跑，恢复时不计入 uncertain。 */
      idempotent?: true
    }
  | {
      v: 1
      seq: number
      /** 动作终态行；ok 为 true 时 result 为动作输出，false 时 error 为失败原因。 */
      type: 'action'
      index: number
      key: string
      ok: boolean
      result?: unknown
      error?: string
      /** 与 action_started 行的幂等声明一致；恢复判定见 readJournal。 */
      idempotent?: true
    }
)

/** agent 调用的 key 输入（决定该 agent 做什么的所有字段）。 */
export interface AgentJournalKeyInput {
  prompt: string
  label?: string
  model?: string
  agentType?: string
  effort?: string
  isolation?: string
  /** gate 验收命令：命令变化即不同调用，不得命中旧缓存。固定槽不与无标签变长槽互撞。 */
  gate?: string
  resume?: string
  /** agent({ schema }) 的序列化形式。 */
  schema?: string
  /**
   * agent({ attachments }) 的产物 ID 列表（原样序列化，不去重不排序：不同
   * ID 或次序变化都是不同调用）。未提供与空数组语义不同，不归一化。
   */
  attachments?: string[]
  /** 派工上限改变会改变子代理行为，不得重放原授权下的缓存结果。 */
  maxSubagentDepth?: number
  /** 机密授予变化会改变外部运行时环境，不得重放旧授权下的缓存结果。 */
  secretNames?: string[]
  /** 工作目录（agent({ cwd })）：目录变化即不同执行上下文，不得命中旧缓存。 */
  cwd?: string
}

/**
 * agent 调用 key 的 canonical 版本（v2 固定槽）。
 *
 * v1（旧账本）在 resume 槽后用变长追加（schema 存在时多一个尾槽）。新增
 * attachments 若继续尾追加，会与 v1 的 schema 尾槽直接碰撞：v1 的
 * `[p,l,m,t,e,i,g,r,schema]` 与 v2 假想的 `[p,l,m,t,e,i,g,r,schema?,attachments?]`
 * 在 schema 有/无与 attachments 有/无的四象限里产生同 canonical 异语义的碰撞。
 * 因此 v2 一次性收敛为带版本标记的固定槽：attachments 恒占第 10 槽（null =
 * 未提供），schema 恒占第 11 槽（null = 未提供），任何后续新字段只能追加在
 * 版本号之后。secretNames 追加为第 13 槽（null = 未提供；无条件占位，不与
 * 任何旧尾槽碰撞）。v3 追加 cwd 为第 14 槽（同规则无条件占位）：cwd 改变
 * 执行上下文（可从该目录切子 Worktree），不得重放旧目录下的缓存结果。注意：
 * 无条件占位使每次版本变更后**全部调用 key 与旧账本失配**（含未携带新字段的
 * 调用）——开发阶段无迁移，旧账本安全降级为断链重跑，不存在「未携带新字段
 * 则 key 不变」的兼容承诺。
 */
export function agentJournalKey(input: AgentJournalKeyInput): string {
  const canonical = JSON.stringify([
    'v3',
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    input.attachments !== undefined ? input.attachments : null,
    input.schema !== undefined ? input.schema : null,
    input.maxSubagentDepth ?? null,
    input.secretNames !== undefined ? input.secretNames : null,
    input.cwd !== undefined ? input.cwd : null,
  ])
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}

/** action 调用的 key：全限定 actionId + 序列化 input。 */
export function actionJournalKey(actionId: string, serializedInput: string): string {
  return createHash('sha256').update(JSON.stringify(['action', actionId, serializedInput])).digest('hex').slice(0, 32)
}

function isAgentExecutionShape(value: unknown): value is JournalAgentExecution {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'nodeId' && key !== 'conversationId' && key !== 'executionId' && key !== 'effectiveCwd' && key !== 'worktree') {
      return false
    }
  }
  if (e['nodeId'] !== undefined && typeof e['nodeId'] !== 'string') return false
  if (e['conversationId'] !== undefined && (!Number.isInteger(e['conversationId']) || (e['conversationId'] as number) < 1)) return false
  if (e['executionId'] !== undefined && typeof e['executionId'] !== 'string') return false
  if (e['effectiveCwd'] !== undefined && typeof e['effectiveCwd'] !== 'string') return false
  if (
    e['worktree'] !== undefined &&
    (typeof e['worktree'] !== 'object' || e['worktree'] === null || Array.isArray(e['worktree']))
  ) {
    return false
  }
  return true
}

function isAgentGateShape(value: unknown): value is JournalGateResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const e = value as Record<string, unknown>
  for (const key of Object.keys(e)) {
    if (key !== 'ok' && key !== 'output' && key !== 'exitCode' && key !== 'timedOut') return false
  }
  if (typeof e['ok'] !== 'boolean' || typeof e['output'] !== 'string') return false
  if (e['exitCode'] !== undefined && e['exitCode'] !== null && !Number.isInteger(e['exitCode'])) return false
  if (e['timedOut'] !== undefined && typeof e['timedOut'] !== 'boolean') return false
  return true
}

export function hasValidScopeIdentity(value: unknown): value is JournalScope {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry['scopePath'] === 'string' && entry['scopePath'].length <= 4096 &&
    /^root(?:\/(?:0|[1-9][0-9]*))*$/.test(entry['scopePath']) &&
    Number.isSafeInteger(entry['scopeCallIndex']) && (entry['scopeCallIndex'] as number) >= 0
}

export function isAgentEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'agent' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'agent' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    (e['text'] === undefined || typeof e['text'] === 'string') &&
    (e['resumed'] === undefined || e['resumed'] === true) &&
    (e['attempt'] === undefined || (Number.isInteger(e['attempt']) && (e['attempt'] as number) >= 1)) &&
    (e['invocationIndex'] === undefined || (Number.isInteger(e['invocationIndex']) && (e['invocationIndex'] as number) >= 0 && (e['invocationIndex'] as number) <= (e['index'] as number))) &&
    (e['prompt'] === undefined || typeof e['prompt'] === 'string') &&
    (e['retryKind'] === undefined || e['retryKind'] === 'manual') &&
    (e['skipped'] === undefined || typeof e['skipped'] === 'boolean') &&
    (e['error'] === undefined || typeof e['error'] === 'string') &&
    (e['timedOut'] === undefined || typeof e['timedOut'] === 'boolean') &&
    (e['execution'] === undefined || isAgentExecutionShape(e['execution'])) &&
    (e['gate'] === undefined || isAgentGateShape(e['gate']))
  )
}

export function isActionStartedEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action_started' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'action_started' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    (e['idempotent'] === undefined || e['idempotent'] === true)
  )
}

export function isActionEntry(value: unknown): value is Extract<WorkflowJournalEntry, { type: 'action' }> {
  if (typeof value !== 'object' || value === null) return false
  const e = value as Record<string, unknown>
  return (
    e['v'] === 1 && Number.isSafeInteger(e['seq']) && (e['seq'] as number) >= 0 &&
    e['type'] === 'action' &&
    Number.isSafeInteger(e['index']) &&
    (e['index'] as number) >= 0 &&
    hasValidScopeIdentity(e) &&
    typeof e['key'] === 'string' &&
    typeof e['ok'] === 'boolean' &&
    (e['idempotent'] === undefined || e['idempotent'] === true)
  )
}
