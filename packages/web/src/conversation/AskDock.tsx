import { useMemo, useState } from 'react'
import type { AskFieldSpec, AskSpec } from '@helm/protocol'
import { asksApi } from '../lib/api.js'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'

export interface AskDockProps {
  conversationId: number
}

interface TerminalSnapshot {
  source: 'context' | 'description'
  text: string
}

/** 从 ask 扩展字段 terminalSnapshot 或 description 提取终端快照（最后 40 行）。 */
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
  if (field.type === 'select') {
    const options = field.options ?? []
    return (
      <select
        id={inputId}
        className="select"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">请选择…</option>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    )
  }
  if (field.type === 'confirm') {
    return (
      <span style={{ display: 'inline-flex', gap: 6 }}>
        <button
          type="button"
          className={`btn btn-sm ${value === 'true' ? 'btn-primary' : ''}`}
          disabled={disabled}
          onClick={() => onChange('true')}
        >
          <HelmIcon name="check" size={12} />
          确认
        </button>
        <button
          type="button"
          className={`btn btn-sm ${value === 'false' ? 'btn-danger' : ''}`}
          disabled={disabled}
          onClick={() => onChange('false')}
        >
          <HelmIcon name="x" size={12} />
          拒绝
        </button>
      </span>
    )
  }
  const secret = field.secret === true
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <input
        id={inputId}
        className="input"
        type={secret ? 'password' : 'text'}
        value={value}
        disabled={disabled}
        placeholder={secret ? '机密值仅入内存 SecretStash' : field.label}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
      />
      {secret ? (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <HelmIcon name="lock" size={11} />
          机密直入内存 SecretStash，不落数据库
        </span>
      ) : null}
    </span>
  )
}

function AskCard({ ask }: { ask: AskSpec }) {
  const store = useHelmStore()
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <HelmIcon name="shield-alert" size={15} />
        <span style={{ fontWeight: 600, fontSize: 13.5 }}>{ask.title}</span>
        {ask.ownerPluginId !== undefined ? (
          <span className="badge badge-warn">{ask.ownerPluginId}</span>
        ) : null}
        {ask.expectedStateSeq !== undefined ? (
          <span className="badge badge-neutral mono" title="CAS 水位线：终端已处理时自动销单">
            seq {ask.expectedStateSeq}
          </span>
        ) : null}
      </div>
      {ask.description !== undefined && snapshot === undefined ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', whiteSpace: 'pre-wrap' }}>
          {ask.description}
        </div>
      ) : null}
      {ask.description !== undefined && snapshot !== undefined && snapshot.source === 'description' ? (
        <div style={{ fontSize: 12.5, color: 'var(--fg-secondary)', whiteSpace: 'pre-wrap' }}>
          {ask.description.slice(0, ask.description.indexOf('```')).trim()}
        </div>
      ) : null}
      {snapshot !== undefined ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            style={{ width: 'fit-content' }}
            onClick={() => setSnapshotOpen((v) => !v)}
          >
            <HelmIcon name={snapshotOpen ? 'chevron-down' : 'chevron-right'} size={12} />
            终端快照（最后 40 行）
          </button>
          {snapshotOpen ? (
            <pre
              className="code-block-pre selectable"
              style={{ background: 'var(--bg-subtle)', borderRadius: 'var(--radius-sm)', padding: 10, maxHeight: 240, overflow: 'auto' }}
            >
              <code>{snapshot.text}</code>
            </pre>
          ) : null}
        </div>
      ) : null}
      {ask.fields.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {ask.fields.map((field) => (
            <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label htmlFor={field.type === 'confirm' ? undefined : `${ask.id}-${field.name}`} style={{ fontSize: 12, color: 'var(--fg-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                {field.label}
                {field.required === true ? <span style={{ color: 'var(--err)' }}>*</span> : null}
              </label>
              <AskFieldInput
                inputId={`${ask.id}-${field.name}`}
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
        <div className="jr-callout jr-callout-err">
          <HelmIcon name="alert-circle" size={13} />
          <span style={{ wordBreak: 'break-all' }}>{error}</span>
        </div>
      ) : null}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
        <button type="button" className="btn" disabled={submitting !== null} onClick={() => void cancel()}>
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={submitting !== null || missingRequired.length > 0}
          onClick={() => void submit()}
        >
          <HelmIcon name={submitting === 'answer' ? 'loader' : 'check'} size={12} />
          提交
        </button>
      </div>
    </div>
  )
}

/** 置底悬停审批坞：当前会话 pending AskDoc 卡片堆叠。 */
export function AskDock({ conversationId }: AskDockProps) {
  const store = useHelmStore()
  const pending = store.pendingAsks.filter((a) => a.conversationId === conversationId && a.status === 'pending')
  if (pending.length === 0) return null
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {pending.map((ask) => (
        <AskCard key={ask.id} ask={ask} />
      ))}
    </div>
  )
}
