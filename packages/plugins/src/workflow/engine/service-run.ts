/**
 * service-run.ts — workflow run 的启动主体（自 WorkflowService.run 拆出的
 * 内部模块）。
 *
 * startWorkflowRun 承载完整 run() 流程：请求校验（name/script/scriptPath
 * 恰一、512KB 上限）、resume 目标解析与账本安全重放校验、接管标记与并发
 * 接管保留、running 快照先于副作用落盘、引擎 host 组装与后台执行链。
 * 终态结算位于 run-settle.ts，进度事件策略位于 run-progress.ts；持久化
 * 格式、错误码与行为契约不变。
 */

import { mkdirSync } from 'node:fs'
import { HelmError, redactJsonValue, type ConversationSummary } from '@helm/protocol'
import type { WorkflowRunRequest, WorkflowRunSummary } from '../../contracts.js'
import {
  JournalWriter,
  readJournal,
  redactJournalEntry,
  type WorkflowJournalEntry,
} from './journal.js'
import {
  MAX_SCRIPT_LENGTH,
  normalizeWorkflowArgs,
  runWorkflow,
  type WorkflowRunResult,
} from './runtime.js'
import { resolveForegroundWaiters, type ActiveRun } from './active-run.js'
import { newRunId, type RunRecord } from './run-store.js'
import { redactSummaryNodes, toSummary } from './run-summary.js'
import { settleWorkflowRun } from './run-settle.js'
import { makeRunProgressHandler } from './run-progress.js'
import type { WorkflowServiceContext } from './service-context.js'

/**
 * 启动一个工作流 run：后台执行，立即返回 summary（不等完成）。
 * context 由内核受信注入（工具链真实 callId），不是用户可写输入；
 * 新 run 必须提供 conversationId；resume 未另指定时复用原 run 的会话。
 * context.foreground 置位 record.syncForeground（前台同步 run：父工具调用
 * 阻塞等待，可被 detach 转后台；不通知父会话直至 detach 置位）。
 * @throws HelmError validation_error / not_found / workflow_action_uncertain / journal_read_failed。
 */
