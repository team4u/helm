/**
 * 受管窗格登记表：scopeKey(machine, paneId) -> 归属/父子/workflow/实际 cwd/目标/清理通道。
 *
 * 职责：
 * - 记录本插件创建的每个 Herdr 窗格（tab/worktree 两种形态）及其**冻结连接目标**
 *   （启用时确定，非机密：machine/session/socketPath）——同一窗格的所有命令、事件、
 *   文件与清理永远走同一 HerdrTarget，绝不热换连接去误伤另一台服务器上的同 ID 窗格；
 * - 记录 spawn 路由（agent kind / Profile id）供无 agentType 的真实 resume 续接；
 * - 支持同 workflow 或同父回合 resume 定位（稳定 agentId 或 paneId 双键）；
 * - 区分「成功保活待结算」与「失败保留现场」（失败 pane 不参与自动清理）。
 */

import { HelmError } from '@helm/protocol'
import type { HerdrTarget } from './contracts.js'

export type PaneOutcome = 'running' | 'keepalive' | 'failed' | 'settled'

/** spawn 路由快照（resume 缺 agentType 时沿用；kind 与 Profile 定位均非机密）。 */
export interface PaneRouting {
  kind: string
  /** 命中的 Profile ID（Profile 入口时存在；前缀直调为 undefined）。 */
  profileId?: string
}

export interface ManagedPane {
  /** 冻结连接目标（启用周期内不变；远端含 machine，本机为 session/socketPath/{}）。 */
  target: HerdrTarget
  paneId: string
  tabId: string
  /** worktree 模式下的 workspace 与工作树（普通 tab 模式为 undefined）。 */
  workspaceId?: string
  worktree?: { path: string; branch?: string }
  /** 实际生效工作目录（worktree 模式为 worktree.path；resume 缺省沿用）。 */
  effectiveCwd: string
  agentName: string
  /** spawn 路由快照（resume 沿用 kind / Profile）。 */
  routing: PaneRouting
  /** 归属：派生它的父会话。 */
  parentConversationId: number
  /** agent_spawn 的稳定 agentId（workflow resume 键）。 */
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
    target: { machine?: string; session?: string; socketPath?: string }
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
    outcome: PaneOutcome
    createdAt: number
    settledAt?: number
    failureNote?: string
  }>
}

export const EMPTY_MANAGED_DOC: ManagedDoc = { version: 1, panes: [] }

export function targetOf(pane: { target: HerdrTarget }): HerdrTarget {
  return pane.target
}

/** 目标机标识（undefined = 本机）；所有归属匹配/查询统一经此取值。 */
export function machineOf(pane: { target?: HerdrTarget }): string | undefined {
  return pane.target?.machine
}

/**
 * 窗格登记表（进程内权威状态 + 持久镜像写入端口）。
 */
export class PaneRegistry {
  private readonly panes = new Map<string, ManagedPane>()
  private readonly mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void }

  constructor(mirror: { get(): ManagedDoc; set(doc: ManagedDoc): void }, restored?: ManagedDoc) {
    this.mirror = mirror
    if (restored) {
      for (const pane of restored.panes) {
        if (!pane.target || !pane.routing || typeof pane.routing.kind !== 'string' || pane.routing.kind === '') {
          throw new HelmError('herdr_managed_invalid', 'Herdr 受管记录缺少 target/routing', 500)
        }
        this.panes.set(scopeKey(pane.target.machine, pane.paneId), {
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
          outputFileName: undefined,
          createdAt: pane.createdAt,
          settledAt: pane.settledAt,
          failureNote: pane.failureNote,
        })
      }
    }
  }

  add(pane: ManagedPane): void {
    this.panes.set(scopeKey(machineOf(pane), pane.paneId), pane)
    this.flush()
  }

  get(machine: string | undefined, paneId: string): ManagedPane | undefined {
    return this.panes.get(scopeKey(machine, paneId))
  }

  /** 按稳定 agentId 或 paneId 定位 resume 候选（跨 machine 可能撞 paneId，由调用方裁决歧义）。 */
  findByResumeRef(ref: string): ManagedPane[] {
    return [...this.panes.values()].filter((p) => p.agentId === ref || p.paneId === ref)
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

  /**
   * 仅内存标记 settled（不刷持久镜像）：服务 stop 路径专用——停用中 doc 句柄
   * 已失效（plugin_context_expired），持久状态由下个启用周期对账重建。
   */
  markSettledVolatile(machine: string | undefined, paneId: string): void {
    const pane = this.panes.get(scopeKey(machine, paneId))
    if (pane === undefined) return
    this.panes.set(scopeKey(machine, paneId), { ...pane, outcome: 'settled', settledAt: Date.now() })
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
