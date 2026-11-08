/**
 * 终端快照菜单提取与审批按键序列规划（纯函数）。
 *
 * 背景：现代 CLI Agent（Antigravity / Claude Code / Codex）的阻塞弹窗多为
 * 游标列表选择式（`> Yes, I trust this folder` / `  No, exit`，提示
 * `↑/↓ Navigate · enter Confirm`）。对这类对话框发送 'y'/'n' 完全不被终端
 * 响应：确认当前高亮项需要 ['enter']，选择第 2 项需要 ['down', 'enter']。
 *
 * 本模块从快照尾部自动提取菜单结构并生成 select options 与 value -> 按键
 * 序列映射；不做任何 IO，提取失败（无菜单）时回退通用选项，绝不编造。
 */

import type { AskFieldOption } from '@helm/protocol'

export interface ExtractedMenuItem {
  /** 菜单项展示文案（去除游标符号后）。 */
  label: string
  /** 选中该项所需发送的 logical keys 序列（如 ['enter'] 或 ['down', 'enter']）。 */
  keys: string[]
  /** 是否为当前游标高亮项。 */
  selected: boolean
}

export interface HerdrAskPromptPlan {
  /** select 字段的 options 列表。 */
  options: AskFieldOption[]
  /** option.value -> 对应发送的 logical keys 数组（不含 'custom'）。 */
  decisionKeys: ReadonlyMap<string, string[]>
  /** 提取到的菜单项（无菜单时为空数组）。 */
  menuItems: ExtractedMenuItem[]
}

/** 游标指示符（CLI TUI 常见集合）。 */
const CURSOR_CHARS = ['>', '❯', '›', '●', '◉', '▶']

function isCursorChar(s: string): boolean {
  return CURSOR_CHARS.includes(s)
}

/** 键位说明栏 / 分隔线 / 状态栏（提取菜单前剥离的噪音行）。 */
function isHintOrDividerLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true
  if (/^[─━═\-]{4,}$/.test(trimmed)) return true
  const lower = trimmed.toLowerCase()
  if (lower.includes('navigate') && lower.includes('confirm')) return true
  if (lower.includes('esc to cancel')) return true
  if (lower.includes('enter to confirm')) return true
  if (lower.includes('enter to select')) return true
  if (lower.includes('? for shortcuts')) return true
  if (trimmed.includes('↑/↓')) return true
  return false
}

interface NumberedLine {
  indent: string
  cursor: string | undefined
  label: string
}

/** 编号列表行：`  1. Yes` / `> 2) No`。 */
function matchNumberedLine(line: string): NumberedLine | undefined {
  const m = /^(\s*)(?:([>❯›●◉▶]|->)\s*)?(\d+)[.)]\s+(.+?)\s*$/.exec(line)
  if (m === null) return undefined
  return { indent: m[1]!, cursor: m[2], label: m[4]! }
}

interface CursorLine {
  indent: string
  label: string
}

/** 无编号游标行：`> Yes, I trust this folder`（排除空 shell prompt）。 */
function matchCursorLine(line: string): CursorLine | undefined {
  const m = /^(\s*)(?:([>❯›●◉▶])|->)\s+(.+?)\s*$/.exec(line)
  if (m === null) return undefined
  const label = m[3]!
  if (label === '') return undefined
  if (label.length > 80) return undefined
  return { indent: m[1]!, label }
}

/** 同级选项行（游标行上/下的候选）：以 1..8 空白开头的短非段落行。 */
function matchSiblingOptionLine(line: string): CursorLine | undefined {
  const m = /^(\s{1,8})(\S.+?)\s*$/.exec(line)
  if (m === null) return undefined
  const label = m[2]!
  if (label.length > 80) return undefined
  if (label.endsWith('.')) return undefined
  if (label.endsWith('?')) return undefined
  const lower = label.toLowerCase()
  if (lower.includes('requires permission')) return undefined
  if (lower.includes('do you trust')) return undefined
  return { indent: m[1]!, label }
}

/** 由菜单项与 selectedIndex 计算 keys/selected。 */
function buildMenuItems(labels: string[], selectedIndex: number): ExtractedMenuItem[] {
  return labels.map((label, i) => ({
    label,
    keys: keysFor(i, selectedIndex),
    selected: i === selectedIndex,
  }))
}

function keysFor(index: number, selectedIndex: number): string[] {
  if (index === selectedIndex) return ['enter']
  if (index > selectedIndex) return [...Array<string>(index - selectedIndex).fill('down'), 'enter']
  return [...Array<string>(selectedIndex - index).fill('up'), 'enter']
}

/** 连续菜单块行数上限（超过视为正文段落而非菜单）。 */
const MAX_MENU_LINES = 8
/** 快照尾部扫描窗口。 */
const TAIL_LINES = 30

/**
 * 从终端快照尾部提取菜单选项：
 * - 剥离底部键位说明栏 / 分隔线 / 状态栏；
 * - 识别编号列表（`1. x` / `> 2. y`，游标行或首项为高亮）；
 * - 识别无编号游标列表（恰 1 行游标 + 紧邻同级选项行）；
 * - 无法识别（不足 2 项）时返回空数组（调用方回退通用选项）。
 */
export function extractMenuItemsFromSnapshot(snapshot: string): ExtractedMenuItem[] {
  const lines = snapshot
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .slice(-TAIL_LINES)
  // 从尾部剥离键位说明 / 分隔线 / 状态栏 / 空行。
  let end = lines.length
  while (end > 0 && isHintOrDividerLine(lines[end - 1]!)) end -= 1
  const body = lines.slice(0, end)
  if (body.length === 0) return []

  // 尝试 1：编号列表（自尾部向上找最长的连续编号块）。
  const numbered = extractNumberedBlock(body)
  if (numbered !== undefined) return numbered

  // 尝试 2：无编号游标列表。
  return extractCursorBlock(body)
}

