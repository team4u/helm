/**
 * 子代理实时卡与后台汇报卡共用的纯展示框架（插件私有，不进公开导出）。
 *
 * 只负责容器 / 头部 / 动作 / 副栏的 DOM 骨架与既有 .subagent-live-* 样式：
 * 不含任何 hooks、实时状态或业务判定，调用方经插槽注入内容——
 * - activate：整卡点击 / 回车 / 空格导航（子代理实时卡语义，挂 subagent-card-clickable）；
 * - toggle：头部触发区渲染为折叠开关按钮（汇报卡语义，aria-expanded / aria-controls）。
 * 两种语义互斥：开关卡不做整卡导航，正文可选可点不误触折叠。
 */
import type { KeyboardEvent, ReactNode } from 'react'

export interface ExecutionCardActivate {
  /** 整卡 aria-label（如「打开子会话 #11 抽屉」）。 */
  label: string
  /** 整卡悬浮提示（多行明细）。 */
  tooltip: string
  open: () => void
}

export interface ExecutionCardToggle {
  /** 折叠开关 aria-label（展开 / 收起各一句）。 */
  label: string
  expanded: boolean
  /** 展开区真实 DOM 节点 id（收起时也保持存在，aria-controls 恒指向真实区域）。 */
  controlsId: string
  onToggle: () => void
}

export function ExecutionCard(props: {
  /** 状态附加类（warn / error / expanded 等变体）。 */
  variantClass?: string
  /** 头部触发区内容（图标 + 标题 + 徽章 + 统计尾注）。 */
  heading: ReactNode
  /** 头部动作区（已隔离点击，不冒泡触发整卡导航）。 */
  actions?: ReactNode
  /** 单行副栏（subagent-live-subline；不传不渲染占位）。 */
  snippet?: ReactNode
  children?: ReactNode
} & (
  | { activate: ExecutionCardActivate; toggle?: never }
  | { toggle: ExecutionCardToggle; activate?: never }
)): ReactNode {
  const { activate, toggle, heading, actions, snippet } = props
  const cardClass = `subagent-live-card${props.variantClass ? ` ${props.variantClass}` : ''}`
  return (
    <div
      {...(activate !== undefined
        ? {
            role: 'button' as const,
            tabIndex: 0,
            className: `${cardClass} subagent-card-clickable`,
            'aria-label': activate.label,
            title: activate.tooltip,
            onClick: activate.open,
            onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
              // 内嵌动作、details/summary 的键盘激活属于控件本身，而非卡片导航。
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                activate.open()
              }
            },
          }
        : { className: cardClass })}
    >
      <div className="subagent-live-header">
        {toggle !== undefined ? (
          <button
            type="button"
            className="subagent-live-trigger subagent-live-toggleable"
            aria-expanded={toggle.expanded}
            aria-controls={toggle.controlsId}
            aria-label={toggle.label}
            onClick={toggle.onToggle}
          >
            {heading}
          </button>
        ) : (
          <div className="subagent-live-trigger">{heading}</div>
        )}
        {actions !== undefined ? (
          <span className="subagent-live-actions" onClick={(e) => e.stopPropagation()}>
            {actions}
          </span>
        ) : null}
      </div>
      {snippet !== undefined ? snippet : null}
      {props.children}
    </div>
  )
}
