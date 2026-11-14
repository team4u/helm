/**
 * MarkdownView 流式分块冻结渲染测试：
 * - 纯函数 splitStreamingMarkdownBlocks：join 恒等原文、边界安全性（行首 '[' 保守
 *   gate 覆盖多行/转义 label 的引用定义、raw HTML、围栏字符与长度、未闭合围栏、
 *   假围栏按段落处理、围栏失信心整篇、列表跨空行、blockquote/setext/表格）、
 *   append 前缀块稳定性（任意切割点、无长度阈值）；
 * - countHeadingsUpToH3：AST 计数（ATX/setext/容器嵌套计，代码块内不计数）；
 * - 组件级证据：真实浏览器复现的两个回归 fixture（多行 label 引用定义、跨 600 阈值
 *   代码块身份）、流式 append 已完成块不重复解析（插件组件渲染计数）、标题偏移跨块
 *   连续、streaming=false 完成切换零重挂载零重解析、最终 DOM 与整篇逐字节等价。
 */
import assert from 'node:assert/strict'
import test, { describe } from 'node:test'
import * as React from 'react'
import { useEffect } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginUiContribution } from '@helm/protocol'
import {
  countHeadingsUpToH3,
  remarkHeadingIndices,
  splitStreamingMarkdownBlocks,
} from '../src/conversation/markdown-model.js'
import { MarkdownView } from '../src/conversation/MarkdownView.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).React = React
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

// 插件 client 模块动态加载在测试环境无真实服务：拦截 client.mjs 请求返回种子 hash，
// 使 loadPluginClientModule 命中 seedPluginClientModule 的缓存条目确定性成功，
// 避免异步错误态以非确定时序覆盖插件组件。
const realFetch: typeof globalThis.fetch = globalThis.fetch.bind(globalThis)
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  if (url.includes('/client.mjs')) {
    return new Response('', { status: 200, headers: { 'x-helm-client-hash': 'seeded' } })
  }
  return realFetch(input, init)
}) as typeof globalThis.fetch

// ---------------------------------------------------------------------------
// 种子插件代码块：渲染计数 = 其所在块被重新 parse 的次数；挂载计数 = 实例身份。
// ---------------------------------------------------------------------------

const pluginStats = { mounts: 0, unmounts: 0, renders: 0 }

function CountingCodeBlock(props: { language?: string; code?: string }): React.ReactNode {
  pluginStats.renders += 1
  useEffect(() => {
    pluginStats.mounts += 1
    return () => {
      pluginStats.unmounts += 1
    }
  }, [])
  return React.createElement(
    'div',
    { className: 'counting-code', 'data-code': props.code ?? '' },
    `${props.language ?? ''}:${(props.code ?? '').length}`,
  )
}

seedPluginClientModule('builtin:test-stream-counter', 'index.tsx', { CountingCodeBlock })

function counterContribution(languages: string[]): PluginUiContribution {
  return {
    pluginId: 'builtin:test-stream-counter',
    surface: 'markdown.codeBlock',
    spec: { id: `counter-${languages.join('-')}`, languages, client: { module: 'index.tsx', export: 'CountingCodeBlock' } },
  }
}

const counterContributions: PluginUiContribution[] = [
  counterContribution(['cnt']),
  counterContribution(['typescript']),
]

function resetPluginStats(): void {
  pluginStats.mounts = 0
  pluginStats.unmounts = 0
  pluginStats.renders = 0
}

interface MountedView {
  host: HTMLElement
  render: (props: { text: string; streaming?: boolean }) => Promise<void>
  unmount: () => void
}

async function mountView(initial: { text: string; streaming?: boolean }): Promise<MountedView> {
  const store = makeTestStore({ uiContributions: counterContributions })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // 异步 act：冲洗净位内的插件模块加载状态更新，保证后续计数与 DOM 断言确定性
  const render = async (props: { text: string; streaming?: boolean }): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(
          HelmStoreContext.Provider,
          { value: store },
          React.createElement(MarkdownView, props),
        ),
      )
    })
  }
  await render(initial)
  return {
    host,
    render,
    unmount: () => {
      act(() => {
        root.unmount()
      })
      host.remove()
    },
  }
}

const longPara = (label: string): string => `${label}：${'这是用于超过整篇渲染阈值的流式正文段落'.repeat(12)}`

