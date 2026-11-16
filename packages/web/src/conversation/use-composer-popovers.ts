/**
 * 输入区触发浮层与自动长高共享 hooks（正式会话 Composer 与待命草稿 StandbyComposer 共用）：
 * - '/' 进 CommandPopover（命令与技能）；'@' '#' ':' 进 CompletionPopover（composerCompleter 插件源）；
 * - 统一处理输入、光标移动（方向键 / 点击）触发检测、token 替换、光标恢复、切换/清空/禁用复位与键盘拦截；
 * - 统一处理 ResizeObserver 自适应长高，避免两套输入区各自维护分叉逻辑。
 * 本模块只导出 hooks / 纯函数 / TS 类型（无组件），保持 .ts Fast Refresh 约定。
 */
import { useCallback, useEffect, useState } from 'react'
import type { ComposerCompleterSpec, ConversationSummary } from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'
import { useStableCallback } from '../lib/use-stable-callback.js'
import { replaceSlashToken } from '../lib/commands-model.js'
import {
  detectCompletionToken,
  replaceTriggerToken,
  type CompletionToken,
  type MergedCompletionItem,
} from './composer-completion-model.js'
import { focusWithCaret } from './composer-controller.js'
import { useComposerCompletionSources, type CompletionSourceSnapshot } from './use-composer-completion.js'

/** 按内容与容器宽度自动调节 textarea 高度。 */
export function autoGrowTextarea(el: HTMLTextAreaElement | null): void {
  if (el === null) return
  el.style.height = '0px'
  el.style.height = `${el.scrollHeight}px`
}

/** 当元素宽度变化时触发回调（ResizeObserver），避免拆分视图或窗口变化时 textarea 高度滞后。 */
export function useElementWidthResize(
  ref: { current: HTMLElement | null },
  onResize: () => void,
): void {
  const onResizeStable = useStableCallback(onResize)
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let width = el.clientWidth
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return
      width = el.clientWidth
      onResizeStable()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [ref, onResizeStable])
}

export interface UseComposerPopoversInput {
  textareaRef: { current: HTMLTextAreaElement | null }
  draftText: string
  readLiveDraft: () => string
  setDraftState: (next: string) => void
  completers: ReadonlyArray<QualifiedUiSpec<ComposerCompleterSpec>>
  /** 真实会话（或已锚定待命会话）；纯草稿态为 undefined。 */
  conversation: ConversationSummary | undefined
  /** 待命草稿角色 ID（无会话时供支持 profileId 的 action 补全源使用）。 */
  profileId?: string
  /** 会话或待命坐标切换键：变化时立即关闭全部浮层并取消在途查询。 */
  resetKey: string | number
  /** 只读/发送中等禁止弹出浮层的状态。 */
  disabled?: boolean
}

export interface UseComposerPopoversResult {
  slashOpen: boolean
  popoverQuery: string
  completionOpen: boolean
  completionTrigger: '@' | '#' | ':'
  completionSnapshot: CompletionSourceSnapshot
  detectPopover: (value: string, caret: number) => void
  handleTextareaKeyUp: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  handleTextareaClick: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  shouldDeferKeyToPopover: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  applySlashPick: (apply: string) => void
  closeSlashPopover: () => void
  applyCompletionPick: (entry: MergedCompletionItem) => void
  closeCompletionPopover: () => void
  resetPopovers: () => void
}

export function useComposerPopovers(input: UseComposerPopoversInput): UseComposerPopoversResult {
  const {
    textareaRef,
    draftText,
    readLiveDraft,
    setDraftState,
    completers,
    conversation,
    profileId,
    resetKey,
    disabled = false,
  } = input
  const [popover, setPopover] = useState<'slash' | null>(null)
  const [popoverQuery, setPopoverQuery] = useState('')
  const [completionToken, setCompletionToken] = useState<CompletionToken | null>(null)

  const resetPopovers = useCallback((): void => {
    setPopover(null)
    setPopoverQuery('')
    setCompletionToken(null)
  }, [])

  useEffect(() => {
    resetPopovers()
  }, [resetKey, resetPopovers])

  useEffect(() => {
    if (disabled || draftText === '') resetPopovers()
  }, [disabled, draftText, resetPopovers])

  // 触发检测：'/' 进斜杠命令浮层；'@' '#' ':' 进统一插件补全浮层。
  const detectPopover = useCallback((value: string, caret: number): void => {
    if (disabled) return
    const token = detectCompletionToken(value.slice(0, caret))
    if (token === null) {
      resetPopovers()
      return
    }
    if (token.trigger === '/') {
      setPopover('slash')
      setPopoverQuery(token.query)
      setCompletionToken(null)
      return
    }
    setPopover(null)
    setPopoverQuery('')
    setCompletionToken(token)
  }, [disabled, resetPopovers])

  const applySlash = (apply: string): void => {
    const el = textareaRef.current
    if (el === null) {
      setPopover(null)
      setPopoverQuery('')
      return
    }
    const currentText = readLiveDraft()
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = replaceSlashToken(currentText, caret, apply)
    setDraftState(next)
    setPopover(null)
    setPopoverQuery('')
    focusWithCaret(el, nextCaret)
  }

  const applyCompletion = (insertText: string): void => {
    const el = textareaRef.current
    if (el === null) {
      setCompletionToken(null)
      return
    }
    const currentText = readLiveDraft()
    const caret = el.selectionStart ?? currentText.length
    const { next, nextCaret } = replaceTriggerToken(currentText, caret, insertText)
    setDraftState(next)
    setCompletionToken(null)
    focusWithCaret(el, nextCaret)
  }

  // 浮层 onPick/onClose 进其全局键盘 effect 依赖：稳定出口，调用时取最新实现。
  const applySlashPick = useStableCallback(applySlash)
  const closeSlashPopover = useStableCallback((): void => {
    setPopover(null)
    setPopoverQuery('')
  })
  const applyCompletionPick = useStableCallback((entry: MergedCompletionItem): void => {
    applyCompletion(entry.item.insertText)
  })
  const closeCompletionPopover = useStableCallback((): void => {
    setCompletionToken(null)
  })

  const completionSnapshot = useComposerCompletionSources({
    token: completionToken,
    completers,
    conversation,
    profileId,
  })
  const slashOpen = popover !== null
  // 浮层真正打开 = 触发符激活且当前作用域内有注册源；无源时不弹窗也不拦截输入。
  const completionOpen = completionSnapshot.hasSources
  const completionTrigger = completionToken !== null && completionToken.trigger !== '/' ? completionToken.trigger : '@'

  const handleTextareaKeyUp = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') {
      detectPopover(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)
    }
  }, [detectPopover])

  const handleTextareaClick = useCallback((e: React.MouseEvent<HTMLTextAreaElement>): void => {
    detectPopover(e.currentTarget.value, e.currentTarget.selectionStart ?? e.currentTarget.value.length)
  }, [detectPopover])

  const shouldDeferKeyToPopover = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean =>
    (slashOpen || completionOpen) &&
    !e.nativeEvent.isComposing &&
    (e.key === 'Enter' || e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'Escape'),
  [slashOpen, completionOpen])

  return {
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
    resetPopovers,
  }
}
