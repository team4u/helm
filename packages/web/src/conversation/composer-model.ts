import { useEffect, useState } from 'react'
import type { ConversationStatus } from '@helm/protocol'
import type { EditRequestTarget } from '../conversation/timeline-model.js'

// ---------------------------------------------------------------------------
// 历史消息编辑态（纯逻辑，单测直测）
// ---------------------------------------------------------------------------

/** 待发送附件草稿（上传后尚未随消息提交）。 */
export interface PendingAttachment {
  artifactId: string
  name: string
  size: number
  mimeType: string
}

/** 编辑目标携带的附件引用 -> 待发送草稿（每次选择编辑目标都整体替换，不保留旧草稿残留）。 */
export function attachmentsOfEditTarget(target: EditRequestTarget): PendingAttachment[] {
  return (target.attachments ?? []).map((a) => ({
    artifactId: a.id,
    name: a.name,
    size: a.size,
    mimeType: a.mimeType,
  }))
}

/** 选中的编辑目标是否构成原地编辑（历史锚点存在）；否则仅是草稿回填。 */
export function isHistoricalEdit(target: EditRequestTarget): boolean {
  return target.entryId !== undefined
}

/** 发送时冻结的草稿版本：任一维度变化即视为用户已修改，旧编辑目标不得回灌。 */
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

/** 会话内管理命令：非编辑输入时立即执行；编辑态正文中只是被编辑消息的文本。 */
export function isSessionManageCommand(payload: string): boolean {
  return payload === '/new' || payload === '/clear' || payload === '/compact'
}

/** 发送失败后是否恢复编辑态：仅当 Composer 仍处于乐观清空后的期望状态
 * （用户未输入新文本、未选择其他编辑目标、未改动附件）时，旧编辑目标才可回灌。 */
export function shouldRestoreEditOnFailure(
  live: ComposerDraftVersion,
  expectedAfterClear: ComposerDraftVersion,
): boolean {
  return sameDraftVersion(live, expectedAfterClear)
}

/** 发送反馈可见性：仅当发送请求在途且服务端尚未以真实 working/blocked 接管。
 *
 * SSE 状态到达后由真实状态接管，不叠第二条发送等待；不修改持久
 * conversation.status，不引入额外业务枚举。
 */
export function sendingPendingVisible(
  sendingInFlight: boolean,
  status: ConversationStatus,
): boolean {
  return sendingInFlight && status !== 'working' && status !== 'blocked'
}

/** 根据是否处于移动端或小屏幕模式生成 Composer 占位符提示文案 */
export function getComposerPlaceholder(working: boolean, isMobile: boolean): string {
  if (working) {
    // 移动端占位符保持极短，避免窄屏折行撑高输入区
    return isMobile ? '补充说明或排队指令…' : '补充说明或输入下一条指令（Enter 插话引导 · ⌘/Ctrl+Enter 排队发送）'
  }
  return isMobile ? '输入消息…' : '输入消息；/ 命令与技能，@ 引用产物，⌘V 粘贴附件'
}

/** 会话正忙时 Enter 的默认 whenBusy 策略（插话引导）。 */
export const BUSY_ENTER_DEFAULT: 'steer' = 'steer'

/**
 * 键盘事件 -> 正忙时 whenBusy 策略（纯函数，单测直测）：
 * Enter 默认插话引导（steer）；⌘/Ctrl+Enter 显式排队发送（followUp）。
 * 调用方需先行完成 Shift+Enter 换行与 IME composing 保护。
 */
export function busyEnterMode(modifier: boolean): 'steer' | 'followUp' {
  return modifier ? 'followUp' : BUSY_ENTER_DEFAULT
}

/** 视为「已开聊」的实质性对话回合 entry 种类（出现任一即锁定起始环境）。
 * SDK 真实 kind 用连字符（pi.tool-result，见 pi-durable README），兼容旧下划线拼写；
 * pi.compaction 属实质上下文：压缩不能变成环境解锁入口。 */
const CONVERSATIONAL_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'helm.input',
  'pi.user',
  'pi.assistant',
  'pi.tool_call',
  'pi.tool_result',
  'pi.tool-call',
  'pi.tool-result',
  'pi.compaction',
])

