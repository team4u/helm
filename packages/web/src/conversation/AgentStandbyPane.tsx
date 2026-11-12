import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Profile } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import { errorText, formatBytes } from '../lib/format.js'
import { HelmIcon } from '../lib/icons.js'
import { isSameResolvedTarget, type ResolvedTarget } from '../lib/types.js'
import { useHelmStore } from '../lib/store-context.js'
import { nodeOptionLabel } from '../modals/nodes-modal-model.js'
import { collectEnabledPluginIds, isHumanSelectableProfile } from '../shell/sidebar-model.js'
import { Popover, PopoverContent, PopoverPortal, PopoverTrigger } from '../ui/Popover.js'
import { Select, type SelectOption } from '../ui/Select.js'
import { ThinkingLevelControl } from '../ui/ThinkingLevelControl.js'
import { CloseSplitButton, SplitToggleButton } from '../ui/SplitControls.js'
import { Tooltip } from '../ui/Tooltip.js'
import { envDraftOnNodeChange, useIsMobile } from './composer-model.js'
import {
  admitStandbyFiles,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetEnvStandbyDraft,
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
  /** 目标携带的草稿环境（删除导航/新话题继承；远端坐标不悄悄回落本机）。 */
  nodeId?: string
  cwd?: string
  isSplit?: boolean
  onCloseSplit?: () => void
}

/**
 * 智能体待命页（主舞台/分屏渲染）：
 * - 智能体是稳定入口：进入待命态不创建会话，首次发送才落库；
 * - 缺 Profile / 插件停用 / 人类不可选如实给出不可用状态，不猜测其他角色；
 * - 草稿（正文/附件/模型/思考档位/环境）只在内存并按面板隔离，见 standby-model.ts。
 */
