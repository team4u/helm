/**
 * service-recovery.ts — 启动恢复与自动续跑候选。
 *
 * StartupRecovery 承载：
 * - prepareRecovery（阶段一屏障）：跨重启遗留 running run 的子会话先落持久
 *   abort 标记（paused 相位），绝不带未落标记启动调度器；
 * - init（阶段二）：原位续跑或标 failed（附结构化 errorCode）、通知 outbox 补发；
 * - listAutoResumeCandidates：满足自动断点续跑条件的后台工作流候选。
 *
 * 全部可恢复性判定统一经 run-resumability.ts 的 inspectRunResumability。
 */

import { HelmError } from '@helm/protocol'
import { inspectRunResumability } from './run-resumability.js'
import {
  backgroundChildIds,
  errorMessage,
  type RunRecord,
} from './run-store.js'
import { reattachBackgroundAgent } from './background-agent-runner.js'
import { resumeWorkflowInPlace } from './service-run.js'
import type { WorkflowServiceContext } from './service-context.js'

export interface WorkflowAutoResumeCandidate {
  runId: string
  conversationId: number
  failedAt: number
  autoResumeCount: number
}

export class StartupRecovery {
  private recovered = false
  private recoveryPrepared = false
  private initPromise?: Promise<void>
  private readonly preparedChildIds = new Set<number>()
  private readonly pendingSettlementChildIds = new Set<number>()
  private settlementPromise?: Promise<void>

  constructor(private readonly svc: WorkflowServiceContext) {}

  async prepareRecovery(): Promise<void> {
    if (this.recoveryPrepared) return
    const autoRecover = this.svc.isAutoRecoverOnRestart()
    const index = this.svc.runs.readIndex()
    const childIds = new Set<number>()
    for (const entry of index) {
      const record = this.svc.runs.loadByEntry(entry)
      if (record.pendingChildCleanup === true) {
        for (const id of backgroundChildIds(record)) childIds.add(id)
        continue
      }
      if (record.status !== 'running') continue
      if (!autoRecover || this.willAbortOnAutoRecover(record)) {
        for (const id of backgroundChildIds(record)) childIds.add(id)
      }
    }
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
    return !inspectRunResumability(record, this.svc.resumabilityContext(), {
      mode: 'startup_in_place',
      preIncrementCrashCheck: true,
    }).resumable
  }

