/**
 * builtin:superagent —— 独立 Watchdog 模块（两层巡检：0-Token 规则表 + L2 认知排障）。
 *
 * 本模块只做巡检策略，机制全部来自 PluginHost / runtime / Herdr 探针：
 * - watchdog_tick（priority 0，位于 Herdr priority 100 追加外部探针之后）汇总
 *   native + external 探针，按确定性规则表执行 notify / bridge_to_ask /
 *   auto_abort_and_notify / wake_watchdog；
 * - 去重状态持久化于私有 ctx.doc（同 (targetKind,nodeId,targetId,stateChangeSeq)
 *   同类动作恰好一次；未达阈值绝不预先占坑，跨重启不重复危险动作）；
 * - L2：向专属 watchdog 会话合并投递异常事实（origin agent / followUp），
 *   并以 ctx.tool 注册 watchdog_inspect / watchdog_recover / watchdog_abort
 *   （scope profileIds:['watchdog']，执行核对实际 watchdogId）；同名 ctx.action
 *   复用同一 handler 供 HTTP/CLI（不 exposeAsTool，避免重复工具）。
 *
 * 安全红线（执行层强约束，不依赖 SYSTEM.md）：
 * - Watchdog 自身（id 或 profileId=watchdog）绝不做探针目标；其 failed/aborted
 *   仅通知（turn_settled），防自巡检死循环；
 * - ownedBy=human 与一切外部终端窗格只读：只允许 notify / 诊断，绝无按键、
 *   恢复注入、自动中止；mutation 前一律现查 deps.getConversationOwnership；
 * - 外部窗格的中止只能经由核对 facts.parentConversationId 指向的 owned 原生
 *   工作会话后由 L2/规则对该会话 abort，由 Herdr 原取消链清理；
 * - 外部探针 facts.stalledBasis='since-last-state-change'：stalledMs 只反映
 *   状态翻转间隔，不含 working 内部活动，绝不能单独作为自动中止证据。
 */

import {
  HelmError,
  ROOT_CONVERSATION_ID,
  type AskResult,
  type BeforeTurnHookPayload,
  type HelmPluginContext,
  type TurnSettledPayload,
  type WatchdogOwnership,
  type WatchdogProbe,
  type WatchdogTickHookPayload,
} from '@helm/protocol'
import { redactJsonValue } from '../../redact.js'
import type { SuperAgentDependencies, SuperAgentWatchdogRuntime } from './contracts.js'

// ---------------------------------------------------------------------------
// 常量与私有类型
// ---------------------------------------------------------------------------

const WATCHDOG_PROFILE_ID = 'watchdog'

export const WATCHDOG_TOOL_INSPECT = 'watchdog_inspect'
export const WATCHDOG_TOOL_RECOVER = 'watchdog_recover'
export const WATCHDOG_TOOL_ABORT = 'watchdog_abort'

/**
 * watchdog 会话（含同 profile 直聊）的 before_turn 工具白名单：
 * 只读 / 记忆 / 专属巡检工具；其余（含 bash/edit/write/subagent/
 * SubagentWorkflow/run_action 与未知第三方工具）一律剥离，#1 与普通 Bot 不受影响。
 */
export const WATCHDOG_ALLOWED_TOOLS: ReadonlySet<string> = new Set([
  'read',
  'read_artifact',
  'load_skill',
  'update_memory',
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  WATCHDOG_TOOL_ABORT,
])

/** 仅实际 watchdog 会话可用的专属工具（同 profile 直聊不可得）。 */
const WATCHDOG_EXCLUSIVE_TOOLS: ReadonlySet<string> = new Set([
  WATCHDOG_TOOL_INSPECT,
  WATCHDOG_TOOL_RECOVER,
  WATCHDOG_TOOL_ABORT,
])

/** 外部目标（无权威 seq，以哨兵水位去重）的同类动作再触发间隔。 */
const EXTERNAL_REFRACTORY_MS = 60 * 60 * 1000
/** 去重文档允许的动作类别（私有 Doc 只信本模块写出的形状）。 */
const DEDUP_ACTIONS: ReadonlySet<string> = new Set(['notify', 'wake', 'abort', 'bridge'])

/** 去重动作类别。 */
type DedupAction = 'notify' | 'wake' | 'abort' | 'bridge'

interface DedupMark {
  /** 触发时的权威水位（外部/缺 seq 目标用 -1 哨兵）。 */
  seq: number
  at: number
}

interface WatchdogDedupDoc {
  version: 1
  fired: Record<string, Record<string, DedupMark>>
}

/** 单个异常事实（L2 投递与通知共用的最小形状）。 */
interface Finding {
  key: string
  targetKind: 'conversation' | 'external'
  nodeId?: string
  targetId: string
  conversationId?: number
  ownedBy: WatchdogOwnership
  status: string
  stateChangeSeq?: number
  stalledMs?: number
  consecutiveErrors?: number
  pendingAskCount?: number
  parentConversationId?: number
  /** 人类可读的证据描述（发出前统一 redact）。 */
  evidence: string
  /** 0-Token 层已定处置，供 L2 知晓上下文。 */
  disposition: string
}

type PlannedOp =
  | { type: 'notify'; finding: Finding; refractoryMs: number }
  | { type: 'wake'; finding: Finding; refractoryMs: number }
  | { type: 'abort'; finding: Finding }
  | { type: 'bridge'; finding: Finding }

// ---------------------------------------------------------------------------
// 纯辅助：探针字段归一 / 去重文档校验 / 文本转义
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function asNonNegativeInt(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined
}

