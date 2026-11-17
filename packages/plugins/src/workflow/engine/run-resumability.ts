/**
 * run-resumability.ts — 引擎结构化失败错误码与单一权威可续跑评估器。
 *
 * 职责：
 * - classifyRunFailureCode：在一切失败出口确定性填充结构化 errorCode（优先取
 *   HelmError.code / WorkflowMetaError / WorkflowRuntimeError，取代下游子串猜测）；
 * - nonRetryableFailureCodeOf：优先判定结构化 errorCode；仅对未写 errorCode 的
 *   磁盘手工测试夹具保留单点最小回退识别；
 * - inspectRunResumability：引擎唯一权威可续跑判定函数，统一服务于：
 *   1) summary.resumable 与 resume_failed 批量续跑（mode='failed'）；
 *   2) Watchdog 自动断点续跑候选（mode='watchdog_auto'）；
 *   3) 启动恢复原位续跑预判与执行（mode='startup_in_place'）；
 *   4) resumeFromRunId 显式续接校验（mode='explicit_resume'）。
 */

import { HelmError } from '@helm/protocol'
import { readJournal, type JournalReadResult, type WorkflowJournalEntry } from './journal.js'
import { WorkflowMetaError } from './meta.js'
import type { RunRecord } from './run-store.js'
import { WorkflowRuntimeError } from './runtime-validation.js'

export const MAX_CRASH_RECOVERIES = 3

export const NON_RETRYABLE_ERROR_CODES: ReadonlySet<string> = new Set([
  'workflow_action_uncertain',
  'journal_read_failed',
  'validation_error',
  'syntax_error',
  'crash_recovery_limit',
  'secret_grant_expired_on_restart',
  'missing_subagent_spec',
  'missing_script_source',
])

/** 确定性提取失败错误码（写入 RunRecord.errorCode 与 WorkflowRunSummary.errorCode）。 */
export function classifyRunFailureCode(
  cause: unknown,
  errorText?: string,
  fallbackCode = 'workflow_failed',
): string {
  if (cause instanceof HelmError && cause.code !== '') return cause.code
  if (cause instanceof WorkflowMetaError) return 'validation_error'
  if (cause instanceof WorkflowRuntimeError) {
    return cause.message.toLowerCase().includes('workflow script has a syntax error')
      ? 'syntax_error'
      : 'validation_error'
  }
  if (errorText !== undefined) {
    const bracketed = /^\[([a-z][a-z0-9_]*)\]/i.exec(errorText.trim())
    if (bracketed !== null) return bracketed[1]!.toLowerCase()
    const lower = errorText.toLowerCase()
    if (lower.includes('workflow_action_uncertain')) return 'workflow_action_uncertain'
    if (lower.includes('journal_read_failed')) return 'journal_read_failed'
    if (lower.includes('secret_grant_expired_on_restart')) return 'secret_grant_expired_on_restart'
    if (lower.includes('workflow script has a syntax error')) return 'syntax_error'
  }
  return fallbackCode
}

/**
 * 判定记录是否属于不可自动恢复失败（返回命中的错误码；可重试返回 undefined）。
 * 优先使用结构化 record.errorCode；仅当磁盘夹具未携带 errorCode 时走最小回退。
 */
export function nonRetryableFailureCodeOf(
  record: Pick<RunRecord, 'errorCode' | 'error'>,
): string | undefined {
  if (record.errorCode !== undefined) {
    return NON_RETRYABLE_ERROR_CODES.has(record.errorCode) ? record.errorCode : undefined
  }
  if (record.error === undefined) return undefined
  const lower = record.error.toLowerCase()
  if (lower.includes('workflow_action_uncertain')) return 'workflow_action_uncertain'
  if (lower.includes('[validation_error]')) return 'validation_error'
  if (lower.includes('workflow script has a syntax error')) return 'syntax_error'
  if (lower.includes('[crash_recovery_limit]')) return 'crash_recovery_limit'
  if (lower.includes('secret_grant_expired_on_restart')) return 'secret_grant_expired_on_restart'
  if (lower.includes('[journal_read_failed]')) return 'journal_read_failed'
  return undefined
}

