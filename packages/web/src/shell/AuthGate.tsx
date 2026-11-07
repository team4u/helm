import { useState, type FormEvent } from 'react'
import { authApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export function AuthGate() {
  const store = useHelmStore()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSetup = !store.authConfigured

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (isSetup && password.length < 8) {
      setError('主控密码至少需要 8 位字符')
      return
    }
    if (isSetup && password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      const res = isSetup
        ? await authApi.setup(password)
        : await authApi.login(password)
      await store.onAuthenticated(res.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : '认证失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--bg)',
        padding: 24,
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="card"
        style={{
          width: '100%',
          maxWidth: 380,
          padding: '24px 24px 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: 'var(--shadow-md)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <HelmIcon name="sparkles" size={18} />
            <span style={{ fontSize: 16, fontWeight: 600 }}>Helm 主控台</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={store.toggleTheme}
            title="切换明暗主题"
          >
            <HelmIcon name={store.theme === 'light' ? 'moon' : 'sun'} size={14} />
          </button>
        </div>

        <div style={{ fontSize: 12.5, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {isSetup
            ? '首次启动：请设置本机 Helm 主控密码（至少 8 位），用于保护会话、模型凭据与 Herdr 终端桥。'
            : '请输入本机 Helm 主控密码以解锁工作台。'}
        </div>

        {error && (
          <div className="jr-callout jr-callout-err">
            <HelmIcon name="alert-circle" size={14} />
            <span>{error}</span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ fontSize: 12, color: 'var(--fg-secondary)', fontWeight: 500 }}>
            {isSetup ? '设置主控密码' : '主控密码'}
          </label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? '至少 8 位字符' : '输入主控密码'}
            autoFocus
            required
          />
        </div>

        {isSetup && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={{ fontSize: 12, color: 'var(--fg-secondary)', fontWeight: 500 }}>
              确认主控密码
            </label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="再次输入密码"
              required
            />
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={submitting} style={{ height: 34 }}>
          <HelmIcon name="lock" size={13} />
          <span>{submitting ? '正在验证...' : isSetup ? '初始化并进入 Helm' : '解锁主控台'}</span>
        </button>
      </form>
    </div>
  )
}