/** 编号列表块：块内存在游标行则以该行为高亮，否则首项默认高亮。 */
function extractNumberedBlock(body: string[]): ExtractedMenuItem[] | undefined {
  // 自尾行向上找连续编号行，收集最长候选块（含块内游标）。
  const candidates: Array<{ labels: string[]; cursorIndex: number }> = []
  let labels: string[] = []
  let cursorIndex = -1
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const m = matchNumberedLine(body[i]!)
    if (m === undefined) {
      if (labels.length >= 2) candidates.push({ labels: [...labels].reverse(), cursorIndex })
      labels = []
      cursorIndex = -1
      continue
    }
    if (labels.length >= MAX_MENU_LINES) continue
    // 首个遇到的游标行（自尾向上）即块内高亮项；labels 为尾序，收集完后反转。
    if (m.cursor !== undefined && cursorIndex < 0) cursorIndex = labels.length
    labels.push(m.label)
  }
  if (labels.length >= 2) candidates.push({ labels: [...labels].reverse(), cursorIndex })
  if (candidates.length === 0) return undefined
  // 最靠近尾部的块优先（弹出菜单总在快照末尾）；cursorIndex 随反转换算。
  const block = candidates[0]!
  const selectedIndex =
    block.cursorIndex >= 0 ? block.labels.length - 1 - block.cursorIndex : 0
  return buildMenuItems(block.labels, selectedIndex)
}

/**
 * 无编号游标列表：恰好 1 行游标前缀；紧邻其上/下方的同级选项行
 * （空白开头短行、非问句正文）组成菜单块（>= 2 行）。
 */
function extractCursorBlock(body: string[]): ExtractedMenuItem[] {
  const cursorIndexes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    if (matchCursorLine(body[i]!) !== undefined) cursorIndexes.push(i)
  }
  if (cursorIndexes.length !== 1) return []
  const cursorAt = cursorIndexes[0]!
  const cursor = matchCursorLine(body[cursorAt]!)!
  const labels: string[] = [cursor.label]
  let selectedIndex = -1
  // 块的连续范围：从游标行向上/向下扩展同级选项行，允许中间 0 行空隙外断开。
  const blockIndexes: number[] = [cursorAt]
  // 向上收集。
  for (let i = cursorAt - 1; i >= 0 && blockIndexes.length < MAX_MENU_LINES; i -= 1) {
    const line = body[i]!
    if (isHintOrDividerLine(line)) break
    const sibling = matchSiblingOptionLine(line)
    if (sibling === undefined || matchCursorLine(line) !== undefined) break
    blockIndexes.unshift(i)
    labels.unshift(sibling.label)
  }
  selectedIndex = labels.length - 1
  // 向下收集。
  for (let i = cursorAt + 1; i < body.length && blockIndexes.length < MAX_MENU_LINES; i += 1) {
    const line = body[i]!
    if (isHintOrDividerLine(line)) break
    const sibling = matchSiblingOptionLine(line)
    if (sibling === undefined || matchCursorLine(line) !== undefined) break
    blockIndexes.push(i)
    labels.push(sibling.label)
  }
  if (labels.length < 2) return []
  return buildMenuItems(labels, selectedIndex)
}

/**
 * 构建 AskDoc 的 select options 与按键映射：
 * - 有菜单：当前高亮项固定 value 'allow-enter'（发送 enter），其余项
 *   `menu-<idx>`（发送 up/down 序列 + enter）；
 * - 无菜单：首项 'allow-enter'（确认当前高亮选项）；
 * - 恒追加通用选项 allow-y / deny-n / send-esc / custom（任何场景可选）；
 * - 兼容别名 send-y / send-n。
 */
export function buildHerdrAskPromptPlan(snapshot: string): HerdrAskPromptPlan {
  const menuItems = extractMenuItemsFromSnapshot(snapshot)
  const options: AskFieldOption[] = []
  const decisionKeys = new Map<string, string[]>()
  if (menuItems.length >= 2) {
    for (const item of menuItems) {
      if (item.selected) {
        options.push({ label: `确认当前高亮项：${item.label}（发送 enter）`, value: 'allow-enter' })
        decisionKeys.set('allow-enter', ['enter'])
      }
    }
    for (let idx = 0; idx < menuItems.length; idx += 1) {
      const item = menuItems[idx]!
      if (item.selected) continue
      const value = `menu-${idx}`
      options.push({ label: `选择第 ${idx + 1} 项：${item.label}（发送 ${item.keys.join(' + ')}）`, value })
      decisionKeys.set(value, item.keys)
    }
  } else {
    options.push({ label: '允许（发送 enter，确认当前高亮选项）', value: 'allow-enter' })
    decisionKeys.set('allow-enter', ['enter'])
  }
  options.push({ label: '发送 y（适用于 y/n 确认提问）', value: 'allow-y' })
  options.push({ label: '发送 n（适用于 y/n 拒绝提问）', value: 'deny-n' })
  options.push({ label: '发送 esc（取消/退出弹窗）', value: 'send-esc' })
  options.push({ label: '自定义按键序列（在 key 字段填写）', value: 'custom' })
  decisionKeys.set('allow-y', ['y'])
  decisionKeys.set('deny-n', ['n'])
  decisionKeys.set('send-esc', ['esc'])
  // 兼容别名（历史客户端可能提交的 value）。
  decisionKeys.set('send-y', ['y'])
  decisionKeys.set('send-n', ['n'])
  return { options, decisionKeys, menuItems }
}

/** 解析用户填写的自定义按键序列：按逗号或空白切分，去除空串。 */
export function parseCustomKeys(raw: string): string[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}
