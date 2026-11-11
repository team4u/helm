/**
 * HTTP 边界固定协议：
 * - 成功：直接返回实体或数组（不统一包 data）。
 * - 失败：`{ error: { code, message, details? } }`。
 * Request/Response 使用 base lib 的 DOM 类型，不依赖 node 内置模块。
 */

import type { ConversationSummary } from './conversation.js'
import type { HelmErrorDetail } from './error.js'

export interface ApiErrorBody {
  error: HelmErrorDetail
}

/** `GET /api/auth/status`。 */
export interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

/** `POST /api/auth/setup` / `POST /api/auth/login` 成功响应。 */
export interface AuthToken {
  token: string
}

/** `GET /api/credentials` 列表项；密钥本体永不离开服务端。 */
export interface CredentialSummary {
  id: string
  configured: boolean
}

/** `POST /api/conversations/:id/fork` 请求体。 */
export interface ConversationForkRequest {
  /** 分叉锚点 entry ID（与 ConversationEntry.id 对应的正整数序号）。 */
  entryId: number
  title?: string
}

/** `POST /api/conversations/:id/compact` 响应。 */
export interface ConversationCompactResponse {
  taskId: number
  conversation: ConversationSummary
}

/** `POST /api/conversations/:id/withdraw` 请求体。 */
export interface ConversationWithdrawRequest {
  /** 待撤回的排队 submission ID（正整数）。 */
  submissionId: number
}

/** `POST /api/conversations/:id/withdraw` 响应。 */
export interface ConversationWithdrawResponse {
  status: 'withdrawn' | 'already_placed' | 'settled'
  /** 若该提交刚进入执行或已结算并分配了条目 ID，则返回对应的 entryId。 */
  entryId?: number
}

/** `GET /api/search?q=...` 命中条目。 */
export interface SearchHit {
  conversationId: number
  entryId?: string
  snippet: string
  title?: string
}

/** 静态核心 CLI 命令路径唯一真源（与 @helm/cli coreCommands() 及内置技能 SKILL.md 双向锁定）。 */
export const CORE_CLI_COMMAND_PATHS = [
  'setup',
  'login',
  'status',
  'events watch',
  'conversations list',
  'conversations get',
  'conversations create',
  'conversations update',
  'conversations delete',
  'conversations reset',
  'conversations compact',
  'conversations fork',
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
  'search',
  'api',
] as const

export type CoreCliCommandPath = (typeof CORE_CLI_COMMAND_PATHS)[number]

