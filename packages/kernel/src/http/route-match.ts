/**
 * Shared path matching: segment decoding + full-path matching for dynamic plugin routes.
 *
 * `hub.ts` (public exemption check) and `routes.ts` (dispatch) MUST share the same matcher;
 * otherwise semantic drift could exempt a route without dispatching it, or vice versa.
 *
 * - Each segment is strictly decoded with `decodeURIComponent`: invalid percent-encoding throws immediately (400)
 *   rather than silently matching literals; decoded `/` (`%2F`) stays inside its segment and never re-splits the path.
 * - Plugin route declarations (`PluginHost.register(ctx.route)`) carry full mount paths
 *   `/api/plugins/<encodeURIComponent(id)>/routes/...`; declared and request segments are both decoded to the
 *   same canonical form before exact comparison (identical segment count), avoiding fragile relative-path reconstruction.
 */

export class PathDecodeError extends Error {
  constructor(segment: string) {
    super(`path segment contains invalid percent-encoding: ${segment}`)
    this.name = 'PathDecodeError'
  }
}

/** Strictly decode a single path segment; invalid percent-encoding throws PathDecodeError (mapped to 400 by router). */
export function decodeSegment(segment: string): string {
  if (!segment.includes('%')) return segment
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new PathDecodeError(segment)
  }
}

/** Split pathname (with or without `/api` prefix) into strictly decoded segments. */
export function decodeSegments(pathname: string): string[] {
  return pathname
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * Convert a declared route path into segments. PluginHost enforces `encodeURIComponent(pluginId)`
 * in the prefix (e.g. `/api/plugins/builtin%3Atriggers/routes/...`), so decoding each segment here
 * aligns it with the decoded request segments. Declared paths are guaranteed valid at registration time
 * (`PluginHost` rejects malformed encodings), so decode failures here propagate as internal errors rather
 * than being masked as caller request errors.
 */
export function declaredSegments(declared: string): string[] {
  return declared
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => decodeSegment(s))
}

/**
 * Full-path match: compare decoded request segments against declared segments (supporting `:param` placeholders).
 * Segment counts must match exactly; `:param` matches any non-empty segment. Request segments are already
 * decoded (so a decoded `/` still counts as a single segment); declared segments use the literal strings registered.
 */
export function matchFullPath(declared: string, requestSegments: string[]): boolean {
  const parts = declaredSegments(declared)
  if (parts.length !== requestSegments.length) return false
  return parts.every(
    (part, i) => (part.startsWith(':') && part.length > 1) || part === requestSegments[i],
  )
}

/** Plugin-dedicated route prefix segments: `/api/plugins/<encodedId>` (encodedId must still be decoded). */
export function pluginRoutePrefixSegments(): string[] {
  return ['api', 'plugins']
}

/**
 * Find the unique matching route (method + full path) in the plugin route list, or `undefined`.
 * Request segments must have the form `['api', 'plugins', <pluginId>, 'routes', ...rest...]`;
 * `pluginId` is compared using its decoded value.
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
