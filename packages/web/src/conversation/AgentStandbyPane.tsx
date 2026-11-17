import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ConversationSummary, Profile } from '@helm/protocol/browser'
import { assetsApi, conversationsApi } from '../lib/api.js'
import {
  buildSlashMenuItems,
  executePluginSlashAction,
  matchExactPluginSlash,
  pluginSlashCommandsFor,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { formatBytes } from '../lib/format.js'
import { errorText } from '../lib/error-text.js'
import { HelmIcon, Select, type SelectOption } from '@helm/plugin-client'
import { isSameResolvedTarget, type ResolvedTarget } from '../lib/types.js'
import {
  useConversations,
  useGroupedUi,
  useLoadError,
  useLocationTargets,
  useModels,
  useNodes,
  usePlugins,
  useProfilesSlice,
  useSkills,
  useStoreActions,
} from '../lib/store-context.js'
import { useWebLocale } from '../i18n/use-web-locale.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { Tooltip } from '../ui/Tooltip.js'
import { CommandPopover } from './CommandPopover.js'
import { CompletionPopover } from './CompletionPopover.js'
import { ModelPickerControl } from './ModelPicker.js'
import { focusWithCaret } from './composer-controller.js'
import { envDraftOnNodeChange, useIsMobile } from './composer-model.js'
import { slashMenuSkills } from './slash-menu-skills.js'
import { autoGrowTextarea, useComposerPopovers, useElementWidthResize } from './use-composer-popovers.js'
import {
  COMPOSER_SHORTCUTS,
  isComposerSubmitEnterEvent,
  isShiftTabEvent,
  nextThinkingLevel,
} from './keybindings-model.js'
import {
  admitStandbyFiles,
  currentStandbyDraftEpoch,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetEnvStandbyDraft,
  resolveStandbyEffectiveModel,
  resolveStandbyThinkingLevel,
  standbyDraftKey,
  standbyEnvError,
  standbyManageAction,
  updateStandbyDraft,
  useStandbyDraft,
  type StandbyDraftState,
  type StandbySendResult,
} from './standby-model.js'

export interface AgentStandbyPaneProps {
  profileId: string
  /** Draft environment carried by the target (delete-navigation / new-topic
   * inheritance; remote coordinates never silently fall back to local). */
  nodeId?: string
  cwd?: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

/**
 * Agent standby pane (rendered on the main stage / split):
 * - the agent is the stable entry: entering the standby state creates no
 *   conversation; the first send persists it;
 * - a missing Profile / disabled plugin / non-human-selectable profile is
 *   reported as-is; no other role is ever guessed;
 * - drafts (text / attachments / model / thinking level / environment) live in
 *   memory, isolated per panel; see standby-model.ts.
 */
export function AgentStandbyPane({ profileId, nodeId, cwd, isSplit, onCloseSplit }: AgentStandbyPaneProps) {
  const { profiles, assetsLoaded } = useProfilesSlice()
  const plugins = usePlugins()
  const conversations = useConversations()
  const groupedUi = useGroupedUi()
  const skills = useSkills()
  const { primaryTarget, splitTarget } = useLocationTargets()
  const profilesLoadError = useLoadError('assets:profiles')
  const { openTarget, closeSplit, pushNotice, invokePluginAction, refreshAssets } = useStoreActions()
  const { locale, t } = useWebLocale()
  const panel = isSplit ? 'split' : 'primary'
  // Draft identity = the full entry coordinate (panel + Profile + inherited
  // environment): the same Profile at different remote coordinates never shares
  // a draft, so an environment inherited from an earlier navigation is never
  // treated as a user edit and carried into the next first send.
  const inheritedNodeId = nodeId !== undefined && nodeId !== '' ? nodeId : undefined
  const inheritedCwd = cwd !== undefined && cwd !== '' ? cwd : undefined
  const draftKey = standbyDraftKey({ panel, profileId, nodeId: inheritedNodeId, cwd: inheritedCwd })
  const draft = useStandbyDraft(draftKey)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const profile = useMemo(() => profiles.find((p) => p.id === profileId), [profiles, profileId])
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(plugins), [plugins])
  const humanSelectable = profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)
  const anchoredConversation = useMemo(
    () => (draft.conversationId !== undefined ? conversations.find((c) => c.id === draft.conversationId) : undefined),
    [draft.conversationId, conversations],
  )
  const slashPluginCommands = useMemo(
    () => pluginSlashCommandsFor(groupedUi.commands, anchoredConversation),
    [groupedUi.commands, anchoredConversation],
  )
  const availableSkills = useMemo(
    () => (profile !== undefined ? slashMenuSkills(profile, skills, enabledPluginIds) : []),
    [profile, skills, enabledPluginIds],
  )
  const commandPendingRef = useRef(false)
  const [commandPending, setCommandPending] = useState(false)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => { mountedRef.current = false }
  }, [])

  // When the store carries no global default model, read /api/models/default
  // on demand to complete the model & thinking-level inheritance chain.
  const [fetchedDefaultModelInfo, setFetchedDefaultModelInfo] = useState<{
    defaultModel: string
    defaultThinkingLevel: string
    modelThinkingLevels?: Record<string, string>
  } | null>(null)
  const defaultModelGenRef = useRef(0)
  const refreshDefaultModelInfo = useCallback(async (): Promise<void> => {
    const gen = ++defaultModelGenRef.current
    try {
      const info = await assetsApi.getDefaultModel()
      if (gen !== defaultModelGenRef.current) return
      if (
        info !== null &&
        typeof info === 'object' &&
        !Array.isArray(info) &&
        typeof info.defaultModel === 'string' &&
        typeof info.defaultThinkingLevel === 'string'
      ) {
        setFetchedDefaultModelInfo({
          defaultModel: info.defaultModel,
          defaultThinkingLevel: info.defaultThinkingLevel,
          ...(info.modelThinkingLevels !== undefined ? { modelThinkingLevels: info.modelThinkingLevels } : {}),
        })
      }
    } catch {
      /* Keep null when the global default cannot be read; fall back to the
       * profile's own model and the "Default model" label. */
    }
  }, [])
  useEffect(() => {
    void refreshDefaultModelInfo()
    return () => { defaultModelGenRef.current++ }
  }, [refreshDefaultModelInfo])
  const effectiveDefaultModelInfo = fetchedDefaultModelInfo

  // Target-environment inheritance: after coordinate isolation, each draft
  // adopts this coordinate's environment on first mount (user edits win and
  // are never overwritten).
  useEffect(() => {
    const record = getStandbyDraft(draftKey)
    if (record.envCustomized) return
    const env = inheritedEnvOf({ nodeId: inheritedNodeId, cwd: inheritedCwd })
    if (env.nodeId === undefined && env.cwd === undefined) return
    updateStandbyDraft(draftKey, { envCustomized: true, envNodeId: env.nodeId, envCwd: env.cwd })
  }, [draftKey, inheritedNodeId, inheritedCwd])

  // "Still viewing this target" check: compares the same complete target
  // (including the environment coordinate); a first send while switched to
  // another environment of the same Profile never hijacks navigation.
  // Invalidated immediately on unmount so a stale ref of an unmounted
  // component cannot pull navigation back to an already-left standby target.
  const coordinateTarget = useMemo<ResolvedTarget>(
    () => ({
      kind: 'agent',
      profileId,
      ...(inheritedNodeId !== undefined ? { nodeId: inheritedNodeId } : {}),
      ...(inheritedCwd !== undefined ? { cwd: inheritedCwd } : {}),
    }),
    [profileId, inheritedNodeId, inheritedCwd],
  )
  const viewingRef = useRef(false)
  viewingRef.current = isSplit
    ? isSameResolvedTarget(splitTarget, coordinateTarget)
    : isSameResolvedTarget(primaryTarget, coordinateTarget)
  useEffect(() => {
    viewingRef.current = true
    return () => { viewingRef.current = false }
  }, [])

  const send = useCallback((): Promise<StandbySendResult> =>
    executeStandbySend(draftKey, profileId, {
      create: (init) => conversationsApi.create(init),
      patchThinkingLevel: (id, thinkingLevel) => conversationsApi.patch(id, { thinkingLevel }).then(() => undefined),
      upload: (id, file) => conversationsApi.uploadArtifact(id, file),
      submit: (id, payload) => conversationsApi.submitInput(id, payload).then(() => undefined),
      notifyError: (title, err, conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'error',
          title,
          body: errorText(err),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      },
      notifySentInBackground: (conversationId) => {
        pushNotice({
          type: 'notification',
          level: 'info',
          title: t('composer.standby.sentInBackgroundTitle'),
          body: t('composer.standby.sentInBackgroundBody', { id: conversationId }),
          conversationId,
        })
      },
      navigateToConversation: (conversationId) => {
        // The panel hosting the standby target is where the new conversation
        // lands: a first send on the right panel replaces only the right one
        // and never hijacks the primary panel.
        openTarget(
          { kind: 'conversation', conversationId },
          { history: 'replace', ...(isSplit ? { split: true } : {}) },
        )
      },
      isStillViewing: () => viewingRef.current,
    }, t), [draftKey, profileId, isSplit, openTarget, pushNotice, t])

  const addFiles = useCallback((files: ReadonlyArray<File>): void => {
    if (files.length === 0 || getStandbyDraft(draftKey).sending) return
    const { draft: patch, rejected } = admitStandbyFiles(getStandbyDraft(draftKey), files, t)
    updateStandbyDraft(draftKey, patch)
    for (const item of rejected) {
      pushNotice({
        type: 'notification',
        level: 'error',
        title: t('composer.standby.attachmentRejectedTitle', { name: item.file.name || t('composer.standby.unnamedFile') }),
        body: item.reason,
      })
    }
  }, [draftKey, pushNotice, t])

  const applyStarter = useCallback((prompt: string): void => {
    const record = getStandbyDraft(draftKey)
    if (record.sending) return
    if (record.text.trim() !== '' || record.localFiles.length > 0 || record.uploaded.length > 0) {
      pushNotice({ type: 'notification', level: 'warning', title: t('composer.draft.handleBeforeStarter') })
      return
    }
    updateStandbyDraft(draftKey, { text: prompt })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [draftKey, pushNotice, t])

  const executeStandbyPluginCommand = useCallback((cmd: QualifiedCommand, mode: 'token' | 'clear'): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    commandPendingRef.current = true
    setCommandPending(true)
    const el = textareaRef.current
    const epoch = currentStandbyDraftEpoch()
    const beforeText = record.text
    const caret = el?.selectionStart ?? beforeText.length
    const resolved = mode === 'token' ? removeTokenBeforeCaret(beforeText, caret) : { next: '', nextCaret: 0 }
    void executePluginSlashAction(cmd, {
      invokePluginAction,
      pushNotice,
      locale,
      ...(record.conversationId !== undefined ? { conversationId: record.conversationId } : {}),
    }).then(() => {
      if (epoch !== currentStandbyDraftEpoch()) return
      if (getStandbyDraft(draftKey).text !== beforeText) return
      updateStandbyDraft(draftKey, { text: resolved.next })
      if (mode === 'token' && el !== null && el.isConnected) focusWithCaret(el, resolved.nextCaret)
    }).catch(() => {
      /* The action call already sent an explicit failure notice; keep the draft. */
    }).finally(() => {
      commandPendingRef.current = false
      if (mountedRef.current) setCommandPending(false)
    })
  }, [draftKey, invokePluginAction, locale, pushNotice])
  const runPluginCommand = useStableCallback((cmd: QualifiedCommand): void => {
    executeStandbyPluginCommand(cmd, 'token')
  })

  // First-send submit entry: intercept plugin slash commands and host
  // management commands first (no real conversation exists to bind them to;
  // never sent to the model as plain input), then enter the real first-send
  // pipeline.
  const submitDraft = useCallback((): void => {
    const record = getStandbyDraft(draftKey)
    if (commandPendingRef.current || record.sending) return
    const pluginCmd = matchExactPluginSlash(record.text.trim(), slashPluginCommands)
    if (pluginCmd !== undefined) {
      executeStandbyPluginCommand(pluginCmd, 'clear')
      return
    }
    const action = standbyManageAction(record.text)
    if (action !== null) {
      if (action.kind === 'clear-draft') {
        updateStandbyDraft(draftKey, { text: '', localFiles: [], uploaded: [], error: null })
        pushNotice({ type: 'notification', level: 'info', title: t('composer.standby.newDraftStartedTitle'), body: t('composer.standby.newDraftStartedBody') })
      } else {
        pushNotice({
          type: 'notification',
          level: 'warning',
          title: t('composer.standby.needsConversationTitle', { command: action.command }),
          body: t('composer.standby.needsConversationBody'),
        })
      }
      return
    }
    void send()
  }, [draftKey, executeStandbyPluginCommand, pushNotice, send, slashPluginCommands, t])

  // Restore defaults: clears the inherited/custom environment; when the URL
  // carries inherited coordinates, the sole navigation removes the matching
  // parameters (no revival on refresh). The draft text moves with the
  // coordinate; when the target coordinate already holds a draft it is never
  // overwritten and the user is told explicitly.
  const resetEnvToDefault = useCallback((): void => {
    if (draft.sending || draft.conversationId !== undefined) return
    const toKey = standbyDraftKey({ panel, profileId })
    if (toKey === draftKey) {
      resetEnvStandbyDraft(draftKey, toKey)
      return
    }
    const moved = resetEnvStandbyDraft(draftKey, toKey)
    if (!moved) {
      pushNotice({
        type: 'notification',
        level: 'warning',
        title: t('composer.standby.defaultEnvHasDraftTitle'),
        body: t('composer.standby.defaultEnvHasDraftBody'),
      })
    }
    openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined)
  }, [draft.sending, draft.conversationId, draftKey, isSplit, openTarget, panel, profileId, pushNotice, t])

  const toggleSplit = (): void => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (splitTarget !== null) {
      closeSplit()
      return
    }
    openTarget({ kind: 'agent', profileId }, { split: true })
  }

  const label = profile?.name || profileId
  const envError = standbyEnvError(draft, t)

  return (
    <div className="helm-pane agent-standby-pane" data-agent={profileId}>
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          <span className="pane-title">{label}</span>
          <span className="pane-cwd-subtitle">
            <span className="env-subtitle-full">{t('composer.standby.newTopic')}</span>
          </span>
        </div>
        <div className="pane-actions">
          {isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton isSplitActive={splitTarget !== null} onToggleSplit={toggleSplit} />
          )}
        </div>
      </header>

      <div className="agent-standby-body">
        {profilesLoadError !== undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="alert-triangle" size={20} />
            <span>{t('composer.standby.profileLoadFailed', { error: profilesLoadError })}</span>
            <button type="button" className="btn btn-sm" onClick={() => void refreshAssets()}>
              {t('common.retry')}
            </button>
          </div>
        ) : !assetsLoaded ? (
          <div className="timeline-empty-state" role="status">
            <HelmIcon name="loader" size={20} className="spin-slow" />
            <span>{t('composer.standby.loadingProfile')}</span>
          </div>
        ) : profile === undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="circle-slash" size={20} />
            <span>{t('composer.standby.profileMissing', { profileId })}</span>
            <button type="button" className="btn btn-sm" onClick={() => openTarget({ kind: 'profiles' })}>
              {t('composer.standby.goToProfiles')}
            </button>
          </div>
        ) : !humanSelectable ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="lock" size={20} />
            <span>{t('composer.standby.notHumanSelectable')}</span>
          </div>
        ) : (
          <>
            <div className="agent-standby-intro">
              <span className="agent-standby-intro-name">{label}</span>
              <span className="agent-standby-intro-hint">{t('composer.standby.introHint')}</span>
            </div>
            {profile.starters !== undefined && profile.starters.length > 0 ? (
              <div className="timeline-starters">
                {profile.starters.map((starter, index) => (
                  <button
                    key={`starter-${index}-${starter.label}`}
                    type="button"
                    className="timeline-starter-btn"
                    title={starter.prompt}
                    disabled={draft.sending}
                    onClick={() => applyStarter(starter.prompt)}
                  >
                    <HelmIcon name="corner-down-right" size={11} />
                    <span className="timeline-starter-label">{starter.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        )}
      </div>

      {assetsLoaded && profile !== undefined && humanSelectable ? (
        <StandbyComposer
          draftKey={draftKey}
          draft={draft}
          profile={profile}
          defaultModelInfo={effectiveDefaultModelInfo}
          envError={envError}
          anchored={draft.conversationId !== undefined}
          anchoredConversation={anchoredConversation}
          commandPending={commandPending}
          availableSkills={availableSkills}
          slashPluginCommands={slashPluginCommands}
          onRunPluginCommand={runPluginCommand}
          isSplit={isSplit}
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          onSend={submitDraft}
          onAddFiles={addFiles}
          onResetEnvToDefault={resetEnvToDefault}
          onCatalogRefreshed={refreshDefaultModelInfo}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Standby input area (a true draft: text + staged attachments + model/thinking
// level + static '/' skill completion + starting environment)
// ---------------------------------------------------------------------------

interface StandbyComposerProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  defaultModelInfo: { defaultModel: string; defaultThinkingLevel: string; modelThinkingLevels?: Record<string, string> } | null
  envError: string | null
  /** create has locked a real conversation: model/thinking/environment are
   * fixed with it and accept no further edits. */
  anchored: boolean
  anchoredConversation: ConversationSummary | undefined
  commandPending: boolean
  availableSkills: ReadonlyArray<{ id: string; name: string }>
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  onRunPluginCommand: (cmd: QualifiedCommand) => void
  isSplit?: boolean
  textareaRef: { current: HTMLTextAreaElement | null }
  fileInputRef: { current: HTMLInputElement | null }
  onSend: () => void
  onAddFiles: (files: ReadonlyArray<File>) => void
  onResetEnvToDefault: () => void
  onCatalogRefreshed: () => Promise<void>
}

function StandbyComposer({
  draftKey,
  draft,
  profile,
  defaultModelInfo,
  envError,
  anchored,
  anchoredConversation,
  commandPending,
  availableSkills,
  slashPluginCommands,
  onRunPluginCommand,
  isSplit,
  textareaRef,
  fileInputRef,
  onSend,
  onAddFiles,
  onResetEnvToDefault,
  onCatalogRefreshed,
}: StandbyComposerProps) {
  const models = useModels()
  const groupedUi = useGroupedUi()
  const { openTarget } = useStoreActions()
  const { locale, t } = useWebLocale()
  const composerBoxRef = useRef<HTMLDivElement | null>(null)
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const isMobile = useIsMobile(680)
  const busy = draft.sending
  const sendDisabled = busy || commandPending || draft.text.trim() === '' || envError !== null
  // Once anchored, every creation-affecting configuration locks: retries skip
  // create, new settings never apply; controls may stay visible but inert.
  const configLocked = busy || anchored

  const effectiveModel = resolveStandbyEffectiveModel(
    draft.model,
    profile.model,
    defaultModelInfo?.defaultModel,
  )
  const currentModel = effectiveModel !== undefined
    ? models.find((model) => model.id === effectiveModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const effectiveThinkingLevel = resolveStandbyThinkingLevel(
    currentLevels,
    draft.thinkingLevel,
    effectiveModel !== undefined ? defaultModelInfo?.modelThinkingLevels?.[effectiveModel] : undefined,
    profile.thinkingLevel,
    defaultModelInfo?.defaultThinkingLevel,
  )

  useLayoutEffect(() => {
    autoGrowTextarea(textareaRef.current)
  }, [draft.text, isMobile])
  useElementWidthResize(textareaRef, () => autoGrowTextarea(textareaRef.current))

  const readLiveDraft = useCallback((): string => getStandbyDraft(draftKey).text, [draftKey])
  const setDraftState = useCallback((next: string): void => {
    updateStandbyDraft(draftKey, { text: next })
  }, [draftKey])

  const {
    slashOpen,
    popoverQuery,
    completionOpen,
    completionTrigger,
    completionSnapshot,
    detectPopover,
    handleTextareaKeyUp,
    handleTextareaClick,
    shouldDeferKeyToPopover,
    applySlashPick,
    closeSlashPopover,
    applyCompletionPick,
    closeCompletionPopover,
  } = useComposerPopovers({
    textareaRef,
    draftText: draft.text,
    readLiveDraft,
    setDraftState,
    completers: groupedUi.composerCompleters,
    conversation: anchoredConversation,
    profileId: profile.id,
    resetKey: draftKey,
    disabled: busy,
  })

  const slashMenuItems = useMemo(
    () => buildSlashMenuItems(availableSkills, slashPluginCommands, onRunPluginCommand, locale),
    [availableSkills, slashPluginCommands, onRunPluginCommand, locale],
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.defaultPrevented || e.nativeEvent.defaultPrevented) {
      return
    }
    if (shouldDeferKeyToPopover(e)) {
      return
    }
    if (isShiftTabEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (configLocked) return
      const next = nextThinkingLevel(currentLevels, effectiveThinkingLevel)
      if (next !== null) {
        updateStandbyDraft(draftKey, { thinkingLevel: next })
      }
      return
    }
    if (isComposerSubmitEnterEvent(e) && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!sendDisabled) onSend()
      return
    }
  }

  const onPaste = (e: React.ClipboardEvent): void => {
    const files = Array.from(e.clipboardData?.files ?? [])
    if (files.length > 0) {
      e.preventDefault()
      onAddFiles(files)
    }
  }

  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault()
    dragDepthRef.current = 0
    setDragging(false)
    const files = Array.from(e.dataTransfer.files ?? [])
    if (files.length > 0) onAddFiles(files)
  }

  const removeLocalFile = (key: string): void => {
    updateStandbyDraft(draftKey, { localFiles: draft.localFiles.filter((item) => item.key !== key) })
  }
  const removeUploaded = (artifactId: string): void => {
    updateStandbyDraft(draftKey, { uploaded: draft.uploaded.filter((item) => item.artifactId !== artifactId) })
  }

  return (
    <div className="composer-shell">
      <div className="composer-inner">
        <StandbyEnvBar draftKey={draftKey} draft={draft} profile={profile} disabled={configLocked} onResetToDefault={onResetEnvToDefault} />
        {anchored ? (
          <div className="agent-standby-anchored callout" role="status">
            <HelmIcon name="lock" size={12} />
            <span className="agent-standby-anchored-text">
              {t('composer.standby.anchoredNotice', { id: draft.conversationId! })}
            </span>
            <Tooltip content={t('composer.standby.openCreatedInPanel')} side="top">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (draft.conversationId === undefined) return
                  openTarget(
                    { kind: 'conversation', conversationId: draft.conversationId },
                    isSplit ? { split: true } : undefined,
                  )
                }}
              >
                {t('composer.standby.viewConversation')}
              </button>
            </Tooltip>
          </div>
        ) : null}
        {draft.error !== null ? (
          <div className="agent-standby-error callout callout--error" role="alert">
            <span className="agent-standby-error-text">{draft.error}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onSend}>
              {t('common.retry')}
            </button>
          </div>
        ) : null}
        <div
          className="composer-box"
          ref={composerBoxRef}
          data-dragging={dragging ? 'true' : undefined}
          onDragEnter={(e) => {
            e.preventDefault()
            dragDepthRef.current += 1
            if (e.dataTransfer.types.includes('Files')) setDragging(true)
          }}
          onDragOver={(e) => e.preventDefault()}
          onDragLeave={(e) => {
            e.preventDefault()
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
            if (dragDepthRef.current === 0) setDragging(false)
          }}
          onDrop={onDrop}
        >
          {draft.localFiles.length > 0 || draft.uploaded.length > 0 ? (
            <div className="composer-attachments">
              {draft.localFiles.map((att) => (
                <span key={att.key} className="attachment-chip">
                  <HelmIcon name="file" size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  <span className="badge badge-neutral agent-standby-attachment-state">{t('composer.standby.attachmentPending')}</span>
                  <Tooltip content={t('composer.standby.removeAttachmentTitle', { name: att.name })} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title={t('composer.standby.removeAttachment')}
                      aria-label={t('composer.standby.removeAttachmentTitle', { name: att.name })}
                      disabled={busy}
                      onClick={() => removeLocalFile(att.key)}
                    >
                      <HelmIcon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              ))}
              {draft.uploaded.map((att) => (
                <span key={att.artifactId} className="attachment-chip">
                  <HelmIcon name="paperclip" size={11} />
                  <span>{att.name}</span>
                  <span className="mono tabular-nums">{formatBytes(att.size)}</span>
                  <span className="badge badge-ok agent-standby-attachment-state">{t('composer.standby.attachmentUploaded')}</span>
                  <Tooltip content={t('composer.standby.removeAttachmentTitle', { name: att.name })} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title={t('composer.standby.removeAttachment')}
                      aria-label={t('composer.standby.removeAttachmentTitle', { name: att.name })}
                      disabled={busy}
                      onClick={() => removeUploaded(att.artifactId)}
                    >
                      <HelmIcon name="x" size={10} />
                    </button>
                  </Tooltip>
                </span>
              ))}
            </div>
          ) : null}
          <textarea
            aria-label={t('composer.standby.firstMessageAria', { name: profile.name || profile.id })}
            ref={textareaRef}
            className="composer-textarea selectable"
            value={draft.text}
            rows={1}
            readOnly={busy}
            placeholder={isMobile ? t('composer.standby.placeholderMobile') : t('composer.standby.placeholder')}
            onChange={(e) => {
              updateStandbyDraft(draftKey, { text: e.target.value })
              detectPopover(e.target.value, e.target.selectionStart ?? e.target.value.length)
            }}
            onKeyUp={handleTextareaKeyUp}
            onClick={handleTextareaClick}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          {slashOpen ? (
            <CommandPopover
              query={popoverQuery}
              slashItems={slashMenuItems}
              onPick={applySlashPick}
              onClose={closeSlashPopover}
            />
          ) : null}
          <CompletionPopover
            open={completionOpen}
            trigger={completionTrigger}
            snapshot={completionSnapshot}
            onPick={applyCompletionPick}
            onClose={closeCompletionPopover}
            anchorRef={composerBoxRef}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <Tooltip content={t('composer.standby.chooseAttachments')} side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title={t('composer.standby.chooseAttachments')}
                  aria-label={t('composer.standby.chooseAttachments')}
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HelmIcon name="plus" size={19} />
                </button>
              </Tooltip>
              <StandbyModelPicker
                draftKey={draftKey}
                draft={draft}
                profile={profile}
                defaultModelInfo={defaultModelInfo}
                disabled={configLocked}
                isSplit={isSplit}
                onCatalogRefreshed={onCatalogRefreshed}
              />
              <input
                ref={fileInputRef}
                type="file"
                multiple
                style={{ display: 'none' }}
                disabled={busy}
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? [])
                  e.target.value = ''
                  onAddFiles(files)
                }}
              />
            </div>
            <span className="composer-toolbar-right">
              <button
                type="button"
                className="btn btn-sm btn-primary btn-pill btn-send"
                disabled={sendDisabled}
                onClick={onSend}
                title={envError !== null ? envError : t('composer.standby.sendTitle')}
                aria-label={busy ? t('composer.standby.sendingAria') : t('composer.sendControls.send')}
              >
                <HelmIcon name={busy ? 'loader' : 'arrow-up'} size={18} className={busy ? 'spin-slow' : undefined} />
              </button>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Model / thinking-level picking (model rides with create; thinking level is
// patched after creation; reuses ModelPickerControl)
// ---------------------------------------------------------------------------

function StandbyModelPicker({
  draftKey,
  draft,
  profile,
  defaultModelInfo,
  disabled,
  isSplit,
  onCatalogRefreshed,
}: {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  defaultModelInfo: { defaultModel: string; defaultThinkingLevel: string; modelThinkingLevels?: Record<string, string> } | null
  disabled: boolean
  isSplit?: boolean
  onCatalogRefreshed: () => Promise<void>
}) {
  const models = useModels()
  const { t } = useWebLocale()
  const lockedNote = t('composer.model.lockedNote')

  const effectiveModel = resolveStandbyEffectiveModel(
    draft.model,
    profile.model,
    defaultModelInfo?.defaultModel,
  )
  const currentModel = effectiveModel !== undefined
    ? models.find((model) => model.id === effectiveModel)
    : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')
  const effectiveThinkingLevel = resolveStandbyThinkingLevel(
    currentLevels,
    draft.thinkingLevel,
    effectiveModel !== undefined ? defaultModelInfo?.modelThinkingLevels?.[effectiveModel] : undefined,
    profile.thinkingLevel,
    defaultModelInfo?.defaultThinkingLevel,
  )
  const showThinkingBadge = supportsThinking && effectiveThinkingLevel !== '' && effectiveThinkingLevel !== 'off'

  const pickModel = (model: string): void => {
    // Reset the thinking level to undefined after a model switch so it
    // re-resolves against the new model's capabilities.
    updateStandbyDraft(draftKey, { model, thinkingLevel: undefined })
  }
  const resetToDefault = (): void => {
    updateStandbyDraft(draftKey, { model: undefined, thinkingLevel: undefined })
  }
  const pickThinking = (level: string): void => {
    updateStandbyDraft(draftKey, { thinkingLevel: level })
  }

  const thinkingSuffix = showThinkingBadge ? t('composer.model.thinkingSuffix', { level: effectiveThinkingLevel }) : ''

  return (
    <ModelPickerControl
      effectiveModel={effectiveModel}
      selectedModel={draft.model}
      activeThinkingLevel={effectiveThinkingLevel}
      fallbackPanel={isSplit ? 'split' : 'primary'}
      resetLabel={
        profile.model !== undefined && profile.model !== ''
          ? t('composer.model.followProfileDefaultModel', { model: profile.model })
          : t('composer.model.followProfileDefault')
      }
      resetTitle={t('composer.model.standbyResetTitle')}
      buttonTitle={
        disabled
          ? lockedNote
          : effectiveModel !== undefined && effectiveModel !== ''
            ? t('composer.model.currentTitle', { model: effectiveModel, thinking: thinkingSuffix, shortcut: COMPOSER_SHORTCUTS.toggleModelPicker })
            : t('composer.model.followsDefaultTitle', { thinking: thinkingSuffix, shortcut: COMPOSER_SHORTCUTS.toggleModelPicker })
      }
      disabled={disabled}
      onPickModel={pickModel}
      onResetDefault={resetToDefault}
      onPickThinking={pickThinking}
      onCatalogRefreshed={onCatalogRefreshed}
    />
  )
}

// ---------------------------------------------------------------------------
// Starting environment bar (local draft, no PATCH; submitted with create on send)
// ---------------------------------------------------------------------------

function StandbyEnvBar({ draftKey, draft, profile, disabled, onResetToDefault }: {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  disabled: boolean
  onResetToDefault: () => void
}) {
  const nodes = useNodes()
  const { t } = useWebLocale()

  const startCustomize = (): void => {
    if (disabled) return
    updateStandbyDraft(draftKey, {
      envCustomized: true,
      envNodeId: profile.nodeId || 'local',
      envCwd: profile.cwd ?? '',
    })
  }

  const nodeOptions = useMemo<SelectOption<string>[]>(() => {
    const nodeId = draft.envNodeId || 'local'
    const list: SelectOption<string>[] = nodes.map((n) => ({
      value: n.id,
      label: nodeOptionLabel(n),
      icon: n.id === 'local' ? 'monitor' : 'network',
      meta: n.id !== 'local' ? (n.online ? t('common.online') : t('common.offline')) : undefined,
    }))
    if (!nodes.some((n) => n.id === nodeId)) {
      list.push({ value: nodeId, label: t('composer.env.nodeUnknownOption', { nodeId }), icon: 'alert-circle' })
    }
    return list
  }, [nodes, draft.envNodeId, t])

  if (!draft.envCustomized) {
    return (
      <div className="composer-env-bar agent-standby-env-bar">
        <HelmIcon name="monitor" size={12} />
        <span className="agent-standby-env-hint">
          {t('composer.standby.envFollowsProfile', {
            node: profile.nodeId !== undefined && profile.nodeId !== '' ? t('composer.standby.envSuffix', { value: profile.nodeId }) : '',
            cwd: profile.cwd ? t('composer.standby.envSuffix', { value: profile.cwd }) : '',
          })}
        </span>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={startCustomize}>
          {t('composer.standby.customEnvButton')}
        </button>
      </div>
    )
  }

  const draftNode = nodes.find((n) => n.id === (draft.envNodeId || 'local'))
  return (
    <div className="composer-env-bar agent-standby-env-bar" data-dirty="true">
      <span className="composer-env-item">
        <Select
          className="composer-env-select"
          aria-label={t('composer.standby.envNodeAria')}
          disabled={disabled}
          value={draft.envNodeId || 'local'}
          options={nodeOptions}
          onChange={(e) => {
            const next = envDraftOnNodeChange({ nodeId: draft.envNodeId || 'local', cwd: draft.envCwd ?? '' }, e.target.value)
            updateStandbyDraft(draftKey, { envNodeId: next.nodeId, envCwd: next.cwd })
          }}
        />
      </span>
      <span className="composer-env-item composer-env-cwd-wrap">
        <HelmIcon name="folder" size={12} className="composer-env-cwd-icon" />
        <input
          className="input mono composer-env-cwd-input"
          aria-label={t('composer.standby.envCwdAria')}
          value={draft.envCwd ?? ''}
          disabled={disabled}
          placeholder={t('composer.env.cwdPlaceholder')}
          onChange={(e) => updateStandbyDraft(draftKey, { envCwd: e.target.value })}
        />
      </span>
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={onResetToDefault} title={disabled ? t('composer.standby.envLockedTitle') : t('composer.standby.clearEnvTitle')}>
        {t('composer.standby.restoreDefaults')}
      </button>
      <span className="composer-env-hint">{t('composer.standby.envEffectOnSend')}</span>
      {draftNode !== undefined && !draftNode.online && draft.envNodeId !== 'local' ? (
        <span className="composer-env-warn">{t('composer.standby.nodeOfflineWarn')}</span>
      ) : null}
    </div>
  )
}
