/**
 * builtin:superagent Watchdog 动作执行：notify / abort / bridge / resume / wake
 * 五类 PlannedOp 的去重、守卫与投递（原 watchdog 闭包的 executeOps 段）。
 *
 * 安全红线（与拆分前逐行等价）：
 * - 0-Token 自动中止/授权变更统一经内核 guarded 端口（探针 ownedBy +
 *   stateChangeSeq 随调用传入），内核在第一个不可逆动作前的同一串行域内
 *   原子复核；插件层现查仅快速失败与诊断；
 * - 去重标记的写入时机逐类保持：abort 在守卫通过后、bridge 在 Ask 创建成功
 *   后、wake 仅在实际投递成功后（提交被拒不消耗水位，下一 tick 可重试）；
 * - fire-and-forget 一律经 runtime.track（计入 service.liveTasks）。
 */

import {
  HelmError,
  type AskResult,
  type HelmPluginContext,
} from '@helm/protocol'
import type { SuperAgentWatchdogRuntime } from './contracts.js'
import type { WatchdogDedupStore } from './watchdog-dedup.js'
import {
  describeError,
  escapeXml,
  EXTERNAL_REFRACTORY_MS,
  guardOf,
  isGuardConflict,
  SENTINEL_SEQ,
  WORKFLOW_RESUME_RETRY_DEFER_MS,
  type Finding,
  type PlannedOp,
  type WatchdogNotify,
} from './watchdog-core.js'
import { isProtectedTarget } from './watchdog-guards.js'

export interface WatchdogOpsDeps {
  ctx: HelmPluginContext
  runtime: SuperAgentWatchdogRuntime
  dedup: WatchdogDedupStore
  notify: WatchdogNotify
  isClosing: () => boolean
  /** 进行中的 bridge Ask（dedup key -> askId）：service stop 取消 + 防同水位重复创建。 */
  inFlightBridges: Map<string, string>
}

export class WatchdogOpsExecutor {
  /** 提交中的目标水位，防止不同 tick 对同一异常重复投递。 */
  private readonly inFlightWakes = new Set<string>()
  /** 续跑调用在途的 runId（防相邻 tick 重叠重复 invoke；探针侧才是权威防重）。 */
  private readonly inFlightWorkflowResumes = new Set<string>()
  /** 续跑调用失败后的重试推迟时刻（runId -> notBefore；内存态，跨重启重置）。 */
  private readonly workflowResumeRetryNotBefore = new Map<string, number>()

  constructor(private readonly deps: WatchdogOpsDeps) {}