/** 构造含围栏/表格/列表/引用的富文档（无行首 '['、无 raw HTML，可安全分块）。 */
const richDoc = [
  '# 一级标题',
  longPara('段落一'),
  '## 二级标题',
  '| 列 | 值 |',
  '| --- | --- |',
  '| 甲 | 1 |',
  '| 乙 | 2 |',
  '',
  '1. 第一项',
  '',
  '2. 第二项',
  '',
  '- 嵌套列表甲',
  '  - 嵌套列表乙',
  '',
  '> 引用一行',
  '> 引用两行',
  '',
  'Setext 标题\n===',
  '',
  '#### 四级不编号',
  longPara('段落二'),
  '```cnt',
  'EQUIV-CODE',
  '```',
  '',
  '链接 [外链](https://example.com) 与 [产物](artifact:art-1)。',
  longPara('段落三'),
].join('\n')

/** 真实浏览器复现 fixture 1：多行 label 引用定义（streaming 与整篇 DOM 必须等价）。 */
const multiLineLabelFixture = `开头 [foo bar] 引用。\n\n${'普通文本。'.repeat(160)}\n\n[foo\nbar]: https://example.com/ref`

/** 真实浏览器复现 fixture 2：短文跨 600 阈值增长（代码块身份必须跨阈值保持）。 */
const thresholdFixtureInitial =
  '# 流式标题\n\n' +
  '这是一段固定的浏览器测试文本，用于验证长时间线的屏幕外渲染隔离、滚动和大纲定位。'.repeat(8) +
  '\n\n```typescript\nconst fixed = 42\n```\n\n## 第二个标题\n\n正在增长'
const thresholdFixtureAppend = '，继续输出直到最后一个段落完成。'.repeat(20)

function assertJoinRoundtrip(text: string, blocks: string[]): void {
  assert.equal(blocks.join(''), text, '块拼接必须恒等原文')
}

/** append 帧间前缀块稳定性：冻结块字符串逐字不变，末块只允许增长。 */
function assertAppendStable(before: string[], after: string[], label: string): void {
  const frozen = before.length - 1
  for (let i = 0; i < frozen; i++) {
    assert.equal(after[i], before[i], `${label}: 前缀块 ${i} 必须逐字稳定`)
  }
  assert.ok(
    after.length >= before.length && after[frozen]!.startsWith(before[frozen]!),
    `${label}: 末块只能原地增长`,
  )
}

// ---------------------------------------------------------------------------
// 1. 纯函数：splitStreamingMarkdownBlocks
// ---------------------------------------------------------------------------

