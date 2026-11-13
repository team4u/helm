import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactMetadata, ArtifactPreviewerProps } from '@helm/protocol'
import { artifactsApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import { useIsMobile } from './composer-model.js'
import { detectLanguage } from './code-language.js'
import { CodeBlockView, MarkdownView } from './MarkdownView.js'
import { MarkdownOutlinePopover } from './MarkdownOutlinePopover.js'
import { buildMarkdownOutline, resolveActiveOutlineEntryId } from './outline-model.js'
import { CopyButton } from './CopyButton.js'
import { formatBytes } from '../lib/format.js'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle } from '../ui/Dialog.js'
import { Select } from '../ui/Select.js'
import { SegmentedControl } from '../ui/Tabs.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { collectArtifactPreviewers } from './artifact-preview-model.js'
import { decodePreviewText, isMarkdown, looksLikeText, MAX_PREVIEW_TEXT_BYTES, shouldDecodeText } from './artifact-preview-text.js'

export interface ArtifactPreviewModalProps {
  artifactId: string
  conversationId?: number
  onClose: () => void
  /** 强制内联渲染（跳过 body portal；node 测试环境 Radix portal 不可用时用）。 */
  inline?: boolean
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'loaded'; blob: Blob; blobUrl: string }
  | { phase: 'error'; message: string }

/** 插件预览器选择：'default' 为宿主默认渲染。 */
type PreviewerChoice = 'default' | string

/** 命中产物元数据时合成给插件组件的标准 Props（协议 ArtifactPreviewerProps）。 */
function buildPreviewerProps(
  artifactId: string,
  conversationId: number | undefined,
  meta: ArtifactMetadata | undefined,
  mime: string,
  size: number,
  blobUrl: string,
  text: string | null,
): ArtifactPreviewerProps {
  return {
    artifactId,
    conversationId,
    name: meta?.name,
    mimeType: mime,
    size,
    blobUrl,
    text,
  }
}

/**
 * 产物智能预览：插件 artifact.previewer 贡献（双轨）+ 宿主默认渲染兜底。
 * - 插件命中需真实会话上下文（scope）与已加载元数据；多命中可切换，可手动切回默认；
 * - text 只解码 ≤1MiB 文本（超限显式说明，不截断伪装）；切换产物/插件移除时
 *   有效回退，ObjectURL 及时回收，绝不让旧 blob/text/name 混入新产物。
 */
