/**
 * meta.ts — 提取并校验工作流脚本的 `meta` 块。
 *
 * 自 @tintinweb/pi-subagents v0.23.1 (MIT) 移植。
 *
 * 脚本体运行在 `node:vm`（无模块加载器，`export` 是语法错误），而 meta 需要
 * 在执行前可读（阶段声明用于首帧分组）。方案：字符串扫描到匹配大括号
 * （注释/模板/正则感知），仅在空 vm context 中求值该片段——纯字面量无可调用物，
 * 非纯字面量要么抛错（未绑定标识符）要么被下方校验拒绝。
 */

import { createContext, Script } from 'node:vm'

/** 声明在前的阶段，供 UI 在首个 agent 运行前展示。 */
export interface WorkflowPhaseMeta {
  title: string
  detail?: string
  /** 阶段钉住模型时展示；仅显示用，runtime 不读。 */
  model?: string
}

export interface WorkflowMeta {
  name: string
  description: string
  whenToUse?: string
  phases?: WorkflowPhaseMeta[]
}

export interface MetaExtraction {
  meta: WorkflowMeta
  /**
   * 剥离头部 `export ` 的脚本（用空格替换保偏移，栈帧行号与作者源码对齐）。
   */
  body: string
}

export class WorkflowMetaError extends Error {}

/** 空 context 求值 meta 片段的墙钟上限：只为阻断病态字面量挂死宿主线程。 */
const META_EVAL_TIMEOUT_MS = 100

const PURE_LITERAL_HINT =
  'The `meta` object must be a PURE LITERAL — no variables, function calls, spreads, or template interpolation.'

const META_DECLARATION = /(^|[\r\n])[ \t]*export[ \t\r\n]+const[ \t\r\n]+meta[ \t\r\n]*=/

export function hasMetaDeclaration(source: string): boolean {
  return META_DECLARATION.test(source)
}

interface ScanResult {
  /** 字面量闭括号之后的位置；大括号永不平衡时为 -1。 */
  end: number
  /** 模板字面量内出现过 `${` 插值。 */
  sawInterpolation: boolean
}

function scanObjectLiteral(source: string, open: number): ScanResult {
  let depth = 0
  let i = open
  let sawInterpolation = false
  let mode: 'code' | 'line-comment' | 'block-comment' | 'single' | 'double' | 'template' | 'regex' = 'code'
  const templateStack: number[] = []

  while (i < source.length) {
    const c = source[i]
    const next = source[i + 1]

    if (mode === 'line-comment') {
      if (c === '\n') mode = 'code'
      i++
      continue
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') {
        mode = 'code'
        i += 2
        continue
      }
      i++
      continue
    }
    if (mode === 'single' || mode === 'double' || mode === 'regex') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (mode === 'single' && c === "'") mode = 'code'
      else if (mode === 'double' && c === '"') mode = 'code'
      else if (mode === 'regex' && c === '/') mode = 'code'
      else if (c === '\n' && mode !== 'double') mode = 'code'
      i++
      continue
    }
    if (mode === 'template') {
      if (c === '\\') {
        i += 2
        continue
      }
      if (c === '`') {
        mode = 'code'
        i++
        continue
      }
      if (c === '$' && next === '{') {
        sawInterpolation = true
        templateStack.push(depth)
        depth++
        mode = 'code'
        i += 2
        continue
      }
      i++
      continue
    }

    // mode === "code"
    if (c === '/' && next === '/') {
      mode = 'line-comment'
      i += 2
      continue
    }
    if (c === '/' && next === '*') {
      mode = 'block-comment'
      i += 2
      continue
    }
    if (c === "'") {
      mode = 'single'
      i++
      continue
    }
    if (c === '"') {
      mode = 'double'
      i++
      continue
    }
    if (c === '`') {
      mode = 'template'
      i++
      continue
    }
    if (c === '/' && isRegexPosition(source, i)) {
      mode = 'regex'
      i++
      continue
    }
    if (c === '{') {
      depth++
      i++
      continue
    }
    if (c === '}') {
      depth--
      i++
      if (templateStack.length > 0 && depth === templateStack[templateStack.length - 1]!) {
        templateStack.pop()
        mode = 'template'
        continue
      }
      if (depth === 0) return { end: i, sawInterpolation }
      continue
    }
    i++
  }
  return { end: -1, sawInterpolation }
}