describe('splitStreamingMarkdownBlocks 纯函数', { timeout: 60_000 }, () => {
  test('短文同样从首帧分块（无长度阈值）；含 CR 整篇', () => {
    assert.deepEqual(splitStreamingMarkdownBlocks('a\n\nb'), ['a\n\n', 'b'])
    assertJoinRoundtrip('a\n\nb', splitStreamingMarkdownBlocks('a\n\nb'))
    assert.deepEqual(splitStreamingMarkdownBlocks('短文无空行'), ['短文无空行'])
    const withCr = 'a\n\nb\r\n\nc'
    assert.deepEqual(splitStreamingMarkdownBlocks(withCr), [withCr])
  })

  test('段落空行切分且 join 恒等原文；无空行长文保持单块', () => {
    const doc = `${'甲'.repeat(300)}\n\n${'乙'.repeat(300)}\n\n${'丙'.repeat(100)}`
    const blocks = splitStreamingMarkdownBlocks(doc)
    assert.equal(blocks.length, 3)
    assertJoinRoundtrip(doc, blocks)
    const noBlank = `${'甲'.repeat(400)}\n${'乙'.repeat(400)}`
    assert.deepEqual(splitStreamingMarkdownBlocks(noBlank), [noBlank])
  })

  test('容器前缀剥离后行首 [ 即整篇：单行/多行/转义 label 定义、容器内嵌套、行内链接误伤', () => {
    const tail = `\n\n${'尾'.repeat(600)}`
    const gatedLines = [
      '[ref]: https://x',
      '  [ref]: https://x',
      '[^1]: 脚注',
      '> [ref]: https://x',
      '- [ref]: https://x',
      '[foo', // 多行 label 定义的首行（label 可跨行）
      '[a\\]b]: https://x', // label 含转义 ]
      '[普通链接](https://example.com) 行首误伤（保守可接受）',
    ]
    for (const gatedLine of gatedLines) {
      const doc = `${'首'.repeat(600)}\n\n${gatedLine}${tail}`
      const blocks = splitStreamingMarkdownBlocks(doc)
      assert.equal(blocks.length, 1, `${gatedLine} 必须触发整篇回退`)
      assertJoinRoundtrip(doc, blocks)
    }
    // 跟踪中的顶层围栏内同形文本是字面内容：不触发回退，围栏整体一块
    const fenceDoc = `${'首'.repeat(590)}\n\n\`\`\`\n[ref]: literal\n\`\`\`\n\n${'尾'.repeat(100)}`
    const fenceBlocks = splitStreamingMarkdownBlocks(fenceDoc)
    assert.ok(fenceBlocks.length >= 3, '围栏内外应正常分块')
    assertJoinRoundtrip(fenceDoc, fenceBlocks)
  })

  test('假围栏（info 含反引号）按段落处理：不吞后续行，定义 gate 照常生效', () => {
    // 无定义：假围栏行是段落文本，正常分块（优化保留）
    const clean = `${'首'.repeat(590)}\n\n\`\`\`info\`x\n假围栏段落\n\n${'尾'.repeat(100)}`
    const cleanBlocks = splitStreamingMarkdownBlocks(clean)
    assert.ok(cleanBlocks.length >= 3, '非法 info 的反引号行按段落处理，仍分块')
    assertJoinRoundtrip(clean, cleanBlocks)

    // 有后置定义：gate 必须命中（旧实现会把该行当真围栏吞掉定义行）
    const withDef = `${'首'.repeat(590)}\n\n\`\`\`info\`x\n假围栏段落\n\n[ref]: https://example.com/z\n\n${'尾'.repeat(100)}`
    assert.equal(splitStreamingMarkdownBlocks(withDef).length, 1, '假围栏不得吞掉后续定义行')
  })

  test('围栏跟踪失信心（内容列左侧非空白）整篇回退而非保留前缀', () => {
    const doc = `- 项\n  \`\`\`\ncode\nx 浅缩进内容\n\`\`\`\n\n[ref]: https://example.com/d\n\n${'尾'.repeat(100)}`
    assert.equal(splitStreamingMarkdownBlocks(doc).length, 1, '容器内围栏失信心必须整篇（后文定义不可漏）')
  })

  test('raw HTML 块起始行触发整篇回退；行内 HTML 不受影响', () => {
    const htmlDoc = `${'首'.repeat(600)}\n\n<div>\n内容\n</div>\n\n${'尾'.repeat(100)}`
    assert.equal(splitStreamingMarkdownBlocks(htmlDoc).length, 1)
    const inlineDoc = `${'首'.repeat(600)} 换行后 <br> 标签\n\n${'尾'.repeat(100)}`
    assert.ok(splitStreamingMarkdownBlocks(inlineDoc).length >= 2, '行内 <br> 不阻断分块')
  })

  test('有序/无序列表跨空行保持单块；缩进延续行不切分', () => {
    const ordered = `1. 第一项\n\n2. 第二项\n\n3. 第三项\n\n${'尾'.repeat(600)}`
    const orderedBlocks = splitStreamingMarkdownBlocks(ordered)
    assert.equal(orderedBlocks.length, 2, '有序列表必须是一个块，只有尾段独立')
    assert.match(orderedBlocks[0]!, /^1\. 第一项/)
    assertJoinRoundtrip(ordered, orderedBlocks)

    const bullet = `- 项甲\n  缩进延续\n\n- 项乙\n\n    项乙代码延续\n\n${'尾'.repeat(600)}`
    const bulletBlocks = splitStreamingMarkdownBlocks(bullet)
    assert.equal(bulletBlocks.length, 2)
    assertJoinRoundtrip(bullet, bulletBlocks)

    const indented = `${'段落'.repeat(60)}\n\n    缩进代码延续不切分\n\n${'尾'.repeat(600)}`
    assert.equal(splitStreamingMarkdownBlocks(indented).length, 2)
  })

  test('blockquote 被空行真实终结为两块；lazy 连续行无空行不产生边界', () => {
    const quoted = `> 引用甲\n\n> 引用乙\n\n${'尾'.repeat(600)}`
    const blocks = splitStreamingMarkdownBlocks(quoted)
    assert.equal(blocks.length, 3)
    assert.match(blocks[0]!, /^> 引用甲/)
    assert.match(blocks[1]!, /^> 引用乙/)
    assertJoinRoundtrip(quoted, blocks)
    const lazy = `> 引用甲\n延续行\n\n${'尾'.repeat(600)}`
    assert.equal(splitStreamingMarkdownBlocks(lazy).length, 2)
  })

  test('setext 下划线与标题行保持同块；空行后的 ===/--- 是独立段落/分隔线', () => {
    const doc = `标题甲\n===\n\n${'尾段'.repeat(300)}\n\n---\n\n${'末段'.repeat(100)}`
    const blocks = splitStreamingMarkdownBlocks(doc)
    assert.equal(blocks[0]!.replace(/\n+$/, ''), '标题甲\n===', 'setext 与其标题行同块（含尾随分隔空白）')
    assert.ok(blocks.length >= 3)
    assertJoinRoundtrip(doc, blocks)
  })

  test('GFM 表格整体单块，表格前后正常切分', () => {
    const doc = `${'首'.repeat(600)}\n\n| 列 | 值 |\n| --- | --- |\n| 甲 | 1 |\n| 乙 | 2 |\n\n${'尾'.repeat(100)}`
    const blocks = splitStreamingMarkdownBlocks(doc)
    assert.equal(blocks.length, 3)
    assert.match(blocks[1]!, /^\| 列 \| 值 \|/)
    assertJoinRoundtrip(doc, blocks)
  })

  test('围栏：闭栏字符一致且长度足够才闭合；未闭合归并为尾块', () => {
    // 反引号闭栏长度不足：不闭合，其后全部并入最后一块
    const shortClose = `${'首'.repeat(590)}\n\n\`\`\`\`\ncode\n\`\`\`\n假闭合后的内容\n\n更多行`
    const blocks = splitStreamingMarkdownBlocks(shortClose)
    assert.equal(blocks.length, 2)
    assertJoinRoundtrip(shortClose, blocks)

    // 波浪与反引号互不闭栏
    const cross = `${'首'.repeat(590)}\n\n~~~\ncode\n\`\`\`\ncode2\n~~~\n\n${'尾'.repeat(100)}`
    const crossBlocks = splitStreamingMarkdownBlocks(cross)
    assert.ok(crossBlocks.length >= 3)
    assert.match(crossBlocks[1]!, /^~~~/)
    assert.ok(crossBlocks[1]!.includes('code2'), '交叉围栏内全部内容留在同一块')
    assertJoinRoundtrip(cross, crossBlocks)

    // 闭栏允许尾随空白
    const trailing = `${'首'.repeat(590)}\n\n\`\`\`\ncode\n\`\`\`   \n\n${'尾'.repeat(100)}`
    assert.equal(splitStreamingMarkdownBlocks(trailing).length, 3)

    // 未闭合围栏到文档末尾：尾块包含其后一切
    const unclosed = `${'首'.repeat(590)}\n\n\`\`\`js\ncode line\n\nstill inside\n`
    const unclosedBlocks = splitStreamingMarkdownBlocks(unclosed)
    assert.equal(unclosedBlocks.length, 2)
    assertJoinRoundtrip(unclosed, unclosedBlocks)
  })

  test('富文档 append 帧任意切割点下前缀块逐字稳定（含切在围栏/段落中间，无长度阈值相变）', () => {
    const fractions = [0.2, 0.35, 0.5, 0.62, 0.75, 0.85, 0.93, 1]
    const frames = fractions.map((f) => richDoc.slice(0, Math.max(1, Math.floor(richDoc.length * f))))
    let prev = splitStreamingMarkdownBlocks(frames[0]!)
    for (let i = 1; i < frames.length; i++) {
      const next = splitStreamingMarkdownBlocks(frames[i]!)
      assertAppendStable(prev, next, `帧 ${i}`)
      assertJoinRoundtrip(frames[i]!, next)
      prev = next
    }
    assert.equal(prev.length, 5, '富文档最终切成 5 块（列表延续并块 + 引用 + setext + 围栏 + 尾段）')
    for (const frame of frames) {
      assertJoinRoundtrip(frame, splitStreamingMarkdownBlocks(frame))
    }
  })

  test('文档以空行开头：空白并入首块，join 恒等且无空白首块', () => {
    const doc = `\n\n${'正文'.repeat(400)}\n\n${'尾'.repeat(100)}`
    const blocks = splitStreamingMarkdownBlocks(doc)
    assert.equal(blocks.length, 2)
    assert.ok(blocks[0]!.trimStart().startsWith('正文'), '前导空白并入首块')
    assertJoinRoundtrip(doc, blocks)
  })
})

