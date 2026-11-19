import { HelmxIcon } from '@helmx/plugin-client'
import { useNotices, useStoreActions } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

export function ToastOverlay() {
  const notices = useNotices()
  const { openTarget, dismissNotice } = useStoreActions()
  const { t } = useWebLocale()
  if (notices.length === 0) return null

  return (
    <div className="toast-overlay">
      {notices.map((n) => {
        const toneClass =
          n.level === 'error'
            ? 'callout-error'
            : n.level === 'warning'
              ? 'callout-warn'
              : ''
        return (
          <div
            key={n.id}
            data-notice-id={n.id}
            role={n.level === 'error' ? 'alert' : 'status'}
            className={`callout toast-item ${toneClass}`.trim()}
          >
            <div className="toast-content">
              <div className="toast-title">
                <HelmxIcon
                  name={
                    n.level === 'error'
                      ? 'alert-circle'
                      : n.level === 'warning'
                        ? 'alert-triangle'
                        : 'activity'
                  }
                  size={13}
                />
                <span>{n.title}</span>
              </div>
              {n.body && (
                <div className="toast-body">
                  {n.body}
                </div>
              )}
              {n.conversationId !== undefined && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm toast-action-btn"
                  onClick={() => {
                    openTarget({ kind: 'conversation', conversationId: n.conversationId! })
                    dismissNotice(n.id)
                  }}
                >
                  <span>{t('shell.toast.viewConversation', { id: n.conversationId })}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon-xs"
              onClick={() => dismissNotice(n.id)}
            >
              <HelmxIcon name="x" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
