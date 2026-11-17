/**
 * builtin:superagent Watchdog 规则评估（原 watchdog_tick 处理器主体：只读分类，
 * 动作另行由 watchdog-ops 执行）。
 *
 * classifyNative 与 classifyExternal 的规则瀑布共享约六成判定（seq 缺失 →
 * notify_only、human → 只读、blocked+已有待答 Ask → 沿用审批、error → wake、
 * stalled 级联），共同决策下沉为本模块的规则原语（planSeqMissing /
 * planHumanReadOnly / planBlockedWithPendingAsk / planWake）；两个分类器只保留
 * 各自差异分支（原生 owned blocked → bridge、stalled → abort/wake；外部
 * stalled 只通知不中止等——判定规则与阈值与拆分前逐行等价）。
 */

import type { DiagnosticsCollection, WatchdogProbe } from '../diagnostics.js'
import type { SuperAgentWatchdogRuntime } from './contracts.js'
import type { WatchdogDedupStore } from './watchdog-dedup.js'
import { collectActiveExternalKeys } from './watchdog-dedup.js'
import {
  asNonNegativeFinite,
  asNonNegativeInt,
  EXTERNAL_REFRACTORY_MS,
  targetKey,
  WATCHDOG_PROFILE_ID,
  WORKFLOW_RESUME_BACKOFF_MS,
  WORKFLOW_RESUME_MAX_COUNT,
  type Finding,
  type PlannedOp,
} from './watchdog-core.js'

/** 确定性规则表的阈值配置（SuperAgentConfig 子集）。 */
interface WatchdogRuleConfig {
  stalledAfterMs: number
  abortAfterMs: number
  errorThreshold: number
}

interface WatchdogClassifierDeps {
  runtime: SuperAgentWatchdogRuntime
  dedup: WatchdogDedupStore
  /** 最近一轮外部探针事实缓存（inspect 只读诊断共用；键与去重键同构）。 */
  externalProbes: Map<string, WatchdogProbe>
  /** closing 或宿主关闭时跳过评估（保持原 tick 处理器守卫语义）。 */
  isInactive(): boolean
  executeOps(tickAt: number, findings: Finding[], ops: PlannedOp[]): Promise<void>
}

/**
 * 单轮规则表评估：去重文档读入校验（损坏显式上抛）→ 历史键安全淘汰 →
 * 防自激排除（watchdog 自身 id 与一切 profileId=watchdog 会话）→ 逐探针
 * 分类（native/external/workflow_run）→ 动作执行。
 */
export async function evaluateCollection(deps: WatchdogClassifierDeps, payload: DiagnosticsCollection): Promise<void> {
  const cfg = deps.runtime.getConfig()
  if (!cfg.watchdogEnabled || deps.isInactive()) return
  deps.dedup.read()
  // 历史键安全淘汰（已删会话 / 超限外部目标）：防 7×24 无限膨胀。
  deps.dedup.evictStaleTargets(collectActiveExternalKeys(payload.probes))

  // 防自激：排除 watchdog 自身 id 与一切 profileId=watchdog 的会话（含直聊）。
  const watchdogIds = new Set<number>()
  const watchdogId = deps.runtime.getWatchdogConversationId()
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
      classifyExternal(deps, probe, watchdogIds, cfg, findings, ops)
    } else {
      classifyNative(probe, watchdogIds, cfg, findings, ops)
    }
  }

  await deps.executeOps(payload.timestamp, findings, ops)
}

// ---------------------------------------------------------------------------
// 共同决策原语（native / external / workflow_run 规则瀑布的公共段）
// ---------------------------------------------------------------------------

/** 归一化探针事实（分类器共用的决策输入；来源字段严格校验，非法即缺省）。 */
interface NormalizedFacts {
  seq: number | undefined
  stalledMs: number | undefined
  errors: number
  pendingAskCount: number
}

function normalizeFacts(probe: WatchdogProbe): NormalizedFacts {
  return {
    seq: asNonNegativeInt(probe.stateChangeSeq),
    stalledMs: asNonNegativeFinite(probe.stalledMs),
    errors: asNonNegativeInt(probe.consecutiveErrors) ?? 0,
    pendingAskCount: asNonNegativeInt(probe.facts?.['pendingAskCount']) ?? 0,
  }
}

/**
 * 共同守卫①（三处共用）：权威 seq 缺失 → 不可防重，绝不执行变更类动作，
 * 只读通知（同文案同节流）。
 */
function planSeqMissing(finding: Finding, ops: PlannedOp[]): void {
  finding.disposition = 'notify_only（缺权威 seq，只读）'
  ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
}

