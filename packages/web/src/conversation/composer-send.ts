/**
 * Composer 发送管线 hook（自 Composer.tsx 拆出，业务逻辑原样迁入）：
 * - 草稿三态（文本 / 编辑锚点 / 附件）与活草稿版本（liveDraftRef）唯一所有者；
 * - 发送管线：空态与在途门控、环境未保存阻塞、插件斜杠命令精确命中即执行、
 *   会话管理命令（/new /clear /compact）非编辑态立即执行、乐观清空 + 失败按
 *   冻结草稿版本回滚（用户已改草稿则不回灌旧编辑目标）；
 * - 附件上传：逐文件上传 + 失败显式通知，await 后以活草稿同步（旧渲染快照不回灌）；
 * - 显式文本提交（sendExplicit）：不消费草稿 / 编辑锚点 / 附件，失败如实 reject；
 * - 空会话起始环境阻塞（SessionEnvBar 回传）的门控哨兵与复位。
 * 本模块只导出 hook 与纯类型（无组件），保持 .ts Fast Refresh 约定。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ConversationAttachmentRef, ConversationSummary, QueuedConversationInput, WhenBusy } from '@helm/protocol/browser'
import { conversationsApi } from '../lib/api.js'
import {
  executePluginSlashAction,
  insertAtCaret,
  matchExactPluginSlash,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { useHelmStore } from '../lib/store-context.js'
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

/** 请求回填文本（时间线「编辑并重发」）；每次递增 tick 保证同文本也能再次触发。 */
export interface ComposerPrefill {
  text: string
  entryId?: number
  attachments?: ConversationAttachmentRef[]
  tick: number
  /** true 时仅当草稿完全空闲（无文本/附件/编辑锚点/在途操作）才回填；否则警告并拒绝。 */
  onlyIfEmpty?: boolean
}

export interface ComposerSendInput {
  conversation: ConversationSummary
  /** 编辑并重发回填请求（null 表示无）。 */
  prefill: ComposerPrefill | null
  /** 真实发送请求开始/结束时通知父层（在途反馈；斜杠命令不触发）。 */
  onSendingChange?: (sending: boolean) => void
  /** /new 新话题入口（进入本智能体待命页）；未提供时显式提示。 */
  onNewThread?: () => void
  /** textarea 引用（回填/插入后聚焦；自动长高由组件负责）。 */
  textareaRef: { current: HTMLTextAreaElement | null }
  /** 当前会话作用域内可用的插件斜杠命令（首 token 精确命中即执行）。 */
  slashPluginCommands: ReadonlyArray<QualifiedCommand>
  /** 会话是否允许配置起始环境（false 时复位环境阻塞哨兵）。 */
  envConfigurable: boolean
  /** 会话是否正忙（发送 whenBusy 策略附着的唯一依据）。 */
  working: boolean
  /** 版本自动刷新挂起判定的本地草稿上报键（组件实例唯一，如 useId()）；缺省不上报。 */
  dirtyKey?: string
}

