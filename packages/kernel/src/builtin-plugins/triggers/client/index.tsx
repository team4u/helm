/**
 * builtin:triggers 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - TriggersManagerScreen：cron / webhook 管理表（crons + webhooks doc 实时订阅；
 *   行动作 cron_trigger / cron_delete / webhook_delete 经 ctx.callAction）；
 * - TriggersSettingsPanel：设置面板（计数概览 + 管理入口引导）。
 *
 * secret 边界：webhook secret 不在 doc 中展示（hasSecret 布尔协作契约）；
 * 创建与删除沿用 helm CLI / HTTP 动作端点。通用结构一律复用宿主设计系统原语
 * （.screen-container / .helm-table / .kv-list / .callout / .loading-state），
 * 仅保留 tg-note 业务专属提示样式。
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
  type CronJobRow,
  type WebhookRow,
} from './models.ts'

import { Clock, ExternalLink, Loader2, Trash2, Webhook, Zap } from 'lucide-react'

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

/**
 * 管理表内行动作钩子。pending 为全局单值：任一动作在途时全部行按钮统一
 * disabled（杜绝「看似可点实际无动作」），完成后恢复。由 ManagerScreen
 * 持有一份并下传两张表，保证跨表也互斥。
 */
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

interface RowActionApi {
  pending: string | undefined
  error: string | undefined
  run: (key: string, actionId: string, input: Record<string, unknown>) => void
}

function RowAction({
  label,
  icon,
  disabled,
  danger,
  onClick,
}: {
  label: string
  icon?: ReactNode
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      className={`btn btn-xs ${danger === true ? 'btn-danger' : ''}`}
      disabled={disabled === true}
      onClick={onClick}
    >
      {disabled === true ? <Loader2 size={11} className="spin-slow" /> : icon}
      <span>{label}</span>
    </button>
  )
}

/** Cron 定时任务表（动作钩子由上层共享下传）。 */
function CronTable({ jobs, loading, actions }: { jobs: CronJobRow[]; loading: boolean; actions: RowActionApi }): ReactNode {
  const { pending, error, run } = actions
  return (
    <div className="screen-section">
      {error !== undefined ? <ActionError message={error} /> : null}
      <div className="helm-table-wrap">
        <table className="helm-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>调度</th>
              <th>指令</th>
              <th>启用</th>
              <th>上次运行</th>
              <th>下次运行</th>
              <th>最近错误</th>
              <th className="cell-actions">操作</th>
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
                <td colSpan={8} className="table-empty">
                  暂无数据
                </td>
              </tr>
            ) : (
              jobs.map((job) => (
                <tr key={job.id}>
                  <td>{job.id}</td>
                  <td>{job.schedule}</td>
                  <td className="cell-ellipsis" title={job.text}>{job.text}</td>
                  <td>
                    <span className={`badge badge-${job.enabled ? 'ok' : 'neutral'}`}>
                      <span>{job.enabled ? '启用' : '停用'}</span>
                    </span>
                  </td>
                  <td>{formatTime(job.lastRunAt) || '—'}</td>
                  <td>{formatTime(job.nextRunAt) || '—'}</td>
                  <td className="cell-error" title={job.lastError ?? ''}>{job.lastError ?? '—'}</td>
                  <td className="cell-actions">
                    <div className="row-actions-group">
                      <RowAction
                        label="立即触发"
                        icon={<Zap size={11} />}
                        disabled={pending !== undefined}
                        onClick={() => run(`trigger:${job.id}`, 'cron_trigger', { id: job.id })}
                      />
                      <RowAction
                        label="删除"
                        icon={<Trash2 size={11} />}
                        disabled={pending !== undefined}
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

/** Webhook 端点表（动作钩子由上层共享下传）。 */
function WebhookTable({ webhooks, loading, actions }: { webhooks: WebhookRow[]; loading: boolean; actions: RowActionApi }): ReactNode {
  const { pending, error, run } = actions
  return (
    <div className="screen-section">
      {error !== undefined ? <ActionError message={error} /> : null}
      <div className="helm-table-wrap">
        <table className="helm-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>描述</th>
              <th>ThreadKey</th>
              <th>创建时间</th>
              <th className="cell-actions">操作</th>
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
                <td colSpan={5} className="table-empty">
                  暂无数据
                </td>
              </tr>
            ) : (
              webhooks.map((hook) => (
                <tr key={hook.id}>
                  <td>{hook.id}</td>
                  <td className="cell-ellipsis" title={hook.description ?? ''}>{hook.description ?? '—'}</td>
                  <td>{hook.threadKey ?? '—'}</td>
                  <td>{formatTime(hook.createdAt) || '—'}</td>
                  <td className="cell-actions">
                    <div className="row-actions-group">
                      <RowAction
                        label="删除"
                        icon={<Trash2 size={11} />}
                        disabled={pending !== undefined}
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

/** 触发器管理全屏视图（cron + webhook 管理表；跨表共享同一动作互斥锁）。 */
export function TriggersManagerScreen(props: ScreenProps): ReactNode {
  const actions = useRowAction()
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)

  return (
    <div className="screen-container">
      <div className="screen-header">
        <div className="screen-title">
          <Clock size={15} strokeWidth={1.75} />
          <span>触发器管理</span>
        </div>
        <span className="screen-subtitle">
          Cron {jobs.length} · Webhook {hooks.length}
          {props.isSplit ? ' · 分屏' : ''}
        </span>
      </div>

      <div className="screen-section">
        <div className="screen-section-title">
          <Clock size={13} strokeWidth={1.75} />
          <span>Cron 定时任务</span>
        </div>
        <CronTable jobs={jobs} loading={crons === undefined} actions={actions} />
      </div>

      <div className="screen-section">
        <div className="screen-section-title">
          <Webhook size={13} strokeWidth={1.75} />
          <span>Webhook 端点</span>
        </div>
        <WebhookTable webhooks={hooks} loading={webhooks === undefined} actions={actions} />
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
    <div className="screen-container">
      <div className="screen-section-title">
        <Clock size={13} strokeWidth={1.75} />
        <span>触发器</span>
      </div>
      {crons === undefined || webhooks === undefined ? (
        <DocLoading label="触发器状态读取中..." />
      ) : (
        <div className="kv-list">
          <div className="kv-key">Cron 任务数</div>
          <div className="kv-val">{jobs.length}</div>
          <div className="kv-key">Webhook 端点数</div>
          <div className="kv-val">{hooks.length}</div>
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
