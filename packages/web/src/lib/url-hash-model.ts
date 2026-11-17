import { pathRulesForShape } from '@helm/protocol/browser'
import { isSameResolvedTarget, isPrototypeParamKey, SCREEN_PARAM_KEY_PATTERN, type ActiveModal, type ResolvedTarget } from './types.js'

/**
 * The workspace location expressed by the address-bar hash: primary target,
 * right split, workbench drawer and top-level modal.
 * This module has zero React/DOM dependencies and only does pure encode /
 * decode / compare functions; the syntax contract lives in test/url-hash.test.ts.
 * Parse defaults (empty hash / invalid path -> profile center) stay unchanged;
 * "entries without an explicit primary target" are upgraded to a conversation
 * space target by the product layer (HelmStoreProvider landing); this module
 * keeps that policy out.
 *
 * Path tree (hierarchical routing: sub-items are always path segments, never
 * query parameters):
 * - `c/<id>`                                                     conversation
 * - `a/<profileId>`                                              agent standby page
 * - `views/<pluginId>/<screenId>`                                plugin full-screen view
 * - `settings/profiles[/<profileId>]`                            profile center
 * - `settings/models[/<providerId>|/defaults|/<providerId>/defaults]` model center (defaults is the reserved segment = global-default tab)
 * - `settings/skills[/<skillId>]`                                skill center
 * - `settings/nodes[/<nodeId>]`                                  node center
 * - `settings/plugins[/<pluginId>]`                              plugin center
 */
export interface WorkspaceLocationState {
  primaryTarget: ResolvedTarget
  target?: ResolvedTarget
  splitTarget: ResolvedTarget | null
  workbenchOpen: boolean
  workbenchTab: string
  activeModal: ActiveModal
}

/** Modals persisted into the URL (command-palette is a transient search box, excluded). */
type PersistedModal = Exclude<ActiveModal, null | { kind: 'command-palette' }>

/**
 * Default primary screen: the agent profile center (conversation-free, usable
 * with zero or all conversations deleted; serializes to
 * `#/settings/profiles`; the historical conversation:1 default was removed
 * with the root-conversation redesign). The parse-layer default is unchanged;
 * a landing entry with "no explicit primary target and no modal" is upgraded
 * by HelmStoreProvider to the conversation-space default via replace once
 * data is ready (see the landing effect).
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
  'workspace-file': 'file',
  'conversation-drawer': 'drawer',
} as const

const MODAL_KEY_TO_KIND = {
  profiles: 'profile-editor',
  providers: 'provider-auth',
  skills: 'skill-viewer',
  plugins: 'plugin-settings',
  nodes: 'nodes',
  artifact: 'artifact-preview',
  file: 'workspace-file',
  drawer: 'conversation-drawer',
} as const

/** Path segments keep only colons readable; slashes inside a segment must be encoded so they never confuse target separators. */
const encodeSegment = (value: string): string =>
  encodeURIComponent(value).replace(/%3A/gi, ':')

/** Decode one path/param segment; empty strings and invalid percent sequences are defensively invalid (null). */
const decodeSegment = (value: string): string | null => {
  try {
    const decoded = decodeURIComponent(value)
    return decoded === '' ? null : decoded
  } catch {
    return null
  }
}

/** Accept decimal positive integers only (no spaces, decimals, scientific notation) — never NaN or 0/negative conversation ids. */
const parsePositiveInt = (raw: string): number | null => {
  if (!/^\d+$/.test(raw)) return null
  const value = Number(raw)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function normalizeHashWorkspacePath(raw: string): string | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('/') || trimmed.includes('\\') || trimmed.includes('\0')) {
    return null
  }
  const normalized = pathRulesForShape('posix').normalize(trimmed)
  if (
    normalized === '' ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    normalized.startsWith('/') ||
    normalized.endsWith('/')
  ) {
    return null
  }
  return normalized
}

function parseHashLineRange(raw: string | null): { startLine?: number; endLine?: number } {
  if (raw === null || raw === '') return {}
  const match = /^(\d+)(?:-(\d+))?$/.exec(raw)
  if (match === null) return {}
  const startLine = parsePositiveInt(match[1]!)
  if (startLine === null) return {}
  if (match[2] === undefined) return { startLine }
  const endLine = parsePositiveInt(match[2])
  if (endLine === null || endLine < startLine) return { startLine }
  return { startLine, endLine }
}

