/**
 * original generate subagent context fork derive (fork: true) sharing validate, inherit parse and clean anchor compute.
 *
 * responsibility:
 * - assertSpawnForkFields / resolveForkMode / resolveInheritedModelAndThinking /
 *   resolveInheritedModelOverride: by runtime-agent-spawn.ts and spawn.ts jointly re- use,
 *   ensure entry validate, hook transform re-check, target inherit and model/think Profile converge keep single one fact source.
 * - selectCleanForkAnchorEntryId: align item inside message by order flat append trace which belong entryIdx,
 *   locate global finally a role === 'assistant' message, check its after continue (contains same item inside) is otherwise store in not
 *   closed together toolCall; if has then truncate to the assistant which in item before, also reject only has system or
 *   empty reset empty shell.
 * - resolveCleanForkAnchor: from Harness read parent conversation real-time ContextView and return security positive integer
 *   item ID; parent conversation missing throw 404 not_found, without can fork history throw 409 fork_empty_history.
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

/** validate fork field type and fork and resume mutual exclusion constraint. */
export function assertSpawnForkFields(request: Pick<AgentSpawnRequest, 'fork' | 'resume'>): void {
  if (request.fork !== undefined && typeof request.fork !== 'boolean') {
    throw new HelmError('validation_error', `fork must is boolean(receives ${typeof request.fork})`, 400, {
      fork: request.fork,
    })
  }
  if (request.fork === true && request.resume !== undefined) {
    throw new HelmError(
      'validation_error',
      'fork and resume mutual exclusion: cannot also from parent conversation fork and resume since has sub-conversation',
      400,
      { resume: request.resume },
    )
  }
}

/** parse target Profile and is otherwise belong same role fork. */
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

/** compute model, think Profile and need to written to the database thinkingLevelOverride. */
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

/** compute need to written to the database modelOverride(explicit takes precedence, second same role fork inherit parent conversation override). */
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
 * from align ContextView in choose clean fork anchor item ID:
 * -  entries[0..len-1] contribution message by order flat and record which belong entryIdx;
 * - found global finally a role === 'assistant' message (under mark lastAssistantFlatIdx, which belong item
 *   lastAssistantEntryIdx), collect its toolCall ID, check flat.slice(lastAssistantFlatIdx + 1)
 *   in is otherwise all already has match role === 'toolResult'(also compatibility across item and same item [assistant, toolResult]);
 * - if store in not closed together toolCall, truncate to lastAssistantEntryIdx; otherwise keep to tail len;
 * - truncate after zone between inside must at least contains a non- system message; return tail purpose security positive integer ID.
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
 * read parent conversation when before ContextView and parse clean fork anchor item ID.
 * parent conversation missing throw 404 not_found; without completed can fork history throw 409 fork_empty_history.
 */
export async function resolveCleanForkAnchor(
  harness: Harness,
  parentConversationId: number,
): Promise<number> {
  const conv = await harness.conversation(parentConversationId as never, BACKGROUND_CONTEXT)
  if (!conv) {
    throw new HelmError('not_found', `parent conversation missing:${parentConversationId}`, 404, {
      parentConversationId,
    })
  }
  const view = await conv.context(BACKGROUND_CONTEXT)
  const anchorEntryId = selectCleanForkAnchorEntryId(view)
  if (anchorEntryId === undefined) {
    throw new HelmError(
      'fork_empty_history',
      'parent conversation still without completed can fork context item, cannot execute fork derive',
      409,
      { parentConversationId },
    )
  }
  return anchorEntryId
}
