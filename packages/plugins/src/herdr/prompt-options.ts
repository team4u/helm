/**
 * Terminal snapshot menu extraction and approval keystroke-sequence planning (pure functions).
 *
 * Background: modern CLI agents' (Antigravity / Claude Code / Codex) blocking popups are mostly
 * cursor-list selections (`> Yes, I trust this folder` / `  No, exit`, hint
 * `↑/↓ Navigate · enter Confirm`). Sending 'y'/'n' to such dialogs is completely ignored by the terminal:
 * confirming the highlighted item needs ['enter'], choosing the 2nd item needs ['down', 'enter'].
 *
 * This module extracts the menu structure from the snapshot tail and produces select options plus the value -> keystroke
 * sequence mapping; it does no IO, and on extraction failure (no menu) falls back to generic options, never fabricating.
 */

import type { AskFieldOption } from '@helm/protocol'

export interface BlockedSnapshotAiOption {
  /** Human-readable option description (e.g. "Allow this run (once)"). */
  label: string
  /** The Herdr logical key sequence to send when this option is chosen (e.g. ['o'] or ['right', 'enter']). */
  keys: string[]
}

export interface BlockedSnapshotAnalysis {
  /** A one-sentence summary: what confirmation the terminal is waiting for (optional). */
  summary?: string
  /** The list of interactive options recognized by AI. */
  options: BlockedSnapshotAiOption[]
}

export interface ExtractedMenuItem {
  /** Menu item display text (after stripping cursor symbols). */
  label: string
  /** The logical key sequence to send for choosing this item (e.g. ['enter'] or ['down', 'enter']). */
  keys: string[]
  /** Whether this is the currently highlighted cursor item. */
  selected: boolean
}

export interface HerdrAskPromptPlan {
  /** The select field's options list. */
  options: AskFieldOption[]
  /** option.value -> the corresponding logical keys array to send (excluding 'custom'). */
  decisionKeys: ReadonlyMap<string, string[]>
  /** The extracted menu items (empty array when there is no menu). */
  menuItems: ExtractedMenuItem[]
  /** AI parse summary (present only when the regex missed and the model returned a valid summary). */
  summary?: string
  /** AI-recognized candidate keystroke options (possibly non-empty only when the regex missed). */
  aiOptions: BlockedSnapshotAnalysis['options']
}

/** Key-hint bars / separators / status bars / menu decoration frames (noise lines stripped before menu extraction). */
function isHintOrDividerLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '') return true
  if (/^[─━═\-]{4,}$/.test(trimmed)) return true
  // Menu decoration frames (╭─ bash ─╮ / ╰────╯ / ─── ───): box-drawing/hyphen/space/short-label only.
  if (/^[╭╮╰╯│┌┐└┘|][─━═\-\s\w]{2,}[╭╮╰╯│┌┐└┘|]?$/.test(trimmed) && /[─━═\-]{2,}/.test(trimmed)) return true
  const lower = trimmed.toLowerCase()
  if (lower.includes('navigate') && lower.includes('confirm')) return true
  if (lower.includes('esc to cancel')) return true
  if (lower.includes('enter to confirm')) return true
  if (lower.includes('enter to select')) return true
  if (lower.includes('enter to continue')) return true
  if (lower.includes('? for shortcuts')) return true
  if (trimmed.includes('↑/↓')) return true
  return false
}

interface NumberedLine {
  indent: string
  cursor: string | undefined
  number: number
  label: string
}

/** Numbered list rows: `  1. Yes` / `> 2) No`. */
function matchNumberedLine(line: string): NumberedLine | undefined {
  const m = /^(\s*)(?:([>❯›●◉▶]|->)\s*)?(\d+)[.)]\s+(.+?)\s*$/.exec(line)
  if (m === null) return undefined
  return { indent: m[1]!, cursor: m[2], number: Number(m[3]), label: m[4]! }
}

interface CursorLine {
  indent: string
  label: string
}

/** Unnumbered cursor rows: `> Yes, I trust this folder` (empty shell prompts excluded). */
function matchCursorLine(line: string): CursorLine | undefined {
  const m = /^(\s*)(?:([>❯›●◉▶])|->)\s+(.+?)\s*$/.exec(line)
  if (m === null) return undefined
  const label = m[3]!
  if (label === '') return undefined
  if (label.length > 80) return undefined
  return { indent: m[1]!, label }
}

