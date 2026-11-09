import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { getMermaidConfig } from './mermaid-theme.js'

export interface MermaidPreviewModalProps {
  code: string
  /** 已渲染的 SVG（内联块已渲染时复用；未渲染则弹窗内自行渲染）。 */
  svg?: string | null
  onClose: () => void
}

const MIN_SCALE = 0.1
const MAX_SCALE = 5
const SCALE_STEP = 0.15

/**
 * Mermaid 放大预览弹窗：
 * - 纯全屏沉浸式画板（固定占满整屏视口，无多余窗口边距）；
 * - 默认 1:1 实际比例，且严格从上往下展示（Top-aligned），避免头部被截断或需反复拖拽；
 * - 普通鼠标滚轮自然上下平移长图，Ctrl/Cmd+滚轮平滑缩放，按住鼠标全局平移；
 * - 解析 SVG viewBox 真实固有尺寸，彻底消除 Flex shrink 误压缩为 300px 的问题；
 * - 提供适屏全貌（看整体鸟瞰）、适宽（铺满视口宽度）与 1:1（从上往下自然阅读）切换；
 * - 源码 / 图形切换与一键复制源码。
 */
export function MermaidPreviewModal({ code, svg, onClose }: MermaidPreviewModalProps) {
  const { theme } = useHelmStore()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [renderedSvg, setRenderedSvg] = useState<string | null>(svg ?? null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const planeRef = useRef<HTMLDivElement | null>(null)
  const offsetRef = useRef(offset)
  const scaleRef = useRef(scale)
  const rafIdRef = useRef<number | null>(null)
  const lastThemeRef = useRef(theme)
  const lastCodeRef = useRef(code)
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

  // 当外部 svg 属性更新（且非空）时同步至 renderedSvg
  useEffect(() => {
    if (svg) {
      setRenderedSvg(svg)
      setError(null)
    }
  }, [svg])

  // 当未提供 svg，或 theme 发生变化，或 code 改变时，在弹窗内重新渲染
  useEffect(() => {
    const isThemeChanged = lastThemeRef.current !== theme
    const isCodeChanged = lastCodeRef.current !== code
    lastThemeRef.current = theme
    lastCodeRef.current = code

    // 如果初始化时已有传入 svg 且主题与代码均未变，则直接复用
    if (svg && !isThemeChanged && !isCodeChanged) return

    let cancelled = false
    const seq = ++seqRef.current
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        mermaid.initialize(getMermaidConfig(theme))
        const id = `helm-mermaid-modal-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
        const { svg: out } = await mermaid.render(id, code)
        if (!cancelled && seqRef.current === seq) {
          setRenderedSvg(out)
          setError(null)
        }
      } catch (err) {
        if (!cancelled && seqRef.current === seq) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, svg, theme])

  // 从 SVG 字符串中提取 viewBox 固有的真实宽与高
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

  // 适应屏幕全貌计算（保证整张图完全落在画布中）
  const calcFitScreen = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !intrinsicSize) return 1
    const availW = Math.max(100, stage.clientWidth - 48)
    const availH = Math.max(100, stage.clientHeight - 64)
    const fit = Math.min(availW / intrinsicSize.width, availH / intrinsicSize.height)
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(fit.toFixed(2))))
  }, [intrinsicSize])

  // 适宽展示计算（宽度填满画布，纵向从上往下阅读）
  const calcFitWidth = useCallback(() => {
    const stage = stageRef.current
    if (!stage || !intrinsicSize) return 1
    const availW = Math.max(100, stage.clientWidth - 48)
    const fit = availW / intrinsicSize.width
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(fit.toFixed(2))))
  }, [intrinsicSize])

  // 适屏全貌重置（全貌展示并居中）
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

  // 适宽重置（宽度贴合视口，从上往下自然展现）
  const resetFitWidth = useCallback(() => {
    const fitW = calcFitWidth()
    setScale(fitW)
    setOffset({ x: 0, y: 0 })
    scaleRef.current = fitW
    offsetRef.current = { x: 0, y: 0 }
    applyTransformDirect()
  }, [calcFitWidth, applyTransformDirect])

  // 1:1 实际比例重置（从上往下自然阅读）
  const resetActual = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    scaleRef.current = 1
    offsetRef.current = { x: 0, y: 0 }
    applyTransformDirect()
  }, [applyTransformDirect])

  // 快捷键支持
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

  // 滚轮操作：Ctrl/Cmd 缩放，普通滚轮顺畅平移长图
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

  // 指针拖拽与多点触控：全局 window 监听，rAF 驱动 GPU 合成变换（零 React 重渲染，移动端 60/120fps 丝滑）
  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    // 阻止浏览器默认页面拖拽、文字选取或拉动刷新手势
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
    if (await copyToClipboard(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  if (typeof document === 'undefined') return null

  return createPortal(
    <div className="modal-backdrop modal-fullscreen-backdrop" onClick={onClose}>
      <div className="modal modal-fullscreen" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header mermaid-modal-header">
          <span
            className="modal-title mermaid-modal-title"
            style={{
              minWidth: 0,
              flex: 1,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            Mermaid 图预览
          </span>
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
              title="放大 (+)"
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
              title="缩小 (-)"
            >
              <HelmIcon name="zoom-out" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetFitScreen}
              title="适应屏幕全貌 (0)"
            >
              适屏
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetFitWidth}
              title="适应视口宽度 (W)"
            >
              适宽
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={resetActual}
              title="实际大小 100% (1)"
            >
              1:1
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setView(view === 'diagram' ? 'source' : 'diagram')}
            >
              {view === 'diagram' ? '查看源码' : '查看图形'}
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void copySource()}>
              <HelmIcon name={copied ? 'check' : 'copy'} size={12} />
              复制源码
            </button>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm mermaid-modal-close"
            onClick={onClose}
            title="关闭 (Esc)"
            aria-label="关闭"
          >
            <HelmIcon name="x" size={13} />
          </button>
        </div>
        <div className="modal-body modal-body-flush">
          {view === 'source' ? (
            <pre className="code-block-pre selectable mermaid-source-pre">
              <code>{code}</code>
            </pre>
          ) : (
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
                {renderedSvg !== null ? (
                  <div
                    className="mermaid-svg-layer"
                    style={{
                      width: intrinsicSize ? `${intrinsicSize.width}px` : 'auto',
                      height: intrinsicSize ? `${intrinsicSize.height}px` : 'auto',
                    }}
                    dangerouslySetInnerHTML={{ __html: renderedSvg }}
                  />
                ) : (
                  <span className="mermaid-status-hint">
                    {error !== null ? `渲染失败：${error}` : '正在渲染…'}
                  </span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  )
}
