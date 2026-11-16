import { useState, type FormEvent } from 'react'
import { authApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
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
      setError('Master password needs at least 8 characters')
      return
    }
    if (isSetup && password !== confirm) {
      setError('The two passwords do not match')
      return
    }
    setSubmitting(true)
    try {
      const res = isSetup
        ? await authApi.setup(password)
        : await authApi.login(password)
      await store.onAuthenticated(res.token)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-gate" style={{ height: '100dvh' }}>
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="card auth-gate-card"
      >
        <div className="auth-gate-header">
          <div className="auth-gate-brand">
            <HelmIcon name="sparkles" size={18} />
            <span className="auth-gate-title">Helm Console</span>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-icon-sm"
            onClick={store.toggleTheme}
            title={
              store.themePreference === 'system'
                ? `System theme (currently ${store.theme === 'dark' ? 'Dark' : 'Light'}; click to switch to light mode)`
                : store.themePreference === 'light'
                  ? 'Light mode (click to switch to dark mode)'
                  : 'Dark mode (click to switch to system theme)'
            }
          >
            <HelmIcon
              name={
                store.themePreference === 'system'
                  ? 'monitor'
                  : store.themePreference === 'light'
                    ? 'sun'
                    : 'moon'
              }
              size={14}
            />
          </button>
        </div>

        <div className="auth-gate-desc">
          {isSetup
            ? 'First start: set the local Helm master password (at least 8 characters) to protect conversations, model credentials and node connections.'
            : 'Enter the local Helm master password to unlock the console.'}
        </div>

        {error && (
          <div className="callout callout-error" role="alert">
            <HelmIcon name="alert-circle" size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="auth-gate-field">
          <label className="auth-gate-label">
            {isSetup ? 'Set master password' : 'Master password'}
          </label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? 'At least 8 characters' : 'Enter master password'}
            autoFocus
            required
          />
        </div>

        {isSetup && (
          <div className="auth-gate-field">
            <label className="auth-gate-label">
              Confirm master password
            </label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Re-enter the password"
              required
            />
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          <HelmIcon name="lock" size={13} />
          <span>{submitting ? 'Verifying...' : isSetup ? 'Initialize and enter Helm' : 'Unlock console'}</span>
        </button>
      </form>
    </div>
  )
}
