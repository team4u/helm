import { useEffect, useMemo, useRef, useState } from 'react'
import type { ArtifactMetadata, ArtifactPreviewerProps } from '@helm/protocol/browser'
import { resolveLocalizedText } from '@helm/protocol/browser'
import { artifactsApi } from '../lib/api.js'
import { HelmIcon, Select, SegmentedControl } from '@helm/plugin-client'
import {
  useConversationArtifacts,
  useConversationSummary,
  useGroupedUi,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { detectLanguage } from './code-language.js'
import { FilePreviewBody } from './FilePreviewBody.js'
import { MarkdownOutlinePopover } from './MarkdownOutlinePopover.js'
import { PreviewModalShell } from './PreviewModalShell.js'
import { formatBytes } from '../lib/format.js'
import { PluginUiView } from '../ui/PluginUiView.js'
import { collectArtifactPreviewers } from './artifact-preview-model.js'
import { isMarkdown, looksLikeText, MAX_PREVIEW_TEXT_BYTES, shouldDecodeText } from './artifact-preview-text.js'
import { useFilePreviewText, useMarkdownOutlineSync, type FilePreviewLoadState } from './use-file-preview.js'

export interface ArtifactPreviewModalProps {
  artifactId: string
  conversationId?: number
  onClose: () => void
  /** 强制内联渲染（跳过 body portal；node 测试环境 Radix portal 不可用时用）。 */
  inline?: boolean
}

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
  const convArtifacts = useConversationArtifacts(conversationId)
  const conversation = useConversationSummary(conversationId)
  const groupedUi = useGroupedUi()
  const { loadConversationArtifacts, pushNotice } = useStoreActions()
  const { locale, t } = useWebLocale()
  const [state, setState] = useState<FilePreviewLoadState>({ phase: 'loading' })
  const [view, setView] = useState<'rich' | 'source'>('rich')
  const [previewer, setPreviewer] = useState<PreviewerChoice | null>(null)
  const modalBodyRef = useRef<HTMLDivElement | null>(null)
  const markdownPreviewRef = useRef<HTMLDivElement | null>(null)
  const artifactsLoaded = conversationId !== undefined && convArtifacts !== undefined

  // store 可能以浅拷贝对象传入（如测试 rerender），loadArtifacts 引用会每次变化；
  // 经由 ref 调用，避免 effect 因此重触发导致重复加载。
  const loadArtifactsRef = useRef(loadConversationArtifacts)
  loadArtifactsRef.current = loadConversationArtifacts

  // 深链预览所属会话不一定在主屏或分屏中，不能依赖会话面板预先加载元数据。
  useEffect(() => {
    if (conversationId !== undefined && !artifactsLoaded) void loadArtifactsRef.current(conversationId)
  }, [conversationId, artifactsLoaded])

  const meta = useMemo(() => {
    if (conversationId === undefined) return undefined
    return (convArtifacts ?? []).find((a) => a.id === artifactId)
  }, [convArtifacts, conversationId, artifactId])

  // 产物加载（含代数竞争保护与 ObjectURL 回收）；MIME 回退在渲染时响应式计算，
  // 深链元数据后到不触发重新拉取。
  useEffect(() => {
    let objectUrl: string | null = null
    let cancelled = false
    setState({ phase: 'loading' })
    void artifactsApi
      .fetchBlob(artifactId)
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
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl)
    }
  }, [artifactId])

  // MIME：已加载用真实 Blob.type，否则回退元数据（响应式，深链元数据后到不重新拉取）。
  const mime = state.phase === 'loaded' ? (state.blob.type || meta?.mimeType || '') : (meta?.mimeType ?? '')
  const loadedBlob = state.phase === 'loaded' ? state.blob : undefined
  const { text, textState } = useFilePreviewText(loadedBlob, meta, mime)

  // 插件命中判定用已加载的真实元数据（名称未知不猜）；加载中/失败不给插件命中。
  const metaName = meta?.name
  const pluginMatchInput = useMemo(
    () =>
      state.phase === 'loaded'
        ? { name: metaName, mimeType: mime }
        : undefined,
    [state.phase, metaName, mime],
  )

  const matchedPreviewers = useMemo(
    () =>
      pluginMatchInput === undefined
        ? []
        : collectArtifactPreviewers(groupedUi.artifactPreviewers, pluginMatchInput, conversation),
    [groupedUi.artifactPreviewers, pluginMatchInput, conversation],
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
  const isTextLike =
    !isImage &&
    !isAudio &&
    !isVideo &&
    !isPdf &&
    (looksLikeText(mime) || isMarkdown(meta?.name, mime) || shouldDecodeText(meta, mime))
  const markdown = isMarkdown(meta?.name, mime)
  // Markdown 源码模式固定 markdown 高亮；其他文本产物按后缀 / mimeType 推导语言。
  const language = markdown ? 'markdown' : detectLanguage(meta?.name, mime)

  const { markdownOutline, activeMarkdownHeading, jumpToMarkdownHeading } = useMarkdownOutlineSync({
    markdown,
    active: view === 'rich' && selected === undefined,
    text,
    modalBodyRef,
    markdownPreviewRef,
    resetKey: artifactId,
  })

  const download = (): void => {
    void artifactsApi.downloadToBrowser(artifactId, name).catch((error: unknown) => pushNotice({ type: 'notification', level: 'error', title: t('conv.artifact.downloadFailed'), body: error instanceof Error ? error.message : String(error) }))
  }

  return (
    <PreviewModalShell
      title={name}
      ariaLabel={t('conv.artifact.previewAria', { name })}
      inline={inline}
      onClose={onClose}
      onDownload={download}
      state={state}
      fallbackSize={meta?.size}
      loadingLabel={t('conv.artifact.loading')}
      errorLabel={state.phase === 'error' ? t('conv.artifact.loadFailed', { message: state.message }) : ''}
      copyText={markdown ? text : undefined}
      modalBodyRef={modalBodyRef}
      headerActions={
        <>
          {matchedPreviewers.length > 0 ? (
            <Select<PreviewerChoice>
              size="sm"
              value={effectivePreviewer}
              onChange={(e) => setPreviewer(e.target.value)}
              aria-label={t('conv.artifact.previewModeAria')}
              className="artifact-previewer-select"
              options={[
                { value: 'default', label: t('conv.artifact.defaultPreview') },
                ...matchedPreviewers.map((p) => ({
                  value: `${p.pluginId}/${p.spec.id}`,
                  label: resolveLocalizedText(p.spec.label, locale),
                  meta: p.spec.title !== undefined ? resolveLocalizedText(p.spec.title, locale) : undefined,
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
              aria-label={t('conv.artifact.viewModeAria')}
              items={[
                { value: 'rich', label: t('conv.artifact.viewRich') },
                { value: 'source', label: t('conv.artifact.viewSource') },
              ]}
            />
          ) : null}
        </>
      }
    >
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
              label={t('conv.attachment.previewName', { name: resolveLocalizedText(selected.spec.label, locale) })}
            />
          </div>
          {textState === 'exceeded' ? (
            <div className="callout">{t('conv.artifact.textExceededPlugin', { limit: formatBytes(MAX_PREVIEW_TEXT_BYTES) })}</div>
          ) : null}
          <div>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => setPreviewer('default')}
              title={t('conv.artifact.switchDefaultTitle')}
            >
              <HelmIcon name="rotate-ccw" size={12} />
              {t('conv.artifact.defaultPreview')}
            </button>
          </div>
        </>
      ) : null}
      {state.phase === 'loaded' && selected === undefined ? (
        <FilePreviewBody
          name={name}
          mime={mime}
          blobUrl={state.blobUrl}
          text={text}
          textState={textState}
          isTextLike={isTextLike}
          markdown={markdown}
          view={view}
          language={language}
          conversationId={conversationId}
          markdownPreviewRef={markdownPreviewRef}
        />
      ) : null}
    </PreviewModalShell>
  )
}
