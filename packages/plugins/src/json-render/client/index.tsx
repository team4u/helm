/**
 * builtin:json-render client component: safe JSON card rendering for ```ui
 * chat code blocks.
 *
 * - JSON.parse safe parsing: invalid JSON / non-objects fall back to a plain
 *   code block (honest failure, never fakes success);
 * - streamed incomplete JSON (truncated tail) falls back to source display
 *   until the stream settles; the final content renders normally;
 * - action execution goes through the host-controlled usePluginContext
 *   (callAction / submitInput / openScreen / openArtifact / notify) — no
 *   direct host-store access, no eval / arbitrary JS / arbitrary URLs;
 * - primitive styling lives entirely in this plugin's CSS (styles.css,
 *   compiled into __helmClientCss and injected by the host);
 * - display copy resolves from copy.ts against the active host locale
 *   (usePluginLocale / usePluginTranslator; no independent language state);
 *   spec-declared text and host error details pass through unchanged.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import './styles.css'
import { usePluginContext, usePluginLocale, usePluginTranslator, ViewBoundary, HelmIcon, Callout } from '@helm/plugin-client'
import type { MarkdownCodeBlockProps } from '@helm/protocol'
import { CopyButton } from '@helm/plugin-client'
import { isDegradedNode, normalizeSpec, type NormalizedSpecNode } from './spec-normalize.ts'
import { resolveSpecAction } from './spec-action.ts'
import {
  JSON_RENDER_INVALID_SPEC_TITLE,
  JSON_RENDER_UNKNOWN_REASON,
  JSON_RENDER_VIEW_LABEL,
  jsonRenderActionFailedNotify,
  jsonRenderActionSubmittedNotify,
  jsonRenderInvalidActionNotify,
  jsonRenderOpenFailedNotify,
  jsonRenderSendFailedNotify,
  jsonRenderSentCommandNotify,
  jsonRenderSentToNotify,
} from './copy.ts'
import type { EvalScope } from './evaluator.ts'
import { SpecNodeList, type SpecRenderContext } from './spec-primitives.tsx'

/** How long the success confirmation state stays visible (button falls back from the check mark after 1.5s). */
const SUCCEED_CONFIRM_MS = 1_500

function StandardCodeBlock({ language, code }: { language: string; code: string }): ReactNode {
  return (
    <div className="code-block-wrap jr-fallback-wrap">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <pre className="code-block-pre code-block-pre-flush selectable">
        <code>{code}</code>
      </pre>
    </div>
  )
}

export function JsonRenderCodeBlock({ language, code, conversationId }: MarkdownCodeBlockProps): ReactNode {
  const t = usePluginTranslator()
  const parsed = useMemo<{ ok: true; spec: Record<string, unknown> } | { ok: false }>(() => {
    try {
      const value = JSON.parse(code) as unknown
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return { ok: true, spec: value as Record<string, unknown> }
      }
      return { ok: false }
    } catch {
      return { ok: false }
    }
  }, [code])

  if (!parsed.ok) {
    // Streamed, still-incomplete JSON falls back to source display (no fake
    // success); the final valid content renders once the stream settles.
    return <StandardCodeBlock language={language} code={code} />
  }

  return (
    <ViewBoundary label={t(JSON_RENDER_VIEW_LABEL)}>
      <JsonCardView spec={parsed.spec} conversationId={conversationId} />
    </ViewBoundary>
  )
}

