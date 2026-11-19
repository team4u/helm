/**
 * <PluginSlot />: rendering primitive for inter-plugin child slots (plugin.slot contributions).
 *
 * - A name that is a short internal slot name of this plugin is automatically
 *   prefixed as `<ctx.pluginId>/<name>`; a name containing '/' is treated as an
 *   explicit fully qualified name ('<ownerPluginId>/<slotName>');
 * - Contribution matching/sorting and rendering of a single contribution (host
 *   PluginUiView) are injected via the host port; the pluginId of the child
 *   context is the contributing plugin, not the owner;
 * - Cycle protection runs inside this component: SlotAncestryContext records
 *   the (contributing plugin, contribution id) pairs along the render chain;
 *   when the same item reappears, an explicit cycle warning is rendered and
 *   recursion stops; a maximum nesting depth is also enforced.
 *
 * This file only exports components and TS types (same Fast Refresh contract).
 */
import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { ComposerController } from '@helmx/protocol/browser'
import { HelmxIcon } from './icons.js'
import { usePluginClientHost } from './host-port.js'
import { PluginClientContext } from './plugin-context.js'

export interface PluginSlotProps {
  /** Short internal slot name of this plugin (auto-prefixed with ctx.pluginId); containing '/' means an explicit fully qualified name. */
  name: string
  /** Context data passed to slot contributions (injected into child props and declarative $data). */
  slotProps?: Record<string, unknown>
  /** 'list' renders all matches (default);'single' renders only the first item after sorting. */
  mode?: 'list' | 'single'
  /** Fallback content when no plugin contributes anything. */
  fallback?: ReactNode
  className?: string
  /** For scenarios without a PluginClientContext such as the declarative track: explicitly provide the owner plugin and conversation. */
  ownerPluginId?: string
  conversationId?: number
  /** Explicitly provided by the host when mounting the slot in the composer area (injected into child
   * usePluginContext().composer); inside plugin components, the composer of the surrounding context is used by default. */
  composer?: ComposerController
}

/** Ancestry record along the render chain: for cycle detection (the same contribution reappearing means a cycle). */
interface SlotAncestry {
  chain: ReadonlyArray<readonly [contributorPluginId: string, contributionId: string]>
  depth: number
}

const SlotAncestryContext = createContext<SlotAncestry>({ chain: [], depth: 0 })

/** Defensive maximum nesting depth (limits stack-blowing infinite nesting even when the contribution chain is not a cycle). */
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
        <HelmxIcon name="alert-triangle" size={13} />
        <span>PluginSlot has no host plugin context (use it inside PluginUiView or pass ownerPluginId explicitly)</span>
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
        <HelmxIcon name="alert-triangle" size={13} />
        <span>Plugin slot nesting exceeded the maximum depth of {MAX_SLOT_DEPTH}; rendering aborted</span>
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
              <HelmxIcon name="alert-triangle" size={13} />
              <span>Plugin slot cycle detected ({key}); recursion aborted</span>
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
              label: `Slot ${qualified}/${item.contributionId}`,
            })}
          </SlotAncestryContext.Provider>
        )
      })}
    </div>
  )
}