// ---------------------------------------------------------------------------
// 2. 纯函数：标题计数（AST，非正则）
// ---------------------------------------------------------------------------

describe('countHeadingsUpToH3 与 remarkHeadingIndices', { timeout: 60_000 }, () => {
  test('countHeadingsUpToH3：ATX/setext/容器嵌套均计数，H4+ 与代码块内不计数', () => {
    assert.equal(countHeadingsUpToH3('## 甲\n\n正文\n\n# 乙\n\n#### 丙\n\n##### 丁'), 2)
    assert.equal(countHeadingsUpToH3('Setext 一级\n==='), 1)
    assert.equal(countHeadingsUpToH3('Setext 二级\n---'), 1)
    assert.equal(countHeadingsUpToH3('> 引用中的标题\n>\n> ### 引用内三级'), 1, 'blockquote 内标题计数')
    assert.equal(countHeadingsUpToH3('- 列表项\n  - ## 嵌套列表内标题'), 1, '列表内标题计数')
    assert.equal(countHeadingsUpToH3('```\n# 代码内井号不是标题\n```\n\n## 真标题'), 1, '围栏内不计数')
    assert.equal(countHeadingsUpToH3('    # 缩进代码内不计数\n\n### 真标题'), 1, '缩进代码内不计数')
    assert.equal(countHeadingsUpToH3(''), 0)
  })

  test('remarkHeadingIndices：索引从 offset 起连续编号 H1~H3，H4+ 跳过', () => {
    const tree = {
      type: 'root',
      children: [
        { type: 'heading', depth: 2, children: [] },
        { type: 'heading', depth: 4, children: [] },
        { type: 'heading', depth: 1, children: [] },
        { type: 'paragraph', children: [] },
      ],
    }
    remarkHeadingIndices({ offset: 5 })(tree)
    assert.equal((tree.children[0] as { data?: { hProperties?: Record<string, unknown> } }).data?.hProperties?.['data-heading-index'], 5)
    assert.equal((tree.children[1] as { data?: { hProperties?: Record<string, unknown> } }).data, undefined, 'H4 不编号')
    assert.equal((tree.children[2] as { data?: { hProperties?: Record<string, unknown> } }).data?.hProperties?.['data-heading-index'], 6)
  })
})

