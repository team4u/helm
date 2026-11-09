/**
 * ComposerController 实时绑定 hook（协议 ComposerScopeProps.composer 的宿主构造方）。
 *
 * 设计约束：
 * - 单一事实来源是 Composer 的 React state（text/attachments/sending）与 textareaRef；
 *   controller 每次渲染重建（读取全部经 ref 转发最新值，不做过期闭包）；
 * - setDraft / insertText 与用户键入同路径：推进 liveDraftRef、必要时聚焦与恢复光标，
 *   编辑目标（历史编辑锚点）与附件语义原样保留；
 * - submit() 复用宿主真实 send 流程（乐观清空 + 失败按活草稿版本回滚 + whenBusy 策略）；
 *   submit(text) 提交显式文本，不消费草稿 / 编辑锚点 / 附件；
 * - 本模块只导出 hook 与纯类型（无组件），保持 .tsx Fast Refresh 约定。
 */
import { useCallback, useMemo, useRef } from 'react'
import type { ComposerController, WhenBusy } from '@helm/protocol'

export interface ComposerControllerBindings {
  /** 当前草稿文本（React state，渲染期读取）。 */
  text: string
  /** 草稿控制函数可在同一事件中同步改写，立即读取时使用宿主最新镜像。 */
  readDraft?: () => string
  /** 当前待发送附件（React state）。 */
  attachments: ReadonlyArray<{ artifactId: string; name: string; size: number; mimeType: string }>
  /** 是否有提交在途（React state）。 */
  sending: boolean
  /** textarea 元素引用。 */
  textareaRef: { current: HTMLTextAreaElement | null }
  /** 整体替换草稿（与用户键入同路径：推进 liveDraftRef；不触碰编辑锚点与附件）。 */
  setDraftState: (text: string) => void
  /**
   * 光标处插入文本（与 applyPopover 同路径）：默认在当前光标位置插入并后移光标；
   * focus 为 false 时不抢焦点（如宿主自身在动画帧内移动光标的场景）。
   */
  insertTextState: (fragment: string) => void
  /** 宿主真实提交流程（复用发送校验 / whenBusy / 附件 / 失败恢复）。 */
  submitDraft: (whenBusy?: WhenBusy) => Promise<void>
  /** 提交显式文本到当前会话（不消费草稿 / 编辑锚点 / 附件；与 sending 并发保护一致）。 */
  submitExplicitText: (text: string, whenBusy?: WhenBusy) => Promise<void>
}

/** 聚焦输入框并把光标落到指定位置（下一动画帧，等 DOM 文本更新生效后再定位）。 */
export function focusWithCaret(el: HTMLTextAreaElement, caret: number): void {
  requestAnimationFrame(() => {
    el.focus()
    el.setSelectionRange(caret, caret)
  })
}

export function useComposerController(bindings: ComposerControllerBindings): ComposerController {
  // 提交在途守卫：与宿主 sendingRef 同步 set，防止 setState 异步生效间隙的重复提交。
  const explicitInFlightRef = useRef(false)
  const latest = useRef(bindings)
  latest.current = bindings

  const setDraft = useCallback((text: string) => {
    const b = latest.current
    b.setDraftState(text)
    const el = b.textareaRef.current
    if (el !== null) focusWithCaret(el, text.length)
  }, [])

  const insertText = useCallback((fragment: string) => {
    const b = latest.current
    b.insertTextState(fragment)
  }, [])

  const submit = useCallback((text?: string, options?: { whenBusy?: WhenBusy }) => {
    const b = latest.current
    const whenBusy = options?.whenBusy
    if (text === undefined) return b.submitDraft(whenBusy)
    if (explicitInFlightRef.current) {
      // 与 sending 并发保护一致：在途期间拒绝重复显式提交，不伪报成功。
      return Promise.reject(new Error('composer_busy'))
    }
    explicitInFlightRef.current = true
    return b.submitExplicitText(text, whenBusy).finally(() => {
      explicitInFlightRef.current = false
    })
  }, [])

  return useMemo<ComposerController>(() => {
    return {
      get draft() {
        return latest.current.readDraft?.() ?? latest.current.text
      },
      get attachments() {
        return latest.current.attachments.map((a) => ({
          id: a.artifactId,
          name: a.name,
          mimeType: a.mimeType,
          size: a.size,
        }))
      },
      get sending() {
        return latest.current.sending
      },
      setDraft,
      insertText,
      submit,
    }
    // controller 读取走 getter 转发 latest ref，不依赖 bindings 身份；
    // 三个方法引用稳定（useCallback 空依赖）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setDraft, insertText, submit])
}