/**
 * Sibling candidate row content validation: short non-paragraph lines, not question bodies (indent legality is compared by the caller).
 */
function validateSiblingLabel(indent: string, label: string): CursorLine | undefined {
  if (label.length > 80) return undefined
  if (label.endsWith('.')) return undefined
  if (label.endsWith('?')) return undefined
  const lower = label.toLowerCase()
  if (lower.includes('requires permission')) return undefined
  if (lower.includes('do you trust')) return undefined
  return { indent, label }
}

/** Compute keys/selected from menu items and selectedIndex. */
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

/** Cap on consecutive menu-block rows (beyond this it's a body paragraph, not a menu; never truncate into a fake menu). */
const MAX_MENU_LINES = 8
/** Snapshot tail scan window. */
const TAIL_LINES = 30

/** Live interaction evidence: navigation/confirm hints (↑/↓ · enter / enter to continue etc.). */
function isInteractionHintLine(line: string): boolean {
  const lower = line.toLowerCase()
  if (line.includes('↑/↓') || line.includes('↑ ↓')) return true
  if (lower.includes('navigate') && (lower.includes('confirm') || lower.includes('select'))) return true
  if (lower.includes('enter to confirm') || lower.includes('enter to select')) return true
  if (lower.includes('enter to continue') || lower.includes('press enter')) return true
  if (lower.includes('enter confirm') || lower.includes('enter select')) return true
  if (lower.includes('arrow keys') && lower.includes('select')) return true
  return false
}

/**
 * Extract menu options from the terminal snapshot tail (deterministic fast path):
 * - strip bottom key-hint bars / separators / status bars;
 * - recognize numbered menus (`1. x` / `> 2. y`): exactly 1 cursor row inside the block is required (reliable highlight),
 *   otherwise it's just a body step list (to the AI slow path; never default to the first item highlighted);
 * - recognize unnumbered cursor lists (exactly 1 cursor row + adjacent option rows at the same indent + interaction hints);
 * - only blank lines/key hints/status bars are allowed after the menu block; historical menus past new body text are not adopted;
 * - anything suspicious but under-evidenced (over 8 items, no selection info) returns an empty array (the caller goes to AI
 *   or generic options); never truncate into a fake menu.
 */
export function extractMenuItemsFromSnapshot(snapshot: string): ExtractedMenuItem[] {
  const lines = snapshot
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .slice(-TAIL_LINES)
  // Strip key hints / separators / status bars / blank lines from the tail.
  let end = lines.length
  while (end > 0 && isHintOrDividerLine(lines[end - 1]!)) end -= 1
  const body = lines.slice(0, end)
  if (body.length === 0) return []

  // Attempt 1: numbered menu (requires interaction evidence).
  const numbered = extractNumberedBlock(body)
  if (numbered !== undefined) return numbered

  // Attempt 2: unnumbered cursor list (requires navigation/confirm hints as live interaction evidence).
  return extractCursorBlock(body, lines.some((line) => isInteractionHintLine(line)))
}

/**
 * Numbered menu block: all conditions must hold, otherwise return undefined (body step lists go to AI):
 * - numbers start at 1 and increase consecutively (a real menu's numbering sequence);
 * - exactly 1 cursor row in the block (an unambiguous highlight): no cursor means no reliable selection info -- never
 *   default to the first item, hand to the AI slow path; multiple cursors are parse noise, also rejected;
 * - only blank lines/key hints/status bars are allowed after the block (historical numbering past new body text is not a menu).
 */
