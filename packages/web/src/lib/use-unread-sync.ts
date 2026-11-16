/**
 * 前台可见聚焦门控自动清未读与可见会话首载同步 hook。
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { ArtifactMetadata, ConversationDetail, ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from './api.js'
import { isPageActive } from './browser-notification.js'
import { errorText } from './format.js'
import type { LiveState } from './live-state.js'
import type { ResolvedTarget, ToastNotice } from './types.js'

export interface UseUnreadSyncOptions {
  authenticated: boolean
  authenticatedRef: MutableRefObject<boolean>
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  liveRef: MutableRefObject<LiveState>
  session: MutableRefObject<number>
  loadConversationDetail: (conversationId: number, force?: boolean) => Promise<ConversationDetail | undefined>
  loadConversationArtifacts: (conversationId: number) => Promise<ArtifactMetadata[] | undefined>
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
}

export interface UseUnreadSyncResult {
  unreadClearInFlight: MutableRefObject<Set<number>>
  unreadClearedSeq: MutableRefObject<Map<number, number>>
  visibleConversationIds: () => number[]
  clearVisibleConversationUnread: (id: number, candidate?: ConversationSummary) => void
  resetUnreadSync: () => void
}

export function useUnreadSync({
  authenticated,
  authenticatedRef,
  primaryTarget,
  splitTarget,
  targets,
  liveRef,
  session,
  loadConversationDetail,
  loadConversationArtifacts,
  pushNotice,
}: UseUnreadSyncOptions): UseUnreadSyncResult {
  const unreadClearInFlight = useRef(new Set<number>())
  const unreadClearedSeq = useRef(new Map<number, number>())

  const visibleConversationIds = useCallback((): number[] => {
    const ids = new Set<number>()
    for (const target of [targets.current.primaryTarget, targets.current.splitTarget]) {
      if (target?.kind === 'conversation') ids.add(target.conversationId)
    }
    return [...ids]
  }, [targets])

  const resetUnreadSync = useCallback(() => {
    unreadClearInFlight.current.clear()
    unreadClearedSeq.current.clear()
  }, [])

  /**
   * 前台可见聚焦门控自动清未读（单飞 + stateChangeSeq 水位防重）：
   * - 仅当 authenticated && isPageActive() 且会话当前 unread=true 时才发 PATCH；
   * - 请求在途期间由 unreadClearInFlight 去重，成功后记录 requestedSeq 水位，
   *   在 SSE upsert 尚未将 unread 翻为 false 期间拦截 visibilitychange+focus 连发；
   * - 收到 unread=false 或 stateChangeSeq 推进且仍 unread=true 时允许下次清零；
   * - 失败只报 toast 通知，绝不污染 loadErrors['conversation:id']。
   */
  const clearVisibleConversationUnread = useCallback(
    (id: number, candidate?: ConversationSummary): void => {
      const summary = candidate ?? liveRef.current.conversations.find((conv) => conv.id === id)
      if (summary === undefined) return
      if (!summary.unread) {
        unreadClearedSeq.current.delete(id)
        return
      }
      if (!authenticatedRef.current || !isPageActive()) return
      if (unreadClearInFlight.current.has(id)) return
      const clearedSeq = unreadClearedSeq.current.get(id)
      if (clearedSeq !== undefined && summary.stateChangeSeq <= clearedSeq) return
      const epoch = session.current
      const requestedSeq = summary.stateChangeSeq
      unreadClearInFlight.current.add(id)
      void conversationsApi
        .patch(id, { unread: false })
        .then((updated) => {
          if (epoch !== session.current) return
          unreadClearInFlight.current.delete(id)
          const latest = liveRef.current.conversations.find((conv) => conv.id === id)
          if (latest !== undefined && !latest.unread) {
            unreadClearedSeq.current.delete(id)
            return
          }
          const updatedSeq =
            typeof updated?.stateChangeSeq === 'number' && updated.unread === false
              ? updated.stateChangeSeq
              : requestedSeq
          const ackSeq = Math.max(requestedSeq, updatedSeq)
          if (
            latest !== undefined &&
            latest.unread &&
            latest.stateChangeSeq > ackSeq &&
            visibleConversationIds().includes(id)
          ) {
            unreadClearedSeq.current.set(id, ackSeq)
            clearVisibleConversationUnread(id, latest)
            return
          }
          if (latest === undefined) return
          unreadClearedSeq.current.set(id, ackSeq)
        })
        .catch((error: unknown) => {
          if (epoch === session.current) {
            unreadClearInFlight.current.delete(id)
            pushNotice({
              type: 'notification',
              level: 'error',
              title: 'Failed to mark as read',
              body: errorText(error),
            })
          }
        })
    },
    [authenticatedRef, liveRef, pushNotice, session, visibleConversationIds],
  )

  useEffect(() => {
    if (!authenticated) return
    for (const id of visibleConversationIds()) {
      void loadConversationDetail(id)
      void loadConversationArtifacts(id)
      clearVisibleConversationUnread(id)
    }
  }, [
    authenticated,
    primaryTarget,
    splitTarget,
    loadConversationDetail,
    loadConversationArtifacts,
    visibleConversationIds,
    clearVisibleConversationUnread,
  ])

  // 切回前台且窗口恢复聚焦时补清当前主屏/分屏可见会话未读（登出/卸载自动解绑）。
  useEffect(() => {
    if (!authenticated || typeof document === 'undefined' || typeof window === 'undefined') return
    const onPageActive = () => {
      if (!isPageActive()) return
      for (const id of visibleConversationIds()) {
        clearVisibleConversationUnread(id)
      }
    }
    document.addEventListener('visibilitychange', onPageActive)
    window.addEventListener('focus', onPageActive)
    return () => {
      document.removeEventListener('visibilitychange', onPageActive)
      window.removeEventListener('focus', onPageActive)
    }
  }, [authenticated, visibleConversationIds, clearVisibleConversationUnread])

  return {
    unreadClearInFlight,
    unreadClearedSeq,
    visibleConversationIds,
    clearVisibleConversationUnread,
    resetUnreadSync,
  }
}
