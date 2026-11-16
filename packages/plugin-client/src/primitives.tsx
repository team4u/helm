/**
 * Lightweight layout primitives shared by plugins (composable, stateless, SSR safe):
 * - All of them reuse the generic design-system classes from the host styles.css
 *   (.screen-container / .screen-header / .helm-table-wrap / .helm-table /
 *   .table-empty / .loading-state / .kv-grid, etc.). No new CSS theme is
 *   introduced and there is no opaque columns/data table — structure and cells
 *   are still expressed as JSX;
 * - No Portal, no document / window access, renderToString works directly;
 * - This file only exports components and TS types (same contract as the host
 *   Fast Refresh rule).
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { HelmIcon } from './icons.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Screen: page container / header / title / subtitle
// ---------------------------------------------------------------------------

export interface ScreenProps {
  /** Extra container class name (extension point for custom layouts). */
  className?: string
  /** Page header content: defaults to the title/subtitle/actions composition. */
  header?: ReactNode
  /** Main title text; use a custom header when an icon is needed. */
  title?: ReactNode
  /** Subtitle text (right of the title or below it, wrapping naturally). */
  subtitle?: ReactNode
  /** Action area on the right of the header (buttons etc.). */
  actions?: ReactNode
  children?: ReactNode
}

/**
 * Full-screen page container: unified vertical scrolling, spacing and header
 * layout. header/title/subtitle/actions are composable — passing header ignores
 * the other three; when none is passed, no header is rendered.
 */
