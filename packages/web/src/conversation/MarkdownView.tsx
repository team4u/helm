import { memo, useEffect, useMemo, useRef, useState } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SyntaxCode } from './SyntaxCode.js'
import { CopyButton } from './CopyButton.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { HelmSpecView } from '../ui/HelmSpecView.js'
import { MermaidPreviewModal } from './MermaidPreviewModal.js'
import { getMermaidConfig } from './mermaid-theme.js'

export interface MarkdownViewProps {
  text: string
  conversationId?: number
}

interface CodeBlockProps {
  language: string
  code: string
  conversationId?: number
}

function StandardCodeBlock({ language, code }: CodeBlockProps) {
  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxCode code={code} language={language} />
    </div>
  )
}

/**
 * 独立语法高亮代码块（产物预览等非 Markdown 场景消费）：
 * 语言为空串时优雅回退普通等宽代码样式，不猜造语言。
 */
export function CodeBlockView({ code, language }: { code: string; language: string }) {
  return (
    <div className="code-block-wrap" style={{ margin: 0 }}>
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxCode code={code} language={language} />
    </div>
  )
}

/** mermaid 图：250ms 防抖渲染 SVG 内联展示；右上角「放大预览」与「复制源码」。 */
function MermaidBlock({ code }: { code: string }) {
  const { theme } = useHelmStore()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomOpen, setZoomOpen] = useState(false)
  const seqRef = useRef(0)

  useEffect(() => {
    const seq = ++seqRef.current
    setSvg(null)
    setError(null)
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize(getMermaidConfig(theme))
          const id = `helm-mermaid-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
          const { svg: rendered } = await mermaid.render(id, code)
          if (seqRef.current === seq) setSvg(rendered)
        } catch (err) {
          if (seqRef.current === seq) {
            setError(err instanceof Error ? err.message : String(err))
          }
        }
      })()
    }, 250)
    return () => clearTimeout(timer)
  }, [code, theme])

  return (
    <div className="code-block-wrap">
      <div className="code-block-header">
        <span>mermaid</span>
        <span style={{ display: 'inline-flex', gap: 4 }}>
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
      <div className="mermaid-body selectable" style={{ padding: '10px 12px', overflowX: 'auto' }}>
        {svg !== null ? (
          <div
            className="mermaid-svg-host"
            // strict 模式禁用用户脚本和 HTML 标签；只注入 Mermaid 转换后的 SVG。
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        ) : error !== null ? (
          <div className="jr-callout jr-callout-err" style={{ borderRadius: 0, borderWidth: 0 }}>
            <span>Mermaid 渲染失败：{error}</span>
          </div>
        ) : (
          <pre className="code-block-pre" style={{ padding: 0 }}>
            <code>{code}</code>
          </pre>
        )}
      </div>
      {zoomOpen && <MermaidPreviewModal code={code} svg={svg} onClose={() => setZoomOpen(false)} />}
    </div>
  )
}

/** ui / json-render 代码块：安全 JSON.parse 后内联 HelmSpecView；失败诚实回退代码块。 */
function SpecBlock({ code, conversationId }: CodeBlockProps) {
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
    return <StandardCodeBlock language="json-render" code={code} />
  }
  return (
    <div className="code-block-wrap" style={{ padding: 10 }}>
      <HelmSpecView spec={parsed.spec} conversationId={conversationId} />
    </div>
  )
}

function CodeRenderer({ language, code, conversationId }: CodeBlockProps) {
  if (language === 'mermaid') return <MermaidBlock code={code} />
  if (language === 'ui' || language === 'json-render') {
    return <SpecBlock code={code} language={language} conversationId={conversationId} />
  }
  return <StandardCodeBlock language={language} code={code} />
}

function extractCodeBlock(node: unknown): { language: string; code: string } | null {
  // react-markdown hast node：pre > code(.language-x)[text]
  if (node === null || typeof node !== 'object') return null
  const codeEl = (node as { children?: unknown }).children
  if (!Array.isArray(codeEl) || codeEl.length === 0) return null
  const first = codeEl[0] as { tagName?: unknown; properties?: unknown; children?: unknown } | undefined
  if (first === null || typeof first !== 'object' || first.tagName !== 'code') return null
  const className = (first.properties as { className?: unknown } | undefined)?.className
  const langs = Array.isArray(className) ? className.map(String) : typeof className === 'string' ? [className] : []
  const langClass = langs.find((c) => c.startsWith('language-')) ?? ''
  const textEls = Array.isArray(first.children) ? first.children : []
  const code = textEls
    .map((c) => (typeof (c as { value?: unknown }).value === 'string' ? (c as { value: string }).value : ''))
    .join('')
    .replace(/\n$/, '')
  if (code === '') return null
  return { language: langClass.replace('language-', '').trim(), code }
}

export const MarkdownView = memo(function MarkdownView({ text, conversationId }: MarkdownViewProps) {
  // 渲染器函数身份必须稳定，否则每次流式文本更新都会重挂载既有代码块。
  const components = useMemo<Components>(() => ({
    pre: ({ children, node }) => {
      const block = extractCodeBlock(node)
      if (block !== null) {
        return <CodeRenderer language={block.language} code={block.code} conversationId={conversationId} />
      }
      return <pre className="code-block-pre selectable">{children}</pre>
    },
    code: ({ className, children }) => <code className={className}>{children}</code>,
    a: ({ href, children }) => (
      <a href={href} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    ),
  }), [conversationId])

  return (
    <div className="msg-ai-body">
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
})
