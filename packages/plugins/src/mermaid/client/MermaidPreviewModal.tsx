import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Callout,
  HelmIcon,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  usePluginContext,
  usePluginLocale,
  usePluginTranslator,
} from '@helm/plugin-client'
import { loadMermaid } from './mermaid-loader.ts'
import { getMermaidConfig } from './mermaid-theme.ts'
import {
  MERMAID_ACTUAL_TITLE,
  MERMAID_CLOSE,
  MERMAID_CLOSE_TITLE,
  MERMAID_COPY_SOURCE,
  MERMAID_FIT_SCREEN,
  MERMAID_FIT_SCREEN_TITLE,
  MERMAID_FIT_WIDTH,
  MERMAID_FIT_WIDTH_TITLE,
  MERMAID_PREVIEW_TITLE,
  MERMAID_RENDER_FAILED,
  MERMAID_RETRY,
  MERMAID_VIEW_DIAGRAM,
  MERMAID_VIEW_SOURCE,
  MERMAID_ZOOM_IN_TITLE,
  MERMAID_ZOOM_OUT_TITLE,
  mermaidModalStatus,
} from './copy.ts'

export interface MermaidPreviewModalProps {
  code: string
  /** Already-rendered SVG (reused when the inline block rendered it; otherwise the modal renders on its own). */
  svg?: string | null
  onClose: () => void
}

const MIN_SCALE = 0.1
const MAX_SCALE = 5
const SCALE_STEP = 0.15

/** Clipboard write (returns false when navigator.clipboard is unavailable; never fakes success). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/**
 * Mermaid zoom-in preview modal:
 * - a pure fullscreen immersive canvas (fills the whole viewport, no extra
 *   window margins);
 * - defaults to 1:1 actual scale, strictly top-aligned, so the head is never
 *   cut off and no repeated dragging is needed;
 * - plain mouse wheel pans long diagrams naturally, Ctrl/Cmd+wheel zooms
 *   smoothly, holding the mouse button pans globally;
 * - parses the SVG viewBox for the true intrinsic size, eliminating the
 *   Flex-shrink mis-compression to 300px;
 * - fit-screen (whole-diagram overview), fit-width (fill the viewport width)
 *   and 1:1 (top-down natural reading) toggles;
 * - source / diagram view toggle and one-click source copy.
 */
