import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  AuthStatus,
  AuthToken,
  ConversationCompactResponse,
  ConversationDetail,
  ConversationForkRequest,
  ConversationInit,
  ConversationInputResult,
  ConversationPatch,
  ConversationStatus,
  ConversationSummary,
  CredentialSummary,
  InputOrigin,
  ModelCatalogEntry,
  ModelProviderSummary,
  PluginConfigFieldSchema,
  PluginSummary,
  Profile,
  ProviderConfig,
  PublicPluginDoc,
  SavedWorkflowSummary,
  SearchHit,
  SkillSummary,
  WhenBusy,
  WorkflowRunRequest,
  WorkflowRunSummary,
} from '@helm/protocol'

// HTTP 请求/响应形状以 @helm/protocol 为唯一事实源；下列别名仅兼容既有导入。
export type {
  AuthStatus,
  AuthToken,
  CredentialSummary,
  ModelCatalogEntry,
  SavedWorkflowSummary,
  SearchHit,
  ConversationForkRequest,
  ConversationCompactResponse,
}
export type AuthStatusResponse = AuthStatus
export type AuthTokenResponse = AuthToken
export type CredentialStatus = CredentialSummary

export interface SubmitInputPayload {
  text: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  meta?: Record<string, unknown>
  attachments?: string[]
}

const TOKEN_STORAGE_KEY = 'helm:token'
let memoryToken: string | null | undefined

export function getStoredToken(): string | null {
  if (memoryToken !== undefined) return memoryToken
  try { return localStorage.getItem(TOKEN_STORAGE_KEY) } catch { return null }
}

export function setStoredToken(token: string | null): void {
  memoryToken = token || null
  try {
    if (memoryToken === null) localStorage.removeItem(TOKEN_STORAGE_KEY)
    else localStorage.setItem(TOKEN_STORAGE_KEY, memoryToken)
  } catch { /* 禁用存储时，本次标签页仍保留内存凭据。 */ }
}

export class ApiClientError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.status = status
    this.details = details
  }
}

function buildAuthHeaders(extra?: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { ...(extra ?? {}) }
  const token = getStoredToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return headers
}

async function parseErrorResponse(res: Response): Promise<ApiClientError> {
  try {
    const data = (await res.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> }
    }
    if (data && typeof data === 'object' && data.error) {
      return new ApiClientError(
        data.error.code ?? `http_${res.status}`,
        data.error.message ?? `请求失败 (${res.status})`,
        res.status,
        data.error.details,
      )
    }
  } catch {
    // 非 JSON 错误响应
  }
  return new ApiClientError(`http_${res.status}`, `请求失败 (${res.status} ${res.statusText})`, res.status)
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const hasBody = body !== undefined
  const headers = buildAuthHeaders(hasBody ? { 'Content-Type': 'application/json' } : undefined)
  const res = await fetch(path, {
    method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
    signal,
  })
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('helm:unauthorized'))
  if (!res.ok) throw await parseErrorResponse(res)
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export const authApi = {
  status: () => apiRequest<AuthStatus>('GET', '/api/auth/status'),
  setup: (password: string) => apiRequest<AuthToken>('POST', '/api/auth/setup', { password }),
  login: (password: string) => apiRequest<AuthToken>('POST', '/api/auth/login', { password }),
}

// ---------------------------------------------------------------------------
// Conversations & Context Ops & Artifacts
// ---------------------------------------------------------------------------

export interface ConversationListFilter {
  profileId?: string
  tag?: string
  status?: ConversationStatus
}

