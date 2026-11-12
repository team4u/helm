import { isSameResolvedTarget, isPrototypeParamKey, SCREEN_PARAM_KEY_PATTERN, type ActiveModal, type ResolvedTarget } from './types.js'

/**
 * 地址栏 Hash 所表达的工作台位置：主屏目标、右分屏、工作台抽屉与顶层弹窗。
 * 本模块零 React / DOM 依赖，仅做纯函数编解码与对比，语法契约见 test/url-hash.test.ts。
 *
 * 路径树（层级化路由：子项一律是路径段，不再是查询参数）：
 * - `c/<id>`                                                     会话
 * - `a/<profileId>`                                              智能体待命页
 * - `views/<pluginId>/<screenId>`                                插件全屏视图
 * - `settings/profiles[/<profileId>]`                            角色中心
 * - `settings/models[/<providerId>|/defaults|/<providerId>/defaults]` 模型中心（defaults 为保留段 = 全局默认 Tab）
 * - `settings/skills[/<skillId>]`                                技能中心
 * - `settings/nodes[/<nodeId>]`                                  节点中心
 * - `settings/plugins[/<pluginId>]`                              插件中心
 */
export interface WorkspaceLocationState {
  primaryTarget: ResolvedTarget
  target?: ResolvedTarget
  splitTarget: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
}

/** 需要持久化进 URL 的弹窗（command-palette 是瞬态搜索框，排除在外）。 */
type PersistedModal = Exclude<ActiveModal, null | { kind: 'command-palette' }>

/**
 * 缺省主屏：智能体角色中心（无会话依赖，零会话/全部删除后仍可用；
 * 序列化为 `#/settings/profiles`；历史缺省 conversation:1 已随根会话特殊设计移除）。
 */
const DEFAULT_PRIMARY: ResolvedTarget = { kind: 'profiles' }
const DEFAULT_WORKBENCH_TAB = 'artifacts'

const MODAL_KIND_TO_KEY = {
  'profile-editor': 'profiles',
  'provider-auth': 'providers',
  'skill-viewer': 'skills',
  'plugin-settings': 'plugins',
  nodes: 'nodes',
  'artifact-preview': 'artifact',
  'conversation-drawer': 'drawer',
} as const

const MODAL_KEY_TO_KIND = {
  profiles: 'profile-editor',
  providers: 'provider-auth',
  skills: 'skill-viewer',
  plugins: 'plugin-settings',
  nodes: 'nodes',
  artifact: 'artifact-preview',
  drawer: 'conversation-drawer',
} as const

/** 路径段只保留冒号可读；段内的斜杠必须编码，不能与目标分隔符混淆。 */
const encodeSegment = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ':')

/** 解码单个路径/参数段；空串与非法百分号序列按边界防御视为无效（返回 null）。 */
const decodeSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value)
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
}

/** 仅接受十进制正整数（无空格、小数、科学计数法），杜绝 NaN 与 0/负数会话 ID。 */
const parsePositiveInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

/** 主屏 / 分屏 Screen 参数在 Hash 查询串中的命名空间前缀（互不冲突）。 */
export const PRIMARY_SCREEN_PARAM_PREFIX = 'sp.'
export const SPLIT_SCREEN_PARAM_PREFIX = 'ssp.'

/** agent 目标草稿环境在 Hash 查询串中的参数名（主屏顶层与 split 内各一套，作用域互不重叠）。 */
const AGENT_NODE_PARAM = 'node'
const AGENT_CWD_PARAM = 'cwd'

/** 从查询串提取 agent 草稿环境（仅非空值生效；空串视为未设置）。 */
function extractAgentEnv(params: URLSearchParams): { nodeId?: string; cwd?: string } {
  const node = params.get(AGENT_NODE_PARAM)
  const cwd = params.get(AGENT_CWD_PARAM)
  return {
    ...(node !== null && node !== '' ? { nodeId: node } : {}),
    ...(cwd !== null && cwd !== '' ? { cwd } : {}),
  }
}

/** 仅在确实携带环境参数时才挂字段，保持无环境 agent 目标的形状稳定。 */
function applyAgentEnv(
  target: { kind: 'agent'; profileId: string },
  env: { nodeId?: string; cwd?: string },
): ResolvedTarget {
  return env.nodeId === undefined && env.cwd === undefined ? target : { ...target, ...env }
}

