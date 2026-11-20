import { HelmxIcon } from '@helmx/plugin-client'
import type { ConversationSummary } from '@helmx/protocol/browser'
import { useConversations, useNotices, useStoreActions } from '../lib/store-context.js'
import { resolveTargetString, type ResolvedTarget } from '../lib/types.js'
import { useWebLocale } from '../i18n/use-web-locale.js'

/**
 * Resolve the single standard "View" action target of a notice:
 * - `view` (declarative deep-link) takes precedence; unresolvable strings warn
 *   and render no button (never a fake or guessed destination);
 * - legacy `conversationId` notices keep navigating to that conversation.
 */
function resolveNoticeTarget(
  notice: { id: string; title: string; view?: string; conversationId?: number },
  conversations: ConversationSummary[],
): ResolvedTarget | null {
  if (notice.view !== undefined) {
    const resolved = resolveTargetString(notice.view, conversations)
    if (resolved === null) {
      console.warn(`[toast] notification "${notice.title}" carries an unresolvable view target: ${notice.view}`)
      return null
    }
    return resolved
  }
  if (notice.conversationId !== undefined) {
    return { kind: 'conversation', conversationId: notice.conversationId }
  }
  return null
}

export function ToastOverlay() {
  const notices = useNotices()
  const conversations = useConversations()
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
        const actionTarget = resolveNoticeTarget(n, conversations)
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
              {actionTarget && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm toast-action-btn"
                  onClick={() => {
                    openTarget(actionTarget)
                    dismissNotice(n.id)
                  }}
                >
                  <span>{t('shell.toast.view')}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon-xs toast-close-btn"
              aria-label={t('shell.toast.dismiss')}
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
