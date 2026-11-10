/**
 * builtin:mermaid client 组件：```mermaid 代码块渲染。
 *
 * - mermaid 经受控 npm 依赖 bundle 进本插件产物（内核只提供解析根与边界校验）；
 * - 代码变化 250ms 防抖，主题切换即时重绘无闪烁；
 * - 代际守卫：缓存命中也推进代际，卸载/参数变更后迟到的异步 render 结果一律丢弃
 *   （绝不覆盖缓存命中态）；渲染失败显式展示诊断与可复制源码，绝不静默截取脏文本。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { HelmIcon, CopyButton, Callout } from '@helm/plugin-client'
import { usePluginContext } from '@helm/plugin-client'
import type { MarkdownCodeBlockProps } from '@helm/protocol'
import { getMermaidConfig } from './mermaid-theme.ts'
import { MermaidPreviewModal } from './MermaidPreviewModal.tsx'
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

async function loadMermaid(): Promise<typeof import('mermaid')['default']> {
  const mod = await import('mermaid')
  return mod.default
}

export function MermaidCodeBlock({ code }: MarkdownCodeBlockProps): ReactNode {
  const { theme } = usePluginContext()
  const cacheKey = mermaidCacheKey(theme, code)
  const [svg, setSvg] = useState<string | null>(() => mermaidSvgCache.get(cacheKey) ?? null)
  const [error, setError] = useState<string | null>(null)
  const [zoomOpen, setZoomOpen] = useState(false)
  // 代际单调递增：任何渲染参数变化（含缓存命中路径）都使旧代异步结果失效。
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
          const mermaid = await loadMermaid()
          mermaid.initialize(getMermaidConfig(theme))
          const id = `helm-mermaid-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
          const { svg: rendered } = await mermaid.render(id, code)
          setCachedSvg(currentKey, rendered)
          // 代际或存活检查：迟到结果一律丢弃（卸载 / 参数已变 / 缓存命中新代）。
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
            title="放大预览"
          >
            <HelmIcon name="maximize" size={12} />
            放大预览
          </button>
          <CopyButton text={code} label="复制源码" />
        </span>
      </div>
      <div className="mermaid-body selectable">
        {svg !== null ? (
          <div
            className="mermaid-svg-host"
            // strict 模式禁用用户脚本和 HTML 标签；只注入 Mermaid 转换后的 SVG。
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error !== null ? (
          <Callout tone="err" title="Mermaid 渲染失败">
            <span className="selectable">{error}</span>
            <pre className="code-block-pre code-block-pre-flush selectable">
              <code>{code}</code>
            </pre>
          </Callout>
        ) : (
          <pre className="code-block-pre code-block-pre-flush selectable">
            <code>{code}</code>
          </pre>
        )}
      </div>
      {zoomOpen && <MermaidPreviewModal code={code} svg={svg} onClose={() => setZoomOpen(false)} />}
    </div>
  )
}