/** agent 目标的环境参数序列化（字典序稳定；由 URLSearchParams 统一转义）。 */
function formatAgentEnvParams(target: ResolvedTarget): Array<[string, string]> {
  if (target.kind !== 'agent') return []
  const pairs: Array<[string, string]> = []
  if (target.nodeId !== undefined && target.nodeId !== '') pairs.push([AGENT_NODE_PARAM, target.nodeId])
  if (target.cwd !== undefined && target.cwd !== '') pairs.push([AGENT_CWD_PARAM, target.cwd])
  return pairs
}

/** 严格解析单个 `sp.<k>=<v>` / `ssp.<k>=<v>` 参数：非法键 / 空值 / 非法编码返回 null。 */
function parseNamespacedParam(
  rawKey: string,
  rawValue: string,
  prefix: string,
): { key: string; value: string } | null {
  if (!rawKey.startsWith(prefix)) return null
  const key = rawKey.slice(prefix.length)
  if (key === '' || !SCREEN_PARAM_KEY_PATTERN.test(key) || isPrototypeParamKey(key)) return null
  if (rawValue === '') return null
  try {
    const value = decodeURIComponent(rawValue)
    return value === '' ? null : { key, value }
  } catch {
    return null
  }
}

/** 从查询串提取命名空间 Screen 参数；非法项与重复键丢弃（静默防入侵）。 */
function extractScreenParams(
  params: URLSearchParams,
  prefix: string,
): Record<string, string> | undefined {
  const candidates = new Map<string, { key: string; value: string } | null>()
  const duplicates = new Set<string>()
  for (const [rawKey, rawValue] of params) {
    if (candidates.has(rawKey)) {
      duplicates.add(rawKey)
      continue
    }
    candidates.set(rawKey, parseNamespacedParam(rawKey, rawValue, prefix))
  }
  const result: Record<string, string> = {}
  for (const [rawKey, parsed] of candidates) {
    if (duplicates.has(rawKey) || parsed === null) continue
    result[parsed.key] = parsed.value
  }
  return Object.keys(result).length === 0 ? undefined : result
}

/** 字典序序列化 Screen 参数（编码后由 URLSearchParams 统一转义）。 */
function formatScreenParams(
  target: ResolvedTarget,
  prefix: string,
): Array<[string, string]> {
  if (target.kind !== 'screen' || target.params === undefined) return []
  return Object.keys(target.params)
    .filter((key) => SCREEN_PARAM_KEY_PATTERN.test(key) && !isPrototypeParamKey(key) && target.params![key] !== '')
    .sort()
    .map((key) => [`${prefix}${key}`, target.params![key]] as [string, string])
}

/**
 * 解析单个 canonical 目标路径（主屏路径与 split 值的路径部分共用）。
 * 先按裸斜杠切分层级，再逐段解码——段内编码后的斜杠（%2F）不会破坏层级；
 * 多余层级 / 空段 / 非法编码一律整体判无效（返回 null），不静默取前段。
 */
