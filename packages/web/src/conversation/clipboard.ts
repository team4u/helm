/**
 * MarkdownView / 时间线共用的剪贴板与文本工具（纯 .ts，Fast Refresh 友好）。
 */

/** 长文本折叠：单行轨迹/代码块输出预览统一截断。 */
export function clip(text: string, max = 4000): string {
  return text.length > max ? `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）` : text
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
