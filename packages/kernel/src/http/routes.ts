/**
 * Core API router (thin layer): strips `/api` prefix, strictly decodes path segments, and statically
 * dispatches by first segment to domain routers (auth / conversations / asks / search /
 * profiles / models / providers / credentials / skills / artifacts /
 * plugins / actions / nodes / env). Domain handlers are responsible for concrete endpoints.
 *
 * Routing rules: exact method + path segment matching (exact segment count required; extra segments
 * always return 404 rather than letting routes like `/auth/status/foo` fall through); segments use
 * strict percent-decoding (invalid encoding returns 400 via `PathDecodeError` caught in `hub.ts`).
 * Auth runs upfront in `hub.ts`, so this module only sees authenticated requests (except the three
 * public auth endpoints).
 *
 * Outbound JSON is redacted when `kernel.stash` is present; plugin action results are returned
 * verbatim (`null` stays `null`, while `undefined` violates the output contract and returns 500).
 */
import { HelmxError } from '@helmx/protocol'
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
import { handleSessionDocsDomain } from './session-doc-routes.js'

export async function handleApi(
  request: Request,
  kernel: KernelRuntimeLike,
  redactor?: JsonRedactor,
): Promise<Response> {
  const url = new URL(request.url)
  const segments = url.pathname.split('/').filter((s) => s.length > 0)
  // Strip api prefix
  if (segments[0] === 'api') segments.shift()
  // hub.ts path validation does not mutate Request; parse and decode path segments from the original URL here.
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
    throw error // top-level 500 handling lives in hub.ts
  }
}

/** Static dispatch table mapping first segment -> domain handler (no fallthrough, no priority rules). */
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
  'session-docs': handleSessionDocsDomain,
  nodes: handleNodeDomain,
  env: handleEnvExecDomain,
}

async function dispatch(
  ctx: RouteContext,
  kernel: KernelRuntimeLike,
  redactor: JsonRedactor | undefined,
): Promise<Response> {
  const head = ctx.segments[0]
  if (head === undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')

  // ---- events: global SSE (the only top-level endpoint outside a domain module) --------------------------
  if (head === 'events') {
    if (ctx.method === 'GET' && ctx.segments[1] === undefined) {
      return kernel.events.response(ctx.request)
    }
    return errorResponse(redactor, 404, 'not_found', 'route not found')
  }

  const handler = Object.hasOwn(DOMAIN_HANDLERS, head) ? DOMAIN_HANDLERS[head] : undefined
  if (handler === undefined) return errorResponse(redactor, 404, 'not_found', 'route not found')
  return handler(ctx, kernel, redactor)
}

/**
 * Map service-layer custom Errors to structured HTTP errors (never let them fall through as 500).
 * - Auth: AuthAlreadyConfiguredError 409 / InvalidCredentialsError 401 / WeakPasswordError 400.
 * - File assets: FileNotFoundError 404; other validation errors 400.
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
  if (error instanceof HelmxError && error.code === 'auth_not_setup') {
    return errorResponse(redactor, 409, 'not_setup', error.message)
  }
  return undefined
}
