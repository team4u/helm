/**
 * 技能文件阅读器纯函数模型
 *
 * 为 SkillDetailDrawer 的紧凑文件阅读器提供文件清单构建、Markdown 判定、
 * YAML frontmatter 解析与 Markdown 元数据表格转换、语法语言推导等纯函数。
 * 遵循前端 Fast Refresh 规范：纯函数与常量统一定义于此，不与组件混写。
 */
import { detectLanguage } from '../conversation/code-language.js'

/** 主规程文件名（读取路径约定为空串，展示为 SKILL.md）。 */
export const SKILL_MAIN_FILENAME = 'SKILL.md'

/** 技能元数据表格的 Markdown 标题文案（置于 frontmatter 转换表格之前）。 */
export const SKILL_FRONTMATTER_TABLE_HEADING = '技能元数据'

/** 阅读器中的单个技能文件条目。 */
export interface SkillFileEntry {
  /** 读取路径：空串表示主规程 SKILL.md */
  path: string
  /** 短文件名（basename），用于下拉选项与工具条主展示 */
  fileName: string
  /** 目录/来源辅助信息（如 'references/' 或 '主规程'） */
  meta: string
  /** 完整相对路径（title 提示与单文件态展示） */
  displayPath: string
}

/** 取路径 basename（兼容携带查询串的路径；空路径返回空串）。 */
export function skillFileBasename(path: string): string {
  const normalized = (path ?? '').split('?')[0]?.split('#')[0] ?? ''
  const idx = normalized.lastIndexOf('/')
  return idx >= 0 ? normalized.slice(idx + 1) : normalized
}

/**
 * 构建技能文件清单：主规程 SKILL.md 置顶，references 依原序排列。
 * 空串、非字符串引用项被过滤，保证清单恒定有效。
 */
export function buildSkillFileList(references?: readonly string[] | null): SkillFileEntry[] {
  const refs = Array.isArray(references)
    ? references.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : []
  const main: SkillFileEntry = {
    path: '',
    fileName: SKILL_MAIN_FILENAME,
    meta: '主规程',
    displayPath: SKILL_MAIN_FILENAME,
  }
  const rest = refs.map((ref) => {
    const fileName = skillFileBasename(ref) || ref
    const dir = ref.slice(0, ref.length - fileName.length)
    return { path: ref, fileName, meta: dir || './', displayPath: ref }
  })
  return [main, ...rest]
}

/** 判断文件是否按 Markdown 渲染（空串视为主规程 SKILL.md）。 */
export function isSkillMarkdownFile(path: string): boolean {
  const name = skillFileBasename(path ?? '') || SKILL_MAIN_FILENAME
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return ext === 'md' || ext === 'markdown'
}

/** frontmatter 中解析出的单个字段（键与其标量值），按原 YAML 顺序保留。 */
export interface SkillFrontmatterField {
  key: string
  value: string
}

/** SKILL.md 顶部 frontmatter 解析结果：字段序列与围栏之后的正文。 */
export interface SkillFrontmatterDoc {
  fields: SkillFrontmatterField[]
  body: string
}

/** 剥离 YAML 单行标量首尾对称的单/双引号（双引号还原 \" 与 \\ 转义，
 * 单引号还原 '' 转义；不对称引号原样保留，不伪造解析）。
 * 语义与 kernel parseSkillFrontmatter 的 stripQuotedScalar 保持一致。 */
function stripQuotedScalar(value: string): string {
  if (value.length < 2) return value
  const first = value[0]
  const last = value[value.length - 1]
  if ((first !== '"' || last !== '"') && (first !== "'" || last !== "'")) return value
  const inner = value.slice(1, -1)
  if (first === '"') return inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  return inner.replace(/''/g, "'")
}

/** 解析 SKILL.md 顶部 YAML frontmatter（--- ... --- / ... 围栏）为字段序列与正文。
 * 值语法与 kernel parseSkillFrontmatter 的最小集对齐：单行标量（剥首尾对称
 * 引号）与块标量——折叠型 > / >-（连续缩进行 trim 后以空格拼接）与保留型
 * | / |-（去公共缩进后以换行拼接）；不匹配键模式的行（注释/空行等）跳过。
 * 无围栏或未闭合时返回 null，调用方原文回退，绝不截断正文。 */
export function extractSkillFrontmatter(text: string): SkillFrontmatterDoc | null {
  const lines = text.split(/\r?\n/)
  if (lines[0] === undefined || lines[0]!.trim() !== '---') return null
  const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'))
  if (end === -1) return null
  const fields: SkillFrontmatterField[] = []
  for (let i = 1; i < end; i++) {
    const line = lines[i]!
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
    if (m === null || m[1] === undefined) continue
    const key = m[1]
    const inline = (m[2] ?? '').trim()
    // 块标量：> / >- / | / |- 后续连续缩进行（浅于首个非空行缩进即块结束）为值体
    if (inline === '>' || inline === '>-' || inline === '|' || inline === '|-') {
      const block: string[] = []
      let indent = -1
      for (let j = i + 1; j < end; j++) {
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
      fields.push({ key, value: value.trim() })
      continue
    }
    fields.push({ key, value: stripQuotedScalar(inline) })
  }
  const rest = lines.slice(end + 1)
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift()
  return { fields, body: rest.join('\n') }
}

/** Markdown 表格单元格安全转义：反斜杠与竖线转义防破坏表格列结构，
 * & 与 < 转字符引用防 react-markdown 把值误当原始 HTML 吞掉，
 * 换行折成空格保证单元格单行（GFM 表格单元格不含块级换行）。 */
function escapeTableCellValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\|/g, '\\|')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\r\n?|\n/g, ' ')
}

/** 把 frontmatter 字段序列转换为 Markdown 表格（含「技能元数据」标题行）。
 * 字段按原 YAML 顺序保留；空字段序列返回空串（无可渲染内容）。 */
export function renderSkillFrontmatterTable(fields: readonly SkillFrontmatterField[]): string {
  if (fields.length === 0) return ''
  const rows = fields.map(
    (f) => `| ${escapeTableCellValue(f.key)} | ${escapeTableCellValue(f.value)} |`,
  )
  return [
    `## ${SKILL_FRONTMATTER_TABLE_HEADING}`,
    '',
    '| 字段 | 内容 |',
    '| --- | --- |',
    ...rows,
  ].join('\n')
}

/** 富文本阅读模式统一文档视图：把 SKILL.md 顶部 YAML frontmatter 转换为
 * Markdown 元数据表格，正文紧随其后，元数据与正文处于同一内容流（桌面/
 * 移动端共用同一 DOM 与渲染逻辑）。无 frontmatter 时正文原样返回；围栏
 * 未闭合或首行非 --- 围栏时原文回退，绝不截断正文。源码模式不经此转换。 */
export function renderSkillDocMarkdown(text: string): string {
  const parsed = extractSkillFrontmatter(text)
  if (parsed === null) return text
  const table = renderSkillFrontmatterTable(parsed.fields)
  if (table === '') return parsed.body
  return parsed.body === '' ? table : `${table}\n\n${parsed.body}`
}

/**
 * 推导技能文件的语法高亮语言（源码模式与代码类文件消费）：
 * 由文件名后缀推导，主规程按 SKILL.md 推导为 markdown；无法识别返回空串。
 */
export function skillFileLanguage(path: string): string {
  return detectLanguage(skillFileBasename(path ?? '') || SKILL_MAIN_FILENAME, undefined)
}
