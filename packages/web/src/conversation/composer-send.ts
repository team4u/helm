/**
 * Composer send-pipeline hook (extracted from Composer.tsx; business logic
 * migrated verbatim):
 * - single owner of the draft triple (text / edit anchor / attachments) and
 *   the live draft version (liveDraftRef);
 * - send pipeline: empty & in-flight gating, unsaved-environment blocking,
 *   exact plugin slash-command hits executed on the spot, session management
 *   commands (/new /clear /compact) executed immediately outside edit mode,
 *   optimistic clear + rollback on failure against the frozen draft version
 *   (when the user already modified the draft, the old edit target never
 *   flows back);
 * - attachment upload: per-file upload + explicit failure notices; after each
 *   await the live draft is used (stale render snapshots never flow back);
 * - explicit text submission (sendExplicit): consumes no draft / edit anchor /
 *   attachments and rejects honestly on failure;
 * - gating sentinel and reset for the empty-conversation starting-environment
 *   block (reported by SessionEnvBar).
 * This module exports only hooks and pure types (no components), honoring the
 * .ts Fast Refresh rule.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationAttachmentRef, ConversationSummary, QueuedConversationInput, WhenBusy } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import { englishWebTranslator, type WebMessageTranslator } from '../i18n/catalog.js'
import {
  executePluginSlashAction,
  insertAtCaret,
  matchExactPluginSlash,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { useOptionalLocale, useStoreActions } from '../lib/store-context.js'
import { DEFAULT_HELM_LOCALE } from '@helm/protocol/browser'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { clearComposerDirty, setComposerDirty } from './composer-dirty.js'
import { focusWithCaret } from './composer-controller.js'
import {
  attachmentsOfEditTarget,
  draftVersionOf,
  isHistoricalEdit,
  parseCompactSlashCommand,
  shouldRestoreEditOnFailure,
  type ComposerDraftVersion,
  type PendingAttachment,
  type SessionEnvBlocker,
  ENV_BLOCKER_CLEAR,
} from './composer-model.js'
import type { EditRequestTarget } from './timeline-model.js'

/** Prefill request (timeline "edit and resend"); the incrementing tick makes
 * the same text trigger again. */
export interface ComposerPrefill {
  text: string
  entryId?: number
  attachments?: ConversationAttachmentRef[]
  tick: number
  /** When true, prefill only if the draft is fully idle (no text/attachments/
   * edit anchor/in-flight operation); otherwise warn and refuse. */
  onlyIfEmpty?: boolean
}

export interface ComposerSendInput {
  conversation: ConversationSummary
  /** Edit-and-resend prefill request (null means none). */
  prefill: ComposerPrefill | null
  /** Notify the parent when a real send request starts/ends (in-flight
   * feedback; slash commands do not trigger it). */
  onSendingChange?: (sending: boolean) => void
  /** /new new-topic entry (navigates to this agent's standby pane); when not
   * provided an explicit notice is shown. */
  onNewThread?: () => void
  /** textarea ref (focus after prefill/insert; auto-grow is the component's job). */
  textareaRef: { current: HTMLTextAreaElement | null }
  /** Plugin slash commands available in the current conversation scope (exact
   * first-token hits execute). */
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  /** Whether the conversation still allows configuring the starting
   * environment (false resets the environment block sentinel). */
  envConfigurable: boolean
  /** Whether the conversation is busy (the sole basis for the send's whenBusy policy). */
  working: boolean
  /** Reporting key for the version auto-refresh pending check (unique per
   * component instance, e.g. useId()); omitted means no reporting. */
  dirtyKey?: string
}

