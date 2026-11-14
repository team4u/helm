/**
 * Magpie 网关模型目录（GET /v1/models）→ pi-ai Model 转换。
 *
 * 映射与 pi-magpie v0.1.6 catalog.ts 一一对应：
 * - native_endpoints 决定请求协议与 baseUrl（/v1/responses → OpenAI Responses
 *   on {root}/v1；/v1/messages → Anthropic Messages on {root}；其余 →
 *   OpenAI Chat Completions on {root}/v1）；
 * - reasoning levels → thinkingLevelMap（pi 的 off 映射模型自身 none；
 *   Anthropic 无 none 档时保留 off 键交由 SDK 发送禁用 thinking）；
 * - Claude 4.6+ 仅支持 adaptive thinking：compat.forceAdaptiveThinking = true。
 */
import type { Model, Provider } from '@earendil-works/pi-ai'

/** GET /v1/models 的单条目录项。 */
export interface MagpieModelEntry {
  id: string
  display_name?: string
  context_length?: number
  context_window?: number
  max_input_tokens?: number
  max_output_tokens?: number
  modalities?: { input?: string[] }
  reasoning?: boolean
  supported_reasoning_levels?: Array<{ effort?: string }>
  /** 该模型被原生转发的 API 路径（决定请求协议）。 */
  native_endpoints?: string[]
  /** 供应它的 magpie provider（路由组为其首个成员的 provider）。 */
  owned_by?: string
}

/** pi 的 thinking 档位（pi-ai MODEL_THINKING_LEVELS），由低到高。 */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** Magpie 原生转发的两条 API 路径。 */
export const MAGPIE_PATHS = {
  responses: '/v1/responses',
  anthropic: '/v1/messages',
} as const

export type MagpieApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/**
 * 按模型被原生转发的 API 决定请求协议与 baseUrl 挂点：
 * - 'root' → baseUrl = {root}（SDK 自行追加 /v1）；
 * - 'v1'   → baseUrl = {root}/v1。
 */
export function magpieApi(nativeEndpoints: readonly string[] | undefined): {
  api: MagpieApi
  endpoint: 'root' | 'v1'
} {
  const native = nativeEndpoints ?? []
  if (native.includes(MAGPIE_PATHS.responses)) return { api: 'openai-responses', endpoint: 'v1' }
  if (native.includes(MAGPIE_PATHS.anthropic)) return { api: 'anthropic-messages', endpoint: 'root' }
  return { api: 'openai-completions', endpoint: 'v1' }
}

/** 该形态模型的 baseUrl。 */
export function baseUrlFor(root: string, endpoint: 'root' | 'v1'): string {
  return endpoint === 'root' ? root : `${root}/v1`
}

/**
 * 模型 reasoning levels → pi thinkingLevelMap：pi 的每个档位映射模型自身
 * 档位（off → none），模型没有的档位以 null 隐藏。Anthropic Messages 上
 * off 缺失时保留键（SDK 据此发送禁用 thinking 的请求）。
 */
export function thinkingLevelMap(
  efforts: readonly string[],
  anthropic: boolean,
): Record<string, string | null> | undefined {
  if (efforts.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const level of PI_THINKING_LEVELS) {
    const effort = level === 'off' ? 'none' : level
    map[level] = efforts.includes(effort) ? effort : null
  }
  if (anthropic && map.off === null) delete map.off
  return map
}

/** claude-opus-5-5 / claude-sonnet-4.6 等（id 可带命名空间前缀）。 */
const CLAUDE_VERSION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:[^0-9]|$)/

/**
 * Claude 是否仅支持 adaptive thinking：4.6 起 `thinking.type=enabled` + 预算
 * 会被拒绝（requires adaptive thinking），必须改请求 adaptive thinking。
 */
export function adaptiveThinking(modelId: string): boolean {
  const match = CLAUDE_VERSION.exec(modelId.toLowerCase())
  if (!match || !match[1]) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 4 || (major === 4 && minor >= 6)
}

/** 目录项缺省兜底（pi-ai Model 必填字段的最小保守值，非探测值）。 */
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384

/**
 * 本插件构建的 pi 模型：携带 magpieOwnedBy（供配额按 provider 归属）。
 * Model<MagpieApi> 的 compat 字段按 api 条件分布；openai-completions 模型
 * 无 compat 字段，故以交叉类型精确表达「magpieOwnedBy 附加字段」。
 */
export type PiMagpieModel = Model<MagpieApi> & { magpieOwnedBy?: string }

/** 单条目录项 → pi 模型。 */
export function toPiModel(entry: MagpieModelEntry, root: string): PiMagpieModel {
  const { api, endpoint } = magpieApi(entry.native_endpoints)
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map((level) => level?.effort)
    .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
  const input = (entry.modalities?.input ?? []).filter(
    (modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image',
  )
  const contextWindow = entry.context_length ?? entry.context_window ?? entry.max_input_tokens
  const model: PiMagpieModel = {
    id: entry.id,
    name: entry.display_name?.trim() || entry.id,
    api,
    provider: 'magpie',
    baseUrl: baseUrlFor(root, endpoint),
    input: input.length > 0 ? input : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // magpie 将「会推理」与「有档位」分开记录：reasoning:true + 空档位是
    // 只有思考开关无努力档的模型，两种都保留 reasoning 标记。
    reasoning: entry.reasoning === true || efforts.length > 0,
    contextWindow: positive(contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: positive(entry.max_output_tokens) ?? DEFAULT_MAX_TOKENS,
  }
  if (entry.owned_by) model.magpieOwnedBy = entry.owned_by
  const levels = thinkingLevelMap(efforts, api === 'anthropic-messages')
  if (levels) model.thinkingLevelMap = levels
  if (api === 'anthropic-messages' && adaptiveThinking(entry.id)) {
    model.compat = { forceAdaptiveThinking: true }
  }
  return model
}

/** 整个目录 → pi 模型列表（无 id 条目丢弃）。 */
export function toPiModels(entries: readonly MagpieModelEntry[], root: string): PiMagpieModel[] {
  return entries
    .filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0)
    .map((entry) => toPiModel(entry, root))
}

/** 目录项归属的 magpie provider：owned_by 优先，其次 id 的 provider 前缀。 */
export function ownedByOf(entry: MagpieModelEntry): string | undefined {
  if (entry.owned_by) return entry.owned_by
  const slash = entry.id.indexOf('/')
  return slash > 0 ? entry.id.slice(0, slash) : undefined
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** 持久化模型是否属于指定网关 root（缓存恢复时过滤其它 root 的旧目录）。 */
export function servedByRoot(model: PiMagpieModel, root: string): boolean {
  return model.baseUrl === root || model.baseUrl === baseUrlFor(root, 'v1')
}

/** Provider 类型再导出（provider.ts / magpie.ts 使用）。 */
export type { Provider }
