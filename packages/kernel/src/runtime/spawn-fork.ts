/**
 * Shared validation, inheritance resolution, and clean-anchor calculation for native subagent context forking (`fork: true`).
 *
 * Responsibilities:
 * - `assertSpawnForkFields` / `resolveForkMode` / `resolveInheritedModelAndThinking` /
 *   `resolveInheritedModelOverride`: reused across `runtime-agent-spawn.ts` and `spawn.ts` so entry
 *   validation, hook transform re-verification, target inheritance, and model/effort clamping share one source of truth;
 * - `selectCleanForkAnchorEntryId`: flattens aligned messages per entry in order while tracking each message's
 *   `entryIdx`, locates the last global `role === 'assistant'` message, verifies whether any subsequent messages
 *   (including within the same entry) leave unclosed `toolCall`s, truncates before that assistant's entry if so,
 *   and rejects empty shells containing only system messages or resets;
 * - `resolveCleanForkAnchor`: reads the parent conversation's live `ContextView` from `Harness` and returns a
 *   positive safe integer entry ID; throws `404 not_found` if parent missing or `409 fork_empty_history` if no forkable history.
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

/** Validate `fork` field type and mutual exclusion between `fork` and `resume`. */
export function assertSpawnForkFields(request: Pick<AgentSpawnRequest, 'fork' | 'resume'>): void {
  if (request.fork !== undefined && typeof request.fork !== 'boolean') {
    throw new HelmError('validation_error', `fork must be a boolean (received ${typeof request.fork})`, 400, {
      fork: request.fork,
    })
  }
  if (request.fork === true && request.resume !== undefined) {
    throw new HelmError(
      'validation_error',
      'fork and resume are mutually exclusive: cannot fork from parent conversation while resuming an existing sub-conversation',
      400,
      { resume: request.resume },
    )
  }
}

/** Resolve target Profile and whether this is a same-profile fork. */
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

/** Compute effective model, reasoning effort, and `thinkingLevelOverride` to persist. */
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

/** Compute `modelOverride` to persist (explicit model takes precedence, then parent override on same-profile fork). */
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
 * Select a clean fork anchor entry ID from an aligned `ContextView`:
 * - Flatten contributed messages from `entries[0..len-1]` in order and record each message's `entryIdx`;
 * - Find the final `role === 'assistant'` message globally (`lastAssistantFlatIdx` in `lastAssistantEntryIdx`),
 *   collect its `toolCall` IDs, and check whether `flat.slice(lastAssistantFlatIdx + 1)` contains matching
 *   `role === 'toolResult'` entries (handles both cross-entry and same-entry `[assistant, toolResult]`);
 * - If any `toolCall` is unclosed, cut at `lastAssistantEntryIdx`; otherwise keep up to `len`;
 * - The remaining slice must contain at least one non-system message; returns the trailing entry's positive safe integer ID.
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
 * Read the parent conversation's current `ContextView` and resolve a clean fork anchor entry ID.
 * Throws `404 not_found` if parent is missing; throws `409 fork_empty_history` if no completed forkable history exists.
 */
export async function resolveCleanForkAnchor(
  harness: Harness,
  parentConversationId: number,
): Promise<number> {
  const conv = await harness.conversation(parentConversationId as never, BACKGROUND_CONTEXT)
  if (!conv) {
    throw new HelmError('not_found', `Parent conversation not found: ${parentConversationId}`, 404, {
      parentConversationId,
    })
  }
  const view = await conv.context(BACKGROUND_CONTEXT)
  const anchorEntryId = selectCleanForkAnchorEntryId(view)
  if (anchorEntryId === undefined) {
    throw new HelmError(
      'fork_empty_history',
      'Parent conversation has no completed forkable context entries yet; cannot fork',
      409,
      { parentConversationId },
    )
  }
  return anchorEntryId
}
