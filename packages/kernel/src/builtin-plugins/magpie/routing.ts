/**
 * 路由组：网关 trace（GET /v1/magpie/trace）与 magpie CLI 输出的解析与投影。
 *
 * 数据源纪律（审查要求）：
 * - 本机 loopback 网关：优先网关 trace；`magpie groups` / `magpie group <id>`
 *   CLI 描述配置本机的 Magpie 实例；
 * - 非本机网关：CLI 描述的是本机另一个实例，绝不混入；仅用所选网关的
 *   trace 提取路由组与最近命中，并如实标注 source: 'gateway-trace'；
 * - 无法明确指向配置目标时不编造 group 定义（CLI 拒绝或 trace 缺失时
 *   如实报告来源与原因）。
 */

/** magpie groups CLI 的单行。 */
export interface GroupListRow {
  id: string
  name?: string
  routing?: string
  stays?: string
  members: string[]
  usedBy?: string
  auto?: boolean
}

/** magpie group <id> CLI 的组定义。 */
export interface GroupInfo {
  id?: string
  name?: string
  auto?: boolean
  removed?: boolean
  routing?: string
  stays?: string
  levels?: string
  effort?: string
  classifier?: string
  usedBy?: string
  members: string[]
  picked?: string
  rules: string[]
}

/** 网关 trace 的单条路由记录（gateway trace.go Route）。 */
export interface TraceRoute {
  time?: string
  agent?: string
  /** agent 请求的模型 id（组请求时为组 id）。 */
  model?: string
  provider?: string
  group?: {
    id?: string
    ref?: string
    name?: string
    routing?: string
    affinity?: string
    auto?: boolean
    members?: string[]
  }
  affinity?: { mode?: string; turn?: number; last?: string; why?: string; kept?: boolean }
  served?: string
  status?: number
  error?: string
  tokens?: number
  tries?: Array<{
    id?: string
    model?: string
    effort?: string
    status?: number
    fail?: string
    error?: string
    ms?: number
  }>
}

/** ANSI 颜色剥离。 */
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** magpie 列表的列分隔符（两个及以上空格）。 */
const COLUMN = /\s{2,}/

/** 组 id 形态：`group/<id>`（用户建）或 `auto/<model>`（magpie 发现）。 */
const GROUP_REF = '(?:group/[a-z0-9][a-z0-9-]*|auto/[^\\s]+)'
const GROUP_REF_LINE = new RegExp(`^${GROUP_REF}$`)

/** `group/<id>` → `<id>`。 */
export function shortGroupId(id: string): string {
  return id.replace(/^group\//, '')
}

/** 组 id 集合去重键：短 id（group/x 与 x 同键）。 */
export function groupKey(id: string | undefined): string | undefined {
  if (!id) return undefined
  const short = shortGroupId(id)
  return short.length > 0 ? short : undefined
}

// ---------------------------------------------------------------------------
// CLI 输出解析（本机 loopback 专用）
// ---------------------------------------------------------------------------

/** magpie group <id> 字段行：两空格 + 键 + 值。 */
const GROUP_FIELD = /^\s{2}(used by|routing|stays|models|rules|levels|effort|classifier)\s+(.*)$/

/** 字段值续行。 */
const GROUP_CONTINUATION = /^\s{12,}(\S.*)$/

const ROUTINGS = new Set(['smart', 'order', 'rotate', 'usage', 'manual'])

/** `magpie group <id>` 输出 → 组定义；无法解析返回 undefined。 */
export function parseGroupShow(text: string): GroupInfo | undefined {
  const info: GroupInfo = { members: [], rules: [] }
  let field: string | undefined
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim()) continue
    const header = new RegExp(`^\\s+(.*?)\\s{2,}(${GROUP_REF})(.*)$`).exec(line)
    if (header && !info.id && header[2]) {
      info.id = header[2]
      info.name = header[1]?.replace(/\s+found$/, '').trim()
      info.auto = /found by magpie/.test(header[3] ?? '')
      info.removed = /\bremoved\b/.test(header[3] ?? '')
      continue
    }
    const match = GROUP_FIELD.exec(line)
    if (match && match[1] && match[2] !== undefined) {
      field = match[1]
      applyGroupField(info, field, match[2], line.includes('\u25cf'))
      continue
    }
    if (field) {
      const continuation = GROUP_CONTINUATION.exec(line)
      if (continuation && continuation[1]) applyGroupField(info, field, continuation[1], line.includes('\u25cf'))
    }
  }
  if (!info.id) return undefined
  return info
}

