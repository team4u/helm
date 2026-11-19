import type {
  ActionManifest,
  ArtifactMetadata,
  AskSpec,
  AuthStatus,
  AuthToken,
  ConversationCompactResponse,
  ConversationDetail,
  ConversationEntry,
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
  ModelProvidersRefreshResult,
  NodeHealthSnapshot,
  NodeInfo,
  NodeIssuedToken,
  NodeBlockedRelease,
  NodeUpgradeCheckInput,
  NodeUpgradeCheckResult,
  NodeUpgradeInput,
  NodeUpgradeResult,
  PluginConfigFieldSchema,
  PluginConfigFieldSource,
  PluginDoctorReport,
  PluginInstallResult,
  PluginRemoveResult,
  PluginSummary,
  PluginUpdateResult,
  Profile,
  ProviderConfig,
  PublicPluginDoc,
  PublicPluginSessionDoc,
  SearchHit,
  SetModelFilterBody,
  SkillSummary,
  ConversationWithdrawRequest,
  ConversationWithdrawResponse,
  WhenBusy,
} from '@helmx/protocol/browser'

export interface SubmitInputPayload {
  text: string
  origin?: InputOrigin
  whenBusy?: WhenBusy
  meta?: Record<string, unknown>
  attachments?: string[]
  /** 历史编辑重发：覆盖该 entry 及其后全部条目（服务端执行 rewind 重放）。 */
  replaceFromEntryId?: number
}