/**
 * 共同守卫②：human 归属永远只读/通知（触发条件、文案与节流由目标类别策略
 * 给出）；未命中触发条件时静默——不为纯 human 异常唤醒执行模型。
 */
interface HumanReadOnlyPolicy {
  triggers(facts: NormalizedFacts, status: string, cfg: WatchdogRuleConfig): boolean
  disposition: string
  refractoryMs: number
}

function planHumanReadOnly(
  finding: Finding,
  facts: NormalizedFacts,
  policy: HumanReadOnlyPolicy,
  cfg: WatchdogRuleConfig,
  ops: PlannedOp[],
): void {
  if (policy.triggers(facts, finding.status, cfg)) {
    finding.disposition = policy.disposition
    ops.push({ type: 'notify', finding, refractoryMs: policy.refractoryMs })
  }
}

/** 共同守卫③：blocked 且已有待答 Ask → 沿用既有审批通道，绝不复制审批。 */
function planBlockedWithPendingAsk(finding: Finding, disposition: string, ops: PlannedOp[]): void {
  finding.disposition = disposition
  ops.push({ type: 'notify', finding, refractoryMs: Number.POSITIVE_INFINITY })
}

/** wake 计划原语（可选附带同节流通知；wake 先入队，与原顺序一致）。 */
function planWake(
  finding: Finding,
  ops: PlannedOp[],
  disposition: string,
  wakeRefractoryMs: number,
  notifyRefractoryMs?: number,
): void {
  finding.disposition = disposition
  ops.push({ type: 'wake', finding, refractoryMs: wakeRefractoryMs })
  if (notifyRefractoryMs !== undefined) {
    ops.push({ type: 'notify', finding, refractoryMs: notifyRefractoryMs })
  }
}

// ---------------------------------------------------------------------------
// 原生会话探针（targetKind=conversation）
// ---------------------------------------------------------------------------

/** 原生 human 只读策略：blocked / error / 停滞达唤醒阈值时一次性告知。 */
const NATIVE_HUMAN_POLICY: HumanReadOnlyPolicy = {
  triggers: (facts, status, cfg) =>
    status === 'blocked' || status === 'error' || (facts.stalledMs !== undefined && facts.stalledMs >= cfg.stalledAfterMs),
  disposition: 'notify_only（human 归属只读红线）',
  refractoryMs: Number.POSITIVE_INFINITY,
}

function classifyNative(
  probe: WatchdogProbe,
  watchdogIds: Set<number>,
  cfg: WatchdogRuleConfig,
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

  const facts = normalizeFacts(probe)
  const finding: Finding = {
    key: targetKey('conversation', undefined, String(conversationId)),
    targetKind: 'conversation',
    targetId: probe.targetId,
    conversationId,
    ownedBy: probe.ownedBy,
    status: probe.status,
    ...(facts.seq !== undefined ? { stateChangeSeq: facts.seq } : {}),
    ...(facts.stalledMs !== undefined ? { stalledMs: facts.stalledMs } : {}),
    ...(facts.errors > 0 ? { consecutiveErrors: facts.errors } : {}),
    pendingAskCount: facts.pendingAskCount,
    evidence: `原生会话 #${conversationId} 状态 ${probe.status}${
      facts.stalledMs !== undefined ? `，停滞 ${Math.round(facts.stalledMs / 1000)}s` : ''
    }${facts.errors > 0 ? `，连续错误 ${facts.errors} 次` : ''}`,
    disposition: '',
  }
  findings.push(finding)

  // ---- 共同守卫：seq 缺失只读；human 归属只读。 ----
  if (facts.seq === undefined) {
    planSeqMissing(finding, ops)
    return
  }
  if (probe.ownedBy === 'human') {
    planHumanReadOnly(finding, facts, NATIVE_HUMAN_POLICY, cfg, ops)
    return
  }

  // ---- owned（helm/bot）确定性规则表（原生差异分支）。 ----
  if (probe.status === 'blocked') {
    if (facts.pendingAskCount > 0) {
      planBlockedWithPendingAsk(finding, 'notify_only（已有待答 Ask，沿用既有审批）', ops)
    } else {
      finding.disposition = 'bridge_to_ask（创建恢复/中止确认 Ask）'
      ops.push({ type: 'bridge', finding })
    }
    return
  }
  if (probe.status === 'error' || (cfg.errorThreshold > 0 && facts.errors >= cfg.errorThreshold)) {
    // 持续 error 交认知层判断（错误不等于停滞，不自动中止）。
    planWake(finding, ops, 'wake_watchdog（持续错误，需认知排障）', Number.POSITIVE_INFINITY)
    return
  }
  if (facts.stalledMs !== undefined && cfg.abortAfterMs > 0 && facts.stalledMs >= cfg.abortAfterMs) {
    finding.disposition = 'auto_abort_and_notify（超长停滞，自动中止）'
    ops.push({ type: 'abort', finding })
    ops.push({ type: 'wake', finding, refractoryMs: Number.POSITIVE_INFINITY })
    return
  }
  if (facts.stalledMs !== undefined && cfg.stalledAfterMs > 0 && facts.stalledMs >= cfg.stalledAfterMs) {
    planWake(finding, ops, 'wake_watchdog（停滞达到唤醒阈值）', Number.POSITIVE_INFINITY)
  }
}

