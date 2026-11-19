import { useEffect, useState } from 'react'
import type { ConversationStatus } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import type { EditRequestTarget } from '../conversation/timeline-model.js'

// ---------------------------------------------------------------------------
// Historical message editing state (pure logic, directly unit-tested)
// ---------------------------------------------------------------------------

/** Pending attachment draft (uploaded but not yet submitted with a message). */
export interface PendingAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

/** Attachment refs carried by an edit target -> pending-send draft (fully
 * replaced each time an edit target is picked; no stale draft residue). */
export function attachmentsOfEditTarget(target: EditRequestTarget): PendingAttachment[] {
  return (target.attachments ?? []).map((a) => ({
    artifactId: a.id,
    name: a.name,
    size: a.size,
    mimeType: a.mimeType,
  }))
}

/** Whether the selected edit target constitutes an in-place edit (a
 * historical anchor exists); otherwise it is only draft prefill. */
export function isHistoricalEdit(target: EditRequestTarget): boolean {
  return target.entryId !== undefined
}

/** Draft version frozen at send time: any dimension changing counts as a user
 * modification; the old edit target must not flow back. */
export interface ComposerDraftVersion {
  text: string
  targetEntryId: number | null
  attachments: string[]
}

export function draftVersionOf(text: string, targetEntryId: number | null, attachments: ReadonlyArray<PendingAttachment>): ComposerDraftVersion {
  return { text, targetEntryId, attachments: attachments.map((a) => a.artifactId) }
}

export function sameDraftVersion(a: ComposerDraftVersion, b: ComposerDraftVersion): boolean {
  return a.text === b.text && a.targetEntryId === b.targetEntryId
    && a.attachments.length === b.attachments.length
    && a.attachments.every((id, i) => id === b.attachments[i])
}

/** Parse `/compact` with optional compaction instructions (`/compact
 * <instructions>`); non-`/compact` payloads return null. */
export function parseCompactSlashCommand(payload: string): { instructions?: string } | null {
  const trimmed = payload.trim()
  if (trimmed === '/compact') return {}
  if (trimmed.startsWith('/compact ') || trimmed.startsWith('/compact\t') || trimmed.startsWith('/compact\n')) {
    const rest = trimmed.slice('/compact'.length).trim()
    return rest !== '' ? { instructions: rest } : {}
  }
  return null
}

/** In-conversation management commands: executed immediately for non-editing
 * input; inside edit mode they are just the edited message's text. */
export function isSessionManageCommand(payload: string): boolean {
  return payload === '/new' || payload === '/clear' || parseCompactSlashCommand(payload) !== null
}

/** Whether the editing state should be restored after a send failure: only
 * when the Composer is still in the expected post-optimistic-clear state (the
 * user typed no new text, picked no other edit target, changed no
 * attachments) may the old edit target flow back. */
export function shouldRestoreEditOnFailure(
  live: ComposerDraftVersion,
  expectedAfterClear: ComposerDraftVersion,
): boolean {
  return sameDraftVersion(live, expectedAfterClear)
}

/** Sending-feedback visibility: only while the send request is in flight and
 * the server has not yet taken over with a real working/blocked status.
 *
 * Once SSE state arrives the real status takes over — no second "sending"
 * wait is stacked; the persistent conversation.status is never modified and
 * no extra business enum is introduced. */
export function sendingPendingVisible(
  sendingInFlight: boolean,
  status: ConversationStatus,
): boolean {
  return sendingInFlight && status !== 'working' && status !== 'blocked'
}

/** Composer placeholder copy for idle vs busy, desktop vs mobile/small screens. */
export function getComposerPlaceholder(working: boolean, isMobile: boolean, t: WebMessageTranslator = englishWebTranslator): string {
  if (working) {
    // Keep the mobile placeholder extremely short to avoid wrapping and
    // growing the input area on narrow screens.
    return isMobile ? t('composer.placeholder.workingMobile') : t('composer.placeholder.working')
  }
  return isMobile ? t('composer.placeholder.idleMobile') : t('composer.placeholder.idle')
}

