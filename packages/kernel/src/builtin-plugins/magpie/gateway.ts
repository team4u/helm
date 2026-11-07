/**
 * Magpie 网关 HTTP 通道：目录 / 配额 / 路由轨迹读取与网关配置解析。
 *
 * 诚实性纪律：
 * - 网络失败一律 throw（调用方决定哪些失败值得上报，本层绝不吞错）；
 * - fetchImpl 注入端口：测试走受控 HTTP，不触真实网络；
 * - 错误信息只含 URL 与状态（token 只经 Bearer 头，绝不进错误文本）。
 */
import { HelmError } from '@helm/protocol'
import {
  DEFAULT_MAGPIE_ROOT,
  DEFAULT_MAGPIE_TOKEN,
  MAGPIE_ADDR_ENV,
  MAGPIE_ROOT_ENV,
  type MagpieGatewayRef,
  type MagpiePluginConfig,
} from './contracts.js'
import type { MagpieModelEntry } from './catalog.js'
import type { QuotaEntry } from './quota.js'
import type { TraceRoute } from './routing.js'

// ---------------------------------------------------------------------------
// 网关配置解析
// ---------------------------------------------------------------------------

/**
 * 网关根地址归一化：补 scheme、去尾斜杠与尾 /v1，使 /v1/models 等可直接拼接。
 * 非 URL 输入返回 undefined。
 */
export function normalizeRoot(input: string | undefined): string | undefined {
  const raw = (input ?? '').trim()
  if (!raw) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return undefined
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
  if (!url.hostname) return undefined
  let path = url.pathname.replace(/\/+$/, '')
  path = path.replace(/\/v1$/i, '')
  return `${url.origin}${path}`
}

/** root 是否本机 loopback。 */
export function isLoopback(root: string): boolean {
  let host: string
  try {
    host = new URL(root).hostname.replace(/^\[|\]$/g, '').toLowerCase()
  } catch {
    return false
  }
  return host === 'localhost' || host === '::1' || host === '0.0.0.0' || /^127\./.test(host)
}

/**
 * 读取当前生效网关快照：
 * 1. 插件配置 gatewayUrl / apiKey（用户显式配置）；
 * 2. 环境变量 MAGPIE_GW_URL / MAGPIE_ADDR（Magpie 自身约定）；
 * 3. 回退本机默认 http://127.0.0.1:3425 + token 'magpie'。
 *
 * configuredRoot 判定规则（审查要求：缺省 loopback 未运行 ≠ 显式配置失败）：
 * - gatewayUrl 显式配置 → true（无论值是否等于默认地址：显式即意图）；
 * - apiKey 显式配置（远端网关密钥）→ true；
 * - 仅环境变量配置 → true（用户自己指明了网关）；
 * - 无任何配置回落默认 loopback → false。
 *
 * 诚实性纪律：显式配置的 gatewayUrl / 非空 MAGPIE_GW_URL / MAGPIE_ADDR
 * 无法解析为合法 http(s) 根地址时直接抛 magpie_invalid_gateway_url——
 * 静默回退本机默认等于把请求发给用户没选的网关（且可能带错 token）。
 */
