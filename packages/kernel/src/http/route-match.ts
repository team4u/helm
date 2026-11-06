/**
 * 路径匹配共享模块：段解码 + 插件动态路由完整路径匹配。
 *
 * hub.ts（public 豁免判定）与 routes.ts（dispatch）必须共用同一匹配器，
 * 否则两处语义漂移会造成「豁免了却派发不到」或反向「派发了却未豁免」。
 *
 * - 每段严格 decodeURIComponent：非法百分号编码直接抛错（400），绝不静默
 *   当作字面量继续匹配；编码后的 '/'（%2F）解码发生在分段之后，不会
 *   重新切分路径段。
 * - 插件路由声明（PluginHost.register(ctx.route)）携带完整挂载路径
 *   /api/plugins/<encodeURIComponent(id)>/routes/...；声明段与请求段都
 *   解码到同一形态后精确比对（段数一致），不臆造相对路径。
 */

export class PathDecodeError extends Error {
  constructor(segment: string) {
    super(`路径段包含非法百分号编码: ${segment}`)
    this.name = 'PathDecodeError'
  }
}

/** 严格解码单个路径段；非法编码抛 PathDecodeError（由路由层映射 400）。 */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new PathDecodeError(segment)
  }
}

/** pathname（已含 /api 前缀与否均可）→ 严格解码后的段数组。 */
export function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * 声明路径 → 段数组。PluginHost 强制声明前缀使用 encodeURIComponent(pluginId)
 * 形态（如 /api/plugins/builtin%3Atriggers/routes/...），此处同样严格解码
 * 每段，与请求段（已解码）在同一形态下比对。声明确保合法编码（注册时
 * PluginHost 已拒非法形态），此处解码失败按原样使用（不放大为请求错误）。
 */
export function declaredSegments(declared: string): string[] {
  return declared
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * 完整路径匹配：已解码请求段 against 声明段（支持 ':param' 占位）。
 * 段数必须完全一致；':param' 捕获任意非空段。请求段此时已是解码后形态
 * （含解码出的 '/' 也只算一段），声明段以插件注册时字符串为准。
 */
export function matchFullPath(declared: string, requestSegments: string[]): boolean {
  const parts = declaredSegments(declared)
  if (parts.length !== requestSegments.length) return false
  return parts.every(
    (part, i) => (part.startsWith(':') && part.length > 1) || part === requestSegments[i],
  )
}

/** 插件专属路由前缀：/api/plugins/<encodedId>（encodedId 需再解码）。 */
export function pluginRoutePrefixSegments(): string[] {
  return ['api', 'plugins']
}

/**
 * 在插件路由清单中查找唯一匹配（method + 完整路径）。
 * 返回 undefined 表示无匹配。请求段必须形如
 * ['api','plugins',<pluginId>,'routes', ...rest...]；插件 id 以解码值比对。
 */
export interface RouteCandidate {
  pluginId: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  public?: boolean
}

export function findPluginRoute<T extends RouteCandidate>(
  routes: readonly T[],
  method: string,
  requestSegments: string[],
): { route: T; pluginId: string; restSegments: string[] } | undefined {
  // 段形：api / plugins / :pluginId / routes / ...rest（rest 至少一段）
  if (requestSegments.length < 5) return undefined
  if (requestSegments[0] !== 'api' || requestSegments[1] !== 'plugins' || requestSegments[3] !== 'routes') {
    return undefined
  }
  const pluginId = requestSegments[2]
  if (pluginId === undefined) return undefined
  const rest = requestSegments.slice(4)
  const route = routes.find(
    (r) => r.pluginId === pluginId && r.method === method && matchFullPath(r.path, requestSegments),
  )
  if (route === undefined) return undefined
  return { route, pluginId, restSegments: rest }
}