// ---------------------------------------------------------------------------
// 3. 组件级：真实浏览器复现 fixture
// ---------------------------------------------------------------------------

describe('MarkdownView 真实浏览器复现 fixture', { timeout: 60_000 }, () => {
  test('多行 label 引用定义：streaming 与整篇 DOM 逐字节等价，链接正确解析', async () => {
    resetPluginStats()
    const streamView = await mountView({ text: multiLineLabelFixture, streaming: true })
    assert.equal(
      streamView.host.querySelectorAll('a[href="https://example.com/ref"]').length,
      1,
      'streaming 实例必须解析出引用链接（整篇参考实例为 1 个 a 元素）',
    )
    const wholeView = await mountView({ text: multiLineLabelFixture })
    assert.equal(streamView.host.innerHTML, wholeView.host.innerHTML, 'streaming 与整篇 innerHTML 必须一致')
    streamView.unmount()
    wholeView.unmount()
  })

  test('多行 label 定义后置到达：冻结前缀诚实重建，最终 DOM 等价整篇', async () => {
    resetPluginStats()
    // 定义尾部剥除后的干净前缀（[foo bar] 为字面文本，正常分块冻结）
    const cleanPrefix = multiLineLabelFixture.slice(
      0,
      multiLineLabelFixture.lastIndexOf('\n\n[foo\nbar]: https://example.com/ref'),
    )
    const view = await mountView({ text: cleanPrefix, streaming: true })
    assert.equal(view.host.querySelectorAll('a[href="https://example.com/ref"]').length, 0, '定义到达前为字面文本')

    await view.render({ text: multiLineLabelFixture, streaming: true })
    assert.equal(view.host.querySelectorAll('a[href="https://example.com/ref"]').length, 1, '定义到达后引用正确解析')
    const wholeView = await mountView({ text: multiLineLabelFixture })
    assert.equal(view.host.innerHTML, wholeView.host.innerHTML, '定义回退整篇后与参考实例逐字节等价')
    view.unmount()
    wholeView.unmount()
  })

  test('短文跨 600 阈值增长：代码块 DOM 身份与挂载计数跨阈值保持', async () => {
    resetPluginStats()
    assert.ok(thresholdFixtureInitial.length <= 600, 'fixture 初始必须处于阈值内')
    assert.ok(
      thresholdFixtureInitial.length + thresholdFixtureAppend.length > 600,
      '追加后必须跨过阈值',
    )
    const view = await mountView({ text: thresholdFixtureInitial, streaming: true })
    const codeNode = view.host.querySelector('[data-code="const fixed = 42"]')
    assert.ok(codeNode !== null, '初始帧代码块已由插件渲染')
    assert.equal(pluginStats.mounts, 1)
    const rendersBeforeAppend = pluginStats.renders

    // 分步追加（逐步跨过 600 阈值）：已渲染代码块绝不因块结构变化重挂载
    for (let step = 1; step <= 4; step++) {
      await view.render({
        text: thresholdFixtureInitial + thresholdFixtureAppend.slice(0, Math.floor((thresholdFixtureAppend.length * step) / 4)),
        streaming: true,
      })
      assert.equal(pluginStats.mounts, 1, `第 ${step} 步追加后代码块保持身份`)
      assert.ok(view.host.querySelector('[data-code="const fixed = 42"]') === codeNode, 'DOM 节点身份保持')
    }
    assert.equal(pluginStats.renders, rendersBeforeAppend, '代码块所在前缀块零重复解析')

    const finalText = thresholdFixtureInitial + thresholdFixtureAppend
    const wholeView = await mountView({ text: finalText })
    assert.equal(view.host.innerHTML, wholeView.host.innerHTML, '跨阈值增长最终 DOM 与整篇等价')
    view.unmount()
    wholeView.unmount()
  })
})