/** Default whenBusy policy for Enter while the conversation is busy (steer). */
export const BUSY_ENTER_DEFAULT = 'steer' as const

/** Send-gating state reported back by the starting-environment bar of an empty
 * conversation (pure types live in a .ts module to keep Fast Refresh). */
export interface SessionEnvBlocker {
  /** True while the environment draft is unsaved (or saving): the Composer
   * must block sending. */
  blocked: boolean
  /** Blocking reason (title hint for the disabled button). */
  reason: string | null
}

/** No-blocker sentinel (referentially stable, shared by useState init and reset). */
export const ENV_BLOCKER_CLEAR: SessionEnvBlocker = { blocked: false, reason: null }

/**
 * Keyboard event -> whenBusy policy while busy (pure function, directly
 * unit-tested): Enter defaults to steering; ⌘/Ctrl+Enter explicitly queues
 * (followUp). Callers must first apply Shift+Enter newline handling and IME
 * composing protection.
 */
export function busyEnterMode(modifier: boolean): 'steer' | 'followUp' {
  return modifier ? 'followUp' : BUSY_ENTER_DEFAULT
}

/** Substantive conversational entry kinds that count as "the chat has
 * started" (any of them locks the starting environment).
 * Real SDK kinds use hyphens (pi.tool-result, see the pi-durable README);
 * legacy underscore spellings stay accepted. pi.compaction is substantive
 * context: compaction must not become an environment unlock path. */
const CONVERSATIONAL_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'helmx.input',
  'pi.user',
  'pi.assistant',
  'pi.tool_call',
  'pi.tool_result',
  'pi.tool-call',
  'pi.tool-result',
  'pi.compaction',
])

/**
 * Whether the conversation is still in its "chat not started yet" empty state
 * (or has had no new message since `/reset`). Only then may the starting
 * execution node and working directory be configured above the Composer;
 * starting the chat locks them.
 */
export interface EnvSubtitleEntry {
  kind: string
  data?: unknown
  model?: unknown
}

/** Reuse timeline-model's handoff extraction rule: `data.handoff` (non-empty
 * string) first, falling back to UserMessage text inside model. */
function resetHandoffText(entry: EnvSubtitleEntry): string {
  if (entry.data !== null && typeof entry.data === 'object' && typeof (entry.data as { handoff?: unknown }).handoff === 'string') {
    return (entry.data as { handoff: string }).handoff
  }
  if (!Array.isArray(entry.model)) return ''
  let text = ''
  for (const msg of entry.model) {
    if (msg === null || typeof msg !== 'object') continue
    if ((msg as { role?: unknown }).role !== 'user') continue
    const content = (msg as { content?: unknown }).content
    if (typeof content === 'string') text += content
    else if (Array.isArray(content)) {
      for (const part of content) {
        if (part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
          text += (part as { text: string }).text
        }
      }
    }
  }
  return text
}

export function canConfigureSessionEnv(
  entries: ReadonlyArray<EnvSubtitleEntry> | undefined,
  status: string,
): boolean {
  if (status === 'working' || status === 'blocked') return false
  if (entries === undefined) return false
  // Check starting from the last pi.reset (or from the beginning when no
  // reset exists). Reset deletes no history and only switches context: after
  // a plain reset the environment is configurable again; but a reset with a
  // handoff summary means the new context inherited the old conversation's
  // environment narrative — keep it locked.
  let start = 0
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.kind === 'pi.reset') {
      start = i
      break
    }
  }
  return !entries.slice(start).some((entry) =>
    CONVERSATIONAL_ENTRY_KINDS.has(entry.kind) ||
    (entry.kind === 'pi.reset' && resetHandoffText(entry).trim() !== ''),
  )
}