  /**
   * fire-and-forget 一律经 runtime.track（计入 service.liveTasks）；
   * track 契约已负责 rejection 显式通知，这里仅防「track 仍抛出」造成
   * 未观察 rejection 崩溃进程——错误已被显式上报，不是静默降级。
   */
  private fireAndForget<T>(label: string, task: () => Promise<T>): void {
    void this.deps.runtime.track(label, task).catch((err: unknown) => {
      this.deps.notify(
        'error',
        'Watchdog 后台任务失败',
        `${label}: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  async executeOps(tickAt: number, findings: Finding[], ops: PlannedOp[]): Promise<void> {
    const { ctx, runtime, dedup, notify, isClosing, inFlightBridges } = this.deps
    // 1) 通知（各自独立去重）。
    for (const op of ops) {
      if (op.type !== 'notify') continue
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      if (!dedup.shouldFire(op.finding.key, 'notify', seq, op.refractoryMs)) continue
      dedup.markFired(op.finding.key, 'notify', seq)
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
      if (!dedup.shouldFire(finding.key, 'abort', seq, Number.POSITIVE_INFINITY)) continue
      if (isClosing()) continue
      this.fireAndForget('watchdog:auto-abort', () => this.autoAbort(finding))
    }

    // 3) bridge_to_ask（原生 owned 阻塞且无待答 Ask；去重标记在 Ask 创建成功后写入）。
    for (const op of ops) {
      if (op.type !== 'bridge') continue
      const finding = op.finding
      const seq = finding.stateChangeSeq
      if (seq === undefined) continue // classify 已保证存在，双保险
      if (inFlightBridges.has(finding.key)) continue
      if (!dedup.shouldFire(finding.key, 'bridge', seq, Number.POSITIVE_INFINITY)) continue
      if (isClosing()) continue
      this.fireAndForget('watchdog:bridge-ask', () => this.bridgeToAsk(finding))
    }

    // 4) workflow_run 失败自动续跑（0-Token 断点续跑）：每 tick 最多恢复 1 个
    //    （failedAt 升序，最旧失败优先，避免网关则恢复时同时唤醒十几个大
    //    工作流再次打挂接口）；防重依赖探针侧 resumedByRunId / stateChangeSeq
    //    机制（续跑成功的旧 Run 不再上报、新失败 Run 携带新水位），执行层仅
    //    加内存 in-flight（防相邻 tick 重叠）与失败重试推迟（防每 tick 刷屏）。
    const resumeOps = ops.filter((op): op is Extract<PlannedOp, { type: 'resume' }> => op.type === 'resume')
    if (resumeOps.length > 0 && !isClosing() && !ctx.host.isClosing) {
      const now = Date.now()
      const eligible = resumeOps.filter((op) => {
        const run = op.finding.workflowRun!
        return !this.inFlightWorkflowResumes.has(run.runId) && (this.workflowResumeRetryNotBefore.get(run.runId) ?? 0) <= now
      })
      eligible.sort((a, b) => a.finding.workflowRun!.failedAt - b.finding.workflowRun!.failedAt)
      const pick = eligible[0]
      if (pick !== undefined) {
        const { runId, conversationId } = pick.finding.workflowRun!
        this.inFlightWorkflowResumes.add(runId)
        this.fireAndForget('watchdog:workflow-resume', async () => {
          try {
            if (isClosing() || ctx.host.isClosing) return
            await ctx.host.invokeAction('builtin:workflow', 'run', {
              resumeFromRunId: runId,
              conversationId,
            })
            this.workflowResumeRetryNotBefore.delete(runId)
            notify(
              'info',
              'Watchdog 已自动续跑失败工作流',
              `${pick.finding.evidence}；已调用 builtin:workflow run（resumeFromRunId=${runId}）从断点恢复，防重由探针 resumedByRunId/stateChangeSeq 机制保证`,
              conversationId,
            )
          } catch (err) {
            // 失败如实告知并推迟重试：探针下一轮仍会上报，冷却条件仍满足即可重试。
            this.workflowResumeRetryNotBefore.set(runId, Date.now() + WORKFLOW_RESUME_RETRY_DEFER_MS)
            const seq = pick.finding.stateChangeSeq ?? SENTINEL_SEQ
            if (dedup.shouldFire(pick.finding.key, 'notify', seq, EXTERNAL_REFRACTORY_MS)) {
              dedup.markFired(pick.finding.key, 'notify', seq)
              notify(
                'error',
                'Watchdog 工作流自动续跑失败',
                `${pick.finding.evidence}；resumeFromRunId=${runId} 调用失败：${describeError(err)}；已推迟 ${Math.round(WORKFLOW_RESUME_RETRY_DEFER_MS / 60_000)} 分钟重试`,
                conversationId,
              )
            }
          } finally {
            this.inFlightWorkflowResumes.delete(runId)
          }
        })
      }
    }

    // 5) L2 唤醒：仅当 due 异常实际投递成功后才消耗 wake 水位；提交被拒绝
    //    （未就绪/关闭/submit 失败）不标记，下一 tick 可重试；提示词只含 due 异常，
    //    不携带同 tick 大量正常事实（防真异常被截断）；单次提交仅 track 一次。
    const wakeOps = ops.filter((op): op is Extract<PlannedOp, { type: 'wake' }> => op.type === 'wake')
    const dueWakes = wakeOps.filter((op) => {
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      return !this.inFlightWakes.has(`${op.finding.key}:${seq}`) && dedup.shouldFire(op.finding.key, 'wake', seq, op.refractoryMs)
    })
    if (dueWakes.length === 0) return
    const watchdogConvId = runtime.getWatchdogConversationId()
    if (watchdogConvId === undefined) {
      notify('warning', 'Watchdog 会话未就绪', '存在需认知排障的异常，但巡检会话尚未初始化，本轮仅记录事实')
      return
    }
    if (isClosing()) return
    const wakeKeys = dueWakes.map((op) => {
      const seq = op.finding.stateChangeSeq ?? SENTINEL_SEQ
      return `${op.finding.key}:${seq}`
    })
    for (const key of wakeKeys) this.inFlightWakes.add(key)
    this.fireAndForget('watchdog:wake-l2', async () => {
      try {
        if (isClosing() || ctx.host.isClosing) return
        const valid = dueWakes.filter((op) => {
          const finding = op.finding
          if (finding.targetKind === 'external') return finding.stateChangeSeq !== undefined && finding.ownedBy !== 'human'
          const id = finding.conversationId
          if (id === undefined) return false
          try {
            return ctx.host.getConversationOwnership(id) !== 'human' && ctx.host.getConversation(id).stateChangeSeq === finding.stateChangeSeq
          } catch (error) {
            if (error instanceof HelmError && error.code === 'not_found') return false
            throw error
          }
        })
        if (valid.length === 0) return
        await ctx.host.submitInput(watchdogConvId, this.buildWakePrompt(valid.map((op) => op.finding)), {
          origin: 'agent',
          whenBusy: 'steer',
          meta: { renderer: 'superagent:watchdog-alert', tickAt },
        })
        // 提交被接受后才写去重标记（提交失败不消耗水位，下一 tick 重试）。
        for (const op of valid) {
          dedup.markFired(op.finding.key, 'wake', op.finding.stateChangeSeq ?? SENTINEL_SEQ)
        }
      } finally {
        for (const key of wakeKeys) this.inFlightWakes.delete(key)
      }
    })
  }

  /** L2 提示词：事实 JSON 转义防逃逸 + 排障手册指引 + 归属红线重申（全量事实，不截断）。 */
  private buildWakePrompt(findings: Finding[]): string {
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
      escapeXml(this.deps.ctx.host.redact(factsJson)),
      '</findings>',
    ].join('\n')
  }

  /**
   * 0-Token 自动中止：守卫全部通过后才写去重标记（守卫失败不消耗水位）。
   *
   * 原子性（human 红线）：探针事实（ownedBy + stateChangeSeq）随调用传入内核
   * abortConversationGuarded，内核在 SDK abort 调用（第一个不可逆动作）前的
   * 同一串行域内同步复核——归属翻转/水位推进在任意 await 窗口内发生都会被
   * 409 ownership_conflict / state_seq_conflict 拒绝，绝不执行中止。插件层
   * 现查仅作快速失败与诊断；不再存在插件检查与内核生效点之间的 TOCTOU。
   * 目标已变（冲突/缺失）与真实失败区分：前者是确定性放弃（保留水位标记，
   * 限频告知），后者撤销标记可重试。
   */
  private async autoAbort(finding: Finding): Promise<void> {
    const { ctx, dedup, notify, isClosing } = this.deps
    const conversationId = finding.conversationId
    if (conversationId === undefined) return
    const seq = finding.stateChangeSeq ?? SENTINEL_SEQ
    const giveUp = (level: 'warning' | 'info', title: string, detail: string): void => {
      // 放弃型通知限频（同一水位 1 小时内不重复），避免每 tick 刷屏。
      if (!dedup.shouldFire(finding.key, 'notify', seq, EXTERNAL_REFRACTORY_MS)) return
      dedup.markFired(finding.key, 'notify', seq)
      notify(level, title, detail, conversationId)
    }
    // 异步任务在真正操作前再查关闭状态：排队期间内核可能已开始关闭。
    if (isClosing() || ctx.host.isClosing) {
      giveUp('info', 'Watchdog 跳过自动中止', '内核/插件正在关闭，不再执行自动中止')
      return
    }
    if (ctx.host.getConversationOwnership(conversationId) === 'human') {
      giveUp('warning', 'Watchdog 放弃自动中止', `${finding.evidence}；执行前归属已变为 human，仅通知`)
      return
    }
    if (isProtectedTarget(this.deps.runtime, conversationId)) {
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
    dedup.markFired(finding.key, 'abort', seq)
    try {
      // 探针事实（ownedBy + stateChangeSeq）随调用传入：内核在 SDK abort 调用
      // 前的同一串行域内原子复核（上方插件层现查仅快速失败）。
      await ctx.host.abortConversationGuarded(conversationId, guardOf(finding, { withSeq: true }))
    } catch (err) {
      if (isGuardConflict(err)) {
        // 内核守卫拒绝：授权事实在生效点已失效（人类接管/水位推进/目标删除）。
        // 确定性放弃——保留水位标记，下一 tick 按新事实重新评估。
        giveUp(
          'warning',
          'Watchdog 放弃自动中止',
          `${finding.evidence}；内核守卫拒绝：${describeError(err)}`,
        )
        return
      }
      // 中止失败：撤销消费标记（与 bridge 失败语义一致），下一 tick 可重试；
      // 如实通知失败原因，绝不记成功。
      dedup.unmarkFired(finding.key, 'abort')
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
  private giveUpBridge(finding: Finding, reason: string): void {
    const seq = finding.stateChangeSeq ?? SENTINEL_SEQ
    if (!this.deps.dedup.shouldFire(finding.key, 'notify', seq, EXTERNAL_REFRACTORY_MS)) return
    this.deps.dedup.markFired(finding.key, 'notify', seq)
    this.deps.notify('warning', 'Watchdog 放弃授权问询', `${finding.evidence}；${reason}`, finding.conversationId)
  }

  private async bridgeToAsk(finding: Finding): Promise<void> {
    const { ctx, runtime, dedup, notify, isClosing, inFlightBridges } = this.deps
    const conversationId = finding.conversationId
    if (conversationId === undefined) return
    const seq = finding.stateChangeSeq
    if (seq === undefined) return
    const guardKey = finding.key
    const askId = `superagent-watchdog-bridge-${conversationId}-${seq}`

    // 异步任务在真正操作前再查关闭状态：排队期间内核可能已开始关闭。
    if (isClosing() || ctx.host.isClosing) return
    if (isProtectedTarget(runtime, conversationId)) {
      this.giveUpBridge(finding, '常驻入口受保护，仅通知')
      return
    }
    if (ctx.host.getConversationOwnership(conversationId) === 'human') {
      this.giveUpBridge(finding, '创建前归属已变为 human，仅通知')
      return
    }
    let current
    try {
      current = ctx.host.getConversation(conversationId)
    } catch (err) {
      this.giveUpBridge(finding, `目标会话已不可读：${describeError(err)}`)
      return
    }
    if (current.stateChangeSeq !== seq || current.status !== 'blocked' || current.pendingAskCount > 0) {
      // 探针已过期：下一 tick 会按新事实重新分类，本轮不创建（限频告知）。
      if (dedup.shouldFire(guardKey, 'notify', seq, EXTERNAL_REFRACTORY_MS)) {
        dedup.markFired(guardKey, 'notify', seq)
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
        description: ctx.host.redact(
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
      dedup.markFired(guardKey, 'bridge', seq)
      inFlightBridges.set(guardKey, askId)
      settled = await created
    } catch (err) {
      inFlightBridges.delete(guardKey)
      if (err instanceof HelmError && err.code === 'ask_id_conflict') {
        // 同 ID 已存在（含已结算）：视为已桥接，占坑防重复创建。
        dedup.markFired(guardKey, 'bridge', seq)
        return
      }
      // 创建/等待失败：撤销 bridge 意图（不消耗水位），显式告知，下一 tick 可重试。
      dedup.unmarkFired(guardKey, 'bridge')
      notify(
        'error',
        'Watchdog 授权问询失败',
        `${finding.evidence}；Ask ${askId} 创建/等待失败：${describeError(err)}；已撤销去重标记，下一轮巡检可重试`,
        conversationId,
      )
      return
    }
    try {
      if (isClosing()) return // 停止中：不再发起新的自动处置（cancelAsk 会结算该 Ask）
      this.applyBridgeAnswer(finding, conversationId, completionSeqAtCreation, settled, askId)
    } finally {
      inFlightBridges.delete(guardKey)
    }
  }

  private applyBridgeAnswer(
    finding: Finding,
    conversationId: number,
    completionSeqAtCreation: number,
    result: { status: string; answers: Record<string, string> },
    askId: string,
  ): void {
    const { ctx, runtime, dedup, notify, isClosing } = this.deps
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
    // 原子性（human 红线）：最终变更经内核 guarded 端口执行（探针 ownedBy 随
    // 调用传入）；内核在 SDK abort/submit 调用（第一个不可逆动作）前的同一
    // 串行域内同步复核归属——上方插件检查与内核生效点之间任意 await 窗口内
    // 的人类接管都会被 409 拒绝，不再有插件层 TOCTOU 残余窗口。
    // 注：Ask 创建/回答会推进 stateChangeSeq，故此处不携带探针 seq（机械比对
    // 会误杀一切授权）；completionSeq 未变由下方检查保证。
    // 关闭中不执行任何变更（stop 已取消/将取消在途 Ask）。
    if (isClosing() || ctx.host.isClosing) {
      notify('info', 'Watchdog 放弃执行授权', '内核/插件正在关闭，不执行授权变更', conversationId)
      return
    }
    if (isProtectedTarget(runtime, conversationId)) {
      notify('warning', 'Watchdog 放弃执行授权', '常驻入口受保护，不执行授权变更', conversationId)
      return
    }
    if (ctx.host.getConversationOwnership(conversationId) === 'human') {
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
          ctx.host.submitInputGuarded(
            conversationId,
            'Watchdog 恢复提示：上轮回合疑似阻塞，请检查在途工具与子代理状态，必要时重试或如实报告失败。',
            { origin: 'agent', whenBusy: 'steer' },
            guardOf(finding),
          ),
        )
        .then(() => {
          notify('info', 'Watchdog 已注入恢复提示', `${finding.evidence}；已向会话 ${conversationId} 提交 agent 恢复输入`, conversationId)
        })
        .catch((err: unknown) => {
          notify(
            isGuardConflict(err) ? 'warning' : 'error',
            isGuardConflict(err) ? 'Watchdog 放弃执行授权' : 'Watchdog 恢复提示提交失败',
            `${finding.evidence}；${describeError(err)}`,
            conversationId,
          )
        })
      return
    }
    void runtime
      .track('watchdog:bridge-abort', () =>
        ctx.host.abortConversationGuarded(conversationId, guardOf(finding)),
      )
      .then(() => {
        notify('error', 'Watchdog 已按授权中止会话', `${finding.evidence}；已中止会话 ${conversationId}`, conversationId)
      })
      .catch((err: unknown) => {
        notify(
          isGuardConflict(err) ? 'warning' : 'error',
          isGuardConflict(err) ? 'Watchdog 放弃执行授权' : 'Watchdog 授权中止失败',
          `${finding.evidence}；${describeError(err)}`,
          conversationId,
        )
      })
  }
}
