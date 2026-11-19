/**
 * builtin:swarm 全局反查索引与实时看板投影（自 group-store 拆出）。
 *
 * 三层派生投影（全量派生自单真源 groupsById，零双写漂移）：
 * 1) 全局轻量反查索引：ctx.doc('index')（workers 与 groups）；
 * 2) 会话级实时看板投影：ctx.sessionDoc('board-view')（按 coordinatorConversationId 键控，
 *    以 (headSeq, memberStateDigest) 指纹去重，流式生成帧 0 写放大）；
 * 3) 顶栏与侧栏角标：ctx.doc('board-badges')（主控与全体活跃成员 O(1) 反查）。
 */
import {
  MAX_INDEX_CLOSED_GROUPS,
  toGroupSummary,
  type BoardBadgesDoc,
  type BoardPost,
  type CollabGroupRecord,
  type MemberLiveState,
  type SwarmCoordinator,
  type SwarmWorkerPointer,
} from './contracts.js'
import { synthesizeBoardView } from './board-router.js'

/** 投影模块对组存储门面的最小依赖端口。 */
export interface ProjectionPorts {
  readonly getCoordinator: () => SwarmCoordinator
  readonly isStopping: () => boolean
  readonly getAllGroups: () => CollabGroupRecord[]
  /** 未懒加载 board.jsonl 的组返回 undefined（不写空黑板假投影）。 */
  readonly getPosts: (groupId: string) => readonly BoardPost[] | undefined
  readonly resolveMemberLive: (conversationId: number) => { liveState: MemberLiveState; model?: string }
}

/** 索引 / 看板 / 角标投影能力（由 group-store 组合根装配后使用）。 */
export interface BoardProjections {
  syncIndex(): void
  syncProjections(): void
  /** 清空全部投影指纹与已写快照（loadAllFromDisk / stopAndClear 阶段）。 */
  reset(): void
  /** 会话删除后清除其投影登记。 */
  forgetCoordinator(conversationId: number): void
}

export function createBoardProjections(ports: ProjectionPorts): BoardProjections {
  /** coordinatorConversationId -> 上次写入 sessionDoc('board-view') 的去重指纹。 */
  const writtenViewDigests = new Map<number, string>()
  /** 已写入过 board-view 的主控会话集合（用于清理或停止阶段核对）。 */
  const projectedCoordinators = new Set<number>()
  /** 上次写入 doc('index') / doc('board-badges') 的序列化快照。 */
  let writtenIndexJson = ''
  let writtenBadgesJson = ''

  const syncIndex = (): void => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || coord.isShutdown()) return
    const activeGroups = ports.getAllGroups()
      .filter((g) => g.status === 'active')
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
    const closedGroups = ports.getAllGroups()
      .filter((g) => g.status === 'closed')
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, MAX_INDEX_CLOSED_GROUPS)
    const ordered = [...activeGroups, ...closedGroups]
    const summaries = ordered.map((g) => toGroupSummary(g))
    const workers: SwarmWorkerPointer[] = activeGroups.flatMap((g) =>
      g.members
        .filter((m) => m.lifecycle === 'active')
        .map((m) => ({
          conversationId: m.conversationId,
          coordinatorConversationId: g.coordinatorConversationId,
          profileId: m.profileId,
          groupId: g.id,
          name: m.name,
          createdAt: m.createdAt,
        })),
    )
    const nextIndex = { workers, groups: summaries }
    const nextJson = JSON.stringify(nextIndex)
    if (nextJson !== writtenIndexJson) {
      coord.writeIndex(nextIndex)
      writtenIndexJson = nextJson
    }
  }

  const syncProjections = (): void => {
    const coord = ports.getCoordinator()
    if (ports.isStopping() || coord.isShutdown()) return
    const docs = coord.getDocs()
    const previewLimit = coord.getConfig().boardPreviewLimit

    const targetGroupByCoordinator = new Map<number, CollabGroupRecord>()
    const orderedGroups = ports.getAllGroups().sort(
      (a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    )
    for (const group of orderedGroups) {
      const existing = targetGroupByCoordinator.get(group.coordinatorConversationId)
      if (existing === undefined || (existing.status !== 'active' && group.status === 'active')) {
        targetGroupByCoordinator.set(group.coordinatorConversationId, group)
      }
    }

    const byConversation: BoardBadgesDoc['byConversation'] = {}

    for (const [coordId, group] of targetGroupByCoordinator) {
      const coordConv = coord.readConversationOrUndefined(coordId)
      const posts = ports.getPosts(group.id)
      if (posts === undefined) {
        // 已结单且尚未按需懒加载 board.jsonl：不写空黑板假投影，清除陈旧投影以便面板走 board_status 回退
        if (projectedCoordinators.has(coordId) && coordConv !== undefined) {
          docs.boardView.set(coordId, null)
        }
        writtenViewDigests.delete(coordId)
        projectedCoordinators.delete(coordId)
        continue
      }
      const { view, digest, badge } = synthesizeBoardView({
        group,
        posts,
        previewLimit,
        resolveMemberLive: ports.resolveMemberLive,
      })

      if (coordConv !== undefined && !group.coordinatorDetached) {
        if (writtenViewDigests.get(coordId) !== digest) {
          docs.boardView.set(coordId, view)
          writtenViewDigests.set(coordId, digest)
          projectedCoordinators.add(coordId)
        }
      } else {
        writtenViewDigests.delete(coordId)
        projectedCoordinators.delete(coordId)
      }

      if (group.status === 'active') {
        if (coordConv !== undefined && !group.coordinatorDetached) {
          byConversation[String(coordId)] = badge
        }
        for (const member of group.members) {
          if (member.lifecycle !== 'active') continue
          if (coord.readConversationOrUndefined(member.conversationId) === undefined) continue
          byConversation[String(member.conversationId)] = badge
        }
      }
    }

    for (const coordId of [...projectedCoordinators]) {
      if (targetGroupByCoordinator.has(coordId)) continue
      if (coord.readConversationOrUndefined(coordId) !== undefined) {
        docs.boardView.set(coordId, null)
      }
      projectedCoordinators.delete(coordId)
      writtenViewDigests.delete(coordId)
    }

    const nextBadgesJson = JSON.stringify(byConversation)
    if (nextBadgesJson !== writtenBadgesJson) {
      docs.boardBadges.set({ byConversation })
      writtenBadgesJson = nextBadgesJson
    }
  }


  const projections: BoardProjections = {
    syncIndex,
    syncProjections,

    reset(): void {
      writtenViewDigests.clear()
      projectedCoordinators.clear()
      writtenIndexJson = ''
      writtenBadgesJson = ''
    },

    forgetCoordinator(conversationId: number): void {
      projectedCoordinators.delete(conversationId)
      writtenViewDigests.delete(conversationId)
    },
  }

  return projections
}