function applyGroupField(info: GroupInfo, key: string, value: string, pickedHere: boolean): void {
  const trimmed = value.trim()
  const first = trimmed.split(COLUMN)[0]?.trim() || trimmed
  switch (key) {
    case 'routing':
      info.routing = first.split(/\s+/)[0] || undefined
      break
    case 'stays':
      info.stays = first.split(/\s+/)[0] || undefined
      break
    case 'models':
      addMember(info, trimmed, pickedHere)
      break
    case 'rules':
      info.rules.push(first.replace(/^\d+\s+/, ''))
      break
    case 'levels':
      info.levels = first || undefined
      break
    case 'effort':
      info.effort = first.split(/\s+/)[0] || undefined
      break
    case 'classifier':
      info.classifier = first.split(/\s+/)[0] || undefined
      break
    case 'used by':
      info.usedBy = first || undefined
      break
  }
}

/** `1 opencode-go/mimo-v2.6-flash ●  OpenCode Go · MiMo` → 成员 id。 */
function addMember(info: GroupInfo, text: string, picked: boolean): void {
  const match = /^\s*(\d+)\s+(\S+)/.exec(text)
  if (!match || !match[2]) return
  const id = match[2]
  if (!info.members.includes(id)) info.members.push(id)
  if (picked) info.picked = id
}

/** `magpie groups` 输出 → 行列表。 */
export function parseGroupsList(text: string): GroupListRow[] {
  const rows: GroupListRow[] = []
  for (const raw of stripAnsi(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const columns = line.split(COLUMN)
    const idIndex = columns.findIndex((column) => GROUP_REF_LINE.test(column.trim()))
    if (idIndex < 0) continue
    const idColumn = columns[idIndex] ?? ''
    const row: GroupListRow = { id: idColumn.trim(), members: [] }
    const name = columns.slice(0, idIndex).join(' ').replace(/\s+found$/, '').trim()
    if (name) row.name = name
    row.auto = /found/.test(columns.slice(0, idIndex).join(' '))
    const how = columns[idIndex + 1]?.trim()
    if (how) {
      const [routing, stays] = how.split(/\s+\u00b7\s+/)
      if (routing && ROUTINGS.has(routing.split(/\s+/)[0] ?? '')) row.routing = routing.split(/\s+/)[0]
      if (stays?.startsWith('stays')) row.stays = stays.replace(/^stays\s+/, '').trim()
    }
    const members = columns[idIndex + 2]?.trim()
    if (members) row.members = splitMembers(members)
    const usedBy = columns.find((column) => column.startsWith('\u2190'))
    if (usedBy) row.usedBy = usedBy.replace(/^\u2190\s*/, '').trim()
    rows.push(row)
  }
  return rows
}

/** `● a/x · b/y` 或 `a/x → b/y` → 成员 id 列表。 */
export function splitMembers(text: string): string[] {
  return text
    .split(/\s+(?:\u00b7|\u2192)\s+/)
    .map((member) =>
      member
        .replace(/^\u25cf\s*/, '')
        .replace(/\s*\(not served\)\s*$/, '')
        .trim(),
    )
    .filter((member) => member.length > 0)
}

// ---------------------------------------------------------------------------
// 网关 trace → 路由组最近命中投影（任意网关可用）
// ---------------------------------------------------------------------------

/** 路由组展示行。 */
export interface RouteRow {
  group: string
  strategy?: string
  provider?: string
  model?: string
  timestamp?: string
}

/**
 * 网关 trace → 每组最近一次命中（组短 id 为键，后出现的覆盖先出现的——
 * trace 按时间升序）。
 */
export function traceRouteRows(routes: readonly TraceRoute[]): RouteRow[] {
  const latest = new Map<string, RouteRow & { order: number }>()
  for (const route of routes) {
    const key = groupKey(route.group?.id ?? route.group?.ref)
    if (!key) continue
    latest.set(key, {
      group: key,
      ...(route.group?.routing ? { strategy: route.group.routing } : {}),
      ...(route.provider ? { provider: route.provider } : {}),
      ...(route.served ? { model: route.served } : {}),
      ...(route.time ? { timestamp: route.time } : {}),
      order: latest.size,
    })
  }
  return [...latest.values()].sort((a, b) => a.order - b.order).map(({ order: _order, ...row }) => row)
}

/** trace 中某组最近一次路由记录。 */
export function latestGroupRouteIn(routes: readonly TraceRoute[], groupId: string): TraceRoute | undefined {
  const wanted = shortGroupId(groupId)
  if (!wanted) return undefined
  let latest: TraceRoute | undefined
  for (const route of routes) {
    const key = groupKey(route.group?.id ?? route.group?.ref)
    if (key === wanted) latest = route
  }
  return latest
}
