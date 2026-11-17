import { Activity } from 'react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useConversations, useStoreActions } from '../lib/store-context.js'
import { ConversationPane } from './ConversationPane.js'
import {
  clearComposerDirty,
  isComposerDirtySnapshot,
  setComposerDirty,
  type ComposerDirtySnapshot,
} from './composer-dirty.js'
import {
  ConversationDirtySinkContext,
  DEFAULT_CONVERSATION_WINDOW_LIMIT,
  pruneConversationWindows,
  touchConversationWindows,
  type ConversationWindowEntry,
} from './conversation-window-model.js'

export interface ConversationWindowStageProps {
  /** Currently shown primary conversation; null while the primary target is not a conversation. */
  activeConversationId: number | null
  /** Bounded keep-alive capacity; the active window is never evicted. */
  limit?: number
}

/**
 * Primary-slot conversation window stage: mounts one <Activity> per kept-alive conversation
 * window and only flips modes on switches. The stage itself stays mounted across non-
 * conversation targets (agent standby, screens, settings centers), so returning to a
 * conversation restores the previous window instead of remounting it. Split-slot panes keep
 * the existing keyed conditional rendering (documented follow-up).
 */
export function ConversationWindowStage({
  activeConversationId,
  limit = DEFAULT_CONVERSATION_WINDOW_LIMIT,
}: ConversationWindowStageProps) {
  const conversations = useConversations()
  const [windows, setWindows] = useState<ReadonlyArray<ConversationWindowEntry>>([])
  // Catalog-loaded marker: an empty conversation list means "not yet loaded" during the boot
  // deep-link beat (a freshly opened window must not be pruned before the SSE snapshot
  // arrives), but "cleared" once a non-empty catalog has been seen — logout resets live
  // state to empty and every kept-alive window (plus its dirty report) must go.
  const catalogLoadedRef = useRef(false)

  // Activation LRU runs before paint: a newly opened conversation must never flash an empty
  // pane, and eviction of the overflow happens in the same beat.
  useLayoutEffect(() => {
    if (activeConversationId === null) return
    setWindows((current) => touchConversationWindows(current, activeConversationId, limit))
  }, [activeConversationId, limit])

  useLayoutEffect(() => {
    if (conversations.length > 0) {
      catalogLoadedRef.current = true
      setWindows((current) => pruneConversationWindows(current, new Set(conversations.map((c) => c.id))))
      return
    }
    if (!catalogLoadedRef.current) return
    // Loaded-then-empty (logout live-state reset, or every conversation removed): drop the
    // whole pool — unmount clears the frames' re-published dirty reports with it.
    catalogLoadedRef.current = false
    setWindows((current) => (current.length === 0 ? current : []))
  }, [conversations])

  return (
    <div
      className={activeConversationId === null ? 'conversation-window-stage is-idle' : 'conversation-window-stage'}
      data-conversation-windows={windows.length}
    >
      {windows.map((window) => (
        <ConversationWindowFrame
          key={window.conversationId}
          conversationId={window.conversationId}
          visible={window.conversationId === activeConversationId}
        />
      ))}
    </div>
  )
}

interface ConversationWindowFrameProps {
  conversationId: number
  visible: boolean
}

function ConversationWindowFrame({ conversationId, visible }: ConversationWindowFrameProps) {
  const { loadConversationDetail } = useStoreActions()
  const dirtySink = useRef<ComposerDirtySnapshot | null>(null)
  const frameDirtyKey = `conversation-window:${conversationId}`
  const wasVisibleRef = useRef(visible)

  // Dirty-draft bridge across Activity hides: hiding destroys the Composer's effect-managed
  // report while the draft survives in component state, so the frame (outside the Activity
  // boundary) re-publishes the last visible snapshot until the window wakes or is evicted.
  // Child effects settle before parent effects, so the wake path also clears this report
  // after the Composer's own report has been re-created — the aggregate stays truthful.
  useEffect(() => {
    if (visible) {
      clearComposerDirty(frameDirtyKey)
      return
    }
    const snapshot = dirtySink.current
    if (snapshot !== null && isComposerDirtySnapshot(snapshot)) setComposerDirty(frameDirtyKey, snapshot)
    else clearComposerDirty(frameDirtyKey)
    return () => clearComposerDirty(frameDirtyKey)
  }, [visible, frameDirtyKey])

  // Wake refresh: kept-alive (hidden) conversations sit outside the store's visible set, so a
  // window can wake with a stale detail snapshot; refresh silently — the timeline's SWR anchor
  // restore keeps the reading position stable across the background refresh.
  useEffect(() => {
    const wasVisible = wasVisibleRef.current
    wasVisibleRef.current = visible
    if (!visible || wasVisible) return
    void loadConversationDetail(conversationId, true, { silent: true })
  }, [visible, conversationId, loadConversationDetail])

  return (
    <ConversationDirtySinkContext.Provider value={dirtySink}>
      <Activity mode={visible ? 'visible' : 'hidden'}>
        <ConversationPane conversationId={conversationId} staged={visible} />
      </Activity>
    </ConversationDirtySinkContext.Provider>
  )
}
