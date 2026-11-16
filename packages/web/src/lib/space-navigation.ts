/**
 * 侧栏空间记忆判定、默认回跳目标、删除回退与 Screen 路由参数补丁纯函数（零 React 依赖）。
 */
import type { ConversationSummary, Profile } from '@helm/protocol/browser'
import { isConversationArchived } from '../conversation/archive-model.js'
import {
  isPrototypeParamKey,
  resolveTargetString,
  SCREEN_PARAM_KEY_PATTERN,
  spaceForTarget,
  type GroupedUiSpecs,
  type ResolvedTarget,
  type SidebarSpace,
} from './types.js'

/** openSpace 判定空间回跳目标时的实时快照输入。 */
export interface SpaceTargetInput {
  conversations: ConversationSummary[]
  profiles: Profile[]
  plugins: ReadonlyArray<{ id: string; enabled: boolean }>
  /** 静态资产是否已完成本轮加载（未加载完时无法证伪角色存在性，按可用放行）。 */
  assetsLoaded: boolean
  grouped: GroupedUiSpecs
}

/** 空间回跳目标当前是否仍可用：会话须在列表中；agent 待命须角色仍存在；
 * screen 须仍是启用插件的贡献；系统中心是宿主静态目标，恒可用。 */
export function isSpaceTargetAvailable(target: ResolvedTarget, input: SpaceTargetInput): boolean {
  switch (target.kind) {
    case 'conversation':
      return input.conversations.some((conv) => conv.id === target.conversationId)
    case 'agent':
      if (!input.assetsLoaded) return true
      return input.profiles.some((profile) => profile.id === target.profileId)
    case 'screen':
      return input.grouped.screens.some(
        (item) => item.pluginId === target.pluginId && item.spec.id === target.screenId,
      )
    default:
      return true
  }
}

/** 空间缺省目标（该空间尚无记忆时）：settings -> 角色中心；conversations -> 最新根会话
 * 所属智能体的待命入口（无会话时退到首个可用角色）；views -> 第一个可解析为 screen
 * 的侧栏项。找不到可用目标时返回 null，由调用方显式通知，绝不伪造不存在目标。 */
export function defaultSpaceTarget(space: SidebarSpace, input: SpaceTargetInput): ResolvedTarget | null {
  if (space === 'settings') return { kind: 'profiles' }
  if (space === 'views') {
    for (const item of input.grouped.sidebarItems) {
      if (!item.spec.target) continue
      const resolved = resolveTargetString(item.spec.target, input.conversations)
      if (resolved?.kind === 'screen') return resolved
    }
    return null
  }
  const agentUsable = (profileId: string): boolean =>
    !input.assetsLoaded || input.profiles.some((profile) => profile.id === profileId)
  const latestRoot = input.conversations
    .filter((conv) => conv.parentConversationId === undefined && !isConversationArchived(conv))
    .reduce<ConversationSummary | null>(
      (best, conv) =>
        best === null || conv.updatedAt > best.updatedAt || (conv.updatedAt === best.updatedAt && conv.id > best.id)
          ? conv
          : best,
      null,
    )
  if (latestRoot !== null && agentUsable(latestRoot.profileId)) {
    return { kind: 'agent', profileId: latestRoot.profileId }
  }
  const enabledPluginIds = new Set(input.plugins.filter((p) => p.enabled).map((p) => p.id))
  const visible = input.profiles.filter(
    (profile) => profile.managedByPlugin === undefined || enabledPluginIds.has(profile.managedByPlugin),
  )
  const preferred = visible.find((profile) => profile.humanSelectable !== false) ?? visible[0]
  return preferred === undefined ? null : { kind: 'agent', profileId: preferred.id }
}

export type SpaceSwitchResolution =
  | { kind: 'already-in-space' }
  | { kind: 'navigate'; target: ResolvedTarget; clearStaleMemory: boolean }
  | { kind: 'unavailable'; clearStaleMemory: boolean }

/** 解析点击 Activity Rail 空间时的目标决策：同空间 no-op；优先有效记忆；失效记忆标记清理并退到缺省。 */
export function resolveSpaceSwitch(
  space: SidebarSpace,
  currentPrimary: ResolvedTarget,
  memory: Partial<Record<SidebarSpace, ResolvedTarget>>,
  input: SpaceTargetInput,
): SpaceSwitchResolution {
  if (spaceForTarget(currentPrimary) === space) {
    return { kind: 'already-in-space' }
  }
  let clearStaleMemory = false
  const remembered = memory[space]
  if (remembered !== undefined) {
    if (isSpaceTargetAvailable(remembered, input)) {
      return { kind: 'navigate', target: remembered, clearStaleMemory: false }
    }
    clearStaleMemory = true
  }
  const fallback = defaultSpaceTarget(space, input)
  if (fallback === null) {
    return { kind: 'unavailable', clearStaleMemory }
  }
  return { kind: 'navigate', target: fallback, clearStaleMemory }
}

/**
 * 被删会话若正是当前主屏目标，回退到所属智能体待命态并继承远端节点与工作目录
 * （local 节点按 URL 契约省略；无会话摘要兜底回角色中心）。
 */
export function deletedConversationFallbackTarget(
  deletedSummary: Pick<ConversationSummary, 'profileId' | 'nodeId' | 'cwd'> | undefined,
): ResolvedTarget {
  if (deletedSummary === undefined) return { kind: 'profiles' }
  return {
    kind: 'agent',
    profileId: deletedSummary.profileId,
    ...(deletedSummary.nodeId !== undefined && deletedSummary.nodeId !== '' && deletedSummary.nodeId !== 'local'
      ? { nodeId: deletedSummary.nodeId }
      : {}),
    ...(deletedSummary.cwd !== undefined && deletedSummary.cwd !== '' ? { cwd: deletedSummary.cwd } : {}),
  }
}

export interface ScreenParamsPatchResult {
  validEntries: Array<[string, string | undefined]>
  invalidKeys: string[]
}

/** 校验并拆分 Screen 路由参数补丁，过滤非法键与原型保留键。 */
export function partitionScreenParamsPatch(
  patch: Record<string, string | undefined>,
): ScreenParamsPatchResult {
  const validEntries: Array<[string, string | undefined]> = []
  const invalidKeys: string[] = []
  for (const [key, value] of Object.entries(patch)) {
    if (SCREEN_PARAM_KEY_PATTERN.test(key) && !isPrototypeParamKey(key) && (value === undefined || typeof value === 'string')) {
      validEntries.push([key, value])
    } else {
      invalidKeys.push(key)
    }
  }
  return { validEntries, invalidKeys }
}

/** 将已校验的 Screen 路由参数补丁应用到目标（undefined 删除键，空串忽略）。 */
export function applyScreenParamsPatch(
  current: ResolvedTarget,
  validEntries: ReadonlyArray<[string, string | undefined]>,
): ResolvedTarget {
  if (current.kind !== 'screen') return current
  const next: Record<string, string> = { ...(current.params ?? {}) }
  for (const [rawKey, rawValue] of validEntries) {
    if (rawValue === undefined) delete next[rawKey]
    else if (rawValue !== '') next[rawKey] = rawValue
  }
  const params = Object.keys(next).length === 0 ? undefined : next
  return params === undefined
    ? { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId }
    : { kind: 'screen', pluginId: current.pluginId, screenId: current.screenId, params }
}
