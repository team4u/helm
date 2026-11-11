/**
 * markdown.codeBlock 扩展裁决纯函数（无组件，供单测直接验证）。
 *
 * - 按 language 精确匹配声明（languages 小写语言标识，与 protocol 校验同一字符集）；
 * - priority 降序稳定排序（同分保持贡献顺序）；取排序后首项；
 * - 未匹配（无插件注册 / 语言不在声明内 / 插件停用后贡献消失）返回 null，
 *   宿主回退普通代码块；不按插件 ID 或语言硬编码任何特判。
 */
import type { MarkdownCodeBlockSpec, PluginUiContribution } from '@helm/protocol'
import type { QualifiedUiSpec } from '../lib/types.js'

export function matchMarkdownCodeBlock(
  contributions: PluginUiContribution[],
  language: string,
): QualifiedUiSpec<MarkdownCodeBlockSpec> | null {
  const normalized = language.trim().toLowerCase()
  if (normalized === '') return null
  const matched: QualifiedUiSpec<MarkdownCodeBlockSpec>[] = []
  for (const item of contributions) {
    if (item.surface !== 'markdown.codeBlock') continue
    const spec = item.spec as Partial<MarkdownCodeBlockSpec> | undefined
    if (!spec || typeof spec !== 'object' || !Array.isArray(spec.languages)) continue
    if (!spec.languages.includes(normalized)) continue
    matched.push({ pluginId: item.pluginId, spec: spec as MarkdownCodeBlockSpec })
  }
  if (matched.length === 0) return null
  const stableSort = (arr: typeof matched): typeof matched => {
    const indexed = arr.map((item, index) => ({ item, index }))
    indexed.sort((a, b) => {
      const pa = a.item.spec.priority ?? 0
      const pb = b.item.spec.priority ?? 0
      if (pb !== pa) return pb - pa
      return a.index - b.index
    })
    return indexed.map((x) => x.item)
  }
  return stableSort(matched)[0] ?? null
}
