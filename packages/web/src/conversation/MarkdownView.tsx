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
import { artifactsApi } from '../lib/api.js'
import { markdownUrlTransform, parseArtifactUrl } from './artifact-link.js'

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
    <div className="code-block-wrap code-block-wrap-flush">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxCode code={code} language={language} />
    </div>
  )
}

/** mermaid 图：代码变化时 250ms 防抖，主题切换时即时重绘无闪烁；右上角「放大预览」与「复制源码」。 */
function MermaidBlock({ code }: { code: string }) {
  const { theme } = useHelmStore()
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [zoomOpen, setZoomOpen] = useState(false)
  const seqRef = useRef(0)
  const lastCodeRef = useRef<string | null>(null)

  useEffect(() => {
    const isCodeChanged = lastCodeRef.current !== code
    lastCodeRef.current = code

    const seq = ++seqRef.current
    if (isCodeChanged) {
      setSvg(null)
      setError(null)
    }

    const delay = isCodeChanged ? 250 : 0
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const mermaid = (await import('mermaid')).default
          mermaid.initialize(getMermaidConfig(theme))
          const id = `helm-mermaid-${theme}-${seq}-${Math.random().toString(36).slice(2, 8)}`
          const { svg: rendered } = await mermaid.render(id, code)
          if (seqRef.current === seq) {
            setSvg(rendered)
            setError(null)
          }
        } catch (err) {
          if (seqRef.current === seq) {
            setError(err instanceof Error ? err.message : String(err))
            setSvg(null)
          }
        }
      })()
    }, delay)
    return () => clearTimeout(timer)
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
          <div className="jr-callout jr-callout-err jr-callout-flush">
            <span>Mermaid 渲染失败：{error}</span>
          </div>
        ) : (
          <pre className="code-block-pre code-block-pre-flush">
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
    <div className="code-block-wrap spec-block-wrap">
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

interface ArtifactInlineMediaProps {
  artifactId: string
  conversationId?: number
  alt?: string
  title?: string
}

function ArtifactInlineMedia({ artifactId, conversationId, alt, title }: ArtifactInlineMediaProps) {
  const store = useHelmStore()
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const label = alt || title || '产物'

  const openPreview = () => {
    store.setActiveModal({
      kind: 'artifact-preview',
      artifactId,
      ...(conversationId !== undefined ? { conversationId } : {}),
    })
  }

  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    setLoading(true)

    void artifactsApi
      .fetchBlob(artifactId)
      .then((blob) => {
        if (cancelled) return
        createdUrl = URL.createObjectURL(blob)
        setMedia({ url: createdUrl, mime: (blob.type || '').toLowerCase() })
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setLoading(false)
      })

    return () => {
      cancelled = true
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [artifactId])

  if (loading) {
    return (
      <span className="attachment-chip">
        <HelmIcon name="loader" size={11} />
        <span>{label}</span>
      </span>
    )
  }

  if (media !== null) {
    if (media.mime.startsWith('image/')) {
      return (
        <button
          type="button"
          className="attachment-image-thumb"
          title={`点击放大：${label}`}
          onClick={openPreview}
        >
          <img src={media.url} alt={label} loading="lazy" />
        </button>
      )
    }
    if (media.mime.startsWith('audio/')) {
      return <audio controls src={media.url} className="markdown-media-audio" />
    }
    if (media.mime.startsWith('video/')) {
      return (
        <video
          controls
          src={media.url}
          className="markdown-media-video"
        />
      )
    }
  }

  return (
    <button
      type="button"
      className="attachment-chip"
      title={`点击预览：${label}`}
      onClick={openPreview}
    >
      <HelmIcon name="file-text" size={11} />
      <span>{label}</span>
    </button>
  )
}

export const MarkdownView = memo(function MarkdownView({ text, conversationId }: MarkdownViewProps) {
  const store = useHelmStore()
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
    a: ({ href, children }) => {
      const artifactId = parseArtifactUrl(href)
      if (artifactId !== null) {
        return (
          <button
            type="button"
            className="attachment-chip"
            title="点击预览产物"
            onClick={() =>
              store.setActiveModal({
                kind: 'artifact-preview',
                artifactId,
                ...(conversationId !== undefined ? { conversationId } : {}),
              })
            }
          >
            <HelmIcon name="file-text" size={11} />
            <span>{children}</span>
          </button>
        )
      }
      return (
        <a href={href} target="_blank" rel="noreferrer noopener">
          {children}
        </a>
      )
    },
    img: ({ src, alt, title }) => {
      const artifactId = parseArtifactUrl(src)
      if (artifactId !== null) {
        return (
          <ArtifactInlineMedia
            artifactId={artifactId}
            conversationId={conversationId}
            alt={alt}
            title={title}
          />
        )
      }
      return <img src={src} alt={alt} title={title} loading="lazy" />
    },
  }), [conversationId, store])

  return (
    <div className="msg-ai-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        urlTransform={markdownUrlTransform}
        components={components}
      >
        {text}
      </Markdown>
    </div>
  )
})