export function hasSafeJournalReplayAnchor(entries: readonly WorkflowJournalEntry[]): boolean {
  return entries.some((line) =>
    line.type === 'action'
      ? line.ok
      : line.type === 'agent' &&
        (line.ok ||
          (line.attempt !== undefined &&
            line.execution?.conversationId !== undefined &&
            line.execution.executionId === undefined)),
  )
}

export interface ResumabilityContext {
  inspectTakeover?(
    takeoverRunId: string,
    conversationId: number,
  ): { ghost: true } | { ghost: false; reason: string }
  readScriptFile?(scriptPath: string): string
  onTakeoverInspectError?(runId: string, takeoverRunId: string, error: unknown): void
}

export interface InspectResumabilityOptions {
  mode?: 'failed' | 'watchdog_auto' | 'startup_in_place' | 'explicit_resume'
  maxAutoResumeAttempts?: number
  /** startup_in_place 预检阶段尚未递增 crashRecoveries 时置 true。 */
  preIncrementCrashCheck?: boolean
  /** explicit_resume 调用方已显式传入 name/script/scriptPath 时置 true。 */
  hasExplicitScriptOverride?: boolean
}

export type RunResumabilityVerdict =
  | {
      resumable: true
      script?: string
      scriptPath?: string
      savedName?: string
      journal?: JournalReadResult
      resumeRef?: string
    }
  | {
      resumable: false
      code: string
      reason: string
      journal?: JournalReadResult
    }

function tryReadPersistedScript(
  record: RunRecord,
  ctx: ResumabilityContext,
): { ok: true; script: string; scriptPath?: string; savedName?: string } | { ok: false } {
  if (record.script !== undefined) {
    return { ok: true, script: record.script }
  }
  if (record.scriptPath !== undefined) {
    if (ctx.readScriptFile === undefined) {
      return {
        ok: true,
        script: '',
        scriptPath: record.scriptPath,
        ...(record.savedName !== undefined ? { savedName: record.savedName } : {}),
      }
    }
    try {
      const script = ctx.readScriptFile(record.scriptPath)
      return {
        ok: true,
        script,
        scriptPath: record.scriptPath,
        ...(record.savedName !== undefined ? { savedName: record.savedName } : {}),
      }
    } catch {
      return { ok: false }
    }
  }
  return { ok: false }
}