export function ArtifactPreviewModal({ artifactId, conversationId, onClose, inline }: ArtifactPreviewModalProps) {
  const store = useHelmStore()
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  const [view, setView] = useState<'rich' | 'source'>('rich')
  const [text, setText] = useState<string | null>(null)
  /** text 为 null 的原因：'idle' 未尝试解码 / 'decoding' 进行中 / 'exceeded' 超 1MiB 上限 / 'binary' 非文本。 */
  const [textState, setTextState] = useState<'idle' | 'decoding' | 'exceeded' | 'binary'>('idle')
  const [previewer, setPreviewer] = useState<PreviewerChoice | null>(null)
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const [activeMarkdownHeading, setActiveMarkdownHeading] = useState<number | undefined>(undefined)
  const modalBodyRef = useRef<HTMLDivElement | null>(null)
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)
  // 移动端固定全屏呈现：小窗模式下标题栏按钮拥挤错位，且滚动区域过于局促。
  const isMobile = useIsMobile(680)
  const isFullscreen = isMobile || desktopFullscreen
  const loadArtifacts = store.loadConversationArtifacts
  const artifactsLoaded = conversationId !== undefined && store.conversationArtifacts[conversationId] !== undefined

  // store 可能以浅拷贝对象传入（如测试 rerender），loadArtifacts 引用会每次变化；
  // 经由 ref 调用，避免 effect 因此重触发导致重复加载。
  const loadArtifactsRef = useRef(loadArtifacts)
  loadArtifactsRef.current = loadArtifacts

  // 深链预览所属会话不一定在主屏或分屏中，不能依赖会话面板预先加载元数据。
  useEffect(() => {
    if (conversationId !== undefined && !artifactsLoaded) void loadArtifactsRef.current(conversationId)
  }, [conversationId, artifactsLoaded])

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

  // 产物加载（含代数竞争保护与 ObjectURL 回收）；MIME 回退在渲染时响应式计算，
  // 深链元数据后到不触发重新拉取。
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setState({ phase: 'loading' })
    setText(null)
    setTextState('idle')
    void artifactsApi
      .fetchBlob(artifactId)
      .then(async (blob) => {
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
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId])

  // MIME：已加载用真实 Blob.type，否则回退元数据（响应式，深链元数据后到不重新拉取）。
  const mime = state.phase === 'loaded' ? (state.blob.type || meta?.mimeType || '') : (meta?.mimeType ?? '')

  // 文本解码（独立于产物加载；MIME 响应式回退，超限显式说明不截断伪装全文）。
  const loadedBlob = state.phase === 'loaded' ? state.blob : undefined
  useEffect(() => {
    if (loadedBlob === undefined) return
    if (!shouldDecodeText(meta, mime)) {
      setText(null)
      setTextState('binary')
      return
    }
    let cancelled = false
    setText(null)
    setTextState('decoding')
    void decodePreviewText(loadedBlob)
      .then((value) => {
        if (cancelled) return
        if (value === null) {
          setTextState('exceeded')
        } else {
          setText(value)
          setTextState('idle')
        }
      })
      .catch(() => {
        if (!cancelled) setTextState('binary')
      })
    return () => {
      cancelled = true
    }
  }, [loadedBlob, mime, meta])

  const conversation = useMemo(
    () => (conversationId !== undefined ? store.conversations.find((c) => c.id === conversationId) : undefined),
    [store.conversations, conversationId],
  )

  // 插件命中判定用已加载的真实元数据（名称未知不猜）；加载中/失败不给插件命中。
  const pluginMatchInput = useMemo(
    () =>
      state.phase === 'loaded'
        ? { name: meta?.name, mimeType: mime }
        : undefined,
    [state, meta, mime],
  )

  const matchedPreviewers = useMemo(
    () =>
      pluginMatchInput === undefined
        ? []
        : collectArtifactPreviewers(store.groupedUi.artifactPreviewers, pluginMatchInput, conversation),
    [store.groupedUi.artifactPreviewers, pluginMatchInput, conversation],
  )

  // 选择回退：未手动选择时默认取命中首位（priority 最高）；已选择项不在命中列表
  // （产物切换 / 插件停用移除 / scope 失配）时回落默认渲染。
  const previewerKey = (p: { pluginId: string; spec: { id: string } }): string => `${p.pluginId}/${p.spec.id}`
  const effectivePreviewer: PreviewerChoice =
    previewer !== null && matchedPreviewers.some((p) => previewerKey(p) === previewer)
      ? previewer
      : previewer === null && matchedPreviewers.length > 0
        ? previewerKey(matchedPreviewers[0]!)
        : 'default'

  const selected = matchedPreviewers.find((p) => previewerKey(p) === effectivePreviewer)

  const name = meta?.name ?? artifactId

  const isImage = mime.startsWith('image/')
  const isAudio = mime.startsWith('audio/')
  const isVideo = mime.startsWith('video/')
  const isPdf = mime === 'application/pdf'
  const isTextLike = !isImage && !isAudio && !isVideo && !isPdf && (looksLikeText(mime) || isMarkdown(meta?.name, mime))
  const markdown = isMarkdown(meta?.name, mime)
  // Markdown 源码模式固定 markdown 高亮；其他文本产物按后缀 / mimeType 推导语言。
  const language = markdown ? 'markdown' : detectLanguage(meta?.name, mime)
  const markdownOutline = useMemo(
    () => markdown && text !== null ? buildMarkdownOutline(text) : [],
    [markdown, text],
  )

  useEffect(() => {
    setActiveMarkdownHeading(undefined)
  }, [artifactId, text])

  useEffect(() => {
    if (!markdown || view !== 'rich' || selected !== undefined || markdownOutline.length === 0) return
    const scrollContainer = modalBodyRef.current
    const content = markdownPreviewRef.current
    if (scrollContainer === null || content === null) return

    const syncActiveHeading = (): void => {
      const containerTop = scrollContainer.getBoundingClientRect().top
      const offsets: Array<{ entryId: string; top: number }> = []
      for (const heading of content.querySelectorAll<HTMLElement>('[data-heading-index]')) {
        const index = heading.dataset.headingIndex
        if (index !== undefined) {
          offsets.push({ entryId: index, top: heading.getBoundingClientRect().top - containerTop })
        }
      }
      const active = resolveActiveOutlineEntryId(offsets, 48)
      setActiveMarkdownHeading(active !== undefined ? Number(active) : undefined)
    }

    syncActiveHeading()
    scrollContainer.addEventListener('scroll', syncActiveHeading, { passive: true })
    return () => scrollContainer.removeEventListener('scroll', syncActiveHeading)
  }, [markdown, view, selected, markdownOutline.length, text])

  const jumpToMarkdownHeading = (headingIndex: number): void => {
    const target = markdownPreviewRef.current?.querySelector<HTMLElement>(`[data-heading-index="${headingIndex}"]`)
    if (target === null || target === undefined) return
    target.scrollIntoView({ behavior: 'smooth', block: 'start' })
    setActiveMarkdownHeading(headingIndex)
  }

  const download = (): void => {
    void artifactsApi.downloadToBrowser(artifactId, name).catch((error: unknown) => store.pushNotice({ type: 'notification', level: 'error', title: '下载失败', body: error instanceof Error ? error.message : String(error) }))
  }

  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className={`modal-backdrop${isFullscreen ? ' modal-fullscreen-backdrop' : ''}`}>
          <DialogContent
            className={`modal${isFullscreen ? ' modal-fullscreen' : ''}`}
            aria-label={`产物预览：${name}`}
            style={isFullscreen ? undefined : { maxWidth: 'min(1100px, 94vw)', maxHeight: '90vh' }}
          >
            <div className="modal-header artifact-preview-header">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <HelmIcon name="file-text" size={14} />
                <DialogTitle className="modal-title" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </DialogTitle>
                {state.phase === 'loaded' ? (
                  <span className="badge badge-neutral mono tabular-nums">{formatBytes(state.blob.size)}</span>
                ) : meta !== undefined ? (
                  <span className="badge badge-neutral mono tabular-nums">{formatBytes(meta.size)}</span>
                ) : null}
              </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            {matchedPreviewers.length > 0 ? (
              <Select<PreviewerChoice>
                size="sm"
                value={effectivePreviewer}
                onChange={(e) => setPreviewer(e.target.value)}
                aria-label="预览方式"
                className="artifact-previewer-select"
                options={[
                  { value: 'default', label: '默认预览' },
                  ...matchedPreviewers.map((p) => ({
                    value: `${p.pluginId}/${p.spec.id}`,
                    label: p.spec.label,
                    meta: p.spec.title,
                  })),
                ]}
              />
            ) : null}
            {markdown && effectivePreviewer === 'default' && view === 'rich' && markdownOutline.length > 0 ? (
              <MarkdownOutlinePopover
                text={text ?? ''}
                activeHeadingIndex={activeMarkdownHeading}
                onSelectHeading={jumpToMarkdownHeading}
              />
            ) : null}
            {markdown && effectivePreviewer === 'default' ? (
              <SegmentedControl<'rich' | 'source'>
                value={view}
                onValueChange={(v) => setView(v)}
                aria-label="视图模式"
                items={[
                  { value: 'rich', label: '富文本' },
                  { value: 'source', label: '源码' },
                ]}
              />
            ) : null}
            {!isMobile ? (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setDesktopFullscreen((v) => !v)}
                title={desktopFullscreen ? '切换为窗口模式' : '全屏预览'}
              >
                <HelmIcon name={desktopFullscreen ? 'minimize-2' : 'maximize-2'} size={12} />
                {desktopFullscreen ? '窗口' : '全屏'}
              </button>
            ) : null}
            {markdown && text !== null ? (
              <CopyButton text={text} label={isMobile ? undefined : '复制'} className="btn btn-sm" />
            ) : null}
            <button type="button" className="btn btn-sm" onClick={download} title="下载">
              <HelmIcon name="download" size={12} />
              {!isMobile ? '下载' : null}
            </button>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                title="关闭 (Esc)"
                aria-label="关闭预览"
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </span>
        </div>
        <div className="modal-body" ref={modalBodyRef}>
          {state.phase === 'loading' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--fg-muted)', fontSize: 12, padding: 24, justifyContent: 'center' }}>
              <HelmIcon name="loader" size={14} className="spin-slow" />
              正在加载产物…
            </div>
          ) : null}
          {state.phase === 'error' ? (
            <div className="callout callout--error">
              <HelmIcon name="alert-circle" size={13} />
              <span style={{ wordBreak: 'break-all' }}>产物加载失败：{state.message}</span>
            </div>
          ) : null}
          {state.phase === 'loaded' && selected !== undefined ? (
            <>
              <div className="artifact-plugin-view">
                <PluginUiView
                  pluginId={selected.pluginId}
                  spec={selected.spec}
                  conversationId={conversationId}
                  slotProps={{
                    ...buildPreviewerProps(
                      artifactId,
                      conversationId,
                      meta,
                      mime,
                      state.blob.size,
                      state.blobUrl,
                      text,
                    ),
                  }}
                  label={`预览 ${selected.spec.label}`}
                />
              </div>
              {textState === 'exceeded' ? (
                <div className="callout">文本内容超过 {formatBytes(MAX_PREVIEW_TEXT_BYTES)} 预览上限，已停止解码，text 为 null。请下载文件查看完整内容。</div>
              ) : null}
              <div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setPreviewer('default')}
                  title="切回宿主默认预览"
                >
                  <HelmIcon name="rotate-ccw" size={12} />
                  默认预览
                </button>
              </div>
            </>
          ) : null}
          {state.phase === 'loaded' && selected === undefined ? (
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
              <div className="callout">此文件类型暂不支持在线预览，请下载后查看。</div>
            ) : textState === 'exceeded' ? (
              <div className="callout">
                文本内容超过 {formatBytes(MAX_PREVIEW_TEXT_BYTES)} 预览上限，已停止解码。请下载文件查看完整内容。
              </div>
            ) : markdown && view === 'rich' && text !== null ? (
              <div ref={markdownPreviewRef} className="artifact-markdown-preview">
                <MarkdownView text={text} conversationId={conversationId} />
              </div>
            ) : (
              <div style={{ overflow: 'auto', minHeight: 200 }}>
                <CodeBlockView code={text ?? '正在读取文本…'} language={language} />
              </div>
            )
          ) : null}
        </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
