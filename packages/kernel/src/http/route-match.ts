/**
 * path match sharing module: segment decode + plugin motion state routing complete path match.
 *
 * hub.ts(public exemption decide) and routes.ts(dispatch) must shared use the same match,
 * otherwise two where semantics drift will build into exemption yet dispatch fewer than or reverse dispatch yet not exemption.
 *
 * - each segment strictly decodeURIComponent: illegal hundred number encode directly throws (400), never static default
 *   when act literal continue match; encode after '/'(%2F) decode occur in segment after, will not
 *   re- cut path segment.
 * - plugin routing declaration (PluginHost.register(ctx.route)) carry complete mount path
 *   /api/plugins/<encodeURIComponent(id)>/routes/...; declaration segment and request segment all
 *   decode to the same form after precise than for (segment count consistent), do not conjecture build relative path.
 */

export class PathDecodeError extends Error {
  constructor(segment: string) {
    super(`path segment contains illegal hundred number encode: ${segment}`)
    this.name = 'PathDecodeError'
  }
}

/** strictly decode single path segment; illegal encode throw PathDecodeError(by routing layer mapping 400). */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new PathDecodeError(segment)
  }
}

/** pathname(already contains /api prefix and otherwise all can)→ strictly decode after segment array. */
export function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * declaration path → segment array.PluginHost force declaration prefix use encodeURIComponent(pluginId)
 * form (such as /api/plugins/builtin%3Atriggers/routes/...), this where same strictly decode
 * each segment, and request segment (already decode) in the same form under than for. declaration ensure legal encode (register when
 * PluginHost already refuse illegal form), this where decode failed by original use (do not put large is request error).
 */
export function declaredSegments(declared: string): string[] {
  return declared
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * complete path match: already decode request segment against declaration segment (support ':param' occupy).
 * segment count must fully consistent;':param' catch any non-empty segment. request segment now already is decode after form
 * (contains decode out '/' also only compute one segment), declaration segment with plugin register when string is allow.
 */
export function matchFullPath(declared: string, requestSegments: string[]): boolean {
  const parts = declaredSegments(declared)
  if (parts.length !== requestSegments.length) return false
  return parts.every(
    (part, i) => (part.startsWith(':') && part.length > 1) || part === requestSegments[i],
  )
}

/** plugin dedicated belong routing prefix:/api/plugins/<encodedId>(encodedId must again decode). */
export function pluginRoutePrefixSegments(): string[] {
  return ['api', 'plugins']
}

/**
 * in plugin routing manifest in find unique match (method + complete path).
 * return undefined means without match. request segment must shape such as
 * ['api','plugins',<pluginId>,'routes', ...rest...]; plugin id with decode value than for.
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
  // segment shape:api / plugins / :pluginId / routes / ...rest(rest at least one segment)
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
