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

export interface BlockedSnapshotAiOption {
  /** 人类可读的选项说明（如 "允许本次执行 (once)"）。 */
  label: string
  /** 选中该项需发送的 Herdr logical keys 序列（如 ['o'] 或 ['right', 'enter']）。 */
  keys: string[]
}

export interface BlockedSnapshotAnalysis {
  /** 一句话中文摘要：终端当前在等待什么确认（可选）。 */
  summary?: string
  /** AI 识别出的交互选项列表。 */
  options: BlockedSnapshotAiOption[]
}

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
  /** AI 解析摘要（仅正则未命中且模型返回有效摘要时存在）。 */
  summary?: string
  /** AI 识别的候选按键选项（仅正则未命中时可能非空）。 */
  aiOptions: BlockedSnapshotAnalysis['options']
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
 * 构建 AskDoc 的 select options 与按键映射（混合快慢路径）：
 * - 快路径（正则命中菜单，>= 2 项）：不调 AI，当前高亮项固定 value
 *   'allow-enter'（发送 enter），其余项 `menu-<idx>`（发送 up/down 序列 + enter）；
 * - 慢路径（正则未命中且传入有效 AI 解析）：注入 `ai-<idx>` 选项（发送模型
 *   识别的按键序列），首个恰为 ['enter'] 的选项复用 'allow-enter' value；
 * - 无菜单无 AI：首项 'allow-enter'（确认当前高亮选项）；
 * - 恒追加通用选项 allow-y / deny-n / send-esc / custom（任何场景可选）；
 * - 兼容别名 send-y / send-n。
 */
