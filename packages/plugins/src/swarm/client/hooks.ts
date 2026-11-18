/**
 * Data hooks for the builtin:swarm client (host store driven, zero private
 * dependencies; pure functions live in *-model.ts, display copy in copy.ts).
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { usePluginContext, usePluginLocale, useSharedNowMs } from '@helm/plugin-client'
import { parseBoardReadPosts, parseBoardView, type BoardPost, type BoardViewDoc } from './board-model.ts'
import { panelStatusInvalid } from './copy.ts'

/** Shared 1Hz stopwatch (SSR first frame returns undefined). */
export function useElapsedNowMs(active: boolean): number | undefined {
  return useSharedNowMs(active)
}

export interface SwarmBoardFallbackState {
  view: BoardViewDoc | undefined
  loading: boolean
  error: string | undefined
  reload: () => void
}

/**
 * Explicit one-shot `board_status` fallback for groups without a live
 * board-view session doc (closed / coordinatorDetached / projection pending):
 * strict boundary parsing — structurally invalid payloads fail explicitly with
 * a Retry affordance, never a fabricated "running" board.
 */
export function useSwarmBoardStatusFallback(
  groupId: string | undefined,
  options: { conversationId?: number; enabled?: boolean; allowConversationLookup?: boolean } = {},
): SwarmBoardFallbackState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const enabled = options.enabled !== false
  const allowConversationLookup = options.allowConversationLookup === true
  const [view, setView] = useState<BoardViewDoc | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  const reload = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    const hasGroupId = groupId !== undefined && groupId !== ''
    const canLookupByConv = allowConversationLookup && options.conversationId !== undefined
    if (!enabled || (!hasGroupId && !canLookupByConv)) {
      setView(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    const input = hasGroupId ? { groupId } : {}
    void ctx
      .callAction('board_status', input, { conversationId: options.conversationId })
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardView(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          setView(undefined)
          return
        }
        setView(parsed)
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
        setView(undefined)
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [enabled, groupId, allowConversationLookup, options.conversationId, ctx, locale, nonce])

  return { view, loading, error, reload }
}

export interface SwarmBoardReadState {
  posts: BoardPost[]
  loading: boolean
  error: string | undefined
  retry: () => void
}

/**
 * On-demand `board_read` history loader for the "show full record" affordance
 * in the workbench panel (resets on group switch, tracks headSeq updates, and
 * allows retries on failure; callers merge into the view).
 */
export function useSwarmBoardReadOnce(
  groupId: string | undefined,
  open: boolean,
  options: { conversationId?: number; headSeq?: number } = {},
): SwarmBoardReadState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [posts, setPosts] = useState<BoardPost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)
  const lastGroupId = useRef<string | undefined>(undefined)
  const loadedKey = useRef<string | undefined>(undefined)

  const retry = useCallback(() => {
    loadedKey.current = undefined
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (lastGroupId.current !== groupId) {
      lastGroupId.current = groupId
      loadedKey.current = undefined
      generation.current += 1
      setPosts([])
      setError(undefined)
      setLoading(false)
    }
    if (!open || groupId === undefined || groupId === '') return
    const targetKey = `${groupId}:${options.headSeq ?? 0}`
    if (loadedKey.current === targetKey) return
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction('board_read', { groupId, limit: 200 }, { conversationId: options.conversationId })
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardReadPosts(raw)
        if (parsed === undefined) {
          setError(panelStatusInvalid(locale))
          return
        }
        loadedKey.current = targetKey
        setPosts(parsed)
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [open, groupId, options.headSeq, options.conversationId, ctx, locale, nonce])

  return { posts, loading, error, retry }
}