export interface ComposerSendApi {
  text: string
  attachments: PendingAttachment[]
  editingEntryId: number | null
  sending: boolean
  uploading: number
  /** 环境阻塞状态（发送按钮禁用与提示）。 */
  envBlocker: SessionEnvBlocker
  /** 发送或上传在途（环境条 sendBlocked 与按钮禁用共用）。 */
  sendInFlight: boolean
  /** 整体替换草稿文本（与用户键入同路径推进活草稿版本；锚点/附件不动）。 */
  setDraftState: (text: string) => void
  /** 光标处插入片段（focusWithCaret 恢复光标）。 */
  insertTextState: (fragment: string) => void
  /** 活草稿文本（供 controller 等渲染期读取）。 */
  readLiveDraft: () => string
  /** 退出历史编辑态并清空草稿。 */
  cancelEdit: () => void
  /** 逐文件上传附件（图片与普通文件同路径；失败显式通知）。 */
  uploadFiles: (files: ReadonlyArray<File>) => Promise<void>
  /** 移除一个待发送附件（同步推进活草稿版本）。 */
  removeAttachment: (artifactId: string) => void
  /** ↑ 历史编辑：整体替换文本 / 锚点 / 附件（含空附件清空旧草稿）。 */
  applyHistoryEdit: (target: EditRequestTarget) => void
  /** ↑ 排队撤回重编：撤回 queuedInputs 中的人类排队消息并回填到草稿（不触发历史回滚横幅）。 */
  withdrawQueuedInput: (queued: QueuedConversationInput) => Promise<void>
  /** 宿主真实发送流程（乐观清空 + 失败按活草稿版本回滚 + whenBusy 策略）。 */
  send: (busyMode?: WhenBusy, strict?: boolean) => Promise<void>
  /** 提交显式文本（不消费草稿 / 编辑锚点 / 附件；失败如实 reject）。 */
  sendExplicit: (raw: string, whenBusy?: WhenBusy) => Promise<void>
  /** 斜杠菜单条目执行插件命令（成功后才消费触发词；稳定身份）。 */
  runPluginCommand: (cmd: QualifiedCommand) => void
  /** SessionEnvBar 阻塞回传（稳定身份，供其 blocker effect 依赖）。 */
  handleEnvBlocker: (blocker: SessionEnvBlocker) => void
  /** 错误通知统一出口（中止回合等组件侧动作共用）。 */
  notifyError: (title: string, err: unknown) => void
}

