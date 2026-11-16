/**
 * Composer / Standby 键盘流纯逻辑与面板快捷键事件桥接（单键肌肉记忆，零多键别名）。
 *
 * 严格遵循「一功能一快捷键」原则：
 * - Ctrl+L：经宿主 HelmStoreProvider 全局派发 helm:shortcut (toggle-model-picker)，
 *   匹配 data-helm-panel 后切换对应面板 ModelPicker；
 * - Shift+Tab：立即 preventDefault() 并循环切换思考档位（不设 Ctrl+T 别名）；
 * - ↑：草稿为空且位于首行时，优先撤回当前会话最新一条人类排队输入，队列为空时才回退历史编辑（不设 Alt+Up 别名）；
 * - Enter / Mod+Enter / Shift+Enter：空闲发送 / 忙时 steer / 忙时 followUp / 换行（不设 Alt+Enter 别名）；
 * - Esc：关闭输入区浮层（stopPropagation 防外层双 Esc 误中断）→ 取消历史编辑态 → 交由外层双 Esc 中断。
 *
 * 本模块仅导出纯常量、纯函数与宿主事件 hook（无组件），保持 .tsx Fast Refresh 规范。
 */
import { useEffect, useRef } from 'react'
import type { QueuedConversationInput } from '@helm/protocol/browser'

export type HelmPanel = 'primary' | 'split'

export const HELM_SHORTCUT_EVENT = 'helm:shortcut' as const

export type HelmShortcutAction = 'toggle-model-picker' | 'toggle-process-groups'

export interface HelmShortcutEventDetail {
  action: HelmShortcutAction | string
  panel: HelmPanel
}

/** 单功能唯一快捷键显示标签（供桌面端 .kbd-hint 与 tooltip 使用；严禁多键别名）。 */
export const COMPOSER_SHORTCUTS = {
  toggleModelPicker: 'Ctrl+L',
  cycleThinkingLevel: 'Shift+Tab',
  recallQueuedOrHistory: '↑',
  sendOrSteer: 'Enter',
  followUpWhenBusy: '⌘/Ctrl+Enter',
  newline: 'Shift+Enter',
  dismissOrCancelEdit: 'Esc',
} as const

export interface KeyModifiersShape {
  key: string
  shiftKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
}