function extractNumberedBlock(body: string[]): ExtractedMenuItem[] | undefined {
  // From the tail upward, find consecutive numbered rows and collect candidate blocks (incl. in-block cursors and original line numbers).
  interface Candidate {
    labels: string[]
    numbers: number[]
    cursorIndex: number // tail-order index; after reversal, forward highlight = length - 1 - cursorIndex
    firstRow: number
    lastRow: number
  }
  const candidates: Candidate[] = []
  let labels: string[] = []
  let numbers: number[] = []
  let cursorIndex = -1
  let firstRow = -1
  let lastRow = -1
  const flush = () => {
    if (cursorIndex !== -2 && labels.length >= 2 && labels.length <= MAX_MENU_LINES) {
      candidates.push({ labels: [...labels].reverse(), numbers: [...numbers].reverse(), cursorIndex, firstRow, lastRow })
    }
    labels = []
    numbers = []
    cursorIndex = -1
    firstRow = -1
    lastRow = -1
  }
  for (let i = body.length - 1; i >= 0; i -= 1) {
    const m = matchNumberedLine(body[i]!)
    if (m === undefined) {
      flush()
      continue
    }
    if (labels.length >= MAX_MENU_LINES) {
      // Over 8 consecutive numbered rows looks more like a body step list: suspected, don't truncate into a fake menu; drop the block.
      flush()
      continue
    }
    if (m.cursor !== undefined) {
      // Multiple cursors are parse noise (a real menu has exactly one highlight): reject.
      if (cursorIndex >= 0) {
        labels = []
        numbers = []
        cursorIndex = -2 // mark the block voided
        firstRow = -1
        lastRow = -1
        continue
      }
      cursorIndex = labels.length
    }
    labels.push(m.label)
    numbers.push(Number(m.number))
    firstRow = i
    if (lastRow < 0) lastRow = i
  }
  flush()
  if (candidates.length === 0) return undefined
  // The block closest to the tail wins (popup menus are always at the snapshot end).
  const block = candidates[0]!
  // Content after the block: only blank lines/key hints/status bars are allowed (the tail hint was stripped in body,
  // but the block may not be at the very end -- when new body text follows, it must be rejected to avoid picking a historical menu).
  for (let i = block.lastRow + 1; i < body.length; i += 1) {
    const line = body[i]!
    if (line.trim() === '' || isHintOrDividerLine(line) || isInteractionHintLine(line)) continue
    return undefined
  }
  // Numbering continuity: a real menu starts at 1 and increases consecutively.
  for (let i = 0; i < block.numbers.length; i += 1) {
    if (block.numbers[i] !== i + 1) return undefined
  }
  // No cursor: no reliable selection info; don't default the first item to highlighted (hand to the AI slow path).
  if (block.cursorIndex < 0) return undefined
  return buildMenuItems(block.labels, block.labels.length - 1 - block.cursorIndex)
}

/**
 * Unnumbered cursor list: exactly 1 cursor-prefixed row + live interaction evidence (↑/↓ navigation / enter
 * confirm hint lines, incl. the already-stripped tail hint); adjacent candidate rows above/below form the menu block (>= 2 rows).
 * - Candidate rows must be at the **same indent level** (menu siblings are typeset consistently; uneven levels mean body
 *   paragraphs, e.g. the supplementary row of "> suggestion\n    detail"), short non-paragraph, not question bodies;
 * - only blank lines/key hints/status bars are allowed after the block: an old menu followed by new body text (e.g. "confirm
 *   now? (y/n)") is rejected; never pick a historical menu;
 * - hitting the 8-row cap with more candidate rows still following does not truncate to the first 8; reject.
 */
function extractCursorBlock(body: string[], hasInteractionHint: boolean): ExtractedMenuItem[] {
  if (!hasInteractionHint) return []
  const cursorIndexes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    if (matchCursorLine(body[i]!) !== undefined) cursorIndexes.push(i)
  }
  if (cursorIndexes.length !== 1) return []
  const cursorAt = cursorIndexes[0]!
  const cursor = matchCursorLine(body[cursorAt]!)!
  const labels: string[] = [cursor.label]
  let selectedIndex = -1
  const blockIndexes: number[] = [cursorAt]
  // Sibling rows at the same indent: the first accepted candidate row sets the baseline; any later indent mismatch ends the block.
  let siblingIndent: string | undefined
  const acceptSibling = (line: string): CursorLine | undefined => {
    // First parse the row's own 1..8-space indent, then compare against the sibling baseline.
    const m = /^(\s{1,8})(\S.+?)\s*$/.exec(line)
    if (m === null) return undefined
    const candidate = validateSiblingLabel(m[1]!, m[2]!)
    if (candidate === undefined) return undefined
    if (siblingIndent === undefined) siblingIndent = candidate.indent
    return candidate.indent === siblingIndent ? candidate : undefined
  }
  // Collect upward.
  for (let i = cursorAt - 1; i >= 0 && blockIndexes.length < MAX_MENU_LINES; i -= 1) {
    const line = body[i]!
    if (isHintOrDividerLine(line)) break
    const sibling = acceptSibling(line)
    if (sibling === undefined || matchCursorLine(line) !== undefined) break
    blockIndexes.unshift(i)
    labels.unshift(sibling.label)
  }
  selectedIndex = labels.length - 1
  // Collect downward; when the cap is reached but more same-level candidate rows follow, don't truncate (suspected long list, hand to AI).
  let truncatedByLimit = false
  for (let i = cursorAt + 1; i < body.length; i += 1) {
    const line = body[i]!
    if (isHintOrDividerLine(line)) break
    const sibling = acceptSibling(line)
    if (sibling === undefined || matchCursorLine(line) !== undefined) break
    if (blockIndexes.length >= MAX_MENU_LINES) {
      truncatedByLimit = true
      break
    }
    blockIndexes.push(i)
    labels.push(sibling.label)
  }
  if (truncatedByLimit) return []
  // Body after the block: only blank lines/key hints/status bars are allowed after a menu block; new body text rejects the whole thing.
  const lastBlockRow = blockIndexes[blockIndexes.length - 1]!
  for (let i = lastBlockRow + 1; i < body.length; i += 1) {
    const line = body[i]!
    if (line.trim() === '' || isHintOrDividerLine(line) || isInteractionHintLine(line)) continue
    return []
  }
  if (labels.length < 2) return []
  return buildMenuItems(labels, selectedIndex)
}

