/**
 * MarkdownView heading indexing and streaming block splitting pure functions
 * (no components, no React deps).
 *
 * Block-splitting safety argument (CommonMark/GFM semantics):
 * - Split only at "blank line + non-list-continuation line": apart from link reference
 *   definitions / footnote definitions (document-level global context where a later definition
 *   can retroactively change how an earlier `[label]` renders) and raw HTML blocks (which may
 *   continue across blank lines), no CommonMark block construct survives a blank line —
 *   paragraph lazy continuation requires no blank line in between, list continuation across
 *   blanks requires indented or marker lines, and blockquote / setext / GFM tables all end at
 *   a blank line. Parsing both sides of a blank-line boundary independently is therefore
 *   equivalent to parsing the whole document;
 * - Top-level fenced code blocks are tracked line by line (a closing fence repeats the opening
 *   character and is at least as long); nothing splits inside a fence. A line whose opening info
 *   contains the fence character is not a legal opening per CommonMark (it is paragraph text),
 *   so it never enters fence tracking and cannot swallow later global definitions; when fence
 *   tracking loses credibility (non-blank text left of the content column) the whole document
 *   falls back — a prefix block that may have missed later global context is never kept;
 * - Every prefix block except the last is immune to later appends: appends only touch the
 *   document tail, and the only constructs that can retroactively change earlier rendering are
 *   global definitions and raw HTML (both gated to whole-document fallback), so a prefix block
 *   with unchanged content can safely reuse its parse result (memo hits).
 */

import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'

type MarkdownAstNode = {
  type?: string
  depth?: number
  children?: MarkdownAstNode[]
  data?: { hProperties?: Record<string, unknown> }
}

export interface HeadingIndicesOptions {
  /** Count of H1~H3 that appeared before this block (keeps numbering continuous across blocks during chunked rendering, matching whole-document rendering). */
  offset?: number
}

/** Add in-document location indexes to H1~H3 headings in the same order as outline-model (optional start offset). */
export function remarkHeadingIndices(options?: HeadingIndicesOptions) {
  const offset = options?.offset ?? 0
  return (tree: unknown): void => {
    let headingIndex = offset
    const visit = (node: MarkdownAstNode): void => {
      if (node.type === 'heading' && node.depth !== undefined && node.depth <= 3) {
        node.data ??= {}
        node.data.hProperties = {
          ...node.data.hProperties,
          'data-heading-index': headingIndex,
        }
        headingIndex += 1
      }
      for (const child of node.children ?? []) visit(child)
    }
    visit(tree as MarkdownAstNode)
  }
}

let astProcessor: ReturnType<typeof createMarkdownAstProcessor> | null = null

function createMarkdownAstProcessor() {
  // Same parser family as react-markdown (remark-parse + remark-gfm), read-only, no side effects
  return unified().use(remarkParse).use(remarkGfm)
}

/**
 * Count H1~H3 headings in a Markdown source (ATX and setext, counted at any container nesting
 * like blockquotes / lists; hash lines inside fenced or indented code blocks are literal content
 * and not counted). The count comes from the real AST, not a regex, matching the heading set
 * remarkHeadingIndices sees. Pure function: the same source always yields the same value.
 */
export function countHeadingsUpToH3(source: string): number {
  const processor = (astProcessor ??= createMarkdownAstProcessor())
  const tree = processor.runSync(processor.parse(source)) as unknown as MarkdownAstNode
  let count = 0
  const visit = (node: MarkdownAstNode): void => {
    if (node.type === 'heading' && node.depth !== undefined && node.depth <= 3) count += 1
    for (const child of node.children ?? []) visit(child)
  }
  visit(tree)
  return count
}

