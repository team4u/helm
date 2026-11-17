/**
 * @json-render standard primitives: 20 components (13 layout/display + 7
 * form/interaction).
 *
 * Each primitive receives the normalized NormalizedSpecNode plus a render
 * context (scope evaluation + child rendering + action execution) with no
 * plugin-business special-casing; styling reuses the existing .jr-* / .btn /
 * .badge / .card / .list / .tabs classes from styles.css — zero new global
 * styles.
 *
 * Display copy discipline: chrome produced by this plugin (fallback labels,
 * submit states, misuse notices) resolves from copy.ts against the
 * render-context locale; any text declared in the spec itself (titles,
 * labels, options) is model output and passes through verbatim. Primitives
 * are invoked as plain functions (see SpecNodeView), so hooks are not an
 * option — the locale flows in through the render context.
 */
import { useEffect, useId, useState, type ReactNode } from 'react'
import { HelmIcon, Select, Checkbox, Tabs, TabsList, TabsTrigger, PluginSlot, MarkdownText } from '@helm/plugin-client'
import type { HelmLocale, LocalizedText } from '@helm/plugin-client'
import { resolveLocalizedText } from '@helm/plugin-client'
import { evaluateSpecValue, type EvalScope } from './evaluator.ts'
import {
  JSON_RENDER_ACTION_LABEL_FALLBACK,
  JSON_RENDER_BUTTON_LABEL_FALLBACK,
  JSON_RENDER_INPUT_SUBMIT,
  JSON_RENDER_INPUT_SUBMITTED,
  JSON_RENDER_INPUT_SUBMITTING,
  JSON_RENDER_SECRET_TAG,
  JSON_RENDER_SLOT_MISSING_NAME,
  JSON_RENDER_SLOT_NO_HOST,
  JSON_RENDER_SUBMITTING_HINT,
  JSON_RENDER_TABLE_ACTIONS_HEADER,
  JSON_RENDER_TABLE_EMPTY,
  jsonRenderStepFallbackTitle,
  jsonRenderTabFallbackTitle,
  jsonRenderUnknownComponent,
} from './copy.ts'
import { formatSpecText, normalizeSpec, resolveKeyValueItems, type NormalizedSpecNode } from './spec-normalize.ts'

export interface SpecRenderContext {
  /** Property evaluation scope ($docs / $sessionDocs / $data / $row / $value). */
  scope: EvalScope
  /** Active host UI locale for plugin chrome copy (fallback labels, state hints); spec-declared text passes through untranslated. */
  locale: HelmLocale
  /** Current conversation context (the Slot primitive passes it to sub-slot contributions for scope filtering; undefined when there is no conversation slot). */
  conversationId?: number
  /** Owning plugin of the current render view (the Slot primitive resolves its short name into the fully-qualified slot name). */
  pluginId?: string
  /** Child-tree render entry (primitives compose with each other). */
  renderChildren(children: NormalizedSpecNode[]): ReactNode
  /** Execute one declarative action directive; buttons sharing a pendingKey enter loading (double-click guard). */
  runAction(rawAction: unknown, scope: EvalScope, pendingKey: string): void
  /** Whether the action for this pendingKey is executing (loading double-click guard). */
  isPending(pendingKey: string): boolean
  /** Whether the action for this pendingKey just succeeded (in-place confirmation state, e.g. a button check mark). */
  isSucceeded?(pendingKey: string): boolean
}