/**
 * Build the AskDoc's select options and key mapping (hybrid fast/slow paths):
 * - fast path (regex hit a menu with >= 2 items): no AI call; the current highlighted item gets the fixed value
 *   'allow-enter' (sends enter), other items `menu-<idx>` (sends an up/down sequence + enter);
 * - slow path (regex missed and a valid AI parse was passed in): inject `ai-<idx>` options (sending the model-recognized
 *   key sequences); the first option that is exactly ['enter'] reuses the 'allow-enter' value;
 * - no menu, no AI: first option 'allow-enter' (sends enter, confirming the current highlighted choice);
 * - generic options allow-y / deny-n / send-esc / custom are always appended (selectable in any scenario);
 * - compatible aliases send-y / send-n.
 *
 * Semantic red line: every option only describes "what keys will be sent", containing no authorization promise
 * (allow-enter does not mean approved); keys are sent only after a human explicitly chooses. summary and labels are uniformly
 * redacted at this boundary (AI output is equally untrusted; it must pass redact before entering AskSpec).
 */
export function buildHerdrAskPromptPlan(
  snapshot: string,
  aiAnalysis?: BlockedSnapshotAnalysis,
  redact: (text: string) => string = (t) => t,
): HerdrAskPromptPlan {
  const menuItems = extractMenuItemsFromSnapshot(snapshot)
  const options: AskFieldOption[] = []
  const decisionKeys = new Map<string, string[]>()
  let summary: string | undefined
  let aiOptionsKept: BlockedSnapshotAnalysis['options'] = []
  if (menuItems.length >= 2) {
    // Fast path: the regex already hit a standard menu; ignore the AI parse (0ms, zero tokens).
    for (const item of menuItems) {
      if (item.selected) {
        options.push({ label: `Send enter (confirm the current highlighted item: ${redact(item.label)})`, value: 'allow-enter' })
        decisionKeys.set('allow-enter', ['enter'])
      }
    }
    for (let idx = 0; idx < menuItems.length; idx += 1) {
      const item = menuItems[idx]!
      if (item.selected) continue
      const value = `menu-${idx}`
      options.push({ label: `Send ${item.keys.join(' + ')} (choose item ${idx + 1}: ${redact(item.label)})`, value })
      decisionKeys.set(value, item.keys)
    }
  } else {
    // Slow path: inject AI options only when the model returned a valid parse cleaned by the whitelist.
    const sanitized = sanitizeBlockedSnapshotAnalysis(aiAnalysis)
    summary = sanitized?.summary !== undefined ? redact(sanitized.summary) : undefined
    aiOptionsKept = sanitized?.options ?? []
    if (sanitized !== undefined && sanitized.options.length > 0) {
      for (let idx = 0; idx < sanitized.options.length; idx += 1) {
        const opt = sanitized.options[idx]!
        // The first option that is exactly ['enter'] reuses 'allow-enter' (same semantics as the fast path).
        if (opt.keys.length === 1 && opt.keys[0] === 'enter' && !decisionKeys.has('allow-enter')) {
          options.push({ label: `AI detected: send enter (${redact(opt.label)})`, value: 'allow-enter' })
          decisionKeys.set('allow-enter', ['enter'])
          continue
        }
        const value = `ai-${idx}`
        options.push({ label: `AI detected: send ${opt.keys.join(' + ')} (${redact(opt.label)})`, value })
        decisionKeys.set(value, opt.keys)
      }
      if (!decisionKeys.has('allow-enter')) {
        options.unshift({ label: 'Send enter (confirm the current highlighted choice)', value: 'allow-enter' })
        decisionKeys.set('allow-enter', ['enter'])
      }
    } else {
      options.push({ label: 'Send enter (confirm the current highlighted choice)', value: 'allow-enter' })
      decisionKeys.set('allow-enter', ['enter'])
    }
  }
  options.push({ label: 'Send y (for y/n confirmation prompts)', value: 'allow-y' })
  options.push({ label: 'Send n (for y/n rejection prompts)', value: 'deny-n' })
  options.push({ label: 'Send esc (cancel/exit the popup)', value: 'send-esc' })
  options.push({ label: 'Custom keystroke sequence (fill in the key field)', value: 'custom' })
  decisionKeys.set('allow-y', ['y'])
  decisionKeys.set('deny-n', ['n'])
  decisionKeys.set('send-esc', ['esc'])
  // Compatible aliases (values historical clients may submit).
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

/** Parse the user's custom keystroke sequence: split by comma or whitespace, drop empty strings. */
export function parseCustomKeys(raw: string): string[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// ---------------------------------------------------------------------------
// AI snapshot parsing auxiliary layer (invoked only when the regex misses a standard menu)
// ---------------------------------------------------------------------------

/** Named function keys supported by the Herdr server's parse_key_combo (compared lowercase). */
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
/** ctrl/alt + single alphanumeric. */
const MODIFIER_COMBO = /^(?:ctrl|alt)\+[a-z0-9]$/i
/** A single visible ASCII character (0x21..0x7e). */
const SINGLE_VISIBLE_ASCII = /^[!-\x7e]$/

/**
 * Herdr logical key whitelist validation: prevents model hallucinations like "yes" / "confirm"
 * (multi-character words) (aligned with the key names the server's parse_key_combo supports, verified against
 * /root/code/herdr/src/config/keybinds.rs: named keys like semicolon/colon/ampersand/
 * backtick are really supported). A single '+' is a separator, not a key name, and must be rejected
 * (use 'plus' for the plus sign).
 */
export function isValidHerdrLogicalKey(key: string): boolean {
  const trimmed = key.trim()
  if (trimmed === '') return false
  // '+' is a combo separator, not a sendable single key; the plus sign must use the named key 'plus'.
  if (trimmed === '+') return false
  if (NAMED_LOGICAL_KEYS.has(trimmed.toLowerCase())) return true
  if (FUNCTION_KEY.test(trimmed)) return true
  if (MODIFIER_COMBO.test(trimmed)) return true
  if (SINGLE_VISIBLE_ASCII.test(trimmed)) return true
  return false
}

/** Caps on AI option count and per-option key sequence length. */
const MAX_AI_OPTIONS = 6
const MAX_AI_OPTION_KEYS = 6

/** Key normalization: named keys (length > 1) lowercased; single-character keys kept as-is (case-sensitive). */
function normalizeAiKey(key: string): string {
  const trimmed = key.trim()
  return trimmed.length > 1 ? trimmed.toLowerCase() : trimmed
}

/**
 * Validate and clean the model's BlockedSnapshotAnalysis output:
 * - label non-empty, truncated to 80 chars; keys must be 1..6 and all whitelisted;
 * - named keys normalized lowercase; dedup by key sequence; keep at most 6 items;
 * - return undefined when there are no valid options and no summary (the caller falls back to generic options).
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

/** Extract the JSON substring from a model reply: prefer a ```json fence, otherwise the first { to the last }. */
function extractJsonSubstring(text: string): string | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  if (fenced !== null) return fenced[1]
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last <= first) return undefined
  return text.slice(first, last + 1)
}

/** Parse a model reply text into a BlockedSnapshotAnalysis; any failure returns undefined. */
export function parseAiSnapshotAnalysisText(text: string): BlockedSnapshotAnalysis | undefined {
  const jsonText = extractJsonSubstring(text)
  if (jsonText === undefined) return undefined
  try {
    return sanitizeBlockedSnapshotAnalysis(JSON.parse(jsonText))
  } catch {
    return undefined
  }
}