export function useComposerSend(input: ComposerSendInput): ComposerSendApi {
  const { conversation, prefill, onSendingChange, onNewThread, textareaRef, slashPluginCommands, envConfigurable, working, dirtyKey } = input
  const store = useHelmStore()
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
  // 活草稿版本：text / 编辑目标 / 附件任一变化推进，用于发送失败后判断草稿是否已被用户修改
  const liveDraftRef = useRef<ComposerDraftVersion>(draftVersionOf('', null, []))
  // 只触达实例 ref，无状态闭包：空依赖维持恒定身份，作为下游 useCallback 的稳定依赖。
  const syncLiveDraft = useCallback((text: string, target: number | null, attachments: ReadonlyArray<PendingAttachment>): void => {
    liveDraftRef.current = draftVersionOf(text, target, attachments)
  }, [])

  const handleEnvBlocker = (blocker: SessionEnvBlocker): void => {
    envBlockedRef.current = blocker.blocked
    setEnvBlocker(blocker)
  }
  // SessionEnvBar 的 blocker effect 依赖此回调身份：普通函数会使其每 render 重跑（blocked 态下循环）。
  const handleEnvBlockerStable = useStableCallback(handleEnvBlocker)
  // 环境条卸载（开聊锁定 / 状态变化）时复位阻塞，避免残留阻止后续发送
  useEffect(() => {
    if (envConfigurable) return
    envBlockedRef.current = false
    setEnvBlocker(ENV_BLOCKER_CLEAR)
  }, [envConfigurable])

  // 回填（编辑并重发）：prefill 引用变化即触发，同文本重复回填也生效。
  // 每次选择编辑目标都整体替换附件（目标无附件则清空），绝不保留上一个目标的草稿残留。
  useEffect(() => {
    if (prefill === null) return
    // onlyIfEmpty：草稿非空/编辑中/在途时拒绝回填（经 ref 读取，不新增 effect 依赖）。
    if (prefill.onlyIfEmpty === true) {
      const live = liveDraftRef.current
      if (
        live.text.trim() !== '' ||
        live.attachments.length > 0 ||
        live.targetEntryId !== null ||
        sendingRef.current ||
        uploadingRef.current > 0
      ) {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: 'Handle the current draft before picking a starter',
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
  }, [prefill, syncLiveDraft])

  // 切换会话时退出历史编辑态（浮层复位由组件侧同名 effect 负责）
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
      store.pushNotice({
        type: 'notification',
        level: 'error',
        title,
        body: err instanceof Error ? err.message : String(err),
        conversationId: conversation.id,
      })
    },
    [store, conversation.id],
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
            // await 后渲染快照已过期：文本/锚点取活值，只替换附件集。
            syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
            return next
          })
        } catch (err) {
          notifyError(`Attachment upload failed: ${file.name}`, err)
        } finally {
          uploadingRef.current--
          setUploading(uploadingRef.current)
        }
      }
    },
    [conversation.id, notifyError],
  )

  // ⌘K 与斜杠菜单复用同一动作寻址；失败必须返回给提交者。
  const runPluginCommandFrom = useCallback(
    (cmd: QualifiedCommand): Promise<void> =>
      executePluginSlashAction(cmd, {
        invokePluginAction: store.invokePluginAction,
        pushNotice: store.pushNotice,
        locale: store.locale,
        conversationId: conversation.id,
      }),
    [store, conversation.id],
  )

  // 命令成功后才消费触发词；用户已经修改草稿时不得覆盖新内容。
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
  // 斜杠菜单条目跨 render 存续：入口经稳定包装取最新实现（替代渲染期写 latest ref）。
  const runPluginCommand = useStableCallback(runPluginCommandImpl)

  const runSlashCommand = (raw: string): boolean => {
    const cmd = raw.trim()
    if (cmd === '/new') {
      // /new 是新话题入口：进入本智能体待命页（首次发送才落库），不再重置原会话；
      // 未提供回调（非会话页宿主）时显式提示，不猜测目标也不伤原会话。
      if (onNewThread !== undefined) {
        onNewThread()
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: 'Start new topics from the New topic action in the conversation top bar',
          conversationId: conversation.id,
        })
      }
      return true
    }
    if (cmd === '/clear') {
      void conversationsApi
        .reset(conversation.id)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: 'Context reset', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('Failed to reset context', err))
      return true
    }
    const compactCmd = parseCompactSlashCommand(cmd)
    if (compactCmd !== null) {
      if (conversation.contextUsage?.compacting === true) {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: 'Context compaction in progress',
          conversationId: conversation.id,
        })
        return true
      }
      void conversationsApi
        .compact(conversation.id, compactCmd.instructions)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: 'Compaction submitted', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('Failed to compact context', err))
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

  /** ↑ 历史编辑整体替换：文本 / 锚点 / 附件（目标无附件即清空旧草稿残留）。 */
  const applyHistoryEdit = useCallback((target: EditRequestTarget): void => {
    setText(target.text)
    setEditingEntryId(target.entryId ?? null)
    // 进入历史编辑同样整体替换附件（含空附件清空旧草稿）
    setAttachments(attachmentsOfEditTarget(target))
    syncLiveDraft(target.text, target.entryId ?? null, attachmentsOfEditTarget(target))
    requestAnimationFrame(() => textareaRef.current?.focus())
  }, [syncLiveDraft, textareaRef])

  /** ↑ 排队撤回重编：优先从 pi.inbox 撤回最新人类排队项并回填文本与附件。 */
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
          store.pushNotice({
            type: 'notification',
            level: 'info',
            title: 'Queued message withdrawn',
            body: `Current draft not empty; input not overwritten: ${queued.text}`,
            conversationId: conversation.id,
          })
          return
        }
        applyHistoryEdit(baseTarget)
      } else if ((res.status === 'already_placed' || res.status === 'settled') && res.entryId !== undefined) {
        if (draftModified) {
          store.pushNotice({
            type: 'notification',
            level: 'warning',
            title: 'Message entered execution',
            body: 'Current draft not empty; not entering history message editing',
            conversationId: conversation.id,
          })
          return
        }
        applyHistoryEdit({ ...baseTarget, entryId: res.entryId })
      } else {
        store.pushNotice({
          type: 'notification',
          level: 'warning',
          title: 'Cannot withdraw queued message',
          body: `Submission entered execution (status=${res.status})`,
          conversationId: conversation.id,
        })
      }
    } catch (err) {
      if (mountedRef.current) {
        notifyError('Failed to withdraw queued message', err)
      }
    } finally {
      withdrawingRef.current = false
    }
  }, [conversation.id, applyHistoryEdit, notifyError, store])

  const send = useCallback(async (busyMode: WhenBusy = 'steer', strict = false): Promise<void> => {
    const draft = liveDraftRef.current.text
    const payload = draft.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) {
      if (strict) throw new Error('Current draft empty or a composer operation is already in flight')
      return
    }
    // 未保存环境或环境保存中不允许发送（同时覆盖 Enter 与发送按钮）
    if (envBlockedRef.current) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: 'Save or cancel the starting environment changes first',
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      if (strict) throw new Error('Save or cancel the starting environment changes first')
      return
    }
    // 插件斜杠命令：草稿首 token 精确命中满足作用域的插件命令时执行（仅非编辑态）。
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
    // 编辑态正文中出现 /new 等管理命令只是被编辑消息的文本，不立即执行；
    // 仅非编辑输入才作为会话管理命令立即执行。
    const slash = editing ? false : runSlashCommand(payload)
    if (slash) {
      setText('')
      syncLiveDraft('', editingEntryId, attachments)
      return
    }
    const targetEntryId = editingEntryId
    const sentAttachments = new Set(attachments.map((attachment) => attachment.artifactId))
    // 冻结发送瞬间草稿：失败时只有 Composer 仍处于乐观清空后的期望状态
    // （用户未新输入、未选其他目标、未改附件）才回滚，旧 target 不得误绑新输入。
    const frozenDraft = draftVersionOf(draft, targetEntryId, attachments)
    const expectedAfterClear = draftVersionOf('', null, attachments)
    sendingRef.current = true
    setSending(true)
    onSendingChange?.(true)
    setText('')
    // 乐观退出编辑态；失败时在 catch 中按冻结版本回滚
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
        // 已发送附件从活版本移除，避免残留误导 onlyIfEmpty 回填与回滚判定。
        syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
        return next
      })
    } catch (err) {
      // 仅当 Composer 仍处于乐观清空后的期望状态才恢复文本与编辑目标；
      // 用户已开始新输入 / 已选择其他编辑目标则保持现状，旧 target 不回灌。
      const restore = shouldRestoreEditOnFailure(liveDraftRef.current, expectedAfterClear)
      if (restore) {
        setText(draft)
        if (frozenDraft.targetEntryId !== null) setEditingEntryId(frozenDraft.targetEntryId)
        syncLiveDraft(draft, frozenDraft.targetEntryId, attachments)
      }
      notifyError(targetEntryId !== null ? 'Failed to update message' : 'Send failed', err)
      if (strict) throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [text, attachments, editingEntryId, working, runSlashCommand, syncLiveDraft, onSendingChange, notifyError, store, conversation.id, uploadingRef, envBlocker, runPluginCommandFrom, slashPluginCommands])

  // 显式文本提交：不消费草稿 / 编辑锚点 / 附件（插件命令结果等非用户键入内容）。
  // 与 send 共用 sendingRef 并发保护与 onSendingChange 在途反馈；失败如实 reject。
  const sendExplicit = useCallback(async (raw: string, whenBusy?: WhenBusy): Promise<void> => {
    const payload = raw.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0) {
      throw new Error('composer_send_invalid')
    }
    if (envBlockedRef.current) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: 'Save or cancel the starting environment changes first',
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
      notifyError('Send failed', err)
      throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [working, onSendingChange, notifyError, store, conversation.id, uploadingRef, envBlocker])

  const readLiveDraft = useCallback((): string => liveDraftRef.current.text, [])

  // 版本自动刷新挂起判定：本地草稿脏状态上报（外部桥接 store 聚合，见
  // composer-dirty.ts）。状态变化即时同步；卸载按实例键清除（依赖数组仅
  // dirtyKey，重渲染不重复清除上报）。
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
