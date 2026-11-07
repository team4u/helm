import { useEffect, useRef, useState } from 'react'
import { copyToClipboard } from './clipboard.js'
import { HelmIcon } from '../lib/icons.js'

export interface MermaidPreviewModalProps {
  code: string
  /** 已渲染的 SVG（内联块已渲染时复用；未渲染则弹窗内自行渲染）。 */
  svg?: string | null
  onClose: () => void
}

const MIN_SCALE = 0.2
const MAX_SCALE = 5
const SCALE_STEP = 0.2

/**
 * Mermaid 放大预览弹窗：
 * - 0.2x ~ 5x 缩放（按钮步进 + 滚轮微调）与适屏重置；
 * - 拖拽平移（指针捕获）；
 * - 源码 / 图形切换。
 */
export function MermaidPreviewModal({ code, svg, onClose }: MermaidPreviewModalProps) {
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [view, setView] = useState<'diagram' | 'source'>('diagram')
  const [renderedSvg, setRenderedSvg] = useState<string | null>(svg ?? null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const dragStateRef = useRef<{ startX: number; startY: number; baseX: number; baseY: number } | null>(null)

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const clampScale = (next: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, next))

  const onWheel = (e: React.WheelEvent): void => {
    e.preventDefault()
    setScale((curr) => clampScale(curr + (e.deltaY < 0 ? SCALE_STEP : -SCALE_STEP)))
  }

  const onPointerDown = (e: React.PointerEvent): void => {
    ;(e.target as Element).setPointerCapture?.(e.pointerId)
    dragStateRef.current = { startX: e.clientX, startY: e.clientY, baseX: offset.x, baseY: offset.y }
  }

  const onPointerMove = (e: React.PointerEvent): void => {
    const drag = dragStateRef.current
    if (drag === null) return
    setOffset({ x: drag.baseX + (e.clientX - drag.startX), y: drag.baseY + (e.clientY - drag.startY) })
  }

  const onPointerUp = (e: React.PointerEvent): void => {
    ;(e.target as Element).releasePointerCapture?.(e.pointerId)
    dragStateRef.current = null
  }

  const copySource = async (): Promise<void> => {
    if (await copyToClipboard(code)) {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }
  }

  return (
    <div className="modal-backdrop" style={{ zIndex: 120 }} onClick={onClose}>
      <div
        className="modal"
        style={{ maxWidth: 'min(1100px, 94vw)', maxHeight: '90vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span className="modal-title">Mermaid 图放大预览</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span className="badge badge-neutral mono tabular-nums">{scale.toFixed(1)}x</span>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setScale((c) => clampScale(c + SCALE_STEP))}
              title="放大"
            >
              <HelmIcon name="maximize" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setScale((c) => clampScale(c - SCALE_STEP))}
              title="缩小"
            >
              <HelmIcon name="minimize" size={12} />
            </button>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setScale(1)
                setOffset({ x: 0, y: 0 })
              }}
              title="适屏重置"
            >
              重置
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
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title="关闭 (Esc)">
              <HelmIcon name="x" size={13} />
            </button>
          </span>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          {view === 'source' ? (
            <pre className="code-block-pre selectable" style={{ padding: 14, minHeight: 300 }}>
              <code>{code}</code>
            </pre>
          ) : (
            <div
              className="selectable"
              style={{
                overflow: 'hidden',
                minHeight: 340,
                cursor: dragStateRef.current !== null ? 'grabbing' : 'grab',
                background: 'var(--bg-subtle)',
              }}
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <div
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transformOrigin: 'center center',
                  width: '100%',
                  height: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: 24,
                }}
              >
                {renderedSvg !== null ? (
                  <div dangerouslySetInnerHTML={{ __html: renderedSvg }} />
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
    </div>
  )
}
