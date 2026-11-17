/**
 * Pure line-splitting helpers for SyntaxCode line-annotated file preview mode
 * (separate from .tsx to obey Fast Refresh).
 */

export interface CodeLineRange {
  start: number
  end?: number
}

const SPAN_TAG_RE = /<(\/?)span\b[^>]*>/gi

/** Split source code into display lines (dropping one trailing newline if present). */
export function splitCodeLines(code: string): string[] {
  if (code === '') return ['']
  const trimmed = code.endsWith('\n') ? code.slice(0, -1) : code
  return trimmed.split('\n')
}

/**
 * Split highlight.js HTML into per-line balanced HTML fragments so multi-line
 * spans (comments, template strings) remain valid inside individual line rows.
 */
export function splitHighlightedHtmlLines(html: string, dropTrailingEmpty: boolean): string[] {
  const rawLines = html.split('\n')
  if (dropTrailingEmpty && rawLines.length > 1 && rawLines[rawLines.length - 1] === '') {
    rawLines.pop()
  }
  const openTags: string[] = []
  return rawLines.map((segment) => {
    const prefix = openTags.join('')
    SPAN_TAG_RE.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = SPAN_TAG_RE.exec(segment)) !== null) {
      if (match[1] === '/') {
        openTags.pop()
      } else {
        openTags.push(match[0])
      }
    }
    const suffix = openTags.length > 0 ? '</span>'.repeat(openTags.length) : ''
    return `${prefix}${segment}${suffix}`
  })
}