export const conversationsApi = {
  list(filter?: ConversationListFilter): Promise<ConversationSummary[]> {
    const params = new URLSearchParams()
    if (filter?.profileId) params.set('profileId', filter.profileId)
    if (filter?.tag) params.set('tag', filter.tag)
    if (filter?.status) params.set('status', filter.status)
    const qs = params.toString()
    return apiRequest<ConversationSummary[]>('GET', `/api/conversations${qs ? `?${qs}` : ''}`)
  },
  getDetail(id: number, opts?: { limit?: number; cursor?: string }): Promise<ConversationDetail> {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return apiRequest<ConversationDetail>('GET', `/api/conversations/${id}${qs ? `?${qs}` : ''}`)
  },
  create(init?: ConversationInit): Promise<ConversationSummary> {
    return apiRequest<ConversationSummary>('POST', '/api/conversations', init ?? {})
  },
  patch(id: number, patch: ConversationPatch): Promise<ConversationSummary> {
    return apiRequest<ConversationSummary>('PATCH', `/api/conversations/${id}`, patch)
  },
  remove(id: number): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>('DELETE', `/api/conversations/${id}`)
  },
  submitInput(
    id: number,
    input: SubmitInputPayload,
    opts?: { wait?: boolean },
  ): Promise<{ submissionId: string } | ConversationInputResult> {
    const qs = opts?.wait ? '?wait=1' : ''
    return apiRequest<{ submissionId: string } | ConversationInputResult>(
      'POST',
      `/api/conversations/${id}/input${qs}`,
      input,
    )
  },
  abort(id: number): Promise<{ ok: boolean }> {
    return apiRequest<{ ok: boolean }>('POST', `/api/conversations/${id}/abort`)
  },
  reset(id: number, handoff?: string): Promise<ConversationSummary> {
    return apiRequest<ConversationSummary>(
      'POST',
      `/api/conversations/${id}/reset`,
      handoff !== undefined && handoff.trim() !== '' ? { handoff } : {},
    )
  },
  compact(id: number, instructions?: string): Promise<ConversationCompactResponse> {
    return apiRequest<ConversationCompactResponse>(
      'POST',
      `/api/conversations/${id}/compact`,
      instructions !== undefined && instructions.trim() !== '' ? { instructions } : {},
    )
  },
  fork(id: number, entryId: string | number, title?: string): Promise<ConversationSummary> {
    // 契约 ConversationForkRequest 要求 entryId 为正整数；ConversationEntry.id 是数字字符串，须先转换。
    const numericEntryId = typeof entryId === 'number' ? entryId : Number.parseInt(String(entryId), 10)
    if (!Number.isInteger(numericEntryId) || numericEntryId <= 0) {
      throw new ApiClientError(
        'validation_error',
        `entryId 需为正整数（收到 ${String(entryId)}）`,
        400,
        { entryId },
      )
    }
    const body: ConversationForkRequest = {
      entryId: numericEntryId,
      ...(title !== undefined && title.trim() !== '' ? { title } : {}),
    }
    return apiRequest<ConversationSummary>('POST', `/api/conversations/${id}/fork`, body)
  },
  listArtifacts(id: number): Promise<ArtifactMetadata[]> {
    return apiRequest<ArtifactMetadata[]>('GET', `/api/conversations/${id}/artifacts`)
  },
  async uploadArtifact(id: number, file: File): Promise<ArtifactMetadata> {
    const bytes = await file.arrayBuffer()
    const headers = buildAuthHeaders({
      'Content-Type': 'application/octet-stream',
      'X-Artifact-Filename': encodeURIComponent(file.name || 'attachment.bin'),
      ...(file.type ? { 'X-Artifact-Mime-Type': file.type } : {}),
    })
    const res = await fetch(`/api/conversations/${id}/artifacts`, {
      method: 'POST',
      headers,
      body: bytes,
    })
    if (!res.ok) {
      throw await parseErrorResponse(res)
    }
    return (await res.json()) as ArtifactMetadata
  },
}

// ---------------------------------------------------------------------------
// Artifacts Content (带 Bearer 鉴权的二进制/文本拉取)
// ---------------------------------------------------------------------------