export interface EnvSubtitleInput {
  profileId: string
  nodeId?: string
  cwd: string
  /** Number of trailing cwd segments to keep (default 2). */
  segments?: number
  /** Compact mode (narrow screens/phones): node identity only; empty on local. */
  compact?: boolean
}

/** Split a path into segments on both separators: Windows backslashes and
 * POSIX slashes are equivalent; a root path stays as one segment. */
function splitPathSegments(cwd: string): string[] {
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length > 0 ? parts : [cwd]
}

/**
 * Build the read-only environment subtitle for the conversation top bar:
 * `profileId · tail` (local) or `profileId · @node:tail` (remote), with a full
 * hover tooltip. Compact mode shows only `@node` (empty on local; callers do
 * not render it).
 */
export function formatEnvSubtitle(input: EnvSubtitleInput, t: WebMessageTranslator = englishWebTranslator): { text: string; tooltip: string } {
  const nodeId = input.nodeId !== undefined && input.nodeId !== '' ? input.nodeId : 'local'
  const cwd = input.cwd === '' ? t('composer.env.notSet') : input.cwd
  const tooltip = t('composer.env.subtitleTooltip', { profileId: input.profileId, nodeId, cwd })
  if (input.compact === true) {
    return { text: nodeId === 'local' ? '' : `@${nodeId}`, tooltip }
  }
  const parts = splitPathSegments(input.cwd)
  const tail = parts.slice(-(input.segments ?? 2)).join('/')
  const text =
    nodeId === 'local'
      ? tail === '' ? input.profileId : `${input.profileId} · ${tail}`
      : tail === '' ? `${input.profileId} · @${nodeId}` : `${input.profileId} · @${nodeId}:${tail}`
  return { text, tooltip }
}

// ---------------------------------------------------------------------------
// Starting-environment draft for empty conversations (pure logic, directly
// unit-tested)
// ---------------------------------------------------------------------------

export interface EnvDraft {
  nodeId: string
  cwd: string
}

/**
 * Derive the next draft from the current conversation coordinates and the
 * existing draft:
 * - node unchanged: keep the user's cwd draft;
 * - switching nodes: clear the cwd draft (the protocol has no per-node default
 *   directory; old-node paths are never carried over) and require the target
 *   node's directory.
 */
export function envDraftOnNodeChange(current: EnvDraft, nextNodeId: string): EnvDraft {
  if (nextNodeId === current.nodeId) return current
  return { nodeId: nextNodeId, cwd: '' }
}

/** Pre-save validation: null means submittable, otherwise a user-readable error. */
export function envDraftError(draft: EnvDraft, t: WebMessageTranslator = englishWebTranslator): string | null {
  if (draft.cwd.trim() === '') return t('composer.env.errorRequired')
  if (!draft.cwd.trim().startsWith('/') && !/^[A-Za-z]:[\\/]/.test(draft.cwd.trim())) {
    return t('composer.env.errorAbsolute')
  }
  return null
}

/** Whether the draft matches the current conversation coordinates (matching
 * means nothing to submit); an absent nodeId counts as local. */
export function envDraftUnchanged(draft: EnvDraft, nodeId: string | undefined, cwd: string): boolean {
  return draft.nodeId === (nodeId || 'local') && draft.cwd === cwd
}

/** Track whether the viewport width is within the mobile threshold (default <= 680px). */
export function useIsMobile(maxWidth = 680): boolean {
  const [isMobile, setIsMobile] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(`(max-width: ${maxWidth}px)`).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mql = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', handler)
      return () => mql.removeEventListener('change', handler)
    } else if (typeof (mql as unknown as { addListener?: (cb: (e: MediaQueryListEvent) => void) => void }).addListener === 'function') {
      (mql as unknown as { addListener: (cb: (e: MediaQueryListEvent) => void) => void }).addListener(handler)
      return () => {
        (mql as unknown as { removeListener: (cb: (e: MediaQueryListEvent) => void) => void }).removeListener(handler)
      }
    }
  }, [maxWidth])

  return isMobile
}