/** Namespace prefixes of primary/split screen params in the hash query string (mutually exclusive). */
export const PRIMARY_SCREEN_PARAM_PREFIX = 'sp.'
export const SPLIT_SCREEN_PARAM_PREFIX = 'ssp.'

/** Query param names of the agent target draft env in the hash (one set at the top level for the primary screen, one inside the split value; scopes never overlap). */
const AGENT_NODE_PARAM = 'node'
const AGENT_CWD_PARAM = 'cwd'

/** Extract the agent draft env from the query string (only non-empty values apply; empty strings count as unset). */
function extractAgentEnv(params: URLSearchParams): { nodeId?: string; cwd?: string } {
  const node = params.get(AGENT_NODE_PARAM)
  const cwd = params.get(AGENT_CWD_PARAM)
  return {
    ...(node !== null && node !== '' ? { nodeId: node } : {}),
    ...(cwd !== null && cwd !== '' ? { cwd } : {}),
  }
}

/** Attach fields only when env params are actually carried, keeping the shape of env-less agent targets stable. */
function applyAgentEnv(
  target: { kind: 'agent'; profileId: string },
  env: { nodeId?: string; cwd?: string },
): ResolvedTarget {
  return env.nodeId === undefined && env.cwd === undefined ? target : { ...target, ...env }
}

/** Serialize the env params of an agent target (stable lexicographic order; escaping handled by URLSearchParams). */
function formatAgentEnvParams(target: ResolvedTarget): Array<[string, string]> {
  if (target.kind !== 'agent') return []
  const pairs: Array<[string, string]> = []
  if (target.nodeId !== undefined && target.nodeId !== '') pairs.push([AGENT_NODE_PARAM, target.nodeId])
  if (target.cwd !== undefined && target.cwd !== '') pairs.push([AGENT_CWD_PARAM, target.cwd])
  return pairs
}

/** Strictly parse one `sp.<k>=<v>` / `ssp.<k>=<v>` param: invalid keys / empty values / invalid encodings return null. */
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

/** Extract namespaced screen params from the query string; invalid entries and duplicate keys are dropped (silent intrusion hardening). */
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

/** Serialize screen params in lexicographic order (escaping handled by URLSearchParams). */
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
 * Parse one canonical target path (shared by the primary path and the path
 * part of a split value). Split hierarchy by bare slashes first, then decode
 * each segment — an encoded slash inside a segment (%2F) never breaks the
 * hierarchy; extra levels / empty segments / invalid encodings invalidate the
 * whole target (null), never silently taking a prefix.
 */
function parseTargetValue(raw: string): ResolvedTarget | null {
  if (raw.startsWith('c/')) {
    const conversationId = parsePositiveInt(raw.slice(2))
    return conversationId === null ? null : { kind: 'conversation', conversationId }
  }
  if (raw.startsWith('a/')) {
    const rest = raw.slice(2)
    // An encoded profileId contains no bare slash; extra slashes are invalid, never silently taking a prefix.
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
      // Center list page (no sub-item)
      if (center === 'profiles') return { kind: 'profiles' }
      if (center === 'models') return { kind: 'models' }
      if (center === 'skills') return { kind: 'skills' }
      if (center === 'nodes') return { kind: 'nodes' }
      if (center === 'plugins') return { kind: 'plugins' }
      return null
    }
    const sub = rest.slice(slashIdx + 1)
    if (center === 'models') return parseModelsSubTarget(sub)
    // Single-sub-item centers: exactly one path segment
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
 * Parse the models center sub-path: `defaults` | `<providerId>` | `<providerId>/defaults`.
 * `defaults` is a reserved segment (global-default tab, continuing the old
 * virtual-card semantics) and is never treated as a providerId;
 * `<providerId>/defaults` expresses "provider drawer + global-default tab"
 * (keeping the current tab when a provider opens in the split).
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
    // `defaults` is a reserved segment, never serialized as a providerId (providers is the default tab and is not serialized)
    if (target.providerId !== undefined && target.providerId !== '' && target.providerId !== 'defaults') {
      parts.push(encodeSegment(target.providerId))
    }
    if (target.tab === 'defaults') parts.push('defaults')
    return parts.join('/')
  }
  return ''
}

