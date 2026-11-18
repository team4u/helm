import { createContext, Fragment, memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Markdown, { type Components, type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { SyntaxCode } from './SyntaxCode.js'
import type { CodeLineRange } from './syntax-code-model.js'
import { CopyButton, HelmIcon, markdownUrlTransform, parseArtifactUrl } from '@helm/plugin-client'
import type { MarkdownViewProps } from '@helm/plugin-client'
import { useConversationSummary, useStoreActions } from '../lib/store-context.js'
import { LazyMount } from '../ui/LazyMount.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { CodeBlockRenderer } from './CodeBlockRenderer.js'
import { artifactsApi, conversationsApi } from '../lib/api.js'
import {
  isDisallowedFileUrl,
  parseWorkspaceFileRef,
  type WorkspaceFileRef,
} from './workspace-file-url.js'
import {
  countHeadingsUpToH3,
  remarkHeadingIndices,
  splitStreamingMarkdownBlocks,
} from './markdown-model.js'

/** 整篇渲染（非流式与 gate 回退路径）复用同一无状态插件组；breaks 路径追加 remark-breaks（用户手输正文单换行即换行）。 */
const wholeDocumentRemarkPlugins = [remarkGfm, remarkHeadingIndices]
const wholeDocumentBreaksRemarkPlugins = [remarkGfm, remarkBreaks, remarkHeadingIndices]

/**
 * 流式尾部块媒体抑制上下文：流式输出期间，仅尾部仍在增长的块设为 true，
 * 避免未闭合或正在拼接的图片 URL 在流式过程中反复发网络请求。
 * 使用轻量 Context 传递，保持 Markdown `components` 对象引用恒定，确保前缀块不重挂载。
 */
const DeferWorkspaceMediaContext = createContext(false)

/** 宿主标准 Markdown 渲染的 props 契约唯一真源在 @helm/plugin-client（本组件经宿主端口注入 SDK）。 */
export type { MarkdownViewProps }

/**
 * 独立语法高亮代码块（产物/工作区预览等非 Markdown 场景消费）：
 * 语言为空串时优雅回退普通等宽代码样式，不猜造语言。
 */
export function CodeBlockView({
  code,
  language,
  showLineNumbers,
  highlightLines,
}: {
  code: string
  language: string
  showLineNumbers?: boolean
  highlightLines?: CodeLineRange
}): ReactNode {
  return (
    <div className="code-block-wrap code-block-wrap-flush">
      <div className="code-block-header">
        <span>{language === '' ? 'text' : language}</span>
        <CopyButton text={code} />
      </div>
      <SyntaxCode
        code={code}
        language={language}
        showLineNumbers={showLineNumbers}
        highlightLines={highlightLines}
      />
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

interface InlineMediaViewProps {
  media: { url: string; mime: string } | null
  loading: boolean
  label: string
  onOpenPreview: () => void
}

function InlineMediaView({ media, loading, label, onOpenPreview }: InlineMediaViewProps): ReactNode {
  const { t } = useWebLocale()

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
          title={t('conv.attachment.clickToEnlarge', { name: label })}
          onClick={onOpenPreview}
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
      title={t('conv.attachment.clickToPreview', { label })}
      onClick={onOpenPreview}
    >
      <HelmIcon name="file-text" size={11} />
      <span>{label}</span>
    </button>
  )
}

interface ArtifactInlineMediaProps {
  artifactId: string
  conversationId?: number
  alt?: string
  title?: string
}

function ArtifactInlineMedia({ artifactId, conversationId, alt, title }: ArtifactInlineMediaProps): ReactNode {
  const { setActiveModal } = useStoreActions()
  const { t } = useWebLocale()
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const label = alt || title || t('conv.attachment.fallbackLabel')

  const openPreview = () => {
    setActiveModal({
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

  return (
    <InlineMediaView
      media={media}
      loading={loading}
      label={label}
      onOpenPreview={openPreview}
    />
  )
}

interface WorkspaceInlineMediaProps {
  conversationId: number
  fileRef: WorkspaceFileRef
  alt?: string
  title?: string
}

function WorkspaceInlineMedia({ conversationId, fileRef, alt, title }: WorkspaceInlineMediaProps): ReactNode {
  const { setActiveModal } = useStoreActions()
  const { t } = useWebLocale()
  const [media, setMedia] = useState<{ url: string; mime: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const label = alt || title || fileRef.path.split('/').pop() || t('conv.attachment.workspaceFileFallback')

  const openPreview = () => {
    setActiveModal({
      kind: 'workspace-file',
      conversationId,
      path: fileRef.path,
      ...(fileRef.startLine !== undefined ? { startLine: fileRef.startLine } : {}),
      ...(fileRef.endLine !== undefined ? { endLine: fileRef.endLine } : {}),
    })
  }

  useEffect(() => {
    let cancelled = false
    let createdUrl: string | null = null
    const controller = new AbortController()
    setLoading(true)
    setMedia(null)

    void conversationsApi
      .fetchWorkspaceFileBlob(conversationId, fileRef.path, true, controller.signal)
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
      controller.abort()
      if (createdUrl !== null) {
        URL.revokeObjectURL(createdUrl)
      }
    }
  }, [conversationId, fileRef.path])

  return (
    <InlineMediaView
      media={media}
      loading={loading}
      label={label}
      onOpenPreview={openPreview}
    />
  )
}

function WorkspaceMediaGate({
  conversationId,
  fileRef,
  alt,
  title,
}: WorkspaceInlineMediaProps): ReactNode {
  const defer = useContext(DeferWorkspaceMediaContext)
  const { t } = useWebLocale()
  const label = alt || title || fileRef.path.split('/').pop() || t('conv.attachment.workspaceFileFallback')

  if (defer) {
    return (
      <span className="attachment-chip">
        <HelmIcon name="file-text" size={11} />
        <span>{label}</span>
      </span>
    )
  }

  return (
    <LazyMount
      inline
      fallback={
        <span className="attachment-chip">
          <HelmIcon name="file-text" size={11} />
          <span>{label}</span>
        </span>
      }
    >
      <WorkspaceInlineMedia
        conversationId={conversationId}
        fileRef={fileRef}
        alt={alt}
        title={title}
      />
    </LazyMount>
  )
}

/**
 * 单块独立解析渲染。默认 memo 浅比较：block / headingOffset / components / deferMediaFetch 均不变
 * 即整块复用（零重解析、零重挂载）；全部比较都是不可变 prop 值，无共享可变状态。
 */
interface StreamingMarkdownBlockProps {
  block: string
  /** 本块之前文档已出现的 H1~H3 数量（父组件从纯计数前缀和预算）。 */
  headingOffset: number
  components: Components
  deferMediaFetch: boolean
  /** 单换行渲染为硬换行（用户手输正文）；与整篇路径的 breaks 语义一致。 */
  breaks: boolean
}

const StreamingMarkdownBlock = memo(function StreamingMarkdownBlock({
  block,
  headingOffset,
  components,
  deferMediaFetch,
  breaks,
}: StreamingMarkdownBlockProps): ReactNode {
  const remarkPlugins: Options['remarkPlugins'] = breaks
    ? [remarkGfm, remarkBreaks, [remarkHeadingIndices, { offset: headingOffset }]]
    : [remarkGfm, [remarkHeadingIndices, { offset: headingOffset }]]
  return (
    <DeferWorkspaceMediaContext.Provider value={deferMediaFetch}>
      <Markdown remarkPlugins={remarkPlugins} urlTransform={markdownUrlTransform} components={components}>
        {block}
      </Markdown>
    </DeferWorkspaceMediaContext.Provider>
  )
})

export const MarkdownView = memo(function MarkdownView({
  text,
  conversationId,
  streaming,
  breaks,
  workspaceBaseDir,
}: MarkdownViewProps): ReactNode {
  const { setActiveModal } = useStoreActions()
  const summary = useConversationSummary(conversationId)
  const { t } = useWebLocale()
  const conversationCwd = summary?.cwd

  // 渲染器函数身份必须稳定，否则每次流式文本更新都会重挂载既有代码块。
  const components = useMemo<Components>(() => ({
    pre: ({ children, node }) => {
      const block = extractCodeBlock(node)
      if (block !== null) {
        const lineCount = block.code.split('\n').length
        const estimatedHeight = Math.min(420, Math.max(72, lineCount * 20 + 40))
        return (
          <LazyMount
            minHeight={estimatedHeight}
            fallback={
              <div className="code-block-wrap">
                <div className="code-block-header">
                  <span>{block.language === '' ? 'text' : block.language}</span>
                </div>
                <pre className="code-block-pre selectable">
                  <code>{block.code}</code>
                </pre>
              </div>
            }
          >
            <CodeBlockRenderer language={block.language} code={block.code} conversationId={conversationId} />
          </LazyMount>
        )
      }
      return <pre className="msg-md-pre-fallback code-block-pre selectable">{children}</pre>
    },
    code: ({ className, children }) => <code className={className}>{children}</code>,
    table: ({ children }) => (
      <div className="msg-md-table-wrap">
        <table>{children}</table>
      </div>
    ),
    a: ({ href, children }) => {
      const artifactId = parseArtifactUrl(href)
      if (artifactId !== null) {
        return (
          <button
            type="button"
            className="attachment-chip"
            title={t('conv.attachment.clickToPreviewArtifact')}
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
      if (conversationId !== undefined) {
        const fileRef = parseWorkspaceFileRef(href, { conversationCwd, workspaceBaseDir })
        if (fileRef !== null) {
          return (
            <button
              type="button"
              className="attachment-chip"
              title={t('conv.attachment.clickToPreviewWorkspaceFile', { path: fileRef.path })}
              onClick={() =>
                setActiveModal({
                  kind: 'workspace-file',
                  conversationId,
                  path: fileRef.path,
                  ...(fileRef.startLine !== undefined ? { startLine: fileRef.startLine } : {}),
                  ...(fileRef.endLine !== undefined ? { endLine: fileRef.endLine } : {}),
                })
              }
            >
              <HelmIcon name="file-text" size={11} />
              <span>{children}</span>
            </button>
          )
        }
      }
      if (isDisallowedFileUrl(href)) {
        return <span className="msg-md-disallowed-file">{children}</span>
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
        const label = alt || title || t('conv.attachment.fallbackLabel')
        return (
          <LazyMount
            inline
            fallback={
              <span className="attachment-chip">
                <HelmIcon name="file-text" size={11} />
                <span>{label}</span>
              </span>
            }
          >
            <ArtifactInlineMedia
              artifactId={artifactId}
              conversationId={conversationId}
              alt={alt}
              title={title}
            />
          </LazyMount>
        )
      }
      if (conversationId !== undefined) {
        const fileRef = parseWorkspaceFileRef(src, { conversationCwd, workspaceBaseDir })
        if (fileRef !== null) {
          return (
            <WorkspaceMediaGate
              conversationId={conversationId}
              fileRef={fileRef}
              alt={alt}
              title={title}
            />
          )
        }
      }
      if (isDisallowedFileUrl(src)) {
        const label = alt || title || t('conv.attachment.disallowedFileLabel')
        return (
          <span className="attachment-chip">
            <HelmIcon name="file-text" size={11} />
            <span>{label}</span>
          </span>
        )
      }
      return <img src={src} alt={alt} title={title} loading="lazy" />
    },
  }), [conversationId, conversationCwd, workspaceBaseDir, setActiveModal, t])

  const lastSplitTextRef = useRef<string | null>(null)
  const headingCacheRef = useRef<Map<string, number> | null>(null)

  const lastSplitText = lastSplitTextRef.current
  // 完成/续流帧沿用分块路径的条件：正文仍是已分块正文的 append（或纯尾部收缩，如收尾
  // trim），前缀块 memo 命中、代码块与插件组件保持身份不重挂载；正文被整体替换时回退
  // 整篇渲染并清空会话缓存。
  const continueBlocks =
    lastSplitText !== null && (text.startsWith(lastSplitText) || lastSplitText.startsWith(text))
  const useBlocks = streaming === true || continueBlocks

  if (!useBlocks) {
    lastSplitTextRef.current = null
    headingCacheRef.current = null
    return (
      <div className="msg-ai-body">
        <Markdown
          remarkPlugins={breaks === true ? wholeDocumentBreaksRemarkPlugins : wholeDocumentRemarkPlugins}
          urlTransform={markdownUrlTransform}
          components={components}
        >
          {text}
        </Markdown>
      </div>
    )
  }

  const blocks = splitStreamingMarkdownBlocks(text)
  lastSplitTextRef.current = text
  // 纯计数缓存：块源串 → H1~H3 数量（countHeadingsUpToH3 为纯函数，同源恒同值）。
  // 每帧把缓存界收敛到当前块集合：逐帧增长的旧 tail 源即时清除，缓存有界且随组件
  // 实例卸载释放；并发放弃的渲染只会写入确定的 source→纯值条目，不改变任何已提交
  // 视图的偏移语义。块偏移 = 前序块计数前缀和，作为不可变 prop 传给 memo 块组件。
  const headingCache = (headingCacheRef.current ??= new Map<string, number>())
  const liveSources = new Set<string>()
  const offsets: number[] = []
  let headingTotal = 0
  for (const block of blocks) {
    liveSources.add(block)
    let count = headingCache.get(block)
    if (count === undefined) {
      count = countHeadingsUpToH3(block)
      headingCache.set(block, count)
    }
    offsets.push(headingTotal)
    headingTotal += count
  }
  for (const source of headingCache.keys()) {
    if (!liveSources.has(source)) headingCache.delete(source)
  }
  // 整篇解析在顶层兄弟元素之间恰好生成一个 '\n' 文本节点（分隔空白折叠而来）；片段
  // 解析会丢弃自身首尾空白，故在块间显式补回，保证分块 DOM 与整篇逐字节等价。
  return (
    <div className="msg-ai-body">
      {blocks.map((block, index) => (
        <Fragment key={index}>
          {index > 0 && '\n'}
          <StreamingMarkdownBlock
            block={block}
            headingOffset={offsets[index] ?? 0}
            components={components}
            deferMediaFetch={streaming === true && index === blocks.length - 1}
            breaks={breaks === true}
          />
        </Fragment>
      ))}
    </div>
  )
})
