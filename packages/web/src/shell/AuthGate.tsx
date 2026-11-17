import { useState, type FormEvent } from 'react'
import { authApi } from '../lib/api.js'
import { HelmIcon } from '@helm/plugin-client'
import { useAuthConnection, useStoreActions, useThemePreferencesState } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { LocaleMenuButton } from '../ui/LocaleMenuButton.js'

export function AuthGate() {
  const { authConfigured } = useAuthConnection()
  const { theme, themePreference } = useThemePreferencesState()
  const { onAuthenticated, toggleTheme } = useStoreActions()
  const { t } = useWebLocale()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const isSetup = !authConfigured

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    if (isSetup && password.length < 8) {
      setError(t('shell.auth.passwordMin'))
      return
    }
    if (isSetup && password !== confirm) {
      setError(t('shell.auth.passwordMismatch'))
      return
    }
    setSubmitting(true)
    try {
      const res = isSetup
        ? await authApi.setup(password)
        : await authApi.login(password)
      await onAuthenticated(res.token)
    } catch (err) {
      // err.message stays verbatim (server/execution text); only the generic fallback is locale copy.
      setError(err instanceof Error ? err.message : t('shell.auth.failed'))
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
            <span className="auth-gate-title">{t('shell.auth.consoleTitle')}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <LocaleMenuButton
              className="btn btn-ghost btn-icon-sm sidebar-locale-toggle"
              iconSize={14}
              tooltipSide="top"
              menuSide="bottom"
              menuAlign="end"
            />
            <button
              type="button"
              className="btn btn-ghost btn-icon-sm"
              onClick={toggleTheme}
              title={
                themePreference === 'system'
                  ? t('shell.auth.themeSystem', {
                      current: t(theme === 'dark' ? 'shell.theme.currentDark' : 'shell.theme.currentLight'),
                    })
                  : themePreference === 'light'
                    ? t('shell.auth.themeLight')
                    : t('shell.auth.themeDark')
              }
            >
              <HelmIcon
                name={
                  themePreference === 'system'
                    ? 'monitor'
                    : themePreference === 'light'
                      ? 'sun'
                      : 'moon'
                }
                size={14}
              />
            </button>
          </div>
        </div>

        <div className="auth-gate-desc">
          {isSetup ? t('shell.auth.setupDesc') : t('shell.auth.unlockDesc')}
        </div>

        {error && (
          <div className="callout callout-error" role="alert">
            <HelmIcon name="alert-circle" size={14} />
            <span>{error}</span>
          </div>
        )}

        <div className="auth-gate-field">
          <label className="auth-gate-label">
            {isSetup ? t('shell.auth.setPasswordLabel') : t('shell.auth.passwordLabel')}
          </label>
          <input
            type="password"
            className="input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={isSetup ? t('shell.auth.setPasswordPlaceholder') : t('shell.auth.passwordPlaceholder')}
            autoFocus
            required
          />
        </div>

        {isSetup && (
          <div className="auth-gate-field">
            <label className="auth-gate-label">
              {t('shell.auth.confirmLabel')}
            </label>
            <input
              type="password"
              className="input"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={t('shell.auth.confirmPlaceholder')}
              required
            />
          </div>
        )}

        <button type="submit" className="btn btn-primary" disabled={submitting}>
          <HelmIcon name="lock" size={13} />
          <span>{submitting ? t('shell.auth.verifying') : isSetup ? t('shell.auth.initialize') : t('shell.auth.unlock')}</span>
        </button>
      </form>
    </div>
  )
}
