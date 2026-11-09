/**
 * 插件命令（CommandSpec）纯逻辑：输入框 '/' 斜杠补全与 ⌘K 命令面板共用。
 *
 * 斜杠菜单三源合并（宿主内置管理命令、技能 /skill: 引用、插件 action 命令）、
 * 光标插入/触发词清理的纯文本计算，以及命令面板的会话作用域过滤与 hint 派生。
 * 纯函数无 React 依赖，供 Composer / CommandPaletteModal 与单测共同消费。
 */
import type { CommandSpec, ConversationSummary } from '@helm/protocol'
import { matchesUiScope } from './types.js'

/** 宿主保留的会话内管理命令斜杠词；插件 slash 声明不得覆盖（后端注册边界拒绝，前端防御性跳过）。 */
export const RESERVED_SLASH_WORDS: ReadonlySet<string> = new Set(['new', 'clear', 'compact'])

/** 宿主保留的技能引用斜杠命名空间前缀。 */
export const SKILL_SLASH_PREFIX = 'skill:'

/** 斜杠菜单 / 命令面板共用的命令限定形态（插件 ID + spec）。 */
export interface QualifiedCommand {
  pluginId: string
  spec: CommandSpec
}

/** 协议约定的合法插件斜杠词：小写字母数字开头，长度 1-64，且不得占用宿主保留词与 skill: 前缀。 */
export function isValidPluginSlash(slash: string): boolean {
  if (!/^[a-z0-9][a-z0-9:_-]{0,63}$/.test(slash)) return false
  if (RESERVED_SLASH_WORDS.has(slash)) return false
  return !slash.startsWith(SKILL_SLASH_PREFIX)
}

/** 草稿首 token 精确命中插件斜杠词（如 '/archive 有参数'）；命令面板回车与输入框提交共用。 */
export function matchExactPluginSlash(
  payload: string,
  commands: ReadonlyArray<QualifiedCommand>,
): QualifiedCommand | undefined {
  const trimmed = payload.trim()
  const m = /^\/([a-z0-9][a-z0-9:_-]*)(?:\s|$)/.exec(trimmed)
  if (m === null) return undefined
  const word = m[1] ?? ''
  if (!isValidPluginSlash(word)) return undefined
  const rest = trimmed.slice(m[0].length).trim()
  return commands.find((cmd) => cmd.spec.slash === word && rest === '')
}

/**
 * 可出现在当前会话输入框 '/' 补全中的插件命令：
 * 声明 slash + actionId（无 actionId 无从执行）、命中会话作用域；
 * 相同 slash 多插件声明时取注册顺序首个（重复声明由后端注册边界拒绝）。
 */
export function pluginSlashCommandsFor(
  commands: ReadonlyArray<QualifiedCommand>,
  conversation: ConversationSummary | undefined,
): QualifiedCommand[] {
  const seen = new Set<string>()
  const out: QualifiedCommand[] = []
  for (const cmd of commands) {
    const slash = cmd.spec.slash
    if (slash === undefined || cmd.spec.actionId === undefined) continue
    if (!isValidPluginSlash(slash)) continue
    if (seen.has(slash)) continue
    if (!matchesUiScope(conversation, cmd.spec.scope)) continue
    seen.add(slash)
    out.push(cmd)
  }
  return out
}

/** 命令面板按会话作用域过滤（无会话上下文时仅保留不限作用域的命令，与输入框 '/' 行为一致）。 */
export function commandsForConversation(
  commands: ReadonlyArray<QualifiedCommand>,
  conversation: ConversationSummary | undefined,
): QualifiedCommand[] {
  return commands.filter((cmd) => matchesUiScope(conversation, cmd.spec.scope))
}

/** 命令执行的目标插件：actionPluginId 显式跨插件路由，缺省命令所属插件。 */
export function commandActionPluginId(cmd: QualifiedCommand): string {
  return cmd.spec.actionPluginId ?? cmd.pluginId
}

/** 命令面板行 hint：优先插件声明 description，回退 action 寻址（pluginId / actionId）。 */
export function commandHint(spec: CommandSpec, pluginId: string): string {
  if (spec.description !== undefined && spec.description !== '') return spec.description
  if (spec.actionId !== undefined) return `${spec.actionPluginId ?? pluginId} / ${spec.actionId}`
  return spec.actionPluginId ?? pluginId
}

/** 斜杠菜单条目：apply 回填草稿（内置命令/技能）；run 直接执行（插件 action 命令，不回填）。 */
export interface SlashMenuItem {
  id: string
  label: string
  hint?: string
  apply?: string
  run?: () => void
}

/**
 * 合并斜杠菜单条目：宿主内置管理命令 → 可见技能 → 满足作用域的插件命令。
 * 插件命令选中即执行（run），不把触发词回填草稿。
 */
export function buildSlashMenuItems(
  visibleSkills: ReadonlyArray<{ id: string; name: string }>,
  pluginSlash: ReadonlyArray<QualifiedCommand>,
  runPluginCommand: (cmd: QualifiedCommand) => void,
): SlashMenuItem[] {
  const builtin: SlashMenuItem[] = [
    { id: '/new', label: '/new', hint: '重置上下文', apply: '/new' },
    { id: '/clear', label: '/clear', hint: '重置上下文', apply: '/clear' },
    { id: '/compact', label: '/compact', hint: '精简上下文', apply: '/compact' },
  ]
  const skills: SlashMenuItem[] = visibleSkills.map((s) => ({
    id: `/${SKILL_SLASH_PREFIX}${s.id}`,
    label: `/${SKILL_SLASH_PREFIX}${s.id}`,
    hint: s.name,
    apply: `/${SKILL_SLASH_PREFIX}${s.id} `,
  }))
  const plugins: SlashMenuItem[] = pluginSlash.map((cmd) => ({
    id: `plugin:${cmd.pluginId}/${cmd.spec.id}`,
    label: `/${cmd.spec.slash}`,
    hint: cmd.spec.description ?? cmd.spec.title,
    run: () => runPluginCommand(cmd),
  }))
  return [...builtin, ...skills, ...plugins]
}

/** 在光标处插入文本片段；caret 越界时收敛到 [0, text.length]。 */
export function insertAtCaret(text: string, caret: number, fragment: string, selectionEnd = caret): { next: string; nextCaret: number } {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0))
  const end = Math.max(pos, Math.min(text.length, Math.trunc(selectionEnd) || 0))
  return { next: text.slice(0, pos) + fragment + text.slice(end), nextCaret: pos + fragment.length }
}

/**
 * 移除光标前最近的 '/' 或 '@' 触发 token（插件命令执行成功后清理触发词）。
 * 光标前无 token 时文本原样返回（不吞未知草稿）。
 */
export function removeTokenBeforeCaret(text: string, caret: number): { next: string; nextCaret: number } {
  const pos = Math.max(0, Math.min(text.length, Math.trunc(caret) || 0))
  const m = /(?:^|\s)([/@][a-zA-Z0-9:_.\-]*)$/.exec(text.slice(0, pos))
  if (m === null) return { next: text, nextCaret: pos }
  const start = pos - (m[1]?.length ?? 0)
  return { next: text.slice(0, start) + text.slice(pos), nextCaret: start }
}
