/**
 * Magpie gateway model catalog (GET /v1/models) -> pi-ai Model conversion.
 *
 * The mapping corresponds one-to-one with pi-magpie v0.1.6 catalog.ts:
 * - native_endpoints decide the request protocol and baseUrl (/v1/responses -> OpenAI Responses
 *   on {root}/v1; /v1/messages -> Anthropic Messages on {root}; anything else ->
 *   OpenAI Chat Completions on {root}/v1）；
 * - reasoning levels -> thinkingLevelMap (pi's off maps the model's own none;
 *   when Anthropic lacks a none tier, keep the off key and let the SDK send the disable-thinking request);
 * - Claude 4.6+ supports adaptive thinking only: compat.forceAdaptiveThinking = true.
 */
import type { Model, Provider } from '@earendil-works/pi-ai'

/** One catalog entry of GET /v1/models. */
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
  /** The API path this model is natively forwarded on (decides the request protocol). */
  native_endpoints?: string[]
  /** The magpie provider serving it (the routing group is its first member's provider). */
  owned_by?: string
}

/** pi's thinking levels (pi-ai MODEL_THINKING_LEVELS), low to high. */
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** The two API paths Magpie forwards natively. */
export const MAGPIE_PATHS = {
  responses: '/v1/responses',
  anthropic: '/v1/messages',
} as const

export type MagpieApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages'

/**
 * Decide the request protocol and baseUrl mount point by the model's natively forwarded API:
 * - 'root' -> baseUrl = {root} (the SDK appends /v1 itself);
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

/** This shape's model baseUrl. */
export function baseUrlFor(root: string, endpoint: 'root' | 'v1'): string {
  return endpoint === 'root' ? root : `${root}/v1`
}

/**
 * Model reasoning levels -> pi thinkingLevelMap: each pi level maps to the model's own
 * level (off -> none); levels the model lacks are hidden as null. On Anthropic Messages,
 * when off is missing the key is kept (the SDK uses it to send a disable-thinking request).
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

/** claude-opus-5-5 / claude-sonnet-4.6 etc. (ids may carry a namespace prefix). */
const CLAUDE_VERSION = /claude-(?:opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2}))?(?:[^0-9]|$)/

/**
 * Whether a Claude supports adaptive thinking only: from 4.6, `thinking.type=enabled` + a budget
 * gets rejected (requires adaptive thinking); the request must switch to adaptive thinking.
 */
export function adaptiveThinking(modelId: string): boolean {
  const match = CLAUDE_VERSION.exec(modelId.toLowerCase())
  if (!match || !match[1]) return false
  const major = Number(match[1])
  const minor = Number(match[2] ?? 0)
  return major > 4 || (major === 4 && minor >= 6)
}

/** Catalog-entry fallback defaults (minimal conservative values for pi-ai Model's required fields; not probed values). */
export const DEFAULT_CONTEXT_WINDOW = 128_000
export const DEFAULT_MAX_TOKENS = 16_384

/**
 * The pi models this plugin builds carry magpieOwnedBy (for per-provider quota attribution) and
 * helmContextWindowKnown (whether the upstream window is really known; see HelmModelSourceMeta in
 * runtime/models.ts). Model<MagpieApi>'s compat field distributes conditionally by api;
 * openai-completions models have no compat field, so the extra fields are expressed precisely via a cross type.
 */
export type PiMagpieModel = Model<MagpieApi> & {
  magpieOwnedBy?: string
  helmContextWindowKnown?: boolean
}

/** One catalog entry -> a pi model. */
export function toPiModel(entry: MagpieModelEntry, root: string): PiMagpieModel {
  const { api, endpoint } = magpieApi(entry.native_endpoints)
  const efforts = (entry.supported_reasoning_levels ?? [])
    .map((level) => level?.effort)
    .filter((effort): effort is string => typeof effort === 'string' && effort.length > 0)
  const input = (entry.modalities?.input ?? []).filter(
    (modality): modality is 'text' | 'image' => modality === 'text' || modality === 'image',
  )
  const contextWindow = entry.context_length ?? entry.context_window ?? entry.max_input_tokens
  const upstreamWindow = positive(contextWindow)
  const model: PiMagpieModel = {
    id: entry.id,
    name: entry.display_name?.trim() || entry.id,
    api,
    provider: 'magpie',
    baseUrl: baseUrlFor(root, endpoint),
    input: input.length > 0 ? input : ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // magpie records "can reason" and "has levels" separately: reasoning:true + empty levels is a
    // model with only a thinking toggle and no effort levels; both keep the reasoning flag.
    reasoning: entry.reasoning === true || efforts.length > 0,
    // Only a positive upstream window counts as known; the fallback value must never pose as a real
    // window (contextUsage does not show a percentage based on it).
    contextWindow: upstreamWindow ?? DEFAULT_CONTEXT_WINDOW,
    helmContextWindowKnown: upstreamWindow !== undefined,
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

/** The whole catalog -> a pi model list (entries without ids dropped). */
export function toPiModels(entries: readonly MagpieModelEntry[], root: string): PiMagpieModel[] {
  return entries
    .filter((entry) => typeof entry?.id === 'string' && entry.id.length > 0)
    .map((entry) => toPiModel(entry, root))
}

/** The magpie provider owning a catalog entry: owned_by first, then the id's provider prefix. */
export function ownedByOf(entry: MagpieModelEntry): string | undefined {
  if (entry.owned_by) return entry.owned_by
  const slash = entry.id.indexOf('/')
  return slash > 0 ? entry.id.slice(0, slash) : undefined
}

function positive(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Whether a persisted model belongs to the given gateway root (filtering old catalogs of other roots at cache recovery). */
export function servedByRoot(model: PiMagpieModel, root: string): boolean {
  return model.baseUrl === root || model.baseUrl === baseUrlFor(root, 'v1')
}

/** Provider type re-export (used by provider.ts / magpie.ts). */
export type { Provider }
