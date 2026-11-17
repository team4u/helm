/**
 * Foreground-visibility-gated automatic unread clearing and visible-conversation
 * first-load sync hook.
 */
import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { ArtifactMetadata, ConversationDetail, ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from './api.js'
import { isPageActive } from './browser-notification.js'
import { errorText } from './format.js'
import type { LiveState } from './live-state.js'
import type { ResolvedTarget, ToastNotice } from './types.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'

export interface ArtifactsSyncWatermark {
  stateChangeSeq: number
  lastEntryId: number | undefined
}

/** 是否处于执行中（working 或 blocked 审批阻塞）：活跃期不作为产物稳定水位，也不在事件流中反复全量拉取产物。 */
export function isConversationStatusActive(status: ConversationSummary['status']): boolean {
  return status === 'working' || status === 'blocked'
}

/** 判定当前缓存的产物列表是否已对齐会话最新非活跃水位（stateChangeSeq + lastEntryId）。 */
export function isArtifactsWatermarkCurrent(
  cachedArtifacts: ReadonlyArray<ArtifactMetadata> | undefined,
  summary: Pick<ConversationSummary, 'status' | 'stateChangeSeq' | 'lastEntryId'> | undefined,
  watermark: ArtifactsSyncWatermark | undefined,
): boolean {
  return (
    cachedArtifacts !== undefined &&
    summary !== undefined &&
    !isConversationStatusActive(summary.status) &&
    watermark !== undefined &&
    watermark.stateChangeSeq === summary.stateChangeSeq &&
    watermark.lastEntryId !== undefined &&
    summary.lastEntryId !== undefined &&
    watermark.lastEntryId === summary.lastEntryId
  )
}

export interface UseUnreadSyncOptions {
  authenticated: boolean
  authenticatedRef: MutableRefObject<boolean>
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  targets: MutableRefObject<{ primaryTarget: ResolvedTarget; splitTarget: ResolvedTarget | null }>
  liveRef: MutableRefObject<LiveState>
  conversationArtifactsRef?: MutableRefObject<Record<number, ArtifactMetadata[]>>
  artifactsWatermarksRef?: MutableRefObject<Map<number, ArtifactsSyncWatermark>>
  session: MutableRefObject<number>
  loadConversationDetail: (
    conversationId: number,
    force?: boolean,
    opts?: { silent?: boolean; limit?: number },
  ) => Promise<ConversationDetail | undefined>
  loadConversationArtifacts: (conversationId: number, opts?: { silent?: boolean }) => Promise<ArtifactMetadata[] | undefined>
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
  /**
   * Locale seam: this hook runs inside HelmStoreProvider's own body (no
   * context access); the Provider does not pass `t` yet, so the English bridge
   * translator keeps today's behavior until the wiring lands.
   */
  t?: WebMessageTranslator
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
  conversationArtifactsRef,
  artifactsWatermarksRef,
  session,
  loadConversationDetail,
  loadConversationArtifacts,
  pushNotice,
  t,
}: UseUnreadSyncOptions): UseUnreadSyncResult {
  const tt = t ?? englishWebTranslator
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
   * Foreground-visibility-gated automatic unread clearing (single-flight +
   * stateChangeSeq watermark dedup):
   * - PATCH only when authenticated && isPageActive() and the conversation is
   *   currently unread=true;
   * - requests in flight are deduped by unreadClearInFlight; after success the
   *   requestedSeq watermark is recorded, intercepting visibilitychange+focus
   *   bursts while SSE upsert has not yet flipped unread to false;
   * - receiving unread=false, or stateChangeSeq advancing while still
   *   unread=true, allows the next clearing;
   * - failures only report a toast notice and never pollute
   *   loadErrors['conversation:id'].
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
              title: tt('shell.unread.markFailed'),
              body: errorText(error),
            })
          }
        })
    },
    [authenticatedRef, liveRef, pushNotice, session, tt, visibleConversationIds],
  )

  useEffect(() => {
    if (!authenticated) return
    for (const id of visibleConversationIds()) {
      void loadConversationDetail(id)
      const cachedArtifacts = conversationArtifactsRef?.current[id]
      const summary = liveRef.current.conversations.find((conv) => conv.id === id)
      const wm = artifactsWatermarksRef?.current.get(id)
      const artifactsUnchanged = isArtifactsWatermarkCurrent(cachedArtifacts, summary, wm)
      if (!artifactsUnchanged) {
        void loadConversationArtifacts(id)
      }
      clearVisibleConversationUnread(id)
    }
  }, [
    authenticated,
    primaryTarget,
    splitTarget,
    liveRef,
    conversationArtifactsRef,
    artifactsWatermarksRef,
    loadConversationDetail,
    loadConversationArtifacts,
    visibleConversationIds,
    clearVisibleConversationUnread,
  ])

  // When the tab becomes visible and the window refocused, catch up on clearing
  // unread for the currently visible main/split conversations (logout/unmount
  // unbinds automatically).
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