function asNonNegativeFinite(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

/** 去重键：JSON 数组三元组，杜绝冒号拼接碰撞（如 targetId 含 ':'）。 */
function targetKey(kind: string, nodeId: string | undefined, targetId: string): string {
  return JSON.stringify([kind, nodeId ?? 'local', targetId])
}

/** XML 转义：异常事实进入 L2 提示词前防逃逸（不用反引号围栏，杜绝 prompt 注入面）。 */
function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

/**
 * 去重文档读入严格校验：结构/键/动作名/seq（非负整数或哨兵 -1）/at 任一非法
 * → 显式 superagent_doc_corrupt 上抛（tick 失败并通知诊断），绝不静默回空——
 * 回空会令已处理过的危险动作重新触发（诚实性纪律）。首次声明的默认值
 * （version:1, fired:{}）天然合法；开发阶段无旧格式兼容。
 */
function sanitizeDedupDoc(raw: unknown): WatchdogDedupDoc {
  if (!isPlainObject(raw) || raw['version'] !== 1 || !isPlainObject(raw['fired'])) {
    throw corruptDedupDoc('顶层结构非法（需 {version:1, fired:{}}）')
  }
  const fired: WatchdogDedupDoc['fired'] = {}
  for (const [key, actions] of Object.entries(raw['fired'])) {
    if (key.length === 0 || !isPlainObject(actions)) {
      throw corruptDedupDoc(`键 ${JSON.stringify(key)} 的动作表非法`)
    }
    const cleaned: Record<string, DedupMark> = {}
    for (const [action, mark] of Object.entries(actions)) {
      if (!DEDUP_ACTIONS.has(action)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 含未知动作 ${JSON.stringify(action)}`)
      }
      if (!isPlainObject(mark)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的标记非法`)
      }
      const seq = mark['seq']
      const at = mark['at']
      // seq 仅允许非负整数或外部/缺水位哨兵 -1；at 必须非负整数。
      if (!((typeof seq === 'number' && Number.isInteger(seq) && seq >= 0) || seq === -1)) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的 seq 非法：${String(seq)}`)
      }
      if (typeof at !== 'number' || !Number.isInteger(at) || at < 0) {
        throw corruptDedupDoc(`键 ${JSON.stringify(key)} 动作 ${action} 的 at 非法：${String(at)}`)
      }
      cleaned[action] = { seq: seq as number, at: at as number }
    }
    fired[key] = cleaned
  }
  return { version: 1, fired }
}

function corruptDedupDoc(detail: string): HelmError {
  return new HelmError(
    'superagent_doc_corrupt',
    `Watchdog 去重文档损坏（${detail}）——拒绝继续巡检以防已处理动作重放；请人工核查插件 doc watchdog-dedup`,
    500,
    { detail },
  )
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

export function registerSuperAgentWatchdog(
  ctx: HelmPluginContext,
  deps: SuperAgentDependencies,
  runtime: SuperAgentWatchdogRuntime,
): void {
  const dedup = ctx.doc<WatchdogDedupDoc>('watchdog-dedup', { version: 1, fired: {} })

  /** 最近一轮外部探针事实（内存缓存，watchdog_inspect 只读诊断用；键与去重键同构）。 */
  const lastExternalProbes = new Map<string, WatchdogProbe>()
  /** 进行中的 bridge Ask（dedup key -> askId）：service stop 取消 + 防同水位重复创建。 */
  const inFlightBridges = new Map<string, string>()
  /** 提交中的目标水位，防止不同 tick 对同一异常重复投递。 */
  const inFlightWakes = new Set<string>()
  /** 服务停止后不再发起新的自动处置（close 期间不无边界等待）。 */
  let closing = false

  // ---- 通知 / fire-and-forget --------------------------------------------

  function notify(level: 'info' | 'warning' | 'error', title: string, body: string, conversationId?: number): void {
    if (closing) return // 生命周期后不再追加事件写入
    try {
      ctx.host.emitEvent('notification', {
        type: 'notification',
        level,
        title: deps.redact(title),
        body: deps.redact(body),
        ...(conversationId !== undefined ? { conversationId } : {}),
      })
    } catch (err) {
      console.error(`[superagent-watchdog] ${deps.redact(`通知发送失败：${err instanceof Error ? err.message : String(err)}`)}`)
    }
  }

  /**
   * fire-and-forget 一律经 runtime.track（计入 service.liveTasks）；
   * track 契约已负责 rejection 显式通知，这里仅防「track 仍抛出」造成
   * 未观察 rejection 崩溃进程——错误已被显式上报，不是静默降级。
   */
  function fireAndForget<T>(label: string, task: () => Promise<T>): void {
    void runtime.track(label, task).catch((err: unknown) => {
      notify(
        'error',
        'Watchdog 后台任务失败',
        `${label}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  // ---- 去重文档（读入严格校验：损坏显式 superagent_doc_corrupt，绝不静默回空）----

  function readDedup(): WatchdogDedupDoc {
    return sanitizeDedupDoc(dedup.get())
  }

  /** 关闭周期不再写去重状态；活动周期的所有存储错误如实传播。 */
  function writeDedup(value: WatchdogDedupDoc): void {
    if (closing) return
    dedup.set(value)
  }

  function shouldFire(key: string, action: DedupAction, seq: number, refractoryMs: number): boolean {
    const mark = readDedup().fired[key]?.[action]
    if (mark === undefined) return true
    if (mark.seq !== seq) return true // 新权威水位 = 新事件，可再次触发
    return Date.now() - mark.at >= refractoryMs
  }

  /** 撤销去重标记（bridge 创建/等待失败时恢复重试权；仅生命周期失效豁免写失败）。 */
  function unmarkFired(key: string, action: DedupAction): void {
    const doc = readDedup()
    const actions = doc.fired[key]
    if (actions === undefined) return
    delete actions[action]
    if (Object.keys(actions).length === 0) delete doc.fired[key]
    else doc.fired[key] = actions
    writeDedup(doc)
  }

  function markFired(key: string, action: DedupAction, seq: number): void {
    const doc = readDedup()
    const actions = doc.fired[key] ?? {}
    // 每目标每动作仅保最新标记（写入即覆盖），不淘汰历史键——淘汰会让旧危险
    // 动作重新获得触发权；已确认消亡的目标经 evictStaleTargets 统一回收。
    actions[action] = { seq, at: Date.now() }
    doc.fired[key] = actions
    writeDedup(doc)
  }

  /**
   * 已消亡目标的安全淘汰：会话已删（not_found）的历史键直接删除（目标不存在
   * 了无从重放）；外部探针目标需同时满足三条件才淘汰（防瞬时探针缺失把危险
   * 动作去重标记清掉造成重放）：① 不在当前活跃探针集；② 总键数超上限；
   * ③ 该键最后一次动作距今超过 EXTERNAL_EVICT_AFTER_MS（刚触发过 notify/wake
   * 等动作的键即便瞬时缺失也绝不淘汰——网络抖动/单 tick 未采到不是消亡证据）。
   * 活跃目标绝不淘汰。
   */
  const MAX_DEDUP_KEYS = 256
  const MAX_EXTERNAL_PROBE_CACHE = 256
  /** 外部键淘汰陈旧度门槛（最后一次动作后仍持续缺失 24h 才算消亡）。 */
  const EXTERNAL_EVICT_AFTER_MS = 24 * 60 * 60 * 1000

  /** 陈旧预算告警一次性标记（避免每 tick 刷屏；重启后可重新告警）。 */
  let staleBudgetWarned = false

  /** 当前 doc 中外部目标键计数。 */
  function countExternalKeys(): number {
    let n = 0
    for (const key of Object.keys(readDedup().fired)) {
      const parsed = parseTargetKey(key)
      if (parsed?.kind === 'external') n += 1
    }
    return n
  }

  function evictStaleTargets(activeProbeKeys: ReadonlySet<string>): void {
    const doc = readDedup()
    let mutated = false
    // 外部探针缓存同样收敛：不在当前活跃集且超限时淘汰。
    if (lastExternalProbes.size > MAX_EXTERNAL_PROBE_CACHE) {
      for (const key of [...lastExternalProbes.keys()]) {
        if (lastExternalProbes.size <= MAX_EXTERNAL_PROBE_CACHE) break
        if (!activeProbeKeys.has(key)) lastExternalProbes.delete(key)
      }
    }
    for (const key of [...Object.keys(doc.fired)]) {
      const parsed = parseTargetKey(key)
      if (parsed === undefined) continue
      if (parsed.kind === 'conversation') {
        // 已删除会话：目标已消亡，无从重放，安全删除。
        const id = Number(parsed.targetId)
        if (!Number.isInteger(id) || id <= 0) {
          delete doc.fired[key]
          mutated = true
          continue
        }
        try {
          ctx.host.getConversation(id)
        } catch (err) {
          if (err instanceof HelmError && err.code === 'not_found') {
            delete doc.fired[key]
            mutated = true
          }
          // 其它错误（宿主故障）不淘汰：诚实保留，下轮重试。
        }
        continue
      }
      // 外部目标：仍在活跃探针集则保留；否则需超限 + 距最后一次动作超过
      // 陈旧门槛才淘汰（迭代序即插入序，最旧优先）。
      if (activeProbeKeys.has(key)) continue
      if (Object.keys(doc.fired).length > MAX_DEDUP_KEYS && isExternalKeyStale(doc.fired[key]!)) {
        delete doc.fired[key]
        mutated = true
      }
    }
    if (mutated) writeDedup(doc)
  }

  /** 外部键陈旧判定：全部动作标记都早于 EXTERNAL_EVICT_AFTER_MS 才算消亡。 */
  function isExternalKeyStale(actions: Record<string, DedupMark>): boolean {
    const marks = Object.values(actions)
    if (marks.length === 0) return true // 无动作标记：无重放风险，可直接淘汰
    const latest = Math.max(...marks.map((m) => m.at))
    if (Date.now() - latest >= EXTERNAL_EVICT_AFTER_MS) return true
    // 近期仍有动作但持续缺失：保留（不淘汰）。若外部键总量已远超预算（3x）
    // 则一次性告警（内存保护兜底诊断，仍不自动清除——淘汰导致危险动作重放
    // 的代价大于内存占用）。
    if (!staleBudgetWarned && countExternalKeys() > MAX_DEDUP_KEYS * 3) {
      staleBudgetWarned = true
      notify(
        'warning',
        'Watchdog 去重文档外部键超预算',
        `去重文档外部目标键 ${countExternalKeys()} 个远超预算 ${MAX_DEDUP_KEYS}，但均未达 ${EXTERNAL_EVICT_AFTER_MS / 3_600_000}h 消亡门槛；为防危险动作重放暂不淘汰，请人工核查外部探针目标集`,
      )
    }
    return false
  }

  /** 当前 tick 活跃外部探针键集（与去重键同构）。 */
  function collectActiveExternalKeys(probes: WatchdogProbe[]): Set<string> {
    const keys = new Set<string>()
    for (const probe of probes) {
      if (probe.targetKind !== 'external') continue
      keys.add(targetKey('external', probe.nodeId, probe.targetId))
    }
    return keys
  }

  /** 去重键（JSON 数组三元组）还原为 {kind, nodeId, targetId}；非目标形状返回 undefined。 */
  function parseTargetKey(key: string): { kind: string; nodeId?: string; targetId: string } | undefined {
    try {
      const parsed = JSON.parse(key) as unknown
      if (!Array.isArray(parsed) || parsed.length !== 3) return undefined
      const [kind, nodeId, targetId] = parsed as [string, string, string]
      if (typeof kind !== 'string' || typeof targetId !== 'string') return undefined
      return { kind, ...(nodeId !== 'local' ? { nodeId } : {}), targetId }
    } catch {
      return undefined
    }
  }

  /** seq 缺失（外部/读不到权威水位）时的哨兵；与任何真实 seq（>=0）必然不等。 */
  const SENTINEL_SEQ = -1

  // ---- 归属与目标守卫 -------------------------------------------------------

  function isWatchdogSession(id: number, profileId: string | undefined): boolean {
    if (runtime.getWatchdogConversationId() === id) return true
    return profileId === WATCHDOG_PROFILE_ID
  }

  /** 受保护目标：root / 中枢 / watchdog 自身（防自激与误伤常驻入口）。 */
  function isProtectedTarget(conversationId: number): boolean {
    return (
      conversationId === ROOT_CONVERSATION_ID ||
      conversationId === runtime.getRouterConversationId() ||
      conversationId === runtime.getWatchdogConversationId()
    )
  }

  /**
   * mutation 前的即时归属核对：probe 携带的 ownedBy 可能已过期，
   * 一律以 deps.getConversationOwnership 现读为准（root 恒 human）。
   */
  function assertOwnedTarget(conversationId: number): void {
    if (isProtectedTarget(conversationId)) {
      throw new HelmError(
        'watchdog_target_protected',
        `会话 ${conversationId} 受保护（root/中枢/巡检自身），拒绝 Watchdog 自动处置`,
        403,
        { conversationId },
      )
    }
    const ownedBy = deps.getConversationOwnership(conversationId)
    if (ownedBy === 'human') {
      throw new HelmError(
        'watchdog_target_human',
        `会话 ${conversationId} 归属人类（ownedBy=human），仅允许只读诊断与通知`,
        403,
        { conversationId },
      )
    }
  }

  // ---------------------------------------------------------------------------
  // watchdog_tick（priority 0）：规则表评估（只读分类，动单另行执行）
  // ---------------------------------------------------------------------------

  ctx.hook.onWatchdogTick(
    async (payload: WatchdogTickHookPayload) => {
      const cfg = runtime.getConfig()
      if (!cfg.watchdogEnabled || closing || deps.isClosing()) return
      readDedup()
      // 历史键安全淘汰（已删会话 / 超限外部目标）：防 7×24 无限膨胀。
      evictStaleTargets(collectActiveExternalKeys(payload.probes))
      const shuttingDown = false

      // 防自激：排除 watchdog 自身 id 与一切 profileId=watchdog 的会话（含直聊）。
      const watchdogIds = new Set<number>()
      const watchdogId = runtime.getWatchdogConversationId()
      if (watchdogId !== undefined) watchdogIds.add(watchdogId)
      for (const summary of payload.conversations) {
        if (summary.profileId === WATCHDOG_PROFILE_ID) watchdogIds.add(summary.id)
      }

      const findings: Finding[] = []
      const ops: PlannedOp[] = []

      for (const probe of payload.probes) {
        // 未声明 targetKind 的探针不作为自动干预授权：不猜数字 targetId 的类别。
        if (probe.targetKind !== 'conversation' && probe.targetKind !== 'external') {
          const finding: Finding = {
            key: targetKey('unknown', probe.nodeId, probe.targetId),
            targetKind: 'conversation',
            targetId: probe.targetId,
            ownedBy: probe.ownedBy,
            status: probe.status,
            evidence: `探针未声明 targetKind（targetId=${probe.targetId}），不猜测目标类别，仅只读告知`,
            disposition: 'notify_only（未声明目标类别）',
          }
          findings.push(finding)
          ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
          continue
        }
        if (probe.targetKind === 'external') {
          classifyExternal(probe, watchdogIds, cfg, findings, ops)
        } else {
          classifyNative(probe, watchdogIds, cfg, findings, ops)
        }
      }

      await executeOps(payload.timestamp, shuttingDown, findings, ops)
    },
    { priority: 0 },
  )

  function classifyNative(
    probe: WatchdogProbe,
    watchdogIds: Set<number>,
    cfg: { stalledAfterMs: number; abortAfterMs: number; errorThreshold: number },
    findings: Finding[],
    ops: PlannedOp[],
  ): void {
    // 自动干预授权三要素：显式 targetKind=conversation + 显式正整数 conversationId
    // + 权威 seq。绝不从数字 targetId 猜 conversationId（外部 paneId 同样是数字）。
    const rawId = probe.conversationId
    const conversationId =
      typeof rawId === 'number' && Number.isInteger(rawId) && rawId > 0 ? rawId : undefined
    if (conversationId === undefined) {
      // 缺显式会话标识：无法建立归属核对，只读告知（不猜数字 targetId）。
      ops.push({
        type: 'notify',
        refractoryMs: EXTERNAL_REFRACTORY_MS,
        finding: {
          key: targetKey('conversation', undefined, probe.targetId),
          targetKind: 'conversation',
          targetId: probe.targetId,
          ownedBy: probe.ownedBy,
          status: probe.status,
          evidence: '原生探针缺少显式 conversationId，不猜测目标，仅只读告知',
          disposition: 'notify_only（缺会话标识）',
        },
      })
      return
    }
    if (watchdogIds.has(conversationId)) return // Watchdog 自身异常仅经 turn_settled 通知

    const seq = asNonNegativeInt(probe.stateChangeSeq)
    const stalledMs = asNonNegativeFinite(probe.stalledMs)
    const errors = asNonNegativeInt(probe.consecutiveErrors) ?? 0
    const pendingAskCount = asNonNegativeInt(probe.facts?.['pendingAskCount']) ?? 0

    const finding: Finding = {
      key: targetKey('conversation', undefined, String(conversationId)),
      targetKind: 'conversation',
      targetId: probe.targetId,
      conversationId,
      ownedBy: probe.ownedBy,
      status: probe.status,
      ...(seq !== undefined ? { stateChangeSeq: seq } : {}),
      ...(stalledMs !== undefined ? { stalledMs } : {}),
      ...(errors > 0 ? { consecutiveErrors: errors } : {}),
      pendingAskCount,
      evidence: `原生会话 #${conversationId} 状态 ${probe.status}${
        stalledMs !== undefined ? `，停滞 ${Math.round(stalledMs / 1000)}s` : ''
      }${errors > 0 ? `，连续错误 ${errors} 次` : ''}`,
      disposition: '',
    }
    findings.push(finding)

    // 权威水位缺失：不可防重，绝不执行变更类动作，只读通知。
    if (seq === undefined) {
      finding.disposition = 'notify_only（缺权威 seq，只读）'
      ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
      return
    }

    if (probe.ownedBy === 'human') {
      // 人类对象永远只读/通知：不为纯 human 异常唤醒执行模型。
      if (probe.status === 'blocked' || probe.status === 'error' || (stalledMs !== undefined && stalledMs >= cfg.stalledAfterMs)) {
        finding.disposition = 'notify_only（human 归属只读红线）'
        ops.push({ type: 'notify', finding, refractoryMs: Number.POSITIVE_INFINITY })
      }
      return
    }

    // ---- owned（helm/bot）确定性规则表 ----
    if (probe.status === 'blocked') {
      if (pendingAskCount > 0) {
        // 已有待答 Ask：沿用既有审批通道（Herdr 桥或原生 Ask），绝不复制审批。
        finding.disposition = 'notify_only（已有待答 Ask，沿用既有审批）'
        ops.push({ type: 'notify', finding, refractoryMs: Number.POSITIVE_INFINITY })
      } else {
        finding.disposition = 'bridge_to_ask（创建恢复/中止确认 Ask）'
        ops.push({ type: 'bridge', finding })
      }
      return
    }
    if (probe.status === 'error' || (cfg.errorThreshold > 0 && errors >= cfg.errorThreshold)) {
      // 持续 error 交认知层判断（错误不等于停滞，不自动中止）。
      finding.disposition = 'wake_watchdog（持续错误，需认知排障）'
      ops.push({ type: 'wake', finding, refractoryMs: Number.POSITIVE_INFINITY })
      return
    }
    if (stalledMs !== undefined && cfg.abortAfterMs > 0 && stalledMs >= cfg.abortAfterMs) {
      finding.disposition = 'auto_abort_and_notify（超长停滞，自动中止）'
      ops.push({ type: 'abort', finding })
      ops.push({ type: 'wake', finding, refractoryMs: Number.POSITIVE_INFINITY })
      return
    }
    if (stalledMs !== undefined && cfg.stalledAfterMs > 0 && stalledMs >= cfg.stalledAfterMs) {
      finding.disposition = 'wake_watchdog（停滞达到唤醒阈值）'
      ops.push({ type: 'wake', finding, refractoryMs: Number.POSITIVE_INFINITY })
    }
  }

  function classifyExternal(
    probe: WatchdogProbe,
    watchdogIds: Set<number>,
    cfg: { stalledAfterMs: number; abortAfterMs: number; errorThreshold: number },
    findings: Finding[],
    ops: PlannedOp[],
  ): void {
    const nodeId = probe.nodeId ?? 'local'
    const key = targetKey('external', nodeId, probe.targetId)
    lastExternalProbes.set(targetKey('external', nodeId, probe.targetId), probe)

    // 由 watchdog 会话派生的窗格同样排除，防自激。
    const parent = asNonNegativeInt(probe.facts?.['parentConversationId'])
    if (parent !== undefined && watchdogIds.has(parent)) return

    const seq = asNonNegativeInt(probe.stateChangeSeq)
    const stalledMs = asNonNegativeFinite(probe.stalledMs)
    const errors = asNonNegativeInt(probe.consecutiveErrors) ?? 0
    const pendingAskCount = asNonNegativeInt(probe.facts?.['pendingAskCount']) ?? 0

    const finding: Finding = {
      key,
      targetKind: 'external',
      nodeId,
      targetId: probe.targetId,
      ownedBy: probe.ownedBy,
      status: probe.status,
      ...(seq !== undefined ? { stateChangeSeq: seq } : {}),
      ...(stalledMs !== undefined ? { stalledMs } : {}),
      ...(errors > 0 ? { consecutiveErrors: errors } : {}),
      pendingAskCount,
      ...(parent !== undefined ? { parentConversationId: parent } : {}),
      evidence: `外部窗格 ${probe.targetId}@${nodeId} 状态 ${probe.status}${
        errors > 0 ? `，连续不可达 ${errors} 次` : ''
      }${pendingAskCount > 0 ? `，待答审批 ${pendingAskCount}` : ''}`,
      disposition: '',
    }
    findings.push(finding)

    if (seq === undefined) {
      finding.disposition = 'notify_only（缺权威 seq，只读）'
      ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
      return
    }

    if (probe.ownedBy === 'human') {
      if (probe.status === 'blocked' || probe.status === 'error' || probe.status === 'unreachable') {
        finding.disposition = 'notify_only（human 归属外部窗格只读）'
        ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
      }
      return
    }

    // 外部事实口径：stalledMs 基于「上次状态翻转」，不含 working 内部活动——
    // 绝不能单独作为自动中止/高频唤醒证据（Herdr state_change_seq 只记翻转）。
    switch (probe.status) {
      case 'unreachable': {
        // 连续不可达 = 明确失败证据（非停滞时长），达阈值交认知层 + 通知。
        if (cfg.errorThreshold > 0 && errors >= cfg.errorThreshold) {
          finding.disposition = 'wake_watchdog（外部窗格连续不可达，需认知排障）'
          ops.push({ type: 'wake', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
          ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
        }
        return
      }
      case 'error': {
        finding.disposition = 'wake_watchdog（外部窗格报错，需认知排障）'
        ops.push({ type: 'wake', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
        ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
        return
      }
      case 'blocked': {
        if (pendingAskCount > 0) {
          // Herdr 审批桥已持有待答 Ask：沿用，绝不复制终端按键审批。
          finding.disposition = 'notify_only（沿用 Herdr 审批桥）'
          ops.push({ type: 'notify', finding, refractoryMs: Number.POSITIVE_INFINITY })
          return
        }
        finding.disposition = 'wake_watchdog（外部阻塞且无审批，需认知排障）'
        ops.push({ type: 'wake', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
        ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
        return
      }
      default: {
        // working 等常态：只读诊断；超长无翻转仅一次性告知，不唤醒不中止。
        if (stalledMs !== undefined && cfg.abortAfterMs > 0 && stalledMs >= cfg.abortAfterMs) {
          finding.disposition =
            'notify_only（外部 stalledBasis=since-last-state-change，不作自动中止证据）'
          ops.push({
            type: 'notify',
            finding,
            refractoryMs: seq !== undefined ? Number.POSITIVE_INFINITY : EXTERNAL_REFRACTORY_MS,
          })
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // 动作执行：notify / abort / bridge / wake
  // ---------------------------------------------------------------------------

  async function executeOps(tickAt: number, shuttingDown: boolean, findings: Finding[], ops: PlannedOp[]): Promise<void> {
    // 1) 通知（各自独立去重）。
    for (const op of ops) {
      if (op.type !== 'notify') continue
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      if (!shouldFire(op.finding.key, 'notify', seq, op.refractoryMs)) continue
      markFired(op.finding.key, 'notify', seq)
      notify(
        op.finding.status === 'error' || op.finding.status === 'unreachable' ? 'error' : 'warning',
        'Watchdog 巡检告警',
        `${op.finding.evidence}；处置：${op.finding.disposition}`,
        op.finding.conversationId,
      )
    }

    // 2) 自动中止（0-Token；去重标记在守卫通过后由 autoAbort 写入，失败守卫不消耗水位）。
    for (const op of ops) {
      if (op.type !== 'abort') continue
      const finding = op.finding
      const seq = finding.stateChangeSeq ?? SENTINEL_SEQ
      if (!shouldFire(finding.key, 'abort', seq, Number.POSITIVE_INFINITY)) continue
      if (closing || shuttingDown) continue
      fireAndForget('watchdog:auto-abort', () => autoAbort(finding))
    }

    // 3) bridge_to_ask（原生 owned 阻塞且无待答 Ask；去重标记在 Ask 创建成功后写入）。
    for (const op of ops) {
      if (op.type !== 'bridge') continue
      const finding = op.finding
      const seq = finding.stateChangeSeq
      if (seq === undefined) continue // classify 已保证存在，双保险
      if (inFlightBridges.has(finding.key)) continue
      if (!shouldFire(finding.key, 'bridge', seq, Number.POSITIVE_INFINITY)) continue
      if (closing || shuttingDown) continue
      fireAndForget('watchdog:bridge-ask', () => bridgeToAsk(finding))
    }

    // 4) L2 唤醒：仅当 due 异常实际投递成功后才消耗 wake 水位；提交被拒绝
    //    （未就绪/关闭/submit 失败）不标记，下一 tick 可重试；提示词只含 due 异常，
    //    不携带同 tick 大量正常事实（防真异常被截断）；单次提交仅 track 一次。
    const wakeOps = ops.filter((op): op is Extract<PlannedOp, { type: 'wake' }> => op.type === 'wake')
    const dueWakes = wakeOps.filter((op) => {
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      return !inFlightWakes.has(`${op.finding.key}:${seq}`) && shouldFire(op.finding.key, 'wake', seq, op.refractoryMs)
    })
    if (dueWakes.length === 0) return
    const watchdogConvId = runtime.getWatchdogConversationId()
    if (watchdogConvId === undefined) {
      notify('warning', 'Watchdog 会话未就绪', '存在需认知排障的异常，但巡检会话尚未初始化，本轮仅记录事实')
      return
    }
    if (closing || shuttingDown) return
    const wakeKeys = dueWakes.map((op) => {
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      return `${op.finding.key}:${seq}`
    })
    for (const key of wakeKeys) inFlightWakes.add(key)
    fireAndForget('watchdog:wake-l2', async () => {
      try {
        if (closing || deps.isClosing()) return
        const valid = dueWakes.filter((op) => {
          const finding = op.finding
          if (finding.targetKind === 'external') return finding.stateChangeSeq !== undefined && finding.ownedBy !== 'human'
          const id = finding.conversationId
          if (id === undefined) return false
          try {
            return deps.getConversationOwnership(id) !== 'human' && ctx.host.getConversation(id).stateChangeSeq === finding.stateChangeSeq
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') return false
            throw error
          }
        })
        if (valid.length === 0) return
        await ctx.host.submitInput(watchdogConvId, buildWakePrompt(valid.map((op) => op.finding)), {
          origin: 'agent',
          whenBusy: 'followUp',
          meta: { renderer: 'superagent:watchdog-alert', tickAt },
        })
        // 提交被接受后才写去重标记（提交失败不消耗水位，下一 tick 重试）。
        for (const op of valid) {
          markFired(op.finding.key, 'wake', op.finding.stateChangeSeq ?? SENTINEL_SEQ)
        }
      } finally {
        for (const key of wakeKeys) inFlightWakes.delete(key)
      }
    })
  }

  /** L2 提示词：事实 JSON 转义防逃逸 + 排障手册指引 + 归属红线重申（全量事实，不截断）。 */
  function buildWakePrompt(findings: Finding[]): string {
    const factsJson = JSON.stringify(
      findings.map((f) => ({
        target: f.targetKind === 'external' ? `external:${f.nodeId}/${f.targetId}` : `conversation:${f.conversationId}`,
        ownedBy: f.ownedBy,
        status: f.status,
        ...(f.stateChangeSeq !== undefined ? { stateChangeSeq: f.stateChangeSeq } : {}),
        ...(f.stalledMs !== undefined ? { stalledMs: Math.round(f.stalledMs) } : {}),
        ...(f.consecutiveErrors !== undefined ? { consecutiveErrors: f.consecutiveErrors } : {}),
        ...(f.pendingAskCount !== undefined ? { pendingAskCount: f.pendingAskCount } : {}),
        ...(f.parentConversationId !== undefined ? { parentConversationId: f.parentConversationId } : {}),
        evidence: f.evidence,
        autoDisposition: f.disposition,
      })),
    )
    return [
      'Watchdog 巡检告警：以下是本轮自动巡检发现的异常事实（0-Token 层处置见 autoDisposition）。',
      '处置铁律：',
      '1) 仅允许对 ownedBy=helm/bot 且 targetKind=conversation 的目标使用 watchdog_recover / watchdog_abort；执行层会再次现查归属，human 归属一律拒绝。',
      '2) ownedBy=human 会话与一切外部终端窗格（targetKind=external）绝对只读：只能 watchdog_inspect 诊断并通知人类，严禁任何按键、恢复注入或直接中止。',
      '3) 中止外部窗格只能先核对 facts.parentConversationId 指向的 owned 原生工作会话，再对该会话 watchdog_abort，由 Herdr 原取消链清理。',
      '4) 外部探针 stalledBasis=since-last-state-change：stalledMs 只是状态翻转间隔，不是工作停滞证据，不得据此中止。',
      '5) 先用 load_skill(skillId="watchdog-playbooks", path="references/<手册>.md") 加载排障手册再决策；无对应手册时保守通知人类。',
      '<findings>',
      escapeXml(deps.redact(factsJson)),
      '</findings>',
    ].join('\n')
  }

  /**
   * 0-Token 自动中止：守卫全部通过后才写去重标记（守卫失败不消耗水位），
   * 执行前现查归属与在途状态——探针事实可能已过期（human 接管/已结束/
   * 已删除都如实降级为限频通知）。
   */
  async function autoAbort(finding: Finding): Promise<void> {
    const conversationId = finding.conversationId
    if (conversationId === undefined) return
    const seq = finding.stateChangeSeq ?? SENTINEL_SEQ
    const giveUp = (level: 'warning' | 'info', title: string, detail: string): void => {
      // 放弃型通知限频（同一水位 1 小时内不重复），避免每 tick 刷屏。
      if (!shouldFire(finding.key, 'notify', seq, EXTERNAL_REFRACTORY_MS)) return
      markFired(finding.key, 'notify', seq)
      notify(level, title, detail, conversationId)
    }
    // 异步任务在真正操作前再查关闭状态：排队期间内核可能已开始关闭。
    if (closing || deps.isClosing()) {
      giveUp('info', 'Watchdog 跳过自动中止', '内核/插件正在关闭，不再执行自动中止')
      return
    }
    if (deps.getConversationOwnership(conversationId) === 'human') {
      giveUp('warning', 'Watchdog 放弃自动中止', `${finding.evidence}；执行前归属已变为 human，仅通知`)
      return
    }
    if (isProtectedTarget(conversationId)) {
      giveUp('warning', 'Watchdog 放弃自动中止', `会话 ${conversationId} 受保护，仅通知`)
      return
    }
    let current
    try {
      current = ctx.host.getConversation(conversationId)
    } catch (err) {
      giveUp('warning', 'Watchdog 放弃自动中止', `${finding.evidence}；目标会话已不可读：${describeError(err)}`)
      return
    }
    if (current.status !== 'working' && current.status !== 'blocked' && current.status !== 'error') {
      // 已完成/空闲的会话不再伪造中止。
      giveUp('info', 'Watchdog 跳过自动中止', `${finding.evidence}；当前状态 ${current.status} 无在途回合`)
      return
    }
    // 现查权威水位：探针 seq 已过期意味着这是新回合/新事件，旧授权不得中止新回合。
    if (finding.stateChangeSeq !== undefined && current.stateChangeSeq !== finding.stateChangeSeq) {
      giveUp(
        'info',
        'Watchdog 跳过自动中止',
        `${finding.evidence}；探针水位 ${finding.stateChangeSeq} 已过期（现查 ${current.stateChangeSeq}），不中止新回合`,
      )
      return
    }
    markFired(finding.key, 'abort', seq)
    try {
      await deps.abortConversation(conversationId)
    } catch (err) {
      // 中止失败：撤销消费标记（与 bridge 失败语义一致），下一 tick 可重试；
      // 如实通知失败原因，绝不记成功。
      unmarkFired(finding.key, 'abort')
      notify(
        'error',
        'Watchdog 自动中止失败',
        `${finding.evidence}；abort 调用失败：${describeError(err)}；已撤销去重标记，下一轮巡检可重试`,
        conversationId,
      )
      return
    }
    notify('error', 'Watchdog 已自动中止超时会话', `${finding.evidence}；已调用 abort，请人工复核`, conversationId)
  }

  /**
   * bridge_to_ask：仅原生 owned 且尚无 pending Ask 的阻塞。
   * - 创建前现查归属/状态/水位（水位仍等于探针值才创建，防陈旧探针）；
   * - Ask 不填 expectedStateSeq：原生干预授权没有终端 CAS 语义（外部终端 CAS
   *   由 Herdr 审批桥完整负责），填错水位会让所有授权失效；
   * - 等待终态不阻塞 tick（runtime.track 计入 liveTasks）；结算后现查归属、
   *   仍 blocked、completionSeq 未变（Ask 自身会推进 stateChangeSeq，机械比对
   *   创建前后的 stateChangeSeq 会误杀一切授权），再执行恢复/中止；
   * - 预分配确定性 askId：跨重启重试撞 ask_id_conflict 视为已桥接（不重复 Ask）。
   */

  /** bridge 阶段性放弃的限频通知（同一水位 1 小时内不重复；只占 notify 坑，不占 bridge 坑）。 */
  function giveUpBridge(finding: Finding, reason: string): void {
    const seq = finding.stateChangeSeq ?? SENTINEL_SEQ
    if (!shouldFire(finding.key, 'notify', seq, EXTERNAL_REFRACTORY_MS)) return
    markFired(finding.key, 'notify', seq)
    notify('warning', 'Watchdog 放弃授权问询', `${finding.evidence}；${reason}`, finding.conversationId)
  }

  async function bridgeToAsk(finding: Finding): Promise<void> {
    const conversationId = finding.conversationId
    if (conversationId === undefined) return
    const seq = finding.stateChangeSeq
    if (seq === undefined) return
    const guardKey = finding.key
    const askId = `superagent-watchdog-bridge-${conversationId}-${seq}`

    // 异步任务在真正操作前再查关闭状态：排队期间内核可能已开始关闭。
    if (closing || deps.isClosing()) return
    if (isProtectedTarget(conversationId)) {
      giveUpBridge(finding, '常驻入口受保护，仅通知')
      return
    }
    if (deps.getConversationOwnership(conversationId) === 'human') {
      giveUpBridge(finding, '创建前归属已变为 human，仅通知')
      return
    }
    let current
    try {
      current = ctx.host.getConversation(conversationId)
    } catch (err) {
      giveUpBridge(finding, `目标会话已不可读：${describeError(err)}`)
      return
    }
    if (current.stateChangeSeq !== seq || current.status !== 'blocked' || current.pendingAskCount > 0) {
      // 探针已过期：下一 tick 会按新事实重新分类，本轮不创建（限频告知）。
      if (shouldFire(guardKey, 'notify', seq, EXTERNAL_REFRACTORY_MS)) {
        markFired(guardKey, 'notify', seq)
        notify(
          'info',
          'Watchdog 跳过授权问询',
          `${finding.evidence}；现查状态 ${current.status}（seq ${current.stateChangeSeq}）与探针不一致`,
          conversationId,
        )
      }
      return
    }
    const completionSeqAtCreation = current.completionSeq

    // createAsk 的 Promise 到终态才结算（创建校验/落盘在首个 await 前同步完成）：
    // 先受理请求并占坑（liveTasks 可见、stop 可取消），创建/等待失败时在 catch
    // 中撤销去重标记——不把失败记成功，也不永久丢失重试。
    let settled: AskResult
    try {
      const created = ctx.host.createAsk({
        id: askId,
        conversationId,
        ownerPluginId: ctx.pluginId,
        title: `Watchdog：后台会话 #${conversationId} 阻塞待授权`,
        description: deps.redact(
          `${finding.evidence}；doing=${String(current.doing ?? '')}。授权后 Watchdog 将按选择执行恢复注入或中止。`,
        ),
        fields: [
          {
            name: 'decision',
            label: '处置方式',
            type: 'select',
            required: true,
            options: [
              { label: '注入恢复提示（以 agent 来源向该会话提交提示）', value: 'recover' },
              { label: '中止该后台会话', value: 'abort' },
              { label: '暂不处理（仅保留本告警）', value: 'dismiss' },
            ],
          },
        ],
      })
      markFired(guardKey, 'bridge', seq)
      inFlightBridges.set(guardKey, askId)
      settled = await created
    } catch (err) {
      inFlightBridges.delete(guardKey)
      if (err instanceof HelmError && err.code === 'ask_id_conflict') {
        // 同 ID 已存在（含已结算）：视为已桥接，占坑防重复创建。
        markFired(guardKey, 'bridge', seq)
        return
      }
      // 创建/等待失败：撤销 bridge 意图（不消耗水位），显式告知，下一 tick 可重试。
      unmarkFired(guardKey, 'bridge')
      notify(
        'error',
        'Watchdog 授权问询失败',
        `${finding.evidence}；Ask ${askId} 创建/等待失败：${describeError(err)}；已撤销去重标记，下一轮巡检可重试`,
        conversationId,
      )
      return
    }
    try {
      if (closing) return // 停止中：不再发起新的自动处置（cancelAsk 会结算该 Ask）
      applyBridgeAnswer(finding, conversationId, completionSeqAtCreation, settled, askId)
    } finally {
      inFlightBridges.delete(guardKey)
    }
  }

  function applyBridgeAnswer(
    finding: Finding,
    conversationId: number,
    completionSeqAtCreation: number,
    result: { status: string; answers: Record<string, string> },
    askId: string,
  ): void {
    if (result.status !== 'answered') {
      notify('info', 'Watchdog 授权未获批', `${finding.evidence}；Ask ${askId} 终态 ${result.status}，不执行变更`, conversationId)
      return
    }
    const decision = result.answers['decision']
    if (decision !== 'recover' && decision !== 'abort') {
      notify('info', 'Watchdog 授权结果为暂不处理', `${finding.evidence}；decision=${decision}`, conversationId)
      return
    }
    // 结算后现查：归属仍 owned、仍 blocked、本回合未结算（completionSeq 未变）。
    // 关闭中不执行任何变更（stop 已取消/将取消在途 Ask）。
    if (closing || deps.isClosing()) {
      notify('info', 'Watchdog 放弃执行授权', '内核/插件正在关闭，不执行授权变更', conversationId)
      return
    }
    if (isProtectedTarget(conversationId)) {
      notify('warning', 'Watchdog 放弃执行授权', '常驻入口受保护，不执行授权变更', conversationId)
      return
    }
    if (deps.getConversationOwnership(conversationId) === 'human') {
      notify('warning', 'Watchdog 放弃执行授权', `${finding.evidence}；授权后归属已变为 human，仅通知`, conversationId)
      return
    }
    let current
    try {
      current = ctx.host.getConversation(conversationId)
    } catch (err) {
      notify('warning', 'Watchdog 放弃执行授权', `${finding.evidence}；目标会话已不可读：${describeError(err)}`, conversationId)
      return
    }
    if (current.status !== 'blocked' || current.completionSeq !== completionSeqAtCreation) {
      notify(
        'info',
        'Watchdog 放弃执行授权',
        `${finding.evidence}；授权期间目标已变化（状态 ${current.status}，completionSeq ${current.completionSeq}），不执行变更`,
        conversationId,
      )
      return
    }
    if (decision === 'recover') {
      void runtime
        .track('watchdog:bridge-recover', () =>
          ctx.host.submitInput(
            conversationId,
            'Watchdog 恢复提示：上轮回合疑似阻塞，请检查在途工具与子代理状态，必要时重试或如实报告失败。',
            { origin: 'agent', whenBusy: 'steer' },
          ),
        )
        .then(() => {
          notify('info', 'Watchdog 已注入恢复提示', `${finding.evidence}；已向会话 ${conversationId} 提交 agent 恢复输入`, conversationId)
        })
        .catch((err: unknown) => {
          notify('error', 'Watchdog 恢复提示提交失败', `${finding.evidence}；${describeError(err)}`, conversationId)
        })
      return
    }
    void runtime
      .track('watchdog:bridge-abort', () => deps.abortConversation(conversationId))
      .then(() => {
        notify('error', 'Watchdog 已按授权中止会话', `${finding.evidence}；已中止会话 ${conversationId}`, conversationId)
      })
      .catch((err: unknown) => {
        notify('error', 'Watchdog 授权中止失败', `${finding.evidence}；${describeError(err)}`, conversationId)
      })
  }

  function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  // ---------------------------------------------------------------------------
  // turn_settled：Watchdog 自身 failed/aborted 仅通知（不进自身探针，靠排除 + 此处兜底）
  // ---------------------------------------------------------------------------

  ctx.hook.onTurnSettled(async (payload: TurnSettledPayload) => {
    if (payload.outcome !== 'failed' && payload.outcome !== 'aborted') return
    const conversation = payload.conversation
    if (!isWatchdogSession(conversation.id, conversation.profileId)) return
    if (deps.isClosing()) return // 关闭中大量 abort 结算是预期行为，不告警不自激
    notify(
      payload.outcome === 'failed' ? 'error' : 'warning',
      '巡检看门狗回合异常',
      `Watchdog 会话 #${conversation.id} 回合 ${payload.outcome}${
        payload.error ? `：${payload.error}` : ''
      }；按防自激策略仅通知，不触发自动巡检动作`,
      conversation.id,
    )
  })

  // ---------------------------------------------------------------------------
  // 执行层强守卫：before_turn 白名单 + tool_call 阻断（不依赖 SYSTEM.md）
  // ---------------------------------------------------------------------------

  ctx.hook.onBeforeTurn(async (turn: BeforeTurnHookPayload) => {
    const conversation = turn.conversation
    if (!isWatchdogSession(conversation.id, conversation.profileId)) return // #1 与普通 Bot 不受影响
    const isActualWatchdog = conversation.id === runtime.getWatchdogConversationId()
    const tools = turn.tools.filter((tool) => {
      if (!WATCHDOG_ALLOWED_TOOLS.has(tool.name)) return false
      // 专属工具仅实际 watchdog 会话可得；同 profile 直聊在可见层即被剥离。
      if (WATCHDOG_EXCLUSIVE_TOOLS.has(tool.name) && !isActualWatchdog) return false
      return true
    })
    if (tools.length === turn.tools.length) return
    return { action: 'transform', value: { ...turn, tools } }
  })

  ctx.hook.onToolCall(async (payload) => {
    const conversationId = payload.conversationId
    let profileId: string | undefined
    try {
      profileId = ctx.host.getConversation(conversationId).profileId
    } catch {
      profileId = undefined // 会话已消失：后续执行层自会显式报错，这里不伪造判断
    }
    if (!isWatchdogSession(conversationId, profileId)) return
    if (!WATCHDOG_ALLOWED_TOOLS.has(payload.toolName)) {
      return {
        action: 'block',
        reason: `巡检会话仅允许只读与记忆工具（${[...WATCHDOG_ALLOWED_TOOLS].join(', ')}），已阻断 ${payload.toolName}`,
      }
    }
    if (WATCHDOG_EXCLUSIVE_TOOLS.has(payload.toolName) && conversationId !== runtime.getWatchdogConversationId()) {
      return {
        action: 'block',
        reason: `watchdog 专属工具 ${payload.toolName} 仅限实际巡检会话使用（同 profile 直聊不可用）`,
      }
    }
    return undefined
  })

  // ---------------------------------------------------------------------------
  // 模型工具（ctx.tool 精确短名）+ 同名 ctx.action（HTTP/CLI 五端复用，不 exposeAsTool）
  // ---------------------------------------------------------------------------

  /** 工具路径执行守卫：仅实际 watchdog 会话（防同 profile 直聊与旧调用绕过）。 */
  function assertToolCaller(conversationId: number): void {
    if (conversationId !== runtime.getWatchdogConversationId()) {
      throw new HelmError(
        'watchdog_not_watchdog_session',
        `watchdog 专属工具仅限实际巡检会话调用（当前会话 ${conversationId}）`,
        403,
        { conversationId },
      )
    }
  }

  /** 动作路径守卫：人工 HTTP/CLI（无 conversationId）放行；带会话上下文须为实际 watchdog 会话。 */
  function assertActionCaller(context: { conversationId?: number }): void {
    if (context.conversationId === undefined) return
    assertToolCaller(context.conversationId)
  }

  async function inspectCore(input: WatchdogInspectInput): Promise<Record<string, unknown>> {
    if (input.conversationId !== undefined && input.probe === undefined) {
      return inspectConversation(input.conversationId)
    }
    if (input.probe !== undefined && input.conversationId === undefined) {
      return inspectExternalProbe(input.probe)
    }
    throw new HelmError(
      'validation_error',
      'watchdog_inspect 需要 conversationId（原生会话）或 probe（外部目标）二选一',
      400,
    )
  }

  async function inspectConversation(conversationId: number): Promise<Record<string, unknown>> {
    const summary = ctx.host.getConversation(conversationId) // 不存在显式 not_found
    const detail = await deps.getConversationDetail(conversationId, { limit: 10 })
    const entries = detail.entries.slice(0, 10).map((entry) => ({
      kind: entry.kind,
      createdAt: entry.createdAt,
      preview: deps.redact(truncatePreview(JSON.stringify(entry.model ?? entry.data ?? null))),
    }))
    return {
      kind: 'conversation' as const,
      conversation: {
        id: summary.id,
        profileId: summary.profileId,
        status: summary.status,
        doing: summary.doing ?? null,
        stateChangeSeq: summary.stateChangeSeq,
        completionSeq: summary.completionSeq,
        pendingAskCount: summary.pendingAskCount,
        ownedBy: deps.getConversationOwnership(summary.id), // 现查，非探针旧值
      },
      entries,
    }
  }

  function inspectExternalProbe(probe: { targetKind: string; nodeId?: string; targetId: string }): Record<string, unknown> {
    if (probe.targetKind !== 'external') {
      throw new HelmError('validation_error', 'watchdog_inspect 的 probe 仅支持 targetKind=external（外部目标只读诊断）', 400)
    }
    const nodeId = probe.nodeId ?? 'local'
    const cached = lastExternalProbes.get(targetKey('external', nodeId, probe.targetId))
    if (cached === undefined) {
      throw new HelmError(
        'not_found',
        `最近一轮巡检未观测到外部目标 ${probe.targetId}@${nodeId}（不猜测、不伪造事实）`,
        404,
        { nodeId, targetId: probe.targetId },
      )
    }
    return {
      kind: 'external' as const,
      probe: {
        targetId: cached.targetId,
        nodeId,
        ownedBy: cached.ownedBy,
        status: cached.status,
        ...(cached.stateChangeSeq !== undefined ? { stateChangeSeq: cached.stateChangeSeq } : {}),
        ...(cached.stalledMs !== undefined ? { stalledMs: cached.stalledMs } : {}),
        ...(cached.consecutiveErrors !== undefined ? { consecutiveErrors: cached.consecutiveErrors } : {}),
        facts: redactFacts(cached.facts ?? {}),
      },
    }
  }

  function truncatePreview(text: string): string {
    return text.length > 400 ? `${text.slice(0, 400)}…` : text
  }

  /** facts 深度脱敏：复用 kernel redactJsonValue（覆盖数组/嵌套对象/键名，避免自研遗漏）。 */
  function redactFacts(value: Record<string, unknown>): unknown {
    return redactJsonValue(value, deps.redact)
  }

  async function recoverCore(input: { conversationId: number; hint: string }, label: string): Promise<Record<string, unknown>> {
    assertOwnedTarget(input.conversationId)
    await runtime.track(label, () =>
      ctx.host.submitInput(input.conversationId, input.hint, { origin: 'agent', whenBusy: 'steer' }),
    )
    return { conversationId: input.conversationId, submitted: true }
  }

  async function abortCore(input: { conversationId: number }, label: string): Promise<Record<string, unknown>> {
    assertOwnedTarget(input.conversationId)
    await runtime.track(label, () => deps.abortConversation(input.conversationId))
    notify('warning', 'Watchdog 会话已被手动中止', `会话 ${input.conversationId} 经 watchdog_abort 中止（操作方见审计日志）`, input.conversationId)
    return { conversationId: input.conversationId, aborted: true }
  }

  const inspectSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1, description: '原生目标会话 ID（正整数）' },
      probe: {
        type: 'object',
        properties: {
          targetKind: { type: 'string', enum: ['external'] },
          nodeId: { type: 'string', minLength: 1, description: "外部目标节点 ID（缺省 'local'）" },
          targetId: { type: 'string', minLength: 1 },
        },
        required: ['targetKind', 'targetId'],
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  } as const

  const inspectOutputSchema = {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['conversation', 'external'] },
      conversation: { type: 'object' },
      entries: { type: 'array', items: { type: 'object' } },
      probe: { type: 'object' },
    },
    required: ['kind'],
    additionalProperties: false,
  } as const
  const recoverSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      hint: { type: 'string', minLength: 1, description: '恢复提示文本（以 agent 来源提交给目标会话）' },
    },
    required: ['conversationId', 'hint'],
    additionalProperties: false,
  } as const

  const abortSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      reason: { type: 'string', minLength: 1 },
    },
    required: ['conversationId'],
    additionalProperties: false,
  } as const

  const mutationOutputSchema = {
    type: 'object',
    properties: {
      conversationId: { type: 'integer', minimum: 1 },
      submitted: { type: 'boolean' },
      aborted: { type: 'boolean' },
    },
    required: ['conversationId'],
    additionalProperties: false,
  } as const

  ctx.tool<{ conversationId?: number; probe?: { targetKind: 'external'; nodeId?: string; targetId: string } }>({
    name: WATCHDOG_TOOL_INSPECT,
    description:
      '读取巡检目标真实详情：conversationId 返回原生会话摘要与最近时间线（归属现查）；probe 返回最近一轮外部目标探针事实（只读，不假装控制外部窗格）。',
    inputSchema: inspectSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(context.conversationId)
      return inspectCore(input)
    },
  })

  ctx.tool<{ conversationId: number; hint: string }>({
    name: WATCHDOG_TOOL_RECOVER,
    description: '向 owned（helm/bot）原生会话提交恢复提示（agent 来源，不等待模型回合）；执行前现查归属，human 目标拒绝。',
    inputSchema: recoverSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(context.conversationId)
      return recoverCore(input, `tool:${WATCHDOG_TOOL_RECOVER}:${input.conversationId}`)
    },
  })

  ctx.tool<{ conversationId: number; reason?: string }>({
    name: WATCHDOG_TOOL_ABORT,
    description: '中止 owned（helm/bot）原生会话；执行前现查归属，human/root/中枢/巡检自身拒绝。外部窗格只能经由其 owned 父会话间接中止。',
    inputSchema: abortSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async execute(input, context) {
      assertToolCaller(context.conversationId)
      return abortCore(input, `tool:${WATCHDOG_TOOL_ABORT}:${input.conversationId}`)
    },
  })

  // 同名 ctx.action 复用同一核心：HTTP/CLI 自动映射 `helm superagent watchdog_*`，
  // 人工调用无会话上下文放行（目标所有权守卫照样生效），不 exposeAsTool 防重复工具。
  ctx.action<{ conversationId?: number; probe?: { targetKind: 'external'; nodeId?: string; targetId: string } }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_INSPECT,
    description: '读取巡检目标真实详情（原生会话或最近外部探针事实，只读）',
    idempotent: true,
    inputSchema: inspectSchema,
    outputSchema: inspectOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    handler(input, context) {
      assertActionCaller(context)
      return inspectCore(input)
    },
  })

  ctx.action<{ conversationId: number; hint: string }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_RECOVER,
    description: '向 owned 原生会话提交恢复提示（agent 来源，不等待模型回合）',
    inputSchema: recoverSchema,
    outputSchema: mutationOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async handler(input, context) {
      assertActionCaller(context)
      return recoverCore(input, `action:${WATCHDOG_TOOL_RECOVER}:${input.conversationId}`)
    },
  })

  ctx.action<{ conversationId: number; reason?: string }, Record<string, unknown>>({
    id: WATCHDOG_TOOL_ABORT,
    description: '中止 owned 原生会话（human/root/中枢/巡检自身拒绝）',
    inputSchema: abortSchema,
    outputSchema: mutationOutputSchema,
    scope: { profileIds: [WATCHDOG_PROFILE_ID] },
    async handler(input, context) {
      assertActionCaller(context)
      return abortCore(input, `action:${WATCHDOG_TOOL_ABORT}:${input.conversationId}`)
    },
  })

  // ---------------------------------------------------------------------------
  // ctx.service：stop 取消自有 pending Ask（close 不无边界等待；停用后不写旧 Doc）
  // ---------------------------------------------------------------------------

  ctx.service({
    id: 'superagent-watchdog',
    start() {
      closing = false
    },
    async stop() {
      closing = true
      // 逐个 await 取消（非 allSettled 吞错）：已结算/不存在的 Ask 属事实性状态
      // 可忽略；其余失败聚合为显式错误上抛（PluginHost 聚合为 plugin_service_stop_failed）。
      const failures: Array<{ askId: string; error: unknown }> = []
      for (const askId of [...inFlightBridges.values()]) {
        try {
          await ctx.host.cancelAsk(askId, 'cancelled')
        } catch (err) {
          if (err instanceof HelmError && (err.code === 'ask_already_settled' || err.code === 'not_found')) {
            continue // 已结算/已清理：事实性终态，非故障
          }
          failures.push({ askId, error: err })
        }
      }
      if (failures.length > 0) {
        throw new HelmError(
          'watchdog_ask_cancel_failed',
          `Watchdog 停用前取消挂起授权问询失败：${failures.map((f) => `${f.askId}（${f.error instanceof Error ? f.error.message : String(f.error)}）`).join('；')}`,
          500,
          { failures },
        )
      }
    },
    liveTasks() {
      // 挂起的人类授权 Ask 是在途任务：停用/卸载前 PluginHost 据此 409 拒绝，
      // 避免吞掉待答审批；close() 路径则由 stop 主动取消。
      return [...inFlightBridges.entries()].map(([key, askId]) => `bridge-ask:${askId}(${key})`)
    },
  })
}

// ---------------------------------------------------------------------------
// 工具入参类型（Schema 与此处保持同步；导出供主插件/测试引用）
// ---------------------------------------------------------------------------

export interface WatchdogInspectInput {
  conversationId?: number
  probe?: { targetKind: 'external'; nodeId?: string; targetId: string }
}

export interface WatchdogRecoverInput {
  conversationId: number
  hint: string
}

export interface WatchdogAbortInput {
  conversationId: number
  reason?: string
}