/** Container prefixes (blockquote / list markers / indentation): strip layer by layer before judging the line start. */
const CONTAINER_PREFIX_PATTERN = /^(?: {0,3}> ?| {1,8}|[-*+] |\d{1,9}[.\)] )/
const RAW_HTML_BLOCK_START_PATTERN = /^ {0,3}<[A-Za-z!?/]/
/** Three or more backticks/tildes (up to 3 leading spaces) form a fence-opening candidate. */
const FENCE_MARKER_PATTERN = /^ {0,3}(`{3,}|~{3,})/
/** After a blank line these lines still continue the previous block: indented content or new list marker lines (ordered included). */
const LIST_ITEM_CONTINUATION_PATTERN = /^(?:[ \t]|(?:[-*+]|\d{1,9}[.\)])(?:[ \t]|$))/

function stripContainerPrefixes(line: string): string {
  let rest = line
  for (;;) {
    const next = rest.replace(CONTAINER_PREFIX_PATTERN, '')
    if (next === rest) break
    rest = next
  }
  return rest
}

/**
 * Split streaming text into independently parseable blocks: joining all blocks in order always
 * equals the source; every block except the last is immune to later appends. Block boundaries
 * are a pure function of the text and fixed from the first frame (no length threshold: short
 * texts split too); appends only grow the last block and never reshape prefix blocks, so
 * code-block / plugin component identity stays stable across frames. When safety cannot be
 * proven, return a single-element array (whole-document rendering) — semantic correctness wins:
 * - the text contains CR (the scanner assumes \n line endings);
 * - any line starting with '[' after stripping container prefixes forces whole-document mode:
 *   it could open a reference/footnote definition — labels span lines and may contain escaped
 *   ']', so a line-oriented regex cannot safely decide the boundary; over-blocking ordinary
 *   inline links / indented code is acceptable (conservatively losing an optimization, not
 *   correctness);
 * - any raw HTML block start (may continue across blanks) forces whole-document mode;
 * - fence tracking losing credibility (non-blank left of the content column, the container may
 *   have ended) forces whole-document mode.
 * Not every text is guaranteed to be splittable.
 */
export function splitStreamingMarkdownBlocks(text: string): string[] {
  if (text.includes('\r')) return [text]

  const blocks: string[] = []
  let blockStart = 0
  let lineStart = 0
  let fenceChar: '`' | '~' | null = null
  let fenceLength = 0
  let fenceIndent = 0
  let afterBlankLine = false

  for (const line of text.split('\n')) {
    if (fenceChar !== null) {
      // Non-blank left of the fence content column: the container (list item etc.) may end
      // here; later swallowed global definitions may still appear — fall back to the whole
      // document instead of keeping prefix blocks.
      if (/\S/.test(line.slice(0, fenceIndent))) return [text]
      const marker = FENCE_MARKER_PATTERN.exec(line)?.[1] ?? ''
      if (marker !== '' && marker[0] === fenceChar && marker.length >= fenceLength && line.trim() === marker) {
        fenceChar = null
      }
    } else {
      if (line.trim() === '') {
        afterBlankLine = true
      } else {
        // Document-level global construct gate: a '[' line start after stripping container
        // prefixes might be a reference/footnote definition (labels span lines, ']' may be
        // escaped; line-level detection is unsafe); raw HTML blocks can continue across blank
        // lines. Both make block-wise parsing non-equivalent — render whole-document on sight
        // (same-shaped text inside a trusted fence is literal content and skipped).
        if (stripContainerPrefixes(line).startsWith('[')) return [text]
        if (RAW_HTML_BLOCK_START_PATTERN.test(line)) return [text]
        if (afterBlankLine && lineStart > blockStart && !LIST_ITEM_CONTINUATION_PATTERN.test(line)) {
          const candidate = text.slice(blockStart, lineStart)
          // A whitespace-only segment never becomes its own block (join-identity requires blanks to merge into the following block; leading whitespace has no segment semantics)
          if (candidate.trim() !== '') {
            blocks.push(candidate)
            blockStart = lineStart
          }
        }
        afterBlankLine = false
        const marker = FENCE_MARKER_PATTERN.exec(line)?.[1] ?? ''
        if (marker !== '') {
          // CommonMark: a backtick fence whose info contains a backtick is not a legal
          // opening — the line is paragraph text. It never enters fence tracking and later
          // lines keep receiving the global gate (otherwise later definitions get swallowed).
          const info = line.slice(line.indexOf(marker) + marker.length)
          if (!(marker[0] === '`' && info.includes('`'))) {
            fenceChar = marker[0] as '`' | '~'
            fenceLength = marker.length
            fenceIndent = line.indexOf(marker)
          }
        }
      }
    }
    lineStart += line.length + 1
  }
  blocks.push(text.slice(blockStart))
  return blocks
}
