/**
 * 技能文件阅读器纯函数模型
 *
 * 为 SkillDetailDrawer 的紧凑文件阅读器提供文件清单构建、Markdown 判定、
 * YAML frontmatter 剥离与语法语言推导等纯函数。
 * 遵循前端 Fast Refresh 规范：纯函数与常量统一定义于此，不与组件混写。
 */
import { detectLanguage } from '../conversation/code-language.js'

/** 主规程文件名（读取路径约定为空串，展示为 SKILL.md）。 */
export const SKILL_MAIN_FILENAME = 'SKILL.md'

/** 技能描述折叠阈值：超过该字符数判定为长描述，阅读区默认 2 行截断并提供展开/收起。 */
export const SKILL_DESC_COLLAPSE_THRESHOLD = 90

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

/**
 * 判定技能描述是否较长（超过 SKILL_DESC_COLLAPSE_THRESHOLD 字符）：
 * 长描述在阅读区默认折叠为 2 行摘要并提供「展开 / 收起」切换，
 * 避免生态技能 500+ 字符描述常驻压顶、挤占正文阅读面积。
 */
export function isSkillDescriptionLong(description: string | undefined | null): boolean {
  return (description ?? '').trim().length > SKILL_DESC_COLLAPSE_THRESHOLD
}

/**
 * 剥离文档头部的 YAML frontmatter（--- ... --- / ... 围栏）与其后的空行。
 * 仅在富文本阅读模式下使用：头部的名称/描述元信息已由抽屉头部展示，
 * 阅读区不再重复渲染原始 frontmatter；源码模式保留原文。
 * 非法或未闭合的 frontmatter 原样返回，绝不截断正文。
 */
export function stripMarkdownFrontmatter(text: string): string {
  if (!text.startsWith('---')) return text
  const lines = text.split('\n')
  if (lines[0] === null || lines[0]!.trim() !== '---') return text
  const end = lines.findIndex((line, i) => i > 0 && (line.trim() === '---' || line.trim() === '...'))
  if (end === -1) return text
  const rest = lines.slice(end + 1)
  while (rest.length > 0 && rest[0]!.trim() === '') rest.shift()
  return rest.join('\n')
}

/**
 * 推导技能文件的语法高亮语言（源码模式与代码类文件消费）：
 * 由文件名后缀推导，主规程按 SKILL.md 推导为 markdown；无法识别返回空串。
 */
export function skillFileLanguage(path: string): string {
  return detectLanguage(skillFileBasename(path ?? '') || SKILL_MAIN_FILENAME, undefined)
}