// ---------------------------------------------------------------------------
// 4. 组件级：流式冻结、身份保持、完成切换与最终 DOM 等价
// ---------------------------------------------------------------------------

describe('MarkdownView 流式分块渲染', { timeout: 60_000 }, () => {
  test('append 时已完成代码块不重复解析、不卸载（插件组件渲染/挂载计数）', async () => {
    resetPluginStats()
    const paraTail = longPara('冻结后续段')
    const f1 = [longPara('第一段'), '```cnt\nCODE-A\n```', longPara('第二段'), longPara('第三段')].join('\n\n')
    const view = await mountView({ text: f1, streaming: true })
    assert.equal(pluginStats.mounts, 1, '代码块插件组件挂载一次')
    const rendersAfterF1 = pluginStats.renders

    await view.render({ text: `${f1}\n\n${paraTail}`, streaming: true })
    assert.equal(pluginStats.renders, rendersAfterF1, '前缀冻结后代码块所在块零重复解析')
    assert.equal(pluginStats.mounts, 1, '代码块组件保持身份')
    assert.ok(view.host.textContent!.includes('冻结后续段'))

    await view.render({ text: `${f1}\n\n${paraTail}\n\n${longPara('再追加段')}`, streaming: true })
    assert.equal(pluginStats.renders, rendersAfterF1)
    assert.equal(pluginStats.mounts, 1)
    view.unmount()
  })

  test('标题偏移跨块连续：与整篇渲染的 data-heading-index 完全一致', async () => {
    resetPluginStats()
    const doc = [
      '## 标题甲',
      longPara('段落一'),
      '### 标题乙',
      longPara('段落二'),
      'Setext 大标题\n===',
      '#### 四级不编号',
      longPara('段落三'),
      '## 标题戊',
      longPara('段落四'),
    ].join('\n\n')
    const splitView = await mountView({ text: doc, streaming: true })
    const wholeView = await mountView({ text: doc })
    assert.equal(splitView.host.innerHTML, wholeView.host.innerHTML, '分块与整篇最终 DOM 逐字节等价（含 data-heading-index）')
    const h2first = splitView.host.querySelector('[data-heading-index="0"]')
    const h3 = splitView.host.querySelector('[data-heading-index="1"]')
    const setext = splitView.host.querySelector('[data-heading-index="2"]')
    const h2last = splitView.host.querySelector('[data-heading-index="3"]')
    assert.ok(h2first && h2first.tagName === 'H2' && h2first.textContent === '标题甲')
    assert.ok(h3 && h3.tagName === 'H3')
    assert.ok(setext && setext.tagName === 'H1' && setext.textContent === 'Setext 大标题')
    assert.ok(h2last && h2last.tagName === 'H2' && h2last.textContent === '标题戊')
    assert.equal(splitView.host.querySelectorAll('[data-heading-index]').length, 4, 'H4 不产生编号')
    splitView.unmount()
    wholeView.unmount()
  })

  test('完成切换 streaming=false：零重挂载、零重解析，最终 DOM 等价整篇', async () => {
    resetPluginStats()
    const fractions = [0.25, 0.45, 0.6, 0.75, 0.9, 1]
    const frames = fractions.map((f) => richDoc.slice(0, Math.max(1, Math.floor(richDoc.length * f))))
    const view = await mountView({ text: frames[0]!, streaming: true })
    for (let i = 1; i < frames.length; i++) await view.render({ text: frames[i]!, streaming: true })
    const htmlAfterStream = view.host.innerHTML
    const rendersAfterStream = pluginStats.renders
    const mountsAfterStream = pluginStats.mounts

    // 同文完成：不切回整篇单块（避免代码块/插件 remount），也不触发任何重解析
    await view.render({ text: frames[frames.length - 1]!, streaming: false })
    assert.equal(view.host.innerHTML, htmlAfterStream, '完成帧 DOM 必须与最后一帧流式 DOM 完全一致')
    assert.equal(pluginStats.renders, rendersAfterStream, '完成切换不得重解析任何块')
    assert.equal(pluginStats.mounts, mountsAfterStream, '完成切换不得重挂载插件组件')

    // 尾部追加的完成帧：前缀冻结，只有新尾块更新
    const finalText = `${frames[frames.length - 1]!}\n\n${longPara('完成收尾段')}`
    await view.render({ text: finalText, streaming: false })
    assert.equal(pluginStats.mounts, mountsAfterStream, '追加收尾不重挂载')
    assert.ok(view.host.textContent!.includes('完成收尾段'))

    // 最终 DOM 与全新整篇实例逐字节等价（插件组件身份：全新实例恰好多一次挂载）
    const wholeView = await mountView({ text: finalText })
    assert.equal(view.host.innerHTML, wholeView.host.innerHTML, '完成帧最终 DOM 与整篇渲染等价')
    assert.equal(pluginStats.mounts, mountsAfterStream + 1, '等价对照的整篇实例各自恰好一次挂载')
    view.unmount()
    wholeView.unmount()
  })

  test('后文引用定义改变前文链接：诚实回退整篇并正确渲染链接', async () => {
    resetPluginStats()
    const paraWithRef = `第一段开头 详见 [资料] 说明 ${'正文'.repeat(300)}`
    const f1 = [paraWithRef, '```cnt\nCODE-B\n```', longPara('第二段'), longPara('第三段')].join('\n\n')
    const view = await mountView({ text: f1, streaming: true })
    assert.ok(view.host.textContent!.includes('[资料]'), '无定义时 [资料] 按字面渲染')
    assert.equal(view.host.querySelector('a[href="https://example.com/x"]'), null)
    const mountsAfterF1 = pluginStats.mounts

    const f2 = `${f1}\n\n[资料]: https://example.com/x\n\n${longPara('定义后段落')}`
    await view.render({ text: f2, streaming: true })
    const link = view.host.querySelector('a[href="https://example.com/x"]')
    assert.ok(link !== null, '定义到达后 [资料] 必须解析为链接（整篇回退）')
    assert.equal(link!.textContent, '资料')
    assert.equal(pluginStats.mounts, mountsAfterF1 + 1, '整篇回退是真实重建（诚实重挂载）')
    view.unmount()
  })

  test('正文整体替换：缓存重建诚实生效；保留公共前缀时公共块身份保持', async () => {
    resetPluginStats()
    const f1 = [longPara('第一段'), '```cnt\nCODE-C\n```', longPara('第二段'), longPara('第三段')].join('\n\n')
    const view = await mountView({ text: f1, streaming: true })
    assert.equal(pluginStats.mounts, 1)
    const rendersAfterF1 = pluginStats.renders

    // 替换但保留到代码块为止的公共前缀：公共前缀块 memo 命中，代码块身份保持
    const replaced = [longPara('第一段'), '```cnt\nCODE-C\n```', longPara('全新第三段'), '', longPara('全新第四段')].join('\n\n')
    await view.render({ text: replaced, streaming: true })
    assert.equal(pluginStats.mounts, 1, '公共前缀块内容不变：代码块不重挂载')
    assert.equal(pluginStats.renders, rendersAfterF1, '公共前缀块不重复解析')
    assert.ok(view.host.textContent!.includes('全新第三段'))
    assert.ok(!view.host.textContent!.includes('第二段：'))

    // 无公共前缀的整体替换：受影响块重解析，内容诚实亚换；同 key 同位置的代码块
    // 经 React 协调原位更新（身份保持，比强制重挂载更好地保留插件状态）
    const doc2 = `${longPara('完全不同开头的正文')}\n\n\`\`\`cnt\nCODE-D\n\`\`\`\n\n${longPara('完全不同结尾')}`
    await view.render({ text: doc2, streaming: true })
    assert.ok(pluginStats.renders > rendersAfterF1, '受影响块重新解析')
    assert.ok(view.host.querySelector('[data-code="CODE-D"]') !== null, '新代码内容诚实呈现')
    assert.ok(view.host.querySelector('[data-code="CODE-C"]') === null, '旧代码内容不再出现')
    view.unmount()
  })

  test('长 append 样例：冻结后 DOM 节点身份与插件渲染计数保持（性能证据）', async () => {
    resetPluginStats()
    const parts: string[] = []
    for (let i = 1; i <= 24; i++) {
      parts.push(longPara(`第${i}段`))
      if (i === 4 || i === 12 || i === 20) parts.push(`\`\`\`cnt\nCODE-${i}\n\`\`\``)
    }
    const fullDoc = parts.join('\n\n')
    // 单调递增帧序列（真实流式 append 形态），含 CODE-12 完成点前后与若干段中切割
    const fence12At = fullDoc.indexOf('```cnt\nCODE-12')
    const afterFence12 = fullDoc.indexOf('\n\n', fence12At + 10) + 2
    const cuts = [0.08, 0.16, 0.24, 0.32, 0.44, afterFence12 / fullDoc.length, 0.56, 0.64, 0.72, 0.8, 0.9, 1].sort((a, b) => a - b)
    const frames: string[] = cuts.map((c) => fullDoc.slice(0, Math.max(1, Math.floor(fullDoc.length * c))))

    const view = await mountView({ text: frames[0]!, streaming: true })
    let code12Node: Element | null = null
    for (const frame of frames.slice(1)) {
      await view.render({ text: frame, streaming: true })
      const node = view.host.querySelector('[data-code="CODE-12"]')
      if (node !== null && code12Node === null) code12Node = node
    }
    assert.ok(code12Node !== null, 'CODE-12 代码块必须已渲染')
    assert.ok(view.host.querySelector('[data-code="CODE-12"]') === code12Node, '冻结块 DOM 节点身份跨帧保持（未卸载重建）')
    const rendersWhenFrozen = pluginStats.renders
    await view.render({ text: fullDoc, streaming: false })
    assert.equal(pluginStats.renders, rendersWhenFrozen, '冻结后（含完成切换）零重复解析')
    assert.equal(pluginStats.mounts, 3, '三个 cnt 代码块各自恰好一次挂载')
    assert.ok(pluginStats.renders <= 9, `渲染计数远小于帧数×代码块数（实际 ${pluginStats.renders} 次 / ${frames.length} 帧）`)
    view.unmount()
  })
})
