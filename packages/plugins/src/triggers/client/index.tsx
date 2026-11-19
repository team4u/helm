/**
 * builtin:triggers client.tsx components (component exports only, Fast
 * Refresh contract):
 * - TriggersManagerScreen: cron / webhook management tables + a right-side
 *   detail drawer opened by row clicks; row actions cron_trigger /
 *   cron_delete / webhook_delete go through ctx.callAction;
 * - TriggersSettingsPanel: settings panel (count overview + manager entry).
 *
 * Secret boundary: webhook secrets are never rendered from the doc (the
 * hasSecret boolean is the collaboration contract); creation and deletion
 * stay on the helmx CLI / HTTP action endpoints. Generic structure reuses the
 * host design system and @helmx/plugin-client primitives (Screen /
 * ScreenSection / KvGrid / Dialog / HelmxIcon / .callout-error / .helmx-table /
 * .loading-state), no native selects, zero Emoji.
 *
 * Display copy resolves from copy.ts against the active host locale (no
 * independent language state, no localStorage); backend error messages pass
 * through unchanged apart from the localized failure prefix.
 */
import { useState } from 'react'
import './styles.css'
import type { ReactNode } from 'react'
import type { ScreenProps } from '@helmx/protocol'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  HelmxIcon,
  KvGrid,
  Screen,
  ScreenSection,
  formatTime,
  usePluginContext,
  usePluginDoc,
  usePluginLocale,
  usePluginTranslator,
} from '@helmx/plugin-client'
import {
  formatTriggerTargetSummary,
  parseCronJobs,
  parseWebhooks,
  type CronJobRow,
  type TriggerDetailSelection,
  type WebhookRow,
} from './models.ts'
import {
  TRIGGERS_CLOSE,
  TRIGGERS_COL_ACTIONS,
  TRIGGERS_COL_COMMAND,
  TRIGGERS_COL_CREATED,
  TRIGGERS_COL_DESCRIPTION,
  TRIGGERS_COL_ENABLED,
  TRIGGERS_COL_LAST_ERROR,
  TRIGGERS_COL_LAST_RUN,
  TRIGGERS_COL_NEXT_RUN,
  TRIGGERS_COL_SCHEDULE,
  TRIGGERS_COMMAND_SECTION,
  TRIGGERS_CRON_DETAIL_SUBTITLE,
  TRIGGERS_CRON_LOADING,
  TRIGGERS_CRON_SECTION,
  TRIGGERS_DELETE,
  TRIGGERS_DETAIL_TITLE,
  TRIGGERS_DISABLED,
  TRIGGERS_ENABLED,
  TRIGGERS_KV_CATCH_UP,
  TRIGGERS_KV_CREATED,
  TRIGGERS_KV_CRON_COUNT,
  TRIGGERS_KV_CRON_EXPRESSION,
  TRIGGERS_KV_DELIVERY_TARGET,
  TRIGGERS_KV_DESCRIPTION,
  TRIGGERS_KV_LAST_RUN,
  TRIGGERS_KV_NEXT_RUN,
  TRIGGERS_KV_SECRET_STATE,
  TRIGGERS_KV_THREAD_KEY,
  TRIGGERS_KV_TIMEZONE,
  TRIGGERS_KV_WEBHOOK_COUNT,
  TRIGGERS_MANAGER_NOTE,
  TRIGGERS_OFF,
  TRIGGERS_ON,
  TRIGGERS_OPEN_MANAGER,
  TRIGGERS_SCREEN_TITLE,
  TRIGGERS_SECRET_CONFIGURED,
  TRIGGERS_SECRET_MISSING,
  TRIGGERS_SETTINGS_LOADING,
  TRIGGERS_SETTINGS_NOTE,
  TRIGGERS_SETTINGS_SECTION,
  TRIGGERS_SPLIT_SUFFIX,
  TRIGGERS_TABLE_EMPTY,
  TRIGGERS_TRIGGER_NOW,
  TRIGGERS_WEBHOOK_DETAIL_SUBTITLE,
  TRIGGERS_WEBHOOK_LOADING,
  TRIGGERS_WEBHOOK_SECTION,
  triggersActionFailed,
} from './copy.ts'