function parseTargetValue(raw: string): ResolvedTarget | null {
  if (raw.startsWith('c/')) {
    const conversationId = parsePositiveInt(raw.slice(2))
    return conversationId === null ? null : { kind: 'conversation', conversationId }
  }
  if (raw.startsWith('a/')) {
    const rest = raw.slice(2)
    // profileId 编码后不含裸斜杠；多余斜杠判非法，不静默取前段。
    if (rest === '' || rest.includes('/')) return null
    const profileId = decodeSegment(rest)
    if (profileId === null) return null
    return { kind: 'agent', profileId }
  }
  if (raw.startsWith('views/')) {
    const rest = raw.slice('views/'.length)
    const slashIdx = rest.indexOf('/')
    if (slashIdx <= 0 || slashIdx === rest.length - 1 || rest.indexOf('/', slashIdx + 1) !== -1) return null
    const pluginId = decodeSegment(rest.slice(0, slashIdx))
    const screenId = decodeSegment(rest.slice(slashIdx + 1))
    if (pluginId === null || screenId === null) return null
    return { kind: 'screen', pluginId, screenId }
  }
  if (raw.startsWith('settings/')) {
    const rest = raw.slice('settings/'.length)
    if (rest === '') return null
    const slashIdx = rest.indexOf('/')
    const center = slashIdx === -1 ? rest : rest.slice(0, slashIdx)
    if (slashIdx === -1) {
      // 中心列表页（无子项）
      if (center === 'profiles') return { kind: 'profiles' }
      if (center === 'models') return { kind: 'models' }
      if (center === 'skills') return { kind: 'skills' }
      if (center === 'nodes') return { kind: 'nodes' }
      if (center === 'plugins') return { kind: 'plugins' }
      return null
    }
    const sub = rest.slice(slashIdx + 1)
    if (center === 'models') return parseModelsSubTarget(sub)
    // 单子项中心：恰好一个路径段
    if (sub === '' || sub.includes('/')) return null
    const subId = decodeSegment(sub)
    if (subId === null) return null
    if (center === 'profiles') return { kind: 'profiles', profileId: subId }
    if (center === 'skills') return { kind: 'skills', skillId: subId }
    if (center === 'nodes') return { kind: 'nodes', nodeId: subId }
    if (center === 'plugins') return { kind: 'plugins', pluginId: subId }
    return null
  }
  return null
}

/**
 * 解析 models 中心子路径：`defaults` | `<providerId>` | `<providerId>/defaults`。
 * `defaults` 是保留段（全局默认 Tab，历史虚拟卡片语义延续），不当作 providerId；
 * `<providerId>/defaults` 表达「供应商抽屉 + 全局默认 Tab」组合（分屏打开供应商时保留当前 Tab）。
 */
function parseModelsSubTarget(sub: string): ResolvedTarget | null {
  const slashIdx = sub.indexOf('/')
  const first = slashIdx === -1 ? sub : sub.slice(0, slashIdx)
  if (first === '') return null
  if (first === 'defaults') {
    return slashIdx === -1 ? { kind: 'models', tab: 'defaults' } : null
  }
  const providerId = decodeSegment(first)
  if (providerId === null) return null
  if (slashIdx === -1) return { kind: 'models', providerId }
  if (sub.slice(slashIdx + 1) !== 'defaults') return null
  return { kind: 'models', providerId, tab: 'defaults' }
}

function formatTargetValue(target: ResolvedTarget): string {
  if (target.kind === 'conversation') return `c/${target.conversationId}`
  if (target.kind === 'agent') return `a/${encodeSegment(target.profileId)}`
  if (target.kind === 'screen') return `views/${encodeSegment(target.pluginId)}/${encodeSegment(target.screenId)}`
  if (target.kind === 'plugins') {
    return target.pluginId === undefined || target.pluginId === '' ? 'settings/plugins' : `settings/plugins/${encodeSegment(target.pluginId)}`
  }
  if (target.kind === 'profiles') {
    return target.profileId === undefined || target.profileId === '' ? 'settings/profiles' : `settings/profiles/${encodeSegment(target.profileId)}`
  }
  if (target.kind === 'skills') {
    return target.skillId === undefined || target.skillId === '' ? 'settings/skills' : `settings/skills/${encodeSegment(target.skillId)}`
  }
  if (target.kind === 'nodes') {
    return target.nodeId === undefined || target.nodeId === '' ? 'settings/nodes' : `settings/nodes/${encodeSegment(target.nodeId)}`
  }
  if (target.kind === 'models') {
    const parts = ['settings/models']
    // `defaults` 是保留段，不作为 providerId 序列化（providers 为缺省 Tab，不序列化）
    if (target.providerId !== undefined && target.providerId !== '' && target.providerId !== 'defaults') {
      parts.push(encodeSegment(target.providerId))
    }
    if (target.tab === 'defaults') parts.push('defaults')
    return parts.join('/')
  }
  return ''
}

/**
 * 解析 split 值：与主屏共用同一套 canonical 目标路径（含 settings/views 层级与中心子项路径段）；
 * 仅 agent 目标可在路径后再携带内嵌查询串 `?node=&cwd=`（中心子项与 Tab 已收进路径段，
 * screen 参数始终在顶层 ssp.* 命名空间，均不再经 split 内查询传递）。
 */
