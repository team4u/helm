import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import { isSameResolvedTarget, type ActiveModal, type ResolvedTarget } from './types.js'

/**
 * 地址栏 Hash 所表达的工作台位置：主屏目标、右分屏、工作台抽屉与顶层弹窗。
 * 本模块零 React / DOM 依赖，仅做纯函数编解码与对比，语法契约见 test/url-hash.test.ts。
 */
export interface WorkspaceLocationState {
  primaryTarget: ResolvedTarget
  splitTarget: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
}

/** 需要持久化进 URL 的弹窗（command-palette 是瞬态搜索框，排除在外）。 */
type PersistedModal = Exclude<ActiveModal, null | { kind: 'command-palette' }>

const DEFAULT_PRIMARY: ResolvedTarget = { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID }
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

/** 解析 `c/<id>` / `s/<pluginId>/<screenId>`；先切分路径，再分别解码，避免 ID 中的转义斜杠破坏结构。 */
function parseTargetValue(raw: string): ResolvedTarget | null {
  if (raw.startsWith('c/')) {
    const conversationId = parsePositiveInt(raw.slice(2))
    return conversationId === null ? null : { kind: 'conversation', conversationId }
  }
  if (raw.startsWith('s/')) {
    const rest = raw.slice(2)
    const slashIdx = rest.indexOf('/')
    if (slashIdx <= 0 || slashIdx === rest.length - 1 || rest.indexOf('/', slashIdx + 1) !== -1) return null
    const pluginId = decodeSegment(rest.slice(0, slashIdx))
    const screenId = decodeSegment(rest.slice(slashIdx + 1))
    if (pluginId === null || screenId === null) return null
    return { kind: 'screen', pluginId, screenId }
  }
  return null
}

function formatTargetValue(target: ResolvedTarget): string {
  if (target.kind === 'conversation') return `c/${target.conversationId}`
  return `s/${encodeSegment(target.pluginId)}/${encodeSegment(target.screenId)}`
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
 * 解析 `#/path?searchParams` 形式的 Hash。所有非法段均回退默认
 * （conversation:1 / 无分屏 / 工作台关闭 / 无弹窗），绝不抛出或产生 NaN。
 */
export function parseLocationHash(rawHash: string): WorkspaceLocationState {
  const raw = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  const queryIdx = raw.indexOf('?')
  const path = (queryIdx === -1 ? raw : raw.slice(0, queryIdx)).replace(/^\/+/, '')
  const params = new URLSearchParams(queryIdx === -1 ? '' : raw.slice(queryIdx + 1))
  const splitRaw = params.get('split')
  const workbenchTab = params.get('wb')
  return {
    primaryTarget: parseTargetValue(path) ?? DEFAULT_PRIMARY,
    splitTarget: splitRaw === null || splitRaw === '' ? null : parseTargetValue(splitRaw),
    workbenchOpen: params.has('wb'),
    workbenchTab: workbenchTab !== null && workbenchTab !== '' ? workbenchTab : DEFAULT_WORKBENCH_TAB,
    activeModal: parseActiveModal(params),
  }
}

/** 始终返回以 `#/` 开头的规范形式；默认态输出 `#/c/1`，command-palette 不序列化。 */
export function formatLocationHash(state: WorkspaceLocationState): string {
  const query: Array<[string, string]> = []
  if (state.splitTarget !== null) query.push(['split', formatTargetValue(state.splitTarget)])
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

/** 逐一对比五个位置字段；workbenchTab 仅在工作台打开时参与（关闭时只是记忆值，不在 URL 中）。 */
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

/**
 * 判断状态迁移是否值得入历史栈（pushState）：
 * - 主屏、分屏、工作台开关、弹窗开关或弹窗类型变化 → push（前进/后退可还原）；
 * - 产物预览切换不同 artifactId → push（每个预览是可独立直达的视图）；
 * - 同一列表型弹窗内仅切换子项、或工作台已打开时仅切 Tab → replace
 *   （避免弹窗内点选 10 项后要后退 10 次才能关掉弹窗）。
 */
export function shouldPushLocationHistory(prev: WorkspaceLocationState, next: WorkspaceLocationState): boolean {
  if (!isSameResolvedTarget(prev.primaryTarget, next.primaryTarget)) return true
  if (!isSameResolvedTarget(prev.splitTarget, next.splitTarget)) return true
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
