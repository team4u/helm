/**
 * Hub HTTP client:CLI unique network boundary.
 * succeeded: directly entity/array; failed:{error:{code,message,details?}}(ApiErrorBody).
 * credentials priority:HELM_TOKEN / HELM_HUB_URL env > cli-token file > by default 3202.
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
 * parse Hub address and Token.
 * Token trust boundary:HELM_TOKEN explicit to out then takes precedence (user itself guarantee it belongs to target Hub);
 * otherwise only when target baseUrl and credentials file record hubUrl fully consistent when only then attach carries store
 * token- -HELM_HUB_URL points to another Hub when never old Hub  token remove.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, credential: { hubUrl?: string; token?: string }): HubEndpoint {
  const envUrl = env['HELM_HUB_URL']?.trim()
  const baseUrl = normalizeUrl(envUrl || credential.hubUrl || DEFAULT_HUB_URL)
  if (env['HELM_TOKEN']) return { baseUrl, token: env['HELM_TOKEN'] }
  // without env URL when baseUrl must however from credential.hubUrl(or default value),token same source available
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
   * need to authentication request construct headers; without token when such as errors (hint source), not silently bare run.
   * auth:'optional' exception: has token attach carries, without token also let through (such as /api/auth/status).
   */
  private authHeaders(extra: Record<string, string> = {}, optional = false): Record<string, string> {
    if (!this.endpoint.token) {
      if (optional) return extra
      throw new CliError(
        `not config Token(${this.endpoint.baseUrl}). run helm login, or settings HELM_TOKEN.`,
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
    let message = text || `${where} return HTTP ${response.status}`
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
      /* non- JSON error body: keep original text */
    }
    if (response.status === 401) {
      return new CliError(`${message}(unauthorized:${this.endpoint.baseUrl}). run helm login or settings HELM_TOKEN.`, code, 1, details)
    }
    return new CliError(message, code, 1, details)
  }

  private async parseEntity<T>(response: Response, where: string): Promise<T> {
    const text = await response.text().catch(() => '')
    if (!response.ok) throw await this.toCliError(response, where, text)
    if (text === '') return undefined as T // 204 No Content etc. empty body succeeded
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CliError(`Hub return non- JSON response (${where}):${text.slice(0, 200)}`, 'invalid_response')
    }
  }

  /**
   * this request timeout control: default use instance by default;timeoutMs explicit to out when override,0 means
   * do not apply add request timeout (--wait long wait for path), only keep caller signal cancel.
   */
  private signalFor(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal {
    const ms = timeoutMs !== undefined ? timeoutMs : this.timeoutMs
    if (ms <= 0) return external ?? new AbortController().signal
    const timeout = AbortSignal.timeout(ms)
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

  /**
   * JSON request;body is undefined when do not send request body.timeoutMs=0 means do not apply add
   * by default request timeout (wait long wait for), the rest value override instance by default.
   * auth:true(by default) must carries token;false explicit anonymous;'optional' has token attach carries,
   * without token also let through (used to status etc. public end point authentication state probe).
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
        throw new CliError(`request timeout (${ms}ms):${method} ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled:${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
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

  /** two enter system content download: return original Response(already validate 2xx). */
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
        throw new CliError(`request timeout (${this.timeoutMs}ms):GET ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled:GET ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `GET ${path}`)
    return response
  }

  /**
   * two enter system artifact upload (POST /api/conversations/:id/artifacts):
   * application/octet-stream stream + x-artifact-filename(URL encode)+ optional mime.
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
        throw new CliError(`request timeout (${this.timeoutMs}ms):POST ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled:POST ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    return this.parseEntity<ArtifactMetadata>(response, `POST ${path}`)
  }

  /**
   * NDJSON streaming POST: one by one chunk consume response.body(never first buffer all response again fake stream),
   * each complete one row parse is a JSON object call back onLine; tail row allows omit newline symbol.
   * parse error and consumer error respectively on throw, cancel when close reader let Hub stop command.
   * create connect/HTTP error re- use unify error message seal;signal support one by one chunk cancel (immediately disconnect).
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
        throw new CliError(`request cancelled:${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `${method} ${path}`)
    if (!response.body) {
      throw new CliError(`Hub not return streaming response body (${method} ${path})`, 'invalid_response')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (contentType !== 'application/x-ndjson') {
      await response.body.cancel()
      throw new CliError(`Hub response type is not application/x-ndjson(${method} ${path})`, 'invalid_response')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const maxFrameBytes = 2 * 1024 * 1024
    let buffer = ''
    const consume = (line: string): void => {
      if (line.trim() === '') return
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        throw new CliError('Hub NDJSON frame exceeds large small cap', 'invalid_response')
      }
      let value: unknown
      try { value = JSON.parse(line) } catch {
        throw new CliError(`Hub NDJSON stream in appear non- JSON row (${method} ${path})`, 'invalid_response')
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
          throw new CliError('Hub NDJSON frame exceeds large small cap', 'invalid_response')
        }
      }
      opts.signal?.throwIfAborted()
      buffer += decoder.decode()
      consume(buffer)
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new CliError(`stream cancelled:${method} ${path}`, 'aborted')
      }
      throw err
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /**
   * SSE subscribe any GET end point (dedicated use event stream re- use the same parse): frame parse compatibility \n\n and
   * \r\n\r\n;event: name and data: JSON all on throw to onFrame. create connect/HTTP error unify
   * message seal (404 etc. structure error original throw CliError, caller based on this decide is otherwise stop retry).
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
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`create connect timeout (${this.timeoutMs}ms):GET ${path}`, 'timeout')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    clearTimeout(connectTimer)
    if (callerAborted()) throw new CliError('cancelled', 'aborted')
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
          if (dataLines.length === 0) continue // note release/keepalive frame
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`stream interrupt:GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }

  /**
   * SSE subscribe `GET /api/events`. timeout only constraint create connect phase; stream establish after by caller signal control.
   * frame parse compatibility \n\n and \r\n\r\n;event: name and data: JSON all on throw to onFrame.
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
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`create connect timeout (${this.timeoutMs}ms):GET ${path}`, 'timeout')
      }
      throw new CliError(
        `cannot connect Hub(${this.endpoint.baseUrl}):${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    clearTimeout(connectTimer)
    if (callerAborted()) throw new CliError('cancelled', 'aborted')
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
          if (dataLines.length === 0) continue // note release/keepalive frame
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`stream interrupt:GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }
}
