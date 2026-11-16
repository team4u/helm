/**
 * service-recovery.ts — 启动恢复与自动续跑候选（自 WorkflowService 拆出的
 * 内部模块）。
 *
 * StartupRecovery 承载：
 * - prepareRecovery（阶段一屏障）：跨重启遗留 running run 的子会话先落持久
 *   abort 标记（paused 相位），绝不带未落标记启动调度器；
 * - init（阶段二）：running 标 failed(interrupted)、通知 outbox 补发
 *   （notifiedAt 防重复，at-least-once）；幂等缓存，失败可重试；
 * - listAutoResumeCandidates：满足自动断点续跑条件的后台工作流候选（账本
 *   安全锚点在引擎内验证，Watchdog 只消费明确候选）。
 *
 * 恢复幂等标记（recovered / recoveryPrepared / initPromise）归属本模块；
 * 行为契约与错误码不变。
 */

import { HelmError } from '@helm/protocol'
import { readJournal, type JournalReadResult } from './journal.js'
import {
  backgroundChildIds,
  errorMessage,
  isNonRetryableWorkflowError,
  type RunRecord,
} from './run-store.js'
import { toSummary } from './run-summary.js'
import { reattachBackgroundAgent } from './background-agent-runner.js'
import { resumeWorkflowInPlace } from './service-run.js'
import type { WorkflowServiceContext } from './service-context.js'

const MAX_CRASH_RECOVERIES = 3

export interface WorkflowAutoResumeCandidate {
  runId: string
  conversationId: number
  failedAt: number
  autoResumeCount: number
}

export class StartupRecovery {
  /** init 幂等标记：仅恢复完整成功后置位；失败可重试。 */
  private recovered = false
  private recoveryPrepared = false
  private initPromise?: Promise<void>
  private readonly preparedChildIds = new Set<number>()
  private readonly pendingSettlementChildIds = new Set<number>()
  private settlementPromise?: Promise<void>

  constructor(private readonly svc: WorkflowServiceContext) {}

