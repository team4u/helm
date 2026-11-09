/**
 * <PluginSlot />：插件间子插槽（plugin.slot 贡献）的渲染原语（P3）。
 *
 * - name 为本插件内部短名时自动拼接 `<ctx.pluginId>/<name>`；含 '/' 视为显式
 *   全限定名（'<ownerPluginId>/<slotName>'）；
 * - 从 store.groupedUi.pluginSlots 查找 target === 全限定名且命中当前会话
 *   scope 的贡献项，按 priority 降序、order 升序稳定排序（同分保持贡献顺序）；
 * - 每项独立 <PluginUiView />（自带 ViewBoundary），子项上下文的 pluginId
 *   是贡献者插件而非 owner；
 * - 环保护：SlotAncestryContext 记录渲染链上的 (贡献者插件, 贡献项 id)，
 *   同一项再次出现时显式渲染环告警并终止递归；同时限制最大嵌套深度。
 *
 * 本文件只导出组件（保 Fast Refresh）；排序与匹配纯函数在 plugin-slot-model.ts。
 */
import { createContext, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import type { ConversationSummary, PluginSlotContributionSpec } from '@helm/protocol'
import { HelmIcon } from '../lib/icons.js'
import { PluginClientContext } from '../lib/plugin-client-context.js'
import { useHelmStore } from '../lib/store-context.js'
import { matchesUiScope, type QualifiedUiSpec } from '../lib/types.js'
import { PluginUiView } from './PluginUiView.js'
import { collectSlotItems } from './plugin-slot-model.js'

export interface PluginSlotProps {
  /** 本插件内部子插槽短名（自动拼接 ctx.pluginId 前缀）；含 '/' 为显式全限定名。 */
  name: string
  /** 传递给子插槽贡献项的上下文数据（注入子组件 props 与声明式 $data）。 */
  slotProps?: Record<string, unknown>
  /** 'list' 渲染全部命中项（默认）；'single' 仅渲染排序后首项。 */
  mode?: 'list' | 'single'
  /** 无任何插件注入时的回退内容。 */
  fallback?: ReactNode
  className?: string
  /** 声明式轨道等无 PluginClientContext 的场景：显式提供 owner 插件与会话。 */
  ownerPluginId?: string
  conversationId?: number
}

/** 渲染链祖先记录：环检测用（同一贡献项再次出现即环）。 */
interface SlotAncestry {
  chain: ReadonlyArray<readonly [contributorPluginId: string, contributionId: string]>
  depth: number
}

const SlotAncestryContext = createContext<SlotAncestry>({ chain: [], depth: 0 })

/** 防御性最大嵌套深度（即使贡献链不构成环，也限制无限嵌套炸栈）。 */
const MAX_SLOT_DEPTH = 16

export function PluginSlot(props: PluginSlotProps): ReactNode {
  const { name, slotProps, mode = 'list', fallback, className, ownerPluginId, conversationId: explicitConversationId } = props
  const clientCtx = useContext(PluginClientContext)
  const store = useHelmStore()
  const owner = ownerPluginId ?? clientCtx?.pluginId
  const conversationId = explicitConversationId ?? clientCtx?.conversationId
  const ancestry = useContext(SlotAncestryContext)

  if (owner === undefined) {
    return (
      <div className="jr-callout jr-callout-warn">
        <HelmIcon name="alert-triangle" size={13} />
        <span>PluginSlot 无宿主插件上下文（需在 PluginUiView 内使用或显式传 ownerPluginId）</span>
      </div>
    )
  }

  const qualified = name.includes('/') ? name : `${owner}/${name}`
  const conversation: ConversationSummary | undefined = conversationId !== undefined
    ? store.conversations.find((c) => c.id === conversationId)
    : undefined

  const items = useMemo(
    () => collectSlotItems(store.groupedUi.pluginSlots, qualified, (scope) => matchesUiScope(conversation, scope)),
    [store.groupedUi.pluginSlots, qualified, conversation],
  )
  const visible = mode === 'single' ? items.slice(0, 1) : items

  if (visible.length === 0) return fallback !== undefined ? <>{fallback}</> : null

  if (ancestry.depth >= MAX_SLOT_DEPTH) {
    return (
      <div className="jr-callout jr-callout-warn" role="alert">
        <HelmIcon name="alert-triangle" size={13} />
        <span>插件子插槽嵌套超过最大深度 {MAX_SLOT_DEPTH}，已终止渲染</span>
      </div>
    )
  }

  return (
    <div className={className}>
      {visible.map((item) => {
        const key = `${item.pluginId}/${item.spec.id}`
        if (ancestry.chain.some(([pid, cid]) => pid === item.pluginId && cid === item.spec.id)) {
          return (
            <div className="jr-callout jr-callout-warn" role="alert" key={key}>
              <HelmIcon name="alert-triangle" size={13} />
              <span>插件子插槽循环嵌套（{key}），已终止递归</span>
            </div>
          )
        }
        return (
          <SlotAncestryContext.Provider
            key={key}
            value={{ chain: [...ancestry.chain, [item.pluginId, item.spec.id] as const], depth: ancestry.depth + 1 }}
          >
            <PluginUiView
              pluginId={item.pluginId}
              spec={item.spec}
              slotProps={slotProps}
              conversationId={conversationId}
              label={`插槽 ${qualified}/${item.spec.id}`}
            />
          </SlotAncestryContext.Provider>
        )
      })}
    </div>
  )
}
