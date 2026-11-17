/**
 * Data hooks for the builtin:workflow plugin (sharing the host store, zero
 * private dependencies). models.ts keeps pure functions only; hook
 * dependencies live in this file for index.tsx components to consume.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkflowRunSummary } from '../../contracts.js'
import {
  useConversation,
  useConversations,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginSessionDoc,
} from '@helm/plugin-client'
import { isScrolledToBottom } from './model-format.ts'
import { parseSavedWorkflowList } from './model-library.ts'
import type { SavedWorkflowView } from './model-library.ts'
import { libListInvalid } from './copy.ts'

/** Follow streaming output only while the user stays pinned to the bottom; never steal scroll position after scrolling up into history. */
export function useStreamFollow(content: unknown) {
  const ref = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const onScroll = useCallback(() => {
    if (ref.current !== null) follow.current = isScrolledToBottom(ref.current)
  }, [])
  useEffect(() => {
    if (follow.current && ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight
  }, [content])
  return { ref, onScroll }
}

/** Subscribe to the builtin:workflow public runs doc (conversation shard, only the current conversation's run list). */
export function useWorkflowRunsDoc<T = { runs: WorkflowRunSummary[] }>(docName: string, conversationId: number | undefined): T | undefined {
  return usePluginSessionDoc<T>(docName, conversationId !== undefined ? { conversationId } : undefined)
}

/** Running stopwatch: SSR first frame starts no clock; only the client-side useEffect advances it (deterministic rendering). */
export function useElapsedNowMs(active: boolean): number | undefined {
  const [nowMs] = useElapsedState(active)
  return nowMs
}

/** Workflow library loading state: list action + generation guard (reloads never splice stale responses). */
export interface WorkflowLibraryState {
  items: SavedWorkflowView[] | undefined
  error: string | undefined
  loading: boolean
  reload: () => Promise<void>
}

/** Load the saved workflow catalog (list action; strict parsing — structurally invalid fails explicitly, never fabricated). */
export function useWorkflowLibrary(): WorkflowLibraryState {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [items, setItems] = useState<SavedWorkflowView[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)

  const reload = useCallback(async (): Promise<void> => {
    const current = ++generation.current
    setLoading(true)
    setError(undefined)
    try {
      const raw = await ctx.callAction('list')
      if (generation.current !== current) return
      const parsed = parseSavedWorkflowList(raw)
      if (parsed === undefined) {
        setError(libListInvalid(locale))
      } else {
        setItems(parsed)
      }
    } catch (err) {
      if (generation.current !== current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (generation.current === current) setLoading(false)
    }
  }, [ctx, locale])

  useEffect(() => {
    void reload()
  }, [reload])

  return { items, error, loading, reload }
}

function useElapsedState(active: boolean): [number | undefined, (v: number) => void] {
  const [nowMs, setNowMs] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (!active) return
    setNowMs(Date.now())
    const timer = globalThis.setInterval?.(() => setNowMs(Date.now()), 1000)
    return () => {
      if (timer !== undefined) globalThis.clearInterval?.(timer)
    }
  }, [active])
  return [nowMs, setNowMs]
}

export { useConversation, useConversations, usePluginContext, usePluginDoc, usePluginSessionDoc }