export function MermaidPreviewModal({ code, svg, onClose }: MermaidPreviewModalProps) {
  const { theme } = usePluginContext()
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [renderedSvg, setRenderedSvg] = useState<string | null>(svg ?? null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [retryCount, setRetryCount] = useState(0)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const planeRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(offset)
  const scaleRef = useRef(scale)
  const rafIdRef = useRef<number | null>(null)
  const lastThemeRef = useRef(theme)
  const lastCodeRef = useRef(code)
  const lastRetryRef = useRef(retryCount)
  const seqRef = useRef(0)

  const activePointersRef = useRef<Map<number, { x: number; y: number }>>(new Map())
  const gestureStateRef = useRef<{
    mode: 'pan' | 'pinch'
    startX: number
    startY: number
    baseOffsetX: number
    baseOffsetY: number
    baseScale: number
    startDistance: number
    startCenterX: number
    startCenterY: number
  } | null>(null)

  useEffect(() => {
    offsetRef.current = offset
  }, [offset])

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current)
        rafIdRef.current = null
      }
    }
  }, [])

  const applyTransformDirect = useCallback(() => {
    if (planeRef.current) {
      planeRef.current.style.transform = `translate3d(${offsetRef.current.x}px, ${offsetRef.current.y}px, 0) scale(${scaleRef.current})`
    }
  }, [])

  // Sync a non-empty external svg prop into renderedSvg when it updates.
  useEffect(() => {
    if (svg) {
      seqRef.current += 1
      setRenderedSvg(svg)
      setError(null)
    }
  }, [svg])

  // Re-render inside the modal when no svg was provided, the theme changed,
  // the code changed, or the user requested a retry.
  useEffect(() => {
    const isThemeChanged = lastThemeRef.current !== theme
    const isCodeChanged = lastCodeRef.current !== code
    const isRetryRequested = lastRetryRef.current !== retryCount
    lastThemeRef.current = theme
    lastCodeRef.current = code
    lastRetryRef.current = retryCount

    // Reuse the passed-in svg directly when neither theme, code, nor retry changed.
    if (svg && !isThemeChanged && !isCodeChanged && !isRetryRequested) return

    if (isThemeChanged || isCodeChanged || isRetryRequested) {
      setRenderedSvg(null)
      setError(null)
    }

    let cancelled = false
    const seq = ++seqRef.current
    const isStale = (): boolean => cancelled || seqRef.current !== seq

    void (async () => {
      try {
        const mermaid = await loadMermaid()
        if (isStale()) return
        mermaid.initialize(getMermaidConfig(theme))
        const id = `helm-mermaid-modal-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
        const { svg: out } = await mermaid.render(id, code)
        if (!isStale()) {
          setRenderedSvg(out)
          setError(null)
        }
      } catch (err) {
        if (!isStale()) {
          setRenderedSvg(null)
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, svg, theme, retryCount])

  // Extract the true intrinsic width/height from the SVG's viewBox.
  const intrinsicSize = useMemo<{ width: number; height: number } | null>(() => {
    if (!renderedSvg) return null
    const match = /viewBox=["']\s*([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s+([0-9.-]+)\s*["']/i.exec(renderedSvg)
    if (match) {
      const w = parseFloat(match[3]!)
      const h = parseFloat(match[4]!)
      if (Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0) {
        return { width: w, height: h }
      }
    }
    return null
  }, [renderedSvg])

  // Fit-whole-diagram scale (the entire diagram stays inside the canvas).
  const calcFitScreen = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !intrinsicSize) return 1
    const availW = Math.max(100, stage.clientWidth - 48)
    const availH = Math.max(100, stage.clientHeight - 64)
    const fit = Math.min(availW / intrinsicSize.width, availH / intrinsicSize.height)
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(fit.toFixed(2))))
  }, [intrinsicSize])

  // Fit-width scale (fill the canvas width, read top-down).
  const calcFitWidth = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !intrinsicSize) return 1
    const availW = Math.max(100, stage.clientWidth - 48)
    const fit = availW / intrinsicSize.width
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(fit.toFixed(2))))
  }, [intrinsicSize])

  // Fit-screen reset (whole diagram, centered).
  const resetFitScreen = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !intrinsicSize) {
      setScale(1)
      setOffset({ x: 0, y: 0 })
      scaleRef.current = 1
      offsetRef.current = { x: 0, y: 0 }
      applyTransformDirect()
      return
    }
    const fit = calcFitScreen()
    const scaledH = intrinsicSize.height * fit
    const stageH = stage.clientHeight
    const extraY = stageH > scaledH + 48 ? (stageH - scaledH) / 2 - 32 : 0
    const newOffset = { x: 0, y: Math.round(extraY) }
    setScale(fit)
    setOffset(newOffset)
    scaleRef.current = fit
    offsetRef.current = newOffset
    applyTransformDirect()
  }, [calcFitScreen, intrinsicSize, applyTransformDirect])

  // Fit-width reset (width hugs the viewport, natural top-down reading).
  const resetFitWidth = useCallback(() => {
    const fitW = calcFitWidth()
    setScale(fitW)
    setOffset({ x: 0, y: 0 })
    scaleRef.current = fitW
    offsetRef.current = { x: 0, y: 0 }
    applyTransformDirect()
  }, [calcFitWidth, applyTransformDirect])

  // 1:1 actual-size reset (natural top-down reading).
  const resetActual = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    scaleRef.current = 1
    offsetRef.current = { x: 0, y: 0 }
    applyTransformDirect()
  }, [applyTransformDirect])

  // Keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === '0') {
        resetFitScreen()
      } else if (e.key === 'w' || e.key === 'W') {
        resetFitWidth()
      } else if (e.key === '1') {
        resetActual()
      } else if (e.key === '+' || e.key === '=') {
        setScale((c) => {
          const next = Math.min(MAX_SCALE, Number((c + SCALE_STEP).toFixed(2)))
          scaleRef.current = next
          applyTransformDirect()
          return next
        })
      } else if (e.key === '-' || e.key === '_') {
        setScale((c) => {
          const next = Math.max(MIN_SCALE, Number((c - SCALE_STEP).toFixed(2)))
          scaleRef.current = next
          applyTransformDirect()
          return next
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, resetFitScreen, resetFitWidth, resetActual, applyTransformDirect])

  // Wheel: Ctrl/Cmd zooms, plain wheel pans long diagrams smoothly.
  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP
      const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((scale + delta).toFixed(2))))
      setScale(nextScale)
      scaleRef.current = nextScale
      applyTransformDirect()
    } else {
      const nextOffset = {
        x: offsetRef.current.x - e.deltaX,
        y: offsetRef.current.y - e.deltaY,
      }
      setOffset(nextOffset)
      offsetRef.current = nextOffset
      applyTransformDirect()
    }
  }

  // Pointer drag & multi-touch: global window listeners, rAF-driven GPU
  // compositing transform (zero React re-renders; silky 60/120fps on mobile).
  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    // Block browser-default page drag, text selection and pull-to-refresh gestures.
    if (e.cancelable) e.preventDefault()

    activePointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    setIsDragging(true)

    const pts = Array.from(activePointersRef.current.values())
    if (pts.length === 1) {
      gestureStateRef.current = {
        mode: 'pan',
        startX: pts[0]!.x,
        startY: pts[0]!.y,
        baseOffsetX: offsetRef.current.x,
        baseOffsetY: offsetRef.current.y,
        baseScale: scaleRef.current,
        startDistance: 0,
        startCenterX: 0,
        startCenterY: 0,
      }
    } else if (pts.length >= 2) {
      const p1 = pts[0]!
      const p2 = pts[1]!
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
      const cx = (p1.x + p2.x) / 2
      const cy = (p1.y + p2.y) / 2
      gestureStateRef.current = {
        mode: 'pinch',
        startX: cx,
        startY: cy,
        baseOffsetX: offsetRef.current.x,
        baseOffsetY: offsetRef.current.y,
        baseScale: scaleRef.current,
        startDistance: Math.max(10, dist),
        startCenterX: cx,
        startCenterY: cy,
      }
    }

    const onMove = (ev: PointerEvent): void => {
      if (!activePointersRef.current.has(ev.pointerId)) return
      activePointersRef.current.set(ev.pointerId, { x: ev.clientX, y: ev.clientY })
      const state = gestureStateRef.current
      if (!state) return

      const currentPts = Array.from(activePointersRef.current.values())
      if (state.mode === 'pan' && currentPts.length === 1) {
        const cur = currentPts[0]!
        const dx = cur.x - state.startX
        const dy = cur.y - state.startY
        offsetRef.current = {
          x: Math.round(state.baseOffsetX + dx),
          y: Math.round(state.baseOffsetY + dy),
        }
        if (rafIdRef.current === null) {
          rafIdRef.current = requestAnimationFrame(() => {
            rafIdRef.current = null
            applyTransformDirect()
          })
        }
      } else if (currentPts.length >= 2) {
        const p1 = currentPts[0]!
        const p2 = currentPts[1]!
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y)
        const cx = (p1.x + p2.x) / 2
        const cy = (p1.y + p2.y) / 2

        if (state.mode === 'pinch' && state.startDistance > 0) {
          const ratio = dist / state.startDistance
          const nextScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((state.baseScale * ratio).toFixed(2))))
          const dx = cx - state.startCenterX
          const dy = cy - state.startCenterY

          scaleRef.current = nextScale
          offsetRef.current = {
            x: Math.round(state.baseOffsetX + dx),
            y: Math.round(state.baseOffsetY + dy),
          }

          if (rafIdRef.current === null) {
            rafIdRef.current = requestAnimationFrame(() => {
              rafIdRef.current = null
              applyTransformDirect()
            })
          }
        }
      }
    }

    const onUp = (upEv: PointerEvent): void => {
      activePointersRef.current.delete(upEv.pointerId)
      const remaining = Array.from(activePointersRef.current.values())

      if (remaining.length === 1) {
        const cur = remaining[0]!
        gestureStateRef.current = {
          mode: 'pan',
          startX: cur.x,
          startY: cur.y,
          baseOffsetX: offsetRef.current.x,
          baseOffsetY: offsetRef.current.y,
          baseScale: scaleRef.current,
          startDistance: 0,
          startCenterX: 0,
          startCenterY: 0,
        }
      } else if (remaining.length === 0) {
        setIsDragging(false)
        gestureStateRef.current = null
        if (rafIdRef.current !== null) {
          cancelAnimationFrame(rafIdRef.current)
          rafIdRef.current = null
        }
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        window.removeEventListener('pointercancel', onUp)

        setOffset({ ...offsetRef.current })
        setScale(scaleRef.current)
      }
    }

    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const onDoubleClick = (e: React.MouseEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    if (Math.abs(scale - 1) > 0.05) {
      resetActual()
    } else {
      resetFitScreen()
    }
  }

  const copySource = async (): Promise<void> => {
    if (await copyText(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal>
        <DialogOverlay className="modal-backdrop modal-fullscreen-backdrop">
          <DialogContent className="modal modal-fullscreen" aria-label={t(MERMAID_PREVIEW_TITLE)}>
            <div className="modal-header mermaid-modal-header">
              <DialogTitle
                className="modal-title mermaid-modal-title"
                style={{
                  minWidth: 0,
                  flex: 1,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {t(MERMAID_PREVIEW_TITLE)}
              </DialogTitle>
          <div className="mermaid-modal-actions">
            <span className="badge badge-neutral mono tabular-nums">{Math.round(scale * 100)}%</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const next = Math.min(MAX_SCALE, Number((scale + SCALE_STEP).toFixed(2)))
                setScale(next)
                scaleRef.current = next
                applyTransformDirect()
              }}
              title={t(MERMAID_ZOOM_IN_TITLE)}
            >
              <HelmIcon name="zoom-in" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                const next = Math.max(MIN_SCALE, Number((scale - SCALE_STEP).toFixed(2)))
                setScale(next)
                scaleRef.current = next
                applyTransformDirect()
              }}
              title={t(MERMAID_ZOOM_OUT_TITLE)}
            >
              <HelmIcon name="zoom-out" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetFitScreen}
              title={t(MERMAID_FIT_SCREEN_TITLE)}
            >
              {t(MERMAID_FIT_SCREEN)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetFitWidth}
              title={t(MERMAID_FIT_WIDTH_TITLE)}
            >
              {t(MERMAID_FIT_WIDTH)}
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetActual}
              title={t(MERMAID_ACTUAL_TITLE)}
            >
              1:1
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView(view === 'diagram' ? 'source' : 'diagram')}
            >
              {view === 'diagram' ? t(MERMAID_VIEW_SOURCE) : t(MERMAID_VIEW_DIAGRAM)}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void copySource()}>
              <HelmIcon name={copied ? 'check' : 'copy'} size={12} />
              {t(MERMAID_COPY_SOURCE)}
            </button>
          </div>
          <DialogClose asChild>
            <button
              type="button"
              className="btn btn-ghost btn-sm mermaid-modal-close"
              title={t(MERMAID_CLOSE_TITLE)}
              aria-label={t(MERMAID_CLOSE)}
            >
              <HelmIcon name="x" size={13} />
            </button>
          </DialogClose>
        </div>
        <div className="modal-body modal-body-flush">
          {view === 'source' ? (
            <pre className="code-block-pre selectable mermaid-source-pre">
              <code>{code}</code>
            </pre>
          ) : renderedSvg !== null ? (
            <div
              ref={stageRef}
              className="mermaid-modal-stage"
              style={{
                cursor: isDragging ? 'grabbing' : 'grab',
                background: 'var(--bg)',
                touchAction: 'none',
              }}
              onDoubleClick={onDoubleClick}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
            >
              <div
                ref={planeRef}
                className="mermaid-transform-plane"
                style={{
                  transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
                  willChange: isDragging ? 'transform' : 'auto',
                }}
              >
                <div
                  className="mermaid-svg-layer"
                  style={{
                    width: intrinsicSize ? `${intrinsicSize.width}px` : 'auto',
                    height: intrinsicSize ? `${intrinsicSize.height}px` : 'auto',
                  }}
                  dangerouslySetInnerHTML={{ __html: renderedSvg }}
                />
              </div>
            </div>
          ) : error !== null ? (
            <div className="mermaid-modal-status">
              <Callout tone="err" title={t(MERMAID_RENDER_FAILED)}>
                <div className="mermaid-error-body">
                  <span className="selectable">{error}</span>
                  <div className="mermaid-error-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => {
                        setError(null)
                        setRenderedSvg(null)
                        setRetryCount((n) => n + 1)
                      }}
                    >
                      <HelmIcon name="refresh-cw" size={12} />
                      {t(MERMAID_RETRY)}
                    </button>
                  </div>
                </div>
              </Callout>
            </div>
          ) : (
            <div className="mermaid-modal-status">
              <span className="mermaid-status-hint">
                <HelmIcon name="loader" size={14} className="spin-slow" />
                {mermaidModalStatus(null, locale)}
              </span>
            </div>
          )}
        </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
