import { useEffect, useState, type ReactNode, type RefObject } from 'react'
import {
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmIcon,
} from '@helm/plugin-client'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { formatBytes } from '../lib/format.js'
import { useIsMobile } from './composer-model.js'
import type { FilePreviewLoadState } from './use-file-preview.js'

export interface PreviewModalShellProps {
  title: string
  ariaLabel: string
  inline?: boolean
  onClose: () => void
  onDownload: () => void
  state: FilePreviewLoadState
  fallbackSize?: number
  loadingLabel: string
  errorLabel: string
  copyText?: string | null
  headerBadges?: ReactNode
  headerActions?: ReactNode
  modalBodyRef: RefObject<HTMLDivElement | null>
  children?: ReactNode
}

/**
 * Shared modal shell for ArtifactPreviewModal and WorkspaceFilePreviewModal:
 * Radix Dialog, mobile/desktop fullscreen toggle, copy/download/close controls,
 * and standard loading/error states.
 */
export function PreviewModalShell({
  title,
  ariaLabel,
  inline,
  onClose,
  onDownload,
  state,
  fallbackSize,
  loadingLabel,
  errorLabel,
  copyText,
  headerBadges,
  headerActions,
  modalBodyRef,
  children,
}: PreviewModalShellProps): ReactNode {
  const { t } = useWebLocale()
  const [desktopFullscreen, setDesktopFullscreen] = useState(false)
  const isMobile = useIsMobile(680)
  const isFullscreen = isMobile || desktopFullscreen

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <Dialog open inline={inline} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPortal inline={inline}>
        <DialogOverlay className={`modal-backdrop${isFullscreen ? ' modal-fullscreen-backdrop' : ''}`}>
          <DialogContent
            className={`modal${isFullscreen ? ' modal-fullscreen' : ''}`}
            aria-label={ariaLabel}
            style={isFullscreen ? undefined : { maxWidth: 'min(1100px, 94vw)', maxHeight: '90vh' }}
          >
            <div className="modal-header artifact-preview-header">
              <span className="preview-modal-title-group">
                <HelmIcon name="file-text" size={14} />
                <DialogTitle className="modal-title preview-modal-title" title={title}>
                  {title}
                </DialogTitle>
                {state.phase === 'loaded' ? (
                  <span className="badge badge-neutral mono tabular-nums">{formatBytes(state.blob.size)}</span>
                ) : fallbackSize !== undefined ? (
                  <span className="badge badge-neutral mono tabular-nums">{formatBytes(fallbackSize)}</span>
                ) : null}
                {headerBadges}
              </span>
              <span className="preview-modal-actions">
                {headerActions}
                {!isMobile ? (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => setDesktopFullscreen((v) => !v)}
                    title={desktopFullscreen ? t('conv.artifact.windowModeTitle') : t('conv.artifact.fullscreenTitle')}
                  >
                    <HelmIcon name={desktopFullscreen ? 'minimize-2' : 'maximize-2'} size={12} />
                    {desktopFullscreen ? t('conv.artifact.windowLabel') : t('conv.pane.fullscreen')}
                  </button>
                ) : null}
                {copyText !== undefined && copyText !== null ? (
                  <CopyButton text={copyText} label={isMobile ? undefined : t('conv.artifact.copy')} className="btn btn-sm" />
                ) : null}
                <button type="button" className="btn btn-sm" onClick={onDownload} title={t('common.download')}>
                  <HelmIcon name="download" size={12} />
                  {!isMobile ? t('common.download') : null}
                </button>
                <DialogClose asChild>
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon-sm"
                    title={t('conv.artifact.closeTitle')}
                    aria-label={t('conv.artifact.closeAria')}
                  >
                    <HelmIcon name="x" size={14} />
                  </button>
                </DialogClose>
              </span>
            </div>
            <div className="modal-body" ref={modalBodyRef}>
              {state.phase === 'loading' ? (
                <div className="preview-modal-loading">
                  <HelmIcon name="loader" size={14} className="spin-slow" />
                  {loadingLabel}
                </div>
              ) : null}
              {state.phase === 'error' ? (
                <div className="callout callout--error">
                  <HelmIcon name="alert-circle" size={13} />
                  <span>{errorLabel}</span>
                </div>
              ) : null}
              {children}
            </div>
          </DialogContent>
        </DialogOverlay>
      </DialogPortal>
    </Dialog>
  )
}