const TOKEN_STORAGE_KEY = 'helmx:token'
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
  } catch { /* Storage disabled: this tab keeps in-memory credentials. */ }
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
        data.error.message ?? `Request failed (${res.status})`,
        res.status,
        data.error.details,
      )
    }
  } catch {
    // 非 JSON 错误响应
  }
  return new ApiClientError(`http_${res.status}`, `Request failed (${res.status} ${res.statusText})`, res.status)
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
  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/api/auth/')) window.dispatchEvent(new Event('helmx:unauthorized'))
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
  list(filter?: ConversationListFilter, opts?: { signal?: AbortSignal }): Promise<ConversationSummary[]> {
    const params = new URLSearchParams()
    if (filter?.profileId) params.set('profileId', filter.profileId)
    if (filter?.tag) params.set('tag', filter.tag)
    if (filter?.status) params.set('status', filter.status)
    const qs = params.toString()
    return apiRequest<ConversationSummary[]>('GET', `/api/conversations${qs ? `?${qs}` : ''}`, undefined, opts?.signal)
  },
  getDetail(id: number, opts?: { limit?: number; cursor?: string; signal?: AbortSignal }): Promise<ConversationDetail> {
    const params = new URLSearchParams()
    if (opts?.limit !== undefined) params.set('limit', String(opts.limit))
    if (opts?.cursor) params.set('cursor', opts.cursor)
    const qs = params.toString()
    return apiRequest<ConversationDetail>('GET', `/api/conversations/${id}${qs ? `?${qs}` : ''}`, undefined, opts?.signal)
  },
  /** 单条目全文取回（服务端时间线预览截断时；返回完整 ConversationEntry）。 */
  getEntry(id: number, entryId: string | number, opts?: { signal?: AbortSignal }): Promise<ConversationEntry> {
    // entryId 是与 ConversationEntry.id 对应的安全正整数（数字字符串）；
    // 严格整数字符串校验与 fork/withdraw 同一防错锚点，绝不容忍 '3oops' 锚定 3。
    const raw = String(entryId)
    const numericEntryId = typeof entryId === 'number' ? entryId : /^[0-9]+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(numericEntryId) || !Number.isSafeInteger(numericEntryId) || numericEntryId <= 0) {
      throw new ApiClientError(
        'validation_error',
        `entryId must be a safe positive integer (got ${String(entryId)})`,
        400,
        { entryId },
      )
    }
    return apiRequest<ConversationEntry>('GET', `/api/conversations/${id}/entries/${numericEntryId}`, undefined, opts?.signal)
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
    // 契约 ConversationForkRequest 要求 entryId 为安全正整数；ConversationEntry.id 是数字字符串。
    // 严格整数字符串正则：拒绝空白/小数/指数/尾杂字符（Number.parseInt('3oops')===3 属错锚点，绝不容忍）。
    const raw = String(entryId)
    const numericEntryId = typeof entryId === 'number' ? entryId : /^[0-9]+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(numericEntryId) || !Number.isSafeInteger(numericEntryId) || numericEntryId <= 0) {
      throw new ApiClientError(
        'validation_error',
        `entryId must be a safe positive integer (got ${String(entryId)})`,
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
  withdraw(id: number, submissionId: string | number): Promise<ConversationWithdrawResponse> {
    // 契约 ConversationWithdrawRequest 要求 submissionId 为安全正整数；严格整数字符串正则与 fork 一致。
    const raw = String(submissionId)
    const numericId = typeof submissionId === 'number' ? submissionId : /^[0-9]+$/.test(raw) ? Number(raw) : NaN
    if (!Number.isInteger(numericId) || !Number.isSafeInteger(numericId) || numericId <= 0) {
      throw new ApiClientError(
        'validation_error',
        `submissionId must be a safe positive integer (got ${String(submissionId)})`,
        400,
        { submissionId },
      )
    }
    const body: ConversationWithdrawRequest = { submissionId: numericId }
    return apiRequest<ConversationWithdrawResponse>('POST', `/api/conversations/${id}/withdraw`, body)
  },
  listArtifacts(id: number, opts?: { signal?: AbortSignal }): Promise<ArtifactMetadata[]> {
    return apiRequest<ArtifactMetadata[]>('GET', `/api/conversations/${id}/artifacts`, undefined, opts?.signal)
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
  async fetchWorkspaceFileBlob(
    conversationId: number,
    path: string,
    inline = true,
    signal?: AbortSignal,
  ): Promise<Blob> {
    const res = await fetch(
      `/api/conversations/${conversationId}/files/content?path=${encodeURIComponent(path)}${inline ? '&inline=1' : ''}`,
      { headers: buildAuthHeaders(), signal },
    )
    if (!res.ok) {
      throw await parseErrorResponse(res)
    }
    return await res.blob()
  },
  async downloadWorkspaceFileToBrowser(
    conversationId: number,
    path: string,
    filename: string,
  ): Promise<void> {
    const blob = await this.fetchWorkspaceFileBlob(conversationId, path, false)
    triggerBlobDownload(blob, filename)
  },
}

function triggerBlobDownload(blob: Blob, filename: string): void {
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
    triggerBlobDownload(blob, filename)
  },
}

// ---------------------------------------------------------------------------
// Nodes（跨平台计算节点）
// ---------------------------------------------------------------------------

export const nodesApi = {
  list: (opts?: { signal?: AbortSignal }) => apiRequest<NodeInfo[]>('GET', '/api/nodes', undefined, opts?.signal),
  issueToken: (nodeId: string) =>
    apiRequest<NodeIssuedToken>('POST', '/api/nodes/issue', { nodeId }),
  remove: (nodeId: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/nodes/${encodeURIComponent(nodeId)}`),
  checkUpgrade: (nodeId: string, registryUrl?: string) => {
    const qs = registryUrl ? `?registryUrl=${encodeURIComponent(registryUrl)}` : ''
    return apiRequest<NodeUpgradeCheckResult>('GET', `/api/nodes/${encodeURIComponent(nodeId)}/upgrade/check${qs}`)
  },
  upgrade: (nodeId: string, input: NodeUpgradeInput = {}) =>
    apiRequest<NodeUpgradeResult>(
      'POST',
      `/api/nodes/${encodeURIComponent(nodeId)}/upgrade`,
      input,
    ),
}

// ---------------------------------------------------------------------------
// Asks
// ---------------------------------------------------------------------------

export const asksApi = {
  list: (opts?: { signal?: AbortSignal }) => apiRequest<AskSpec[]>('GET', '/api/asks', undefined, opts?.signal),
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
  /** 用户显式禁用（目录标注；available 仍表示凭据可用，两者独立）。 */
  disabled?: boolean
  label?: string
  /** 该模型支持的思考档位（缺省仅 off）。 */
  thinkingLevels: string[]
  /** 真实已知的模型上下文窗口（tokens）；未知省略。 */
  contextWindow?: number
}

export interface ModelCatalogInfo {
  models: ModelDescriptor[]
  /** 全局默认模型（未配置省略）。 */
  defaultModel?: string
  /** 全局默认思考档位（未配置省略）。 */
  defaultThinkingLevel?: string
  /** 全局压缩模型（未配置省略）。 */
  defaultCompactionModel?: string
  /** 全局压缩思考档位（未配置省略）。 */
  defaultCompactionThinkingLevel?: string
}

/** 解析 GET /api/models：新版 { models, thinkingLevels, defaultModel } 形状。 */
export function normalizeModelCatalogInfo(raw: unknown): ModelCatalogInfo {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !('models' in raw) || !Array.isArray((raw as { models?: unknown }).models)) {
    throw new Error('Invalid model catalog format')
  }
  const body = raw as {
    models: unknown[]
    thinkingLevels?: unknown
    defaultModel?: unknown
    defaultThinkingLevel?: unknown
    defaultCompactionModel?: unknown
    defaultCompactionThinkingLevel?: unknown
  }
  const levelsRaw = body.thinkingLevels && typeof body.thinkingLevels === 'object' && !Array.isArray(body.thinkingLevels)
    ? body.thinkingLevels as Record<string, unknown>
    : {}
  const models = body.models.map((item: unknown): ModelDescriptor => {
    if (item === null || typeof item !== 'object') throw new Error('Invalid model catalog entry format')
    const entry = item as Partial<ModelCatalogEntry>
    if (
      typeof entry.provider !== 'string' ||
      typeof entry.modelId !== 'string' ||
      typeof entry.available !== 'boolean'
    ) {
      throw new Error('Invalid model catalog entry format')
    }
    const id = `${entry.provider}/${entry.modelId}`
    const levels = levelsRaw[id]
    // 窗口边界校验：出现即必须是有限正数（真实已知 tokens）；非法显式拒绝，未知省略。
    if (
      entry.contextWindow !== undefined &&
      (typeof entry.contextWindow !== 'number' || !Number.isFinite(entry.contextWindow) || entry.contextWindow <= 0)
    ) {
      throw new Error('Invalid model catalog entry format')
    }
    return {
      id,
      provider: entry.provider,
      modelId: entry.modelId,
      available: entry.available,
      ...(entry.disabled === true ? { disabled: true } : {}),
      ...(entry.contextWindow !== undefined ? { contextWindow: entry.contextWindow } : {}),
      thinkingLevels: Array.isArray(levels) && levels.every((level) => typeof level === 'string') && levels.length > 0 ? levels as string[] : ['off'],
    }
  })
  return {
    models,
    ...(typeof body.defaultModel === 'string' && body.defaultModel !== '' ? { defaultModel: body.defaultModel } : {}),
    ...(typeof body.defaultThinkingLevel === 'string' && body.defaultThinkingLevel !== '' ? { defaultThinkingLevel: body.defaultThinkingLevel } : {}),
    ...(typeof body.defaultCompactionModel === 'string' && body.defaultCompactionModel !== '' ? { defaultCompactionModel: body.defaultCompactionModel } : {}),
    ...(typeof body.defaultCompactionThinkingLevel === 'string' && body.defaultCompactionThinkingLevel !== ''
      ? { defaultCompactionThinkingLevel: body.defaultCompactionThinkingLevel }
      : {}),
  }
}

export const assetsApi = {
  listProfiles: (opts?: { signal?: AbortSignal }) => apiRequest<Profile[]>('GET', '/api/profiles', undefined, opts?.signal),
  getProfile: (id: string, opts?: { signal?: AbortSignal }) =>
    apiRequest<Profile>('GET', `/api/profiles/${encodeURIComponent(id)}`, undefined, opts?.signal),
  createProfile: (profile: Profile) => apiRequest<Profile>('POST', '/api/profiles', profile),
  updateProfile: (id: string, profile: Omit<Profile, 'id'> & { id?: string }) =>
    apiRequest<Profile>('PUT', `/api/profiles/${encodeURIComponent(id)}`, profile),
  deleteProfile: (id: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/profiles/${encodeURIComponent(id)}`),

  listProviders: (opts?: { signal?: AbortSignal }) => apiRequest<ProviderConfig[]>('GET', '/api/providers', undefined, opts?.signal),
  saveProviders: (providers: ProviderConfig[]) =>
    apiRequest<ProviderConfig[]>('PUT', '/api/providers', { providers }),

  listCredentials: (opts?: { signal?: AbortSignal }) => apiRequest<CredentialSummary[]>('GET', '/api/credentials', undefined, opts?.signal),
  setCredential: (id: string, value: string) =>
    apiRequest<{ ok: boolean }>('PUT', `/api/credentials/${encodeURIComponent(id)}`, { value }),
  deleteCredential: (id: string) =>
    apiRequest<{ ok: boolean }>('DELETE', `/api/credentials/${encodeURIComponent(id)}`),

  listModels: async (opts?: { signal?: AbortSignal }) =>
    normalizeModelCatalogInfo(await apiRequest<unknown>('GET', '/api/models', undefined, opts?.signal)).models,
  getDefaultModel: (opts?: { signal?: AbortSignal }) =>
    apiRequest<{
      defaultModel: string
      defaultThinkingLevel: string
      modelThinkingLevels: Record<string, string>
      defaultCompactionModel?: string
      defaultCompactionThinkingLevel?: string
    }>('GET', '/api/models/default', undefined, opts?.signal),
  setDefaultModel: (
    model?: string,
    thinkingLevel?: string,
    compactionModel?: string,
    compactionThinkingLevel?: string,
    modelThinking?: { model: string; level: string },
    modelThinkingLevels?: Record<string, string>,
  ) =>
    apiRequest<{
      ok: boolean
      defaultModel: string
      defaultThinkingLevel: string
      modelThinkingLevels: Record<string, string>
      defaultCompactionModel?: string
      defaultCompactionThinkingLevel?: string
    }>('PUT', '/api/models/default', {
      ...(model !== undefined ? { model } : {}),
      ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
      ...(compactionModel !== undefined ? { compactionModel } : {}),
      ...(compactionThinkingLevel !== undefined ? { compactionThinkingLevel } : {}),
      ...(modelThinking !== undefined ? { modelThinking: modelThinking.model, modelThinkingLevel: modelThinking.level } : {}),
      ...(modelThinkingLevels !== undefined ? { modelThinkingLevels } : {}),
    }),
  listModelProviders: (opts?: { signal?: AbortSignal }) =>
    apiRequest<ModelProviderSummary[]>('GET', '/api/models/providers', undefined, opts?.signal),
  refreshModels: (providers?: string[]) =>
    apiRequest<ModelProvidersRefreshResult>('POST', '/api/models/refresh', providers && providers.length > 0 ? { providers } : {}),
  setModelFilter: (body: SetModelFilterBody) =>
    apiRequest<{ ok: boolean; catalog: ModelCatalogInfo }>('PUT', '/api/models/filter', body),

  listSkills: (opts?: { signal?: AbortSignal }) => apiRequest<SkillSummary[]>('GET', '/api/skills', undefined, opts?.signal),
  readSkill: (id: string, path?: string, opts?: { signal?: AbortSignal }) => {
    const qs = path ? `?path=${encodeURIComponent(path)}` : ''
    return apiRequest<{ text: string }>('GET', `/api/skills/${encodeURIComponent(id)}${qs}`, undefined, opts?.signal)
  },
}

// ---------------------------------------------------------------------------
// Plugins / Actions / Public Docs
// ---------------------------------------------------------------------------

export interface PluginConfigResponse {
  values: Record<string, unknown>
  schema: Record<string, PluginConfigFieldSchema>
  /** 各字段当前生效来源（configured | default | unset）；旧内核可缺省。 */
  sources?: Record<string, PluginConfigFieldSource>
}

export const pluginsApi = {
  list: (opts?: { signal?: AbortSignal }) => apiRequest<PluginSummary[]>('GET', '/api/plugins', undefined, opts?.signal),
  enable: (id: string) =>
    apiRequest<PluginSummary[]>('POST', `/api/plugins/${encodeURIComponent(id)}/enable`),
  /** 停用插件；force: true 用于在知情前提下越过 409 plugin_in_use 占用拦截。 */
  disable: (id: string, opts?: { force?: boolean }) =>
    apiRequest<PluginSummary[]>(
      'POST',
      `/api/plugins/${encodeURIComponent(id)}/disable`,
      opts?.force === true ? { force: true } : undefined,
    ),
  getConfig: (id: string, opts?: { signal?: AbortSignal }) =>
    apiRequest<PluginConfigResponse>('GET', `/api/plugins/${encodeURIComponent(id)}/config`, undefined, opts?.signal),
  setConfig: (id: string, values: Record<string, unknown>) =>
    apiRequest<{ ok: boolean }>('PUT', `/api/plugins/${encodeURIComponent(id)}/config`, { values }),
  /** 外部插件源码静态自检（POST /api/plugins/doctor）；body 为 { id } 或 { path }。 */
  doctor: (target: { id: string } | { path: string }) =>
    apiRequest<PluginDoctorReport>('POST', '/api/plugins/doctor', target),
  /** 安装外部插件包（POST /api/plugins/install）。 */
  install: (source: string, enable?: boolean) =>
    apiRequest<PluginInstallResult>('POST', '/api/plugins/install', {
      source,
      ...(enable ? { enable: true } : {}),
    }),
  /** 更新已安装的外部插件包（POST /api/plugins/:id/update）。 */
  update: (id: string) =>
    apiRequest<PluginUpdateResult>('POST', `/api/plugins/${encodeURIComponent(id)}/update`),
  /** 移除已安装的外部插件包（POST /api/plugins/:id/remove）。 */
  remove: (id: string) =>
    apiRequest<PluginRemoveResult>('POST', `/api/plugins/${encodeURIComponent(id)}/remove`),
  getPublicDoc: (pluginId: string, name: string, opts?: { signal?: AbortSignal }) =>
    apiRequest<PublicPluginDoc>(
      'GET',
      `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}`,
      undefined,
      opts?.signal,
    ),
  /** 会话级文档一次性读取（扩展同一路径 ?conversationId=；订阅式更新用 usePluginSessionDoc）。 */
  getPublicSessionDoc: (
    pluginId: string,
    name: string,
    conversationId: number,
    opts?: { signal?: AbortSignal },
  ) =>
    apiRequest<PublicPluginSessionDoc>(
      'GET',
      `/api/plugins/${encodeURIComponent(pluginId)}/docs/${encodeURIComponent(name)}?conversationId=${conversationId}`,
      undefined,
      opts?.signal,
    ),
  listActions: (opts?: { signal?: AbortSignal }) =>
    apiRequest<ActionManifest[]>('GET', '/api/actions', undefined, opts?.signal),
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
// Search
// ---------------------------------------------------------------------------

export const searchApi = {
  query: (q: string, opts?: { signal?: AbortSignal }) =>
    apiRequest<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, opts?.signal),
}