function parseSplitTargetValue(raw: string): ResolvedTarget | null {
  const queryIdx = raw.indexOf('?')
  const path = queryIdx === -1 ? raw : raw.slice(0, queryIdx)
  const baseTarget = parseTargetValue(path)
  if (baseTarget === null) return null
  if (queryIdx === -1) return baseTarget
  if (baseTarget.kind !== 'agent') return baseTarget
  const params = new URLSearchParams(raw.slice(queryIdx + 1))
  return applyAgentEnv(baseTarget, extractAgentEnv(params))
}

function formatSplitTarget(target: ResolvedTarget): string {
  const base = formatTargetValue(target)
  const agentEnv = formatAgentEnvParams(target)
  if (agentEnv.length === 0) return base
  const env = new URLSearchParams(agentEnv).toString()
  return `${base}?${env}`
}

/** 列表型弹窗的子项 ID（profileId / skillId / pluginId / nodeId）或抽屉会话 ID。 */
const modalSubId = (modal: PersistedModal): string | undefined => {
  switch (modal.kind) {
    case 'profile-editor': return modal.profileId
    case 'skill-viewer': return modal.skillId
    case 'plugin-settings': return modal.pluginId
    case 'nodes': return modal.nodeId
    case 'conversation-drawer': return String(modal.conversationId)
    default: return undefined
  }
}

function parseActiveModal(params: URLSearchParams): ActiveModal {
  const key = params.get('modal')
  if (key === null || key === '') return null
  if (!Object.hasOwn(MODAL_KEY_TO_KIND, key)) return null
  const kind = MODAL_KEY_TO_KIND[key as keyof typeof MODAL_KEY_TO_KIND]
  const id = params.get('id')
  const subId = id !== null && id !== '' ? id : undefined
  switch (kind) {
    case 'provider-auth':
      return { kind: 'provider-auth' }
    case 'artifact-preview':
      // artifact 深链的 id 必填：缺失视为无效弹窗。
      if (subId === undefined) return null
      const conversationId = parsePositiveInt(params.get('conv') ?? '')
      return conversationId === null
        ? { kind: 'artifact-preview', artifactId: subId }
        : { kind: 'artifact-preview', artifactId: subId, conversationId }
    case 'profile-editor':
      return subId === undefined ? { kind: 'profile-editor' } : { kind: 'profile-editor', profileId: subId }
    case 'skill-viewer':
      return subId === undefined ? { kind: 'skill-viewer' } : { kind: 'skill-viewer', skillId: subId }
    case 'plugin-settings':
      return subId === undefined ? { kind: 'plugin-settings' } : { kind: 'plugin-settings', pluginId: subId }
    case 'nodes':
      return subId === undefined ? { kind: 'nodes' } : { kind: 'nodes', nodeId: subId }
    case 'conversation-drawer': {
      if (subId === undefined) return null
      const convId = parsePositiveInt(subId)
      return convId === null ? null : { kind: 'conversation-drawer', conversationId: convId }
    }
  }
}

/**
 * 解析 `#/path?searchParams` 形式的 Hash。所有非法段（含全部旧路径形态）均回退默认
 * （角色中心 `#/settings/profiles` / 无分屏 / 工作台关闭 / 无弹窗），绝不抛出或产生 NaN。
 */