/** Resolve plugin display copy against the render-context locale. */
function tr(ctx: SpecRenderContext, text: LocalizedText): string {
  return resolveLocalizedText(text, ctx.locale)
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function bool(value: unknown): boolean {
  return value === true
}

/** Re-evaluate inside a primitive (e.g. $row injection for Table row actions: local scope override). */
function evalIn<T>(template: unknown, scope: EvalScope): T {
  return evaluateSpecValue<T>(template, scope)
}

/**
 * Remote-value-driven state with local uncommitted-input protection:
 * - when a new remote value (SSE push) arrives, sync it into local state;
 * - while the user is editing locally (dirty), never overwrite — avoid
 *   interrupting input;
 * - after unmount the remote value no longer pulls back (React controlled semantics).
 */
function useRemoteSyncedState<T>(remote: T, areEqual: (a: T, b: T) => boolean): [T, (next: T) => void] {
  const [local, setLocal] = useState<T>(remote)
  const [dirty, setDirty] = useState(false)
  useEffect(() => {
    if (!dirty && !areEqual(local, remote)) setLocal(remote)
    // Only reacts to remote value changes; reading local/dirty here is
    // intentional — "never overwrite uncommitted input"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote])
  const update = (next: T) => {
    setDirty(true)
    setLocal(next)
  }
  return [local, update]
}

const strictEquals = (a: unknown, b: unknown) => a === b

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false
  for (const v of a) {
    if (!b.has(v)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Layout & display (13)
// ---------------------------------------------------------------------------

function StackImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const direction = str(evalIn(node.props['direction'], ctx.scope), 'vertical')
  const gap = evalIn<unknown>(node.props['gap'], ctx.scope)
  const style = typeof gap === 'number' && Number.isFinite(gap) ? { gap } : undefined
  return (
    <div className={direction === 'horizontal' ? 'stack-row' : 'jr-stack'} style={style}>
      {ctx.renderChildren(node.children)}
    </div>
  )
}

function CardImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const title = str(evalIn(node.props['title'], ctx.scope))
  const subtitle = str(evalIn(node.props['subtitle'], ctx.scope))
  return (
    <div className="card jr-card">
      {(title !== '' || subtitle !== '') && (
        <div className="jr-card-header">
          {title !== '' && <div className="jr-card-title">{title}</div>}
          {subtitle !== '' && <div className="jr-card-subtitle">{subtitle}</div>}
        </div>
      )}
      {ctx.renderChildren(node.children)}
    </div>
  )
}

const TEXT_VARIANT_STYLE: Record<string, Record<string, unknown>> = {
  body: {},
  title: { fontSize: 15, fontWeight: 650 },
  muted: { color: 'var(--fg-muted)', fontSize: 12.5 },
  mono: { fontFamily: 'var(--font-mono)', fontSize: 12 },
}

function TextImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const variant = str(evalIn(node.props['variant'], ctx.scope), 'body')
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['content'], ctx.scope)
  const lineClamp = evalIn<unknown>(node.props['lineClamp'], ctx.scope)
  const text = typeof rawText === 'string' ? rawText : formatSpecText(rawText)
  const style: Record<string, unknown> = { ...(TEXT_VARIANT_STYLE[variant] ?? {}) }
  if (typeof lineClamp === 'number' && lineClamp > 0) {
    style['display'] = '-webkit-box'
    style['WebkitLineClamp'] = lineClamp
    style['WebkitBoxOrient'] = 'vertical'
    style['overflow'] = 'hidden'
  }
  return <div style={style}>{text}</div>
}

function BadgeImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tone = str(evalIn(node.props['tone'], ctx.scope), 'neutral')
  const icon = str(evalIn(node.props['icon'], ctx.scope))
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['label'], ctx.scope)
  const validTone = ['neutral', 'accent', 'ok', 'warn', 'err'].includes(tone) ? tone : 'neutral'
  return (
    <span className={`badge badge-${validTone}`}>
      {icon !== '' && <HelmIcon name={icon} size={11} />}
      {formatSpecText(rawText)}
    </span>
  )
}

function MarkdownImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawText = evalIn<unknown>(node.props['text'] ?? node.props['content'], ctx.scope)
  const text = typeof rawText === 'string' ? rawText : formatSpecText(rawText)
  return (
    <div className="jr-markdown msg-ai-body">
      <MarkdownText text={text} />
    </div>
  )
}

function MetricGridImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const cols = evalIn<unknown>(node.props['cols'], ctx.scope)
  const style =
    typeof cols === 'number' && cols > 0
      ? { gridTemplateColumns: `repeat(${Math.min(6, Math.floor(cols))}, minmax(0, 1fr))` }
      : undefined
  return (
    <div className="jr-metric-grid" style={style}>
      {ctx.renderChildren(node.children)}
    </div>
  )
}

function MetricCardImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const rawValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const hint = str(evalIn(node.props['hint'], ctx.scope))
  const tone = str(evalIn(node.props['tone'], ctx.scope))
  const toneColor =
    tone === 'ok'
      ? 'var(--ok)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'err'
          ? 'var(--err)'
          : tone === 'accent'
            ? 'var(--accent)'
            : undefined
  return (
    <div className="jr-metric-card">
      <div className="jr-metric-label">{label}</div>
      <div className="jr-metric-value" style={toneColor !== undefined ? { color: toneColor } : undefined}>
        {formatSpecText(rawValue)}
      </div>
      {hint !== '' && <div className="jr-metric-label">{hint}</div>}
    </div>
  )
}

function KeyValueListImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  // Do not evalIn(items) up front: pointer keys ('/$docs/...') must stay raw
  // templates until this stage — otherwise the key is already turned into a
  // concrete value (e.g. a number), resolveKeyValueItems cannot recognize the
  // spelling and shows a dash
  const items = resolveKeyValueItems(node.props['items'], (expr) => evaluateSpecValue(expr, ctx.scope))
  // .kv-list is a two-column grid: key and value alternate and pair up automatically
  return (
    <div className="kv-list">
      {items.map((item, i) => (
        <KeyValueRow key={i} label={item.label} value={item.value} />
      ))}
    </div>
  )
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="kv-key">{label}</div>
      <div className="kv-val">{value}</div>
    </>
  )
}

const CALLOUT_TONE_CLASS: Record<string, string> = {
  info: 'callout',
  warn: 'callout callout--warning',
  err: 'callout callout--error',
  ok: 'callout callout--success',
}

function CalloutImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tone = str(evalIn(node.props['tone'], ctx.scope), 'info')
  const title = str(evalIn(node.props['title'], ctx.scope))
  const text = str(evalIn(node.props['text'], ctx.scope))
  const cls = CALLOUT_TONE_CLASS[tone] ?? 'callout'
  const iconName =
    tone === 'warn' ? 'alert-triangle' : tone === 'err' ? 'alert-circle' : tone === 'ok' ? 'check-circle' : 'alert-circle'
  return (
    <div className={cls}>
      <HelmIcon name={iconName} size={13} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
        {title !== '' && <div style={{ fontWeight: 600 }}>{title}</div>}
        {text !== '' && <div>{text}</div>}
        {ctx.renderChildren(node.children)}
      </div>
    </div>
  )
}

const STEP_STATUS_META: Record<string, { icon: string; cls: string }> = {
  pending: { icon: 'circle', cls: 'badge-neutral' },
  running: { icon: 'loader', cls: 'badge-accent' },
  done: { icon: 'check', cls: 'badge-ok' },
  failed: { icon: 'x', cls: 'badge-err' },
}

function StepsImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawItems = evalIn<unknown>(node.props['items'] ?? node.props['steps'], ctx.scope)
  const items = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map((raw, i) => ({
        title: str(raw['title'] ?? raw['label'], jsonRenderStepFallbackTitle(i + 1, ctx.locale)),
        detail: str(raw['detail']),
        status: str(raw['status'], 'pending'),
      }))
    : []
  return (
    <div className="list">
      {items.map((item, i) => {
        const meta = STEP_STATUS_META[item.status] ?? STEP_STATUS_META['pending']!
        return (
          <div key={i} className="row">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
              <span className={`badge ${meta.cls}`}>
                <HelmIcon name={meta.icon} size={10} className={item.status === 'running' ? 'spin-slow' : undefined} />
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span style={{ fontSize: 12.5 }}>{item.title}</span>
                {item.detail !== '' && <span style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{item.detail}</span>}
              </div>
            </div>
            <span className="jr-metric-label tabular-nums">
              {i + 1}/{items.length}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function BarListImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawItems = evalIn<unknown>(node.props['items'], ctx.scope)
  const items = Array.isArray(rawItems)
    ? (rawItems as Array<Record<string, unknown>>).map((raw) => ({
        label: str(raw['label'] ?? raw['name']),
        value: Number(raw['value'] ?? 0),
        max: raw['max'] !== undefined ? Number(raw['max']) : undefined,
      }))
    : []
  const globalMax = Math.max(1, ...items.map((it) => it.max ?? it.value))
  return (
    <div className="jr-stack" style={{ gap: 6 }}>
      {items.map((item, i) => {
        const ratio = Math.max(0, Math.min(1, item.value / globalMax))
        return (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span
              style={{
                width: 120,
                flexShrink: 0,
                fontSize: 12,
                color: 'var(--fg-secondary)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </span>
            <div style={{ flex: 1, height: 8, borderRadius: 999, background: 'var(--bg-muted)', overflow: 'hidden' }}>
              <div style={{ width: `${ratio * 100}%`, height: '100%', borderRadius: 999, background: 'var(--accent)' }} />
            </div>
            <span
              className="tabular-nums mono"
              style={{ fontSize: 11.5, color: 'var(--fg-muted)', minWidth: 40, textAlign: 'right' }}
            >
              {item.value}
            </span>
          </div>
        )
      })}
    </div>
  )
}

function TableImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tableId = useId()
  const rawColumns = evalIn<unknown>(node.props['columns'], ctx.scope)
  const columns = Array.isArray(rawColumns)
    ? (rawColumns as Array<Record<string, unknown>>).map((c) => ({
        key: str(c['key']),
        label: str(c['label'] ?? c['key']),
      }))
    : []
  const rawRows = evalIn<unknown>(node.props['rows'], ctx.scope)
  const rows: Array<Record<string, unknown>> = Array.isArray(rawRows) ? (rawRows as Array<Record<string, unknown>>) : []
  // rowActions keep their raw templates: {$row.xxx} inside them depends on
  // the row-level scope — evaluating at the outer layer would interpolate them
  // into empty strings too early (unrecoverable at click time); they are
  // evaluated at row-render time with $row injected
  const rawRowActions = node.props['rowActions']
  const rowActions = Array.isArray(rawRowActions) ? (rawRowActions as Array<Record<string, unknown>>) : []
  const empty = str(evalIn(node.props['empty'], ctx.scope))

  const columnKeys = columns.length > 0 ? columns.map((c) => c.key) : rows[0] !== undefined ? Object.keys(rows[0]!) : []
  const headerLabels = columns.length > 0 ? columns.map((c) => c.label) : columnKeys
  const colSpan = Math.max(1, columnKeys.length + (rowActions.length > 0 ? 1 : 0))

  return (
    <div className="helm-table-wrap">
      <table className="helm-table jr-table-selectable">
        {headerLabels.length > 0 && (
          <thead>
            <tr>
              {headerLabels.map((label, i) => (
                <th key={i}>{label}</th>
              ))}
              {rowActions.length > 0 && <th style={{ textAlign: 'right' }}>{tr(ctx, JSON_RENDER_TABLE_ACTIONS_HEADER)}</th>}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} style={{ color: 'var(--fg-muted)' }}>
                {empty !== '' ? empty : tr(ctx, JSON_RENDER_TABLE_EMPTY)}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            // Row-level scope: the current row object is injected as $row, so
            // rowActions evaluation keeps the raw types of the row fields
            const rowScope: EvalScope = { ...ctx.scope, $row: row }
            const pendingKey = `${tableId}-row-${i}`
            return (
              <tr key={i}>
                {columnKeys.map((key, j) => (
                  <td key={j}>{formatSpecText(row[key])}</td>
                ))}
                {rowActions.length > 0 && (
                  <td style={{ textAlign: 'right' }}>
                    <div className="stack-row" style={{ justifyContent: 'flex-end' }}>
                      {rowActions.map((ra, k) => (
                        <RowActionButton
                          key={k}
                          label={str(evalIn(ra['label'], rowScope), tr(ctx, JSON_RENDER_ACTION_LABEL_FALLBACK))}
                          tone={str(evalIn(ra['tone'], rowScope))}
                          pending={ctx.isPending(`${pendingKey}-${k}`)}
                          succeeded={ctx.isSucceeded?.(`${pendingKey}-${k}`) === true}
                          onClick={() => ctx.runAction(ra['action'], rowScope, `${pendingKey}-${k}`)}
                        />
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Confirm/loading icon for interactive buttons: pending wins over succeeded (no stale check mark during a new request round). */
function actionIconState(pending: boolean, succeeded: boolean, icon: string): { name: string | null; className?: string } {
  if (pending) return { name: 'loader', className: 'spin-slow' }
  if (succeeded) return { name: 'check' }
  return icon !== '' ? { name: icon } : { name: null }
}

function RowActionButton({
  label,
  tone,
  pending,
  succeeded,
  onClick,
}: {
  label: string
  tone: string
  pending: boolean
  succeeded: boolean
  onClick: () => void
}) {
  const cls =
    tone === 'danger' || tone === 'err'
      ? 'btn btn-sm btn-danger'
      : tone === 'primary' || tone === 'accent'
        ? 'btn btn-sm btn-primary'
        : 'btn btn-sm'
  const icon = actionIconState(pending, succeeded, '')
  return (
    <button type="button" className={cls} disabled={pending} aria-busy={pending} onClick={onClick}>
      {icon.name !== null && <HelmIcon name={icon.name} size={11} className={icon.className} />}
      {label}
    </button>
  )
}

function AccordionImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const defaultOpenRaw = node.props['defaultOpen']
  const [open, setOpen] = useState(defaultOpenRaw === undefined ? true : bool(evalIn(defaultOpenRaw, ctx.scope)))
  const title = str(evalIn(node.props['title'], ctx.scope))
  return (
    <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--fg)',
        }}
      >
        <HelmIcon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
        {title}
      </button>
      {open && <div style={{ padding: '2px 12px 12px 31px' }}>{ctx.renderChildren(node.children)}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Forms & interaction (7)
// ---------------------------------------------------------------------------

function TextInputImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const placeholder = str(evalIn(node.props['placeholder'], ctx.scope))
  const secret = bool(evalIn(node.props['secret'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remote = typeof evaluatedValue === 'string' ? evaluatedValue : ''
  // Later SSE-pushed values sync into local state; the user's uncommitted local input is never overwritten
  const [text, setText] = useRemoteSyncedState(remote, strictEquals)
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const succeeded = ctx.isSucceeded?.(pendingKey) === true
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {label !== '' && (
        <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>
          {label}
          {secret && <span style={{ color: 'var(--warn)' }}>{tr(ctx, JSON_RENDER_SECRET_TAG)}</span>}
        </span>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
        <input
          className="input"
          style={{ flex: 1, minWidth: 0 }}
          type={secret ? 'password' : 'text'}
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        {node.props['action'] !== undefined && (
          <button
            type="button"
            className="btn btn-sm"
            style={{ flexShrink: 0 }}
            disabled={pending}
            aria-busy={pending}
            onClick={() => ctx.runAction(node.props['action'], { ...ctx.scope, $value: text }, pendingKey)}
          >
            {pending ? (
              <HelmIcon name="loader" size={12} className="spin-slow" />
            ) : succeeded ? (
              <HelmIcon name="check" size={12} />
            ) : null}
            {pending
              ? tr(ctx, JSON_RENDER_INPUT_SUBMITTING)
              : succeeded
                ? tr(ctx, JSON_RENDER_INPUT_SUBMITTED)
                : tr(ctx, JSON_RENDER_INPUT_SUBMIT)}
          </button>
        )}
      </div>
    </label>
  )
}

function SelectImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remote = typeof evaluatedValue === 'string' ? evaluatedValue : formatSpecText(evaluatedValue)
  const [selected, setSelected] = useRemoteSyncedState(remote, strictEquals)
  const pendingKey = useId()
  const rawOptions = evalIn<unknown>(node.props['options'], ctx.scope)
  const options = Array.isArray(rawOptions)
    ? (rawOptions as Array<Record<string, unknown>>).map((o) => ({
        label: str(o['label']),
        value: str(o['value']),
      }))
    : []
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {label !== '' && <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{label}</span>}
      <Select
        value={selected}
        options={options}
        onChange={(e) => {
          setSelected(e.target.value)
          if (node.props['action'] !== undefined) {
            ctx.runAction(node.props['action'], { ...ctx.scope, $value: e.target.value }, pendingKey)
          }
        }}
      />
    </label>
  )
}

function SwitchImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluated = evalIn<unknown>(node.props['value'], ctx.scope)
  // checked is re-evaluated from the remote scope on every render: new
  // booleans pushed over SSE sync naturally, no local state needed
  const checked = typeof evaluated === 'boolean' ? evaluated : bool(evaluated)
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const toggle = () => {
    // Trigger the action with the new boolean injected as $value (the
    // real-world superagent set_router_mode spelling)
    ctx.runAction(node.props['action'], { ...ctx.scope, $value: !checked }, pendingKey)
  }
  return (
    <button
      type="button"
      disabled={pending || node.props['action'] === undefined}
      onClick={toggle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 12.5,
        color: 'var(--fg-secondary)',
        padding: 0,
      }}
    >
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          width: 28,
          height: 16,
          borderRadius: 999,
          background: checked ? 'var(--accent)' : 'var(--bg-muted)',
          border: `1px solid ${checked ? 'var(--accent)' : 'var(--border-strong)'}`,
          transition: 'background 120ms ease',
          flexShrink: 0,
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: 1.5,
            left: checked ? 13 : 1.5,
            width: 11,
            height: 11,
            borderRadius: 999,
            background: 'var(--bg-elevated)',
            boxShadow: 'var(--shadow-sm)',
            transition: 'left 120ms ease',
          }}
        />
      </span>
      {pending && <HelmIcon name="loader" size={12} />}
      {label}
    </button>
  )
}

function CheckboxGroupImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const rawOptions = evalIn<unknown>(node.props['options'], ctx.scope)
  const options = Array.isArray(rawOptions)
    ? (rawOptions as Array<Record<string, unknown>>).map((o) => ({
        label: str(o['label']),
        value: str(o['value']),
      }))
    : []
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const remote = Array.isArray(evaluatedValue)
    ? new Set((evaluatedValue as unknown[]).map((v) => String(v)))
    : new Set<string>()
  const [selected, setSelected] = useRemoteSyncedState(remote, (a, b) => setsEqual(a, b))
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label !== '' && <span style={{ fontSize: 12, color: 'var(--fg-secondary)' }}>{label}</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {options.map((o) => (
          <Checkbox
            key={o.value}
            checked={selected.has(o.value)}
            label={o.label}
            onChange={(checked) => {
              const next = new Set(selected)
              if (checked) next.add(o.value)
              else next.delete(o.value)
              setSelected(next)
              if (node.props['action'] !== undefined) {
                ctx.runAction(node.props['action'], { ...ctx.scope, $value: Array.from(next) }, pendingKey)
              }
            }}
          />
        ))}
      </div>
      {pending && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <HelmIcon name="loader" size={11} />
          {tr(ctx, JSON_RENDER_SUBMITTING_HINT)}
        </span>
      )}
    </div>
  )
}

const BUTTON_VARIANT_CLASS: Record<string, string> = {
  primary: 'btn btn-primary',
  danger: 'btn btn-danger',
  ghost: 'btn btn-ghost',
}

function ButtonImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'] ?? node.props['text'], ctx.scope), tr(ctx, JSON_RENDER_BUTTON_LABEL_FALLBACK))
  const icon = str(evalIn(node.props['icon'], ctx.scope))
  const variant = str(evalIn(node.props['variant'], ctx.scope))
  // Node-unique pendingKey: multiple coexisting Buttons never disable each other
  const pendingKey = useId()
  const pending = ctx.isPending(pendingKey)
  const succeeded = ctx.isSucceeded?.(pendingKey) === true
  const cls = BUTTON_VARIANT_CLASS[variant] ?? 'btn'
  const iconState = actionIconState(pending, succeeded, icon)
  return (
    <button
      type="button"
      className={cls}
      disabled={pending || node.props['action'] === undefined}
      aria-busy={pending}
      onClick={() => ctx.runAction(node.props['action'], ctx.scope, pendingKey)}
    >
      {iconState.name !== null && <HelmIcon name={iconState.name} size={12} className={iconState.className} />}
      {label}
    </button>
  )
}

function ActionBarImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawActions = evalIn<unknown>(node.props['actions'], ctx.scope)
  const actionBarId = useId()
  const actions = Array.isArray(rawActions) ? (rawActions as Array<Record<string, unknown>>) : []
  if (actions.length > 0) {
    return (
      <div className="stack-row">
        {actions.map((a, i) => {
          const label = str(evalIn(a['label'], ctx.scope), tr(ctx, JSON_RENDER_ACTION_LABEL_FALLBACK))
          const icon = str(evalIn(a['icon'], ctx.scope))
          const variant = str(evalIn(a['variant'], ctx.scope))
          // Node-unique prefix + button index: multiple coexisting ActionBars never disable each other
          const pendingKey = `${actionBarId}-${i}`
          const pending = ctx.isPending(pendingKey)
          const succeeded = ctx.isSucceeded?.(pendingKey) === true
          const cls = BUTTON_VARIANT_CLASS[variant] ?? 'btn'
          const iconState = actionIconState(pending, succeeded, icon)
          return (
            <button
              key={i}
              type="button"
              className={cls}
              disabled={pending}
              aria-busy={pending}
              onClick={() => ctx.runAction(a['action'], ctx.scope, pendingKey)}
            >
              {iconState.name !== null && <HelmIcon name={iconState.name} size={12} className={iconState.className} />}
              {label}
            </button>
          )
        })}
      </div>
    )
  }
  return <div className="stack-row">{ctx.renderChildren(node.children)}</div>
}

function TabsImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawTabs = evalIn<unknown>(node.props['tabs'], ctx.scope)
  const tabs = Array.isArray(rawTabs)
    ? (rawTabs as Array<Record<string, unknown>>).map((t, i) => ({
        id: str(t['id'], `tab-${i}`),
        label: str(t['label'] ?? t['title'], jsonRenderTabFallbackTitle(i + 1, ctx.locale)),
        childrenRaw: t['children'],
      }))
    : []
  const [activeId, setActiveId] = useState(tabs[0]?.id)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  return (
    <Tabs
      value={active?.id}
      onValueChange={(val) => setActiveId(val)}
      variant="underline"
      style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}
    >
      <TabsList className="tabs-bar">
        {tabs.map((t) => (
          <TabsTrigger key={t.id} value={t.id} className="tab-btn">
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {active !== undefined && (
        <div style={{ padding: '12px 4px' }}>
          <TabChildren childrenRaw={active.childrenRaw} ctx={ctx} />
        </div>
      )}
    </Tabs>
  )
}

/** Tab children are raw, unevaluated JSON (a tree-shorthand array); normalize them on the spot before rendering. */
function TabChildren({ childrenRaw, ctx }: { childrenRaw: unknown; ctx: SpecRenderContext }) {
  if (!Array.isArray(childrenRaw)) return null
  const normalized = normalizeSpec({ component: 'Stack', children: childrenRaw })
  if (normalized.root === null) return null
  return <SpecNodeList nodes={normalized.root.children} ctx={ctx} />
}

// ---------------------------------------------------------------------------
// Slot primitive: cross-plugin sub-slot injection on the declarative track
// (reuses the client track's <PluginSlot />)
// ---------------------------------------------------------------------------

function SlotImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const name = str(evalIn(node.props['name'], ctx.scope))
  const modeRaw = str(evalIn(node.props['mode'], ctx.scope), 'list')
  const mode = modeRaw === 'single' ? 'single' : 'list'
  const fallback = node.children.length > 0 ? <SpecNodeList nodes={node.children} ctx={ctx} /> : undefined
  if (name === '') {
    return (
      <div className="callout callout--warning">
        <HelmIcon name="alert-triangle" size={13} />
        <span>{tr(ctx, JSON_RENDER_SLOT_MISSING_NAME)}</span>
      </div>
    )
  }
  if (ctx.pluginId === undefined) {
    return (
      <div className="callout callout--warning">
        <HelmIcon name="alert-triangle" size={13} />
        <span>{tr(ctx, JSON_RENDER_SLOT_NO_HOST)}</span>
      </div>
    )
  }
  return (
    <PluginSlot
      name={name}
      mode={mode}
      fallback={fallback}
      slotProps={{ ...ctx.scope['$data'] as Record<string, unknown> | undefined }}
      conversationId={ctx.conversationId}
      ownerPluginId={ctx.pluginId}
    />
  )
}

// ---------------------------------------------------------------------------
// Dispatch table
// ---------------------------------------------------------------------------

export type SpecPrimitiveImpl = (args: { node: NormalizedSpecNode; ctx: SpecRenderContext }) => ReactNode

/** Primitive-name contract private to this plugin (migrated out of protocol; registry at the end of this file). */
export type SpecPrimitiveName =
  | 'Stack' | 'Card' | 'Text' | 'Badge' | 'Markdown'
  | 'MetricGrid' | 'MetricCard' | 'KeyValueList' | 'Callout'
  | 'Steps' | 'BarList' | 'Table' | 'Accordion'
  | 'TextInput' | 'Select' | 'Switch' | 'CheckboxGroup'
  | 'Button' | 'ActionBar' | 'Tabs' | 'Slot'

const PRIMITIVES: Record<SpecPrimitiveName, SpecPrimitiveImpl> = {
  Stack: StackImpl,
  Card: CardImpl,
  Text: TextImpl,
  Badge: BadgeImpl,
  Markdown: MarkdownImpl,
  MetricGrid: MetricGridImpl,
  MetricCard: MetricCardImpl,
  KeyValueList: KeyValueListImpl,
  Callout: CalloutImpl,
  Steps: StepsImpl,
  BarList: BarListImpl,
  Table: TableImpl,
  Accordion: AccordionImpl,
  TextInput: TextInputImpl,
  Select: SelectImpl,
  Switch: SwitchImpl,
  CheckboxGroup: CheckboxGroupImpl,
  Button: ButtonImpl,
  ActionBar: ActionBarImpl,
  Tabs: TabsImpl,
  Slot: SlotImpl,
}

/** Render one normalized node (unknown components get an explicit notice, never silently swallowed). */
export function SpecNodeView({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }): ReactNode {
  const impl = (PRIMITIVES as Record<string, SpecPrimitiveImpl | undefined>)[node.component]
  if (impl === undefined) {
    return (
      <div className="callout callout--warning">
        <HelmIcon name="alert-triangle" size={13} />
        <span>{jsonRenderUnknownComponent(node.component, ctx.locale)}</span>
      </div>
    )
  }
  return impl({ node, ctx })
}

/** Render a list of normalized nodes. */
export function SpecNodeList({ nodes, ctx }: { nodes: NormalizedSpecNode[]; ctx: SpecRenderContext }): ReactNode {
  return (
    <>
      {nodes.map((child, i) => (
        <SpecNodeView key={i} node={child} ctx={ctx} />
      ))}
    </>
  )
}