/**
 * Parse a split value: shares the same canonical target paths as the primary
 * screen (including settings/views hierarchy and center sub-item segments);
 * only agent targets may carry an embedded query `?node=&cwd=` after the path
 * (center sub-items and tabs are already path segments, screen params always
 * live in the top-level ssp.* namespace — nothing else travels via a split
 * query anymore).
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

/** Sub-item id of list modals (profileId / skillId / pluginId / nodeId) or the drawer conversation id. */
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
      // The artifact deep-link id is required: a missing one means an invalid modal.
      if (subId === undefined) return null
      const conversationId = parsePositiveInt(params.get('conv') ?? '')
      return conversationId === null
        ? { kind: 'artifact-preview', artifactId: subId }
        : { kind: 'artifact-preview', artifactId: subId, conversationId }
    case 'workspace-file': {
      const fileConvId = parsePositiveInt(params.get('conv') ?? '')
      if (fileConvId === null) return null
      const rawPath = params.get('path')
      if (rawPath === null) return null
      const path = normalizeHashWorkspacePath(rawPath)
      if (path === null) return null
      const lineRange = parseHashLineRange(params.get('line'))
      return { kind: 'workspace-file', conversationId: fileConvId, path, ...lineRange }
    }
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

/** Split a raw hash: strip `#`, separate path and query at the first `?`, trim leading/trailing slashes from the path. */
function splitHash(rawHash: string): { path: string; params: URLSearchParams } {
  const raw = rawHash.startsWith('#') ? rawHash.slice(1) : rawHash
  const queryIdx = raw.indexOf('?')
  return {
    path: (queryIdx === -1 ? raw : raw.slice(0, queryIdx)).replace(/^\/+/, '').replace(/\/+$/, ''),
    params: new URLSearchParams(queryIdx === -1 ? '' : raw.slice(queryIdx + 1)),
  }
}

/**
 * Whether the entry hash explicitly expresses a primary target: empty hashes,
 * query-only hashes and invalid paths are all false (the parse-default
 * fallback to the profile center is not an explicit target). The landing
 * decision consults only this function and modal deep links; the landing
 * policy itself belongs to the product layer (HelmStoreProvider).
 */
export function hashHasPrimaryTarget(rawHash: string): boolean {
  return parseTargetValue(splitHash(rawHash).path) !== null
}

/**
 * Parse a `#/path?searchParams` hash. Every invalid segment (including all
 * legacy path shapes) falls back to the defaults (profile center
 * `#/settings/profiles` / no split / workbench closed / no modal) — never
 * throws and never produces NaN; the landing upgrade for "entries without an
 * explicit primary target" (replace to the conversation space once auth and
 * data are ready) belongs to HelmStoreProvider; this function stays pure
 * parsing.
 */
export function parseLocationHash(rawHash: string): WorkspaceLocationState {
  const { path, params } = splitHash(rawHash)
  const splitRaw = params.get('split')
  const workbenchTab = params.get('wb')
  let primaryTarget = parseTargetValue(path) ?? DEFAULT_PRIMARY
  // The draft env of an agent standby primary comes from top-level node/cwd params (an agent env inside the split is encoded within the split value).
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

/** Attach the params field only when valid params exist, keeping param-less screen targets shape-stable. */
function applyScreenParams(
  target: { kind: 'screen'; pluginId: string; screenId: string },
  params: Record<string, string> | undefined,
): ResolvedTarget {
  return params === undefined ? target : { ...target, params }
}

/** Always return the canonical form starting with `#/`; the default state outputs `#/settings/profiles`; command-palette is never serialized. */
export function formatLocationHash(state: WorkspaceLocationState): string {
  const query: Array<[string, string]> = []
  // The draft env (node/cwd) of an agent standby target serializes into the primary's top-level namespace; the split carries its own inside the split string.
  query.push(...formatAgentEnvParams(state.primaryTarget))
  if (state.splitTarget !== null) query.push(['split', formatSplitTarget(state.splitTarget)])
  // Primary/split screen params occupy the sp.* / ssp.* namespaces respectively: the same screen open twice never crosses params.
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
    } else if (modal.kind === 'workspace-file') {
      query.push(['conv', String(modal.conversationId)])
      query.push(['path', modal.path])
      if (modal.startLine !== undefined && Number.isSafeInteger(modal.startLine) && modal.startLine > 0) {
        const lineStr =
          modal.endLine !== undefined && Number.isSafeInteger(modal.endLine) && modal.endLine >= modal.startLine
            ? `${modal.startLine}-${modal.endLine}`
            : String(modal.startLine)
        query.push(['line', lineStr])
      }
    } else {
      const subId = modalSubId(modal)
      if (subId !== undefined && subId !== '') query.push(['id', subId])
    }
  }
  const search = new URLSearchParams(query).toString()
  return `#/${formatTargetValue(state.primaryTarget)}${search === '' ? '' : `?${search}`}`
}

