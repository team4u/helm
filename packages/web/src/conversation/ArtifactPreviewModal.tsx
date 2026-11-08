import { useEffect, useMemo, useState } from 'react'
import type { ArtifactMetadata } from '@helm/protocol'
import { artifactsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { detectLanguage } from './code-language.js'
import { CodeBlockView, MarkdownView } from './MarkdownView.js'
import { formatBytes } from './timeline-model.js'

export interface ArtifactPreviewModalProps {
  artifactId: string
  conversationId?: number
  onClose: () => void
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; blobUrl: string; mime: string; meta?: ArtifactMetadata }
  | { phase: 'error'; message: string }

const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-yaml|x-sh))/i

function isMarkdown(name: string | undefined, mime: string): boolean {
  if (mime.startsWith('text/markdown')) return true
  if (name !== undefined && /\.md$/i.test(name)) return true
  return false
}

function looksLikeText(mime: string): boolean {
  return TEXT_MIME_RE.test(mime)
}

/** 产物智能预览：Markdown 富文本/源码切换、代码/JSON 语法高亮、图片/PDF/音视频 ObjectURL。 */
export function ArtifactPreviewModal({ artifactId, conversationId, onClose }: ArtifactPreviewModalProps) {
  const store = useHelmStore()
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [view, setView] = useState<'rich' | 'source'>('rich')
  const [text, setText] = useState<string | null>(null)

  const meta = useMemo(() => {
    if (conversationId === undefined) return undefined
    return (store.conversationArtifacts[conversationId] ?? []).find((a) => a.id === artifactId)
  }, [store.conversationArtifacts, conversationId, artifactId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setState({ phase: 'loading' })
    setText(null)
    void artifactsApi
      .fetchBlob(artifactId)
      .then(async (blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        const mime = blob.type || meta?.mimeType || ''
        setState({ phase: 'loaded', blobUrl: objectUrl, mime, meta })
        if (looksLikeText(mime) || isMarkdown(meta?.name, mime)) {
          const value = await blob.text()
          if (!cancelled) setText(value)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId, meta?.mimeType, meta?.name])

  const name = meta?.name ?? artifactId
  const mime = state.phase === 'loaded' ? state.mime : meta?.mimeType ?? ''

  const isImage = mime.startsWith('image/')
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isPdf = mime === 'application/pdf'
  const isTextLike = !isImage && !isAudio && !isVideo && !isPdf && (looksLikeText(mime) || isMarkdown(meta?.name, mime))
  const markdown = isMarkdown(meta?.name, mime)
  // Markdown 源码模式固定 markdown 高亮；其他文本产物按后缀 / mimeType 推导语言。
  const language = markdown ? 'markdown' : detectLanguage(meta?.name, mime)

  const download = (): void => {
    void artifactsApi.downloadToBrowser(artifactId, name).catch((error: unknown) => store.pushNotice({ type: 'notification', level: 'error', title: '下载失败', body: error instanceof Error ? error.message : String(error) }))
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={`产物预览：${name}`}
        style={{ maxWidth: 'min(960px, 92vw)', maxHeight: '88vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <HelmIcon name="file-text" size={14} />
            <span className="modal-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {name}
            </span>
            {meta !== undefined ? (
              <span className="badge badge-neutral mono tabular-nums">{formatBytes(meta.size)}</span>
            ) : null}
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {markdown ? (
              <span className="btn-group" role="group">
                <button
                  type="button"
                  className={`btn btn-sm${view === 'rich' ? ' btn-primary' : ''}`}
                  onClick={() => setView('rich')}
                >
                  富文本
                </button>
                <button
                  type="button"
                  className={`btn btn-sm${view === 'source' ? ' btn-primary' : ''}`}
                  onClick={() => setView('source')}
                >
                  源码
                </button>
              </span>
            ) : null}
            <button type="button" className="btn btn-sm" onClick={download}>
              <HelmIcon name="download" size={12} />
              下载文件
            </button>
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} title="关闭 (Esc)">
              <HelmIcon name="x" size={13} />
            </button>
          </span>
        </div>
        <div className="modal-body">
          {state.phase === 'loading' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-muted)', fontSize: 12, padding: 24, justifyContent: 'center' }}>
              <HelmIcon name="loader" size={14} className="spin-slow" />
              正在加载产物…
            </div>
          ) : null}
          {state.phase === 'error' ? (
            <div className="jr-callout jr-callout-err">
              <HelmIcon name="alert-circle" size={13} />
              <span style={{ wordBreak: 'break-all' }}>产物加载失败：{state.message}</span>
            </div>
          ) : null}
          {state.phase === 'loaded' ? (
            isImage ? (
              <img
                src={state.blobUrl}
                alt={name}
                style={{ maxWidth: '100%', maxHeight: '64vh', objectFit: 'contain', margin: '0 auto', display: 'block', borderRadius: 'var(--radius-sm)' }}
              />
            ) : isAudio ? (
              // eslint-disable-next-line jsx-a11y/media-has-caption
              <audio controls src={state.blobUrl} style={{ width: '100%' }} />
            ) : isVideo ? (
              <video controls src={state.blobUrl} style={{ width: '100%', maxHeight: '64vh' }} />
            ) : isPdf ? (
              <iframe src={state.blobUrl} title={name} style={{ width: '100%', height: '64vh', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }} />
            ) : !isTextLike ? (
              <div className="jr-callout">此文件类型暂不支持在线预览，请下载后查看。</div>
            ) : markdown && view === 'rich' && text !== null ? (
              <MarkdownView text={text} conversationId={conversationId} />
            ) : (
              <div style={{ overflow: 'auto', minHeight: 200 }}>
                <CodeBlockView code={text ?? '正在读取文本…'} language={language} />
              </div>
            )
          ) : null}
        </div>
      </div>
    </div>
  )
}