  /**
   * 启动恢复（阶段一：全局服务 prepare 屏障，SDK 调度器仍 paused）：扫描全部
   * running 与 pendingChildCleanup 记录（含后台、同步与 CLI 工作流），把遗留
   * 原生子会话经 host.abortConversationGuarded（paused 相位：只落持久 abort
   * 标记，不唤醒调度器、不等结算）逐个持久取消。
   * 幂等；run() 首次调用前自动执行，也可由宿主显式调用。失败可重试：
   * recoveryPrepared / initPromise 仅在完整成功后保留。
   */
  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    const autoRecover = this.svc.isAutoRecoverOnRestart()
    const index = this.svc.runs.readIndex()
    const childIds = new Set<number>()
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.svc.runs.load(entry.id)
      } catch (error) {
        // 记录缺失（索引残留）：恢复只处理真实存在的记录；索引损坏诊断
        // 留给 listRuns（与 init 同契约，绝不删除索引掩盖）。
        if (error instanceof HelmError && error.code === 'not_found') continue
        throw error
      }
      if (record.pendingChildCleanup === true) {
        for (const id of backgroundChildIds(record)) childIds.add(id)
        continue
      }
      if (record.status !== 'running') continue
      if (!autoRecover || this.willAbortOnAutoRecover(record)) {
        for (const id of backgroundChildIds(record)) childIds.add(id)
      }
    }
    // 逐会话守卫取消。仅两类确定性可接受失败可诊断后继续：not_found（会话
    // 已删除）/ ownership_conflict（human 接管，红线拒绝——human 绝不 abort）。
    // 其余失败（持久化 I/O、内核内部错误）必须上抛：恢复屏障被阻断，
    // recoveryPrepared 不置位（下次 prepare 重试），绝不带着未落取消标记
    // 启动调度器——“先落取消标记”的屏障优先于“容错继续”。
    for (const id of childIds) {
      try {
        await this.svc.host.abortConversationGuarded(id)
      } catch (error) {
        if (
          error instanceof HelmError &&
          (error.code === 'not_found' || error.code === 'ownership_conflict')
        ) {
          process.stderr.write(
            `workflow prepareRecovery: skip conversation ${id}（${error.code}，确定性跳过不阻断屏障）: ${errorMessage(error)}\n`,
          )
          continue
        }
        throw error
      }
    }
    for (const id of childIds) this.preparedChildIds.add(id)
    this.recoveryPrepared = true
  }

  /** 预判自动恢复模式下某 running 记录是否必定放弃恢复并须中止遗留子会话。 */
  private willAbortOnAutoRecover(record: RunRecord): boolean {
    if (record.suspendedCleanly !== true && (record.crashRecoveries ?? 0) + 1 > MAX_CRASH_RECOVERIES) {
      return true
    }
    if (record.kind === 'subagent') {
      const spec = record.subagentSpec
      if (spec === undefined) return true
      const exec = record.subagentMeta?.execution
      const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
      if (!hasHandle && spec.hadSecretGrant === true) return true
      return false
    }
    const script = this.readScriptForRecord(record)
    if (script === undefined) return true
    const journal = readJournal(record.journalPath)
    return journal.readFailed !== undefined || journal.actionUncertain
  }

  private readScriptForRecord(record: RunRecord): string | undefined {
    if (record.script !== undefined) return record.script
    if (record.scriptPath !== undefined) {
      try {
        return this.svc.library.readScriptFile(record.scriptPath)
      } catch {
        return undefined
      }
    }
    return undefined
  }

  private async failRecoveredRecord(
    record: RunRecord,
    errorText: string,
    pendingNotifies: Array<() => Promise<void>>,
  ): Promise<void> {
    const children = new Set<number>(backgroundChildIds(record))
    for (const id of children) this.pendingSettlementChildIds.add(id)
    await Promise.all([...children].map(async (id) => {
      try {
        await this.svc.host.abortConversationGuarded(id)
      } catch (error) {
        process.stderr.write(
          `workflow init: guarded abort conversation ${id} failed: ${errorMessage(error)}\n`,
        )
      }
    }))
    if (record.pendingChildCleanup !== undefined) {
      delete record.pendingChildCleanup
    }
    if (record.suspendedCleanly !== undefined) {
      delete record.suspendedCleanly
    }
    record.status = 'failed'
    record.updatedAt = Date.now()
    record.error = errorText
    if (record.nodes !== undefined) {
      record.nodes = record.nodes.map((node) => node.status === 'running' || node.status === 'pending'
        ? { ...node, status: 'failed', settledAt: record.updatedAt, error: record.error }
        : node)
    }
    this.svc.writeRecord(record)
    if (record.notifyParentOnSettle === true && record.notifiedAt === undefined) {
      const target = record
      pendingNotifies.push(async () => {
        if (this.svc.host.onBackgroundAgentSettled === undefined) return
        await this.svc.host.onBackgroundAgentSettled(toSummary(target), {
          parentConversationId: target.conversationId,
          ...(target.subagentMeta ?? {}),
        })
        target.notifiedAt = Date.now()
        this.svc.writeRecord(target)
      })
    }
    this.svc.emitEventSafe('workflow.updated', { run: toSummary(record) })
  }

  async init(): Promise<void> {
    if (this.recovered) return
    if (this.initPromise !== undefined) return this.initPromise
    this.initPromise = (async () => {
      try {
        await this.prepareRecovery()
        const autoRecover = this.svc.isAutoRecoverOnRestart()
        const index = this.svc.runs.readIndex()
        let changed = false
        // 通知 outbox 补发：崩溃前已达终态但 onBackgroundAgentSettled 未成功（或
        // 未及调用）的记录。回调失败不阻断 init（stderr 诊断，notifiedAt 不置位，
        // 下次 init 重试）。
        const pendingNotifies: Array<() => Promise<void>> = []
        const reattachHorizons: Promise<void>[] = []
        for (const entry of index) {
          let record: RunRecord
          try {
            record = this.svc.runs.load(entry.id)
          } catch (error) {
            // 记录缺失（索引残留）：恢复只处理真实存在的记录；索引损坏诊断
            // 留给 listRuns（与 prepareRecovery 同契约，绝不删除索引掩盖）。
            if (error instanceof HelmError && error.code === 'not_found') continue
            throw error
          }
          if (
            record.notifyParentOnSettle === true &&
            record.status !== 'running' &&
            record.notifiedAt === undefined
          ) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.svc.host.onBackgroundAgentSettled === undefined) return
              await this.svc.host.onBackgroundAgentSettled(toSummary(target), {
                parentConversationId: target.conversationId,
                ...(target.subagentMeta ?? {}),
              })
              target.notifiedAt = Date.now()
              this.svc.writeRecord(target)
            })
          }
          if (record.status !== 'running') {
            if (record.pendingChildCleanup === true) {
              for (const id of backgroundChildIds(record)) {
                this.pendingSettlementChildIds.add(id)
              }
              delete record.pendingChildCleanup
              this.svc.writeRecord(record)
              changed = true
            }
            continue
          }
          if (!autoRecover) {
            const errorText =
              record.kind === 'subagent'
                ? 'subagent run interrupted by process restart（可凭 conversationId/executionId 通过 resume 续接）'
                : `run interrupted by process restart（账本完好，可经 resumeFromRunId 恢复）：${record.error ?? ''}`.trim()
            await this.failRecoveredRecord(record, errorText, pendingNotifies)
            changed = true
            continue
          }

          // 自动恢复路径（§1.3）：区分优雅挂起与异常崩溃，并先将计数变更落盘再发起恢复。
          if (record.suspendedCleanly === true) {
            delete record.suspendedCleanly
          } else {
            record.crashRecoveries = (record.crashRecoveries ?? 0) + 1
          }
          this.svc.writeRecord(record)
          await this.svc.state.flush?.()
          changed = true

          if ((record.crashRecoveries ?? 0) > MAX_CRASH_RECOVERIES) {
            process.stderr.write(
              `workflow init: circuit breaker tripped for ${record.id} (crashRecoveries=${record.crashRecoveries})\n`,
            )
            await this.failRecoveredRecord(
              record,
              `[crash_recovery_limit] 连续异常崩溃恢复超过上限（${MAX_CRASH_RECOVERIES} 次），已触发熔断中止恢复`,
              pendingNotifies,
            )
            continue
          }

          if (record.kind === 'subagent') {
            const spec = record.subagentSpec
            if (spec === undefined) {
              await this.failRecoveredRecord(
                record,
                'subagent run interrupted by process restart（缺少持久化启动规格 subagentSpec，无法自动恢复）',
                pendingNotifies,
              )
              continue
            }
            const exec = record.subagentMeta?.execution
            const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
            if (!hasHandle && spec.hadSecretGrant === true) {
              await this.failRecoveredRecord(
                record,
                '[secret_grant_expired_on_restart] 后台子代理在创建执行环境前因重启中断，且原请求授予了会话内存机密（secretNames），重启后内存机密已失效，拒绝无机密降级启动',
                pendingNotifies,
              )
              continue
            }
            try {
              this.svc.host.getConversation(record.conversationId)
            } catch (error) {
              await this.failRecoveredRecord(
                record,
                `subagent 所属父会话 ${record.conversationId} 不可用，无法恢复：${errorMessage(error)}`,
                pendingNotifies,
              )
              continue
            }
            const reattached = reattachBackgroundAgent(this.svc, record)
            if (reattached.isNativeReattach) {
              reattachHorizons.push(reattached.horizonGate)
            }
            this.svc.emitEventSafe('workflow.updated', { run: toSummary(record) })
            continue
          }

          const script = this.readScriptForRecord(record)
          if (script === undefined) {
            await this.failRecoveredRecord(
              record,
              'run interrupted by process restart（未持久化脚本源，无法原位续跑）',
              pendingNotifies,
            )
            continue
          }
          const journal: JournalReadResult = readJournal(record.journalPath)
          if (journal.readFailed !== undefined) {
            await this.failRecoveredRecord(
              record,
              `[journal_read_failed] 工作流账本不可读（${journal.readFailed.code}）：${journal.readFailed.message}`,
              pendingNotifies,
            )
            continue
          }
          if (journal.actionUncertain) {
            const why =
              journal.failedActions > 0
                ? '存在失败（ok:false）的动作终态行'
                : '账本存在已开始但未确认完成或无法判定的动作调用'
            await this.failRecoveredRecord(
              record,
              `[workflow_action_uncertain] 工作流 ${record.id} 的${why}（failedActions=${journal.failedActions}），拒绝自动恢复`,
              pendingNotifies,
            )
            continue
          }
          try {
            this.svc.host.getConversation(record.conversationId)
          } catch (error) {
            await this.failRecoveredRecord(
              record,
              `工作流所属父会话 ${record.conversationId} 不可用，无法恢复：${errorMessage(error)}`,
              pendingNotifies,
            )
            continue
          }
          const initialSeq = journal.entries.reduce((max, item) => Math.max(max, item.seq + 1), 0)
          const resumeJournalIoErrors =
            journal.ioErrors > 0
              ? [`journal ${record.id} has ${journal.ioErrors} corrupt/unreadable line(s) (in-place resume from ${record.journalPath})`]
              : undefined
          const resumed = resumeWorkflowInPlace(this.svc, record, {
            script,
            journalEntries: journal.entries,
            initialSeq,
            ...(resumeJournalIoErrors !== undefined ? { resumeJournalIoErrors } : {}),
          })
          reattachHorizons.push(resumed.horizonGate)
          this.svc.emitEventSafe('workflow.updated', { run: toSummary(record) })
        }
        if (changed) await this.svc.state.flush?.()
        if (reattachHorizons.length > 0) {
          await Promise.allSettled(reattachHorizons)
        }
        this.recovered = true
        // 先置 recovered 再补发：失败重试时上面循环不会重复处理（记录已非 running）。
        for (const notify of pendingNotifies) {
          try {
            await notify()
          } catch (error) {
            process.stderr.write(
              `workflow init: onBackgroundAgentSettled retry failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
        // notifiedAt 落盘失败仅意味着下次 init 可能重发（at-least-once），
        // 不阻断 init：恢复主体已在此前成功提交。
        if (pendingNotifies.length > 0) {
          try {
            await this.svc.state.flush?.()
          } catch (error) {
            process.stderr.write(
              `workflow init: notifiedAt persist failed: ${
                error instanceof Error ? error.message : String(error)
              }\n`,
            )
          }
        }
      } finally {
        // 失败（flush 抛错等）时清缓存：下一次 init()/run() 重试，不永久贴 failed。
        if (!this.recovered) this.initPromise = undefined
      }
    })()
    return this.initPromise
  }

  /**
   * 启动后收敛（由 runtime.started 在 harness.resume() 后触发；幂等）：
   * 此时调度器已进入 running 相位，对恢复收集到的全部遗留子会话再次调用
   * abortConversationGuarded，真实等待尚未停下的取消句柄完成并收敛至 idle，
   * 确保随后回收原生 Worktree 崩溃租约前底层子会话已彻底停止。
   */
  async awaitPreparedChildrenSettled(): Promise<void> {
    if (this.settlementPromise !== undefined) return this.settlementPromise
    const ids = new Set<number>([...this.preparedChildIds, ...this.pendingSettlementChildIds])
    if (ids.size === 0) return
    let run: Promise<void> | undefined
    run = (async () => {
      try {
        await Promise.all(
          [...ids].map(async (id) => {
            try {
              await this.svc.host.abortConversationGuarded(id)
              this.preparedChildIds.delete(id)
              this.pendingSettlementChildIds.delete(id)
            } catch (error) {
              if (
                error instanceof HelmError &&
                (error.code === 'not_found' || error.code === 'ownership_conflict')
              ) {
                this.preparedChildIds.delete(id)
                this.pendingSettlementChildIds.delete(id)
                process.stderr.write(
                  `workflow awaitPreparedChildrenSettled: skip conversation ${id}（${error.code}，确定性跳过）: ${errorMessage(error)}\n`,
                )
                return
              }
              process.stderr.write(
                `workflow awaitPreparedChildrenSettled: guarded abort conversation ${id} failed: ${errorMessage(error)}\n`,
              )
            }
          }),
        )
      } finally {
        if (this.settlementPromise === run) this.settlementPromise = undefined
      }
    })()
    this.settlementPromise = run
    return run
  }

  /**
   * 返回满足自动断点续跑条件的后台工作流。安全条件在引擎内读取并验证账本，
   * Watchdog 只消费明确候选，不自行推断 action 是否可能已执行。
   */
  listAutoResumeCandidates(maxAttempts = 3): WorkflowAutoResumeCandidate[] {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new HelmError('validation_error', 'maxAttempts 必须是正整数', 400, { maxAttempts })
    }
    // 索引读取与其他全部入口统一：损坏显式 workflow_index_corrupt，绝不静默
    // 当空索引返回空候选（那会让 Watchdog 误以为无事可做）。
    const index = this.svc.runs.readIndex()
    const candidates: WorkflowAutoResumeCandidate[] = []
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.svc.runs.load(entry.id)
      } catch (error) {
        // 单条损坏记录不能让所有其它候选静默消失；记录明确诊断后跳过，
        // Watchdog 仍可恢复账本完整的 Run。listRuns 继续对外严格失败。
        process.stderr.write(`workflow auto-resume: skip ${entry.id}: ${errorMessage(error)}\n`)
        continue
      }
      if (
        record.status !== 'failed' ||
        record.kind === 'subagent' ||
        record.notifyParentOnSettle !== true ||
        (record.autoResumeCount ?? 0) >= maxAttempts ||
        isNonRetryableWorkflowError(record.error)
      ) continue
      if (record.resumedByRunId !== undefined) {
        // 幽灵接管标记同规则甄别（与 resume 入口同一 helper）：接管 run 四面
        // 无痕（从未写记录/账本）才放行重接管；仍存在或损坏（含磁盘仍有
        // 文件、并发启动窗口）一律不放行。损坏诊断后跳过本条，不影响其他候选。
        try {
          const takeover = this.svc.runs.inspectTakeoverMarker(record.resumedByRunId, record.conversationId, {
            reserved: this.svc.takeoverReservations.has(record.resumedByRunId),
            active: this.svc.active.has(record.resumedByRunId),
          })
          if (!takeover.ghost) continue
        } catch (error) {
          process.stderr.write(
            `workflow auto-resume: skip ${entry.id}: takeover ${record.resumedByRunId} unusable: ${errorMessage(error)}\n`,
          )
          continue
        }
      }
      const journal = readJournal(record.journalPath)
      const hasSafeReplayAnchor = journal.entries.some((line) =>
        line.type === 'action'
          ? line.ok
          : line.type === 'agent' && (line.ok || (
              line.attempt !== undefined && line.execution?.conversationId !== undefined && line.execution.executionId === undefined
            )),
      )
      if (journal.actionUncertain || !hasSafeReplayAnchor) continue
      candidates.push({
        runId: record.id,
        conversationId: record.conversationId,
        failedAt: record.updatedAt,
        autoResumeCount: record.autoResumeCount ?? 0,
      })
    }
    return candidates.sort((a, b) => a.failedAt - b.failedAt)
  }
}
