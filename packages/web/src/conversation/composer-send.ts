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
import type { ConversationAttachmentRef, ConversationSummary, WhenBusy } from '@helm/protocol'
import { conversationsApi } from '../lib/api.js'
import {
  commandActionPluginId,
  insertAtCaret,
  matchExactPluginSlash,
  removeTokenBeforeCaret,
  type QualifiedCommand,
} from '../lib/commands-model.js'
import { useHelmStore } from '../lib/store-context.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { focusWithCaret } from './composer-controller.js'
import {
  attachmentsOfEditTarget,
  draftVersionOf,
  isHistoricalEdit,
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
  const { conversation, prefill, onSendingChange, onNewThread, textareaRef, slashPluginCommands, envConfigurable, working } = input
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
          title: '请先处理当前草稿，再选择引导词',
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
          if (file.size > 15 * 1024 * 1024) throw new Error('文件超过 15 MiB 上限')
          const meta = await conversationsApi.uploadArtifact(conversation.id, file)
          setAttachments((prev) => {
            const next = [...prev, { artifactId: meta.id, name: meta.name, size: meta.size, mimeType: meta.mimeType }]
            // await 后渲染快照已过期：文本/锚点取活值，只替换附件集。
            syncLiveDraft(liveDraftRef.current.text, liveDraftRef.current.targetEntryId, next)
            return next
          })
        } catch (err) {
          notifyError(`附件上传失败：${file.name}`, err)
        } finally {
          uploadingRef.current--
          setUploading(uploadingRef.current)
        }
      }
    },
    [conversation.id, notifyError],
  )

  // ⌘K 与斜杠菜单复用同一动作寻址；失败必须返回给提交者。
  const runPluginCommandFrom = useCallback(async (cmd: QualifiedCommand): Promise<void> => {
    const actionId = cmd.spec.actionId
    if (actionId === undefined) throw new Error('插件命令未绑定动作')
    await store
      .invokePluginAction(commandActionPluginId(cmd), actionId, cmd.spec.input, conversation.id)
      .then(() => {
        store.pushNotice({
          type: 'notification',
          level: 'info',
          title: '命令已执行',
          body: `${cmd.spec.slash !== undefined ? `/${cmd.spec.slash} · ` : ''}${cmd.spec.title}`,
          conversationId: conversation.id,
        })
      })
      .catch((err: unknown) => {
        notifyError(`命令执行失败：/${cmd.spec.slash ?? cmd.spec.id}`, err)
        throw err
      })
  }, [store, conversation.id, notifyError])

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
    }).catch(() => { /* 动作调用已发送明确失败通知，保留原草稿。 */ }).finally(() => { commandPendingRef.current = false })
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
          title: '请从会话顶栏「新话题」开始新话题',
          conversationId: conversation.id,
        })
      }
      return true
    }
    if (cmd === '/clear') {
      void conversationsApi
        .reset(conversation.id)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: '上下文已重置', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('重置上下文失败', err))
      return true
    }
    if (cmd === '/compact') {
      void conversationsApi
        .compact(conversation.id)
        .then(() => {
          store.pushNotice({ type: 'notification', level: 'info', title: '精简任务已提交', conversationId: conversation.id })
        })
        .catch((err: unknown) => notifyError('精简上下文失败', err))
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

  const send = useCallback(async (busyMode: WhenBusy = 'steer', strict = false): Promise<void> => {
    const draft = liveDraftRef.current.text
    const payload = draft.trim()
    if (payload === '' || sendingRef.current || uploadingRef.current > 0 || commandPendingRef.current) {
      if (strict) throw new Error('当前草稿为空或输入区已有在途操作')
      return
    }
    // 未保存环境或环境保存中不允许发送（同时覆盖 Enter 与发送按钮）
    if (envBlockedRef.current) {
      store.pushNotice({
        type: 'notification',
        level: 'warning',
        title: '请先保存或取消起始环境修改',
        body: envBlocker.reason ?? undefined,
        conversationId: conversation.id,
      })
      if (strict) throw new Error('请先保存或取消起始环境修改')
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
      notifyError(targetEntryId !== null ? '更新消息失败' : '发送失败', err)
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
        title: '请先保存或取消起始环境修改',
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
      notifyError('发送失败', err)
      throw err
    } finally {
      sendingRef.current = false
      setSending(false)
      onSendingChange?.(false)
    }
  }, [working, onSendingChange, notifyError, store, conversation.id, uploadingRef, envBlocker])

  const readLiveDraft = useCallback((): string => liveDraftRef.current.text, [])

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
    send,
    sendExplicit,
    runPluginCommand,
    handleEnvBlocker: handleEnvBlockerStable,
    notifyError,
  }
}
