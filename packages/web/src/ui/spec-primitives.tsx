/**
 * @json-render 20 个标准原语组件（布局展示 13 + 表单交互 7）。
 *
 * 每个原语接收已归一化的 NormalizedSpecNode 与渲染上下文（scope 求值 +
 * 子节点渲染 + 动作执行），无任何插件业务特判；样式全部复用 styles.css
 * 的 .jr-* / .btn / .badge / .card / .list / .tabs 既有类，零新增全局样式。
 */
import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { HelmIcon } from '../lib/icons.js'
import { evaluateSpecValue, type EvalScope } from './evaluator.js'
import { formatSpecText, normalizeSpec, resolveKeyValueItems, type NormalizedSpecNode } from './spec-normalize.js'

export interface SpecRenderContext {
  /** 属性求值作用域（$docs / $data / $row / $value）。 */
  scope: EvalScope
  /** 子树渲染入口（原语间互相组合）。 */
  renderChildren(children: NormalizedSpecNode[]): ReactNode
  /** 执行一条声明式动作指令；pendingKey 相同的按钮进入 loading 防连点。 */
  runAction(rawAction: unknown, scope: EvalScope, pendingKey: string): void
  /** 该 pendingKey 的动作是否执行中（loading 防连点）。 */
  isPending(pendingKey: string): boolean
}

function str(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return fallback
}

function bool(value: unknown): boolean {
  return value === true
}

/** 原语内部再求值（Table 行动作的 $row 注入等场景：局部 scope 覆盖）。 */
function evalIn<T>(template: unknown, scope: EvalScope): T {
  return evaluateSpecValue<T>(template, scope)
}

// ---------------------------------------------------------------------------
// 布局与展示（13 个）
// ---------------------------------------------------------------------------

function StackImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const direction = str(evalIn(node.props['direction'], ctx.scope), 'vertical')
  const gap = evalIn<unknown>(node.props['gap'], ctx.scope)
  const style = typeof gap === 'number' && Number.isFinite(gap) ? { gap } : undefined
  return (
    <div className={direction === 'horizontal' ? 'jr-stack-row' : 'jr-stack'} style={style}>
      {ctx.renderChildren(node.children)}
    </div>
  )
}

function CardImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const title = str(evalIn(node.props['title'], ctx.scope))
  const subtitle = str(evalIn(node.props['subtitle'], ctx.scope))
  return (
    <div className="card">
      {(title !== '' || subtitle !== '') && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: node.children.length > 0 ? 10 : 0 }}>
          {title !== '' && <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>}
          {subtitle !== '' && <div style={{ fontSize: 11.5, color: 'var(--fg-muted)' }}>{subtitle}</div>}
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
      <Markdown remarkPlugins={[remarkGfm]}>{text}</Markdown>
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
  const itemsRaw = evalIn<unknown>(node.props['items'], ctx.scope)
  // key 以 '/$' 或 '{' 开头时按表达式求值（superagent/triggers settingsPanel 真实写法）
  const items = resolveKeyValueItems(itemsRaw, (expr) => evaluateSpecValue(expr, ctx.scope))
  // .jr-kv-list 是两列 grid：key 与 value 交替排列即自动成对
  return (
    <div className="jr-kv-list">
      {items.map((item, i) => (
        <KeyValueRow key={i} label={item.label} value={item.value} />
      ))}
    </div>
  )
}

function KeyValueRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <div className="jr-kv-key">{label}</div>
      <div className="jr-kv-val">{value}</div>
    </>
  )
}

const CALLOUT_TONE_CLASS: Record<string, string> = {
  info: 'jr-callout',
  warn: 'jr-callout jr-callout-warn',
  err: 'jr-callout jr-callout-err',
  ok: 'jr-callout jr-callout-ok',
}

function CalloutImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const tone = str(evalIn(node.props['tone'], ctx.scope), 'info')
  const title = str(evalIn(node.props['title'], ctx.scope))
  const text = str(evalIn(node.props['text'], ctx.scope))
  const cls = CALLOUT_TONE_CLASS[tone] ?? 'jr-callout'
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
        title: str(raw['title'] ?? raw['label'], `步骤 ${i + 1}`),
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
                <HelmIcon name={meta.icon} size={10} />
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
  const rawColumns = evalIn<unknown>(node.props['columns'], ctx.scope)
  const columns = Array.isArray(rawColumns)
    ? (rawColumns as Array<Record<string, unknown>>).map((c) => ({
        key: str(c['key']),
        label: str(c['label'] ?? c['key']),
      }))
    : []
  const rawRows = evalIn<unknown>(node.props['rows'], ctx.scope)
  const rows: Array<Record<string, unknown>> = Array.isArray(rawRows) ? (rawRows as Array<Record<string, unknown>>) : []
  const rawRowActions = evalIn<unknown>(node.props['rowActions'], ctx.scope)
  const rowActions = Array.isArray(rawRowActions) ? (rawRowActions as Array<Record<string, unknown>>) : []
  const empty = str(evalIn(node.props['empty'], ctx.scope))

  const columnKeys = columns.length > 0 ? columns.map((c) => c.key) : rows[0] !== undefined ? Object.keys(rows[0]!) : []
  const headerLabels = columns.length > 0 ? columns.map((c) => c.label) : columnKeys
  const colSpan = Math.max(1, columnKeys.length + (rowActions.length > 0 ? 1 : 0))

  return (
    <div className="jr-table-wrap">
      <table className="jr-table">
        {headerLabels.length > 0 && (
          <thead>
            <tr>
              {headerLabels.map((label, i) => (
                <th key={i}>{label}</th>
              ))}
              {rowActions.length > 0 && <th style={{ textAlign: 'right' }}>操作</th>}
            </tr>
          </thead>
        )}
        <tbody>
          {rows.length === 0 && (
            <tr>
              <td colSpan={colSpan} style={{ color: 'var(--fg-muted)' }}>
                {empty !== '' ? empty : '暂无数据'}
              </td>
            </tr>
          )}
          {rows.map((row, i) => {
            // 行级 scope：当前行对象注入 $row，rowActions 求值时保持 row 字段原始类型
            const rowScope: EvalScope = { ...ctx.scope, $row: row }
            const pendingKey = `table-row-${i}`
            return (
              <tr key={i}>
                {columnKeys.map((key, j) => (
                  <td key={j}>{formatSpecText(row[key])}</td>
                ))}
                {rowActions.length > 0 && (
                  <td style={{ textAlign: 'right' }}>
                    <div className="jr-stack-row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                      {rowActions.map((ra, k) => (
                        <RowActionButton
                          key={k}
                          label={str(evalIn(ra['label'], rowScope), '操作')}
                          tone={str(evalIn(ra['tone'], rowScope))}
                          pending={ctx.isPending(`${pendingKey}-${k}`)}
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

function RowActionButton({
  label,
  tone,
  pending,
  onClick,
}: {
  label: string
  tone: string
  pending: boolean
  onClick: () => void
}) {
  const cls =
    tone === 'danger' || tone === 'err'
      ? 'btn btn-sm btn-danger'
      : tone === 'primary' || tone === 'accent'
        ? 'btn btn-sm btn-primary'
        : 'btn btn-sm'
  return (
    <button type="button" className={cls} disabled={pending} onClick={onClick}>
      {pending && <HelmIcon name="loader" size={11} />}
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
// 表单与交互（7 个）
// ---------------------------------------------------------------------------

function TextInputImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const placeholder = str(evalIn(node.props['placeholder'], ctx.scope))
  const secret = bool(evalIn(node.props['secret'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const [text, setText] = useState(typeof evaluatedValue === 'string' ? evaluatedValue : '')
  const pending = ctx.isPending('textinput')
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {label !== '' && (
        <span style={{ fontSize: 11.5, color: 'var(--fg-secondary)' }}>
          {label}
          {secret && <span style={{ color: 'var(--warn)' }}>（机密）</span>}
        </span>
      )}
      <span className="jr-stack-row" style={{ gap: 4 }}>
        <input
          className="input"
          type={secret ? 'password' : 'text'}
          value={text}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => setText(e.target.value)}
        />
        {node.props['action'] !== undefined && (
          <button
            type="button"
            className="btn"
            disabled={pending}
            onClick={() => ctx.runAction(node.props['action'], { ...ctx.scope, $value: text }, 'textinput')}
          >
            {pending && <HelmIcon name="loader" size={12} />}
            提交
          </button>
        )}
      </span>
    </label>
  )
}

function SelectImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluatedValue = evalIn<unknown>(node.props['value'], ctx.scope)
  const initial = typeof evaluatedValue === 'string' ? evaluatedValue : formatSpecText(evaluatedValue)
  const [selected, setSelected] = useState(initial)
  const rawOptions = evalIn<unknown>(node.props['options'], ctx.scope)
  const options = Array.isArray(rawOptions)
    ? (rawOptions as Array<Record<string, unknown>>).map((o) => ({
        label: str(o['label']),
        value: str(o['value']),
      }))
    : []
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      {label !== '' && <span style={{ fontSize: 11.5, color: 'var(--fg-secondary)' }}>{label}</span>}
      <select
        className="select"
        value={selected}
        onChange={(e) => {
          setSelected(e.target.value)
          if (node.props['action'] !== undefined) {
            ctx.runAction(node.props['action'], { ...ctx.scope, $value: e.target.value }, `select-${label}`)
          }
        }}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function SwitchImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const label = str(evalIn(node.props['label'], ctx.scope))
  const evaluated = evalIn<unknown>(node.props['value'], ctx.scope)
  const checked = typeof evaluated === 'boolean' ? evaluated : bool(evaluated)
  const pending = ctx.isPending('switch')
  const toggle = () => {
    // 新布尔值注入 $value 后触发 action（superagent set_router_mode 真实写法）
    ctx.runAction(node.props['action'], { ...ctx.scope, $value: !checked }, 'switch')
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
  const [selected, setSelected] = useState<Set<string>>(
    new Set(Array.isArray(evaluatedValue) ? (evaluatedValue as unknown[]).map((v) => String(v)) : []),
  )
  const pending = ctx.isPending('checkbox-group')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {label !== '' && <span style={{ fontSize: 11.5, color: 'var(--fg-secondary)' }}>{label}</span>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        {options.map((o) => (
          <label
            key={o.value}
            style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, color: 'var(--fg-secondary)', cursor: 'pointer' }}
          >
            <input
              type="checkbox"
              checked={selected.has(o.value)}
              onChange={(e) => {
                const next = new Set(selected)
                if (e.target.checked) next.add(o.value)
                else next.delete(o.value)
                setSelected(next)
                if (node.props['action'] !== undefined) {
                  ctx.runAction(node.props['action'], { ...ctx.scope, $value: Array.from(next) }, 'checkbox-group')
                }
              }}
            />
            {o.label}
          </label>
        ))}
      </div>
      {pending && (
        <span style={{ fontSize: 11, color: 'var(--fg-muted)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <HelmIcon name="loader" size={11} />
          正在提交...
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
  const label = str(evalIn(node.props['label'] ?? node.props['text'], ctx.scope), '按钮')
  const icon = str(evalIn(node.props['icon'], ctx.scope))
  const variant = str(evalIn(node.props['variant'], ctx.scope))
  const pending = ctx.isPending('button')
  const cls = BUTTON_VARIANT_CLASS[variant] ?? 'btn'
  return (
    <button
      type="button"
      className={cls}
      disabled={pending || node.props['action'] === undefined}
      onClick={() => ctx.runAction(node.props['action'], ctx.scope, 'button')}
    >
      {(icon !== '' || pending) && <HelmIcon name={pending ? 'loader' : icon} size={12} />}
      {label}
    </button>
  )
}

function ActionBarImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawActions = evalIn<unknown>(node.props['actions'], ctx.scope)
  const actions = Array.isArray(rawActions) ? (rawActions as Array<Record<string, unknown>>) : []
  if (actions.length > 0) {
    return (
      <div className="jr-stack-row">
        {actions.map((a, i) => {
          const label = str(evalIn(a['label'], ctx.scope), '操作')
          const icon = str(evalIn(a['icon'], ctx.scope))
          const variant = str(evalIn(a['variant'], ctx.scope))
          const pendingKey = `actionbar-${i}`
          const pending = ctx.isPending(pendingKey)
          const cls = BUTTON_VARIANT_CLASS[variant] ?? 'btn'
          return (
            <button
              key={i}
              type="button"
              className={cls}
              disabled={pending}
              onClick={() => ctx.runAction(a['action'], ctx.scope, pendingKey)}
            >
              {(icon !== '' || pending) && <HelmIcon name={pending ? 'loader' : icon} size={12} />}
              {label}
            </button>
          )
        })}
      </div>
    )
  }
  return <div className="jr-stack-row">{ctx.renderChildren(node.children)}</div>
}

function TabsImpl({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }) {
  const rawTabs = evalIn<unknown>(node.props['tabs'], ctx.scope)
  const tabs = Array.isArray(rawTabs)
    ? (rawTabs as Array<Record<string, unknown>>).map((t, i) => ({
        id: str(t['id'], `tab-${i}`),
        label: str(t['label'] ?? t['title'], `Tab ${i + 1}`),
        childrenRaw: t['children'],
      }))
    : []
  const [activeId, setActiveId] = useState(tabs[0]?.id)
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      <div className="tabs-bar">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`tab-btn ${t.id === active?.id ? 'tab-btn-active' : ''}`}
            onClick={() => setActiveId(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      {active !== undefined && (
        <div style={{ padding: '12px 4px' }}>
          <TabChildren childrenRaw={active.childrenRaw} ctx={ctx} />
        </div>
      )}
    </div>
  )
}

/** Tab 的 children 是求值前的原始 JSON（树状简写数组），需现场归一化再渲染。 */
function TabChildren({ childrenRaw, ctx }: { childrenRaw: unknown; ctx: SpecRenderContext }) {
  if (!Array.isArray(childrenRaw)) return null
  const normalized = normalizeSpec({ component: 'Stack', children: childrenRaw })
  if (normalized.root === null) return null
  return <SpecNodeList nodes={normalized.root.children} ctx={ctx} />
}

// ---------------------------------------------------------------------------
// 分发表
// ---------------------------------------------------------------------------

export type SpecPrimitiveImpl = (args: { node: NormalizedSpecNode; ctx: SpecRenderContext }) => ReactNode

const PRIMITIVES: Record<string, SpecPrimitiveImpl> = {
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
}

/** 渲染一个归一化节点（未知组件显式提示，不静默吞掉）。 */
export function SpecNodeView({ node, ctx }: { node: NormalizedSpecNode; ctx: SpecRenderContext }): ReactNode {
  const impl = PRIMITIVES[node.component]
  if (impl === undefined) {
    return (
      <div className="jr-callout jr-callout-warn">
        <HelmIcon name="alert-triangle" size={13} />
        <span>未注册的组件: {node.component}</span>
      </div>
    )
  }
  return impl({ node, ctx })
}

/** 渲染一组归一化节点。 */
export function SpecNodeList({ nodes, ctx }: { nodes: NormalizedSpecNode[]; ctx: SpecRenderContext }): ReactNode {
  return (
    <>
      {nodes.map((child, i) => (
        <SpecNodeView key={i} node={child} ctx={ctx} />
      ))}
    </>
  )
}