export function parseLocationHash(rawHash: string): WorkspaceLocationState {
  const raw = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  const queryIdx = raw.indexOf('?')
  const path = (queryIdx === -1 ? raw : raw.slice(0, queryIdx)).replace(/^\/+/, '').replace(/\/+$/, '')
  const params = new URLSearchParams(queryIdx === -1 ? '' : raw.slice(queryIdx + 1))
  const splitRaw = params.get('split')
  const workbenchTab = params.get('wb')
  let primaryTarget = parseTargetValue(path) ?? DEFAULT_PRIMARY
  // agent 待命主屏的草稿环境来自顶层 node/cwd 参数（split 内 agent 环境编码在 split 值内部）。
  if (primaryTarget.kind === 'agent') {
    primaryTarget = applyAgentEnv(primaryTarget, extractAgentEnv(params))
  }
  const splitTarget = splitRaw === null || splitRaw === '' ? null : parseSplitTargetValue(splitRaw)

  const state: WorkspaceLocationState = {
    primaryTarget:
      primaryTarget.kind === 'screen'
        ? applyScreenParams(primaryTarget, extractScreenParams(params, PRIMARY_SCREEN_PARAM_PREFIX))
        : primaryTarget,
    splitTarget:
      splitTarget !== null && splitTarget.kind === 'screen'
        ? applyScreenParams(splitTarget, extractScreenParams(params, SPLIT_SCREEN_PARAM_PREFIX))
        : splitTarget,
    workbenchOpen: params.has('wb'),
    workbenchTab: workbenchTab !== null && workbenchTab !== '' ? workbenchTab : DEFAULT_WORKBENCH_TAB,
    activeModal: parseActiveModal(params),
  }
  Object.defineProperty(state, 'target', {
    get() {
      return this.primaryTarget
    },
    enumerable: false,
    configurable: true,
  })
  return state
}

/** 仅在确实存在合法参数时才挂 params 字段，保持无参数 screen 目标的形状稳定。 */
function applyScreenParams(
  target: { kind: 'screen'; pluginId: string; screenId: string },
  params: Record<string, string> | undefined,
): ResolvedTarget {
  return params === undefined ? target : { ...target, params }
}

/** 始终返回以 `#/` 开头的规范形式；默认态输出 `#/settings/profiles`，command-palette 不序列化。 */
export function formatLocationHash(state: WorkspaceLocationState): string {
  const query: Array<[string, string]> = []
  // agent 待命目标的草稿环境（node/cwd）序列化到主屏顶层命名空间；分屏在 split 串内自带。
  query.push(...formatAgentEnvParams(state.primaryTarget))
  if (state.splitTarget !== null) query.push(['split', formatSplitTarget(state.splitTarget)])
  // 主/分屏 Screen 参数各占 sp.* / ssp.* 命名空间：同一 screen 双开时参数互不串扰。
  query.push(...formatScreenParams(state.primaryTarget, PRIMARY_SCREEN_PARAM_PREFIX))
  if (state.splitTarget !== null) query.push(...formatScreenParams(state.splitTarget, SPLIT_SCREEN_PARAM_PREFIX))
  if (state.workbenchOpen) {
    query.push(['wb', state.workbenchTab === '' ? DEFAULT_WORKBENCH_TAB : state.workbenchTab])
  }
  const modal = state.activeModal
  if (modal !== null && modal.kind !== 'command-palette') {
    query.push(['modal', MODAL_KIND_TO_KEY[modal.kind]])
    if (modal.kind === 'artifact-preview') {
      query.push(['id', modal.artifactId])
      if (modal.conversationId !== undefined && Number.isSafeInteger(modal.conversationId) && modal.conversationId > 0) {
        query.push(['conv', String(modal.conversationId)])
      }
    } else {
      const subId = modalSubId(modal)
      if (subId !== undefined && subId !== '') query.push(['id', subId])
    }
  }
  const search = new URLSearchParams(query).toString()
  return `#/${formatTargetValue(state.primaryTarget)}${search === '' ? '' : `?${search}`}`
}

/** command-palette 是瞬态弹窗，不参与位置比较（与不入 URL 的契约一致）。 */
const normalizeModal = (modal: ActiveModal): PersistedModal | null =>
  modal === null || modal.kind === 'command-palette' ? null : modal

/** 逐一对比位置字段；workbenchTab 仅在工作台打开时参与（关闭时只是记忆值，不在 URL 中）。 */
export function isSameLocationState(a: WorkspaceLocationState, b: WorkspaceLocationState): boolean {
  if (!isSameResolvedTarget(a.primaryTarget, b.primaryTarget)) return false
  if (!isSameResolvedTarget(a.splitTarget, b.splitTarget)) return false
  if (a.workbenchOpen !== b.workbenchOpen) return false
  if (a.workbenchOpen && a.workbenchTab !== b.workbenchTab) return false
  const modalA = normalizeModal(a.activeModal)
  const modalB = normalizeModal(b.activeModal)
  if ((modalA === null) !== (modalB === null)) return false
  if (modalA === null || modalB === null) return true
  if (modalA.kind !== modalB.kind) return false
  if (modalA.kind === 'artifact-preview' && modalB.kind === 'artifact-preview') {
    return modalA.artifactId === modalB.artifactId
      && (modalA.conversationId ?? undefined) === (modalB.conversationId ?? undefined)
  }
  return modalSubId(modalA) === modalSubId(modalB)
}

