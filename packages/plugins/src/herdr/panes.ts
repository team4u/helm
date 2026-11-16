/**
 * Managed pane registry: scopeKey(nodeId, paneId) -> ownership/parent/workflow/actual cwd/target/cleanup channel.
 *
 * Responsibilities:
 * - Record every Herdr pane created by this plugin (tab/worktree forms) and its **frozen connection target**
 *   (determined at enable; non-secret: nodeId/session/socketPath) -- all commands, events,
 *   files and cleanup for a pane always go through the same HerdrTarget; never hot-swap connections and risk hitting same-ID panes on another server;
 * - Record the spawn routing (agent kind / Profile id) for real resumes without agentType;
 * - Support same-workflow or same-parent-turn resume lookup (stable agentId or dual paneId keys);
 * - Distinguish "succeeded, keepalive pending settle" from "failed, keep the scene" (failure panes never join auto-cleanup).
 */

import { HelmError } from '@helm/protocol'
import { targetNodeId, type HerdrTarget } from './contracts.js'
import { OUTPUT_FILE_PATTERN } from './transport-output.js'

export type PaneOutcome = 'running' | 'keepalive' | 'failed' | 'settled'

/** Spawn routing snapshot (reused when resume has no agentType; both kind and Profile lookup are non-secret). */
export interface PaneRouting {
  kind: string
  /** The matched Profile ID (present for Profile entry; undefined for direct-prefix calls). */
  profileId?: string
}

export interface ManagedPane {
  /** Frozen connection target (constant within an enable cycle; remote carries nodeId, local carries session/socketPath/{}). */
  target: HerdrTarget
  paneId: string
  tabId: string
  /** Workspace and worktree in worktree mode (undefined in plain tab mode). */
  workspaceId?: string
  worktree?: { path: string; branch?: string }
  /** The actually effective working directory (worktree.path in worktree mode; the default reused by resume). */
  effectiveCwd: string
  agentName: string
  /** Spawn routing snapshot (resume reuses kind / Profile). */
  routing: PaneRouting
  /** Ownership: the parent conversation that spawned it. */
  parentConversationId: number
  /** agent_spawn's stable agentId (the workflow resume key). */
  agentId?: string
  /** The workflow run that spawned it; undefined for single-turn subagents. */
  workflowRunId?: string
  /** Current lifecycle form. */
  outcome: PaneOutcome
  /** Handoff file name (cleared after successful cleanup). */
  outputFileName?: string
  createdAt: number
  settledAt?: number
  /** Redacted diagnostic summary on failure (the keep-the-scene explanation). */
  failureNote?: string
}

/** Persistence mirror shape (ctx.doc 'managed'; non-secret fields only). */
export interface ManagedDoc {
  version: 1
  panes: Array<{
    target: { nodeId?: string; session?: string; socketPath?: string }
    paneId: string
    tabId: string
    workspaceId?: string
    worktree?: { path: string; branch?: string }
    effectiveCwd: string
    agentName: string
    routing: PaneRouting
    parentConversationId: number
    agentId?: string
    workflowRunId?: string
    /** 当前生命周期形态。 */
    outcome: PaneOutcome
    /** 持久化交接文件名（成功保活或清理结算后清空）。 */
    outputFileName?: string
    createdAt: number
    settledAt?: number
    failureNote?: string
  }>
}

export const EMPTY_MANAGED_DOC: ManagedDoc = { version: 1, panes: [] }

export function targetOf(pane: { target: HerdrTarget }): HerdrTarget {
  return pane.target
}

/** Target node identifier (undefined = local); all ownership matching/queries go through this. */
export function nodeIdOf(pane: { target?: HerdrTarget }): string | undefined {
  return targetNodeId(pane.target)
}

