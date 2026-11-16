/**
 * builtin:mermaid client components: ```mermaid code-block rendering.
 *
 * - mermaid is bundled into this plugin's artifact as a controlled npm
 *   dependency (the kernel only provides the resolution root and boundary
 *   checks);
 * - code changes debounce at 250ms, theme switches repaint immediately
 *   without flicker;
 * - generation guard: cache hits also advance the generation, so late async
 *   render results after unmount/parameter changes are always discarded
 *   (never overwrite a cache-hit state); render failures show diagnostics
 *   and copyable source explicitly, never silently swap in dirty text.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HelmIcon, CopyButton, Callout, usePluginContext, usePluginTranslator } from '@helm/plugin-client'
import type { MarkdownCodeBlockProps } from '@helm/protocol'
import mermaid from 'mermaid'
import { getMermaidConfig } from './mermaid-theme.ts'
import { MermaidPreviewModal } from './MermaidPreviewModal.tsx'
import {
  MERMAID_COPY_SOURCE,
  MERMAID_RENDERING,
  MERMAID_RENDER_FAILED,
  MERMAID_ZOOM_IN,
} from './copy.ts'
import './styles.css'

const MERMAID_CACHE_LIMIT = 200
const mermaidSvgCache = new Map<string, string>()

function mermaidCacheKey(theme: string, code: string): string {
  return `${theme}:${code}`
}

function setCachedSvg(key: string, svg: string): void {
  if (mermaidSvgCache.size >= MERMAID_CACHE_LIMIT) {
    const first = mermaidSvgCache.keys().next().value
    if (first !== undefined) mermaidSvgCache.delete(first)
  }
  mermaidSvgCache.set(key, svg)
}

export { mermaid }

export function MermaidCodeBlock({ code }: MarkdownCodeBlockProps): ReactNode {
  const { theme } = usePluginContext()
  const t = usePluginTranslator()
  const cacheKey = mermaidCacheKey(theme, code)
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [zoomOpen, setZoomOpen] = useState(false)
  // Monotonic generation: any render-parameter change (including the
  // cache-hit path) invalidates stale async results of older generations.
  const seqRef = useRef(0)
  const aliveRef = useRef(true)

  useEffect(() => {
    aliveRef.current = true
    const seq = ++seqRef.current

    const currentKey = mermaidCacheKey(theme, code)
    const cached = mermaidSvgCache.get(currentKey)
    if (cached) {
      setSvg(cached)
      setError(null)
      return () => {
        aliveRef.current = false
      }
    }

    const isCodeChanged = seq > 1
    if (isCodeChanged) {
      setSvg(null)
      setError(null)
    }

    const delay = isCodeChanged ? 250 : 0
    let timer: ReturnType<typeof setTimeout> | null = null
    timer = setTimeout(() => {
      void (async () => {
        try {
          mermaid.initialize(getMermaidConfig(theme))
          const id = `helm-mermaid-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
          const { svg: rendered } = await mermaid.render(id, code)
          setCachedSvg(currentKey, rendered)
          // Generation / liveness check: late results are always discarded
          // (unmounted / parameters changed / a newer cache hit).
          if (aliveRef.current && seqRef.current === seq) {
            setSvg(rendered)
            setError(null)
          }
        } catch (err) {
          if (aliveRef.current && seqRef.current === seq) {
            setError(err instanceof Error ? err.message : String(err))
            setSvg(null)
          }
        }
      })()
    }, delay)
    return () => {
      aliveRef.current = false
      if (timer !== null) clearTimeout(timer)
    }
  }, [code, theme])

  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>mermaid</span>
        <span className="code-block-header-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setZoomOpen(true)}
            title={t(MERMAID_ZOOM_IN)}
          >
            <HelmIcon name="maximize" size={12} />
            {t(MERMAID_ZOOM_IN)}
          </button>
          <CopyButton text={code} label={t(MERMAID_COPY_SOURCE)} />
        </span>
      </div>
      <div className="mermaid-body selectable">
        {svg !== null ? (
          <div
            className="mermaid-svg-host"
            // strict mode disables user scripts and HTML tags; only inject the
            // Mermaid-transformed SVG.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error !== null ? (
          <Callout tone="err" title={t(MERMAID_RENDER_FAILED)}>
            <span className="selectable">{error}</span>
            <pre className="code-block-pre code-block-pre-flush selectable">
              <code>{code}</code>
            </pre>
          </Callout>
        ) : (
          <div className="mermaid-placeholder">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--fg-secondary)', padding: '4px 0 8px' }}>
              <HelmIcon name="loader" size={13} className="spin-slow" />
              <span>{t(MERMAID_RENDERING)}</span>
            </div>
            <pre className="code-block-pre code-block-pre-flush selectable" style={{ opacity: 0.5 }}>
              <code>{code}</code>
            </pre>
          </div>
        )}
      </div>
      {zoomOpen && <MermaidPreviewModal code={code} svg={svg} onClose={() => setZoomOpen(false)} />}
    </div>
  )
}
