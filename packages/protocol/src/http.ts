/**
 * Fixed HTTP boundary protocol:
 * - Success: the entity or array is returned directly (no unified data wrapper).
 * - Failure: `{ error: { code, message, details? } }`.
 * Request/Response use the base lib's DOM types, with no dependency on node builtins.
 */

import type { ConversationSummary } from './conversation.js'
import type { HelmxErrorDetail } from './error.js'

export interface ApiErrorBody {
  error: HelmxErrorDetail
}

/** `GET /api/auth/status`. */
export interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

/** Success response of `POST /api/auth/setup` / `POST /api/auth/login`. */
export interface AuthToken {
  token: string
}

/** `GET /api/credentials` list item; the secret itself never leaves the server. */
export interface CredentialSummary {
  id: string
  configured: boolean
}

/** `POST /api/conversations/:id/fork` request body. */
export interface ConversationForkRequest {
  /** Fork anchor entry ID (a positive integer ordinal corresponding to ConversationEntry.id); defaults to the latest clean anchor when omitted. */
  entryId?: number
  title?: string
}

/** `POST /api/conversations/:id/compact` response. */
export interface ConversationCompactResponse {
  taskId: number
  conversation: ConversationSummary
}

/** `POST /api/conversations/:id/withdraw` request body. */
export interface ConversationWithdrawRequest {
  /** Queued submission ID to withdraw (positive integer). */
  submissionId: number
}

/** `POST /api/conversations/:id/withdraw` response. */
export interface ConversationWithdrawResponse {
  status: 'withdrawn' | 'already_placed' | 'settled'
  /** If the submission just entered execution or has settled and been assigned an entry ID, the corresponding entryId is returned. */
  entryId?: number
}

/** Hit entry of `GET /api/search?q=...`. */
export interface SearchHit {
  conversationId: number
  entryId?: string
  snippet: string
  title?: string
}

/** Single source of truth for static core CLI command paths (bidirectionally locked with @helmx/cli coreCommands() and the built-in skill SKILL.md). */
export const CORE_CLI_COMMAND_PATHS = [
  'setup',
  'login',
  'status',
  'start',
  'stop',
  'restart',
  'update',
  'events watch',
  'conversations list',
  'conversations get',
  'conversations entry',
  'conversations file',
  'conversations create',
  'conversations update',
  'conversations delete',
  'conversations reset',
  'conversations compact',
  'conversations fork',
  'conversations watch',
  'ask',
  'send',
  'conversations withdraw',
  'abort',
  'asks list',
  'asks answer',
  'asks cancel',
  'profiles list',
  'profiles get',
  'profiles create',
  'profiles update',
  'profiles delete',
  'providers list',
  'providers set',
  'credentials list',
  'credentials set',
  'credentials delete',
  'nodes list',
  'nodes issue',
  'nodes remove',
  'nodes upgrade',
  'nodes forward',
  'nodes forwards',
  'nodes forward-inspect',
  'nodes forward-stop',
  'env exec',
  'plugins list',
  'plugins enable',
  'plugins disable',
  'plugins config',
  'plugins doc',
  'plugins client',
  'plugins doctor',
  'plugins reload',
  'plugins rescan',
  'plugins init',
  'plugins build',
  'plugins install',
  'plugins update',
  'plugins remove',
  'actions list',
  'artifacts list',
  'artifacts put',
  'artifacts get',
  'skills list',
  'skills read',
  'models list',
  'models default',
  'models providers',
  'models refresh',
  'models filter',
  'search',
  'api',
] as const

export type CoreCliCommandPath = (typeof CORE_CLI_COMMAND_PATHS)[number]
