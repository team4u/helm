/**
 * Multiplexed session-doc SSE domain routing: `GET /api/session-docs/events?sub=<pluginId>/<name>/<conversationId>&...`.
 *
 * Strictly validates every `?sub=` tuple via `@helm/protocol`'s `parseSessionDocSubParam`,
 * rejects empty/malformed/duplicate/over-limit subscriptions with `400 validation_error`,
 * checks plugin/session-doc service availability (`501 not_implemented` when missing),
 * and delegates to `kernel.sessionDocEvents.multiplexResponse(...)` without modifying `plugin-routes.ts`.
 */
import { HelmError, parseSessionDocSubParam } from '@helm/protocol'
import type { PublicPluginSessionDoc, SessionDocSubscription } from '@helm/protocol'
import type { KernelRuntimeLike } from './contracts.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import type { RouteContext } from './route-context.js'
import { ValidationError } from './validate.js'

/** Upper bound on `?sub=` tuples per multiplexed SSE connection. */
export const MAX_SESSION_DOC_MULTIPLEX_SUBS = 64

export async function handleSessionDocsDomain(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  if (ctx.method !== 'GET' || ctx.segments[1] !== 'events' || ctx.segments[2] !== undefined) {
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }

  const rawSubs = ctx.url.searchParams.getAll('sub')
  if (rawSubs.length === 0) {
    throw new ValidationError('at least one ?sub=<pluginId>/<name>/<conversationId> query parameter is required')
  }
  if (rawSubs.length > MAX_SESSION_DOC_MULTIPLEX_SUBS) {
    throw new ValidationError(
      `too many session doc subscriptions (${rawSubs.length}); maximum is ${MAX_SESSION_DOC_MULTIPLEX_SUBS}`,
    )
  }

  const seen = new Set<string>()
  const subs: SessionDocSubscription[] = []
  for (const raw of rawSubs) {
    const parsed = parseSessionDocSubParam(raw)
    const key = `${parsed.pluginId}\0${parsed.name}\0${parsed.conversationId}`
    if (seen.has(key)) {
      throw new ValidationError(
        `duplicate session doc subscription: ${parsed.pluginId}/${parsed.name}/${parsed.conversationId}`,
      )
    }
    seen.add(key)
    subs.push(parsed)
  }

  if (kernel.plugins === undefined || typeof kernel.plugins.getPublicSessionDoc !== 'function') {
    throw new HelmError(
      'not_implemented',
      'current runtime does not provide plugin session document service',
      501,
    )
  }
  const port = kernel.sessionDocEvents
  if (port === undefined || typeof port.multiplexResponse !== 'function') {
    throw new HelmError(
      'not_implemented',
      'current runtime does not provide multiplexed conversation document event stream',
      501,
    )
  }

  return port.multiplexResponse(subs, ctx.request, {
    snapshot: (sub) => {
      const doc = snapshotDocOf(kernel, sub)
      return { seq: port.seq, doc }
    },
  })
}

function snapshotDocOf(
  kernel: KernelRuntimeLike,
  sub: SessionDocSubscription,
): PublicPluginSessionDoc {
  const result = kernel.plugins.getPublicSessionDoc(sub.pluginId, sub.name, sub.conversationId)
  if (result instanceof Promise) {
    throw new HelmError(
      'not_implemented',
      'current runtime getPublicSessionDoc is async; cannot provide sync conversation document snapshot',
      501,
    )
  }
  return result
}
