import { memo, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { SyntaxCode } from './SyntaxCode.js'
import { CopyButton } from './CopyButton.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { CodeBlockRenderer } from './CodeBlockRenderer.js'
import { artifactsApi } from '../lib/api.js'
import { markdownUrlTransform, parseArtifactUrl } from './artifact-link.js'

export interface MarkdownViewProps {
  text: string
  conversationId?: number
}

/**
 * 独立语法高亮代码块（产物预览等非 Markdown 场景消费）：
 * 语言为空串时优雅回退普通等宽代码样式，不猜造语言。
 */
export function CodeBlockView({ code, language }: { code: string; language: string }): ReactNode {
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

function ArtifactInlineMedia({ artifactId, conversationId, alt, title }: ArtifactInlineMediaProps): ReactNode {
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

export const MarkdownView = memo(function MarkdownView({ text, conversationId }: MarkdownViewProps): ReactNode {
  const { setActiveModal } = useHelmStore()
  // 渲染器函数身份必须稳定，否则每次流式文本更新都会重挂载既有代码块。
  const components = useMemo<Components>(() => ({
    pre: ({ children, node }) => {
      const block = extractCodeBlock(node)
      if (block !== null) {
        return <CodeBlockRenderer language={block.language} code={block.code} conversationId={conversationId} />
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
              setActiveModal({
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
  }), [conversationId, setActiveModal])

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
