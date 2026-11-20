/**
 * Hub 变更日志弹窗（已安装版本 changelog，数据来自随包分发的 CHANGELOG.md）：
 * - 侧栏底部「版本与更新」入口打开全量视图；
 * - 总览升级提示条带 `from` 打开「本次更新」切片（跨过的版本，新版本在上）；
 * - 未随附 changelog（老 payload / 特殊部署）如实显示空态，不装假数据。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { Dialog, DialogClose, DialogContent, DialogOverlay, DialogPortal, DialogTitle, HelmxIcon } from '@helmx/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { apiRequest, ApiClientError } from '../lib/api.js'
import { useIsMobile } from '../conversation/composer-model.js'
import { MarkdownView } from '../conversation/MarkdownView.js'

interface ChangelogSection {
  version: string
  date: string
  markdown: string
}

interface ChangelogResponse {
  available: boolean
  version: string
  from?: string
  fromMatched?: boolean
  sections?: ChangelogSection[]
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'loaded'; data: ChangelogResponse }

export function HubChangelogModal({ from, onClose, inline = false }: { from?: string; onClose: () => void; inline?: boolean }): ReactNode {
  const { t } = useWebLocale()
  const isMobile = useIsMobile(680)
  const [state, setState] = useState<LoadState>({ phase: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    const path = from !== undefined && from !== '' ? `/api/hub-update/changelog?from=${encodeURIComponent(from)}` : '/api/hub-update/changelog'
    apiRequest<ChangelogResponse>('GET', path, undefined, controller.signal)
      .then((data) => setState({ phase: 'loaded', data }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setState({ phase: 'error', message: error instanceof ApiClientError ? error.message : String(error) })
      })
    return () => controller.abort()
  }, [from])

  const data = state.phase === 'loaded' ? state.data : null
  const sections = data?.sections ?? []
  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className={`modal-backdrop${isMobile ? ' modal-fullscreen-backdrop' : ''}`}>
          <DialogContent
            className={`modal hub-changelog-modal${isMobile ? ' modal-fullscreen' : ''}`}
            aria-label={t('shell.hubChangelog.title')}
            style={isMobile ? undefined : { maxWidth: 'min(860px, 94vw)', maxHeight: '88vh' }}
          >
            <div className="modal-header hub-changelog-header">
              <span className="preview-modal-title-group">
                <HelmxIcon name="file-text" size={14} />
                <DialogTitle className="modal-title preview-modal-title">{t('shell.hubChangelog.title')}</DialogTitle>
                {data !== null ? (
                  <span className="badge badge-neutral mono tabular-nums">v{data.version}</span>
                ) : null}
                {data?.from !== undefined ? (
                  <span className="badge badge-neutral tabular-nums">
                    {data.fromMatched === true
                      ? t('shell.hubChangelog.range', { from: data.from, count: sections.length })
                      : t('shell.hubChangelog.rangeOlder', { from: data.from, count: sections.length })}
                  </span>
                ) : null}
              </span>
              <span className="preview-modal-actions">
                <DialogClose asChild>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    title={t('shell.hubChangelog.closeTitle')}
                    aria-label={t('shell.hubChangelog.closeTitle')}
                  >
                    <HelmxIcon name="x" size={14} />
                  </button>
                </DialogClose>
              </span>
            </div>
            <div className="modal-body hub-changelog-body">
              {state.phase === 'loading' ? (
                <div className="preview-modal-loading">
                  <HelmxIcon name="loader" size={14} className="spin-slow" />
                  {t('shell.hubChangelog.loading')}
                </div>
              ) : null}
              {state.phase === 'error' ? (
                <div className="callout callout--error">{state.message}</div>
              ) : null}
              {state.phase === 'loaded' && data !== null && data.available !== true ? (
                <div className="callout">{t('shell.hubChangelog.absent')}</div>
              ) : null}
              {state.phase === 'loaded' && data !== null && data.available === true && sections.length === 0 ? (
                <div className="callout">{t('shell.hubChangelog.emptyRange')}</div>
              ) : null}
              {sections.map((section) => (
                <section key={section.version} className="hub-changelog-section">
                  <header className="hub-changelog-section-head">
                    <span className="hub-changelog-version mono tabular-nums">v{section.version}</span>
                    <span className="hub-changelog-date tabular-nums">{section.date}</span>
                  </header>
                  <MarkdownView text={section.markdown} />
                </section>
              ))}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