export function buildHerdrAskPromptPlan(snapshot: string, aiAnalysis?: BlockedSnapshotAnalysis): HerdrAskPromptPlan {
  const menuItems = extractMenuItemsFromSnapshot(snapshot)
  const options: AskFieldOption[] = []
  const decisionKeys = new Map<string, string[]>()
  let summary: string | undefined
  let aiOptionsKept: BlockedSnapshotAnalysis['options'] = []
  if (menuItems.length >= 2) {
    // 快路径：正则已命中标准菜单，忽略 AI 解析（0ms、零 Token）。
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
    // 慢路径：仅当模型返回经过白名单清洗的有效解析时注入 AI 选项。
    const sanitized = sanitizeBlockedSnapshotAnalysis(aiAnalysis)
    summary = sanitized?.summary
    aiOptionsKept = sanitized?.options ?? []
    if (sanitized !== undefined && sanitized.options.length > 0) {
      for (let idx = 0; idx < sanitized.options.length; idx += 1) {
        const opt = sanitized.options[idx]!
        // 恰为 ['enter'] 的首个选项复用 'allow-enter'（语义与快路径一致）。
        if (opt.keys.length === 1 && opt.keys[0] === 'enter' && !decisionKeys.has('allow-enter')) {
          options.push({ label: `AI 识别：${opt.label}（发送 enter）`, value: 'allow-enter' })
          decisionKeys.set('allow-enter', ['enter'])
          continue
        }
        const value = `ai-${idx}`
        options.push({ label: `AI 识别：${opt.label}（发送 ${opt.keys.join(' + ')}）`, value })
        decisionKeys.set(value, opt.keys)
      }
      if (!decisionKeys.has('allow-enter')) {
        options.unshift({ label: '允许（发送 enter，确认当前高亮选项）', value: 'allow-enter' })
        decisionKeys.set('allow-enter', ['enter'])
      }
    } else {
      options.push({ label: '允许（发送 enter，确认当前高亮选项）', value: 'allow-enter' })
      decisionKeys.set('allow-enter', ['enter'])
    }
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
  return {
    options,
    decisionKeys,
    menuItems,
    ...(summary !== undefined ? { summary } : {}),
    aiOptions: aiOptionsKept,
  }
}

/** 解析用户填写的自定义按键序列：按逗号或空白切分，去除空串。 */
export function parseCustomKeys(raw: string): string[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ---------------------------------------------------------------------------
// AI 快照解析辅助层（仅正则未命中标准菜单时调用）
// ---------------------------------------------------------------------------

/** Herdr 服务端 parse_key_combo 支持的命名功能键（小写比较）。 */
const NAMED_LOGICAL_KEYS = new Set([
  'enter',
  'return',
  'esc',
  'escape',
  'tab',
  'shift+tab',
  'space',
  'backspace',
  'bs',
  'up',
  'down',
  'left',
  'right',
  'plus',
  'minus',
  'comma',
  'period',
  'slash',
  'backslash',
  'quote',
  'double_quote',
  'double-quote',
  'semicolon',
  'colon',
  'percent',
  'ampersand',
  'backtick',
])

/** F1 ~ F12。 */
const FUNCTION_KEY = /^[fF](?:[1-9]|1[0-2])$/
/** ctrl/alt + 单字母数字。 */
const MODIFIER_COMBO = /^(?:ctrl|alt)\+[a-z0-9]$/i
/** 单个可见 ASCII 字符（0x21..0x7e）。 */
const SINGLE_VISIBLE_ASCII = /^[!-\x7e]$/

/**
 * Herdr logical key 白名单校验：防止模型幻觉输出 "yes" / "confirm" 等
 * 多字符单词（对齐服务端 parse_key_combo 支持的按键名）。
 */
export function isValidHerdrLogicalKey(key: string): boolean {
  const trimmed = key.trim()
  if (trimmed === '') return false
  if (NAMED_LOGICAL_KEYS.has(trimmed.toLowerCase())) return true
  if (FUNCTION_KEY.test(trimmed)) return true
  if (MODIFIER_COMBO.test(trimmed)) return true
  if (SINGLE_VISIBLE_ASCII.test(trimmed)) return true
  return false
}

/** AI 选项数量与每项按键序列长度上限。 */
const MAX_AI_OPTIONS = 6
const MAX_AI_OPTION_KEYS = 6

/** 键归一化：命名键（长度 > 1）转小写，单字符键保留原样。 */
function normalizeAiKey(key: string): string {
  const trimmed = key.trim()
  return trimmed.length > 1 ? trimmed.toLowerCase() : trimmed
}

/**
 * 校验并清洗模型输出的 BlockedSnapshotAnalysis：
 * - label 非空截 80 字符；keys 需 1..6 个且全部命中白名单；
 * - 命名键归一化小写；按按键序列去重；最多保留 6 项；
 * - 无有效选项且无摘要时返回 undefined（调用方回退通用选项）。
 */
export function sanitizeBlockedSnapshotAnalysis(raw: unknown): BlockedSnapshotAnalysis | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as { summary?: unknown; options?: unknown }
  const summary =
    typeof record.summary === 'string' && record.summary.trim().length > 0
      ? record.summary.trim().slice(0, 200)
      : undefined
  const options: BlockedSnapshotAiOption[] = []
  const seenKeySeqs = new Set<string>()
  if (Array.isArray(record.options)) {
    for (const candidate of record.options) {
      if (options.length >= MAX_AI_OPTIONS) break
      if (typeof candidate !== 'object' || candidate === null) continue
      const opt = candidate as { label?: unknown; keys?: unknown }
      if (typeof opt.label !== 'string' || opt.label.trim().length === 0) continue
      if (!Array.isArray(opt.keys) || opt.keys.length === 0 || opt.keys.length > MAX_AI_OPTION_KEYS) continue
      const keys: string[] = []
      let allValid = true
      for (const k of opt.keys) {
        if (typeof k !== 'string' || !isValidHerdrLogicalKey(k)) {
          allValid = false
          break
        }
        keys.push(normalizeAiKey(k))
      }
      if (!allValid) continue
      const seqKey = keys.join('+')
      if (seenKeySeqs.has(seqKey)) continue
      seenKeySeqs.add(seqKey)
      options.push({ label: opt.label.trim().slice(0, 80), keys })
    }
  }
  if (options.length === 0 && summary === undefined) return undefined
  return { ...(summary !== undefined ? { summary } : {}), options }
}

/** 从模型回复中截取 JSON 子串：优先 ```json 围栏，否则取首个 { 到最后一个 }。 */
function extractJsonSubstring(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced !== null) return fenced[1]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return undefined
  return text.slice(first, last + 1)
}

/** 解析模型回复文本为 BlockedSnapshotAnalysis；任何失败返回 undefined。 */
export function parseAiSnapshotAnalysisText(text: string): BlockedSnapshotAnalysis | undefined {
  const jsonText = extractJsonSubstring(text)
  if (jsonText === undefined) return undefined
  try {
    return sanitizeBlockedSnapshotAnalysis(JSON.parse(jsonText))
  } catch {
    return undefined
  }
}