/**
 * 判断会话是否处于「尚未开聊」的空状态（或 `/reset` 后未再发消息）。
 * 仅此时允许在 Composer 上方配置起始执行节点与工作目录；开聊即锁定。
 */
export interface EnvSubtitleEntry {
  kind: string
  data?: unknown
  model?: unknown
}

/** 复用 timeline-model 的 handoff 提取规则：`data.handoff`（非空字符串）优先，回退 model 内 UserMessage 文本。 */
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
  // 从最后一条 pi.reset 之后开始检查（无 reset 则从头检查）。
  // reset 不删除历史、只切换上下文：普通 reset 后重新可配；
  // 但带 handoff 交接摘要的 reset 说明新上下文已继承旧会话环境叙事，继续锁定。
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
  /** cwd 尾部保留段数，缺省 2。 */
  segments?: number
  /** 紧凑模式（窄屏/手机）：只保留节点身份，本机直接隐藏。 */
  compact?: boolean
}

/** 路径按两种分隔符拆段：Windows 反斜杠与 POSIX 斜杠等价处理，根路径保留为一段。 */
function splitPathSegments(cwd: string): string[] {
  const parts = cwd.split(/[\\/]+/).filter((p) => p !== '')
  return parts.length > 0 ? parts : [cwd]
}

/**
 * 生成会话顶栏只读环境副标题：`profileId · tail`（本机）或 `profileId · @node:tail`（远端），
 * 附完整悬停提示。compact 模式仅展示 `@node`（本机空串，调用方不渲染）。
 */
export function formatEnvSubtitle(input: EnvSubtitleInput): { text: string; tooltip: string } {
  const nodeId = input.nodeId !== undefined && input.nodeId !== '' ? input.nodeId : 'local'
  if (input.compact === true) {
    return {
      text: nodeId === 'local' ? '' : `@${nodeId}`,
      tooltip: `智能体：${input.profileId} · 节点：${nodeId} · 工作目录：${input.cwd || '(未设置)'}`,
    }
  }
  const parts = splitPathSegments(input.cwd)
  const tail = parts.slice(-(input.segments ?? 2)).join('/')
  const text =
    nodeId === 'local'
      ? tail === '' ? input.profileId : `${input.profileId} · ${tail}`
      : tail === '' ? `${input.profileId} · @${nodeId}` : `${input.profileId} · @${nodeId}:${tail}`
  return {
    text,
    tooltip: `智能体：${input.profileId} · 节点：${nodeId} · 工作目录：${input.cwd || '(未设置)'}`,
  }
}

// ---------------------------------------------------------------------------
// 空会话起始环境草稿（纯逻辑，单测直测）
// ---------------------------------------------------------------------------

export interface EnvDraft {
  nodeId: string
  cwd: string
}

/**
 * 从当前会话坐标与既有草稿推导新草稿：
 * - 未改节点：保留用户已输入的 cwd 草稿；
 * - 跨节点切换：清空 cwd 草稿（协议无节点默认目录，绝不沿用旧节点路径），要求填写目标节点目录。
 */
export function envDraftOnNodeChange(current: EnvDraft, nextNodeId: string): EnvDraft {
  if (nextNodeId === current.nodeId) return current
  return { nodeId: nextNodeId, cwd: '' }
}

/** 保存前校验：返回 null 表示可提交，否则返回用户可读错误。 */
export function envDraftError(draft: EnvDraft): string | null {
  if (draft.cwd.trim() === '') return '请填写目标节点上的工作目录（绝对路径）'
  if (!draft.cwd.trim().startsWith('/') && !/^[A-Za-z]:[\\/]/.test(draft.cwd.trim())) {
    return '工作目录必须是绝对路径（POSIX / 或 Windows 盘符开头）'
  }
  return null
}

/** 草稿是否与当前会话坐标一致（一致则无需提交）；nodeId 缺省视为 local。 */
export function envDraftUnchanged(draft: EnvDraft, nodeId: string | undefined, cwd: string): boolean {
  return draft.nodeId === (nodeId || 'local') && draft.cwd === cwd
}

/** 监听视口宽度是否在移动端阈值内（默认 <= 680px） */
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