export interface ComposerSendApi {
  text: string
  attachments: PendingAttachment[]
  editingEntryId: number | null
  sending: boolean
  uploading: number
  /** Environment block state (send button disable + hint). */
  envBlocker: SessionEnvBlocker
  /** Send or upload in flight (shared by the env bar's sendBlocked and button disable). */
  sendInFlight: boolean
  /** Replace the whole draft text (advances the live draft version like user
   * typing; anchor/attachments untouched). */
  setDraftState: (text: string) => void
  /** Insert a fragment at the caret (focusWithCaret restores the caret). */
  insertTextState: (fragment: string) => void
  /** Live draft text (for render-time reads such as the controller). */
  readLiveDraft: () => string
  /** Exit history-edit mode and clear the draft. */
  cancelEdit: () => void
  /** Upload attachments file by file (images and plain files share the path;
   * failures notify explicitly). */
  uploadFiles: (files: ReadonlyArray<File>) => Promise<void>
  /** Remove one pending attachment (synchronously advances the live draft version). */
  removeAttachment: (artifactId: string) => void
  /** ↑ history edit: wholesale replacement of text / anchor / attachments
   * (an empty attachment list clears the old draft). */
  applyHistoryEdit: (target: EditRequestTarget) => void
  /** ↑ queued-withdraw re-edit: withdraws the newest human queued input from
   * queuedInputs and prefills the draft (no history-rollback banner). */
  withdrawQueuedInput: (queued: QueuedConversationInput) => Promise<void>
  /** Host's real send flow (optimistic clear + rollback by live draft version
   * on failure + whenBusy policy). */
  send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  /** Submit explicit text (consumes no draft / edit anchor / attachments;
   * rejects honestly on failure). */
  sendExplicit: (raw: string, whenBusy?: WhenBusy) => Promise<void>
  /** Execute a plugin command from the slash menu (trigger word consumed only
   * on success; stable identity). */
  runPluginCommand: (cmd: QualifiedCommand) => void
  /** SessionEnvBar block report (stable identity, for its blocker effect deps). */
  handleEnvBlocker: (blocker: SessionEnvBlocker) => void
  /** Unified error-notice outlet (shared by component-side actions like aborting a turn). */
  notifyError: (title: string, err: unknown) => void
}

