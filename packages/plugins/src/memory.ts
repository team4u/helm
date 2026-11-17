/**
 * builtin:memory: the fully autonomous long-term memory plugin (locked: false, enabled by default).
 *
 * Responsibilities (orthogonal to builtin:profile; zero memory awareness in kernel/protocol):
 * - MemoryStore manages `<dataDir>/profiles/<id>/MEMORY.md` itself (file lock + the 64k cap's single
 *   authoritative point, see memory/store.ts); the on-disk full text is the single authority, never entering public docs;
 * - the private ctx.doc('state') persists compact state: disabledProfiles (per-Profile switch)
 *   and initializedProfiles (distinguishing "never initialized" from "initialized then deleted" across restarts);
 * - before_turn: with a Profile's memory off, read no file, inject no section, and strip the
 *   update_memory tool; with it on, inject memory.content / memory.guide / memory.assets-missing by content;
 * - the update_memory tool: the execute entry re-checks the per-Profile switch (off -> 403);
 * - three ctx.actions (get / set / configure) auto-map to HTTP / CLI (helm memory
 *   get|set|configure) / Agent Tool / Web invokeAction -- five ends.
 *
 * Honesty discipline:
 * - MEMORY.md of an initialized Profile deleted externally: an explicit warning notification + the
 *   injected memory.assets-missing; never rebuild unconditionally at startup to mask the loss;
 *   self-heals after the file is restored or a tool writes;
 * - a legal Profile never initialized creates lazily on first memory need (no false missing report);
 * - a blank MEMORY.md is a legal memory.guide state (no missing warning).
 */
import { HelmError, PROFILE_DETAIL_SECTION_SLOT, type HelmHostProfilesPort, type PluginActionContext, type PluginDefinition } from '@helm/protocol'
import { resolvePluginClientRoot } from './asset-paths.js'
import { MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MemoryStore } from './memory/store.js'

export { MEMORY_PLUGIN_ID, MAX_MEMORY_CHARS, MEMORY_DEFAULT, MemoryStore } from './memory/store.js'

/** Compact persistent state of per-Profile memory switches and initialization markers (private doc, no full text). */
export interface MemoryPluginDoc {
  /** Profile IDs with long-term memory disabled (Profiles not listed are enabled by default). */
  disabledProfiles: string[]
  /** Profile IDs whose MEMORY.md has been initialized (distinguishing never-initialized vs deleted across restarts). */
  initializedProfiles: string[]
}

const DOC_NAME = 'state'

export function isProfileMemoryEnabled(
  doc: Pick<MemoryPluginDoc, 'disabledProfiles'> | undefined,
  profileId: string,
): boolean {
  return !(doc?.disabledProfiles ?? []).includes(profileId)
}

/** Truncation note (appended after truncated content at injection time; never truncate silently). */
const MEMORY_TRUNCATION_NOTE = `\n[ helm note: MEMORY.md exceeds the ${MAX_MEMORY_CHARS}-character cap; the above is the first ${MAX_MEMORY_CHARS} characters; use update_memory(mode='replace') to consolidate and trim memory ]`

/** Memory tool usage hint (injected dynamically; SYSTEM.md no longer hardcodes it). */
const MEMORY_USAGE_NOTE = 'Use `update_memory` to save stable user preferences and conventions.'

/** Public port: validate the ID and read the Profile (no guessing of missing targets). */
async function requireProfile(profiles: HelmHostProfilesPort, profileId: string): Promise<void> {
  const found = await profiles.get(profileId)
  if (found === undefined) {
    throw new HelmError('profile_not_found', `Profile '${profileId}' does not exist`, 404, { profileId })
  }
}

/** Explicit Profile wins; otherwise inherit from the calling conversation; never guess a default Profile. */
function resolveActionProfileId(
  explicitProfileId: string | undefined,
  context: PluginActionContext,
  getConversation: (id: number) => { profileId: string },
): string {
  if (explicitProfileId !== undefined) return explicitProfileId
  if (context.conversationId !== undefined) return getConversation(context.conversationId).profileId
  throw new HelmError(
    'validation_error',
    'Missing Profile target: provide --profile-id or a conversation context (CLI uses --current)',
    400,
  )
}

