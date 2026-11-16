/**
 * core API routing dispatch (thin layer): strip /api prefix, strictly decode path segment, by first segment
 * static dispatch to domain routing module (auth / conversations / asks / search /
 * profiles / models / providers / credentials / skills / artifacts /
 * plugins / actions / nodes / env). domain handler internal only then is specific end point.
 *
 * routing rule: method + precise path segment match (segment count must fully consistent, redundant segment one rule 404,
 * never let /auth/status/foo of class operation branch); segment value via strictly hundred number decode
 * (illegal encode 400,PathDecodeError by hub.ts fall back mapping). authentication in hub.ts
 * unify pre-, this module only handle already recognize verify request (auth three end point except outside).
 *
 * out station JSON one rule via redactor redaction (kernel.stash store in when); plugin action result
 * original return (null is exactly null,undefined is output boundary violate about, explicit 500).
 */
import { HelmError } from '@helm/protocol'
import type { KernelRuntimeLike } from './contracts.js'
import { errorResponse, type JsonRedactor } from './http-utils.js'
import { decodeSegment } from './route-match.js'
import type { RouteContext } from './route-context.js'
import {
  AuthAlreadyConfiguredError,
  InvalidCredentialsError,
  WeakPasswordError,
  FileNotFoundError,
} from '../services/index.js'

import { handleAuthDomain } from './auth-routes.js'
import {
  handleAsksDomain,
  handleConversationsDomain,
  handleSearchDomain,
} from './conversation-routes.js'
import { handleProfilesDomain } from './profile-routes.js'
import {
  handleCredentialsDomain,
  handleModelsDomain,
  handleProvidersDomain,
} from './model-routes.js'
import { handleNodeDomain, handleEnvExecDomain } from './node-routes.js'
import { handlePluginsDomain, handleActionsDomain } from './plugin-routes.js'
import { handleArtifactsDomain, handleSkillsDomain } from './asset-routes.js'

export async function handleApi(
  request: Request,
  kernel: KernelRuntimeLike,
  redactor?: JsonRedactor,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  // strip api prefix
  if (segments[0] === 'api') segments.shift()
  // hub.ts path validate do not change write Request; this in from original URL parse and decode path segment.
  const ctx: RouteContext = {
    request,
    method: request.method,
    segments: segments.map((s) => decodeSegment(s)),
    url,
  }

  try {
    return await dispatch(ctx, kernel, redactor)
  } catch (error) {
    const mapped = mapServiceError(redactor, error)
    if (mapped !== undefined) return mapped
    throw error // top-level 500 handle in hub.ts
  }
}

/** first segment → domain handler static dispatch table (without through match, without priority rule). */
const DOMAIN_HANDLERS: Readonly<
  Record<string, (ctx: RouteContext, kernel: KernelRuntimeLike, redactor: JsonRedactor | undefined) => Promise<Response>>
> = {
  auth: handleAuthDomain,
  conversations: handleConversationsDomain,
  asks: handleAsksDomain,
  search: handleSearchDomain,
  profiles: handleProfilesDomain,
  models: handleModelsDomain,
  providers: handleProvidersDomain,
  credentials: handleCredentialsDomain,
  skills: handleSkillsDomain,
  artifacts: handleArtifactsDomain,
  plugins: handlePluginsDomain,
  actions: handleActionsDomain,
  nodes: handleNodeDomain,
  env: handleEnvExecDomain,
}

async function dispatch(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const head = ctx.segments[0]
  if (head === undefined) return errorResponse(redactor, 404, 'not_found', 'routing missing')

  // ---- events: global SSE(unique do not archive domain top-level end point)--------------------------
  if (head === 'events') {
    if (ctx.method === 'GET' && ctx.segments[1] === undefined) {
      return kernel.events.response(ctx.request)
    }
    return errorResponse(redactor, 404, 'not_found', 'routing missing')
  }

  const handler = Object.hasOwn(DOMAIN_HANDLERS, head) ? DOMAIN_HANDLERS[head] : undefined
  if (handler === undefined) return errorResponse(redactor, 404, 'not_found', 'routing missing')
  return handler(ctx, kernel, redactor)
}

/**
 * service layer self define Error → structure HTTP error (cannot any its becomes 500).
 * - authentication:AuthAlreadyConfiguredError 409 / InvalidCredentialsError 401 / WeakPasswordError 400.
 * - file asset:FileNotFoundError 404; other validate error 400.
 */
function mapServiceError(redactor: JsonRedactor | undefined, error: unknown): Response | undefined {
  if (error instanceof AuthAlreadyConfiguredError) {
    return errorResponse(redactor, 409, 'already_setup', error.message)
  }
  if (error instanceof InvalidCredentialsError) {
    return errorResponse(redactor, 401, 'invalid_credentials', error.message)
  }
  if (error instanceof WeakPasswordError) {
    return errorResponse(redactor, 400, 'weak_password', error.message)
  }
  if (error instanceof FileNotFoundError) {
    return errorResponse(redactor, 404, 'not_found', error.message)
  }
  if (error instanceof HelmError && error.code === 'auth_not_setup') {
    return errorResponse(redactor, 409, 'not_setup', error.message)
  }
  return undefined
}
