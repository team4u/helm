/**
 * 双击 Esc 中止确认窗口状态机 hook：
 * 负责 1.5s 确认窗口武装、提示横幅增删、目标切换/非运行态自动复位及卸载定时器清理。
 */
import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { ConversationDetail, ConversationSummary } from '@helm/protocol/browser'
import { conversationsApi } from './api.js'
import { errorText } from './format.js'
import type { FocusedPanel, ResolvedTarget, ToastNotice } from './types.js'
import {
  activeTargetForPanel,
  ESC_ABORT_WINDOW_MS,
  isConversationAbortable,
} from '../shell/shortcuts-model.js'

const ESC_ABORT_NOTICE_ID = 'esc-abort-confirm'

export interface UseEscAbortOptions {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  focusedPanel: FocusedPanel
  conversations: ConversationSummary[]
  conversationDetails: Record<number, ConversationDetail>
  setNotices: Dispatch<SetStateAction<ToastNotice[]>>
  pushNotice: (notice: Omit<ToastNotice, 'id' | 'createdAt'>) => void
}

export interface UseEscAbortResult {
  pendingEscAbortConversationId: number | null
  clearEscAbortPrompt: () => void
  confirmOrArmEscAbort: (conversationId: number) => void
}

export function useEscAbort({
  primaryTarget,
  splitTarget,
  focusedPanel,
  conversations,
  conversationDetails,
  setNotices,
  pushNotice,
}: UseEscAbortOptions): UseEscAbortResult {
  const [pendingEscAbortConversationId, setPendingEscAbortConversationId] = useState<number | null>(null)
  const escAbortTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingEscAbortRef = useRef<number | null>(null)

  const clearEscAbortPrompt = useCallback(() => {
    if (escAbortTimerRef.current !== null) {
      clearTimeout(escAbortTimerRef.current)
      escAbortTimerRef.current = null
    }
    if (pendingEscAbortRef.current !== null) {
      pendingEscAbortRef.current = null
      setPendingEscAbortConversationId(null)
    }
    setNotices((prev) =>
      prev.some((item) => item.id === ESC_ABORT_NOTICE_ID)
        ? prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID)
        : prev,
    )
  }, [setNotices])

  const armEscAbortPrompt = useCallback((conversationId: number) => {
    if (escAbortTimerRef.current !== null) {
      clearTimeout(escAbortTimerRef.current)
      escAbortTimerRef.current = null
    }
    pendingEscAbortRef.current = conversationId
    setPendingEscAbortConversationId(conversationId)
    setNotices((prev) => [
      ...prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID),
      {
        id: ESC_ABORT_NOTICE_ID,
        type: 'notification',
        level: 'warning',
        title: 'Press Esc again to stop the current execution',
        body: 'Press Esc again within 1.5s to abort the current conversation run',
        conversationId,
        createdAt: Date.now(),
      },
    ])
    escAbortTimerRef.current = setTimeout(() => {
      escAbortTimerRef.current = null
      pendingEscAbortRef.current = null
      setPendingEscAbortConversationId(null)
      setNotices((prev) => prev.filter((item) => item.id !== ESC_ABORT_NOTICE_ID))
    }, ESC_ABORT_WINDOW_MS)
  }, [setNotices])

  const confirmOrArmEscAbort = useCallback((conversationId: number) => {
    if (pendingEscAbortRef.current === conversationId) {
      clearEscAbortPrompt()
      void conversationsApi.abort(conversationId).catch((error: unknown) => {
        pushNotice({
          type: 'notification',
          level: 'error',
          title: 'Failed to stop the current execution',
          body: errorText(error),
          conversationId,
        })
      })
    } else {
      armEscAbortPrompt(conversationId)
    }
  }, [armEscAbortPrompt, clearEscAbortPrompt, pushNotice])

  useEffect(() => {
    if (pendingEscAbortConversationId === null) return
    const activeTarget = activeTargetForPanel(primaryTarget, splitTarget, focusedPanel)
    if (activeTarget.kind !== 'conversation' || activeTarget.conversationId !== pendingEscAbortConversationId) {
      clearEscAbortPrompt()
      return
    }
    const conv = conversations.find((c) => c.id === activeTarget.conversationId)
      ?? conversationDetails[activeTarget.conversationId]
    if (!isConversationAbortable(conv)) clearEscAbortPrompt()
  }, [pendingEscAbortConversationId, primaryTarget, splitTarget, focusedPanel, conversations, conversationDetails, clearEscAbortPrompt])

  useEffect(() => () => {
    if (escAbortTimerRef.current !== null) {
      clearTimeout(escAbortTimerRef.current)
      escAbortTimerRef.current = null
    }
  }, [])

  return {
    pendingEscAbortConversationId,
    clearEscAbortPrompt,
    confirmOrArmEscAbort,
  }
}
