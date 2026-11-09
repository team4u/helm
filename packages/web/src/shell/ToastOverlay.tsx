import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export function ToastOverlay() {
  const store = useHelmStore()
  if (store.notices.length === 0) return null

  return (
    <div className="toast-overlay">
      {store.notices.map((n) => {
        const toneClass =
          n.level === 'error'
            ? 'jr-callout-err'
            : n.level === 'warning'
              ? 'jr-callout-warn'
              : ''
        return (
          <div
            key={n.id}
            className={`jr-callout toast-item ${toneClass}`}
          >
            <div className="toast-content">
              <div className="toast-title">
                <HelmIcon
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
                    store.openTarget({ kind: 'conversation', conversationId: n.conversationId! })
                    store.dismissNotice(n.id)
                  }}
                >
                  <span>查看会话 #{n.conversationId}</span>
                </button>
              )}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-sm btn-icon-xs"
              onClick={() => store.dismissNotice(n.id)}
            >
              <HelmIcon name="x" size={12} />
            </button>
          </div>
        )
      })}
    </div>
  )
}
