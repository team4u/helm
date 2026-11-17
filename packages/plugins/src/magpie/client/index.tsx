/**
 * builtin:magpie client.tsx components (component exports only, Fast Refresh
 * contract):
 * - MagpieSettingsPanel: settings panel (gateway status / diagnostics /
 *   quotas / route history; live subscription to the 'status' doc; the
 *   refresh action goes through ctx.callAction).
 *
 * Honesty: when reachable=false the model count is labeled as a cached
 * count; lastError and diagnostics are shown verbatim; the apiKey never
 * enters any display path.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged.
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import { formatTime, usePluginContext, usePluginDoc, usePluginLocale, usePluginTranslator } from '@helm/plugin-client'
import {
  boolLabel,
  parseStatus,
  quotaTone,
  type MagpieStatusView,
} from './models.ts'
import {
  MAGPIE_DIAGNOSTICS_COL,
  MAGPIE_DIAGNOSTICS_EMPTY,
  MAGPIE_DIAGNOSTICS_SECTION,
  MAGPIE_KV_GATEWAY_URL,
  MAGPIE_KV_GROUPS,
  MAGPIE_KV_LAST_ERROR,
  MAGPIE_KV_LAST_REFRESHED,
  MAGPIE_KV_LOCAL_LOOPBACK,
  MAGPIE_KV_MODELS,
  MAGPIE_KV_MODELS_CACHED,
  MAGPIE_KV_REACHABLE,
  MAGPIE_LOADING,
  MAGPIE_QUOTA_COL_ACCOUNT,
  MAGPIE_QUOTA_COL_REMAINING,
  MAGPIE_QUOTA_COL_RESET,
  MAGPIE_QUOTA_COL_WINDOW,
  MAGPIE_QUOTA_EMPTY,
  MAGPIE_QUOTA_SECTION,
  MAGPIE_REFRESH,
  MAGPIE_REFRESHING,
  MAGPIE_ROUTES_COL_GROUP,
  MAGPIE_ROUTES_COL_MODEL,
  MAGPIE_ROUTES_COL_STRATEGY,
  MAGPIE_ROUTES_COL_TIME,
  MAGPIE_ROUTES_EMPTY,
  MAGPIE_ROUTES_SECTION,
  MAGPIE_TITLE,
} from './copy.ts'

import { Activity, Gauge, Loader2, RefreshCw, Route, Server } from 'lucide-react'

function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="loading-state" role="status">
      <Loader2 size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout--error" role="alert">
      <span>{message}</span>
    </div>
  )
}

/** Gateway status overview (KeyValueList-shaped layout). */
function StatusSummary({ status }: { status: MagpieStatusView }): ReactNode {
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  return (
    <div className="kv-list">
      <div className="kv-key">{t(MAGPIE_KV_GATEWAY_URL)}</div>
      <div className="kv-val">{status.gatewayUrl || '—'}</div>
      <div className="kv-key">{t(MAGPIE_KV_LOCAL_LOOPBACK)}</div>
      <div className="kv-val">{boolLabel(status.local, locale)}</div>
      <div className="kv-key">{t(MAGPIE_KV_REACHABLE)}</div>
      <div className="kv-val">
        <span className={`badge badge-${status.reachable ? 'ok' : 'warn'}`}>
          <span>{boolLabel(status.reachable, locale)}</span>
        </span>
      </div>
      <div className="kv-key">{status.reachable ? t(MAGPIE_KV_MODELS) : t(MAGPIE_KV_MODELS_CACHED)}</div>
      <div className="kv-val">{status.modelCount}</div>
      <div className="kv-key">{t(MAGPIE_KV_GROUPS)}</div>
      <div className="kv-val">{status.groupCount}</div>
      <div className="kv-key">{t(MAGPIE_KV_LAST_REFRESHED)}</div>
      <div className="kv-val">{formatTime(status.lastRefreshedAt) || '—'}</div>
      {status.lastError !== undefined ? (
        <>
          <div className="kv-key">{t(MAGPIE_KV_LAST_ERROR)}</div>
          <div className="kv-val">{status.lastError}</div>
        </>
      ) : null}
    </div>
  )
}

