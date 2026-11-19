/**
 * triggers/delivery.ts: the delivery helper shared by cron and webhook.
 *
 * Target resolution (§4.4, complementary to the superagent trigger hook's routing):
 * - envelope.targetConversationId wins (mutually exclusive with the second parameter targetProfileId);
 * - targetProfileId only: take the lowest existing conversation ID of that Profile; with no
 *   conversation, validate the Profile exists and then create one (never deliver to the wrong role;
 *   concurrent creations single-flight and merge per profileId);
 * - neither: keep the default (no targetConversationId; the kernel resolves the assistant entry,
 *   and the superagent trigger hook may decide whether to route to the hub);
 * - text passes through raw (runtime.dispatchTrigger applies the unified defang anti-escape
 *   wrapping; connectors never double-wrap); the source convention is cron:<id> / webhook:<id>;
 */
import { HelmxError } from '@helmx/protocol'
import type { ExternalTriggerEnvelope } from '@helmx/protocol'
import type { ConversationLookup, ProfileLookup } from './contracts.js'

export type DispatchTriggerHelper = (
  event: ExternalTriggerEnvelope,
  targetProfileId?: string,
) => Promise<void>

export function createDeliveryDispatch(options: {
  host: {
    dispatchTrigger(event: ExternalTriggerEnvelope): Promise<void>
  } & ConversationLookup
  profiles: ProfileLookup
  /** Host closing state (the ctx.host.isClosing getter). */
  isClosing(): boolean
}): DispatchTriggerHelper {
  const { host, profiles, isClosing } = options
  /** Per-profile single-flight conversation creation (see the resolveProfileConversation comment). */
  const creationInflight = new Map<string, Promise<number>>()
  return async (event, targetProfileId) => {
    if (isClosing()) {
      throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, {
        source: event.source,
      })
    }
    let target = event.targetConversationId
    if (target !== undefined && targetProfileId !== undefined) {
      throw new HelmxError(
        'validation_error',
        'targetConversationId and targetProfileId must not both be provided',
        400,
        {},
      )
    }
    if (target === undefined && targetProfileId !== undefined) {
      target = await resolveProfileConversation(host, profiles, targetProfileId, creationInflight)
    }
    if (target !== undefined) {
      assertConversationExists(host, target)
    }
    if (isClosing()) {
      throw new HelmxError('runtime_closing', 'the runtime is closing; new trigger deliveries are rejected', 409, { source: event.source })
    }
    const final: ExternalTriggerEnvelope =
      target === undefined ? event : { ...event, targetConversationId: target }
    await host.dispatchTrigger(final)
  }
}

function assertConversationExists(host: ConversationLookup, id: number): void {
  if (!Number.isInteger(id) || id <= 0) {
    throw new HelmxError('validation_error', `targetConversationId is not a positive integer (${String(id)})`, 400, {})
  }
  try {
    host.getConversation(id)
  } catch (err) {
    if (err instanceof HelmxError && err.code === 'not_found') {
      throw new HelmxError(
        'not_found',
        `the trigger target conversation #${id} does not exist (possibly deleted; please update the trigger target)`,
        404,
        { targetConversationId: id },
      )
    }
    throw err
  }
}

/**
 * targetProfileId -> conversation ID: reuse the lowest ID; with no conversation, validate existence then create.
 * The creation section has a per-profileId single-flight (matching the kernel default path's
 * resolveDefaultTriggerTarget waiting semantics): concurrent triggers (multiple cron jobs at the same
 * point targeting the same new Profile / webhook bursts) create exactly one conversation, leaving no
 * orphan conversation forever unreachable by later deliveries. Clear on success (never caching a
 * deletable conversation ID); clear the cache on failure too, allowing the next trigger to retry. The
 * empty list and the map query happen in the same synchronous segment, so the creation winner is
 */
async function resolveProfileConversation(
  host: ConversationLookup,
  profiles: ProfileLookup,
  profileId: string,
  creationInflight: Map<string, Promise<number>>,
): Promise<number> {
  if (typeof profileId !== 'string' || /\s|[/\\]/.test(profileId) || profileId.length === 0 || profileId.length > 64) {
    throw new HelmxError('validation_error', `invalid targetProfileId (got: ${String(profileId)})`, 400, {})
  }
  const profile = await profiles.get(profileId)
  if (profile === undefined) {
    throw new HelmxError(
      'validation_error',
      `targetProfileId does not exist: ${profileId} (refusing to deliver to the wrong role)`,
      400,
      { targetProfileId: profileId },
    )
  }
  const existing = host.listConversations({ profileId }).sort((a, b) => a.id - b.id)
  if (existing.length > 0) return existing[0]!.id
  const inflight = creationInflight.get(profileId)
  if (inflight !== undefined) return inflight
  const creation = host.createConversation({
    title: `Trigger target (${profileId})`,
    profileId,
  }).then((created) => created.id)
  creationInflight.set(profileId, creation)
  try {
    return await creation
  } finally {
    if (creationInflight.get(profileId) === creation) creationInflight.delete(profileId)
  }
}