/** command-palette is a transient modal and never participates in location comparison (consistent with staying out of the URL). */
const normalizeModal = (modal: ActiveModal): PersistedModal | null =>
  modal === null || modal.kind === 'command-palette' ? null : modal

/** Compare location fields one by one; workbenchTab participates only while the workbench is open (closed, it is just a memory value not in the URL). */
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
  if (modalA.kind === 'workspace-file' && modalB.kind === 'workspace-file') {
    return modalA.conversationId === modalB.conversationId
      && modalA.path === modalB.path
      && (modalA.startLine ?? undefined) === (modalB.startLine ?? undefined)
      && (modalA.endLine ?? undefined) === (modalB.endLine ?? undefined)
  }
  return modalSubId(modalA) === modalSubId(modalB)
}

/** Same screen coordinate (identical kind/pluginId/screenId) counts as the same location; param differences are not coordinate changes. */
const isSameScreenSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind !== 'screen' || b.kind !== 'screen') return false
  return a.pluginId === b.pluginId && a.screenId === b.screenId
}

/** The same agent standby coordinate (identical profileId) is the same location slot; draft-env-only changes are not coordinate-level switches. */
const isSameAgentSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind !== 'agent' || b.kind !== 'agent') return false
  return a.profileId === b.profileId
}

/** The same center coordinate (both kinds being that first-level full-screen center) is the same primary-stage slot; drawer switches or closes are not coordinate-level switches. */
const isSamePrimaryCenterSlot = (a: ResolvedTarget | null, b: ResolvedTarget | null): boolean => {
  if (a === null || b === null) return a === b
  if (a.kind === 'plugins' && b.kind === 'plugins') return true
  if (a.kind === 'profiles' && b.kind === 'profiles') return true
  if (a.kind === 'skills' && b.kind === 'skills') return true
  if (a.kind === 'nodes' && b.kind === 'nodes') return true
  if (a.kind === 'models' && b.kind === 'models') return true
  return false
}

/** Whether the primary/split location changed at coordinate level (conversation id change, agent coordinate change, screen coordinate change, view-type change, split open/close). */
const isTargetSlotChanged = (prev: ResolvedTarget | null, next: ResolvedTarget | null): boolean =>
  !isSameResolvedTarget(prev, next) && !isSameScreenSlot(prev, next) && !isSameAgentSlot(prev, next) && !isSamePrimaryCenterSlot(prev, next)

/**
 * Decide whether a state transition deserves a history-stack entry (pushState):
 * - primary, split, workbench toggle, modal toggle or modal kind change ->
 *   push (restorable via forward/back);
 * - the same screen target with only params changed, or the same agent standby
 *   target with only a draft env (node/cwd) change -> replace, so filter/env
 *   adjustments do not pollute the back stack on every keystroke; force a push
 *   explicitly at the call site when needed;
 * - artifact preview switching to a different artifactId -> push (every
 *   preview is an independently reachable view);
 * - switching sub-items within one list modal, or switching tabs while the
 *   workbench is already open -> replace (avoid needing 10 back presses to
 *   close a modal after picking 10 items inside it).
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

  // Opening a center drawer from its list (no id -> id) pushes, so browser back closes the drawer
  if (isOpeningDrawer(prev.primaryTarget, next.primaryTarget)) {
    return true
  }
  // Params-only changes (screen coordinate unchanged) or switching/closing inside a center drawer -> replace, so filter keystrokes do not pollute the back stack; force a push explicitly at the call site (the setScreenParams push flag).
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
  if (prevModal.kind === 'workspace-file' && nextModal.kind === 'workspace-file') {
    return prevModal.conversationId !== nextModal.conversationId
      || prevModal.path !== nextModal.path
      || (prevModal.startLine ?? undefined) !== (nextModal.startLine ?? undefined)
      || (prevModal.endLine ?? undefined) !== (nextModal.endLine ?? undefined)
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
 * Hash serialization contract helper.
 * Accepts a WorkspaceLocationState, a partial object carrying target/primaryTarget, or a bare ResolvedTarget.
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

/** Reverse parse contract alias, pointing at parseLocationHash. */
export const parseHash = parseLocationHash