function JsonCardView({ spec, conversationId }: { spec: Record<string, unknown>; conversationId?: number }): ReactNode {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set())
  const [succeededKeys, setSucceededKeys] = useState<ReadonlySet<string>>(new Set())
  const inflightRef = useRef<Set<string>>(new Set())
  const succeedTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const mountedRef = useRef(true)

  const clearSucceedTimer = useCallback((key: string): void => {
    const timer = succeedTimersRef.current.get(key)
    if (timer !== undefined) {
      clearTimeout(timer)
      succeedTimersRef.current.delete(key)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    const timers = succeedTimersRef.current
    return () => {
      mountedRef.current = false
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    }
  }, [])

  const runAction = useCallback(
    (rawAction: unknown, scope: EvalScope, pendingKey: string) => {
      if (inflightRef.current.has(pendingKey)) return
      inflightRef.current.add(pendingKey)
      clearSucceedTimer(pendingKey)
      setSucceededKeys((prev) => {
        if (!prev.has(pendingKey)) return prev
        const next = new Set(prev)
        next.delete(pendingKey)
        return next
      })
      const beginRequest = (): void => setPendingKeys((prev) => new Set(prev).add(pendingKey))
      const finishRequest = (): void => {
        inflightRef.current.delete(pendingKey)
        if (!mountedRef.current) return
        setPendingKeys((prev) => {
          if (!prev.has(pendingKey)) return prev
          const next = new Set(prev)
          next.delete(pendingKey)
          return next
        })
      }
      const markSucceeded = (): void => {
        if (!mountedRef.current) return
        setSucceededKeys((prev) => new Set(prev).add(pendingKey))
        const timer = setTimeout(() => {
          succeedTimersRef.current.delete(pendingKey)
          if (!mountedRef.current) return
          setSucceededKeys((prev) => {
            if (!prev.has(pendingKey)) return prev
            const next = new Set(prev)
            next.delete(pendingKey)
            return next
          })
        }, SUCCEED_CONFIRM_MS)
        succeedTimersRef.current.set(pendingKey, timer)
      }

      let resolved: ReturnType<typeof resolveSpecAction>
      try {
        resolved = resolveSpecAction(rawAction, scope, conversationId, locale)
      } catch (error) {
        inflightRef.current.delete(pendingKey)
        ctx.notify(jsonRenderInvalidActionNotify(error instanceof Error ? error.message : String(error), locale), 'warning')
        return
      }
      if (resolved.kind === 'invalid') {
        inflightRef.current.delete(pendingKey)
        ctx.notify(jsonRenderInvalidActionNotify(resolved.message, locale), 'warning')
        return
      }

      const run = async (): Promise<void> => {
        try {
          if (resolved.kind === 'action') {
            beginRequest()
            await ctx.callAction(resolved.actionId, resolved.input, {
              pluginId: resolved.pluginId,
              ...(conversationId !== undefined ? { conversationId } : {}),
            })
            if (mountedRef.current) {
              markSucceeded()
              if (conversationId !== undefined) ctx.notify(jsonRenderActionSubmittedNotify(resolved.actionId, locale))
            }
            return
          }
          if (resolved.kind === 'open') {
            beginRequest()
            if (resolved.target.startsWith('artifact:')) {
              ctx.openArtifact(resolved.target.slice('artifact:'.length))
            } else if (resolved.split) {
              ctx.openSplitScreen(resolved.target)
            } else {
              ctx.openScreen(resolved.target)
            }
            markSucceeded()
            return
          }
          beginRequest()
          await ctx.submitInput(resolved.text, {
            conversationId: resolved.conversationId,
            ...(resolved.whenBusy !== undefined ? { whenBusy: resolved.whenBusy } : {}),
          })
          if (mountedRef.current) {
            markSucceeded()
            ctx.notify(
              resolved.conversationId === conversationId
                ? jsonRenderSentCommandNotify(resolved.text, locale)
                : jsonRenderSentToNotify(resolved.conversationId, locale),
            )
          }
        } catch (error) {
          if (mountedRef.current) {
            ctx.notify(
              resolved.kind === 'action'
                ? jsonRenderActionFailedNotify(resolved.actionId, error instanceof Error ? error.message : String(error), locale)
                : resolved.kind === 'send'
                  ? jsonRenderSendFailedNotify(resolved.conversationId, error instanceof Error ? error.message : String(error), locale)
                  : jsonRenderOpenFailedNotify(error instanceof Error ? error.message : String(error), locale),
              'error',
            )
          }
        } finally {
          finishRequest()
        }
      }
      void run()
    },
    [ctx, conversationId, locale, clearSucceedTimer],
  )

  const normalized = useMemo(() => normalizeSpec(spec, locale), [spec, locale])
  const isPending = useCallback((key: string) => pendingKeys.has(key), [pendingKeys])
  const isSucceeded = useCallback((key: string) => succeededKeys.has(key), [succeededKeys])

  if (normalized.root === null) return null
  if (isDegradedNode(normalized.root)) {
    const reason =
      typeof normalized.root.props['reason'] === 'string' ? normalized.root.props['reason'] : t(JSON_RENDER_UNKNOWN_REASON)
    return (
      <Callout tone="warn" title={t(JSON_RENDER_INVALID_SPEC_TITLE)}>
        <span>{reason}</span>
      </Callout>
    )
  }

  const renderCtx: SpecRenderContext = {
    scope: { $data: {} },
    locale,
    conversationId,
    pluginId: undefined,
    renderChildren: (children: NormalizedSpecNode[]) => <SpecNodeList nodes={children} ctx={renderCtx} />,
    runAction,
    isPending,
    isSucceeded,
  }

  return (
    <div className="jr-card-wrap">
      <SpecNodeList nodes={[normalized.root]} ctx={renderCtx} />
    </div>
  )
}
