import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from '../lib/icons.js'

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
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [renderedSvg, setRenderedSvg] = useState<string | null>(svg ?? null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (svg !== undefined && svg !== null) return
    let cancelled = false
    void (async () => {
      try {
        const mermaid = (await import('mermaid')).default
        const id = `helm-mermaid-modal-${Math.random().toString(36).slice(2, 8)}`
        const { svg: out } = await mermaid.render(id, code)
        if (!cancelled) setRenderedSvg(out)
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [code, svg])

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
      return
    }
    const fit = calcFitScreen()
    setScale(fit)
    const scaledH = intrinsicSize.height * fit
    const stageH = stage.clientHeight
    const extraY = stageH > scaledH + 48 ? (stageH - scaledH) / 2 - 32 : 0
    setOffset({ x: 0, y: Math.round(extraY) })
  }, [calcFitScreen, intrinsicSize])

  // 适宽重置（宽度贴合视口，从上往下自然展现）
  const resetFitWidth = useCallback(() => {
    const fitW = calcFitWidth()
    setScale(fitW)
    setOffset({ x: 0, y: 0 })
  }, [calcFitWidth])

  // 1:1 实际比例重置（从上往下自然阅读）
  const resetActual = useCallback(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
  }, [])

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
        setScale((c) => Math.min(MAX_SCALE, Number((c + SCALE_STEP).toFixed(2))))
      } else if (e.key === '-' || e.key === '_') {
        setScale((c) => Math.max(MIN_SCALE, Number((c - SCALE_STEP).toFixed(2))))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, resetFitScreen, resetFitWidth, resetActual])

  // 滚轮操作：Ctrl/Cmd 缩放，普通滚轮顺畅平移长图
  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP
      setScale((curr) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((curr + delta).toFixed(2)))))
    } else {
      setOffset((prev) => ({
        x: prev.x - e.deltaX,
        y: prev.y - e.deltaY,
      }))
    }
  }

  // 指针拖拽平移：全局 window 监听，彻底避免脱出容器丢失捕获
  const onPointerDown = (e: React.PointerEvent): void => {
    if ((e.target as HTMLElement).closest('button')) return
    const startX = e.clientX
    const startY = e.clientY
    const baseX = offset.x
    const baseY = offset.y
    setIsDragging(true)

    const onMove = (moveEv: PointerEvent): void => {
      setOffset({
        x: baseX + (moveEv.clientX - startX),
        y: baseY + (moveEv.clientY - startY),
      })
    }

    const onUp = (): void => {
      setIsDragging(false)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
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
    <div className="modal-backdrop modal-fullscreen-backdrop" style={{ zIndex: 120 }} onClick={onClose}>
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
              onClick={() => setScale((c) => Math.min(MAX_SCALE, Number((c + SCALE_STEP).toFixed(2))))}
              title="放大 (+)"
            >
              <HelmIcon name="zoom-in" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setScale((c) => Math.max(MIN_SCALE, Number((c - SCALE_STEP).toFixed(2))))}
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
        <div className="modal-body" style={{ padding: 0, overflow: 'hidden' }}>
          {view === 'source' ? (
            <pre
              className="code-block-pre selectable"
              style={{ padding: 14, height: '100%', overflow: 'auto', margin: 0 }}
            >
              <code>{code}</code>
            </pre>
          ) : (
            <div
              ref={stageRef}
              className="mermaid-modal-stage selectable"
              style={{
                flex: 1,
                width: '100%',
                height: '100%',
                minHeight: 0,
                overflow: 'hidden',
                position: 'relative',
                cursor: isDragging ? 'grabbing' : 'grab',
                background: 'var(--bg-subtle)',
              }}
              onDoubleClick={onDoubleClick}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
            >
              <div
                className="mermaid-transform-plane"
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transformOrigin: 'top center',
                  position: 'absolute',
                  left: 0,
                  right: 0,
                  top: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  paddingTop: 32,
                  paddingBottom: 64,
                  pointerEvents: 'none',
                }}
              >
                {renderedSvg !== null ? (
                  <div
                    className="mermaid-svg-layer"
                    style={{
                      width: intrinsicSize ? `${intrinsicSize.width}px` : 'auto',
                      height: intrinsicSize ? `${intrinsicSize.height}px` : 'auto',
                      maxWidth: 'none',
                      pointerEvents: 'auto',
                    }}
                    dangerouslySetInnerHTML={{ __html: renderedSvg }}
                  />
                ) : (
                  <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
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