export async function startWorkflowRun(
  svc: WorkflowServiceContext,
  request: WorkflowRunRequest,
  context?: { parentToolCallId?: string; notifyParentOnSettle?: boolean; foreground?: boolean },
): Promise<WorkflowRunSummary> {
  svc.assertNotClosed()
  await svc.init()

  // 内部元数据只经受信 context 进入：空串与非字符串一律视为无关联，
  // 绝不允许 HTTP body / DSL 冒充（request 里没有这个字段）。
  const parentToolCallId =
    typeof context?.parentToolCallId === 'string' && context.parentToolCallId !== ''
      ? context.parentToolCallId
      : undefined

  const sources = [request.name, request.script, request.scriptPath].filter((v) => v !== undefined)
  if (sources.length > 1) {
    throw new HelmError(
      'validation_error',
      'exactly one of name, script, scriptPath must be provided (or omit all to reuse the old script with resumeFromRunId)',
      400,
      { provided: sources.length },
    )
  }

  // --- resume 目标解析 ---------------------------------------------
  let replayFrom: RunRecord | undefined
  if (request.resumeFromRunId !== undefined) {
    replayFrom = svc.runs.load(request.resumeFromRunId)
    if (replayFrom.kind === 'subagent') {
      throw new HelmError('validation_error', '后台子代理运行没有工作流重放脚本；请用 execution.conversationId/executionId 通过 subagent resume 续接', 400, { runId: replayFrom.id })
    }
    if (replayFrom.status === 'running' && !svc.active.has(replayFrom.id)) {
      // init() 已把跨重启 running 标 failed；此处 running 只可能是同进程旧状态。
      replayFrom.status = 'failed'
      replayFrom.error = 'run interrupted（账本完好，可经 resumeFromRunId 恢复）'
      svc.writeRecord(replayFrom)
      await svc.state.flush?.()
    }
    if (svc.active.has(replayFrom.id)) {
      throw new HelmError('conflict', `工作流 ${replayFrom.id} 仍在运行中`, 409, { runId: replayFrom.id })
    }
  }

  const conversationId = request.conversationId ?? replayFrom?.conversationId
  if (conversationId === undefined) {
    throw new HelmError(
      'validation_error',
      '缺少工作流目标会话：提供 conversationId，或从 CLI 使用 --current；工具调用会使用当前会话',
      400,
    )
  }
  if (replayFrom !== undefined && request.conversationId !== undefined && request.conversationId !== replayFrom.conversationId) {
    throw new HelmError(
      'validation_error',
      `恢复目标不匹配：工作流 ${replayFrom.id} 属于会话 ${replayFrom.conversationId}，不能改在会话 ${request.conversationId} 下恢复`,
      400,
      { runId: replayFrom.id, recordedConversationId: replayFrom.conversationId, requestedConversationId: request.conversationId },
    )
  }

  let parent: ConversationSummary
  try {
    parent = svc.host.getConversation(conversationId)
  } catch {
    throw new HelmError('not_found', `会话 ${conversationId} 不存在，无法在其下运行工作流`, 404, {
      conversationId,
    })
  }

  // --- 脚本源 ------------------------------------------------------
  let script: string
  let scriptPath: string | undefined
  let savedName: string | undefined

  if (request.script !== undefined) {
    script = request.script
  } else if (request.name !== undefined) {
    savedName = request.name
    scriptPath = svc.library.resolveSavedName(request.name)
    script = svc.library.readScriptFile(scriptPath)
  } else if (request.scriptPath !== undefined) {
    scriptPath = svc.library.resolveExplicitPath(request.scriptPath)
    script = svc.library.readScriptFile(scriptPath)
  } else if (replayFrom !== undefined) {
    if (replayFrom.script !== undefined) {
      script = replayFrom.script
    } else if (replayFrom.scriptPath !== undefined) {
      scriptPath = replayFrom.scriptPath
      script = svc.library.readScriptFile(scriptPath)
      if (replayFrom.savedName !== undefined) savedName = replayFrom.savedName
    } else {
      throw new HelmError(
        'validation_error',
        `工作流 ${request.resumeFromRunId} 未持久化脚本源，无法 resume；请显式提供 script/scriptPath`,
        400,
        { runId: request.resumeFromRunId },
      )
    }
  } else {
    throw new HelmError('validation_error', '必须提供 name、script 或 scriptPath 之一', 400)
  }

  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new HelmError(
      'validation_error',
      `工作流脚本 ${script.length} 字符，超过上限 ${MAX_SCRIPT_LENGTH}`,
      400,
      { length: script.length },
    )
  }

  // --- args（resume 沿用原 args；显式提供才覆盖） --------------------
  let args: unknown
  if (request.args !== undefined) {
    args = normalizeWorkflowArgs(request.args)
  } else if (replayFrom?.args !== undefined) {
    args = replayFrom.args
  }

  // --- journal（resume 重放 + 本 run 记账） -------------------------
  const runId = newRunId()
  mkdirSync(svc.runs.artifactsDir(conversationId), { recursive: true })
  const journalPath = svc.runs.journalPathFor(conversationId, runId)

  let replayEntries: readonly WorkflowJournalEntry[] = []
  /** resume 读旧账本时的損行诊断（计数形态，结算时入 run 诊断面）。 */
  let resumeJournalIoErrors: string[] | undefined
  if (replayFrom !== undefined) {
    const journal = readJournal(replayFrom.journalPath)
    if (journal.readFailed !== undefined) {
      // 权限/I-O 错误：账本状态未知，假扮空账本等于自动重跑全部副作用。
      throw new HelmError(
        'journal_read_failed',
        `工作流 ${replayFrom.id} 的账本不可读（${journal.readFailed.code}），无法安全恢复；请修复文件权限后重试`,
        409,
        { priorRunId: replayFrom.id, journalPath: replayFrom.journalPath, ...journal.readFailed },
      )
    }
    if (journal.actionUncertain) {
      // 悬挂 started / 失败 action / 不可判定损坏行：副作用是否发生不可判定，
      // 显式交人类决策，绝不自动重跑。
      const why = journal.failedActions > 0 ? '存在失败（ok:false）的动作终态行' : '账本存在已开始但未确认完成或无法判定的动作调用'
      throw new HelmError(
        'workflow_action_uncertain',
        `工作流 ${replayFrom.id} 的${why}（failedActions=${journal.failedActions}），无法安全恢复；` +
          '请人工确认该动作副作用后，从其 journal 中移除对应 action 行或放弃 resume',
        409,
        { priorRunId: replayFrom.id, journalPath: replayFrom.journalPath, failedActions: journal.failedActions },
      )
    }
    replayEntries = journal.entries
    // 損行不影响安全重放（已由 actionUncertain 把关），但记入本 run 诊断面：
    // 账本健康度如实可见，绝不静默少重放。运行期 agent 行写失败由引擎经
    // WorkflowRunResult.journalIoErrors 补充，这里只覆盖 resume 时的存量損行。
    if (journal.ioErrors > 0) {
      resumeJournalIoErrors = [
        `journal ${replayFrom.id} has ${journal.ioErrors} corrupt/unreadable line(s) (replayed from ${replayFrom.journalPath})`,
      ]
    }
  }

  // --- resume 接管（§3.2）：账本可安全重放已验证，新 run 建立即标记原 run
  // 被接管（防重复续跑，重复 resume 显式 409），并让新记录继承
  // notifyParentOnSettle、累计 autoResumeCount +1。接管标记先于新 run 快照
  // 落盘：进程死在两写之间只会留下「指向不存在 run 的接管标记」（诊断
  // 可见），不会出现双 run 同时可续跑。
  /**
   * 接管保留释放（幂等）：新 run 快照落盘（磁盘成为接管事实的权威）或
   * 启动失败（标记是否幽灵交由磁盘事实判定）时调用。
   */
  let releaseTakeoverReservation: () => void = () => {}
  if (replayFrom !== undefined) {
    // 并发接管串行化（同步临界段）：终检用现读记录——本 run 入口 loadRecord
    // 后已经过 init()/flush 等 await 点，并发 resume 可能已抢先落标记；从
    // 现读检查到标记写入之间无 await（单线程事件循环），后到者必然读到先
    // 到者的标记并 409，不可能双双接管。
    const currentMarker = svc.runs.load(replayFrom.id).resumedByRunId
    if (currentMarker !== undefined) {
      // 幽灵标记甄别：索引 not_found 不等于新 run 从未存在——接管 run 可能
      // 已写记录/账本后索引才丢失。只有进程内保留、活跃表、索引与磁盘
      // （同会话的记录与账本文件）四面都无痕迹才确证可重接管；仍有痕迹
      // （即使索引缺失）保持 409 诊断，防对已产生副作用的 run 重复续跑。
      // 接管记录损坏如实上抛。
      const takeover = svc.runs.inspectTakeoverMarker(currentMarker, replayFrom.conversationId, {
        reserved: svc.takeoverReservations.has(currentMarker),
        active: svc.active.has(currentMarker),
      })
      if (!takeover.ghost) {
        throw new HelmError(
          'conflict',
          `工作流 ${replayFrom.id} 已被运行 ${currentMarker} 接管续跑（${takeover.reason}）；请从接管的 run 继续或人工核查`,
          409,
          { runId: replayFrom.id, resumedByRunId: currentMarker },
        )
      }
      process.stderr.write(
        `workflow resume: clearing orphaned takeover marker ${currentMarker} on ${replayFrom.id}（索引与磁盘均无接管痕迹，确证从未写记录/账本）\n`,
      )
      replayFrom.resumedByRunId = undefined
    }
    // 接管保留（防并发双接管）：从旧 record 标记落盘到新 run 快照落盘之间
    // 存在 await 窗口（flush 等），此间的幽灵检测在索引与磁盘上都看不到新
    // run——保留集合先占位，检测一律按「接管仍存在」409；绝不放宽整个
    // 活跃期，快照落盘或启动失败即释放。
    svc.takeoverReservations.add(runId)
    let reservationHeld = true
    releaseTakeoverReservation = (): void => {
      if (reservationHeld) {
        reservationHeld = false
        svc.takeoverReservations.delete(runId)
      }
    }
    try {
      replayFrom.resumedByRunId = runId
      replayFrom.updatedAt = Date.now()
      svc.writeRecord(replayFrom)
      await svc.state.flush?.()
    } catch (error) {
      releaseTakeoverReservation()
      throw error
    }
  }

  const abort = new AbortController()
  const createdAt = Date.now()
  const meta = svc.library.peekMeta(script)
  // 显式前台同步（工具 background:false 的 resume）：接管 run 的等待方是新
  // 调用方，不继承源 run 的后台通知标记——否则后台 run 的同步 resume 会被
  // 误判已后台（detach 拒绝）且自然完成多发汇报；通知链在 detach 置位后才
  // 接入。CLI/action 的后台 resume（未传 foreground）仍继承原标记。
  const foregroundContext = context?.foreground === true

  const record: RunRecord = {
    id: runId,
    name: meta?.name ?? scriptPath ?? runId,
    conversationId,
    ...(parentToolCallId !== undefined ? { parentToolCallId } : {}),
    status: 'running',
    createdAt,
    updatedAt: createdAt,
    kind: 'workflow',
    // 后台启动（工具 background / CLI-action 后台 resume 继承源标记）：结算后
    // 向父会话投递通知并参与重启恢复的守卫中止（isBackgroundRecord）；同步
    // run 不置位、不通知（显式前台覆盖继承，见 foregroundContext 注释）。
    ...(!foregroundContext &&
      (context?.notifyParentOnSettle === true || replayFrom?.notifyParentOnSettle === true)
      ? { notifyParentOnSettle: true }
      : {}),
    // 前台同步标记（工具 background:false）：可被 detach 转后台；resume 不
    // 继承（接管 run 的等待方由新调用方决定，不伪造前台事实）。
    ...(foregroundContext ? { syncForeground: true } : {}),
    ...(replayFrom !== undefined ? { autoResumeCount: (replayFrom.autoResumeCount ?? 0) + 1 } : {}),
    ...(meta?.description !== undefined ? { description: svc.redact(meta.description) } : {}),
    ...(meta?.phases !== undefined
      ? { phases: redactJsonValue(meta.phases, svc.redact) as RunRecord['phases'] }
      : {}),
    ...(scriptPath === undefined ? { script } : {}),
    ...(scriptPath !== undefined ? { scriptPath } : {}),
    ...(savedName !== undefined ? { savedName } : {}),
    ...(args !== undefined ? { args: redactJsonValue(args, svc.redact) } : {}),
    journalPath,
    ...(replayFrom !== undefined ? { replayedFrom: replayFrom.id } : {}),
  }

  // done 自注册进 active 起即为真实终点（deferred gate，由下方结算链 resolve）：
  // 占位 Promise.resolve 会让「注册 → running 快照 flush → 结算链启动」之间
  // 的 await 窗口内并发 wait()/abort() 立即假返回，违背「返回时 run 已终态」
  // 契约（与 startBackgroundAgent 的 doneGate 同构）。
  let resolveRunDone: () => void = () => {}
  const doneGate = new Promise<void>((resolve) => {
    resolveRunDone = resolve
  })
  const run: ActiveRun = {
    runId,
    conversationId,
    abort,
    record,
    done: doneGate,
    summary: toSummary(record),
    journalPath,
    writer: new JournalWriter(journalPath),
    progress: [],
    timeline: [],
    pendingAborts: new Set(),
    pendingExecs: new Set(),
    childConversations: new Set(),
    foregroundWaiters: new Set(),
    lastPersistAt: createdAt,
    lastNodeEventAt: createdAt,
  }
  // 停机屏障复查：入口检查后已经过 init() 与 resume 分支的 flush 等多个 await
  // 点，close() 只快照当下 active 集合——漏检会让 run 越过屏障继续派生子会话。
  // 本行到 active.set 之间无 await（单线程事件循环），此后 close 必然拍到本 run。
  // 同款复查取消窗口：经过脚本读取/账本重放等 await 后，目标会话可能已进入
  // 级联取消边界——在此拒绝，不留越过标记的漏网 run。拒绝时释放接管保留
  // （新 run 未落任何快照，标记交由磁盘事实判定）。
  try {
    svc.assertNotClosed()
    svc.cancellation.assertNotCancelling(conversationId)
  } catch (error) {
    releaseTakeoverReservation()
    throw error
  }
  svc.active.set(runId, run)

  // 先落 running 快照（state store）：进程若死于此 run，重启后 init() 显式发现并标 failed。
  try {
    svc.writeRecord(record)
    // 快照已原子落盘：接管事实以磁盘为权威（幽灵检测必见文件），进程内
    // 保留即可释放（幂等；flush 失败时文件仍在，同样不再需要保留）。
    releaseTakeoverReservation()
    await svc.state.flush?.()
  } catch (error) {
    // running 快照都没能落库：不启动执行，不留任何 active/writer。
    // 快照未落盘时释放接管保留——此时标记是否幽灵交由磁盘事实判定
    // （无任何文件 = 真幽灵可重接管；写一半失败原子回滚不留文件）。
    releaseTakeoverReservation()
    // close() 快照可能已拍到本 run：gate 必须给终点，否则 close 永久挂起。
    await run.writer.close().catch(() => {})
    svc.active.delete(runId)
    resolveRunDone()
    // 此窗口内不可能有前台等待者（runId 尚未返回给调用方），防御性收口。
    resolveForegroundWaiters(run, 'settled')
    throw error
  }
  svc.emitEventSafe('workflow.updated', { run: redactSummaryNodes(svc.redact, { ...run.summary }) })

  const engineHost = svc.makeEngineHost(run, parent)
  const onProgress = makeRunProgressHandler(svc, run)

  // 真实结算链：结束后 resolve doneGate（wait/abort/close 自 active.set 起
  // 等待的都是同一个 gate，再无占位窗口）。
  void (async () => {
    let result: WorkflowRunResult | undefined
    let failure: unknown
    try {
      result = await runWorkflow({
        script,
        ...(args !== undefined ? { args } : {}),
        host: engineHost,
        signal: abort.signal,
        ...svc.caps,
        ...(svc.redact !== undefined ? { redact: svc.redact } : {}),
        onProgress,
        journal: {
          ...(replayEntries.length > 0 ? { entries: replayEntries } : {}),
          retryFailedCalls: replayFrom?.status === 'failed',
          append: async (entry) => {
            // agent 行 execution/gate（effectiveCwd、worktree 路径、gate 输出
            // 可含机密 token）落盘前统一脱敏；幂等替换，重复脱敏无害。
            await run.writer.append(redactJournalEntry(entry, svc.redact))
          },
        },
      })
    } catch (error) {
      // 引擎在 worker 启动前拒绝（坏 meta、超限等）：无进度可折叠，直接失败。
      failure = error
    }
    try {
      await settleWorkflowRun(svc, run, resumeJournalIoErrors, result, failure)
    } catch (error) {
      // settleWorkflowRun 设计上吸收全部异常（终态落盘失败等经 settleError
      // 如实浮出给 wait/abort）；此 catch 仅防御缩程错误逃逸：gate 仍必须
      // resolve，且不得留下 floating rejection。
      process.stderr.write(
        `workflow ${runId}: settle crashed: ${error instanceof Error ? error.message : String(error)}\n`,
      )
      run.settleError = run.settleError ?? error
    }
    resolveRunDone()
  })()

  return { ...run.summary }
}
