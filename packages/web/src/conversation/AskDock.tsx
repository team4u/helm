import { useId, useMemo, useState } from 'react'
import type { AskFieldSpec, AskSpec } from '@helm/protocol/browser'
import { asksApi } from '../lib/api.js'
import { HelmIcon, Select } from '@helm/plugin-client'
import { useHelmStore } from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { collectSubtreeIds } from './ancestry-model.js'

export interface AskDockProps {
  conversationId: number
}

/** Source-conversation badge: shown when the ask belongs to another
 * conversation; clicking opens that child conversation's drawer. */
interface AskSourceInfo {
  conversationId: number
  title: string
}

interface TerminalSnapshot {
  source: 'context' | 'description'
  text: string
}

/** Extract the terminal snapshot (last 40 lines) from the ask extension field
 * terminalSnapshot or from the description. */
function extractTerminalSnapshot(ask: AskSpec): TerminalSnapshot | undefined {
  const extra = ask as AskSpec & { context?: { terminalSnapshot?: unknown } }
  const fromContext = extra.context?.terminalSnapshot
  if (typeof fromContext === 'string' && fromContext.trim() !== '') {
    return { source: 'context', text: lastLines(fromContext, 40) }
  }
  const desc = ask.description ?? ''
  const marker = desc.indexOf('```')
  if (marker !== -1) {
    const body = desc.slice(marker + 3)
    if (body.trim() !== '') return { source: 'description', text: lastLines(body, 40) }
  }
  return undefined
}

function lastLines(text: string, max: number): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  return lines.length <= max ? lines.join('\n') : lines.slice(-max).join('\n')
}

function AskFieldInput({
  field,
  value,
  onChange,
  disabled,
  inputId,
}: {
  inputId: string
  field: AskFieldSpec
  value: string
  onChange: (v: string) => void
  disabled: boolean
}) {
  const { t } = useWebLocale()
  if (field.type === 'select') {
    const options = [
      { value: '', label: t('composer.ask.selectPlaceholder') },
      ...(field.options ?? []).map((opt) => ({
        value: opt.value,
        label: opt.label,
      })),
    ]
    return (
      <Select
        id={inputId}
        value={value}
        disabled={disabled}
        options={options}
        onChange={(e) => onChange(e.target.value)}
      />
    )
  }
  if (field.type === 'confirm') {
    return (
      <span className="ask-dock-confirm-actions">
        <button
          type="button"
          className={`btn btn-sm ${value === 'true' ? 'btn-primary' : ''}`}
          disabled={disabled}
          onClick={() => onChange('true')}
        >
          <HelmIcon name="check" size={12} />
          {t('composer.ask.approve')}
        </button>
        <button
          type="button"
          className={`btn btn-sm ${value === 'false' ? 'btn-danger' : ''}`}
          disabled={disabled}
          onClick={() => onChange('false')}
        >
          <HelmIcon name="x" size={12} />
          {t('composer.ask.reject')}
        </button>
      </span>
    )
  }
  const secret = field.secret === true
  return (
    <span className="ask-dock-input-wrap">
      <input
        id={inputId}
        className="input"
        type={secret ? 'password' : 'text'}
        value={value}
        disabled={disabled}
        placeholder={secret ? t('composer.ask.secretPlaceholder') : field.label}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {secret ? (
        <span className="ask-dock-secret-hint">
          <HelmIcon name="lock" size={11} />
          {t('composer.ask.secretHint')}
        </span>
      ) : null}
    </span>
  )
}