/** 引擎单一权威可续跑评估器。 */
export function inspectRunResumability(
  record: RunRecord,
  ctx: ResumabilityContext = {},
  options: InspectResumabilityOptions = {},
): RunResumabilityVerdict {
  const mode = options.mode ?? 'failed'

  if (mode === 'startup_in_place') {
    const projectedCrashes = options.preIncrementCrashCheck
      ? record.suspendedCleanly === true
        ? (record.crashRecoveries ?? 0)
        : (record.crashRecoveries ?? 0) + 1
      : (record.crashRecoveries ?? 0)
    if (projectedCrashes > MAX_CRASH_RECOVERIES) {
      return {
        resumable: false,
        code: 'crash_recovery_limit',
        reason: `[crash_recovery_limit] 连续异常崩溃恢复超过上限（${MAX_CRASH_RECOVERIES} 次），已触发熔断中止恢复`,
      }
    }
    if (record.kind === 'subagent') {
      const spec = record.subagentSpec
      if (spec === undefined) {
        return {
          resumable: false,
          code: 'missing_subagent_spec',
          reason: 'subagent run interrupted by process restart（缺少持久化启动规格 subagentSpec，无法自动恢复）',
        }
      }
      const exec = record.subagentMeta?.execution
      const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
      if (!hasHandle && spec.hadSecretGrant === true) {
        return {
          resumable: false,
          code: 'secret_grant_expired_on_restart',
          reason:
            '[secret_grant_expired_on_restart] 后台子代理在创建执行环境前因重启中断，且原请求授予了会话内存机密（secretNames），重启后内存机密已失效，拒绝无机密降级启动',
        }
      }
      return { resumable: true }
    }
    const resolvedScript = tryReadPersistedScript(record, ctx)
    if (!resolvedScript.ok) {
      return {
        resumable: false,
        code: 'missing_script_source',
        reason: 'run interrupted by process restart（未持久化脚本源，无法原位续跑）',
      }
    }
    const journal = readJournal(record.journalPath)
    if (journal.readFailed !== undefined) {
      return {
        resumable: false,
        code: 'journal_read_failed',
        reason: `[journal_read_failed] 工作流账本不可读（${journal.readFailed.code}）：${journal.readFailed.message}`,
        journal,
      }
    }
    if (journal.actionUncertain) {
      const why =
        journal.failedActions > 0
          ? '存在失败（ok:false）的动作终态行'
          : '账本存在已开始但未确认完成或无法判定的动作调用'
      return {
        resumable: false,
        code: 'workflow_action_uncertain',
        reason: `[workflow_action_uncertain] 工作流 ${record.id} 的${why}（failedActions=${journal.failedActions}），拒绝自动恢复`,
        journal,
      }
    }
    return {
      resumable: true,
      script: resolvedScript.script,
      ...(resolvedScript.scriptPath !== undefined ? { scriptPath: resolvedScript.scriptPath } : {}),
      ...(resolvedScript.savedName !== undefined ? { savedName: resolvedScript.savedName } : {}),
      journal,
    }
  }

  if (mode === 'explicit_resume') {
    if (record.kind === 'subagent') {
      if (record.status !== 'failed' && record.status !== 'aborted') {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `后台子代理 ${record.id} 当前状态为 ${record.status}，仅 failed/aborted 状态支持 resumeFromRunId 续接`,
        }
      }
      const spec = record.subagentSpec
      const exec = record.subagentMeta?.execution
      const resumeRef = exec?.executionId ?? (exec?.conversationId !== undefined ? String(exec.conversationId) : undefined)
      if (spec === undefined || resumeRef === undefined) {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `后台子代理 ${record.id} 缺少可续接执行句柄或持久化规格（无法执行 resumeFromRunId）`,
        }
      }
      return { resumable: true, resumeRef }
    }
    let script: string | undefined
    let scriptPath: string | undefined
    let savedName: string | undefined
    if (!options.hasExplicitScriptOverride) {
      if (record.script !== undefined) {
        script = record.script
      } else if (record.scriptPath !== undefined) {
        scriptPath = record.scriptPath
        script = ctx.readScriptFile ? ctx.readScriptFile(scriptPath) : undefined
        if (record.savedName !== undefined) savedName = record.savedName
      } else {
        return {
          resumable: false,
          code: 'validation_error',
          reason: `工作流 ${record.id} 未持久化脚本源，无法 resume；请显式提供 script/scriptPath`,
        }
      }
    }
    const journal = readJournal(record.journalPath)
    if (journal.readFailed !== undefined) {
      return {
        resumable: false,
        code: 'journal_read_failed',
        reason: `工作流 ${record.id} 的账本不可读（${journal.readFailed.code}），无法安全恢复；请修复文件权限后重试`,
        journal,
      }
    }
    if (journal.actionUncertain) {
      const why =
        journal.failedActions > 0
          ? '存在失败（ok:false）的动作终态行'
          : '账本存在已开始但未确认完成或无法判定的动作调用'
      return {
        resumable: false,
        code: 'workflow_action_uncertain',
        reason:
          `工作流 ${record.id} 的${why}（failedActions=${journal.failedActions}），无法安全恢复；` +
          '请人工确认该动作副作用后，从其 journal 中移除对应 action 行或放弃 resume',
        journal,
      }
    }
    return {
      resumable: true,
      ...(script !== undefined ? { script } : {}),
      ...(scriptPath !== undefined ? { scriptPath } : {}),
      ...(savedName !== undefined ? { savedName } : {}),
      journal,
    }
  }

  // 'failed' 与 'watchdog_auto' 共用基础门槛
  if (record.status !== 'failed') {
    return { resumable: false, code: 'not_failed', reason: `状态为 ${record.status}（非 failed）` }
  }
  if (mode === 'watchdog_auto') {
    if (record.kind === 'subagent') {
      return { resumable: false, code: 'subagent_not_auto_resumed', reason: '单子代理不进入工作流自动断点续跑候选' }
    }
    if (record.notifyParentOnSettle !== true) {
      return { resumable: false, code: 'not_background', reason: '非后台工作流' }
    }
    const maxAttempts = options.maxAutoResumeAttempts ?? 3
    if ((record.autoResumeCount ?? 0) >= maxAttempts) {
      return { resumable: false, code: 'max_attempts_reached', reason: '自动续跑次数已达上限' }
    }
  }

  const badCode = nonRetryableFailureCodeOf(record)
  if (badCode !== undefined) {
    return {
      resumable: false,
      code: badCode,
      reason: `不可自动恢复错误：${record.error ?? badCode}`,
    }
  }

  if (record.resumedByRunId !== undefined) {
    if (ctx.inspectTakeover === undefined) {
      return { resumable: false, code: 'already_resumed', reason: `已被 ${record.resumedByRunId} 接管续跑` }
    }
    try {
      const takeover = ctx.inspectTakeover(record.resumedByRunId, record.conversationId)
      if (!takeover.ghost) {
        return { resumable: false, code: 'already_resumed', reason: `已被 ${record.resumedByRunId} 接管续跑` }
      }
    } catch (error) {
      ctx.onTakeoverInspectError?.(record.id, record.resumedByRunId, error)
      return {
        resumable: false,
        code: 'takeover_corrupt',
        reason: `接管记录 ${record.resumedByRunId} 损坏不可判定`,
      }
    }
  }

  if (mode === 'watchdog_auto') {
    const journal = readJournal(record.journalPath)
    if (
      journal.readFailed !== undefined ||
      journal.actionUncertain ||
      !hasSafeJournalReplayAnchor(journal.entries)
    ) {
      return {
        resumable: false,
        code: journal.actionUncertain ? 'workflow_action_uncertain' : 'no_replay_anchor',
        reason: '账本存在不确定副作用或缺少可安全恢复锚点',
        journal,
      }
    }
    return { resumable: true, journal }
  }

  // mode === 'failed'（summary.resumable 与 resume_failed 批量恢复）
  if (record.kind === 'subagent') {
    const exec = record.subagentMeta?.execution
    const hasHandle = exec?.conversationId !== undefined || exec?.executionId !== undefined
    if (record.subagentSpec === undefined || !hasHandle) {
      return {
        resumable: false,
        code: 'missing_subagent_spec',
        reason: '缺少可续接执行句柄或持久化规格 subagentSpec',
      }
    }
    return { resumable: true }
  }

  const resolvedScript = tryReadPersistedScript(record, ctx)
  if (!resolvedScript.ok) {
    return { resumable: false, code: 'missing_script_source', reason: '未持久化脚本源' }
  }
  const journal = readJournal(record.journalPath)
  if (journal.readFailed !== undefined) {
    return {
      resumable: false,
      code: 'journal_read_failed',
      reason: `journal_read_failed: ${journal.readFailed.code}`,
      journal,
    }
  }
  if (journal.actionUncertain) {
    return {
      resumable: false,
      code: 'workflow_action_uncertain',
      reason: 'workflow_action_uncertain: 账本存在不确定副作用',
      journal,
    }
  }
  return {
    resumable: true,
    script: resolvedScript.script,
    ...(resolvedScript.scriptPath !== undefined ? { scriptPath: resolvedScript.scriptPath } : {}),
    ...(resolvedScript.savedName !== undefined ? { savedName: resolvedScript.savedName } : {}),
    journal,
  }
}
