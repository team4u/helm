import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export function ToastOverlay() {
  const store = useHelmStore()
  if (store.notices.length === 0) return null

  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 90,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 360,
      }}
    >
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
            className={`jr-callout ${toneClass}`}
            style={{
              background: 'var(--bg-elevated)',
              boxShadow: 'var(--shadow-md)',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontWeight: 600 }}>
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
                <div style={{ fontSize: 12, color: 'var(--fg-secondary)', wordBreak: 'break-word' }}>
                  {n.body}
                </div>
              )}
              {n.conversationId !== undefined && (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  style={{ width: 'fit-content', padding: '0 4px', marginTop: 2 }}
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
              className="btn btn-ghost btn-sm"
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
