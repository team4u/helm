/**
 * Agent standby pane pure logic and draft storage:
 * - the standby state is a true draft: no fabricated ConversationSummary, no
 *   pre-created conversation, no uploaded attachments;
 * - drafts live in memory only (a module-level Map, isolated per
 *   `panel:profileId` coordinate so primary/split never cross), surviving
 *   component unmounts / target switches (in-flight first sends and retries
 *   all reference the same record);
 * - the first-send pipeline (create -> patch thinkingLevel -> upload
 *   attachments -> submitInput) guards double-click/Enter concurrency with a
 *   synchronous sending flag; after create succeeds, any later failure keeps
 *   the real conversation id and uploaded attachments for reuse on retry —
 *   never duplicating creation or auto-deleting to mask a failure.
 * This module exports no components; the only React binding is the single
 * useSyncExternalStore hook.
 */
import { useSyncExternalStore } from 'react'
import type { ArtifactMetadata, ConversationInit, ConversationSummary } from '@helmx/protocol/browser'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import { envDraftError, parseCompactSlashCommand, type EnvDraft } from './composer-model.js'
import { resolveEffectiveThinkingLevel } from './keybindings-model.js'

/** Attachments staged locally before sending (no conversation created, nothing uploaded). */
export interface StandbyLocalFile {
  key: string
  file: File
  name: string
  size: number
  mimeType: string
}

/** Uploaded attachments (reused on retry after a partial first-send failure;
 * never re-uploaded). */
export interface StandbyUploadedAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

/** Full standby draft state (an immutable record in module-level storage,
 * wholly replaced on each update). */
export interface StandbyDraftState {
  text: string
  localFiles: StandbyLocalFile[]
  uploaded: StandbyUploadedAttachment[]
  /** Explicit model selection; undefined = follow the Profile/global default
   * (resolved by the server, never fabricated). */
  model: string | undefined
  /** Explicit thinking level; undefined = no patch (patchable only after creation). */
  thinkingLevel: string | undefined
  /** Whether the environment was explicitly customized (URL inheritance or
   * user edit); false means create carries no nodeId/cwd. */
  envCustomized: boolean
  envNodeId: string | undefined
  envCwd: string | undefined
  /** Resume anchor after a partial first-send failure: the real created
   * conversation id (retry skips create). */
  conversationId: number | undefined
  /** Synchronous debounce flag: set to true synchronously when the first-send
   * task starts; double-click / repeated Enter are ignored outright. */
  sending: boolean
  /** User-readable error of the most recent first-send failure (shown until retried). */
  error: string | null
}

export const EMPTY_STANDBY_DRAFT: StandbyDraftState = {
  text: '',
  localFiles: [],
  uploaded: [],
  model: undefined,
  thinkingLevel: undefined,
  envCustomized: false,
  envNodeId: undefined,
  envCwd: undefined,
  conversationId: undefined,
  sending: false,
  error: null,
}

/** Attachment size cap, identical to the existing Composer (15 MiB). */
export const STANDBY_FILE_MAX_BYTES = 15 * 1024 * 1024

/**
 * Accept only real Blob/File objects (Blob-branded instances that must be
 * arrayBuffer-readable and carry name/size): plain objects riding synthetic
 * events (fake Files with only name/size) are rejected at the admission
 * boundary. Otherwise they would sneak into the draft and render as normal
 * chips until the first send's uploadArtifact call throws a synchronous
 * TypeError at file.arrayBuffer(), cutting the anchored send chain in half
 * (verified in a browser: after create succeeds — zero uploads, zero input,
 * zero navigation, only a failure toast).
 */
function isReadableFileLike(file: unknown): file is File {
  if (file === null || typeof file !== 'object' || typeof Blob === 'undefined') return false
  if (!(file instanceof Blob)) return false
  const candidate = file as Partial<Blob> & { name?: unknown }
  return typeof candidate.arrayBuffer === 'function' && typeof candidate.size === 'number' && typeof candidate.name === 'string'
}

type DraftListener = () => void

const drafts = new Map<string, StandbyDraftState>()
const listeners = new Set<DraftListener>()
let localFileSeq = 0
export const EMPTY_STANDBY_DIRTY_KEYS: ReadonlyArray<string> = []
let dirtyKeysCache: ReadonlyArray<string> = EMPTY_STANDBY_DIRTY_KEYS
/** Draft lifecycle epoch: bumped on full resets such as logout; in-flight
 * first-send tasks verify the epoch after every await and discard their
 * responses when it changed (no reviving text/attachments, no further
 * upload/send, no notices, no navigation). */
let draftEpoch = 0

function isStandbyDraftDirtyRecord(draft: StandbyDraftState): boolean {
  return (
    draft.text.trim() !== '' ||
    draft.localFiles.length > 0 ||
    draft.uploaded.length > 0 ||
    draft.sending
  )
}