function DocLoading({ label }: { label: string }): ReactNode {
  return (
    <div className="loading-state" role="status">
      <HelmxIcon name="loader" size={12} className="spin-slow" />
      <span>{label}</span>
    </div>
  )
}

function ActionError({ message }: { message: string }): ReactNode {
  return (
    <div className="callout callout-error" role="alert">
      <HelmxIcon name="alert-circle" size={13} />
      <span className="callout-text">{message}</span>
    </div>
  )
}

/**
 * Shared row-action hook for the management tables. `pending` is a single
 * global value: while any action is in flight every row button is disabled
 * uniformly (no "looks clickable but does nothing" states) and restored on
 * completion. The ManagerScreen holds one instance and passes it down to
 * both tables, so the mutual exclusion spans tables as well.
 */
function useRowAction() {
  const ctx = usePluginContext()
  const locale = usePluginLocale()
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (key: string, actionId: string, input: Record<string, unknown>): void => {
    if (pending !== undefined) return
    setPending(key)
    setError(undefined)
    void ctx
      .callAction(actionId, input)
      .catch((err: unknown) => {
        setError(triggersActionFailed(actionId, err instanceof Error ? err.message : String(err), locale))
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
      <HelmxIcon
        name={disabled === true ? 'loader' : iconName}
        size={11}
        className={disabled === true ? 'spin-slow' : undefined}
      />
      <span>{label}</span>
    </button>
  )
}

/** Cron jobs table (action hook shared from above; row clicks open the detail drawer). */
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
  const t = usePluginTranslator()
  const { pending, run } = actions
  return (
    <div className="tg-table-wrap">
      <div className="helmx-table-wrap">
        <table className="helmx-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t(TRIGGERS_COL_SCHEDULE)}</th>
              <th>{t(TRIGGERS_COL_COMMAND)}</th>
              <th>{t(TRIGGERS_COL_ENABLED)}</th>
              <th>{t(TRIGGERS_COL_LAST_RUN)}</th>
              <th>{t(TRIGGERS_COL_NEXT_RUN)}</th>
              <th>{t(TRIGGERS_COL_LAST_ERROR)}</th>
              <th className="cell-actions">{t(TRIGGERS_COL_ACTIONS)}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={8}>
                  <DocLoading label={t(TRIGGERS_CRON_LOADING)} />
                </td>
              </tr>
            ) : jobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="table-empty">
                  {t(TRIGGERS_TABLE_EMPTY)}
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
                  <td data-label={t(TRIGGERS_COL_SCHEDULE)} className="mono">{job.schedule}</td>
                  <td data-label={t(TRIGGERS_COL_COMMAND)} className="cell-ellipsis" title={job.text}>{job.text}</td>
                  <td data-label={t(TRIGGERS_COL_ENABLED)}>
                    <span className={`badge badge-${job.enabled ? 'ok' : 'neutral'}`}>
                      <span>{job.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}</span>
                    </span>
                  </td>
                  <td data-label={t(TRIGGERS_COL_LAST_RUN)}>{formatTime(job.lastRunAt) || '—'}</td>
                  <td data-label={t(TRIGGERS_COL_NEXT_RUN)}>{formatTime(job.nextRunAt) || '—'}</td>
                  <td data-label={t(TRIGGERS_COL_LAST_ERROR)} className="cell-error" title={job.lastError ?? ''}>
                    {job.lastError ?? '—'}
                  </td>
                  <td data-label={t(TRIGGERS_COL_ACTIONS)} className="cell-actions">
                    <div
                      className="row-actions-group"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <RowAction
                        label={t(TRIGGERS_TRIGGER_NOW)}
                        iconName="zap"
                        disabled={pending !== undefined}
                        onClick={() => run(`trigger:${job.id}`, 'cron_trigger', { id: job.id })}
                      />
                      <RowAction
                        label={t(TRIGGERS_DELETE)}
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

/** Webhook endpoints table (action hook shared from above; row clicks open the detail drawer). */
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
  const t = usePluginTranslator()
  const { pending, run } = actions
  return (
    <div className="tg-table-wrap">
      <div className="helmx-table-wrap">
        <table className="helmx-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>{t(TRIGGERS_COL_DESCRIPTION)}</th>
              <th>{t(TRIGGERS_KV_THREAD_KEY)}</th>
              <th>{t(TRIGGERS_COL_CREATED)}</th>
              <th className="cell-actions">{t(TRIGGERS_COL_ACTIONS)}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={5}>
                  <DocLoading label={t(TRIGGERS_WEBHOOK_LOADING)} />
                </td>
              </tr>
            ) : webhooks.length === 0 ? (
              <tr>
                <td colSpan={5} className="table-empty">
                  {t(TRIGGERS_TABLE_EMPTY)}
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
                  <td data-label={t(TRIGGERS_COL_DESCRIPTION)} className="cell-ellipsis" title={hook.description ?? ''}>
                    {hook.description ?? '—'}
                  </td>
                  <td data-label={t(TRIGGERS_KV_THREAD_KEY)} className="mono">{hook.threadKey ?? '—'}</td>
                  <td data-label={t(TRIGGERS_COL_CREATED)}>{formatTime(hook.createdAt) || '—'}</td>
                  <td data-label={t(TRIGGERS_COL_ACTIONS)} className="cell-actions">
                    <div
                      className="row-actions-group"
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => e.stopPropagation()}
                    >
                      <RowAction
                        label={t(TRIGGERS_DELETE)}
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
  const locale = usePluginLocale()
  const t = usePluginTranslator()
  const title = cronJob !== undefined ? cronJob.id : webhook !== undefined ? webhook.id : t(TRIGGERS_DETAIL_TITLE)

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
                      {cronJob.enabled ? t(TRIGGERS_ENABLED) : t(TRIGGERS_DISABLED)}
                    </span>
                  ) : webhook !== undefined ? (
                    <span className="badge badge-neutral">Webhook</span>
                  ) : null}
                </div>
                <div className="text-subtle">
                  {cronJob !== undefined ? t(TRIGGERS_CRON_DETAIL_SUBTITLE) : t(TRIGGERS_WEBHOOK_DETAIL_SUBTITLE)}
                </div>
              </div>
            </div>
            <DialogClose asChild>
              <button
                type="button"
                className="btn btn-ghost btn-icon-sm tg-drawer-close"
                aria-label={t(TRIGGERS_CLOSE)}
                title={t(TRIGGERS_CLOSE)}
              >
                <HelmxIcon name="x" size={14} />
              </button>
            </DialogClose>
          </div>

          <div className="primary-drawer-body">
            {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

            {cronJob !== undefined ? (
              <>
                <KvGrid
                  items={[
                    { key: t(TRIGGERS_KV_DESCRIPTION), value: cronJob.description ?? '—' },
                    { key: t(TRIGGERS_KV_CRON_EXPRESSION), value: <span className="mono">{cronJob.schedule}</span> },
                    { key: t(TRIGGERS_KV_TIMEZONE), value: <span className="mono">{cronJob.timezone || 'UTC'}</span> },
                    { key: t(TRIGGERS_KV_CATCH_UP), value: cronJob.catchUp ? t(TRIGGERS_ON) : t(TRIGGERS_OFF) },
                    { key: t(TRIGGERS_KV_DELIVERY_TARGET), value: formatTriggerTargetSummary(cronJob, locale) },
                    { key: t(TRIGGERS_KV_LAST_RUN), value: formatTime(cronJob.lastRunAt) || '—' },
                    { key: t(TRIGGERS_KV_NEXT_RUN), value: formatTime(cronJob.nextRunAt) || '—' },
                  ]}
                />

                <ScreenSection title={t(TRIGGERS_COMMAND_SECTION)}>
                  <pre className="tg-detail-text selectable mono">{cronJob.text}</pre>
                </ScreenSection>

                {cronJob.lastError !== undefined && cronJob.lastError !== '' ? (
                  <div className="callout callout-error" role="alert">
                    <HelmxIcon name="alert-circle" size={13} />
                    <span className="callout-text selectable">{cronJob.lastError}</span>
                  </div>
                ) : null}
              </>
            ) : webhook !== undefined ? (
              <KvGrid
                items={[
                  { key: t(TRIGGERS_KV_DESCRIPTION), value: webhook.description ?? '—' },
                  { key: t(TRIGGERS_KV_THREAD_KEY), value: <span className="mono">{webhook.threadKey ?? '—'}</span> },
                  { key: t(TRIGGERS_KV_DELIVERY_TARGET), value: formatTriggerTargetSummary(webhook, locale) },
                  { key: t(TRIGGERS_KV_SECRET_STATE), value: webhook.hasSecret ? t(TRIGGERS_SECRET_CONFIGURED) : t(TRIGGERS_SECRET_MISSING) },
                  { key: t(TRIGGERS_KV_CREATED), value: formatTime(webhook.createdAt) || '—' },
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
                <HelmxIcon name="trash-2" size={12} />
                <span>{t(TRIGGERS_DELETE)}</span>
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={actions.pending !== undefined}
                onClick={() => actions.run(`trigger:${cronJob.id}`, 'cron_trigger', { id: cronJob.id })}
              >
                <HelmxIcon name="zap" size={12} />
                <span>{t(TRIGGERS_TRIGGER_NOW)}</span>
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
                <HelmxIcon name="trash-2" size={12} />
                <span>{t(TRIGGERS_DELETE)}</span>
              </button>
            </div>
          ) : null}
        </DialogContent>
      </DialogPortal>
    </Dialog>
  )
}

/** Trigger manager fullscreen view (cron + webhook tables + row-click detail drawer; one shared action mutex across both tables). */
export function TriggersManagerScreen(
  props: ScreenProps & { inlineDrawer?: boolean },
): ReactNode {
  const t = usePluginTranslator()
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
          <HelmxIcon name="clock" size={15} />
          <span>{t(TRIGGERS_SCREEN_TITLE)}</span>
        </>
      }
      subtitle={
        <>
          Cron {jobs.length} · Webhook {hooks.length}
          {props.isSplit ? t(TRIGGERS_SPLIT_SUFFIX) : ''}
        </>
      }
    >
      {actions.error !== undefined ? <ActionError message={actions.error} /> : null}

      <ScreenSection
        title={
          <>
            <HelmxIcon name="clock" size={13} />
            <span>{t(TRIGGERS_CRON_SECTION)}</span>
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
            <HelmxIcon name="webhook" size={13} />
            <span>{t(TRIGGERS_WEBHOOK_SECTION)}</span>
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

      <div className="tg-note">{t(TRIGGERS_MANAGER_NOTE)}</div>

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

/** Trigger settings panel: count overview + manager view / CLI guidance. */
export function TriggersSettingsPanel(): ReactNode {
  const ctx = usePluginContext()
  const t = usePluginTranslator()
  const crons = usePluginDoc<{ jobs?: unknown }>('crons')
  const webhooks = usePluginDoc<{ webhooks?: unknown }>('webhooks')
  const jobs = parseCronJobs(crons)
  const hooks = parseWebhooks(webhooks)

  return (
    <ScreenSection
      className="tg-settings"
      title={
        <>
          <HelmxIcon name="clock" size={13} />
          <span>{t(TRIGGERS_SETTINGS_SECTION)}</span>
        </>
      }
    >
      {crons === undefined || webhooks === undefined ? (
        <DocLoading label={t(TRIGGERS_SETTINGS_LOADING)} />
      ) : (
        <KvGrid
          items={[
            { key: t(TRIGGERS_KV_CRON_COUNT), value: jobs.length },
            { key: t(TRIGGERS_KV_WEBHOOK_COUNT), value: hooks.length },
          ]}
        />
      )}
      <div className="tg-note">{t(TRIGGERS_SETTINGS_NOTE)}</div>
      <div>
        <button
          type="button"
          className="btn btn-xs"
          onClick={() => ctx.openScreen('screen:builtin:triggers/manager')}
        >
          <HelmxIcon name="external-link" size={11} />
          <span>{t(TRIGGERS_OPEN_MANAGER)}</span>
        </button>
      </div>
    </ScreenSection>
  )
}