function isRegexPosition(source: string, i: number): boolean {
  let j = i - 1
  while (j >= 0 && /\s/.test(source[j]!)) j--
  if (j < 0) return true
  return !/[\w$)\]]/.test(source[j]!)
}

function fail(message: string): never {
  throw new WorkflowMetaError(message)
}

function assertPhases(value: unknown): WorkflowPhaseMeta[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) fail('`meta.phases` must be an array of { title, detail?, model? } objects.')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fail(`\`meta.phases[${index}]\` must be an object with a \`title\`.`)
    }
    const { title, detail, model } = entry as Record<string, unknown>
    if (typeof title !== 'string' || title.trim() === '') {
      fail(`\`meta.phases[${index}].title\` must be a non-empty string.`)
    }
    if (detail !== undefined && typeof detail !== 'string') {
      fail(`\`meta.phases[${index}].detail\` must be a string.`)
    }
    if (model !== undefined && typeof model !== 'string') {
      fail(`\`meta.phases[${index}].model\` must be a string.`)
    }
    return {
      title,
      ...(detail !== undefined ? { detail } : {}),
      ...(model !== undefined ? { model } : {}),
    }
  })
}

export function extractMeta(source: string): MetaExtraction {
  const declaration = META_DECLARATION.exec(source)
  if (!declaration) {
    fail(
      'A workflow script must begin with `export const meta = { name, description }`.\n' + PURE_LITERAL_HINT,
    )
  }

  const open = source.indexOf('{', declaration.index + declaration[0].length)
  if (open === -1) fail('`export const meta` must be assigned an object literal.\n' + PURE_LITERAL_HINT)

  const { end: close, sawInterpolation } = scanObjectLiteral(source, open)
  if (close === -1) fail('`meta` object literal is never closed — check for an unbalanced `{`.')

  if (sawInterpolation) {
    fail('`meta` must not use template interpolation (`${...}`).\n' + PURE_LITERAL_HINT)
  }

  const fragment = source.slice(open, close)
  let value: unknown
  try {
    value = new Script(`(${fragment})`, { filename: 'workflow-meta.js' }).runInContext(createContext({}), {
      timeout: META_EVAL_TIMEOUT_MS,
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    if (/timed out|Script execution/i.test(detail)) {
      fail(
        `\`meta\` did not finish evaluating within ${META_EVAL_TIMEOUT_MS}ms — it must be a literal, not a computation.\n` +
          PURE_LITERAL_HINT,
      )
    }
    fail(`\`meta\` could not be evaluated: ${detail}\n${PURE_LITERAL_HINT}`)
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('`meta` must be an object literal.\n' + PURE_LITERAL_HINT)
  }
  const raw = value as Record<string, unknown>

  if (typeof raw['name'] !== 'string' || (raw['name'] as string).trim() === '') {
    fail('`meta.name` is required and must be a non-empty string.')
  }
  if (typeof raw['description'] !== 'string' || (raw['description'] as string).trim() === '') {
    fail('`meta.description` is required and must be a non-empty string.')
  }
  if (raw['whenToUse'] !== undefined && typeof raw['whenToUse'] !== 'string') {
    fail('`meta.whenToUse` must be a string.')
  }
  const phases = assertPhases(raw['phases'])

  const meta: WorkflowMeta = {
    name: raw['name'],
    description: raw['description'],
    ...(raw['whenToUse'] !== undefined ? { whenToUse: raw['whenToUse'] as string } : {}),
    ...(phases !== undefined ? { phases } : {}),
  }

  const exportAt = source.indexOf('export', declaration.index)
  const body = `${source.slice(0, exportAt)}${' '.repeat(6)}${source.slice(exportAt + 6)}`

  return { meta, body }
}