function syncDirtyKeysCache(): void {
  const keys: string[] = []
  for (const [key, draft] of drafts.entries()) {
    if (isStandbyDraftDirtyRecord(draft)) keys.push(key)
  }
  keys.sort()
  if (keys.length === dirtyKeysCache.length && keys.every((k, i) => k === dirtyKeysCache[i])) return
  dirtyKeysCache = keys.length === 0 ? EMPTY_STANDBY_DIRTY_KEYS : keys
}

function notifyListeners(): void {
  syncDirtyKeysCache()
  for (const listener of listeners) listener()
}

/** Subscribe to draft-store changes (for read-only consumers like the version
 * auto-refresh pending check). */
export function subscribeStandbyDrafts(listener: DraftListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Referentially stable list of dirty standby draft keys (for useSyncExternalStore).
 */
export function standbyDirtyDraftKeys(): ReadonlyArray<string> {
  return dirtyKeysCache
}

/**
 * Whether any standby draft at any coordinate carries unsubmitted local state
 * (non-empty text / staged or uploaded attachments / a first send in flight).
 * Consumed when the version auto-refresh treats unsubmitted browser-local
 * content as the pending condition; text and attachments stay un-persisted
 * until the first send succeeds, and a sending failure anchor (conversationId)
 * counts as local state too.
 */
export function standbyDraftsDirty(): boolean {
  return dirtyKeysCache.length > 0
}

/** Draft entry coordinate: panel + Profile + inherited environment. The same
 * Profile at different remote coordinates yields two independent drafts so an
 * environment inherited from an earlier navigation never leaks into the next
 * first send as if the user had edited it. */
export interface StandbyCoordinate {
  panel: 'primary' | 'split'
  profileId: string
  nodeId?: string
  cwd?: string
}

/** Draft storage key: normalized JSON (fixed field order, empty values
 * omitted) — unambiguous per entry coordinate. */
export function standbyDraftKey(coordinate: StandbyCoordinate): string {
  const normalized: Record<string, string> = {
    panel: coordinate.panel,
    profileId: coordinate.profileId,
  }
  if (coordinate.nodeId !== undefined && coordinate.nodeId !== '') normalized.nodeId = coordinate.nodeId
  if (coordinate.cwd !== undefined && coordinate.cwd !== '') normalized.cwd = coordinate.cwd
  return JSON.stringify(normalized)
}

export function getStandbyDraft(key: string): StandbyDraftState {
  return drafts.get(key) ?? EMPTY_STANDBY_DRAFT
}

/** Update a draft (created from the empty record when absent). */
export function updateStandbyDraft(key: string, patch: Partial<StandbyDraftState>): StandbyDraftState {
  const next: StandbyDraftState = { ...getStandbyDraft(key), ...patch }
  drafts.set(key, next)
  notifyListeners()
  return next
}

/** Update only while the record still exists (after a fully successful send
 * clears the draft, the trailing sending reset must not revive an empty
 * record). */
export function patchStandbyDraftIfPresent(key: string, patch: Partial<StandbyDraftState>): void {
  if (!drafts.has(key)) return
  const current = drafts.get(key)!
  drafts.set(key, { ...current, ...patch })
  notifyListeners()
}

/** Clear the draft after the whole first-send chain succeeds (text lives in
 * memory only; no cross-refresh restore needed). */
export function clearStandbyDraft(key: string): void {
  if (!drafts.delete(key)) return
  notifyListeners()
}

/** Clear all standby drafts and bump the epoch (logout release / test
 * isolation): every in-flight task response is voided. */
export function resetStandbyDrafts(): void {
  draftEpoch++
  drafts.clear()
  notifyListeners()
}

/** Current draft epoch (for in-flight task snapshot comparison). */
export function currentStandbyDraftEpoch(): number {
  return draftEpoch
}

/** On "restore defaults", reset the environment fields; when the target
 * coordinate already holds a draft it is not overwritten (returning false lets
 * the caller report explicitly). */
export function resetEnvStandbyDraft(from: string, to: string): boolean {
  if (!drafts.has(from)) return false
  if (from !== to && drafts.has(to)) return false
  const record = drafts.get(from)!
  drafts.set(to, { ...record, envCustomized: false, envNodeId: undefined, envCwd: undefined })
  if (from !== to) drafts.delete(from)
  notifyListeners()
  return true
}

/** React binding: draft record identity is stable (wholly replaced per
 * update), for useSyncExternalStore consumption. */
export function useStandbyDraft(key: string): StandbyDraftState {
  return useSyncExternalStore(subscribeStandbyDrafts, () => getStandbyDraft(key), () => EMPTY_STANDBY_DRAFT)
}

// ---------------------------------------------------------------------------
// Pure functions: environment draft, attachments and create input
// ---------------------------------------------------------------------------

/** Environment inherited from an agent target (delete-navigation / new-topic
 * inheritance); absent values stay undefined for the server to resolve. */
export function inheritedEnvOf(target: { nodeId?: string; cwd?: string }): { nodeId?: string; cwd?: string } {
  return {
    ...(target.nodeId !== undefined && target.nodeId !== '' ? { nodeId: target.nodeId } : {}),
    ...(target.cwd !== undefined && target.cwd !== '' ? { cwd: target.cwd } : {}),
  }
}

/** Disposition of conversation-management commands hit on the standby pane:
 * /new clears the draft; /clear and /compact require an existing conversation
 * and are never sent as plain input. */
export type StandbyManageAction =
  | { kind: 'clear-draft' }
  | { kind: 'needs-conversation'; command: string }
  | null

export function standbyManageAction(payload: string): StandbyManageAction {
  const cmd = payload.trim()
  if (cmd === '/new') return { kind: 'clear-draft' }
  if (cmd === '/clear' || parseCompactSlashCommand(cmd) !== null) {
    return { kind: 'needs-conversation', command: cmd === '/clear' ? '/clear' : '/compact' }
  }
  return null
}

/**
 * Resolve the standby pane's effective model: explicit draft override >
 * Profile binding > global default model. All empty -> undefined (the button
 * shows "Default model"; the submitted create carries no model field).
 */
export function resolveStandbyEffectiveModel(
  draftModel: string | undefined,
  profileModel: string | undefined,
  globalDefaultModel: string | undefined,
): string | undefined {
  if (draftModel !== undefined && draftModel !== '') return draftModel
  if (profileModel !== undefined && profileModel !== '') return profileModel
  if (globalDefaultModel !== undefined && globalDefaultModel !== '') return globalDefaultModel
  return undefined
}

/**
 * Resolve the standby pane's effective thinking level: explicit draft
 * override > per-model default for the effective model > Profile binding >
 * global default level, converged into the current model's supported list
 * (falling back to off or the first supported level when unsupported).
 */
export function resolveStandbyThinkingLevel(
  levels: ReadonlyArray<string>,
  draftLevel: string | undefined,
  perModelDefaultLevel: string | undefined,
  profileLevel: string | undefined,
  globalDefaultLevel: string | undefined,
): string {
  const raw =
    draftLevel !== undefined && draftLevel !== ''
      ? draftLevel
      : perModelDefaultLevel !== undefined && perModelDefaultLevel !== ''
        ? perModelDefaultLevel
        : profileLevel !== undefined && profileLevel !== ''
          ? profileLevel
          : globalDefaultLevel !== undefined && globalDefaultLevel !== ''
            ? globalDefaultLevel
            : ''
  return resolveEffectiveThinkingLevel(levels, raw)
}

/** Post-customization validation (reuses the conversation environment bar's
 * rule: the directory is required and must be an absolute path). Always passes
 * while not customized. */
export function standbyEnvError(draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd'>, t: WebMessageTranslator = englishWebTranslator): string | null {
  if (!draft.envCustomized) return null
  return envDraftError({ nodeId: draft.envNodeId || 'local', cwd: draft.envCwd ?? '' } satisfies EnvDraft, t)
}

/** Local attachment admission (real Blob/File boundary validation + 15 MiB
 * cap; returns rejected items with user-readable reasons). */
export function admitStandbyFiles(
  draft: Pick<StandbyDraftState, 'localFiles'>,
  files: ReadonlyArray<File>,
  t: WebMessageTranslator = englishWebTranslator,
): { draft: Pick<StandbyDraftState, 'localFiles'>; accepted: File[]; rejected: Array<{ file: File; reason: string }> } {
  const next = [...draft.localFiles]
  const accepted: File[] = []
  const rejected: Array<{ file: File; reason: string }> = []
  for (const file of files) {
    if (!isReadableFileLike(file)) {
      rejected.push({ file, reason: t('composer.attach.unsupportedSource') })
      continue
    }
    if (file.size > STANDBY_FILE_MAX_BYTES) {
      rejected.push({ file, reason: t('composer.attach.tooLarge') })
      continue
    }
    next.push({
      key: `standby-file-${++localFileSeq}`,
      file,
      name: file.name || 'attachment.bin',
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
    })
    accepted.push(file)
  }
  return { draft: { localFiles: next }, accepted, rejected }
}

/** Assemble the create input: the environment rides along only when
 * explicitly customized; the model only when explicitly selected (defaults
 * are resolved by the server). */
export function buildStandbyCreateInit(
  profileId: string,
  draft: Pick<StandbyDraftState, 'envCustomized' | 'envNodeId' | 'envCwd' | 'model'>,
): ConversationInit {
  return {
    profileId,
    ...(draft.envCustomized
      ? { nodeId: draft.envNodeId || 'local', cwd: (draft.envCwd ?? '').trim() }
      : {}),
    ...(draft.model !== undefined && draft.model !== '' ? { model: draft.model } : {}),
  }
}

// ---------------------------------------------------------------------------
// First-send pipeline (dependency-injected; the UI layer passes real APIs and
// navigation callbacks)
// ---------------------------------------------------------------------------

export interface StandbySendDeps {
  create: (init: ConversationInit) => Promise<ConversationSummary>
  patchThinkingLevel: (conversationId: number, thinkingLevel: string) => Promise<unknown>
  upload: (conversationId: number, file: File) => Promise<ArtifactMetadata>
  submit: (conversationId: number, payload: { text: string; origin: 'human'; attachments?: string[] }) => Promise<unknown>
  notifyError: (title: string, err: unknown, conversationId?: number) => void
  /** When the whole chain succeeded but the standby target is no longer in
   * view, guide the user back to the new conversation with a clickable
   * notice. */
  notifySentInBackground: (conversationId: number) => void
  /** When the whole chain succeeded while the standby target is still in
   * view, navigate (replace) to the real conversation. */
  navigateToConversation: (conversationId: number) => void
  isStillViewing: () => boolean
}

export type StandbySendResult = 'sent' | 'invalid' | 'busy' | 'failed' | 'stale'

/**
 * Execute the first send. Checks and claims the sending flag synchronously
 * (a second double-click/Enter returns busy immediately), then advances
 * create -> patch -> upload -> submit; any failure keeps the draft, the
 * created conversation id and the uploaded attachments and returns failed for
 * the user to retry explicitly (reusing the anchor).
 */
export async function executeStandbySend(
  key: string,
  profileId: string,
  deps: StandbySendDeps,
  t: WebMessageTranslator = englishWebTranslator,
): Promise<StandbySendResult> {
  const record = getStandbyDraft(key)
  const payload = record.text.trim()
  if (payload === '') return 'invalid'
  if (record.sending) return 'busy'
  const envError = standbyEnvError(record, t)
  if (envError !== null) {
    deps.notifyError(t('composer.standby.fixEnvFirst'), envError)
    return 'invalid'
  }
  // Claim synchronously: later double-clicks/Enter are rejected before any await.
  updateStandbyDraft(key, { sending: true, error: null })
  // Epoch snapshot: after logout/full reset, no old-task response may touch
  // storage or send anything outward again.
  const epoch = currentStandbyDraftEpoch()
  const stale = (): boolean => epoch !== currentStandbyDraftEpoch()
  let conversationId = record.conversationId
  try {
    if (conversationId === undefined) {
      const created = await deps.create(buildStandbyCreateInit(profileId, record))
      if (stale()) return 'stale'
      conversationId = created.id
      // Persist the anchor immediately: on any later failure, retry skips create.
      updateStandbyDraft(key, { conversationId })
    }
    if (record.thinkingLevel !== undefined && record.thinkingLevel !== '') {
      await deps.patchThinkingLevel(conversationId, record.thinkingLevel)
      if (stale()) return 'stale'
    }
    for (const local of record.localFiles) {
      const meta = await deps.upload(conversationId, local.file)
      if (stale()) return 'stale'
      // Uploaded counts as final: failed retries never re-upload the file.
      const current = getStandbyDraft(key)
      updateStandbyDraft(key, {
        localFiles: current.localFiles.filter((item) => item.key !== local.key),
        uploaded: [...current.uploaded, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }],
      })
    }
    const attachments = getStandbyDraft(key).uploaded.map((item) => item.artifactId)
    await deps.submit(conversationId, {
      text: payload,
      origin: 'human',
      ...(attachments.length > 0 ? { attachments } : {}),
    })
    if (stale()) return 'stale'
    clearStandbyDraft(key)
    if (deps.isStillViewing()) deps.navigateToConversation(conversationId)
    else deps.notifySentInBackground(conversationId)
    return 'sent'
  } catch (err) {
    if (stale()) return 'stale'
    patchStandbyDraftIfPresent(key, { error: err instanceof Error ? err.message : String(err) })
    deps.notifyError(
      conversationId !== undefined ? t('composer.standby.sendFailedRetryTitle') : t('composer.standby.createFailedTitle'),
      err,
      conversationId,
    )
    return 'failed'
  } finally {
    // Never reset when the epoch changed: the new epoch may already hold a new
    // draft under the same key; the old task's cleanup must not overwrite its
    // sending state.
    if (!stale()) patchStandbyDraftIfPresent(key, { sending: false })
  }
}