export const artifactsApi = {
  async fetchBlob(artifactId: string, inline = true): Promise<Blob> {
    const res = await fetch(
      `/api/artifacts/${encodeURIComponent(artifactId)}/content${inline ? '?inline=1' : ''}`,
      { headers: buildAuthHeaders() },
    )
    if (!res.ok) {
      throw await parseErrorResponse(res)
    }
    return await res.blob()
  },
  async fetchText(artifactId: string): Promise<string> {
    const blob = await this.fetchBlob(artifactId, true)
    return await blob.text()
  },
  async downloadToBrowser(artifactId: string, filename: string): Promise<void> {
    const blob = await this.fetchBlob(artifactId, false)
    const url = URL.createObjectURL(blob)
    try {
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 5_000)
    }
  },
}

// ---------------------------------------------------------------------------
// Asks
// ---------------------------------------------------------------------------

export const asksApi = {
  list: () => apiRequest<AskSpec[]>('GET', '/api/asks'),
  answer: (askId: string, answers: Record<string, string>, expectedStateSeq?: number) =>
    apiRequest<{ ok: boolean }>('POST', `/api/asks/${encodeURIComponent(askId)}/answer`, {
      answers,
      ...(expectedStateSeq !== undefined ? { expectedStateSeq } : {}),
    }),
  cancel: (askId: string) =>
    apiRequest<{ ok: boolean }>('POST', `/api/asks/${encodeURIComponent(askId)}/cancel`),
}

// ---------------------------------------------------------------------------
// Profiles / Providers / Credentials / Models / Skills
// ---------------------------------------------------------------------------

export interface ModelDescriptor {
  id: string
  provider: string
  modelId: string
  available: boolean
  label?: string
}

export function normalizeModelCatalog(raw: unknown): ModelDescriptor[] {
  if (!Array.isArray(raw)) throw new Error('模型目录格式无效')
  return raw.map((item: unknown): ModelDescriptor => {
    if (item === null || typeof item !== 'object') throw new Error('模型目录条目格式无效')
    const entry = item as Partial<ModelCatalogEntry>
    if (
      typeof entry.provider !== 'string' ||
      typeof entry.modelId !== 'string' ||
      typeof entry.available !== 'boolean'
    ) {
      throw new Error('模型目录条目格式无效')
    }
    return {
      id: `${entry.provider}/${entry.modelId}`,
      provider: entry.provider,
      modelId: entry.modelId,
      available: entry.available,
    }
  })
}

export const assetsApi = {
  listProfiles: () => apiRequest<Profile[]>('GET', '/api/profiles'),
  getProfile: (id: string) => apiRequest<Profile>('GET', `/api/profiles/${encodeURIComponent(id)}`),
  createProfile: (profile: Profile) => apiRequest<Profile>('POST', '/api/profiles', profile),
  updateProfile: (id: string, profile: Omit<Profile, 'id'> & { id?: string }) =>
    apiRequest<Profile>('PUT', `/api/profiles/${encodeURIComponent(id)}`, profile),
  deleteProfile: (id: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/profiles/${encodeURIComponent(id)}`),

  listProviders: () => apiRequest<ProviderConfig[]>('GET', '/api/providers'),
  saveProviders: (providers: ProviderConfig[]) =>
    apiRequest<ProviderConfig[]>('PUT', '/api/providers', { providers }),

  listCredentials: () => apiRequest<CredentialSummary[]>('GET', '/api/credentials'),
  setCredential: (id: string, value: string) =>
    apiRequest<{ ok: boolean }>('PUT', `/api/credentials/${encodeURIComponent(id)}`, { value }),
  deleteCredential: (id: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/credentials/${encodeURIComponent(id)}`),

  listModels: async () => normalizeModelCatalog(await apiRequest<unknown>('GET', '/api/models')),
  listModelProviders: () => apiRequest<ModelProviderSummary[]>('GET', '/api/models/providers'),

  listSkills: () => apiRequest<SkillSummary[]>('GET', '/api/skills'),
  readSkill: (id: string, path?: string) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : ''
    return apiRequest<{ text: string }>('GET', `/api/skills/${encodeURIComponent(id)}${qs}`)
  },
}

