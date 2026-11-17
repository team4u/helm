import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { SkillSummary } from '@helm/protocol/browser'
import { HelmIcon, CopyButton, Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, Select } from '@helm/plugin-client'
import type { SelectOption } from '@helm/plugin-client'
import { CodeBlockView, MarkdownView } from '../conversation/MarkdownView.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import {
  getSkillSourceBadge,
  skillsApi,
} from './skill-center-model.js'
import {
  buildSkillFileList,
  isSkillMarkdownFile,
  renderSkillDocMarkdown,
  skillFileLanguage,
} from './skill-reader-model.js'

export interface SkillDetailDrawerProps {
  skill: SkillSummary | null
  open: boolean
  onClose: () => void
  /** Render inline explicitly (for tests and unified SSR assertions). */
  inline?: boolean
  /** Initial content injection (mainly for SSR tests asserting the doc area). */
  initialContent?: string
  /** Custom file reading implementation; defaults to skillsApi.read. */
  readSkill?: (id: string, path?: string) => Promise<{ text: string }>
}

/** Reading mode for Markdown files: rich rendering or monospace source. */
type SkillViewMode = 'rich' | 'source'

/**
 * Skill center detail drawer with a compact file reader:
 * - built on the Radix UI Dialog wrapper, 520px-560px right slide-over;
 * - header shows the icon, name, source badge (built-in / shared / workspace /
 *   plugin), skill ID and the close button;
 * - below the header is a single-row compact file toolbar, then one scrolling
 *   reader area filling the rest of the viewport;
 * - multiple files switch through the common Select dropdown (short file name
 *   + directory hint); a single file shows its name directly, no file tab
 *   wall;
 * - Markdown files support rich-text / source dual-mode reading, unified
 *   across desktop and mobile: rich mode converts the leading YAML
 *   frontmatter into a "skill metadata" Markdown table inside the single
 *   .skill-reader-doc content flow (no mobile-specific metadata layout, no
 *   standalone description block between toolbar and body); source mode keeps
 *   the raw YAML unconverted; code files use CodeBlockView with
 *   suffix-derived highlighting;
 * - async reads go through skillsApi.read with algebraic race protection
 *   (loadGenerationRef) so interleaved loads never overwrite each other;
 * - follows the zero-emoji rule and Fast Refresh conventions strictly.
 */
