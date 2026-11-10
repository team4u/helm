/**
 * builtin:magpie 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - MagpieSettingsPanel：设置面板（网关状态 / 诊断 / 配额 / 路由轨迹；
 *   docs: status 实时订阅；refresh 动作经 ctx.callAction）。
 *
 * 诚实性：reachable=false 时 modelCount 标注为缓存计数；lastError 与
 * diagnostics 如实展示；apiKey 绝不进入任何展示路径。
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import { usePluginContext, usePluginDoc } from '@helm/plugin-client'
import {
  boolLabel,
  formatTime,
  parseStatus,
  quotaTone,
  type MagpieStatusView,
} from './models.ts'

import { Activity, Gauge, Loader2, RefreshCw, Route, Server } from 'lucide-react'

function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="mp-loading" role="status">
      <Loader2 size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="mp-error" role="alert">
      <span>{message}</span>
    </div>
  )
}

/** 网关状态概览（KeyValueList 同构布局）。 */
function StatusSummary({ status }: { status: MagpieStatusView }): ReactNode {
  return (
    <div className="mp-kv-list">
      <div className="mp-kv-key">网关地址</div>
      <div className="mp-kv-val">{status.gatewayUrl || '—'}</div>
      <div className="mp-kv-key">本机 loopback</div>
      <div className="mp-kv-val">{boolLabel(status.local)}</div>
      <div className="mp-kv-key">可达</div>
      <div className="mp-kv-val">
        <span className={`badge badge-${status.reachable ? 'ok' : 'warn'}`}>
          <span>{boolLabel(status.reachable)}</span>
        </span>
      </div>
      <div className="mp-kv-key">{status.reachable ? '模型数' : '模型数（缓存）'}</div>
      <div className="mp-kv-val">{status.modelCount}</div>
      <div className="mp-kv-key">路由组数</div>
      <div className="mp-kv-val">{status.groupCount}</div>
      <div className="mp-kv-key">最近刷新</div>
      <div className="mp-kv-val">{formatTime(status.lastRefreshedAt) || '—'}</div>
      {status.lastError !== undefined ? (
        <>
          <div className="mp-kv-key">最近错误</div>
          <div className="mp-kv-val">{status.lastError}</div>
        </>
      ) : null}
    </div>
  )
}

/** 诊断列表（不可用项；空时如实展示无诊断信息）。 */
function DiagnosticsTable({ diagnostics }: { diagnostics: string[] }): ReactNode {
  return (
    <div className="mp-table-wrap">
      <table className="mp-table">
        <thead>
          <tr>
            <th>不可用项</th>
          </tr>
        </thead>
        <tbody>
          {diagnostics.length === 0 ? (
            <tr>
              <td className="mp-table-empty">无诊断信息</td>
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

/** 配额表（剩余百分比按阈值着色）。 */
function QuotaTable({ quotas }: { quotas: MagpieStatusView['quotas'] }): ReactNode {
  return (
    <div className="mp-table-wrap">
      <table className="mp-table">
        <thead>
          <tr>
            <th>Provider</th>
            <th>账号</th>
            <th>窗口</th>
            <th>剩余 %</th>
            <th>重置</th>
          </tr>
        </thead>
        <tbody>
          {quotas.length === 0 ? (
            <tr>
              <td colSpan={5} className="mp-table-empty">
                暂无配额数据
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

/** 路由轨迹表。 */
function RouteTable({ routes }: { routes: MagpieStatusView['routes'] }): ReactNode {
  return (
    <div className="mp-table-wrap">
      <table className="mp-table">
        <thead>
          <tr>
            <th>路由组</th>
            <th>策略</th>
            <th>Provider</th>
            <th>命中模型</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {routes.length === 0 ? (
            <tr>
              <td colSpan={5} className="mp-table-empty">
                暂无路由记录
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

/** Magpie 网关设置面板（状态 + 诊断 + 配额 + 路由轨迹 + 刷新动作）。 */
export function MagpieSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
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
    <div className="mp-panel">
      <div className="mp-header">
        <div className="mp-section-title">
          <Server size={13} strokeWidth={1.75} />
          <span>Magpie 网关</span>
        </div>
        <button type="button" className="btn btn-xs" disabled={refreshing} onClick={refresh}>
          {refreshing ? <Loader2 size={11} className="spin-slow" /> : <RefreshCw size={11} />}
          <span>{refreshing ? '刷新中...' : '刷新模型目录'}</span>
        </button>
      </div>
      {status.summaryText !== '' ? <div className="mp-summary">{status.summaryText}</div> : null}
      {error !== undefined ? <ActionError message={error} /> : null}
      {doc === undefined ? (
        <DocLoading label="网关状态读取中..." />
      ) : (
        <>
          <StatusSummary status={status} />
          <div className="mp-section">
            <div className="mp-section-title">
              <Activity size={12} strokeWidth={1.75} />
              <span>诊断</span>
            </div>
            <DiagnosticsTable diagnostics={status.diagnostics} />
          </div>
          <div className="mp-section">
            <div className="mp-section-title">
              <Gauge size={12} strokeWidth={1.75} />
              <span>配额</span>
            </div>
            <QuotaTable quotas={status.quotas} />
          </div>
          <div className="mp-section">
            <div className="mp-section-title">
              <Route size={12} strokeWidth={1.75} />
              <span>路由轨迹</span>
            </div>
            <RouteTable routes={status.routes} />
          </div>
        </>
      )}
    </div>
  )
}
