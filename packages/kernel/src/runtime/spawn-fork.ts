/**
 * 原生 subagent 上下文分叉派生（fork: true）的共享校验、继承解析与干净锚点计算。
 *
 * 职责：
 * - assertSpawnForkFields / resolveForkMode / resolveInheritedModelAndThinking /
 *   resolveInheritedModelOverride：由 runtime-agent-spawn.ts 与 spawn.ts 共同复用，
 *   确保入口校验、钩子 transform 复核、靶点继承与模型/思考档位收敛保持单一事实源。
 * - selectCleanForkAnchorEntryId：将对齐条目内消息按序扁平化追踪所属 entryIdx，
 *   定位全局最后一个 role === 'assistant' 消息，检查其后续（含同条目内）是否存在未
 *   闭合 toolCall；若有则截断到该 assistant 所在条目之前，同时拒绝仅有 system 或
 *   空 reset 的空壳。
 * - resolveCleanForkAnchor：从 Harness 读取父会话实时 ContextView 并返回安全正整数
 *   条目 ID；父会话缺失抛 404 not_found，无可分叉历史抛 409 fork_empty_history。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Models } from '@earendil-works/pi-ai'
import type { Harness } from '@earendil-works/pi-durable'
import { HelmError, type AgentSpawnRequest } from '@helm/protocol'
import { clampThinkingLevelForModel, parseModelRef, type ModelRefParts } from './models.js'

export interface ForkAnchorContextMessage {
  role?: string
  content?: unknown
  toolCallId?: string
}

export interface ForkAnchorContextView {
  entries: ReadonlyArray<{ id: number | string }>
  contributions: ReadonlyArray<ReadonlyArray<ForkAnchorContextMessage>>
}

export interface ForkModelAndThinkingInput {
  request: Pick<AgentSpawnRequest, 'fork' | 'model' | 'effort'>
  forkSameProfile: boolean
  profile: { model?: string; thinkingLevel?: string }
  parentSummary: { model?: string; thinkingLevel?: string; thinkingLevelOverride?: string } | undefined
  defaultModel: () => ModelRefParts
  defaultThinkingLevel?: () => string | undefined
  modelsForClamp?: Models
}

export interface ForkModelAndThinkingResult {
  resolvedModel: ModelRefParts
  createModelRef: string
  thinkingLevel: string | undefined
  thinkingLevelOverride: string | undefined
}

/** 校验 fork 字段类型以及 fork 与 resume 的互斥约束。 */
export function assertSpawnForkFields(request: Pick<AgentSpawnRequest, 'fork' | 'resume'>): void {
  if (request.fork !== undefined && typeof request.fork !== 'boolean') {
    throw new HelmError('validation_error', `fork 必须为 boolean（收到 ${typeof request.fork}）`, 400, {
      fork: request.fork,
    })
  }
  if (request.fork === true && request.resume !== undefined) {
    throw new HelmError(
      'validation_error',
      'fork 与 resume 互斥：不能同时从父会话分叉并续接既有子会话',
      400,
      { resume: request.resume },
    )
  }
}

/** 解析目标 Profile 与是否属「同角色 fork」。 */
export function resolveForkMode(
  requestedProfileId: string | undefined,
  isFork: boolean | undefined,
  parentProfileId: string | undefined,
  defaultProfileId = 'assistant',
): { profileId: string; forkSameProfile: boolean } {
  const explicit = requestedProfileId !== undefined && requestedProfileId !== '' ? requestedProfileId : undefined
  const profileId = explicit ?? (isFork === true && parentProfileId !== undefined ? parentProfileId : defaultProfileId)
  return {
    profileId,
    forkSameProfile: isFork === true && profileId === parentProfileId,
  }
}

/** 计算模型、思考档位及需要落库的 thinkingLevelOverride。 */
export function resolveInheritedModelAndThinking(
  input: ForkModelAndThinkingInput,
): ForkModelAndThinkingResult {
  const { request, forkSameProfile, profile, parentSummary, defaultModel, defaultThinkingLevel, modelsForClamp } = input
  const explicitModel = request.model ? parseModelRef(request.model) : undefined
  const profileModel = profile.model ? parseModelRef(profile.model) : undefined
  const parentModel = parentSummary?.model ? parseModelRef(parentSummary.model) : undefined
  const resolvedModel =
    request.fork === true
      ? (explicitModel ?? (forkSameProfile ? (parentModel ?? profileModel) : (profileModel ?? parentModel)) ?? defaultModel())
      : (explicitModel ?? profileModel ?? defaultModel())

  const parentThinking =
    (parentSummary?.thinkingLevelOverride && parentSummary.thinkingLevelOverride !== ''
      ? parentSummary.thinkingLevelOverride
      : undefined) ??
    (parentSummary?.thinkingLevel && parentSummary.thinkingLevel !== '' ? parentSummary.thinkingLevel : undefined)
  const inheritedLevel =
    request.fork === true
      ? (request.effort ?? (forkSameProfile ? (parentThinking ?? profile.thinkingLevel) : (profile.thinkingLevel ?? parentThinking)) ?? defaultThinkingLevel?.())
      : (request.effort ?? profile.thinkingLevel ?? defaultThinkingLevel?.())
  const thinkingLevel = modelsForClamp
    ? clampThinkingLevelForModel(modelsForClamp, resolvedModel, inheritedLevel)
    : inheritedLevel
  const thinkingLevelOverride =
    request.effort !== undefined
      ? thinkingLevel
      : forkSameProfile &&
          parentSummary?.thinkingLevelOverride !== undefined &&
          thinkingLevel !== undefined &&
          thinkingLevel !== ''
        ? thinkingLevel
        : undefined

  return {
    resolvedModel,
    createModelRef: `${resolvedModel.provider}/${resolvedModel.modelId}`,
    thinkingLevel,
    thinkingLevelOverride,
  }
}