export function createMemoryPlugin(): PluginDefinition {
  return {
    id: MEMORY_PLUGIN_ID,
    name: { en: 'Long-term Memory', 'zh-CN': '长期记忆' },
    description: {
      en: 'Autonomous long-term memory: manages MEMORY.md injection and toggles per Profile, providing the update_memory tool.',
      'zh-CN': '自主长期记忆：按 Profile 管理 MEMORY.md 注入与开关，提供 update_memory 工具。',
    },
    icon: 'sparkles',
    version: '0.1.0',
    locked: false,
    clientRoot: resolvePluginClientRoot(MEMORY_PLUGIN_ID, 'memory', 'memory_plugin_client_missing'),
    definePlugin(ctx) {
      const { profiles } = ctx.host
      const store = new MemoryStore(ctx.host)
      // Private compact state: disabledProfiles + initializedProfiles (the on-disk full text is the single authority).
      const stateDoc = ctx.doc<MemoryPluginDoc>(DOC_NAME, {
        disabledProfiles: [],
        initializedProfiles: [],
      })

      const isEnabled = (profileId: string): boolean =>
        isProfileMemoryEnabled(stateDoc.get(), profileId)
      const isInitialized = (profileId: string): boolean =>
        stateDoc.get().initializedProfiles.includes(profileId)
      const markInitialized = (profileId: string): void => {
        stateDoc.update((current) =>
          current.initializedProfiles.includes(profileId)
            ? current
            : { ...current, initializedProfiles: [...current.initializedProfiles, profileId] },
        )
      }

      // ------------------------------------------------------------------
      // ctx.actions: get / set / configure (auto-mapped to helm memory ... CLI and HTTP)
      // ------------------------------------------------------------------

      ctx.action<{ profileId?: string }, { profileId: string; enabled: boolean; content: string; initialized: boolean }>({
        id: 'get',
        description: 'Read the Profile long-term memory content and switch state (pass --profile-id, or use --current for the current conversation)',
        inputSchema: {
          type: 'object',
          properties: { profileId: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            enabled: { type: 'boolean' },
            content: { type: 'string' },
            initialized: { type: 'boolean' },
          },
          required: ['profileId', 'enabled', 'content', 'initialized'],
          additionalProperties: false,
        },
        idempotent: true,
        async handler(input, context) {
          const profileId = resolveActionProfileId(input.profileId, context, (id) => ctx.host.getConversation(id))
          await requireProfile(profiles, profileId)
          let content = ''
          try {
            content = await store.getMemory(profileId)
          } catch (err) {
            if (!(err instanceof HelmError && err.code === 'not_found')) throw err
            // File absent: return an empty string honestly (the frontend sees the real state; no fabricated content).
          }
          return {
            profileId,
            enabled: isEnabled(profileId),
            content,
            initialized: isInitialized(profileId),
          }
        },
      })

      ctx.action<{ profileId?: string; text: string; mode?: 'append' | 'replace' }, { profileId: string; updated: boolean; length: number }>({
        id: 'set',
        description: 'Write the Profile MEMORY.md in full or append (--profile-id or --current picks the target)',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string', minLength: 1 },
            text: { type: 'string' },
            mode: { type: 'string', enum: ['replace', 'append'] },
          },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            updated: { type: 'boolean' },
            length: { type: 'number' },
          },
          required: ['profileId', 'updated', 'length'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = resolveActionProfileId(input.profileId, context, (id) => ctx.host.getConversation(id))
          await requireProfile(profiles, profileId)
          const mode = input.mode ?? 'replace'
          if (!isEnabled(profileId)) {
            throw new HelmError(
              'memory_disabled_for_profile',
              `Profile '${profileId}' has long-term memory disabled; writing MEMORY.md is forbidden`,
              403,
              { profileId },
            )
          }
          const written = await store.updateMemory(profileId, input.text, mode)
          markInitialized(profileId)
          return { profileId, updated: true, length: written.length }
        },
      })

      ctx.action<
        { profileId?: string; enabled: boolean; text?: string },
        { profileId: string; enabled: boolean }
      >({
        id: 'configure',
        description: 'Configure the Profile long-term memory switch (--profile-id or --current picks the target)',
        inputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string', minLength: 1 },
            enabled: { type: 'boolean' },
            text: { type: 'string' },
          },
          required: ['enabled'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: {
            profileId: { type: 'string' },
            enabled: { type: 'boolean' },
          },
          required: ['profileId', 'enabled'],
          additionalProperties: false,
        },
        async handler(input, context) {
          const profileId = resolveActionProfileId(input.profileId, context, (id) => ctx.host.getConversation(id))
          await requireProfile(profiles, profileId)
          // Write the text first (if provided) and commit the switch only on success -- no half-config left behind on failure.
          if (input.text !== undefined) {
            if (!isEnabled(profileId) && !input.enabled) {
              throw new HelmError(
                'memory_disabled_for_profile',
                `Profile '${profileId}' has long-term memory disabled; writing MEMORY.md is forbidden`,
                403,
                { profileId },
              )
            }
            await store.updateMemory(profileId, input.text, 'replace')
            markInitialized(profileId)
          }
          if (input.enabled && !isInitialized(profileId)) {
            // Enabled and not yet marked initialized: lazily create the file (kept as-is when it exists).
            await store.ensureMemory(profileId)
            markInitialized(profileId)
          }
          stateDoc.update((current) => ({
            ...current,
            disabledProfiles: input.enabled
              ? current.disabledProfiles.filter((id) => id !== profileId)
              : current.disabledProfiles.includes(profileId)
                ? current.disabledProfiles
                : [...current.disabledProfiles, profileId],
          }))
          return { profileId, enabled: input.enabled }
        },
      })

      // ------------------------------------------------------------------
      // before_turn: per-Profile switch + lazy initialization + missing-asset warning
      // ------------------------------------------------------------------

      const missingNotified = new Set<string>()

      ctx.hook.onBeforeTurn(async (turn) => {
        const profileId = turn.conversation.profileId
        if (!isEnabled(profileId)) {
          // Per-Profile memory off: read no file, inject nothing, and strip the update_memory tool.
          if (turn.tools.some((t) => t.name === 'update_memory')) {
            return {
              action: 'transform',
              value: {
                ...turn,
                tools: turn.tools.filter((t) => t.name !== 'update_memory'),
              },
            }
          }
          return { action: 'continue' }
        }

        const sections = [...turn.sections]
        let rawMemory: string
        try {
          rawMemory = await store.getMemory(profileId)
          missingNotified.delete(profileId) // stop once restored; can warn again if missing later
          if (!isInitialized(profileId)) markInitialized(profileId)
        } catch (err) {
          if (!(err instanceof HelmError && err.code === 'not_found')) throw err
          if (!isInitialized(profileId)) {
            // A legal never-initialized Profile needing memory for the first time: lazily create the default file.
            rawMemory = await store.ensureMemory(profileId)
            markInitialized(profileId)
          } else {
            // Initialized then deleted externally: warn explicitly (deduped per profileId); no rebuild.
            if (!missingNotified.has(profileId)) {
              await ctx.host.emitEvent('notification', {
                type: 'notification',
                level: 'warning',
                title: `Long-term memory file missing: ${profileId}/MEMORY.md`,
                body: `Profile '${profileId}' MEMORY.md once existed but was deleted externally; this turn proceeds without memory and self-heals after the next update_memory write or file restoration`,
              })
              missingNotified.add(profileId)
            }
            sections.push({
              id: 'memory.assets-missing',
              text: [
                '<memory_assets_missing>',
                `[Warning] Long-term memory asset missing (${profileId}/MEMORY.md existed but was deleted).`,
                'Please remind the user to check the profiles directory or rebuild via update_memory; until then you have no long-term memory.',
                '</memory_assets_missing>',
              ].join('\n'),
            })
            rawMemory = ''
          }
        }

        // Blank content is a legal state (memory.guide); no missing warning.
        if (rawMemory.trim()) {
          // Pre-existing over-limit content (externally hand-edited past the write defense): truncate at injection with an explicit note.
          const memory =
            rawMemory.length > MAX_MEMORY_CHARS
              ? `${rawMemory.slice(0, MAX_MEMORY_CHARS)}${MEMORY_TRUNCATION_NOTE}`
              : rawMemory
          sections.push({
            id: 'memory.content',
            text: `<memory>\n${memory}\n</memory>\n${MEMORY_USAGE_NOTE}`,
          })
        } else {
          sections.push({ id: 'memory.guide', text: MEMORY_USAGE_NOTE })
        }
        return { action: 'transform', value: { ...turn, sections } }
      })

      // ------------------------------------------------------------------
      // update_memory tool (execution-time recheck of the per-Profile switch)
      // ------------------------------------------------------------------

      ctx.tool<{ text: string; mode: 'append' | 'replace' }>({
        name: 'update_memory',
        description: 'Update the current conversation Profile\'s MEMORY.md. append adds content; replace swaps the full text (over 64000 chars requires a replace to trim first).',
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' }, mode: { type: 'string', enum: ['append', 'replace'] } },
          required: ['text', 'mode'],
          additionalProperties: false,
        },
        async execute(input, context) {
          const conversation = ctx.host.getConversation(context.conversationId)
          const profileId = conversation.profileId
          if (!isEnabled(profileId)) {
            throw new HelmError(
              'memory_disabled_for_profile',
              `Profile '${profileId}' has long-term memory disabled; calling update_memory is forbidden`,
              403,
              { profileId },
            )
          }
          // The size defense's single authoritative point is inside MemoryStore.updateMemory's file lock
          // (checked post-merge): concurrent appends across conversations for the same Profile cannot stack past the cap.
          const content = await store.updateMemory(profileId, input.text, input.mode)
          markInitialized(profileId)
          return { updated: true, profileId, length: content.length }
        },
      })

      // ------------------------------------------------------------------
      // Web slot: inject the per-Profile memory switch and editor into the Profile detail drawer
      // ------------------------------------------------------------------

      ctx.ui.slot({
        id: 'profile-memory-section',
        target: PROFILE_DETAIL_SECTION_SLOT,
        order: 10,
        client: { module: 'index.tsx', export: 'ProfileMemorySection' },
      })
    },
  }
}