  private async failRecoveredRecord(
    record: RunRecord,
    errorCode: string,
    errorText: string,
    pendingNotifies: Array<() => Promise<void>>,
  ): Promise<void> {
    const children = new Set<number>(backgroundChildIds(record))
    for (const id of children) this.pendingSettlementChildIds.add(id)
    await Promise.all(
      [...children].map(async (id) => {
        try {
          await this.svc.host.abortConversationGuarded(id)
        } catch (error) {
          process.stderr.write(
            `workflow init: guarded abort conversation ${id} failed: ${errorMessage(error)}\n`,
          )
        }
      }),
    )
    if (record.pendingChildCleanup !== undefined) {
      delete record.pendingChildCleanup
    }
    if (record.suspendedCleanly !== undefined) {
      delete record.suspendedCleanly
    }
    record.status = 'failed'
    record.updatedAt = Date.now()
    record.errorCode = errorCode
    record.error = errorText
    if (record.nodes !== undefined) {
      record.nodes = record.nodes.map((node) =>
        node.status === 'running' || node.status === 'pending'
          ? { ...node, status: 'failed', settledAt: record.updatedAt, error: record.error }
          : node,
      )
    }
    this.svc.writeRecord(record)
    if (record.notifyParentOnSettle === true && record.notifiedAt === undefined) {
      const target = record
      pendingNotifies.push(async () => {
        if (this.svc.host.onBackgroundAgentSettled === undefined) return
        await this.svc.host.onBackgroundAgentSettled(this.svc.summaryOf(target), {
          parentConversationId: target.conversationId,
          ...(target.subagentMeta ?? {}),
        })
        target.notifiedAt = Date.now()
        this.svc.writeRecord(target)
      })
    }
    this.svc.emitEventSafe('workflow.updated', { run: this.svc.summaryOf(record) })
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
        const pendingNotifies: Array<() => Promise<void>> = []
        const reattachHorizons: Promise<void>[] = []
        for (const entry of index) {
          const record = this.svc.runs.loadByEntry(entry)
          if (
            record.notifyParentOnSettle === true &&
            record.status !== 'running' &&
            record.notifiedAt === undefined
          ) {
            const target = record
            pendingNotifies.push(async () => {
              if (this.svc.host.onBackgroundAgentSettled === undefined) return
              await this.svc.host.onBackgroundAgentSettled(this.svc.summaryOf(target), {
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
            await this.failRecoveredRecord(record, 'interrupted', errorText, pendingNotifies)
            changed = true
            continue
          }

          if (record.suspendedCleanly === true) {
            delete record.suspendedCleanly
          } else {
            record.crashRecoveries = (record.crashRecoveries ?? 0) + 1
          }
          this.svc.writeRecord(record)
          await this.svc.state.flush?.()
          changed = true

          const verdict = inspectRunResumability(record, this.svc.resumabilityContext(), {
            mode: 'startup_in_place',
          })
          if (!verdict.resumable) {
            if (verdict.code === 'crash_recovery_limit') {
              process.stderr.write(
                `workflow init: circuit breaker tripped for ${record.id} (crashRecoveries=${record.crashRecoveries})\n`,
              )
            }
            await this.failRecoveredRecord(record, verdict.code, verdict.reason, pendingNotifies)
            continue
          }

          try {
            this.svc.host.getConversation(record.conversationId)
          } catch (error) {
            const kindLabel = record.kind === 'subagent' ? 'subagent' : '工作流'
            const code = error instanceof HelmError && error.code !== '' ? error.code : 'parent_conversation_unavailable'
            await this.failRecoveredRecord(
              record,
              code,
              `${kindLabel} 所属父会话 ${record.conversationId} 不可用，无法恢复：${errorMessage(error)}`,
              pendingNotifies,
            )
            continue
          }

          if (record.kind === 'subagent') {
            const reattached = reattachBackgroundAgent(this.svc, record)
            if (reattached.isNativeReattach) {
              reattachHorizons.push(reattached.horizonGate)
            }
            this.svc.emitEventSafe('workflow.updated', { run: this.svc.summaryOf(record) })
            continue
          }

          const journal = verdict.journal!
          const initialSeq = journal.entries.reduce((max, item) => Math.max(max, item.seq + 1), 0)
          const resumeJournalIoErrors =
            journal.ioErrors > 0
              ? [`journal ${record.id} has ${journal.ioErrors} corrupt/unreadable line(s) (in-place resume from ${record.journalPath})`]
              : undefined
          const resumed = resumeWorkflowInPlace(this.svc, record, {
            script: verdict.script!,
            journalEntries: journal.entries,
            initialSeq,
            ...(resumeJournalIoErrors !== undefined ? { resumeJournalIoErrors } : {}),
          })
          reattachHorizons.push(resumed.horizonGate)
          this.svc.emitEventSafe('workflow.updated', { run: this.svc.summaryOf(record) })
        }
        if (changed) await this.svc.state.flush?.()
        if (reattachHorizons.length > 0) {
          await Promise.allSettled(reattachHorizons)
        }
        this.recovered = true
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
        if (!this.recovered) this.initPromise = undefined
      }
    })()
    return this.initPromise
  }

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

  /** 返回满足自动断点续跑条件的后台工作流。 */
  listAutoResumeCandidates(maxAttempts = 3): WorkflowAutoResumeCandidate[] {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new HelmError('validation_error', 'maxAttempts 必须是正整数', 400, { maxAttempts })
    }
    const index = this.svc.runs.readIndex()
    const baseCtx = this.svc.resumabilityContext()
    const candidates: WorkflowAutoResumeCandidate[] = []
    for (const entry of index) {
      let record: RunRecord
      try {
        record = this.svc.runs.loadByEntry(entry)
      } catch (error) {
        process.stderr.write(`workflow auto-resume: skip ${entry.id}: ${errorMessage(error)}\n`)
        continue
      }
      const verdict = inspectRunResumability(
        record,
        {
          ...baseCtx,
          onTakeoverInspectError: (runId, takeoverId, error) => {
            process.stderr.write(
              `workflow auto-resume: skip ${runId}: takeover ${takeoverId} unusable: ${errorMessage(error)}\n`,
            )
          },
        },
        { mode: 'watchdog_auto', maxAutoResumeAttempts: maxAttempts },
      )
      if (!verdict.resumable) continue
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