/** 计算需要落库的 modelOverride（显式优先，其次同角色 fork 继承父会话覆盖）。 */
export function resolveInheritedModelOverride(
  requestModel: string | undefined,
  forkSameProfile: boolean,
  parentModelOverride: string | undefined,
): string | undefined {
  if (requestModel !== undefined && requestModel !== '') return requestModel
  return forkSameProfile ? parentModelOverride : undefined
}

function collectToolCallIds(content: unknown): Set<string> {
  const callIds = new Set<string>()
  if (!Array.isArray(content)) return callIds
  for (const block of content) {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'toolCall' &&
      typeof (block as { id?: unknown }).id === 'string'
    ) {
      callIds.add((block as { id: string }).id)
    }
  }
  return callIds
}

/**
 * 从对齐的 ContextView 中选择干净的分叉锚点条目 ID：
 * - 将 entries[0..len-1] 的贡献消息按序扁平化并记录所属 entryIdx；
 * - 找到全局最后一个 role === 'assistant' 消息（下标 lastAssistantFlatIdx、所属条目
 *   lastAssistantEntryIdx），收集其 toolCall ID，检查 flat.slice(lastAssistantFlatIdx + 1)
 *   中是否全部已有匹配 role === 'toolResult'（同时兼容跨条目与同条目 [assistant, toolResult]）；
 * - 若存在未闭合 toolCall，截断到 lastAssistantEntryIdx；否则保留到末尾 len；
 * - 截断后区间内必须至少包含一条非 system 消息；返回末尾条目的安全正整数 ID。
 */
export function selectCleanForkAnchorEntryId(view: ForkAnchorContextView): number | undefined {
  const len = Math.min(view.entries.length, view.contributions.length)
  if (len <= 0) return undefined

  const flat: Array<{ entryIdx: number; msg: ForkAnchorContextMessage }> = []
  for (let i = 0; i < len; i += 1) {
    for (const msg of view.contributions[i] ?? []) {
      if (msg !== null && typeof msg === 'object') {
        flat.push({ entryIdx: i, msg })
      }
    }
  }

  let lastAssistantFlatIdx = -1
  let lastAssistantEntryIdx = -1
  for (let k = flat.length - 1; k >= 0; k -= 1) {
    if (flat[k]!.msg.role === 'assistant') {
      lastAssistantFlatIdx = k
      lastAssistantEntryIdx = flat[k]!.entryIdx
      break
    }
  }

  let cutIndex = len
  if (lastAssistantFlatIdx >= 0) {
    const callIds = collectToolCallIds(flat[lastAssistantFlatIdx]!.msg.content)
    if (callIds.size > 0) {
      const resolvedIds = new Set<string>()
      for (const item of flat.slice(lastAssistantFlatIdx + 1)) {
        if (item.msg.role === 'toolResult' && typeof item.msg.toolCallId === 'string') {
          resolvedIds.add(item.msg.toolCallId)
        }
      }
      for (const id of callIds) {
        if (!resolvedIds.has(id)) {
          cutIndex = lastAssistantEntryIdx
          break
        }
      }
    }
  }

  if (cutIndex <= 0) return undefined
  const hasNonSystem = flat.some((item) => item.entryIdx < cutIndex && item.msg.role !== 'system')
  if (!hasNonSystem) return undefined

  const rawId = view.entries[cutIndex - 1]!.id
  const entryId =
    typeof rawId === 'number'
      ? rawId
      : typeof rawId === 'string' && /^\d+$/.test(rawId)
        ? Number(rawId)
        : Number.NaN
  if (!Number.isSafeInteger(entryId) || entryId <= 0) return undefined
  return entryId
}

/**
 * 读取父会话当前 ContextView 并解析干净的分叉锚点条目 ID。
 * 父会话不存在抛 404 not_found；无已完成可分叉历史抛 409 fork_empty_history。
 */
export async function resolveCleanForkAnchor(
  harness: Harness,
  parentConversationId: number,
): Promise<number> {
  const conv = await harness.conversation(parentConversationId as never, BACKGROUND_CONTEXT)
  if (!conv) {
    throw new HelmError('not_found', `父会话不存在：${parentConversationId}`, 404, {
      parentConversationId,
    })
  }
  const view = await conv.context(BACKGROUND_CONTEXT)
  const anchorEntryId = selectCleanForkAnchorEntryId(view)
  if (anchorEntryId === undefined) {
    throw new HelmError(
      'fork_empty_history',
      '父会话尚无已完成的可分叉上下文条目，无法执行 fork 派生',
      409,
      { parentConversationId },
    )
  }
  return anchorEntryId
}