// ---------------------------------------------------------------------------
// 外部探针（targetKind=external，如 Herdr 终端窗格）
// ---------------------------------------------------------------------------

/** 外部 human 只读策略：blocked / error / unreachable 时限频告知。 */
const EXTERNAL_HUMAN_POLICY: HumanReadOnlyPolicy = {
  triggers: (_facts, status) => status === 'blocked' || status === 'error' || status === 'unreachable',
  disposition: 'notify_only（human 归属外部窗格只读）',
  refractoryMs: EXTERNAL_REFRACTORY_MS,
}

function classifyExternal(
  deps: WatchdogClassifierDeps,
  probe: WatchdogProbe,
  watchdogIds: Set<number>,
  cfg: WatchdogRuleConfig,
  findings: Finding[],
  ops: PlannedOp[],
): void {
  const nodeId = probe.nodeId ?? 'local'
  const key = targetKey('external', nodeId, probe.targetId)
  deps.externalProbes.set(targetKey('external', nodeId, probe.targetId), probe)
  const facts = normalizeFacts(probe)
  const seq = facts.seq

  // 由 watchdog 会话派生的窗格同样排除，防自激。
  const parent = asNonNegativeInt(probe.facts?.['parentConversationId'])
  if (parent !== undefined && watchdogIds.has(parent)) return

  // workflow_run 失败探针（builtin:workflow 采集）：走确定性 0-Token 断点
  // 续跑链路，不进通用外部状态规则（error 直接唤醒 L2 会绕过冷却与限流）。
  if (probe.facts?.['kind'] === 'workflow_run') {
    classifyWorkflowRun(probe, key, seq, findings, ops)
    return
  }

  const finding: Finding = {
    key,
    targetKind: 'external',
    nodeId,
    targetId: probe.targetId,
    ownedBy: probe.ownedBy,
    status: probe.status,
    ...(seq !== undefined ? { stateChangeSeq: seq } : {}),
    ...(facts.stalledMs !== undefined ? { stalledMs: facts.stalledMs } : {}),
    ...(facts.errors > 0 ? { consecutiveErrors: facts.errors } : {}),
    pendingAskCount: facts.pendingAskCount,
    ...(parent !== undefined ? { parentConversationId: parent } : {}),
    evidence: `外部窗格 ${probe.targetId}@${nodeId} 状态 ${probe.status}${
      facts.errors > 0 ? `，连续不可达 ${facts.errors} 次` : ''
    }${facts.pendingAskCount > 0 ? `，待答审批 ${facts.pendingAskCount}` : ''}`,
    disposition: '',
  }
  findings.push(finding)

  // ---- 共同守卫：seq 缺失只读；human 归属只读。 ----
  if (seq === undefined) {
    planSeqMissing(finding, ops)
    return
  }
  if (probe.ownedBy === 'human') {
    planHumanReadOnly(finding, facts, EXTERNAL_HUMAN_POLICY, cfg, ops)
    return
  }

  // ---- 外部事实口径差异分支：stalledMs 基于「上次状态翻转」，不含 working
  // 内部活动——绝不能单独作为自动中止/高频唤醒证据（Herdr state_change_seq
  // 只记翻转）。 ----
  switch (probe.status) {
    case 'unreachable': {
      // 连续不可达 = 明确失败证据（非停滞时长），达阈值交认知层 + 通知。
      if (cfg.errorThreshold > 0 && facts.errors >= cfg.errorThreshold) {
        planWake(
          finding,
          ops,
          'wake_watchdog（外部窗格连续不可达，需认知排障）',
          EXTERNAL_REFRACTORY_MS,
          EXTERNAL_REFRACTORY_MS,
        )
      }
      return
    }
    case 'error': {
      planWake(
        finding,
        ops,
        'wake_watchdog（外部窗格报错，需认知排障）',
        EXTERNAL_REFRACTORY_MS,
        EXTERNAL_REFRACTORY_MS,
      )
      return
    }
    case 'blocked': {
      if (facts.pendingAskCount > 0) {
        // Herdr 审批桥已持有待答 Ask：沿用，绝不复制终端按键审批。
        planBlockedWithPendingAsk(finding, 'notify_only（沿用 Herdr 审批桥）', ops)
        return
      }
      planWake(
        finding,
        ops,
        'wake_watchdog（外部阻塞且无审批，需认知排障）',
        EXTERNAL_REFRACTORY_MS,
        EXTERNAL_REFRACTORY_MS,
      )
      return
    }
    default: {
      // working 等常态：只读诊断；超长无翻转仅一次性告知，不唤醒不中止。
      if (facts.stalledMs !== undefined && cfg.abortAfterMs > 0 && facts.stalledMs >= cfg.abortAfterMs) {
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

/**
 * workflow_run 失败探针分类（§3.2 断点续跑）：
 * - 事实严格校验（kind/runId/conversationId/failedAt/autoResumeCount），
 *   残缺只读告知，绝不猜造；
 * - 严格仅 helm 归属后台探针（human/bot 一律不自动续跑）；
 * - 冷却退避：autoResumeCount 0/1/2 → 2/5/15 分钟；未满冷却不产生任何
 *   动作（每 15s tick 通知会刷屏）；
 * - autoResumeCount 达上限后交人类（限频告知）；
 * - 防重不占本地去重坑：依赖探针侧 resumedByRunId（续跑按档的旧 Run 不
 *   再上报）与 stateChangeSeq=autoResumeCount（新失败 Run 携带新水位）
 *   机制；执行层仅加内存 in-flight 与失败重试推迟（见 executeOps）。
 */
function classifyWorkflowRun(
  probe: WatchdogProbe,
  key: string,
  seq: number | undefined,
  findings: Finding[],
  ops: PlannedOp[],
): void {
  const facts = probe.facts ?? {}
  const runId =
    typeof facts['runId'] === 'string' && facts['runId'].length > 0 ? facts['runId'] : undefined
  const conversationIdRaw = asNonNegativeInt(facts['conversationId'])
  const failedAt =
    typeof facts['failedAt'] === 'number' && Number.isFinite(facts['failedAt'])
      ? facts['failedAt']
      : undefined
  const autoResumeCount = asNonNegativeInt(facts['autoResumeCount'])

  const finding: Finding = {
    key,
    targetKind: 'external',
    nodeId: probe.nodeId ?? 'local',
    targetId: probe.targetId,
    ownedBy: probe.ownedBy,
    status: probe.status,
    ...(seq !== undefined ? { stateChangeSeq: seq } : {}),
    evidence: `外部工作流探针 ${probe.targetId}@${probe.nodeId ?? 'local'} 状态 ${probe.status}`,
    disposition: '',
  }
  findings.push(finding)

  if (runId === undefined || conversationIdRaw === undefined || conversationIdRaw <= 0 || failedAt === undefined || autoResumeCount === undefined) {
    finding.disposition = 'notify_only（workflow_run 事实残缺，不猜测）'
    ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
    return
  }
  const conversationId = conversationIdRaw
  finding.conversationId = conversationId
  finding.workflowRun = { runId, conversationId, failedAt, autoResumeCount }
  finding.evidence = `失败工作流 run ${runId}（会话 ${conversationId}）failedAt=${new Date(failedAt).toISOString()}，已自动续跑 ${autoResumeCount} 次`

  if (seq === undefined) {
    planSeqMissing(finding, ops)
    return
  }
  if (probe.ownedBy !== 'helm') {
    // 严格仅 helm 归属后台探针：human/bot（含缺省未知）一律不自动续跑。
    finding.disposition = 'notify_only（非 helm 归属，拒绝自动续跑）'
    ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
    return
  }
  if (autoResumeCount >= WORKFLOW_RESUME_MAX_COUNT || autoResumeCount >= WORKFLOW_RESUME_BACKOFF_MS.length) {
    finding.disposition = `notify_only（自动续跑次数用尽（上限 ${WORKFLOW_RESUME_MAX_COUNT}），交人类处置）`
    ops.push({ type: 'notify', finding, refractoryMs: EXTERNAL_REFRACTORY_MS })
    return
  }
  const cooldownMs = WORKFLOW_RESUME_BACKOFF_MS[autoResumeCount]!
  if (Date.now() - failedAt < cooldownMs) {
    // 冷却未满：零动作（不通知——冷却期内每 15s tick 会刷屏），仅记事实。
    finding.disposition = `wait_cooldown（第 ${autoResumeCount + 1} 次续跑冷却 ${Math.round(cooldownMs / 60_000)} 分钟未满）`
    return
  }
  finding.disposition = 'auto_resume（冷却期满，断点续跑）'
  ops.push({ type: 'resume', finding })
}
