/**
 * 插件共享的轻量布局原语（组合式、无状态、SSR 安全）：
 * - 全部复用宿主 styles.css 通用设计系统类（.screen-container / .screen-header /
 *   .helm-table-wrap / .helm-table / .table-empty / .loading-state / .kv-grid 等），
 *   不引入新 CSS 主题，不做黑盒 columns/data 表格——结构与单元格仍由 JSX 表达；
 * - 不使用 Portal、不触碰 document / window，renderToString 可直接渲染；
 * - 文件只导出组件与 TS 类型（宿主 Fast Refresh 契约同源）。
 */
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react'
import { HelmIcon } from './icons.js'

function joinClass(...parts: Array<string | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

// ---------------------------------------------------------------------------
// Screen：页面容器 / header / title / subtitle
// ---------------------------------------------------------------------------

export interface ScreenProps {
  /** 容器附加类名（业务特异结构扩展点）。 */
  className?: string
  /** 页头内容：缺省由 title/subtitle/actions 组合生成。 */
  header?: ReactNode
  /** 主标题文本；需要图标时用自定义 header。 */
  title?: ReactNode
  /** 副标题文本（右侧或标题下方，随换行自然排布）。 */
  subtitle?: ReactNode
  /** 页头右侧动作区（按钮等）。 */
  actions?: ReactNode
  children?: ReactNode
}

/**
 * 全屏页面容器：统一纵向滚动、间距与页头排版。
 * header/title/subtitle/actions 可组合——传 header 时忽略后三者，
 * 两者都不传则不渲染页头。
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
            <div className="screen-title">{title}</div>
            {(subtitle !== undefined || actions !== undefined) && (
              <>
                {subtitle !== undefined && <span className="screen-subtitle">{subtitle}</span>}
                {actions !== undefined && <div className="stack-row">{actions}</div>}
              </>
            )}
          </div>
        ))}
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// ScreenSection：页面分节
// ---------------------------------------------------------------------------

export interface ScreenSectionProps {
  /** 分节标题文本（推荐字符串；复杂标题可用 titleExtra 组合）。 */
  title?: ReactNode
  /** 标题行右侧补充内容（如计数徽标、入口按钮）。 */
  titleExtra?: ReactNode
  className?: string
  children?: ReactNode
}

/** 页面分节：可选标题 + 内容纵向排列。 */
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
// DataTable：宿主表格原语 + 统一 loading / empty
// ---------------------------------------------------------------------------

export interface DataTableProps {
  /** 列数：loading / empty 占位行的 colSpan（缺省按 thead 推断，推断不出用 1）。 */
  columns?: number
  /** 数据加载中：渲染统一加载行（不渲染 children）。 */
  loading?: boolean
  /** 加载提示文案。 */
  loadingLabel?: string
  /** 数据为空：渲染统一空态行（不渲染 children）。 */
  empty?: boolean
  /** 空态文案（缺省「暂无数据」）。 */
  emptyLabel?: string
  /** 表格语义描述（无障碍：aria-label）。 */
  label?: string
  className?: string
  /**
   * 表格内容：thead（自定义表头）与 tbody（数据行）由调用方以 JSX 组合，
   * 本原语不接管列定义——保持组合式，不做黑盒 columns/data 表格。
   */
  children: ReactNode
}

/** 展开 JSX Fragment，保留有效 React 元素。 */
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

/** 计算占位行 colSpan：显式声明优先，否则统计 thead 第一行单元格的 colSpan。 */
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
 * 组合式表格：外壳复用宿主 .helm-table-wrap / .helm-table 原语并统一
 * loading / empty 占位行；表头与数据单元格完全由 children JSX 表达：
 *
 * ```tsx
 * <DataTable loading={rows === undefined} empty={rows?.length === 0} columns={4}>
 *   <thead>
 *     <tr><th>ID</th><th>名称</th><th>状态</th><th>操作</th></tr>
 *   </thead>
 *   <tbody>
 *     {rows?.map((r) => <tr key={r.id}><td>{r.id}</td>…</tr>)}
 *   </tbody>
 * </DataTable>
 * ```
 */
export function DataTable(props: DataTableProps): ReactNode {
  const {
    columns,
    loading = false,
    loadingLabel = '数据读取中…',
    empty = false,
    emptyLabel = '暂无数据',
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
// KvGrid：键值概览
// ---------------------------------------------------------------------------

export interface KvGridProps {
  /** 键值对：按声明顺序渲染（key 为标签，value 为内容）。 */
  items: ReadonlyArray<{ key: ReactNode; value: ReactNode }>
  className?: string
}

/** 键值概览网格：复用宿主 .kv-grid 两列自适应原语（key/value 为网格直接子项）。 */
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