/** 同一 screen 坐标（kind/pluginId/screenId 相同）即视为同一位置；params 差异不算坐标变化。 */
const isSameScreenSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind !== 'screen' || b.kind !== 'screen') return false
  return a.pluginId === b.pluginId && a.screenId === b.screenId
}

/** 同一 agent 待命坐标（profileId 相同）视为同一位置槽位；仅草稿环境变化不算坐标级切屏。 */
const isSameAgentSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind !== 'agent' || b.kind !== 'agent') return false
  return a.profileId === b.profileId
}

/** 同一中心坐标（kind 均为对应的一级全屏中心）视为同一主舞台位置槽位；drawer 切换或关闭不算坐标级切屏。 */
const isSamePrimaryCenterSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind === 'plugins' && b.kind === 'plugins') return true
  if (a.kind === 'profiles' && b.kind === 'profiles') return true
  if (a.kind === 'skills' && b.kind === 'skills') return true
  if (a.kind === 'nodes' && b.kind === 'nodes') return true
  if (a.kind === 'models' && b.kind === 'models') return true
  return false
}

/** 主/分屏位置是否发生坐标级变化（会话 ID 变化、agent 坐标变化、screen 坐标变化、视图类型变化、开/关分屏）。 */
const isTargetSlotChanged = (prev: ResolvedTarget | null, next: ResolvedTarget | null): boolean =>
  !isSameResolvedTarget(prev, next) && !isSameScreenSlot(prev, next) && !isSameAgentSlot(prev, next) && !isSamePrimaryCenterSlot(prev, next)

/**
 * 判断状态迁移是否值得入历史栈（pushState）：
 * - 主屏、分屏、工作台开关、弹窗开关或弹窗类型变化 → push（前进/后退可还原）；
 * - 同一 screen 目标仅 params 变化、或同一 agent 待命目标仅草稿环境（node/cwd）变化 → replace，
 *   避免筛选器/环境调整每次按键污染后退栈，需要入栈时由调用方显式强制；
 * - 产物预览切换不同 artifactId → push（每个预览是可独立直达的视图）；
 * - 同一列表型弹窗内仅切换子项、或工作台已打开时仅切 Tab → replace
 *   （避免弹窗内点选 10 项后要后退 10 次才能关掉弹窗）。
 */
export function shouldPushLocationHistory(prev: WorkspaceLocationState, next: WorkspaceLocationState): boolean {
  const isOpeningDrawer = (prevT: ResolvedTarget, nextT: ResolvedTarget): boolean => {
    if (prevT.kind === 'plugins' && nextT.kind === 'plugins') {
      return prevT.pluginId === undefined && nextT.pluginId !== undefined
    }
    if (prevT.kind === 'profiles' && nextT.kind === 'profiles') {
      return prevT.profileId === undefined && nextT.profileId !== undefined
    }
    if (prevT.kind === 'skills' && nextT.kind === 'skills') {
      return prevT.skillId === undefined && nextT.skillId !== undefined
    }
    if (prevT.kind === 'nodes' && nextT.kind === 'nodes') {
      return prevT.nodeId === undefined && nextT.nodeId !== undefined
    }
    if (prevT.kind === 'models' && nextT.kind === 'models') {
      return prevT.providerId === undefined && nextT.providerId !== undefined
    }
    return false
  }

  // 从列表打开任一中心的抽屉（无 ID -> 有 ID）入栈（push），支持浏览器后退关闭抽屉
  if (isOpeningDrawer(prev.primaryTarget, next.primaryTarget)) {
    return true
  }
  // 仅 params 变化（screen 坐标不变）或中心抽屉内切换/关闭 → replace，避免筛选器每次按键污染后退栈；
  // 需要入栈时由调用方（setScreenParams push 标记）显式强制。
  if (isTargetSlotChanged(prev.primaryTarget, next.primaryTarget)) return true
  if (isTargetSlotChanged(prev.splitTarget, next.splitTarget)) return true
  if (prev.workbenchOpen !== next.workbenchOpen) return true
  const prevModal = normalizeModal(prev.activeModal)
  const nextModal = normalizeModal(next.activeModal)
  if ((prevModal === null) !== (nextModal === null)) return true
  if (prevModal === null || nextModal === null) return false
  if (prevModal.kind !== nextModal.kind) return true
  if (prevModal.kind === 'artifact-preview' && nextModal.kind === 'artifact-preview') {
    return prevModal.artifactId !== nextModal.artifactId
      || (prevModal.conversationId ?? undefined) !== (nextModal.conversationId ?? undefined)
  }
  if (prevModal.kind === 'conversation-drawer' && nextModal.kind === 'conversation-drawer') {
    return prevModal.conversationId !== nextModal.conversationId
  }
  return false
}

