/**
 * Shared skill bundle contract (single source of truth across packages).
 *
 * The same SKILL.md frontmatter / skill id / in-bundle relative-path validity rules must hold for every
 * discovery source — the Hub dataDir root, the machine-level shared root (~/.agents/skills), and the
 * per-node workspace root (<cwd>/.helmx/skills) — so a skill listed by any catalog is guaranteed readable
 * by load_skill with the exact same vocabulary. Pure dependency-free functions only; extracted from the
 * kernel SkillService so @helmx/plugins can reuse them without depending on @helmx/kernel.
 */

/** Skill id pattern: 1-64 chars of [A-Za-z0-9._-] starting alphanumerically. */
export const SKILL_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/

/** Validate a skill id; throws on anything else (illegal ids never enter a catalog). */
export function assertSkillId(id: string): void {
  if (!SKILL_ID_PATTERN.test(id)) {
    throw new Error(`illegal skill id: ${id}`)
  }
}

/**
 * Validate a relative path inside a skill bundle: forbids absolute paths, `..` segments, backslashes,
 * control characters, empty segments, and whitespace/`?`/`#` inside segments. Allows nested relative
 * paths like `SKILL.md` and `references/...`. Returns the input unchanged on success.
 */
export function assertSafeSkillRelativePath(input: string): string {
  if (input.includes('\\')) throw new Error(`illegal path (backslash): ${input}`)
  if (input.includes('\0')) throw new Error('illegal path (contains NUL)')
  if (input === '' || input === '.') throw new Error('path cannot be empty')
  if (input.startsWith('/')) throw new Error(`forbidden absolute path: ${input}`)
  for (const seg of input.split('/')) {
    if (seg === '' || seg === '.') throw new Error(`illegal path segment: ${input}`)
    if (seg === '..') throw new Error(`forbidden path traversal: ${input}`)
    if (/[\s/?#]/.test(seg)) throw new Error(`illegal path segment: ${input}`)
  }
  return input
}

/** Strip symmetric leading/trailing single or double quotes from a YAML single-line scalar (unescaping " and \
 * in double quotes and '' in single quotes; asymmetric quotes are kept verbatim without guessing). */
function stripQuotedScalar(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first !== '"' || last !== '"') && (first !== "'" || last !== "'")) return value
  const inner = value.slice(1, -1)
  if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return inner.replace(/''/g, "'")
}

/** Parsed SKILL.md frontmatter fields. */
export interface SkillFrontmatter {
  name: string
  description: string
  managedByPlugin?: string
}

/**
 * Parse top YAML frontmatter name/description/managedByPlugin from SKILL.md (defaults to id/empty when omitted).
 * Only accepts the current field name managedByPlugin (no legacy aliases); a present key with an empty value is invalid
 * and throws explicitly rather than fabricating ownerless data (honest failure, no silent fallback).
 * Supports the minimal YAML subset used by pi ecosystem shared skills (~/.agents/skills): single-line scalars
 * (stripping symmetric outer quotes) and block scalars—folded > / >- (trims consecutive indented lines and joins
 * with spaces for long single-line descriptions) and literal | / |- (strips common indent and joins with newlines);
 * advanced YAML syntax (anchors/lists/nesting, etc.) is unsupported.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (match === null) return { name: '', description: '' }
  const body = match[1] ?? ''
  const fields = new Map<string, string>()
  const lines = body.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m === null || m[1] === undefined) continue
    const key = m[1]
    const inline = (m[2] ?? '').trim()
    // Block scalar: > / >- / | / |- spans consecutive indented lines until a line indented less than the first non-empty line.
    if (inline === '>' || inline === '>-' || inline === '|' || inline === '|-') {
      const block: string[] = []
      let indent = -1
      for (let j = i + 1; j < lines.length; j++) {
        const raw = lines[j]!
        if (raw.trim() === '') {
          block.push('')
          continue
        }
        const leading = raw.length - raw.trimStart().length
        if (indent === -1) indent = leading
        if (leading < indent) break
        block.push(raw.slice(indent))
        i = j
      }
      while (block.length > 0 && block[block.length - 1] === '') block.pop()
      const value = inline.startsWith('>')
        ? block.map((l) => l.trim()).filter((l) => l !== '').join(' ')
        : block.join('\n')
      fields.set(key, value.trim())
      continue
    }
    fields.set(key, stripQuotedScalar(inline))
  }
  const managedRaw = fields.get('managedByPlugin')
  if (managedRaw !== undefined && managedRaw === '') {
    throw new Error(`SKILL.md frontmatter managedByPlugin value is empty (when present, it must be a non-empty plugin ID)`)
  }
  return {
    name: fields.get('name') ?? '',
    description: fields.get('description') ?? '',
    ...(managedRaw !== undefined ? { managedByPlugin: managedRaw } : {}),
  }
}