/** 校验持久记录中的交接文件名（必须为 undefined 或匹配 OUTPUT_FILE_PATTERN）。 */
function assertValidManagedOutputFileName(outputFileName: unknown, paneId: string): string | undefined {
  if (outputFileName === undefined) return undefined
  if (typeof outputFileName !== 'string' || !OUTPUT_FILE_PATTERN.test(outputFileName)) {
    throw new HelmError(
      'herdr_managed_invalid',
      `Herdr 受管记录包含非法交接文件名：${String(outputFileName)}`,
      500,
      { paneId, outputFileName: typeof outputFileName === 'string' ? outputFileName : typeof outputFileName },
    )
  }
  return outputFileName
}

/**
 * Pane registry (in-process authoritative state + persistent mirror write port).
 */
export class PaneRegistry {
  /** Bounded reclaim cap for settled records: keep the most recent N settled (tab already closed; reconciliation/audit value only); failed kept longer (scene-investigation records). */
  static readonly MAX_RETAINED_SETTLED = 50
  static readonly MAX_RETAINED_FAILED = 20
  private readonly panes = new Map<string, ManagedPane>()
  private readonly mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void; flush?: () => Promise<void> }

  constructor(mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void; flush?: () => Promise<void> }, restored?: ManagedDoc) {
    this.mirror = mirror
    if (restored) {
      for (const pane of restored.panes) {
        if (!pane.target || !pane.routing || typeof pane.routing.kind !== 'string' || pane.routing.kind === '') {
          throw new HelmError('herdr_managed_invalid', 'Herdr managed record is missing target/routing', 500)
        }
        const outputFileName = assertValidManagedOutputFileName(pane.outputFileName, pane.paneId)
        this.panes.set(scopeKey(targetNodeId(pane.target), pane.paneId), {
          target: pane.target,
          paneId: pane.paneId,
          tabId: pane.tabId,
          workspaceId: pane.workspaceId,
          worktree: pane.worktree,
          effectiveCwd: pane.effectiveCwd,
          agentName: pane.agentName,
          routing: pane.routing,
          parentConversationId: pane.parentConversationId,
          agentId: pane.agentId,
          workflowRunId: pane.workflowRunId,
          outcome: pane.outcome,
          outputFileName,
          createdAt: pane.createdAt,
          settledAt: pane.settledAt,
          failureNote: pane.failureNote,
        })
      }
    }
  }

  add(pane: ManagedPane): void {
    const outputFileName = assertValidManagedOutputFileName(pane.outputFileName, pane.paneId)
    this.panes.set(scopeKey(nodeIdOf(pane), pane.paneId), { ...pane, outputFileName })
    this.flush()
  }

  get(nodeId: string | undefined, paneId: string): ManagedPane | undefined {
    return this.panes.get(scopeKey(nodeId, paneId))
  }

  /** Locate resume candidates by stable agentId or paneId (paneId may collide across nodes; the caller adjudicates ambiguity). */
  findByResumeRef(ref: string): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.agentId === ref || p.paneId === ref)
  }

  /** Locate all panes by workflow run. */
  findByWorkflow(workflowRunId: string): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.workflowRunId === workflowRunId)
  }

  /** Locate all panes by parent turn. */
  findByParent(parentConversationId: number): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.parentConversationId === parentConversationId)
  }

  all(): ManagedPane[] {
    return [...this.panes.values()]
  }

  update(nodeId: string | undefined, paneId: string, patch: Partial<ManagedPane>): ManagedPane | undefined {
    const key = scopeKey(nodeId, paneId)
    const pane = this.panes.get(key)
    if (!pane) return undefined
    const next = { ...pane, ...patch }
    if ('outputFileName' in patch) {
      next.outputFileName = assertValidManagedOutputFileName(patch.outputFileName, paneId)
    }
    this.panes.set(key, next)
    this.flush()
    return this.panes.get(key)
  }

  remove(nodeId: string | undefined, paneId: string): void {
    if (this.panes.delete(scopeKey(nodeId, paneId))) this.flush()
  }

  /**
   * Bounded reclaim of settled records (prevents unbounded growth: appending forever
   * per spawn would make memory and the persistent doc fully rewritten, slowing reconciliation/stop linearly): keep the most recent
   * N settled and M failed by settledAt (createdAt fallback); running/keepalive are never reclaimed. failed is kept
   * longer -- failureNote is a scene-investigation record (reclaiming a record does not close its tab; it only drops the registration).
   */
  prune(options: { maxSettled?: number; maxFailed?: number } = {}): number {
    const maxSettled = options.maxSettled ?? PaneRegistry.MAX_RETAINED_SETTLED
    const maxFailed = options.maxFailed ?? PaneRegistry.MAX_RETAINED_FAILED
    let removed = 0
    for (const [outcome, max] of [['settled', maxSettled], ['failed', maxFailed]] as const) {
      const stale = this.all()
        .filter((p) => p.outcome === outcome)
        .sort((a, b) => (b.settledAt ?? b.createdAt) - (a.settledAt ?? a.createdAt))
        .slice(max)
      for (const pane of stale) {
        this.panes.delete(scopeKey(nodeIdOf(pane), pane.paneId))
        removed += 1
      }
    }
    if (removed > 0) this.flush()
    return removed
  }

  /**
   * Memory-only settled marking (no persistent mirror flush): service stop path only -- during disable the doc handle
   * is already invalid (plugin_context_expired); persistent state is rebuilt by next enable cycle's reconciliation.
   */
  markSettledVolatile(nodeId: string | undefined, paneId: string): void {
    const pane = this.panes.get(scopeKey(nodeId, paneId))
    if (pane === undefined) return
    this.panes.set(scopeKey(nodeId, paneId), {
      ...pane,
      outcome: 'settled',
      settledAt: Date.now(),
      outputFileName: undefined,
    })
  }

  /** liveTasks label: still running + succeeded keepalive pending settle (failure/settled don't count). */
  liveTaskLabels(): string[] {
    const labels: string[] = []
    for (const pane of this.panes.values()) {
      if (pane.outcome === 'running') labels.push(`herdr-pane:${pane.paneId}`)
      else if (pane.outcome === 'keepalive') labels.push(`herdr-keepalive:${pane.paneId}`)
    }
    return labels
  }

  /** Non-secret reconciliation view (for restart scans). */
  snapshot(): ManagedDoc {
    return {
      version: 1,
      panes: this.all().map((p) => ({
        target: { ...p.target },
        paneId: p.paneId,
        tabId: p.tabId,
        ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
        ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
        effectiveCwd: p.effectiveCwd,
        agentName: p.agentName,
        routing: { ...p.routing },
        parentConversationId: p.parentConversationId,
        ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        ...(p.workflowRunId !== undefined ? { workflowRunId: p.workflowRunId } : {}),
        outcome: p.outcome,
        ...(p.outputFileName !== undefined ? { outputFileName: p.outputFileName } : {}),
        createdAt: p.createdAt,
        ...(p.settledAt !== undefined ? { settledAt: p.settledAt } : {}),
        ...(p.failureNote !== undefined ? { failureNote: p.failureNote } : {}),
      })),
    }
  }

  /** 将排队中的持久镜像写冲刷落盘（底层 store 未提供 flush 时立即完成）。 */
  flushDisk(): Promise<void> {
    return this.mirror.flush ? this.mirror.flush() : Promise.resolve()
  }

  private flush(): void {
    this.mirror.set(this.snapshot())
  }
}

export function scopeKey(nodeId: string | undefined, paneId: string): string {
  return `${nodeId ?? 'local'}:${paneId}`
}

/** executor in-memory table primary key: the pane's unique key bound to the target's full coordinates (no cross-node collisions). */
export function paneStateKey(pane: { target: HerdrTarget; paneId: string }): string {
  return JSON.stringify([pane.target, pane.paneId])
}

/** closePane single-flight key (node coordinate folds 'local'; shares the same coordinate with the steer gate). */
export function paneCloseKey(pane: { target?: HerdrTarget; paneId: string }): string {
  return scopeKey(nodeIdOf(pane), pane.paneId)
}