export function SkillDetailDrawer({
  skill,
  open,
  onClose,
  inline = false,
  initialContent,
  readSkill,
}: SkillDetailDrawerProps): React.JSX.Element {
  const { t } = useWebLocale()
  const [loading, setLoading] = useState(false)
  const [content, setContent] = useState<string>(() => initialContent ?? '')
  const [error, setError] = useState<string | null>(null)
  const [activePath, setActivePath] = useState<string>('')
  const [viewMode, setViewMode] = useState<SkillViewMode>('rich')
  const loadGenerationRef = useRef(0)

  const files = useMemo(() => buildSkillFileList(skill?.references, t), [skill?.references, t])
  const activeIndex = Math.max(
    0,
    files.findIndex((f) => f.path === activePath),
  )
  const activeFile = files[activeIndex]
  const activeDisplayPath = activeFile?.displayPath ?? 'SKILL.md'
  const isMarkdown = isSkillMarkdownFile(activePath)
  const richText = isMarkdown && viewMode === 'rich'

  // Switching skills resets to the root SKILL.md and rich-text mode
  useEffect(() => {
    setActivePath('')
    setViewMode('rich')
  }, [skill?.id])

  // Async load of the skill file content with strict race protection
  useEffect(() => {
    if (!skill || !open) {
      if (initialContent === undefined) {
        setContent('')
      }
      setError(null)
      setLoading(false)
      return
    }

    const gen = ++loadGenerationRef.current
    setLoading(true)
    setError(null)

    const reader = readSkill ?? skillsApi.read
    reader(skill.id, activePath || undefined)
      .then((res) => {
        if (loadGenerationRef.current === gen) {
          setContent(res.text ?? '')
          setLoading(false)
        }
      })
      .catch((err) => {
        if (loadGenerationRef.current === gen) {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      })
  }, [skill?.id, activePath, open, readSkill, initialContent])

  const sourceBadge = skill ? getSkillSourceBadge(skill, t) : null
  const badgeClass =
    sourceBadge?.variant === 'builtin'
      ? 'badge badge-neutral'
      : sourceBadge?.variant === 'plugin'
        ? 'badge badge-neutral mono'
        : sourceBadge?.variant === 'agents'
          ? 'badge badge-accent'
          : 'badge badge-neutral'

  const fileOptions: Array<SelectOption<string>> = files.map((f) => ({
    value: f.path,
    label: f.fileName,
    meta: f.meta,
  }))

  const displayText = richText ? renderSkillDocMarkdown(content, t) : content
  const sourceLanguage = skillFileLanguage(activePath)
  const lineCount = content === '' ? 0 : content.split('\n').length

  return (
    <Dialog
      open={open}
      inline={inline}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop skill-drawer-backdrop" />
        <DialogContent
          className="primary-drawer-content skill-drawer-content"
          role="dialog"
          aria-label={
            skill
              ? t('skills.drawer.detailsTitle', { name: skill.name || skill.id })
              : t('skills.drawer.detailsFallback')
          }
        >
          {/* Drawer top header */}
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title break-word">
                    {skill?.name || skill?.id || t('skills.drawer.detailsFallback')}
                  </DialogTitle>
                  {sourceBadge && (
                    <span className={badgeClass} title={t('skills.card.sourceTitle', { label: sourceBadge.label })}>
                      {sourceBadge.label}
                    </span>
                  )}
                </div>
                {skill && (
                  <div className="primary-drawer-id mono text-subtle break-word" title={skill.id}>
                    {skill.id}
                  </div>
                )}
                {skill?.source === 'agents' && (
                  <div className="text-subtle">{t('skills.drawer.machineSharedRoot')}</div>
                )}
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm"
                aria-label={t('common.close')}
                title={t('common.close')}
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          {/* Drawer body: outer area does not scroll; the reader is the only scroll container */}
          <div className="primary-drawer-body">
            {!skill ? (
              <div className="empty-state">{t('skills.drawer.noSkillSelected')}</div>
            ) : (
              <>
                {/* Compact file reader: single toolbar row + single scrollable reader */}
                <div className="skill-reader">
                  <div className="skill-reader-toolbar" role="group" aria-label={t('skills.drawer.toolbarLabel')}>
                    <div className="skill-reader-file">
                      {files.length > 1 ? (
                        <Select
                          className="skill-file-select"
                          size="sm"
                          inline={inline}
                          value={activePath}
                          options={fileOptions}
                          onChange={(ev) => setActivePath(ev.target.value)}
                          aria-label={t('skills.drawer.chooseFile')}
                          prefixIcon="file-text"
                        />
                      ) : (
                        <span className="skill-reader-file-label mono" title={activeDisplayPath}>
                          <HelmIcon name={isMarkdown ? 'file-text' : 'file-code'} size={13} />
                          <span>{activeDisplayPath}</span>
                        </span>
                      )}
                    </div>

                    <div className="skill-reader-toolbar-meta">
                      {loading && (
                        <span className="skill-reader-loading text-subtle">
                          <HelmIcon name="loader" size={12} className="spin" />
                          <span>{t('common.loading')}</span>
                        </span>
                      )}
                      {isMarkdown && (
                        <div
                          className="segmented-control skill-reader-mode"
                          role="group"
                          aria-label={t('skills.drawer.readingMode')}
                        >
                          <button
                            type="button"
                            className="segmented-control-btn"
                            aria-pressed={richText}
                            title={t('skills.drawer.richTitle')}
                            onClick={() => setViewMode('rich')}
                          >
                            <HelmIcon name="eye" size={12} />
                            <span>{t('skills.drawer.richMode')}</span>
                          </button>
                          <button
                            type="button"
                            className="segmented-control-btn"
                            aria-pressed={viewMode === 'source'}
                            title={t('skills.drawer.sourceTitle')}
                            onClick={() => setViewMode('source')}
                          >
                            <HelmIcon name="code" size={12} />
                            <span>{t('skills.drawer.sourceMode')}</span>
                          </button>
                        </div>
                      )}
                      <span
                        className="badge badge-neutral tabular-nums skill-reader-index"
                        title={t('skills.drawer.fileIndexTitle', { index: activeIndex + 1, total: files.length })}
                      >
                        {`${activeIndex + 1}/${files.length}`}
                      </span>
                      <span
                        className="skill-reader-lines tabular-nums"
                        title={t('skills.drawer.linesTitle', { file: activeDisplayPath })}
                      >
                        {lineCount > 0 ? t('skills.drawer.linesCount', { count: lineCount }) : '--'}
                      </span>
                      <CopyButton
                        className="btn btn-ghost btn-sm skill-reader-copy"
                        text={content}
                        label={t('skills.drawer.copy')}
                      />
                    </div>
                  </div>

                  {/* Single scrollable reader: metadata table and body share one content flow */}
                  <div className="skill-reader-scroll">
                    {/* Body reading area */}
                    <div className="skill-reader-body" data-mode={richText ? 'rich' : 'source'}>
                      {error ? (
                        <div className="callout callout-error" role="alert">
                          <HelmIcon name="alert-circle" size={13} />
                          <span className="callout-text">{t('skills.drawer.readFailed', { error })}</span>
                        </div>
                      ) : loading && content === '' ? (
                        <div className="skill-reader-placeholder text-subtle">
                          <HelmIcon name="loader" size={13} className="spin" />
                          <span>{t('skills.drawer.readingContent')}</span>
                        </div>
                      ) : content === '' ? (
                        <div className="skill-reader-placeholder text-subtle">{t('skills.drawer.fileEmpty')}</div>
                      ) : richText ? (
                        <div className="skill-reader-doc selectable">
                          <MarkdownView text={displayText} />
                        </div>
                      ) : (
                        <div className="skill-reader-code">
                          <CodeBlockView code={content} language={sourceLanguage} />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}