export function AgentStandbyPane({ profileId, nodeId, cwd, isSplit, onCloseSplit }: AgentStandbyPaneProps) {
  const store = useHelmStore()
  const panel = isSplit ? 'split' : 'primary'
  // 草稿身份 = 完整入口坐标（面板 + Profile + 继承环境）：同 Profile 不同远端坐标互不串草稿，
  // 避免上次导航继承的环境被当作用户编辑带入下一次首发。
  const inheritedNodeId = nodeId !== undefined && nodeId !== '' ? nodeId : undefined
  const inheritedCwd = cwd !== undefined && cwd !== '' ? cwd : undefined
  const draftKey = standbyDraftKey({ panel, profileId, nodeId: inheritedNodeId, cwd: inheritedCwd })
  const draft = useStandbyDraft(draftKey)
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const isMobile = useIsMobile(680)

  const profile = useMemo(() => store.profiles.find((p) => p.id === profileId), [store.profiles, profileId])
  const enabledPluginIds = useMemo(() => collectEnabledPluginIds(store.plugins), [store.plugins])
  const humanSelectable = profile !== undefined && isHumanSelectableProfile(profile, enabledPluginIds)

  // 目标环境继承：按坐标隔离后，每份草稿首次挂载即采纳本坐标环境（用户编辑优先不被覆盖）。
  useEffect(() => {
    const record = getStandbyDraft(draftKey)
    if (record.envCustomized) return
    const env = inheritedEnvOf({ nodeId: inheritedNodeId, cwd: inheritedCwd })
    if (env.nodeId === undefined && env.cwd === undefined) return
    updateStandbyDraft(draftKey, { envCustomized: true, envNodeId: env.nodeId, envCwd: env.cwd })
  }, [draftKey, inheritedNodeId, inheritedCwd])

  // 「仍在当前视口」判定：比较同一完整目标（含环境坐标）；首发中切同 Profile 其他环境不抢导航。
  // 卸载时立即失效，防止已卸载组件的旧 ref 把导航拉回已离开的待命目标。
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
    ? isSameResolvedTarget(store.splitTarget, coordinateTarget)
    : isSameResolvedTarget(store.primaryTarget, coordinateTarget)
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
        store.pushNotice({
          type: 'notification',
          level: 'error',
          title,
          body: errorText(err),
          ...(conversationId !== undefined ? { conversationId } : {}),
        })
      },
      notifySentInBackground: (conversationId) => {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '已发送并创建会话',
          body: `首条消息已发送到会话 #${conversationId}`,
          conversationId,
        })
      },
      navigateToConversation: (conversationId) => {
        // 待命目标所在面板即新会话落点：右屏首发只替换右屏，不劫持主屏。
        store.openTarget(
          { kind: 'conversation', conversationId },
          { history: 'replace', ...(isSplit ? { split: true } : {}) },
        )
      },
      isStillViewing: () => viewingRef.current,
    }), [draftKey, profileId, isSplit, store])

  const addFiles = useCallback((files: ReadonlyArray<File>): void => {
    if (files.length === 0 || getStandbyDraft(draftKey).sending) return
    const { draft: patch, rejected } = admitStandbyFiles(getStandbyDraft(draftKey), files)
    updateStandbyDraft(draftKey, patch)
    for (const item of rejected) {
      store.pushNotice({ type: 'notification', level: 'error', title: `附件无法暂存：${item.file.name || '未命名文件'}`, body: item.reason })
    }
  }, [draftKey, store])

  const applyStarter = useCallback((prompt: string): void => {
    const record = getStandbyDraft(draftKey)
    if (record.sending) return
    if (record.text.trim() !== '' || record.localFiles.length > 0 || record.uploaded.length > 0) {
      store.pushNotice({ type: 'notification', level: 'warning', title: '请先处理当前草稿，再选择引导词' })
      return
    }
    updateStandbyDraft(draftKey, { text: prompt })
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [draftKey, store])

  // 首发提交入口：先拦截会话管理命令（无真实会话可绑定，绝不作为普通输入发给模型），
  // 再进入真实首发编排。
  const submitDraft = useCallback((): void => {
    const action = standbyManageAction(getStandbyDraft(draftKey).text)
    if (action !== null) {
      if (action.kind === 'clear-draft') {
        updateStandbyDraft(draftKey, { text: '', localFiles: [], uploaded: [], error: null })
        store.pushNotice({ type: 'notification', level: 'info', title: '已开始新草稿', body: '继续输入新的首条消息即可' })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: `${action.command} 需要已有会话`,
          body: '请先发送首条消息创建会话后再使用该命令',
        })
      }
      return
    }
    void send()
  }, [draftKey, send, store])

  // 恢复默认：清除继承/自定义环境；URL 已携带继承坐标时经唯一导航移除对应参数（刷新不复活），
  // 草稿正文随坐标转移，目标坐标已有草稿时不覆盖并显式告知。
  const resetEnvToDefault = useCallback((): void => {
    if (draft.sending || draft.conversationId !== undefined) return
    const toKey = standbyDraftKey({ panel, profileId })
    if (toKey === draftKey) {
      resetEnvStandbyDraft(draftKey, toKey)
      return
    }
    const moved = resetEnvStandbyDraft(draftKey, toKey)
    if (!moved) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: '默认环境已有其他草稿',
        body: '未覆盖该草稿；当前草稿仍保留在原环境坐标',
      })
    }
    store.openTarget({ kind: 'agent', profileId }, isSplit ? { split: true } : undefined)
  }, [draft.sending, draft.conversationId, draftKey, isSplit, panel, profileId, store])

  const autoGrow = useCallback((): void => {
    const el = textareaRef.current
    if (el === null) return
    el.style.height = '0px'
    el.style.height = `${el.scrollHeight}px`
  }, [])
  useLayoutEffect(() => { autoGrow() }, [draft.text, isMobile, autoGrow])

  const toggleSplit = (): void => {
    if (isSplit) {
      onCloseSplit?.()
      return
    }
    if (store.splitTarget !== null) {
      store.closeSplit()
      return
    }
    store.openTarget({ kind: 'agent', profileId }, { split: true })
  }

  const label = profile?.name || profileId
  const envError = standbyEnvError(draft)
  const profilesLoadError = store.loadErrors['assets:profiles']

  return (
    <div className="helm-pane agent-standby-pane" data-agent={profileId}>
      <header className="pane-topbar conversation-topbar">
        <div className="pane-title-group">
          <span className="pane-title">{label}</span>
          <span className="pane-cwd-subtitle">
            <span className="env-subtitle-full">开始新话题</span>
          </span>
        </div>
        <div className="pane-actions">
          {isSplit && onCloseSplit !== undefined ? (
            <CloseSplitButton onCloseSplit={onCloseSplit} />
          ) : (
            <SplitToggleButton isSplitActive={store.splitTarget !== null} onToggleSplit={toggleSplit} />
          )}
        </div>
      </header>

      <div className="agent-standby-body">
        {profilesLoadError !== undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="alert-triangle" size={20} />
            <span>角色信息加载失败：{profilesLoadError}</span>
            <button type="button" className="btn btn-sm" onClick={() => void store.refreshAssets()}>
              重试
            </button>
          </div>
        ) : !store.assetsLoaded ? (
          <div className="timeline-empty-state" role="status">
            <HelmIcon name="loader" size={20} className="spin-slow" />
            <span>正在加载角色信息…</span>
          </div>
        ) : profile === undefined ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="circle-slash" size={20} />
            <span>角色 {profileId} 不存在或已删除</span>
            <button type="button" className="btn btn-sm" onClick={() => store.openTarget({ kind: 'profiles' })}>
              前往角色中心
            </button>
          </div>
        ) : !humanSelectable ? (
          <div className="timeline-empty-state" role="alert">
            <HelmIcon name="lock" size={20} />
            <span>该角色不支持手动新建对话（常驻角色由其托管插件管理）</span>
          </div>
        ) : (
          <>
            <div className="agent-standby-intro">
              <span className="agent-standby-intro-name">{label}</span>
              <span className="agent-standby-intro-hint">发送第一条消息开始新话题；会话将在首次发送时创建</span>
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

      {store.assetsLoaded && profile !== undefined && humanSelectable ? (
        <StandbyComposer
          draftKey={draftKey}
          draft={draft}
          profile={profile}
          envError={envError}
          anchored={draft.conversationId !== undefined}
          isSplit={isSplit}
          textareaRef={textareaRef}
          fileInputRef={fileInputRef}
          onSend={submitDraft}
          onAddFiles={addFiles}
          onResetEnvToDefault={resetEnvToDefault}
        />
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 待命输入区（真草稿：正文 + 附件暂存 + 模型/思考档位 + 起始环境）
// ---------------------------------------------------------------------------

interface StandbyComposerProps {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  envError: string | null
  /** create 已锁定真实会话：模型/思考/环境随会话固化，不再接受修改。 */
  anchored: boolean
  isSplit?: boolean
  textareaRef: { current: HTMLTextAreaElement | null }
  fileInputRef: { current: HTMLInputElement | null }
  onSend: () => void
  onAddFiles: (files: ReadonlyArray<File>) => void
  onResetEnvToDefault: () => void
}

function StandbyComposer({ draftKey, draft, profile, envError, anchored, isSplit, textareaRef, fileInputRef, onSend, onAddFiles, onResetEnvToDefault }: StandbyComposerProps) {
  const store = useHelmStore()
  const dragDepthRef = useRef(0)
  const [dragging, setDragging] = useState(false)
  const isMobile = useIsMobile(680)
  const busy = draft.sending
  const sendDisabled = busy || draft.text.trim() === '' || envError !== null
  // 锚定后锁定一切影响创建的配置：重试跳过 create，新设置不会生效，不可星现可改但不生效。
  const configLocked = busy || anchored

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
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
              已创建会话 #{draft.conversationId}：模型与起始环境已随会话锁定，可修改正文与附件后重试
            </span>
            <Tooltip content="在当前面板查看已创建的会话" side="top">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => {
                  if (draft.conversationId === undefined) return
                  store.openTarget(
                    { kind: 'conversation', conversationId: draft.conversationId },
                    isSplit ? { split: true } : undefined,
                  )
                }}
              >
                查看会话
              </button>
            </Tooltip>
          </div>
        ) : null}
        {draft.error !== null ? (
          <div className="agent-standby-error callout callout--error" role="alert">
            <span className="agent-standby-error-text">{draft.error}</span>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={onSend}>
              重试
            </button>
          </div>
        ) : null}
        <div
          className="composer-box"
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
                  <span className="badge badge-neutral agent-standby-attachment-state">待发送</span>
                  <Tooltip content={`移除附件 ${att.name}`} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title="移除附件"
                      aria-label={`移除附件 ${att.name}`}
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
                  <span className="badge badge-ok agent-standby-attachment-state">已上传</span>
                  <Tooltip content={`移除附件 ${att.name}`} side="top">
                    <button
                      type="button"
                      className="btn btn-ghost btn-icon-xs"
                      title="移除附件"
                      aria-label={`移除附件 ${att.name}`}
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
            aria-label={`向 ${profile.name || profile.id} 输入首条消息`}
            ref={textareaRef}
            className="composer-textarea selectable"
            value={draft.text}
            rows={1}
            readOnly={busy}
            placeholder={isMobile ? '输入消息开始新话题…' : '输入消息开始新话题；Enter 发送 · Shift+Enter 换行 · 可拖入或粘贴附件'}
            onChange={(e) => updateStandbyDraft(draftKey, { text: e.target.value })}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            spellCheck={false}
          />
          <div className="composer-toolbar">
            <div className="composer-toolbar-left">
              <Tooltip content="选择附件（发送时才上传）" side="top">
                <button
                  type="button"
                  className="btn btn-ghost btn-sm composer-icon-button"
                  title="选择附件（发送时才上传）"
                  aria-label="选择附件（发送时才上传）"
                  disabled={busy}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HelmIcon name="plus" size={19} />
                </button>
              </Tooltip>
              <StandbyModelPicker draftKey={draftKey} draft={draft} profile={profile} disabled={configLocked} />
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
                title={envError !== null ? envError : '发送 (Enter)；会话将在首次发送时创建'}
                aria-label={busy ? '发送中' : '发送'}
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
// 模型 / 思考档位选择（模型随 create 提交；思考档位创建后 patch）
// ---------------------------------------------------------------------------

function StandbyModelPicker({ draftKey, draft, profile, disabled }: {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  disabled: boolean
}) {
  const store = useHelmStore()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const lockedNote = '已随会话锁定（或发送中），重试复用当前配置'

  const effectiveModel = draft.model !== undefined && draft.model !== '' ? draft.model : profile.model
  const rawShortName = effectiveModel !== undefined && effectiveModel !== '' ? effectiveModel.split('/').pop() ?? effectiveModel : ''
  const shortName = rawShortName.trim() !== '' ? rawShortName : '默认模型'
  const currentModel = effectiveModel !== undefined ? store.models.find((model) => model.id === effectiveModel) : undefined
  const currentLevels = currentModel?.thinkingLevels ?? ['off']
  const supportsThinking = currentLevels.some((level) => level !== 'off')

  const pickModel = (model: string): void => {
    setOpen(false)
    // 换模型后旧思考档位不再可信，回到跟随默认。
    updateStandbyDraft(draftKey, { model: model === '' ? undefined : model, thinkingLevel: undefined })
  }
  const pickThinking = (level: string): void => {
    updateStandbyDraft(draftKey, { thinkingLevel: level === '' ? undefined : level })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="btn btn-ghost btn-sm composer-model-button"
          disabled={disabled}
          aria-expanded={open}
          aria-label={`模型与思考档位：${shortName}`}
          title={disabled ? lockedNote : effectiveModel !== undefined && effectiveModel !== '' ? `当前模型：${effectiveModel}（未选择时跟随角色/全局默认）` : '跟随角色/全局默认模型'}
        >
          <span className="composer-model-label">{shortName}</span>
          {draft.thinkingLevel !== undefined ? <span className="composer-model-level">· {draft.thinkingLevel}</span> : null}
          <HelmIcon name="chevron-down" size={12} />
        </button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent side="top" align="start" sideOffset={8} className="composer-popover composer-model-popover">
          <button
            type="button"
            className="popover-item"
            disabled={disabled}
            title="创建会话时不指定模型，由服务器按角色/全局默认解析"
            onClick={() => pickModel('')}
          >
            跟随角色默认{profile.model !== undefined && profile.model !== '' ? `（${profile.model}）` : ''}
          </button>
          <div className="composer-model-search-bar" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div className="search-box" style={{ flex: 1, minWidth: 0 }}>
              <HelmIcon name="search" size={13} />
              <input
                aria-label="搜索模型"
                placeholder="搜索模型…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
          </div>
          {store.models
            .filter((model) => model.available && model.disabled !== true && model.id.toLowerCase().includes(query.toLowerCase()))
            .map((model) => (
              <button
                key={model.id}
                title={model.id}
                type="button"
                disabled={disabled}
                className={`popover-item${model.id === draft.model ? ' popover-item-active' : ''}`}
                onClick={() => pickModel(model.id)}
              >
                <span className="mono">{model.modelId}</span>
                <span className="popover-item-meta">{model.provider}</span>
              </button>
            ))}
          {store.models.every((model) => !model.available || model.disabled === true) && (
            <div className="popover-item" style={{ cursor: 'default', color: 'var(--fg-subtle)' }}>暂无可用模型；请先在「模型与凭据」配置供应商密钥</div>
          )}
          {supportsThinking ? (
            <>
              <div className="popover-header">
                思考档位
                <span style={{ color: 'var(--fg-subtle)' }}>{shortName}</span>
              </div>
              <ThinkingLevelControl
                value={draft.thinkingLevel ?? ''}
                levels={currentLevels}
                disabled={disabled}
                onPick={pickThinking}
                defaultTitle="创建会话后跟随默认档位（不显式覆盖）"
              />
            </>
          ) : null}
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  )
}

// ---------------------------------------------------------------------------
// 起始环境条（本地草稿，不 PATCH；发送时随 create 提交）
// ---------------------------------------------------------------------------

function StandbyEnvBar({ draftKey, draft, profile, disabled, onResetToDefault }: {
  draftKey: string
  draft: StandbyDraftState
  profile: Profile
  disabled: boolean
  onResetToDefault: () => void
}) {
  const store = useHelmStore()

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
    const list: SelectOption<string>[] = store.nodes.map((n) => ({
      value: n.id,
      label: nodeOptionLabel(n),
      icon: n.id === 'local' ? 'monitor' : 'network',
      meta: n.id !== 'local' ? (n.online ? '在线' : '离线') : undefined,
    }))
    if (!store.nodes.some((n) => n.id === nodeId)) {
      list.push({ value: nodeId, label: `${nodeId}（未知）`, icon: 'alert-circle' })
    }
    return list
  }, [store.nodes, draft.envNodeId])

  if (!draft.envCustomized) {
    return (
      <div className="composer-env-bar agent-standby-env-bar">
        <HelmIcon name="monitor" size={12} />
        <span className="agent-standby-env-hint">
          执行环境跟随角色默认
          {profile.nodeId !== undefined && profile.nodeId !== '' ? ` · ${profile.nodeId}` : ''}
          {profile.cwd ? ` · ${profile.cwd}` : ''}
        </span>
        <button type="button" className="btn btn-sm" disabled={disabled} onClick={startCustomize}>
          自定义
        </button>
      </div>
    )
  }

  const draftNode = store.nodes.find((n) => n.id === (draft.envNodeId || 'local'))
  return (
    <div className="composer-env-bar agent-standby-env-bar" data-dirty="true">
      <span className="composer-env-item">
        <Select
          className="composer-env-select"
          aria-label="新会话执行节点"
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
          aria-label="新会话工作目录"
          value={draft.envCwd ?? ''}
          disabled={disabled}
          placeholder="目标节点上的绝对路径，例如 /home/user/work"
          onChange={(e) => updateStandbyDraft(draftKey, { envCwd: e.target.value })}
        />
      </span>
      <button type="button" className="btn btn-sm" disabled={disabled} onClick={onResetToDefault} title={disabled ? '发送中或已随会话锁定' : '清除继承/自定义环境，跟随角色默认'}>
        恢复默认
      </button>
      <span className="composer-env-hint">首次发送时生效</span>
      {draftNode !== undefined && !draftNode.online && draft.envNodeId !== 'local' ? (
        <span className="composer-env-warn">节点离线，发送后仍需节点上线才能执行</span>
      ) : null}
    </div>
  )
}
