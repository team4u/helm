/**
 * MarkdownView 标题索引与流式分块纯函数（无组件、无 React 依赖）。
 *
 * 分块安全性论证（CommonMark/GFM 语义）：
 * - 只在「空行 + 非列表延续行」处切分：除链接引用定义 / 脚注定义（文档级全局上下文，
 *   后置定义可回溯改变前文 `[标签]` 的渲染）与 raw HTML 块（可跨空行延续）外，
 *   CommonMark 的任何块级构造都无法跨越空行延续——段落 lazy continuation 要求中间无空行、
 *   列表跨空行延续时后续行必须是缩进或列表标记行、blockquote / setext / GFM 表格
 *   均被空行终结。因此空行边界两侧各自独立解析与整篇解析等价；
 * - 顶层围栏代码块逐行跟踪（闭栏字符与开栏一致且长度不小于开栏），围栏内部不切分；
 *   开栏 info 含围栏字符的行按 CommonMark 不是合法开栏（是段落文本），不进入围栏跟踪，
 *   因此不会吞掉后续全局定义；围栏跟踪失去可信度时（内容列左侧出现非空白）整篇回退，
 *   绝不保留可能漏掉后文全局上下文的前缀块；
 * - 除最后一块外的全部前缀块对后续 append 免疫：append 只作用于文档尾部，唯一能回溯
 *   改变前文渲染的构造是全局定义与 raw HTML（均被 gate 整篇回退），因此前缀块一旦
 *   内容不变，其解析结果可安全复用（memo 命中）。
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
  /** 本块之前文档已出现的 H1~H3 数量（分块渲染时保证跨块连续编号，与整篇一致）。 */
  offset?: number
}

/** 为 H1~H3 标题添加与 outline-model 相同顺序的文档内定位索引（可选起始偏移）。 */
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
  // 与 react-markdown 同族解析器（remark-parse + remark-gfm），只读解析、无副作用
  return unified().use(remarkParse).use(remarkGfm)
}

/**
 * 统计一段 Markdown 源内 H1~H3 数量（ATX 与 setext、blockquote / 列表等任意容器嵌套内
 * 均计数；围栏与缩进代码块内的井号行是字面内容不计数）。计数来自真实 AST 而非正则，
 * 与 remarkHeadingIndices 看到的标题集合一致。纯函数：同源串恒同值。
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

/** 容器前缀（blockquote / 列表标记 / 缩进）：逐层剥离后判定行首字符。 */
const CONTAINER_PREFIX_PATTERN = /^(?: {0,3}> ?| {1,8}|[-*+] |\d{1,9}[.\)] )/
const RAW_HTML_BLOCK_START_PATTERN = /^ {0,3}<[A-Za-z!?/]/
/** 3 个及以上反引号/波浪线（前导至多 3 空格）构成围栏开栏候选。 */
const FENCE_MARKER_PATTERN = /^ {0,3}(`{3,}|~{3,})/
/** 空行之后，这些行仍延续前一块：缩进内容或新的列表标记行（含有序标记）。 */
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
 * 把流式正文切成可独立解析的块：所有块按序拼接恒等于原文；除最后一块外均对后续
 * append 免疫。块边界是正文的纯函数且从首帧就确定（无长度阈值：短文同样分块），
 * append 只增长末块、永不重塑前缀块，代码块/插件组件身份跨帧稳定。无法证明安全时
 * 返回单元素数组（整篇渲染），语义正确优先：
 * - 含 CR（扫描器假定 \n 行尾）；
 * - 容器前缀剥离后任一行以 '[' 开头即整篇：该行可能是引用/脚注定义的开端——定义
 *   label 可跨行、可含转义 ']'，逐行正则无法安全判定定义边界；宁可把行首为普通
 *   行内链接 / 缩进代码的行一并误伤（保守损失分块优化，不损失正确性）；
 * - 任一行是 raw HTML 块起始（可跨空行延续）即整篇；
 * - 围栏跟踪失去可信度（内容列左侧出现非空白，所在容器可能已结束）即整篇。
 * 不承诺所有文本都能分块。
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
      // 围栏内容列左侧出现非空白：所在容器（列表项等）可能在此结束，围栏跟踪不再可信；
      // 后文仍可能出现被吞掉的全局定义，必须整篇回退而不是保留前缀块。
      if (/\S/.test(line.slice(0, fenceIndent))) return [text]
      const marker = FENCE_MARKER_PATTERN.exec(line)?.[1] ?? ''
      if (marker !== '' && marker[0] === fenceChar && marker.length >= fenceLength && line.trim() === marker) {
        fenceChar = null
      }
    } else {
      if (line.trim() === '') {
        afterBlankLine = true
      } else {
        // 文档级全局构造 gate：容器前缀剥离后行首 '[' 可能是引用/脚注定义（label 可跨行、
        // 可转义 ']'，行级判别不安全）；raw HTML 块可跨空行延续。二者都使分块解析不等价，
        // 出现即整篇渲染（受信围栏内的同形文本是字面内容，跳过）。
        if (stripContainerPrefixes(line).startsWith('[')) return [text]
        if (RAW_HTML_BLOCK_START_PATTERN.test(line)) return [text]
        if (afterBlankLine && lineStart > blockStart && !LIST_ITEM_CONTINUATION_PATTERN.test(line)) {
          const candidate = text.slice(blockStart, lineStart)
          // 空白段不单独成块（join 恒等要求空白始终并入后块，片段解析前导空白无语义）
          if (candidate.trim() !== '') {
            blocks.push(candidate)
            blockStart = lineStart
          }
        }
        afterBlankLine = false
        const marker = FENCE_MARKER_PATTERN.exec(line)?.[1] ?? ''
        if (marker !== '') {
          // CommonMark：反引号开栏的 info 含反引号即不是合法开栏，该行是段落文本——
          // 不进入围栏跟踪，后续行照常接受全局 gate（否则会吞掉后文定义）。
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