function AskCard({ ask, source }: { ask: AskSpec; source?: AskSourceInfo }) {
  const store = useHelmStore()
  const { t } = useWebLocale()
  // The same approval can appear in both an ancestor panel and a child
  // conversation drawer; form labels associate with this instance only.
  const formId = useId()
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState<'answer' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const snapshot = useMemo(() => extractTerminalSnapshot(ask), [ask])

  const missingRequired = ask.fields
    .filter((f) => f.required === true)
    .filter((f) => (answers[f.name] ?? '').trim() === '')

  const submit = async (): Promise<void> => {
    setSubmitting('answer')
    setError(null)
    try {
      await asksApi.answer(ask.id, answers, ask.expectedStateSeq)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  const cancel = async (): Promise<void> => {
    setSubmitting('cancel')
    setError(null)
    try {
      await asksApi.cancel(ask.id)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <div className="ask-dock">
      <div className="ask-dock-header">
        <HelmIcon name="shield-alert" size={15} />
        <span className="ask-dock-title">{ask.title}</span>
        {ask.ownerPluginId !== undefined ? (
          <span className="badge badge-warn">{ask.ownerPluginId}</span>
        ) : null}
        {ask.expectedStateSeq !== undefined ? (
          <span className="badge badge-neutral mono" title={t('composer.ask.casTitle')}>
            seq {ask.expectedStateSeq}
          </span>
        ) : null}
        {source !== undefined ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm ask-dock-source-btn"
            title={source.title !== ''
              ? t('composer.ask.openChildTitle', { id: source.conversationId, title: source.title })
              : t('composer.ask.openChildDrawer', { id: source.conversationId })}
            aria-label={t('composer.ask.openChildDrawer', { id: source.conversationId })}
            onClick={() => store.setActiveModal({ kind: 'conversation-drawer', conversationId: source.conversationId })}
          >
            <HelmIcon name="corner-down-right" size={11} />
            {t('composer.ask.fromSource', { id: source.conversationId })}
          </button>
        ) : null}
      </div>
      {ask.description !== undefined && snapshot === undefined ? (
        <div className="ask-dock-desc">
          {ask.description}
        </div>
      ) : null}
      {ask.description !== undefined && snapshot !== undefined && snapshot.source === 'description' ? (
        <div className="ask-dock-desc">
          {ask.description.slice(0, ask.description.indexOf('```')).trim()}
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div className="ask-dock-snapshot">
          <button
            type="button"
            className="btn btn-ghost btn-sm ask-dock-snapshot-btn"
            onClick={() => setSnapshotOpen((v) => !v)}
          >
            <HelmIcon name={snapshotOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            {t('composer.ask.terminalSnapshot')}
          </button>
          {snapshotOpen ? (
            <pre className="code-block-pre selectable ask-dock-snapshot-pre">
              <code>{snapshot.text}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {ask.fields.length > 0 ? (
        <div className="ask-dock-fields">
          {ask.fields.map((field) => (
            <div key={field.name} className="ask-dock-field">
              <label htmlFor={field.type === 'confirm' ? undefined : `${formId}-${field.name}`} className="ask-dock-label">
                {field.label}
                {field.required === true ? <span className="ask-dock-required">*</span> : null}
              </label>
              <AskFieldInput
                inputId={`${formId}-${field.name}`}
                field={field}
                value={answers[field.name] ?? ''}
                disabled={submitting !== null}
                onChange={(v) => setAnswers((prev) => ({ ...prev, [field.name]: v }))}
              />
            </div>
          ))}
        </div>
      ) : null}
      {error !== null ? (
        <div className="callout callout--error">
          <HelmIcon name="alert-circle" size={13} />
          <span className="callout-text">{error}</span>
        </div>
      ) : null}
      <div className="ask-dock-actions">
        <button type="button" className="btn" disabled={submitting !== null} onClick={() => void cancel()}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting !== null || missingRequired.length > 0}
          onClick={() => void submit()}
        >
          <HelmIcon name={submitting === 'answer' ? 'loader' : 'check'} size={12} />
          {t('composer.ask.submit')}
        </button>
      </div>
    </div>
  )
}

/** Bottom-docked approval stack: pending AskDoc cards of the current
 * conversation and all of its descendants. AskDoc is conversation-scoped:
 * answer/cancel still go through the original asksApi (with the
 * expectedStateSeq CAS); this dock only aggregates display and changes nothing
 * about the approval chain. */
export function AskDock({ conversationId }: AskDockProps) {
  const store = useHelmStore()
  // Ancestry derives purely from store.conversations; pending asks of
  // descendant conversations are surfaced as well.
  const subtreeIds = useMemo(
    () => collectSubtreeIds(store.conversations, conversationId),
    [store.conversations, conversationId],
  )
  const pending = store.pendingAsks.filter(
    (a) => a.status === 'pending' && subtreeIds.has(a.conversationId),
  )
  if (pending.length === 0) return null
  return (
    <div className="ask-dock-stack">
      {pending.map((ask) => (
        <AskCard
          key={ask.id}
          ask={ask}
          {...(ask.conversationId !== conversationId
            ? {
                source: {
                  conversationId: ask.conversationId,
                  title: store.conversations.find((conv) => conv.id === ask.conversationId)?.title ?? '',
                },
              }
            : {})}
        />
      ))}
    </div>
  )
}