export function resolveGateway(
  config: MagpiePluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): MagpieGatewayRef {
  const invalid = (source: 'gatewayUrl' | 'env', raw: string): HelmError =>
    new HelmError(
      'magpie_invalid_gateway_url',
      `Magpie 网关地址配置无法解析为 http(s) 根地址：${source === 'gatewayUrl' ? '插件配置 gatewayUrl' : '环境变量 MAGPIE_GW_URL / MAGPIE_ADDR'} = ${JSON.stringify(raw)}`,
      400,
      { source, value: raw },
    )
  const configuredRaw = config.gatewayUrl?.trim()
  if (configuredRaw) {
    const normalized = normalizeRoot(configuredRaw)
    if (normalized === undefined) throw invalid('gatewayUrl', configuredRaw)
  }
  const envRaw = env[MAGPIE_ROOT_ENV]?.trim() || env[MAGPIE_ADDR_ENV]?.trim()
  if (envRaw) {
    const normalized = normalizeRoot(envRaw)
    if (normalized === undefined) throw invalid('env', envRaw)
  }
  const configuredUrl = configuredRaw ? normalizeRoot(configuredRaw)! : undefined
  const envUrl = envRaw ? normalizeRoot(envRaw)! : undefined
  const root = configuredUrl ?? envUrl ?? normalizeRoot(DEFAULT_MAGPIE_ROOT)!
  const token = config.apiKey?.trim() || DEFAULT_MAGPIE_TOKEN
  const hasApiKey = Boolean(config.apiKey?.trim())
  const configuredRoot = configuredUrl !== undefined || hasApiKey || envUrl !== undefined
  return { root, token, configuredRoot, local: isLoopback(root) }
}

// ---------------------------------------------------------------------------
// HTTP 读取
// ---------------------------------------------------------------------------

export const modelsUrl = (root: string): string => `${root}/v1/models`
export const quotasUrl = (root: string, kept = false): string =>
  `${root}/v1/magpie/quotas${kept ? '?kept=1' : ''}`
export const traceUrl = (root: string): string => `${root}/v1/magpie/trace`

/** 网络失败统一错误构造（脱敏：只含 URL 与原因，不含 token）。 */
export function gatewayError(code: string, message: string, status: number, details?: Record<string, unknown>): HelmError {
  return new HelmError(code, message, status, details)
}

/** 从错误文本中剥离已知 token（网关错误页可能回显 Authorization 头或 token 本体）。 */
function stripTokens(text: string, token: string): string {
  let out = text.replace(/Bearer\s+\S+/g, 'Bearer ***')
  if (token.length > 0) out = out.split(token).join('***')
  return out
}

/** GET 网关端点为 JSON；失败 throw（bounded wait，可取消；错误文本脱敏）。 */
export async function fetchJson(
  url: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  timeoutMs = 8_000,
): Promise<unknown> {
  // signal 在 fetch 前已 abort：立即终止，绝不发起请求
  signal.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(signal.reason)
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      const detail = stripTokens(body.trim(), token).slice(0, 200)
      throw new Error(`${url} answered ${response.status}${detail ? `: ${detail}` : ''}`)
    }
    return (await response.json()) as unknown
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** GET /v1/models 目录；失败 throw。 */
export async function fetchCatalog(
  root: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<MagpieModelEntry[]> {
  const body = await fetchJson(modelsUrl(root), token, signal, fetchImpl)
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error(`${modelsUrl(root)} did not answer a model list`)
  return data as MagpieModelEntry[]
}

/** GET /v1/magpie/quotas；失败 throw。kept=true 读 magpie 已缓存的读数（不问供应商）。 */
export async function fetchQuotas(
  root: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
  options: { kept?: boolean } = {},
): Promise<QuotaEntry[]> {
  const url = quotasUrl(root, options.kept)
  const body = await fetchJson(url, token, signal, fetchImpl)
  const data = (body as { data?: unknown })?.data
  if (!Array.isArray(data)) throw new Error(`${url} did not answer a quota list`)
  return data as QuotaEntry[]
}

/**
 * GET /v1/magpie/trace 路由轨迹。unavailable = 网关不能提供（远端拒绝或
 * 版本过旧）：不吞网络错误细节——失败原因如实返回，由调用方决定是否值得报告。
 */
export async function fetchTrace(
  root: string,
  token: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<{ routes: TraceRoute[] } | { unavailable: string }> {
  const url = traceUrl(root)
  let body: unknown
  try {
    body = await fetchJson(url, token, signal, fetchImpl)
  } catch (error) {
    return { unavailable: error instanceof Error ? error.message : String(error) }
  }
  const data = (body as { routes?: unknown })?.routes
  if (!Array.isArray(data)) return { unavailable: `${url} did not answer a route list` }
  return { routes: data as TraceRoute[] }
}
