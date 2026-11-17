/**
 * Hub HTTP client: the CLI's sole network boundary.
 * Success: entity/array directly; failure: {error:{code,message,details?}} (ApiErrorBody).
 * Credential priority: HELM_TOKEN / HELM_HUB_URL env > cli-token file > default 3202.
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
 * Resolve Hub URL and auth token.
 * Token trust boundary: explicit HELM_TOKEN takes precedence (caller guarantees it belongs to target Hub);
 * otherwise attach the stored token only when target baseUrl exactly matches the hubUrl recorded in
 * the credential file — never send an old Hub's token when HELM_HUB_URL points elsewhere.
 */
export function resolveEndpoint(env: NodeJS.ProcessEnv, credential: { hubUrl?: string; token?: string }): HubEndpoint {
  const envUrl = env['HELM_HUB_URL']?.trim()
  const baseUrl = normalizeUrl(envUrl || credential.hubUrl || DEFAULT_HUB_URL)
  if (env['HELM_TOKEN']) return { baseUrl, token: env['HELM_TOKEN'] }
  // Without env URL, baseUrl comes from credential.hubUrl (or default), so the token shares the same origin
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
   * Build headers for authenticated requests; fail explicitly with a hint when token is missing instead of sending unauthenticated requests.
   * auth:'optional' exception: attach token if present, still allow unauthenticated requests (e.g. /api/auth/status).
   */
  private authHeaders(extra: Record<string, string> = {}, optional = false): Record<string, string> {
    if (!this.endpoint.token) {
      if (optional) return extra
      throw new CliError(
        `No token configured (${this.endpoint.baseUrl}). Run helm login or set HELM_TOKEN.`,
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
    let message = text || `${where} returned HTTP ${response.status}`
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
      /* non-JSON error body: preserve raw text */
    }
    if (response.status === 401) {
      return new CliError(`${message} (unauthorized: ${this.endpoint.baseUrl}). Run helm login or set HELM_TOKEN.`, code, 1, details)
    }
    return new CliError(message, code, 1, details)
  }

  private async parseEntity<T>(response: Response, where: string): Promise<T> {
    const text = await response.text().catch(() => '')
    if (!response.ok) throw await this.toCliError(response, where, text)
    if (text === '') return undefined as T // empty body success such as 204 No Content
    try {
      return JSON.parse(text) as T
    } catch {
      throw new CliError(`Hub returned non-JSON response (${where}): ${text.slice(0, 200)}`, 'invalid_response')
    }
  }

  /**
   * Per-request timeout control: defaults to instance timeout; explicit timeoutMs overrides,
   * and 0 disables request timeout (--wait long-polling), preserving only caller signal cancellation.
   */
  private signalFor(timeoutMs: number | undefined, external?: AbortSignal): AbortSignal {
    const ms = timeoutMs !== undefined ? timeoutMs : this.timeoutMs
    if (ms <= 0) return external ?? new AbortController().signal
    const timeout = AbortSignal.timeout(ms)
    return external ? AbortSignal.any([timeout, external]) : timeout
  }

  /**
   * JSON request; omits request body when body is undefined. timeoutMs=0 disables the default timeout
   * (for --wait long waits); any other value overrides the instance default.
   * auth: true (default) requires token; false forces anonymous; 'optional' attaches token if present
   * and proceeds without one otherwise (used to probe public endpoints like status).
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
        throw new CliError(`request timed out (${ms}ms): ${method} ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled: ${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
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

  /** Binary content download: returns the raw Response (already verified 2xx). */
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
        throw new CliError(`request timed out (${this.timeoutMs}ms): GET ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled: GET ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `GET ${path}`)
    return response
  }

  /**
   * Binary artifact upload (POST /api/conversations/:id/artifacts):
   * application/octet-stream body + URL-encoded x-artifact-filename + optional MIME type.
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
        throw new CliError(`request timed out (${this.timeoutMs}ms): POST ${path}`, 'timeout')
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new CliError(`request cancelled: POST ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    return this.parseEntity<ArtifactMetadata>(response, `POST ${path}`)
  }

  /**
   * NDJSON streaming POST: consumes response.body chunk by chunk (never buffers the full response),
   * parsing each complete line as JSON and passing it to onLine; the trailing line may omit a newline.
   * Parse and consumer errors propagate directly; cancellation closes the reader so the Hub stops the command.
   * Connection/HTTP errors use the unified error envelope; AbortSignal cancels chunk-by-chunk immediately.
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
        throw new CliError(`request cancelled: ${method} ${path}`, 'aborted')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
        'hub_unreachable',
      )
    }
    if (!response.ok) throw await this.toCliError(response, `${method} ${path}`)
    if (!response.body) {
      throw new CliError(`Hub did not return a streaming response body (${method} ${path})`, 'invalid_response')
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim()
    if (contentType !== 'application/x-ndjson') {
      await response.body.cancel()
      throw new CliError(`Hub response content-type is not application/x-ndjson (${method} ${path})`, 'invalid_response')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const maxFrameBytes = 2 * 1024 * 1024
    let buffer = ''
    const consume = (line: string): void => {
      if (line.trim() === '') return
      if (Buffer.byteLength(line, 'utf8') > maxFrameBytes) {
        throw new CliError('Hub NDJSON frame exceeded maximum size limit', 'invalid_response')
      }
      let value: unknown
      try { value = JSON.parse(line) } catch {
        throw new CliError(`Hub NDJSON stream contained a non-JSON line (${method} ${path})`, 'invalid_response')
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
          throw new CliError('Hub NDJSON frame exceeded maximum size limit', 'invalid_response')
        }
      }
      opts.signal?.throwIfAborted()
      buffer += decoder.decode()
      consume(buffer)
    } catch (err) {
      if (opts.signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw new CliError(`stream cancelled: ${method} ${path}`, 'aborted')
      }
      throw err
    } finally {
      await reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /**
   * Subscribe to any GET SSE endpoint (shares framing parser with /api/events): handles both \n\n and \r\n\r\n,
   * forwarding event name and data payload to onFrame. Connection/HTTP errors use the unified envelope
   * (404 etc. throw structured CliError so callers can decide whether to stop retrying).
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
        throw new CliError(`connection timed out (${this.timeoutMs}ms): GET ${path}`, 'timeout')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
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
          if (dataLines.length === 0) continue // comment or keepalive frame
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`stream interrupted: GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }

  /**
   * Subscribe to `GET /api/events` via SSE. The timeout applies only to establishing the connection;
   * once open, the stream is controlled solely by the caller's AbortSignal.
   * Supports both \n\n and \r\n\r\n frame delimiters, forwarding event and data to onFrame.
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
        throw new CliError(`connection timed out (${this.timeoutMs}ms): GET ${path}`, 'timeout')
      }
      throw new CliError(
        `cannot connect to Hub (${this.endpoint.baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
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
          if (dataLines.length === 0) continue // comment or keepalive frame
          listeners.onFrame({ event, data: dataLines.join('\n') })
        }
      }
    } catch (err) {
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        if (callerAborted()) throw new CliError('cancelled', 'aborted')
        throw new CliError(`stream interrupted: GET ${path}`, 'aborted')
      }
      throw err
    } finally {
      reader.releaseLock()
      await (response.body as ReadableStream<Uint8Array>).cancel().catch(() => {})
    }
  }
}
