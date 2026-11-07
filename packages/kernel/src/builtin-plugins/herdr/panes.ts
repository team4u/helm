/**
 * 受管窗格登记表：paneId -> 归属/父子/workflow/实际 cwd/目标机/清理通道。
 *
 * 职责：
 * - 记录本插件创建的每个 Herdr 窗格（tab/worktree 两种形态）；
 * - 支持同 workflow 或同父回合 resume 定位；
 * - 区分「成功保活待结算」与「失败保留现场」（失败 pane 不参与自动清理与
 *   liveTasks 保活，重启对账也不当普通 ended orphan 回收）；
 * - 持久化镜像（ctx.doc，非机密字段）供重启对账。
 */

import type { HerdrTarget } from './contracts.js'

export type PaneOutcome = 'running' | 'keepalive' | 'failed' | 'settled'

export interface ManagedPane {
  /** 目标机标识（undefined = 本机）。 */
  machine?: string
  paneId: string
  tabId: string
  /** worktree 模式下的 workspace 与工作树（普通 tab 模式为 undefined）。 */
  workspaceId?: string
  worktree?: { path: string; branch?: string }
  /** 实际生效工作目录（worktree 模式为 worktree.path）。 */
  effectiveCwd: string
  agentName: string
  /** 归属：派生它的父会话。 */
  parentConversationId: number
  /** agent_spawn 的 agentId（resume 定位键）。 */
  agentId?: string
  /** 派生它的 workflow run；单回合 subagent 为 undefined。 */
  workflowRunId?: string
  /** 当前生命周期形态。 */
  outcome: PaneOutcome
  /** 交接文件名（成功清理后清空）。 */
  outputFileName?: string
  createdAt: number
  settledAt?: number
  /** 失败时的脱敏诊断摘要（保留现场说明）。 */
  failureNote?: string
}

/** 持久化镜像形状（ctx.doc 'managed'；仅非机密字段）。 */
export interface ManagedDoc {
  version: 1
  panes: Array<{
    machine?: string
    paneId: string
    tabId: string
    workspaceId?: string
    worktree?: { path: string; branch?: string }
    effectiveCwd: string
    agentName: string
    parentConversationId: number
    agentId?: string
    workflowRunId?: string
    outcome: PaneOutcome
    createdAt: number
    settledAt?: number
    failureNote?: string
  }>
}

export const EMPTY_MANAGED_DOC: ManagedDoc = { version: 1, panes: [] }

export function targetOf(pane: { machine?: string }): HerdrTarget {
  return pane.machine === undefined ? {} : { machine: pane.machine }
}

/**
 * 窗格登记表（进程内权威状态 + 持久镜像写入端口）。
 * 所有查询/变更都在内存表上完成；变更后同步刷镜像（失败如实上抛）。
 */
export class PaneRegistry {
  private readonly panes = new Map<string, ManagedPane>()
  /** paneId -> 简洁归属键（machine|local : paneId），与 Ask id 命名一致。 */
  private readonly mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void }

  constructor(mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void }, restored?: ManagedDoc) {
    this.mirror = mirror
    if (restored) {
      for (const pane of restored.panes) {
        this.panes.set(scopeKey(pane.machine, pane.paneId), {
          machine: pane.machine,
          paneId: pane.paneId,
          tabId: pane.tabId,
          workspaceId: pane.workspaceId,
          worktree: pane.worktree,
          effectiveCwd: pane.effectiveCwd,
          agentName: pane.agentName,
          parentConversationId: pane.parentConversationId,
          agentId: pane.agentId,
          workflowRunId: pane.workflowRunId,
          outcome: pane.outcome,
          createdAt: pane.createdAt,
          settledAt: pane.settledAt,
          failureNote: pane.failureNote,
        })
      }
    }
  }

  add(pane: ManagedPane): void {
    this.panes.set(scopeKey(pane.machine, pane.paneId), pane)
    this.flush()
  }

  get(machine: string | undefined, paneId: string): ManagedPane | undefined {
    return this.panes.get(scopeKey(machine, paneId))
  }

  /** 按 agentId 定位（resume 用；同父会话约束由调用方校验）。 */
  findByAgentId(agentId: string): ManagedPane | undefined {
    for (const pane of this.panes.values()) if (pane.agentId === agentId) return pane
    return undefined
  }

  /** 按 workflow run 定位全部 pane。 */
  findByWorkflow(workflowRunId: string): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.workflowRunId === workflowRunId)
  }

  /** 按父回合定位全部 pane。 */
  findByParent(parentConversationId: number): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.parentConversationId === parentConversationId)
  }

  all(): ManagedPane[] {
    return [...this.panes.values()]
  }

  update(machine: string | undefined, paneId: string, patch: Partial<ManagedPane>): ManagedPane | undefined {
    const key = scopeKey(machine, paneId)
    const pane = this.panes.get(key)
    if (!pane) return undefined
    this.panes.set(key, { ...pane, ...patch })
    this.flush()
    return this.panes.get(key)
  }

  remove(machine: string | undefined, paneId: string): void {
    if (this.panes.delete(scopeKey(machine, paneId))) this.flush()
  }

  /** liveTasks 标签：仍运行 + 成功保活待结算（失败/已结算不计）。 */
  liveTaskLabels(): string[] {
    const labels: string[] = []
    for (const pane of this.panes.values()) {
      if (pane.outcome === 'running') labels.push(`herdr-pane:${pane.paneId}`)
      else if (pane.outcome === 'keepalive') labels.push(`herdr-keepalive:${pane.paneId}`)
    }
    return labels
  }

  /** 非机密对账视图（重启扫描用）。 */
  snapshot(): ManagedDoc {
    return {
      version: 1,
      panes: this.all().map((p) => ({
        ...(p.machine !== undefined ? { machine: p.machine } : {}),
        paneId: p.paneId,
        tabId: p.tabId,
        ...(p.workspaceId !== undefined ? { workspaceId: p.workspaceId } : {}),
        ...(p.worktree !== undefined ? { worktree: p.worktree } : {}),
        effectiveCwd: p.effectiveCwd,
        agentName: p.agentName,
        parentConversationId: p.parentConversationId,
        ...(p.agentId !== undefined ? { agentId: p.agentId } : {}),
        ...(p.workflowRunId !== undefined ? { workflowRunId: p.workflowRunId } : {}),
        outcome: p.outcome,
        createdAt: p.createdAt,
        ...(p.settledAt !== undefined ? { settledAt: p.settledAt } : {}),
        ...(p.failureNote !== undefined ? { failureNote: p.failureNote } : {}),
      })),
    }
  }

  private flush(): void {
    this.mirror.set(this.snapshot())
  }
}

export function scopeKey(machine: string | undefined, paneId: string): string {
  return `${machine ?? 'local'}:${paneId}`
}