// ---------------------------------------------------------------------------
// Plugins / Actions / Public Docs
// ---------------------------------------------------------------------------

export interface PluginConfigResponse {
  values: Record<string, unknown>
  schema: Record<string, PluginConfigFieldSchema>
}

export const pluginsApi = {
  list: () => apiRequest<PluginSummary[]>('GET', '/api/plugins'),
  enable: (id: string) =>
    apiRequest<PluginSummary[]>('POST', `/api/plugins/${encodeURIComponent(id)}/enable`),
  disable: (id: string) =>
    apiRequest<PluginSummary[]>('POST', `/api/plugins/${encodeURIComponent(id)}/disable`),
  getConfig: (id: string) =>
    apiRequest<PluginConfigResponse>('GET', `/api/plugins/${encodeURIComponent(id)}/config`),
  setConfig: (id: string, values: Record<string, unknown>) =>
    apiRequest<{ ok: boolean }>('PUT', `/api/plugins/${encodeURIComponent(id)}/config`, { values }),
  getPublicDoc: (pluginId: string, name: string) =>
    apiRequest<PublicPluginDoc>(
      'GET',
      `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`,
    ),
  listActions: () => apiRequest<ActionManifest[]>('GET', '/api/actions'),
  invokeAction: <T = unknown>(
    pluginId: string,
    actionId: string,
    input: unknown,
    conversationId?: number,
  ) =>
    apiRequest<T>(
      'POST',
      `/api/actions/${encodeURIComponent(pluginId)}/${encodeURIComponent(actionId)}`,
      {
        input: input ?? {},
        ...(conversationId !== undefined ? { conversationId } : {}),
      },
    ),
}

// ---------------------------------------------------------------------------
// Workflows & Search
// ---------------------------------------------------------------------------

/** 兼容后端 `{ name, path, description?, whenToUse?, phases? }` 形状（SavedWorkflowSummary 契约）。 */
export function normalizeSavedWorkflows(raw: unknown): SavedWorkflowSummary[] {
  if (!Array.isArray(raw)) throw new Error('工作流目录格式无效')
  return raw.map((item: unknown): SavedWorkflowSummary => {
    if (item === null || typeof item !== 'object') throw new Error('工作流目录条目格式无效')
    const entry = item as Record<string, unknown>
    if (typeof entry.name !== 'string') throw new Error('工作流目录条目格式无效')
    return {
      name: entry.name,
      ...(typeof entry.path === 'string' ? { path: entry.path } : {}),
      ...(typeof entry.description === 'string' ? { description: entry.description } : {}),
      ...(typeof entry.whenToUse === 'string' ? { whenToUse: entry.whenToUse } : {}),
      ...(Array.isArray(entry.phases) ? { phases: entry.phases as SavedWorkflowSummary['phases'] } : {}),
    }
  })
}

export const workflowsApi = {
  listSaved: async () => normalizeSavedWorkflows(await apiRequest<unknown>('GET', '/api/workflows')),
  listRuns: (conversationId?: number) => {
    const qs = conversationId !== undefined ? `?conversationId=${conversationId}` : ''
    return apiRequest<WorkflowRunSummary[]>('GET', `/api/workflows/runs${qs}`)
  },
  getRun: (runId: string) =>
    apiRequest<WorkflowRunSummary>('GET', `/api/workflows/runs/${encodeURIComponent(runId)}`),
  run: (req: WorkflowRunRequest, wait?: boolean) =>
    apiRequest<WorkflowRunSummary>('POST', `/api/workflows/run${wait ? '?wait=1' : ''}`, req),
  abort: (runId: string) =>
    apiRequest<{ ok: boolean }>('POST', `/api/workflows/runs/${encodeURIComponent(runId)}/abort`),
}

export const searchApi = {
  query: (q: string) =>
    apiRequest<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`),
}