/** 严格匹配 Shift+Tab（无 Ctrl/Meta/Alt），确保不与其他组合键混淆。 */
export function isShiftTabEvent(e: KeyModifiersShape): boolean {
  return e.key === 'Tab' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** 严格匹配单键 ↑（无 Shift/Ctrl/Meta/Alt），禁止 Alt+Up 等多键别名。 */
export function isPlainArrowUpEvent(e: KeyModifiersShape): boolean {
  return e.key === 'ArrowUp' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

/** 匹配可触发提交的 Enter / Mod+Enter（排除 Shift+Enter 换行与 Alt+Enter 非法别名）。 */
export function isComposerSubmitEnterEvent(e: Pick<KeyModifiersShape, 'key' | 'shiftKey' | 'altKey'>): boolean {
  return e.key === 'Enter' && !e.shiftKey && !e.altKey
}

/** 判断光标是否位于文本首行（无前置换行符）。 */
export function isCaretAtFirstLine(value: string, selectionStart: number | null): boolean {
  const pos = Math.max(0, Math.min(value.length, selectionStart ?? 0))
  return !value.slice(0, pos).includes('\n')
}

/** 仅当草稿为空且光标位于首行时允许 ↑ 触发队列撤回 / 历史编辑回填。 */
export function canRecallOnArrowUp(value: string, selectionStart: number | null): boolean {
  return value === '' && isCaretAtFirstLine(value, selectionStart)
}

/**
 * 从当前会话 live.queuedInputs 中筛选最新一条人类（origin === 'human'）排队消息。
 * - 非人类来源（agent / trigger）或缺少合法 submissionId 的条目一律跳过；
 * - 按 createdAt 最大值选取最新一条，createdAt 相同时取队列尾部（最后出现）项。
 */
export function latestHumanQueuedInput(
  queuedInputs: ReadonlyArray<QueuedConversationInput> | undefined,
): QueuedConversationInput | undefined {
  if (!Array.isArray(queuedInputs) || queuedInputs.length === 0) return undefined
  let latest: QueuedConversationInput | undefined
  for (const item of queuedInputs) {
    if (
      item === null ||
      item === undefined ||
      item.origin !== 'human' ||
      typeof item.submissionId !== 'string' ||
      item.submissionId === '' ||
      typeof item.text !== 'string'
    ) {
      continue
    }
    if (latest === undefined) {
      latest = item
      continue
    }
    const itemTs = typeof item.createdAt === 'number' && Number.isFinite(item.createdAt) ? item.createdAt : 0
    const latestTs = typeof latest.createdAt === 'number' && Number.isFinite(latest.createdAt) ? latest.createdAt : 0
    if (itemTs >= latestTs) {
      latest = item
    }
  }
  return latest
}

/** 按模型能力列表解析实际生效思考档位（缺省回退 off 或首项支持档位）。 */
export function resolveEffectiveThinkingLevel(levels: ReadonlyArray<string>, activeLevel: string): string {
  const fallback = levels.includes('off') ? 'off' : (levels[0] ?? '')
  return levels.includes(activeLevel) ? activeLevel : fallback
}

/**
 * Shift+Tab 循环切换下一思考档位：
 * - 模型仅支持单一档位或全为 off 时返回 null（不触发无意义的切换请求）；
 * - 按列表顺序循环步进，到达末尾后回绕至首项。
 */
export function nextThinkingLevel(levels: ReadonlyArray<string>, currentLevel: string): string | null {
  if (levels.length <= 1) return null
  if (!levels.some((level) => level !== 'off')) return null
  const idx = levels.indexOf(currentLevel)
  if (idx < 0) return levels[0] ?? null
  return levels[(idx + 1) % levels.length] ?? null
}

/** ModelPicker 打开或过滤变更时，高亮索引优先落到当前生效模型；未命中则落到首项。 */
export function initialModelActiveIndex(
  models: ReadonlyArray<{ id: string }>,
  currentModelId: string | undefined,
): number {
  if (models.length === 0) return -1
  if (currentModelId !== undefined && currentModelId !== '') {
    const idx = models.findIndex((model) => model.id === currentModelId)
    if (idx >= 0) return idx
  }
  return 0
}

/** ModelPicker 列表上下箭头循环步进高亮索引。 */
export function stepActiveIndex(current: number, length: number, delta: 1 | -1): number {
  if (length <= 0) return -1
  if (current < 0 || current >= length) return delta > 0 ? 0 : length - 1
  return (current + delta + length) % length
}

/** 从 DOM 祖先 `[data-helm-panel]` 读取面板归属，缺省回退 `fallback`（默认 `'primary'`）。 */
export function resolveElementPanel(
  el: Element | null | undefined,
  fallback: HelmPanel = 'primary',
): HelmPanel {
  const attr = el?.closest?.('[data-helm-panel]')?.getAttribute('data-helm-panel')
  if (attr === 'primary' || attr === 'split') return attr
  return fallback
}

/** 判定当前组件是否应响应 `helm:shortcut` 目标面板事件（子会话弹窗抽屉不误响应主屏快捷键）。 */
export function isShortcutPanelMatch(
  el: Element | null | undefined,
  targetPanel: unknown,
  fallback: HelmPanel = 'primary',
): boolean {
  if (targetPanel !== 'primary' && targetPanel !== 'split') return false
  if (el?.closest?.('.conversation-drawer') && !el?.closest?.('[data-helm-panel]')) {
    return false
  }
  return resolveElementPanel(el, fallback) === targetPanel
}

/**
 * 监听 window `helm:shortcut` 自定义事件，仅当 `detail.action` 与当前 DOM 所在
 * `[data-helm-panel]` 面板匹配时触发回调（保证分屏下互不误触，且无重复拦截）。
 */
export function usePanelShortcut(
  rootRef: { current: Element | null },
  action: HelmShortcutAction | string,
  handler: () => void,
  fallback: HelmPanel = 'primary',
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (typeof window === 'undefined') return
    const onShortcut = (event: Event): void => {
      const detail = (event as CustomEvent<Partial<HelmShortcutEventDetail> | undefined>).detail
      if (detail === undefined || detail === null || detail.action !== action) return
      if (!isShortcutPanelMatch(rootRef.current, detail.panel, fallback)) return
      handlerRef.current()
    }
    window.addEventListener(HELM_SHORTCUT_EVENT, onShortcut)
    return () => window.removeEventListener(HELM_SHORTCUT_EVENT, onShortcut)
  }, [rootRef, action, fallback])
}