export function Screen(props: ScreenProps): ReactNode {
  const { className, header, title, subtitle, actions, children } = props
  const hasHeader = header !== undefined || title !== undefined || subtitle !== undefined || actions !== undefined
  return (
    <div className={joinClass('screen-container', className)}>
      {hasHeader &&
        (header !== undefined ? (
          header
        ) : (
          <div className="screen-header">
            <div className="screen-heading">
              {title !== undefined && <div className="screen-title">{title}</div>}
              {subtitle !== undefined && <span className="screen-subtitle">{subtitle}</span>}
            </div>
            {actions !== undefined && <div className="stack-row">{actions}</div>}
          </div>
        ))}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ScreenSection: page section
// ---------------------------------------------------------------------------

export interface ScreenSectionProps {
  /** Section title text (plain strings recommended; compose with titleExtra for complex titles). */
  title?: ReactNode
  /** Extra content on the right of the title row (e.g. count badge, entry button). */
  titleExtra?: ReactNode
  className?: string
  children?: ReactNode
}

/** Page section: optional title + vertically stacked content. */
export function ScreenSection(props: ScreenSectionProps): ReactNode {
  const { title, titleExtra, className, children } = props
  return (
    <section className={joinClass('screen-section', className)}>
      {(title !== undefined || titleExtra !== undefined) && (
        <div className="screen-section-title">
          {title}
          {titleExtra !== undefined && <span className="screen-subtitle">{titleExtra}</span>}
        </div>
      )}
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// DataTable: host table primitive + unified loading / empty states
// ---------------------------------------------------------------------------

export interface DataTableProps {
  /** Column count: colSpan for the loading / empty placeholder row (defaults to inference from thead, or 1). */
  columns?: number
  /** Data is loading: renders the unified loading row (children not rendered). */
  loading?: boolean
  /** Loading label text. */
  loadingLabel?: string
  /** Data is empty: renders the unified empty row (children not rendered). */
  empty?: boolean
  /** Empty-state label text (defaults to "No data"). */
  emptyLabel?: string
  /** Table semantic description (accessibility: aria-label). */
  label?: string
  className?: string
  /**
   * Table content: thead (custom header) and tbody (data rows) are composed by
   * the caller as JSX. This primitive does not take over column definitions —
   * stay composable, no opaque columns/data table.
   */
  children: ReactNode
}

/** Flattens JSX Fragments, keeping valid React elements. */
function flattenElements(node: ReactNode): ReactElement[] {
  return Children.toArray(node).flatMap((child) => {
    if (!isValidElement(child)) return []
    if (child.type === Fragment) {
      const props = child.props as { children?: ReactNode }
      return flattenElements(props.children)
    }
    return [child]
  })
}

/** Computes the placeholder-row colSpan: explicit declaration wins, otherwise sum the colSpans of the first thead row cells. */
function inferColSpan(columns: number | undefined, children: ReactNode): number {
  if (columns !== undefined && Number.isInteger(columns) && columns > 0) return columns
  const thead = flattenElements(children).find((child) => child.type === 'thead')
  const row = thead === undefined
    ? undefined
    : flattenElements((thead.props as { children?: ReactNode }).children).find((child) => child.type === 'tr')
  if (row === undefined) return 1

  const cells = flattenElements((row.props as { children?: ReactNode }).children)
  const span = cells.reduce((total, cell) => {
    const cellProps = cell.props as { colSpan?: unknown }
    const colSpan = typeof cellProps.colSpan === 'number' && Number.isInteger(cellProps.colSpan) && cellProps.colSpan > 0
      ? cellProps.colSpan
      : 1
    return total + colSpan
  }, 0)
  return span || 1
}

/**
 * Composable table: the shell reuses the host .helm-table-wrap / .helm-table
 * primitives and unifies the loading / empty placeholder rows; the header and
 * data cells are fully expressed by children JSX:
 *
 * ```tsx
 * <DataTable loading={rows === undefined} empty={rows?.length === 0} columns={4}>
 *   <thead>
 *     <tr><th>ID</th><th>Name</th><th>Status</th><th>Actions</th></tr>
 *   </thead>
 *   <tbody>
 *     {rows?.map((r) => <tr key={r.id}><td>{r.id}</td>…</tr>)}
 *   </tbody>
 * </DataTable>
 * ```
 *
 * The default loading / empty labels below are fixed English texts of the SDK.
 * If they ever need to be translated by the host, expose localized strings via
 * props (loadingLabel / emptyLabel) — do not extend the protocol for this.
 */
export function DataTable(props: DataTableProps): ReactNode {
  const {
    columns,
    loading = false,
    loadingLabel = 'Loading…',
    empty = false,
    emptyLabel = 'No data',
    label,
    className,
    children,
  } = props
  const colSpan = inferColSpan(columns, children)
  return (
    <div className="helm-table-wrap">
      <table className={joinClass('helm-table', className)} aria-label={label}>
        {loading ? (
          <tbody>
            <tr>
              <td colSpan={colSpan}>
                <div className="loading-state" role="status">
                  <HelmIcon name="loader" size={12} className="spin-slow" />
                  <span>{loadingLabel}</span>
                </div>
              </td>
            </tr>
          </tbody>
        ) : empty ? (
          <tbody>
            <tr>
              <td colSpan={colSpan} className="table-empty">
                {emptyLabel}
              </td>
            </tr>
          </tbody>
        ) : (
          children
        )}
      </table>
    </div>
  )
}

// ---------------------------------------------------------------------------
// KvGrid: key-value overview
// ---------------------------------------------------------------------------

export interface KvGridProps {
  /** Key-value pairs rendered in declaration order (key is the label, value is the content). */
  items: ReadonlyArray<{ key: ReactNode; value: ReactNode }>
  className?: string
}

/** Key-value overview grid: reuses the host .kv-grid two-column adaptive primitive (key/value are direct grid children). */
export function KvGrid(props: KvGridProps): ReactNode {
  const { items, className } = props
  return (
    <div className={joinClass('kv-grid', className)}>
      {items.map((item, index) => (
        <Fragment key={index}>
          <div className="kv-key">{item.key}</div>
          <div className="kv-val">{item.value}</div>
        </Fragment>
      ))}
    </div>
  )
}
