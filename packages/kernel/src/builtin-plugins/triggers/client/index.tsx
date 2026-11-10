/**
 * builtin:triggers 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - TriggersManagerScreen：cron / webhook 管理表（docs: crons + webhooks 实时订阅；
 *   行动作 cron_trigger / cron_delete / webhook_delete 经 ctx.callAction）；
 * - TriggersSettingsPanel：设置面板（计数概览 + 管理入口引导）。
 *
 * secret 边界：webhook secret 不在 doc 中展示（hasSecret 布尔协作契约）；
 * 创建与删除沿用 helm CLI / HTTP 动作端点。
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import { usePluginContext, usePluginDoc } from '@helm/plugin-client'
import {
  formatTime,
  parseCronJobs,
  parseWebhooks,
  targetLabel,
  type CronJobRow,
  type WebhookRow,
} from './models.ts'

import { Clock, ExternalLink, Loader2, Trash2, Webhook, Zap } from 'lucide-react'

function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="tg-loading" role="status">
      <Loader2 size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="tg-error" role="alert">
      <span>{message}</span>
    </div>
  )
}

function RowAction({
  label,
  icon,
  pending,
  danger,
  onClick,
}: {
  label: string
  icon?: ReactNode
  pending?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={pending === true}
      onClick={onClick}
    >
      {pending === true ? <Loader2 size={11} className="spin-slow" /> : icon}
      <span>{label}</span>
    </button>
  )
}

/** 管理表内单行动作（按 id 键控 pending，防并发重复提交）。 */
function useRowAction() {
  const ctx = usePluginContext()
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (key: string, actionId: string, input: Record<string, unknown>): void => {
    if (pending !== undefined) return
    setPending(key)
    setError(undefined)
    void ctx
      .callAction(actionId, input)
      .catch((err: unknown) => {
        setError(`${actionId} 失败：${err instanceof Error ? err.message : String(err)}`)
      })
      .finally(() => {
        setPending(undefined)
      })
  }
  return { pending, error, run }
}

/** Cron 定时任务表。 */
function CronTable({ jobs, loading }: { jobs: CronJobRow[]; loading: boolean }): ReactNode {
  const { pending, error, run } = useRowAction()
  return (
    <div className="tg-section">
      {error !== undefined ? <ActionError message={error} /> : null}
      <div className="jr-table-wrap">
        <table className="jr-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>调度</th>
              <th>指令</th>
              <th>启用</th>
              <th>上次运行</th>
              <th>下次运行</th>
              <th>最近错误</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}>
                  <DocLoading label="Cron 任务读取中..." />
                </td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ color: 'var(--fg-muted)' }}>
                  暂无数据
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.id}</td>
                  <td>{job.schedule}</td>
                  <td className="tg-text-cell" title={job.text}>{job.text}</td>
                  <td>
                    <span className={`badge badge-${job.enabled ? 'ok' : 'neutral'}`}>
                      <span>{job.enabled ? '启用' : '停用'}</span>
                    </span>
                  </td>
                  <td>{formatTime(job.lastRunAt) || '—'}</td>
                  <td>{formatTime(job.nextRunAt) || '—'}</td>
                  <td className="tg-err-cell" title={job.lastError ?? ''}>{job.lastError ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="tg-row-actions">
                      <RowAction
                        label="立即触发"
                        icon={<Zap size={11} />}
                        pending={pending === `trigger:${job.id}`}
                        onClick={() => run(`trigger:${job.id}`, 'cron_trigger', { id: job.id })}
                      />
                      <RowAction
                        label="删除"
                        icon={<Trash2 size={11} />}
                        pending={pending === `delete:${job.id}`}
                        danger
                        onClick={() => run(`delete:${job.id}`, 'cron_delete', { id: job.id })}
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Webhook 端点表。 */
function WebhookTable({ webhooks, loading }: { webhooks: WebhookRow[]; loading: boolean }): ReactNode {
  const { pending, error, run } = useRowAction()
  return (
    <div className="tg-section">
      {error !== undefined ? <ActionError message={error} /> : null}
      <div className="jr-table-wrap">
        <table className="jr-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>描述</th>
              <th>ThreadKey</th>
              <th>创建时间</th>
              <th style={{ textAlign: 'right' }}>操作</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5}>
                  <DocLoading label="Webhook 端点读取中..." />
                </td>
              </tr>
            ) : webhooks.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ color: 'var(--fg-muted)' }}>
                  暂无数据
                </td>
              </tr>
            ) : (
              webhooks.map((hook) => (
                <tr key={hook.id}>
                  <td>{hook.id}</td>
                  <td className="tg-text-cell" title={hook.description ?? ''}>{hook.description ?? '—'}</td>
                  <td>{hook.threadKey ?? '—'}</td>
                  <td>{formatTime(hook.createdAt) || '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <div className="tg-row-actions">
                      <RowAction
                        label="删除"
                        icon={<Trash2 size={11} />}
                        pending={pending === `webhook-delete:${hook.id}`}
                        danger
                        onClick={() => run(`webhook-delete:${hook.id}`, 'webhook_delete', { id: hook.id })}
                      />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** 触发器管理全屏视图（cron + webhook 管理表）。 */
export function TriggersManagerScreen(props: ScreenProps): ReactNode {
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)

  return (
    <div className="tg-screen">
      <div className="tg-screen-header">
        <div className="tg-screen-title">
          <Clock size={15} strokeWidth={1.75} />
          <span>触发器管理</span>
        </div>
        <span className="tg-screen-subtitle">
          Cron {jobs.length} · Webhook {hooks.length}
          {props.isSplit ? ' · 分屏' : ''}
        </span>
      </div>

      <div className="tg-section">
        <div className="tg-section-title">
          <Clock size={13} strokeWidth={1.75} />
          <span>Cron 定时任务</span>
        </div>
        <CronTable jobs={jobs} loading={crons === undefined} />
      </div>

      <div className="tg-section">
        <div className="tg-section-title">
          <Webhook size={13} strokeWidth={1.75} />
          <span>Webhook 端点</span>
        </div>
        <WebhookTable webhooks={hooks} loading={webhooks === undefined} />
      </div>

      <div className="tg-note">
        secret 不在文档中展示；创建与删除请使用 helm cron / helm webhook 命令或对应动作端点。
      </div>
    </div>
  )
}

/** 触发器设置面板：计数概览 + 管理视图 / CLI 引导。 */
export function TriggersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)

  return (
    <div className="tg-screen">
      <div className="tg-section-title">
        <Clock size={13} strokeWidth={1.75} />
        <span>触发器</span>
      </div>
      {crons === undefined || webhooks === undefined ? (
        <DocLoading label="触发器状态读取中..." />
      ) : (
        <div className="jr-kv-list">
          <div className="jr-kv-key">Cron 任务数</div>
          <div className="jr-kv-val">{jobs.length}</div>
          <div className="jr-kv-key">Webhook 端点数</div>
          <div className="jr-kv-val">{hooks.length}</div>
        </div>
      )}
      <div className="tg-note">
        cron 调度细节与 webhook 验签 secret 的管理请前往触发器管理视图或使用 helm CLI。
      </div>
      <div>
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => ctx.openScreen('screen:builtin:triggers/manager')}
        >
          <ExternalLink size={11} />
          <span>打开触发器管理</span>
        </button>
      </div>
    </div>
  )
}
