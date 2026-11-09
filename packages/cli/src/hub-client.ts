/**
 * Hub HTTP 客户端：CLI 的唯一网络边界。
 * 成功：直接实体/数组；失败：{error:{code,message,details?}}（ApiErrorBody）。
 * 凭据优先级：HELM_TOKEN / HELM_HUB_URL env > cli-token 文件 > 默认 3202。
 */
import type { ApiErrorBody, ArtifactMetadata } from '@helm/protocol'
import { CliError } from './errors.js'
import type { Io } from './options.js'

export const DEFAULT_HUB_URL = 'http://127.0.0.1:3202'
const DEFAULT_TIMEOUT_MS = 30_000

const normalizeUrl = (url: string): string => url.trim().replace(/\/+$/, '')

export interface HubEndpoint {
  baseUrl: string
  token?: string
}

/**
 * 解析 Hub 地址与 Token。
 * Token 信任边界：HELM_TOKEN 显式给出则优先（用户自己保证它属于目标 Hub）；
 * 否则仅当目标 baseUrl 与凭据文件记录的 hubUrl 完全一致时才附带存储的
 * token——HELM_HUB_URL 指向另一个 Hub 时绝不把旧 Hub 的 token 发过去。
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, credential: { hubUrl?: string; token?: string }): HubEndpoint {
  const envUrl = env['HELM_HUB_URL']?.trim()
  const baseUrl = normalizeUrl(envUrl || credential.hubUrl || DEFAULT_HUB_URL)
  if (env['HELM_TOKEN']) return { baseUrl, token: env['HELM_TOKEN'] }
  // 无 env URL 时 baseUrl 必然来自 credential.hubUrl（或默认值），token 同源可用
  const sameHub = !envUrl || !credential.hubUrl || normalizeUrl(credential.hubUrl) === baseUrl
  return { baseUrl, token: sameHub ? credential.token : undefined }
}

export class HubClient {
  constructor(
    private readonly endpoint: HubEndpoint,
    private readonly io: Io,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  get baseUrl(): string {
    return this.endpoint.baseUrl
  }

  /**
   * 需要鉴权的请求构造 headers；无 token 时如实报错（提示来源），不静默裸奔。
   * auth:'optional' 例外：有 token 附带，无 token 也放行（如 /api/auth/status）。
   */
  private authHeaders(extra: Record<string, string> = {}, optional = false): Record<string, string> {
    if (!this.endpoint.token) {
      if (optional) return extra
      throw new CliError(
        `未配置 Token（${this.endpoint.baseUrl}）。运行 helm login，或设置 HELM_TOKEN。`,
        'unauthorized',
      )
    }
    return { authorization: `Bearer ${this.endpoint.token}`, ...extra }
  }

  private signal(external?: AbortSignal): AbortSignal {
    return this.signalFor(undefined, external)
  }

  private async toCliError(response: Response, where: string, preloadedText?: string): Promise<CliError> {
    const text = preloadedText ?? (await response.text().catch(() => ''))
    let message = text || `${where} 返回 HTTP ${response.status}`
    let code = `http_${response.status}`
    let details: unknown
    try {
      const parsed = JSON.parse(text) as Partial<ApiErrorBody>
      if (parsed && typeof parsed === 'object' && parsed.error) {
        const { error } = parsed
        if (typeof error.code === 'string') code = error.code
        if (typeof error.message === 'string') message = error.message
        if ('details' in error) details = error.details
      }
    } catch {
      /* 非 JSON 错误体：保留原文 */
    }
    if (response.status === 401) {
      return new CliError(`${message}（未授权：${this.endpoint.baseUrl}）。运行 helm login 或设置 HELM_TOKEN。`, code, 1, details)
    }
    return new CliError(message, code, 1, details)
  }

  private async parseEntity<T>(response: Response, where: string): Promise<T> {
    const text = await response.text().catch(() => '')
    if (!response.ok) throw await this.toCliError(response, where, text)
    if (text === '') return undefined as T // 204 No Content 等空体成功
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CliError(`Hub 返回非 JSON 响应（${where}）：${text.slice(0, 200)}`, 'invalid_response')
    }
  }

  /**
   * 本请求超时控制：缺省用实例默认；timeoutMs 显式给出时覆盖，0 表示
   * 不施加请求超时（--wait 长等待路径），仅保留调用方 signal 取消。
   */
  private signalFor(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal {
    const ms = timeoutMs !== undefined ? timeoutMs : this.timeoutMs
    if (ms <= 0) return external ?? new AbortController().signal
    const timeout = AbortSignal.timeout(ms)
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

  /**
   * JSON 请求；body 为 undefined 时不发送请求体。timeoutMs=0 表示不施加
   * 默认请求超时（wait 长等待），其余值覆盖实例默认。
   * auth：true（默认）必须带 token；false 明确匿名；'optional' 有 token 附带、
   * 无 token 也放行（用于 status 等公开端点的鉴权状态探测）。
   */
  async request<T>(method: string, path: string, opts: { body?: unknown; auth?: boolean | 'optional'; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    const headers: Record<string, string> = {}
    if (opts.auth === 'optional') Object.assign(headers, this.authHeaders({}, true))
    else if (opts.auth !== false) Object.assign(headers, this.authHeaders())
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: this.signalFor(opts.timeoutMs, opts.signal),
        redirect: 'error',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        const ms = opts.timeoutMs !== undefined ? opts.timeoutMs : this.timeoutMs
        throw new CliError(`请求超时（${ms}ms）：${method} ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`请求已取消：${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    return this.parseEntity<T>(response, `${method} ${path}`)
  }

  get<T>(path: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>('GET', path, { signal })
  }

  post<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>('POST', path, { body: body ?? {}, signal })
  }

  put<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PUT', path, { body: body ?? {} })
  }

  patch<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { body: body ?? {} })
  }

  delete<T>(path: string): Promise<T> {
    return this.request<T>('DELETE', path)
  }

  /** 二进制内容下载：返回原始 Response（已校验 2xx）。 */
  async raw(path: string, signal?: AbortSignal): Promise<Response> {
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        headers: this.authHeaders(),
        signal: this.signal(signal),
        redirect: 'error',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new CliError(`请求超时（${this.timeoutMs}ms）：GET ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`请求已取消：GET ${path}`, 'aborted')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `GET ${path}`)
    return response
  }

  /**
   * 二进制产物上传（POST /api/conversations/:id/artifacts）：
   * application/octet-stream 流 + x-artifact-filename（URL 编码）+ 可选 mime。
   */
  async uploadArtifact(
    conversationId: number,
    fileName: string,
    bytes: Uint8Array,
    mimeType?: string,
  ): Promise<ArtifactMetadata> {
    const path = `/api/conversations/${conversationId}/artifacts`
    const headers = this.authHeaders({
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent(fileName),
      ...(mimeType !== undefined ? { 'x-artifact-mime-type': mimeType } : {}),
    })
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: bytes as unknown as BodyInit,
        signal: this.signal(undefined),
        redirect: 'error',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'TimeoutError') {
        throw new CliError(`请求超时（${this.timeoutMs}ms）：POST ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`请求已取消：POST ${path}`, 'aborted')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    return this.parseEntity<ArtifactMetadata>(response, `POST ${path}`)
  }

  /**
   * NDJSON 流式 POST：逐块消费 response.body（绝不先缓冲全响应再伪流），
   * 每完整一行解析为一个 JSON 对象回调 onLine；尾行允许省略换行符。
   * 解析错误与消费方错误分别上抛，取消时关闭 reader 让 Hub 停止命令。
   * 建连/HTTP 错误复用统一错误信封；signal 支持逐块取消（立即断开）。
   */
  async streamNdjson(
    method: string,
    path: string,
    opts: { body?: unknown; onLine: (value: unknown) => void; signal?: AbortSignal } = { onLine: () => {} },
  ): Promise<void> {
    const headers = this.authHeaders({ accept: 'application/x-ndjson' })
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts.signal,
        redirect: 'error',
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`请求已取消：${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `${method} ${path}`)
    if (!response.body) {
      throw new CliError(`Hub 未返回流式响应体（${method} ${path}）`, 'invalid_response')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (contentType !== 'application/x-ndjson') {
      await response.body.cancel()
      throw new CliError(`Hub 响应类型不是 application/x-ndjson（${method} ${path}）`, 'invalid_response')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const maxFrameBytes = 2 * 1024 * 1024
    let buffer = ''
    const consume = (line: string): void => {
      if (line.trim() === '') return
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        throw new CliError('Hub NDJSON 帧超过大小上限', 'invalid_response')
      }
      let value: unknown
      try { value = JSON.parse(line) } catch {
        throw new CliError(`Hub NDJSON 流中出现非 JSON 行（${method} ${path}）`, 'invalid_response')
      }
      opts.onLine(value)
    }
    try {
      for (;;) {
        opts.signal?.throwIfAborted()
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let newline = buffer.indexOf('\n')
        while (newline !== -1) {
          consume(buffer.slice(0, newline))
          buffer = buffer.slice(newline + 1)
          newline = buffer.indexOf('\n')
        }
        if (Buffer.byteLength(buffer, 'utf8') > maxFrameBytes) {
          throw new CliError('Hub NDJSON 帧超过大小上限', 'invalid_response')
        }
      }
      opts.signal?.throwIfAborted()
      buffer += decoder.decode()
      consume(buffer)
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new CliError(`流已取消：${method} ${path}`, 'aborted')
      }
      throw err
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /**
   * SSE 订阅任意 GET 端点（专用事件流复用同一解析器）：帧解析兼容 \n\n 与
   * \r\n\r\n；event: 名与 data: JSON 均上抛给 onFrame。建连/HTTP 错误统一
   * 信封（404 等结构化错误原样抛 CliError，调用方据此决定是否停止重试）。
   */
  async streamSse(
    path: string,
    listeners: {
      onFrame: (frame: { event: string; data: string }) => void
      signal?: AbortSignal
    },
  ): Promise<void> {
    const connectController = new AbortController()
    const connectTimer = setTimeout(() => connectController.abort(), this.timeoutMs)
    connectTimer.unref?.()
    const callerAborted = (): boolean => listeners.signal?.aborted === true
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        headers: this.authHeaders({ accept: 'text/event-stream' }),
        signal: AbortSignal.any([connectController.signal, ...(listeners.signal ? [listeners.signal] : [])]),
        redirect: 'error',
      })
    } catch (err) {
      clearTimeout(connectTimer)
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (callerAborted()) throw new CliError('已取消', 'aborted')
        throw new CliError(`建连超时（${this.timeoutMs}ms）：GET ${path}`, 'timeout')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    clearTimeout(connectTimer)
    if (callerAborted()) throw new CliError('已取消', 'aborted')
    if (!response.ok || !response.body) throw await this.toCliError(response, `GET ${path}`)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          let event = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length === 0) continue // 注释/keepalive 帧
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (callerAborted()) throw new CliError('已取消', 'aborted')
        throw new CliError(`流中断：GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }

  /**
   * SSE 订阅 `GET /api/events`。超时仅约束建连阶段；流建立后由调用方 signal 控制。
   * 帧解析兼容 \n\n 与 \r\n\r\n；event: 名与 data: JSON 均上抛给 onFrame。
   */
  async streamEvents(
    listeners: {
      onFrame: (frame: { event: string; data: string }) => void
      signal?: AbortSignal
    },
  ): Promise<void> {
    const path = '/api/events'
    const connectController = new AbortController()
    const connectTimer = setTimeout(() => connectController.abort(), this.timeoutMs)
    connectTimer.unref?.()
    const callerAborted = (): boolean => listeners.signal?.aborted === true
    let response: Response
    try {
      response = await this.io.fetchImpl(`${this.endpoint.baseUrl}${path}`, {
        headers: this.authHeaders({ accept: 'text/event-stream' }),
        signal: AbortSignal.any([connectController.signal, ...(listeners.signal ? [listeners.signal] : [])]),
        redirect: 'error',
      })
    } catch (err) {
      clearTimeout(connectTimer)
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (callerAborted()) throw new CliError('已取消', 'aborted')
        throw new CliError(`建连超时（${this.timeoutMs}ms）：GET ${path}`, 'timeout')
      }
      throw new CliError(
        `无法连接 Hub（${this.endpoint.baseUrl}）：${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    clearTimeout(connectTimer)
    if (callerAborted()) throw new CliError('已取消', 'aborted')
    if (!response.ok || !response.body) throw await this.toCliError(response, `GET ${path}`)
    const reader = (response.body as ReadableStream<Uint8Array>).getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer = (buffer + decoder.decode(value, { stream: true })).replaceAll('\r\n', '\n')
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          let event = 'message'
          const dataLines: string[] = []
          for (const line of block.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim()
            else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
          }
          if (dataLines.length === 0) continue // 注释/keepalive 帧
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (callerAborted()) throw new CliError('已取消', 'aborted')
        throw new CliError(`流中断：GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }
}
