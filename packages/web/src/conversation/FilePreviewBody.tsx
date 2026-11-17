import type { ReactNode, RefObject } from 'react'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatBytes } from '../lib/format.js'
import { MAX_PREVIEW_TEXT_BYTES } from './artifact-preview-text.js'
import { CodeBlockView, MarkdownView } from './MarkdownView.js'
import type { CodeLineRange } from './syntax-code-model.js'
import type { FilePreviewTextState } from './use-file-preview.js'

export interface FilePreviewBodyProps {
  name: string
  mime: string
  blobUrl: string
  text: string | null
  textState: FilePreviewTextState
  isTextLike: boolean
  markdown: boolean
  view: 'rich' | 'source'
  language: string
  conversationId?: number
  workspaceBaseDir?: string
  markdownPreviewRef: RefObject<HTMLDivElement | null>
  showLineNumbers?: boolean
  highlightLines?: CodeLineRange
}

/**
 * Shared default preview body for images, audio, video, PDF, rich Markdown,
 * and syntax-highlighted source code.
 */
export function FilePreviewBody({
  name,
  mime,
  blobUrl,
  text,
  textState,
  isTextLike,
  markdown,
  view,
  language,
  conversationId,
  workspaceBaseDir,
  markdownPreviewRef,
  showLineNumbers,
  highlightLines,
}: FilePreviewBodyProps): ReactNode {
  const { t } = useWebLocale()
  const isImage = mime.startsWith('image/')
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isPdf = mime === 'application/pdf'

  if (isImage) {
    return (
      <img
        src={blobUrl}
        alt={name}
        className="preview-modal-image"
      />
    )
  }
  if (isAudio) {
    // eslint-disable-next-line jsx-a11y/media-has-caption
    return <audio controls src={blobUrl} className="preview-modal-audio" />
  }
  if (isVideo) {
    return <video controls src={blobUrl} className="preview-modal-video" />
  }
  if (isPdf) {
    return <iframe src={blobUrl} title={name} className="preview-modal-pdf" />
  }
  if (!isTextLike) {
    return <div className="callout">{t('conv.artifact.noInlinePreview')}</div>
  }
  if (textState === 'exceeded') {
    return (
      <div className="callout">
        {t('conv.artifact.textExceededDefault', { limit: formatBytes(MAX_PREVIEW_TEXT_BYTES) })}
      </div>
    )
  }
  if (markdown && view === 'rich' && text !== null) {
    return (
      <div ref={markdownPreviewRef} className="artifact-markdown-preview">
        <MarkdownView
          text={text}
          conversationId={conversationId}
          workspaceBaseDir={workspaceBaseDir}
        />
      </div>
    )
  }
  return (
    <div className="preview-modal-code">
      <CodeBlockView
        code={text ?? t('conv.artifact.readingText')}
        language={language}
        showLineNumbers={showLineNumbers}
        highlightLines={highlightLines}
      />
    </div>
  )
}
