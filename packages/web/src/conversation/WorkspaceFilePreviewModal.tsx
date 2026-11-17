import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { SegmentedControl } from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { conversationsApi } from '../lib/api.js'
import { useHelmStore } from '../lib/store-context.js'
import { isMarkdown, looksLikeText, shouldDecodeText } from './artifact-preview-text.js'
import { detectLanguage } from './code-language.js'
import { FilePreviewBody } from './FilePreviewBody.js'
import { MarkdownOutlinePopover } from './MarkdownOutlinePopover.js'
import { PreviewModalShell } from './PreviewModalShell.js'
import { useFilePreviewText, useMarkdownOutlineSync, type FilePreviewLoadState } from './use-file-preview.js'

export interface WorkspaceFilePreviewModalProps {
  conversationId: number
  path: string
  startLine?: number
  endLine?: number
  onClose: () => void
  /** Force inline rendering (skips body portal in node test environments). */
  inline?: boolean
}

function posixDirname(filePath: string): string | undefined {
  const slashIdx = filePath.lastIndexOf('/')
  if (slashIdx <= 0) return undefined
  return filePath.slice(0, slashIdx)
}

function posixBasename(filePath: string): string {
  const slashIdx = filePath.lastIndexOf('/')
  return slashIdx === -1 ? filePath : filePath.slice(slashIdx + 1)
}

/**
 * Workspace file preview modal: loads `/api/conversations/:id/files/content`
 * and renders media, rich Markdown (with recursive `workspaceBaseDir`), or
 * syntax-highlighted source with optional `#L<start>(-L<end>)` line highlight.
 */
export function WorkspaceFilePreviewModal({
  conversationId,
  path,
  startLine,
  endLine,
  onClose,
  inline,
}: WorkspaceFilePreviewModalProps): ReactNode {
  const store = useHelmStore()
  const { t } = useWebLocale()
  const [state, setState] = useState<FilePreviewLoadState>({ phase: 'loading' })
  const [view, setView] = useState<'rich' | 'source'>(() => (startLine !== undefined ? 'source' : 'rich'))
  const modalBodyRef = useRef<HTMLDivElement | null>(null)
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setView(startLine !== undefined ? 'source' : 'rich')
  }, [conversationId, path, startLine])

  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    const controller = new AbortController()
    setState({ phase: 'loading' })
    void conversationsApi
      .fetchWorkspaceFileBlob(conversationId, path, true, controller.signal)
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setState({ phase: 'loaded', blob, blobUrl: objectUrl })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ phase: 'error', message: err instanceof Error ? err.message : String(err) })
        }
      })
    return () => {
      cancelled = true
      controller.abort()
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [conversationId, path])

  const fileName = posixBasename(path)
  const workspaceBaseDir = posixDirname(path)
  const fileMeta = useMemo(() => ({ name: fileName }), [fileName])
  const mime = state.phase === 'loaded' ? state.blob.type : ''
  const loadedBlob = state.phase === 'loaded' ? state.blob : undefined
  const { text, textState } = useFilePreviewText(loadedBlob, fileMeta, mime)

  const isImage = mime.startsWith('image/')
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isPdf = mime === 'application/pdf'
  const isTextLike =
    !isImage &&
    !isAudio &&
    !isVideo &&
    !isPdf &&
    (looksLikeText(mime) || isMarkdown(fileName, mime) || shouldDecodeText(fileMeta, mime))
  const markdown = isMarkdown(fileName, mime)
  const language = markdown ? 'markdown' : detectLanguage(fileName, mime)

  const { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading } = useMarkdownOutlineSync({
    markdown,
    active: view === 'rich',
    text,
    modalBodyRef,
    markdownPreviewRef,
    resetKey: `${conversationId}:${path}`,
  })

  const highlightLines = useMemo(
    () => (startLine !== undefined ? { start: startLine, ...(endLine !== undefined ? { end: endLine } : {}) } : undefined),
    [startLine, endLine],
  )

  const lineBadge =
    startLine !== undefined
      ? endLine !== undefined && endLine > startLine
        ? t('conv.workspaceFile.lineRange', { start: startLine, end: endLine })
        : t('conv.workspaceFile.lineSingle', { line: startLine })
      : null

  const download = (): void => {
    void conversationsApi
      .downloadWorkspaceFileToBrowser(conversationId, path, fileName)
      .catch((error: unknown) =>
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title: t('conv.artifact.downloadFailed'),
          body: error instanceof Error ? error.message : String(error),
        }),
      )
  }

  return (
    <PreviewModalShell
      title={path}
      ariaLabel={t('conv.workspaceFile.previewAria', { path })}
      inline={inline}
      onClose={onClose}
      onDownload={download}
      state={state}
      loadingLabel={t('conv.workspaceFile.loading')}
      errorLabel={state.phase === 'error' ? t('conv.workspaceFile.loadFailed', { message: state.message }) : ''}
      copyText={text}
      modalBodyRef={modalBodyRef}
      headerBadges={
        lineBadge !== null ? (
          <span className="badge badge-neutral mono tabular-nums">{lineBadge}</span>
        ) : undefined
      }
      headerActions={
        markdown ? (
          <>
            {view === 'rich' && markdownOutline.length > 0 ? (
              <MarkdownOutlinePopover
                text={text ?? ''}
                activeHeadingIndex={activeMarkdownHeading}
                onSelectHeading={jumpToMarkdownHeading}
              />
            ) : null}
            <SegmentedControl<'rich' | 'source'>
              value={view}
              onValueChange={(v) => setView(v)}
              aria-label={t('conv.artifact.viewModeAria')}
              items={[
                { value: 'rich', label: t('conv.artifact.viewRich') },
                { value: 'source', label: t('conv.artifact.viewSource') },
              ]}
            />
          </>
        ) : null
      }
    >
      {state.phase === 'loaded' ? (
        <FilePreviewBody
          name={fileName}
          mime={mime}
          blobUrl={state.blobUrl}
          text={text}
          textState={textState}
          isTextLike={isTextLike}
          markdown={markdown}
          view={view}
          language={language}
          conversationId={conversationId}
          workspaceBaseDir={workspaceBaseDir}
          markdownPreviewRef={markdownPreviewRef}
          showLineNumbers={text !== null}
          highlightLines={highlightLines}
        />
      ) : null}
    </PreviewModalShell>
  )
}