/** Diagnostics list (unavailable items; empty state shown honestly when there are none). */
function DiagnosticsTable({ diagnostics }: { diagnostics: string[] }): ReactNode {
  const t = usePluginTranslator()
  return (
    <div className="helm-table-wrap">
      <table className="helm-table">
        <thead>
          <tr>
            <th>{t(MAGPIE_DIAGNOSTICS_COL)}</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.length === 0 ? (
            <tr>
              <td className="table-empty">{t(MAGPIE_DIAGNOSTICS_EMPTY)}</td>
            </tr>
          ) : (
            diagnostics.map((message, i) => (
              <tr key={i}>
                <td>{message}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Quota table (remaining percent colored by threshold). */
function QuotaTable({ quotas }: { quotas: MagpieStatusView['quotas'] }): ReactNode {
  const t = usePluginTranslator()
  return (
    <div className="helm-table-wrap">
      <table className="helm-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>{t(MAGPIE_QUOTA_COL_ACCOUNT)}</th>
            <th>{t(MAGPIE_QUOTA_COL_WINDOW)}</th>
            <th>{t(MAGPIE_QUOTA_COL_REMAINING)}</th>
            <th>{t(MAGPIE_QUOTA_COL_RESET)}</th>
          </tr>
        </thead>
        <tbody>
          {quotas.length === 0 ? (
            <tr>
              <td colSpan={5} className="table-empty">
                {t(MAGPIE_QUOTA_EMPTY)}
              </td>
            </tr>
          ) : (
            quotas.map((q, i) => (
              <tr key={`${q.provider}:${i}`}>
                <td>{q.provider}</td>
                <td>{q.account ?? '—'}</td>
                <td>{q.windowLabel ?? '—'}</td>
                <td>
                  <span className={`badge badge-${quotaTone(q.remainingPercent)}`}>
                    <span>{q.remainingPercent}</span>
                  </span>
                </td>
                <td>{q.resetText ?? '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Route history table. */
function RouteTable({ routes }: { routes: MagpieStatusView['routes'] }): ReactNode {
  const t = usePluginTranslator()
  return (
    <div className="helm-table-wrap">
      <table className="helm-table">
        <thead>
          <tr>
            <th>{t(MAGPIE_ROUTES_COL_GROUP)}</th>
            <th>{t(MAGPIE_ROUTES_COL_STRATEGY)}</th>
            <th>Provider</th>
            <th>{t(MAGPIE_ROUTES_COL_MODEL)}</th>
            <th>{t(MAGPIE_ROUTES_COL_TIME)}</th>
          </tr>
        </thead>
        <tbody>
          {routes.length === 0 ? (
            <tr>
              <td colSpan={5} className="table-empty">
                {t(MAGPIE_ROUTES_EMPTY)}
              </td>
            </tr>
          ) : (
            routes.map((r, i) => (
              <tr key={`${r.group}:${i}`}>
                <td>{r.group}</td>
                <td>{r.strategy ?? '—'}</td>
                <td>{r.provider ?? '—'}</td>
                <td>{r.model ?? '—'}</td>
                <td>{r.timestamp ?? '—'}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

/** Magpie gateway settings panel (status + diagnostics + quotas + route history + refresh action). */
export function MagpieSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const doc = usePluginDoc<MagpieStatusView>('status')
  const status = parseStatus(doc)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const refresh = (): void => {
    if (refreshing) return
    setRefreshing(true)
    setError(undefined)
    void ctx
      .callAction('refresh', {})
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        setRefreshing(false)
      })
  }

  return (
    <div className="screen-container">
      <div className="screen-header">
        <div className="screen-section-title">
          <Server size={13} strokeWidth={1.75} />
          <span>{t(MAGPIE_TITLE)}</span>
        </div>
        <button type="button" className="btn btn-xs" disabled={refreshing} onClick={refresh}>
          {refreshing ? <Loader2 size={11} className="spin-slow" /> : <RefreshCw size={11} />}
          <span>{refreshing ? t(MAGPIE_REFRESHING) : t(MAGPIE_REFRESH)}</span>
        </button>
      </div>
      {status.summaryText !== '' ? <div className="screen-subtitle">{status.summaryText}</div> : null}
      {error !== undefined ? <ActionError message={error} /> : null}
      {doc === undefined ? (
        <DocLoading label={t(MAGPIE_LOADING)} />
      ) : (
        <>
          <StatusSummary status={status} />
          <div className="screen-section">
            <div className="screen-section-title">
              <Activity size={12} strokeWidth={1.75} />
              <span>{t(MAGPIE_DIAGNOSTICS_SECTION)}</span>
            </div>
            <DiagnosticsTable diagnostics={status.diagnostics} />
          </div>
          <div className="screen-section">
            <div className="screen-section-title">
              <Gauge size={12} strokeWidth={1.75} />
              <span>{t(MAGPIE_QUOTA_SECTION)}</span>
            </div>
            <QuotaTable quotas={status.quotas} />
          </div>
          <div className="screen-section">
            <div className="screen-section-title">
              <Route size={12} strokeWidth={1.75} />
              <span>{t(MAGPIE_ROUTES_SECTION)}</span>
            </div>
            <RouteTable routes={status.routes} />
          </div>
        </>
      )}
    </div>
  )
}
