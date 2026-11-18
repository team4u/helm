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
  options: { conversationId?: number; enabled?: boolean } = {},
): SwarmBoardFallbackState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const enabled = options.enabled !== false
  const [view, setView] = useState<BoardViewDoc | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [nonce, setNonce] = useState(0)
  const generation = useRef(0)

  const reload = useCallback(() => {
    setNonce((n) => n + 1)
  }, [])

  useEffect(() => {
    if (!enabled || groupId === undefined || groupId === '') {
      setView(undefined)
      setError(undefined)
      setLoading(false)
      return
    }
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction('board_status', { groupId }, { conversationId: options.conversationId })
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
  }, [enabled, groupId, options.conversationId, ctx, locale, nonce])

  return { view, loading, error, reload }
}

export interface SwarmBoardReadState {
  posts: BoardPost[]
  loading: boolean
  error: string | undefined
}

/**
 * On-demand `board_read` history loader for the "show full record" affordance
 * in the workbench panel (loads once per group; callers merge into the view).
 */
export function useSwarmBoardReadOnce(
  groupId: string | undefined,
  open: boolean,
  options: { conversationId?: number } = {},
): SwarmBoardReadState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [posts, setPosts] = useState<BoardPost[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const generation = useRef(0)
  const loadedKey = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (!open || groupId === undefined || groupId === '') return
    if (loadedKey.current === groupId) return
    loadedKey.current = groupId
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    void ctx
      .callAction('board_read', { groupId, limit: 200 }, { conversationId: options.conversationId })
      .then((raw) => {
        if (generation.current !== current) return
        const parsed = parseBoardReadPosts(raw)
        if (parsed.length === 0 && !Array.isArray((raw as { posts?: unknown })?.posts)) {
          setError(panelStatusInvalid(locale))
          return
        }
        setPosts(parsed)
      })
      .catch((err: unknown) => {
        if (generation.current !== current) return
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (generation.current === current) setLoading(false)
      })
  }, [open, groupId, options.conversationId, ctx, locale])

  return { posts, loading, error }
}
