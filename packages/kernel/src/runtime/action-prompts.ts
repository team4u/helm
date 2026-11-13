/**
 * 动作目录提示（宿主管理段 prompt.actions）。
 *
 * 职责：把当前会话真正可达（run_action 未被剥离 + scope 命中 + 非 exposeAsTool
 * 直投）的插件动作渲染成 <available_actions> 紧凑目录，并投射进 system sections。
 * 纯函数模块：可达性判定（工具交集 / scope）由 hook-bridge 负责，这里只做
 * 渲染与段落管理。完整 Schema 不常驻提示词——目录只带必填/可选与顶层类型，
 * 嵌套与复杂结构显式引导经 run_action describe 按需查询。
 */
import type { ActionManifest, JsonSchema } from '@helm/protocol'
import { escapeXml } from './runtime-helpers.js'

/** 宿主管理段 ID（set-or-clear；无目录时必须移除旧段，不留幻影文本）。 */
export const ACTIONS_PROMPT_SECTION_ID = 'prompt.actions'

/** 目录条目：manifest + 预解析的等效 CLI 命令（undefined = 不展示 CLI）。 */
export interface ActionDirectoryEntry {
  readonly manifest: ActionManifest
  readonly cliCommand?: string
}

/**
 * 等效 CLI 命令（真实存在的挂载路径）：cli.command 覆写优先，缺省
 * [剥离 builtin: 的 pluginId, actionId]；cli.hidden 不展示（不宣传不存在的
 * 顶层命令）。
 */
export function actionCliCommand(manifest: ActionManifest): string | undefined {
  if (manifest.cli?.hidden === true) return undefined
  const custom = manifest.cli?.command?.filter((segment) => typeof segment === 'string' && segment.length > 0)
  if (custom !== undefined && custom.length > 0) return `helm ${custom.join(' ')}`
  return `helm ${manifest.pluginId.replace(/^builtin:/, '')} ${manifest.id}`
}

/** 多行/多空白描述压成单行（目录每动作一行描述）。 */
function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim()
}

/** 属性级类型签名的复杂度判定。 */
type PropComplexity = 'plain' | 'nested-object' | 'complex'

function propSignature(prop: unknown): { signature: string; complexity: PropComplexity } {
  if (prop === null || typeof prop !== 'object' || Array.isArray(prop)) {
    return { signature: 'unknown', complexity: 'complex' }
  }
  const spec = prop as Record<string, unknown>
  if (spec['$ref'] !== undefined || spec['oneOf'] !== undefined || spec['anyOf'] !== undefined || spec['allOf'] !== undefined || spec['not'] !== undefined) {
    return { signature: '复杂', complexity: 'complex' }
  }
  const type = spec['type']
  if (type === 'array') {
    const items = spec['items']
    const itemType =
      items !== null && typeof items === 'object' && !Array.isArray(items)
        ? String((items as Record<string, unknown>)['type'] ?? 'unknown')
        : 'unknown'
    const nested = itemType === 'object' || (items as Record<string, unknown> | undefined)?.['properties'] !== undefined
    return { signature: `${itemType}[]`, complexity: nested ? 'complex' : 'plain' }
  }
  if (type === 'object') {
    const hasProperties = spec['properties'] !== undefined
    return { signature: hasProperties ? 'object（嵌套）' : 'object', complexity: hasProperties ? 'nested-object' : 'plain' }
  }
  if (typeof type === 'string') return { signature: type, complexity: 'plain' }
  if (typeof type === 'boolean') return { signature: 'unknown', complexity: 'plain' }
  return { signature: 'unknown', complexity: 'complex' }
}

/**
 * 顶层 inputSchema 的紧凑参数签名：
 * - 普通对象 schema：全量列出属性（name: type（必填|可选）），无静默截断；
 * - 嵌套对象 / 数组元素为对象 / 组合器：标注为按需 describe 查询，不展开；
 * - 非普通对象 schema（组合器 / $ref / 非对象类型）：整体标注 describe 查询。
 */
