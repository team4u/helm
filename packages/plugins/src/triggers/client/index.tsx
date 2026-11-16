/**
 * builtin:triggers 插件 client.tsx 组件（只导出组件，保 Fast Refresh 契约）：
 * - TriggersManagerScreen：cron / webhook 管理表 + 点击行打开右侧详情抽屉；
 *   行动作 cron_trigger / cron_delete / webhook_delete 经 ctx.callAction；
 * - TriggersSettingsPanel：设置面板（计数概览 + 管理入口引导）。
 *
 * secret 边界：webhook secret 不在 doc 中展示（hasSecret 布尔协作契约）；
 * 创建与删除沿用 helm CLI / HTTP 动作端点。通用结构一律复用宿主设计系统与
 * @helm/plugin-client 原语（Screen / ScreenSection / KvGrid / Dialog / HelmIcon /
 * .callout-error / .helm-table / .loading-state），无原生下拉框，零 Emoji。
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helm/protocol'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmIcon,
  KvGrid,
  Screen,
  ScreenSection,
  formatTime,
  usePluginContext,
  usePluginDoc,
} from '@helm/plugin-client'
import {
  formatTriggerTargetSummary,
  parseCronJobs,
  parseWebhooks,
  type CronJobRow,
  type TriggerDetailSelection,
  type WebhookRow,
} from './models.ts'

function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="loading-state" role="status">
      <HelmIcon name="loader" size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout-error" role="alert">
      <HelmIcon name="alert-circle" size={13} />
      <span className="callout-text">{message}</span>
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
  iconName,
  disabled,
  danger,
  onClick,
}: {
  label: string
  iconName: string
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
      <HelmIcon
        name={disabled === true ? 'loader' : iconName}
        size={11}
        className={disabled === true ? 'spin-slow' : undefined}
      />
      <span>{label}</span>
    </button>
  )
}

/** Cron 定时任务表（动作钩子由上层共享下传；点击行打开详情抽屉）。 */
function CronTable({
  jobs,
  loading,
  actions,
  selectedId,
  onSelect,
}: {
  jobs: CronJobRow[]
  loading: boolean
  actions: RowActionApi
  selectedId?: string
  onSelect: (id: string) => void
}): ReactNode {
  const { pending, run } = actions
  return (
    <div className="tg-table-wrap">
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
                <tr
                  key={job.id}
                  className={selectedId === job.id ? 'tg-row is-selected' : 'tg-row'}
                  tabIndex={0}
                  onClick={() => onSelect(job.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(job.id)
                    }
                  }}
                >
                  <td data-label="ID" className="mono">{job.id}</td>
                  <td data-label="调度" className="mono">{job.schedule}</td>
                  <td data-label="指令" className="cell-ellipsis" title={job.text}>{job.text}</td>
                  <td data-label="启用">
                    <span className={`badge badge-${job.enabled ? 'ok' : 'neutral'}`}>
                      <span>{job.enabled ? '启用' : '停用'}</span>
                    </span>
                  </td>
                  <td data-label="上次运行">{formatTime(job.lastRunAt) || '—'}</td>
                  <td data-label="下次运行">{formatTime(job.nextRunAt) || '—'}</td>
                  <td data-label="最近错误" className="cell-error" title={job.lastError ?? ''}>
                    {job.lastError ?? '—'}
                  </td>
                  <td data-label="操作" className="cell-actions">
                    <div
                      className="row-actions-group"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <RowAction
                        label="立即触发"
                        iconName="zap"
                        disabled={pending !== undefined}
                        onClick={() => run(`trigger:${job.id}`, 'cron_trigger', { id: job.id })}
                      />
                      <RowAction
                        label="删除"
                        iconName="trash-2"
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

/** Webhook 端点表（动作钩子由上层共享下传；点击行打开详情抽屉）。 */
function WebhookTable({
  webhooks,
  loading,
  actions,
  selectedId,
  onSelect,
}: {
  webhooks: WebhookRow[]
  loading: boolean
  actions: RowActionApi
  selectedId?: string
  onSelect: (id: string) => void
}): ReactNode {
  const { pending, run } = actions
  return (
    <div className="tg-table-wrap">
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
                <tr
                  key={hook.id}
                  className={selectedId === hook.id ? 'tg-row is-selected' : 'tg-row'}
                  tabIndex={0}
                  onClick={() => onSelect(hook.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onSelect(hook.id)
                    }
                  }}
                >
                  <td data-label="ID" className="mono">{hook.id}</td>
                  <td data-label="描述" className="cell-ellipsis" title={hook.description ?? ''}>
                    {hook.description ?? '—'}
                  </td>
                  <td data-label="ThreadKey" className="mono">{hook.threadKey ?? '—'}</td>
                  <td data-label="创建时间">{formatTime(hook.createdAt) || '—'}</td>
                  <td data-label="操作" className="cell-actions">
                    <div
                      className="row-actions-group"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <RowAction
                        label="删除"
                        iconName="trash-2"
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

function TriggerDetailDrawer({
  cronJob,
  webhook,
  actions,
  inline,
  onClose,
}: {
  cronJob?: CronJobRow
  webhook?: WebhookRow
  actions: RowActionApi
  inline?: boolean
  onClose: () => void
}): ReactNode {
  const title = cronJob !== undefined ? cronJob.id : webhook !== undefined ? webhook.id : '触发器详情'

  return (
    <Dialog
      open
      inline={inline}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <DialogPortal inline={inline}>
        <DialogOverlay className="modal-backdrop primary-drawer-backdrop" />
        <DialogContent className="primary-drawer-content" role="dialog" aria-label={title}>
          <div className="primary-drawer-header">
            <div className="primary-drawer-header-left">
              <div className="primary-drawer-title-col">
                <div className="primary-drawer-title-row">
                  <DialogTitle className="primary-drawer-title break-word mono">{title}</DialogTitle>
                  {cronJob !== undefined ? (
                    <span className={`badge badge-${cronJob.enabled ? 'ok' : 'neutral'}`}>
                      {cronJob.enabled ? '启用' : '停用'}
                    </span>
                  ) : webhook !== undefined ? (
                    <span className="badge badge-neutral">Webhook</span>
                  ) : null}
                </div>
                <div className="text-subtle">
                  {cronJob !== undefined ? 'Cron 定时触发器详情' : 'Webhook 触发端点详情'}
                </div>
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm tg-drawer-close"
                aria-label="关闭"
                title="关闭"
              >
                <HelmIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

            {cronJob !== undefined ? (
              <>
                <KvGrid
                  items={[
                    { key: '描述', value: cronJob.description ?? '—' },
                    { key: 'Cron 表达式', value: <span className="mono">{cronJob.schedule}</span> },
                    { key: '时区', value: <span className="mono">{cronJob.timezone || 'UTC'}</span> },
                    { key: '错过补跑', value: cronJob.catchUp ? '开启' : '关闭' },
                    { key: '投递目标', value: formatTriggerTargetSummary(cronJob) },
                    { key: '上次运行', value: formatTime(cronJob.lastRunAt) || '—' },
                    { key: '下次运行', value: formatTime(cronJob.nextRunAt) || '—' },
                  ]}
                />

                <ScreenSection title="触发指令">
                  <pre className="tg-detail-text selectable mono">{cronJob.text}</pre>
                </ScreenSection>

                {cronJob.lastError !== undefined && cronJob.lastError !== '' ? (
                  <div className="callout callout-error" role="alert">
                    <HelmIcon name="alert-circle" size={13} />
                    <span className="callout-text selectable">{cronJob.lastError}</span>
                  </div>
                ) : null}
              </>
            ) : webhook !== undefined ? (
              <KvGrid
                items={[
                  { key: '描述', value: webhook.description ?? '—' },
                  { key: 'ThreadKey', value: <span className="mono">{webhook.threadKey ?? '—'}</span> },
                  { key: '投递目标', value: formatTriggerTargetSummary(webhook) },
                  { key: 'Secret 状态', value: webhook.hasSecret ? '已配置（明文受保护不下发）' : '未配置' },
                  { key: '创建时间', value: formatTime(webhook.createdAt) || '—' },
                ]}
              />
            ) : null}
          </div>

          {cronJob !== undefined ? (
            <div className="primary-drawer-footer flex-row-between">
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={actions.pending !== undefined}
                onClick={() => actions.run(`delete:${cronJob.id}`, 'cron_delete', { id: cronJob.id })}
              >
                <HelmIcon name="trash-2" size={12} />
                <span>删除</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={actions.pending !== undefined}
                onClick={() => actions.run(`trigger:${cronJob.id}`, 'cron_trigger', { id: cronJob.id })}
              >
                <HelmIcon name="zap" size={12} />
                <span>立即触发</span>
              </button>
            </div>
          ) : webhook !== undefined ? (
            <div className="primary-drawer-footer">
              <button
                type="button"
                className="btn btn-sm btn-danger"
                disabled={actions.pending !== undefined}
                onClick={() => actions.run(`webhook-delete:${webhook.id}`, 'webhook_delete', { id: webhook.id })}
              >
                <HelmIcon name="trash-2" size={12} />
                <span>删除</span>
              </button>
            </div>
          ) : null}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

/** 触发器管理全屏视图（cron + webhook 管理表 + 点击行查看详情抽屉；跨表共享同一动作互斥锁）。 */
export function TriggersManagerScreen(
  props: ScreenProps & { inlineDrawer?: boolean },
): ReactNode {
  const actions = useRowAction()
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)
  const [selection, setSelection] = useState<TriggerDetailSelection | null>(null)

  const selectedCron =
    selection?.kind === 'cron' ? jobs.find((job) => job.id === selection.id) : undefined
  const selectedWebhook =
    selection?.kind === 'webhook' ? hooks.find((hook) => hook.id === selection.id) : undefined

  return (
    <Screen
      title={
        <>
          <HelmIcon name="clock" size={15} />
          <span>触发器管理</span>
        </>
      }
      subtitle={
        <>
          Cron {jobs.length} · Webhook {hooks.length}
          {props.isSplit ? ' · 分屏' : ''}
        </>
      }
    >
      {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

      <ScreenSection
        title={
          <>
            <HelmIcon name="clock" size={13} />
            <span>Cron 定时任务</span>
          </>
        }
      >
        <CronTable
          jobs={jobs}
          loading={crons === undefined}
          actions={actions}
          selectedId={selectedCron?.id}
          onSelect={(id) => setSelection({ kind: 'cron', id })}
        />
      </ScreenSection>

      <ScreenSection
        title={
          <>
            <HelmIcon name="webhook" size={13} />
            <span>Webhook 端点</span>
          </>
        }
      >
        <WebhookTable
          webhooks={hooks}
          loading={webhooks === undefined}
          actions={actions}
          selectedId={selectedWebhook?.id}
          onSelect={(id) => setSelection({ kind: 'webhook', id })}
        />
      </ScreenSection>

      <div className="tg-note">
        secret 不在文档中展示；创建与删除请使用 helm cron / helm webhook 命令或对应动作端点。
      </div>

      {(selectedCron !== undefined || selectedWebhook !== undefined) && (
        <TriggerDetailDrawer
          cronJob={selectedCron}
          webhook={selectedWebhook}
          actions={actions}
          inline={props.inlineDrawer}
          onClose={() => setSelection(null)}
        />
      )}
    </Screen>
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
    <ScreenSection
      className="tg-settings"
      title={
        <>
          <HelmIcon name="clock" size={13} />
          <span>触发器</span>
        </>
      }
    >
      {crons === undefined || webhooks === undefined ? (
        <DocLoading label="触发器状态读取中..." />
      ) : (
        <KvGrid
          items={[
            { key: 'Cron 任务数', value: jobs.length },
            { key: 'Webhook 端点数', value: hooks.length },
          ]}
        />
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
          <HelmIcon name="external-link" size={11} />
          <span>打开触发器管理</span>
        </button>
      </div>
    </ScreenSection>
  )
}
