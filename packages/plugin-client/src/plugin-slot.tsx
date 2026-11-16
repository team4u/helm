/**
 * <PluginSlot />：插件间子插槽（plugin.slot 贡献）的渲染原语。
 *
 * - name 为本插件内部短名时自动拼接 `<ctx.pluginId>/<name>`；含 '/' 视为显式
 *   全限定名（'<ownerPluginId>/<slotName>'）；
 * - 贡献项匹配与排序、单个贡献项渲染（宿主 PluginUiView）经宿主端口注入；
 *   子项上下文的 pluginId 是贡献者插件而非 owner；
 * - 环保护在本组件内执行：SlotAncestryContext 记录渲染链上的
 *   (贡献者插件, 贡献项 id)，同一项再次出现时显式渲染环告警并终止递归；
 *   同时限制最大嵌套深度。
 *
 * 本文件只导出组件与 TS 类型（Fast Refresh 契约同源）。
 */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ComposerController } from '@helm/protocol/browser'
import { HelmIcon } from './icons.js'
import { usePluginClientHost } from './host-port.js'
import { PluginClientContext } from './plugin-context.js'

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
  /** 宿主在输入区挂载插槽时显式提供输入控制器（注入子项 usePluginContext().composer）；
   * 插件组件内缺省沿用自身上下文的 composer。 */
  composer?: ComposerController
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
  const { name, slotProps, mode = 'list', fallback, className, ownerPluginId, conversationId: explicitConversationId, composer: explicitComposer } = props
  const clientCtx = useContext(PluginClientContext)
  const host = usePluginClientHost()
  const owner = ownerPluginId ?? clientCtx?.pluginId
  const conversationId = explicitConversationId ?? clientCtx?.conversationId
  const composer = explicitComposer ?? clientCtx?.composer
  const ancestry = useContext(SlotAncestryContext)

  if (owner === undefined) {
    return (
      <div className="callout callout--warning">
        <HelmIcon name="alert-triangle" size={13} />
        <span>PluginSlot 无宿主插件上下文（需在 PluginUiView 内使用或显式传 ownerPluginId）</span>
      </div>
    )
  }

  const qualified = name.includes('/') ? name : `${owner}/${name}`
  const items = host.slots.collectItems(qualified, conversationId)
  const visible = mode === 'single' ? items.slice(0, 1) : items

  if (visible.length === 0) return fallback !== undefined ? <>{fallback}</> : null

  if (ancestry.depth >= MAX_SLOT_DEPTH) {
    return (
      <div className="callout callout--warning" role="alert">
        <HelmIcon name="alert-triangle" size={13} />
        <span>插件子插槽嵌套超过最大深度 {MAX_SLOT_DEPTH}，已终止渲染</span>
      </div>
    )
  }

  return (
    <div className={className}>
      {visible.map((item) => {
        const key = `${item.pluginId}/${item.contributionId}`
        if (ancestry.chain.some(([pid, cid]) => pid === item.pluginId && cid === item.contributionId)) {
          return (
            <div className="callout callout--warning" role="alert" key={key}>
              <HelmIcon name="alert-triangle" size={13} />
              <span>插件子插槽循环嵌套（{key}），已终止递归</span>
            </div>
          )
        }
        return (
          <SlotAncestryContext.Provider
            key={key}
            value={{ chain: [...ancestry.chain, [item.pluginId, item.contributionId] as const], depth: ancestry.depth + 1 }}
          >
            {host.slots.renderItem(item, {
              slotProps,
              conversationId,
              composer,
              label: `插槽 ${qualified}/${item.contributionId}`,
            })}
          </SlotAncestryContext.Provider>
        )
      })}
    </div>
  )
}