export type HashSerializable =
  | WorkspaceLocationState
  | { target: ResolvedTarget; splitTarget?: ResolvedTarget | null; workbenchOpen?: boolean; workbenchTab?: string; activeModal?: ActiveModal }
  | { primaryTarget: ResolvedTarget; splitTarget?: ResolvedTarget | null; workbenchOpen?: boolean; workbenchTab?: string; activeModal?: ActiveModal }
  | ResolvedTarget

/**
 * 序列化 Hash 契约辅助函数。
 * 兼容接收 WorkspaceLocationState、携带 target/primaryTarget 的局部对象、或直接输入 ResolvedTarget。
 */
export function serializeHash(input: HashSerializable): string {
  if (
    'kind' in input &&
    (input.kind === 'conversation' ||
      input.kind === 'agent' ||
      input.kind === 'screen' ||
      input.kind === 'plugins' ||
      input.kind === 'profiles' ||
      input.kind === 'skills' ||
      input.kind === 'nodes' ||
      input.kind === 'models')
  ) {
    return formatLocationHash({
      primaryTarget: input,
      splitTarget: null,
      workbenchOpen: false,
      workbenchTab: DEFAULT_WORKBENCH_TAB,
      activeModal: null,
    })
  }
  const primaryTarget: ResolvedTarget =
    'primaryTarget' in input
      ? input.primaryTarget
      : 'target' in input
        ? input.target
        : DEFAULT_PRIMARY

  return formatLocationHash({
    primaryTarget,
    splitTarget: input.splitTarget ?? null,
    workbenchOpen: input.workbenchOpen ?? false,
    workbenchTab: input.workbenchTab ?? DEFAULT_WORKBENCH_TAB,
    activeModal: input.activeModal ?? null,
  })
}

/** 反向解析 Hash 契约辅助别名，指向 parseLocationHash。 */
export const parseHash = parseLocationHash

/**
 * 历史旧弹窗参数平滑升级守卫：
 * 当 URL 携带旧的 modal=profiles|skills|nodes|providers|plugins 时，
 * 自动升格为对应的一级全屏中心路由（primaryTarget），并销毁旧 modal。
 */
export function upgradeLegacyLocationState(state: WorkspaceLocationState): WorkspaceLocationState {
  if (state.activeModal !== null) {
    if (state.activeModal.kind === 'profile-editor') {
      return {
        ...state,
        primaryTarget: { kind: 'profiles', profileId: state.activeModal.profileId },
        activeModal: null,
      }
    }
    if (state.activeModal.kind === 'skill-viewer') {
      return {
        ...state,
        primaryTarget: { kind: 'skills', skillId: state.activeModal.skillId },
        activeModal: null,
      }
    }
    if (state.activeModal.kind === 'nodes') {
      return {
        ...state,
        primaryTarget: { kind: 'nodes', nodeId: state.activeModal.nodeId },
        activeModal: null,
      }
    }
    if (state.activeModal.kind === 'provider-auth') {
      return {
        ...state,
        primaryTarget: { kind: 'models' },
        activeModal: null,
      }
    }
    if (state.activeModal.kind === 'plugin-settings') {
      return {
        ...state,
        primaryTarget: { kind: 'plugins', pluginId: state.activeModal.pluginId },
        activeModal: null,
      }
    }
  }
  return state
}
