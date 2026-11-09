/**
 * PluginMicroAction：三类微插槽（conversation.header.action / conversation.row.action /
 * timeline.entry.action）的统一渲染组件。
 *
 * - action-only（仅 actionId）：按 variant 渲染标准极简图标按钮（toolbar / hover）
 *   或菜单项（menu），点击调用 actionPluginId ?? pluginId 的 action，载荷由
 *   宿主实际上下文强制覆盖 spec.input（见 action-model.buildMicroActionInput）；
 * - 声明 client/json：内联 <PluginUiView />（独立 ViewBoundary 隔离，卸载即清理）；
 * - pending 期间禁用防重复提交；失败/成功经 store.pushNotice 显式通知，绝不静默吞错；
 * - 点击不冒泡（宿主行点击切换会话等行为不受干扰）。
 */
import { useState } from 'react'
import type { ReactNode } from 'react'
import type { ConversationActionSpec } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { useHelmStore } from '../lib/store-context.js'
import type { QualifiedUiSpec } from '../lib/types.js'
import { PluginUiView } from './PluginUiView.js'
import { buildMicroActionInput, isActionOnlyActionSpec, microActionPluginId } from '../conversation/action-model.js'

export interface PluginMicroActionProps {
  action: QualifiedUiSpec<ConversationActionSpec>
  /** 渲染形态：toolbar=顶栏图标按钮；menu=下拉菜单项；hover=消息悬停栏图标按钮。 */
  variant: 'toolbar' | 'menu' | 'hover'
  /** 实际会话上下文（载荷与 PluginUiView conversationId 都用它，绝不取 spec 伪造值）。 */
  conversationId: number
  /** timeline.entry.action 场景的目标条目 ID（注入载荷 entryId）。 */
  entryId?: string
  /** PluginUiView 协议标准 Props（如 timeline.entry.action 的 { conversationId, entry }）。 */
  slotProps?: Record<string, unknown>
  /** 点击后回调（如关闭所在菜单）。 */
  onInvoked?: () => void
}

export function PluginMicroAction({
  action,
  variant,
  conversationId,
  entryId,
  slotProps,
  onInvoked,
}: PluginMicroActionProps): ReactNode {
  const store = useHelmStore()
  const [pending, setPending] = useState(false)
  const spec = action.spec

  // 双轨内容：client/json 内联挂载（独立 ViewBoundary，与 action-only 互斥）。
  if (!isActionOnlyActionSpec(spec)) {
    return (
      <PluginUiView
        pluginId={action.pluginId}
        spec={spec}
        conversationId={conversationId}
        label={`微操作 ${spec.id}`}
        slotProps={slotProps}
      />
    )
  }

  const label = spec.label || spec.id
  const run = async (): Promise<void> => {
    if (pending || spec.actionId === undefined) return
    setPending(true)
    onInvoked?.()
    try {
      await store.invokePluginAction(
        microActionPluginId(spec, action.pluginId),
        spec.actionId,
        buildMicroActionInput(spec, { conversationId, entryId }),
        conversationId,
      )
      store.pushNotice({
        type: 'notification',
        level: 'info',
        title: `已执行：${label}`,
        conversationId,
      })
    } catch (err) {
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title: `执行失败：${label}`,
        body: err instanceof Error ? err.message : String(err),
        conversationId,
      })
    } finally {
      setPending(false)
    }
  }

  if (variant === 'menu') {
    return (
      <button
        type="button"
        className="popover-item"
        disabled={pending}
        title={label}
        onClick={(e) => {
          e.stopPropagation()
          void run()
        }}
      >
        <span className="pane-more-item-label">
          <HelmIcon name={pending ? 'loader' : (spec.icon ?? 'zap')} size={13} className={pending ? 'spin-slow' : undefined} />
          {label}
        </span>
      </button>
    )
  }

  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      title={label}
      aria-label={label}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation()
        void run()
      }}
    >
      <HelmIcon name={pending ? 'loader' : (spec.icon ?? 'zap')} size={12} className={pending ? 'spin-slow' : undefined} />
      {variant === 'toolbar' ? <span className="pane-action-label">{label}</span> : null}
    </button>
  )
}