export function useComposerSend(input: ComposerSendInput, t: WebMessageTranslator = englishWebTranslator): ComposerSendApi {
  const { conversation, prefill, onSendingChange, onNewThread, textareaRef, slashPluginCommands, envConfigurable, working, dirtyKey } = input
  const { invokePluginAction, pushNotice } = useStoreActions()
  const locale = useOptionalLocale() ?? DEFAULT_HELM_LOCALE
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null)
  const [sending, setSending] = useState(false)
  const [uploading, setUploading] = useState(0)
  const [envBlocker, setEnvBlocker] = useState<SessionEnvBlocker>(ENV_BLOCKER_CLEAR)
  const sendingRef = useRef(false)
  const uploadingRef = useRef(0)
  const envBlockedRef = useRef(false)
  const commandPendingRef = useRef(false)
  const withdrawingRef = useRef(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  // Live draft version: advanced by any change to text / edit target /
  // attachments; after a send failure it tells whether the user already
  // modified the draft.
  const liveDraftRef = useRef<ComposerDraftVersion>(draftVersionOf('', null, []))
  // Instance refs only, no state closures: empty deps keep a constant
  // identity, serving as the stable dependency of downstream useCallbacks.
  const syncLiveDraft = useCallback((text: string, target: number | null, attachments: ReadonlyArray<PendingAttachment>): void => {
    liveDraftRef.current = draftVersionOf(text, target, attachments)
  }, [])

  const handleEnvBlocker = (blocker: SessionEnvBlocker): void => {
    envBlockedRef.current = blocker.blocked
    setEnvBlocker(blocker)
  }
  // SessionEnvBar's blocker effect depends on this callback's identity: a
  // plain function would re-run it every render (looping while blocked).
  const handleEnvBlockerStable = useStableCallback(handleEnvBlocker)
  // Reset the block when the env bar unmounts (locked by the chat starting /
  // status change), so a leftover never blocks later sends.
  useEffect(() => {
    if (envConfigurable) return
    envBlockedRef.current = false
    setEnvBlocker(ENV_BLOCKER_CLEAR)
  }, [envConfigurable])

  // Prefill (edit and resend): any prefill reference change triggers it, and
  // repeated prefills of the same text also apply. Each picked edit target
  // wholly replaces the attachments (cleared when the target has none);
  // residue from the previous target is never kept.
  useEffect(() => {
    if (prefill === null) return
    // onlyIfEmpty: refuse prefill while the draft is non-empty/editing/in
    // flight (read via ref; no extra effect deps).
    if (prefill.onlyIfEmpty === true) {
      const live = liveDraftRef.current
      if (
        live.text.trim() !== '' ||
        live.attachments.length > 0 ||
        live.targetEntryId !== null ||
        sendingRef.current ||
        uploadingRef.current > 0
      ) {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.draft.handleBeforeStarter'),
          conversationId: conversation.id,
        })
        return
      }
    }
    const target = { text: prefill.text, ...(prefill.entryId !== undefined ? { entryId: prefill.entryId } : {}), ...(prefill.attachments !== undefined ? { attachments: prefill.attachments } : {}) }
    const nextEditing = isHistoricalEdit(target) ? prefill.entryId! : null
    const nextAttachments = attachmentsOfEditTarget(target)
    setText(prefill.text)
    setEditingEntryId(nextEditing)
    setAttachments(nextAttachments)
    syncLiveDraft(prefill.text, nextEditing, nextAttachments)
    textareaRef.current?.focus()
  }, [prefill, syncLiveDraft, t, pushNotice, conversation.id, textareaRef])

  // Leaving history-edit mode when the conversation switches (popover resets
  // are the component-side effect of the same name).
  useEffect(() => {
    setEditingEntryId(null)
  }, [conversation.id])

  const cancelEdit = useCallback((): void => {
    setEditingEntryId(null)
    setText('')
    setAttachments([])
    syncLiveDraft('', null, [])
  }, [syncLiveDraft])

  const notifyError = useCallback(
    (title: string, err: unknown) => {
      pushNotice({
        type: 'notification',
        level: 'error',
        title,
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    },
    [pushNotice, conversation.id],
  )

  const uploadFiles = useCallback(
    async (files: ReadonlyArray<File>): Promise<void> => {
      uploadingRef.current += files.length
      setUploading(uploadingRef.current)
      for (const file of files) {
        try {
          if (file.size > 15 * 1024 * 1024) throw new Error('File exceeds the 15 MiB limit')
          const meta = await conversationsApi.uploadArtifact(conversation.id, file)
          setAttachments((prev) => {
            const next = [...prev, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }]
            // The render snapshot is stale after the await: take live values
            // for text/anchor, only replacing the attachment set.
            syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
            return next
          })
        } catch (err) {
          notifyError(t('composer.attach.uploadFailedTitle', { name: file.name }), err)
        } finally {
          uploadingRef.current--
          setUploading(uploadingRef.current)
        }
      }
    },
    [conversation.id, notifyError, t],
  )

  // ⌘K and the slash menu share the same action addressing; failures must
  // reach the submitter.
  const runPluginCommandFrom = useCallback(
    (cmd: QualifiedCommand): Promise<void> =>
      executePluginSlashAction(cmd, {
        invokePluginAction,
        pushNotice,
        locale,
        conversationId: conversation.id,
      }),
    [invokePluginAction, pushNotice, locale, conversation.id],
  )

  // Consume the trigger word only after the command succeeds; when the user
  // already modified the draft, the new content must not be overwritten.
  const runPluginCommandImpl = useCallback((cmd: QualifiedCommand): void => {
    if (commandPendingRef.current) return
    commandPendingRef.current = true
    const el = textareaRef.current
    const before = liveDraftRef.current
    const caret = el?.selectionStart ?? before.text.length
    const { next, nextCaret } = removeTokenBeforeCaret(before.text, caret)
    void runPluginCommandFrom(cmd).then(() => {
      if (!shouldRestoreEditOnFailure(liveDraftRef.current, before)) return
      setText(next)
      syncLiveDraft(next, editingEntryId, attachments)
      if (el !== null) focusWithCaret(el, nextCaret)
    }).catch(() => { /* The action call already sent an explicit failure notice; keep the draft. */ }).finally(() => { commandPendingRef.current = false })
  }, [editingEntryId, attachments, syncLiveDraft, runPluginCommandFrom])
  // Slash menu entries persist across renders: the entry point takes the
  // latest implementation through a stable wrapper (instead of writing a
  // latest ref during render).
  const runPluginCommand = useStableCallback(runPluginCommandImpl)

  const runSlashCommand = (raw: string): boolean => {
    const cmd = raw.trim()
    if (cmd === '/new') {
      // /new is the new-topic entry: navigate to this agent's standby pane
      // (the conversation is only created on first send) without resetting the
      // original one; when no callback is provided (a non-conversation host),
      // notify explicitly — never guess a target or harm the original
      // conversation.
      if (onNewThread !== undefined) {
        onNewThread()
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.send.newTopicFromTopBar'),
          conversationId: conversation.id,
        })
      }
      return true
    }
    if (cmd === '/clear') {
      void conversationsApi
        .reset(conversation.id)
        .then(() => {
          pushNotice({ type: 'notification', level: 'info', title: t('composer.compaction.resetDone'), conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError(t('composer.compaction.resetFailed'), err))
      return true
    }
    const compactCmd = parseCompactSlashCommand(cmd)
    if (compactCmd !== null) {
      if (conversation.contextUsage?.compacting === true) {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.compaction.inProgress'),
          conversationId: conversation.id,
        })
        return true
      }
      void conversationsApi
        .compact(conversation.id, compactCmd.instructions)
        .then(() => {
          pushNotice({ type: 'notification', level: 'info', title: t('composer.compaction.submitted'), conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError(t('composer.compaction.failed'), err))
      return true
    }
    return false
  }

  const setDraftState = useCallback((next: string): void => {
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
  }, [editingEntryId, attachments, syncLiveDraft])

  const insertTextState = useCallback((fragment: string): void => {
    const el = textareaRef.current
    const currentText = liveDraftRef.current.text
    if (el === null) {
      const appended = currentText + fragment
      setText(appended)
      syncLiveDraft(appended, editingEntryId, attachments)
      return
    }
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = insertAtCaret(currentText, caret, fragment, el.selectionEnd ?? caret)
    setText(next)
    syncLiveDraft(next, editingEntryId, attachments)
    focusWithCaret(el, nextCaret)
  }, [text, editingEntryId, attachments, syncLiveDraft, textareaRef])

  const removeAttachment = useCallback((artifactId: string): void => {
    setAttachments((prev) => {
      const next = prev.filter((a) => a.artifactId !== artifactId)
      syncLiveDraft(text, editingEntryId, next)
      return next
    })
  }, [text, editingEntryId, syncLiveDraft])

  /** ↑ history-edit wholesale replacement: text / anchor / attachments (no
   * attachments on the target clears the old draft residue). */
  const applyHistoryEdit = useCallback((target: EditRequestTarget): void => {
    setText(target.text)
    setEditingEntryId(target.entryId ?? null)
    // Entering a history edit also wholly replaces attachments (an empty list
    // clears the old draft).
    setAttachments(attachmentsOfEditTarget(target))
    syncLiveDraft(target.text, target.entryId ?? null, attachmentsOfEditTarget(target))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [syncLiveDraft, textareaRef])

  /** ↑ queued-withdraw re-edit: withdraw the newest human queued input from
   * pi.inbox first, then prefill text and attachments. */
  const withdrawQueuedInput = useCallback(async (queued: QueuedConversationInput): Promise<void> => {
    if (withdrawingRef.current || sendingRef.current || uploadingRef.current > 0) return
    withdrawingRef.current = true
    try {
      const res = await conversationsApi.withdraw(conversation.id, queued.submissionId)
      if (!mountedRef.current) return
      const baseTarget: EditRequestTarget = {
        text: queued.text,
        ...(queued.attachments !== undefined && queued.attachments.length > 0
          ? { attachments: queued.attachments }
          : {}),
      }
      const live = liveDraftRef.current
      const draftModified = live.text !== '' || live.targetEntryId !== null
      if (res.status === 'withdrawn') {
        if (draftModified) {
          pushNotice({
            type: 'notification',
            level: 'info',
            title: t('composer.send.withdrawnTitle'),
            body: t('composer.send.withdrawnBody', { text: queued.text }),
            conversationId: conversation.id,
          })
          return
        }
        applyHistoryEdit(baseTarget)
      } else if ((res.status === 'already_placed' || res.status === 'settled') && res.entryId !== undefined) {
        if (draftModified) {
          pushNotice({
            type: 'notification',
            level: 'warning',
            title: t('composer.send.enteredExecutionTitle'),
            body: t('composer.send.enteredExecutionBody'),
            conversationId: conversation.id,
          })
          return
        }
        applyHistoryEdit({ ...baseTarget, entryId: res.entryId })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.send.cannotWithdrawTitle'),
          body: t('composer.send.cannotWithdrawBody', { status: res.status }),
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      if (mountedRef.current) {
        notifyError(t('composer.send.withdrawFailed'), err)
      }
    } finally {
      withdrawingRef.current = false
    }
  }, [conversation.id, applyHistoryEdit, notifyError, pushNotice, t])

  const send = useCallback(async (busyMode: WhenBusy = 'steer', strict = false): Promise<void> => {
    const draft = liveDraftRef.current.text
    const payload = draft.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) {
      if (strict) throw new Error('Current draft empty or a composer operation is already in flight')
      return
    }
    // Sending is disallowed while the environment is unsaved or still saving
    // (covers both Enter and the send button).
    if (envBlockedRef.current) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.env.saveOrCancelFirst'),
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      if (strict) throw new Error('Save or cancel the starting environment changes first')
      return
    }
    // Plugin slash commands: executed when the draft's first token exactly
    // hits an in-scope plugin command (non-editing mode only).
    const pluginCmd = matchExactPluginSlash(payload, slashPluginCommands)
    const editing = editingEntryId !== null
    if (!editing && pluginCmd !== undefined) {
      commandPendingRef.current = true
      const before = liveDraftRef.current
      try {
        await runPluginCommandFrom(pluginCmd)
        if (shouldRestoreEditOnFailure(liveDraftRef.current, before)) {
          setText('')
          syncLiveDraft('', editingEntryId, attachments)
        }
      } catch (error) {
        if (strict) throw error
      } finally {
        commandPendingRef.current = false
      }
      return
    }
    // Management commands like /new appearing inside edited text are just the
    // edited message's text, never executed immediately; only non-editing
    // input executes them as session management commands.
    const slash = editing ? false : runSlashCommand(payload)
    if (slash) {
      setText('')
      syncLiveDraft('', editingEntryId, attachments)
      return
    }
    const targetEntryId = editingEntryId
    const sentAttachments = new Set(attachments.map((attachment) => attachment.artifactId))
    // Freeze the draft at the send instant: on failure the rollback only
    // applies while the Composer is still in the expected post-optimistic-clear
    // state (no new input, no other target, no attachment change) — an old
    // target must never bind to new input.
    const frozenDraft = draftVersionOf(draft, targetEntryId, attachments)
    const expectedAfterClear = draftVersionOf('', null, attachments)
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    setText('')
    // Optimistically exit edit mode; on failure roll back per the frozen version.
    setEditingEntryId(null)
    syncLiveDraft('', null, attachments)
    try {
      await conversationsApi.submitInput(conversation.id, {
        text: payload,
        origin: 'human',
        ...(targetEntryId !== null ? { replaceFromEntryId: targetEntryId } : working ? { whenBusy: busyMode } : {}),
        ...(attachments.length > 0 ? { attachments: attachments.map((a) => a.artifactId) } : {}),
      })
      setAttachments((current) => {
        const next = current.filter((attachment) => !sentAttachments.has(attachment.artifactId))
        // Sent attachments leave the live version too, so residue cannot
        // mislead the onlyIfEmpty prefill or the rollback check.
        syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
        return next
      })
    } catch (err) {
      // Restore text and edit target only while the Composer is still in the
      // expected post-clear state; if the user already started new input or
      // picked another edit target, keep the present state — the old target
      // never flows back.
      const restore = shouldRestoreEditOnFailure(liveDraftRef.current, expectedAfterClear)
      if (restore) {
        setText(draft)
        if (frozenDraft.targetEntryId !== null) setEditingEntryId(frozenDraft.targetEntryId)
        syncLiveDraft(draft, frozenDraft.targetEntryId, attachments)
      }
      notifyError(targetEntryId !== null ? t('composer.send.updateFailed') : t('composer.send.sendFailed'), err)
      if (strict) throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [text, attachments, editingEntryId, working, runSlashCommand, syncLiveDraft, onSendingChange, notifyError, pushNotice, conversation.id, uploadingRef, envBlocker, runPluginCommandFrom, slashPluginCommands, t])

  // Explicit text submission: consumes no draft / edit anchor / attachments
  // (content not typed by the user, e.g. plugin command output). Shares the
  // sendingRef concurrency guard and onSendingChange in-flight feedback with
  // send; rejects honestly on failure.
  const sendExplicit = useCallback(async (raw: string, whenBusy?: WhenBusy): Promise<void> => {
    const payload = raw.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0) {
      throw new Error('composer_send_invalid')
    }
    if (envBlockedRef.current) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.env.saveOrCancelFirst'),
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      throw new Error('composer_env_blocked')
    }
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    try {
      await conversationsApi.submitInput(conversation.id, {
        text: payload,
        origin: 'human',
        ...(working ? { whenBusy: whenBusy ?? 'steer' } : {}),
      })
    } catch (err) {
      notifyError(t('composer.send.sendFailed'), err)
      throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [working, onSendingChange, notifyError, pushNotice, conversation.id, uploadingRef, envBlocker, t])

  const readLiveDraft = useCallback((): string => liveDraftRef.current.text, [])

  // Version auto-refresh pending check: report local draft dirtiness (aggregated
  // by the external bridge store, see composer-dirty.ts). Sync immediately on
  // change; clear on unmount by the instance key (the dep array holds only
  // dirtyKey, so re-renders never clear the report twice).
  useEffect(() => {
    if (dirtyKey === undefined) return
    setComposerDirty(dirtyKey, {
      hasDraftText: text.trim() !== '',
      editingEntry: editingEntryId !== null,
      hasAttachments: attachments.length > 0,
      busy: sending || uploading > 0,
    })
  }, [dirtyKey, text, editingEntryId, attachments, sending, uploading])
  useEffect(() => {
    if (dirtyKey === undefined) return
    return () => clearComposerDirty(dirtyKey)
  }, [dirtyKey])

  return {
    text,
    attachments,
    editingEntryId,
    sending,
    uploading,
    envBlocker,
    sendInFlight: sending || uploading > 0,
    setDraftState,
    insertTextState,
    readLiveDraft,
    cancelEdit,
    uploadFiles,
    removeAttachment,
    applyHistoryEdit,
    withdrawQueuedInput,
    send,
    sendExplicit,
    runPluginCommand,
    handleEnvBlocker: handleEnvBlockerStable,
    notifyError,
  }
}
