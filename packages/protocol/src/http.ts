/**
 * HTTP 边界固定协议：
 * - 成功：直接返回实体或数组（不统一包 data）。
 * - 失败：`{ error: { code, message, details? } }`。
 * Request/Response 使用 base lib 的 DOM 类型，不依赖 node 内置模块。
 */

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