export function compactActionSignature(schema: JsonSchema): string {
  if (schema === null || typeof schema !== 'object') return 'Schema 非法，run_action describe 查询'
  const combinators = ['$ref', 'oneOf', 'anyOf', 'allOf']
  if (combinators.some((key) => schema[key] !== undefined)) return 'Schema 复杂，run_action describe 查询'
  if (schema['type'] !== undefined && schema['type'] !== 'object') {
    return `顶层类型 ${String(schema['type'])}，run_action describe 查询`
  }
  const properties = schema['properties']
  if (properties === undefined || properties === null || typeof properties !== 'object' || Array.isArray(properties)) {
    return '（无参数）'
  }
  const required = Array.isArray(schema['required']) ? new Set(schema['required'].map((name) => String(name))) : new Set<string>()
  const parts: string[] = []
  for (const [name, prop] of Object.entries(properties)) {
    const { signature, complexity } = propSignature(prop)
    const optional = required.has(name) ? '必填' : '可选'
    const hint = complexity === 'plain' ? '' : '（describe 查询）'
    parts.push(`${name}: ${signature}${hint}（${optional}）`)
  }
  if (parts.length === 0) return '（无参数）'
  return parts.join('、')
}

/** 渲染 <available_actions> 目录段；无条目返回 undefined（调用方清除旧段）。 */
export function renderAvailableActionsSection(entries: readonly ActionDirectoryEntry[]): string | undefined {
  if (entries.length === 0) return undefined
  const header = [
    '<available_actions>',
    '以下插件动作在当前会话经 run_action({ actionId: "pluginId.actionId", input }) 调用；目录为全量清单，无截断。',
    '参数为紧凑签名（必填/可选与顶层类型），嵌套与复杂结构不展开：先 run_action({ actionId, describe: true }) 获取该动作完整 input/outputSchema（仅描述，不执行动作）；也可经 bash 执行 helm actions list --json 查看。CLI 为等效人工通道（本会话无 bash 时仍可经 run_action 调用）。',
  ]
  const groups = new Map<string, ActionDirectoryEntry[]>()
  for (const entry of entries) {
    const list = groups.get(entry.manifest.pluginId)
    if (list !== undefined) list.push(entry)
    else groups.set(entry.manifest.pluginId, [entry])
  }
  const body: string[] = []
  for (const [pluginId, pluginEntries] of groups) {
    body.push(`plugin ${escapeXml(pluginId)}:`)
    for (const { manifest, cliCommand } of pluginEntries) {
      const qualified = `${manifest.pluginId}.${manifest.id}`
      body.push(`- ${escapeXml(qualified)}: ${escapeXml(oneLine(manifest.description))}`)
      body.push(`  参数: ${escapeXml(compactActionSignature(manifest.inputSchema))}`)
      if (cliCommand !== undefined) body.push(`  CLI: ${escapeXml(cliCommand)}`)
      if (manifest.promptGuidelines !== undefined && manifest.promptGuidelines.length > 0) {
        body.push(`  指引（${escapeXml(qualified)}）:`)
        for (const item of manifest.promptGuidelines) body.push(`  - ${item}`)
      }
      if (manifest.promptSnippet !== undefined) {
        body.push(`  说明（${escapeXml(qualified)}）:`)
        for (const line of manifest.promptSnippet.split('\n')) body.push(`  ${line}`)
      }
    }
  }
  return `${header.join('\n')}\n${body.join('\n')}\n</available_actions>`
}

/**
 * 投射宿主管理段 prompt.actions：text 非空覆盖 / 为空移除；其余段（含插件
 * 自定义段）原样保留，未变化时返回原引用。停用、scope 不匹配、run_action
 * 剥离或无可用动作时调用方传 undefined 即完成旧段清除。
 */
export function projectActionPromptSection(
  sections: ReadonlyArray<{ id: string; text: string }>,
  text: string | undefined,
): Array<{ id: string; text: string }> {
  const current = sections.find((section) => section.id === ACTIONS_PROMPT_SECTION_ID)
  if (text === undefined) {
    if (current === undefined) return sections as Array<{ id: string; text: string }>
    return sections.filter((section) => section.id !== ACTIONS_PROMPT_SECTION_ID)
  }
  if (current !== undefined && current.text === text) return sections as Array<{ id: string; text: string }>
  const rest = sections.filter((section) => section.id !== ACTIONS_PROMPT_SECTION_ID)
  const insertAt = rest.findIndex((section) => section.id.startsWith('prompt.'))
  if (insertAt === -1) return [...rest, { id: ACTIONS_PROMPT_SECTION_ID, text }]
  return [...rest.slice(0, insertAt), { id: ACTIONS_PROMPT_SECTION_ID, text }, ...rest.slice(insertAt)]
}
