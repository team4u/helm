/**
 * 工具展开体数据层测试：
 * 1. head/tail 行切片（write/read 预览与 bash 尾部折叠的计数契约）；
 * 2. inputKvEntries 键值归一（短值内联、多行/长串/嵌套值块状、字符串入参）；
 * 3. write/read/bash 展示数据提取（字段只做类型收窄，缺失即 undefined；
 *    read spill 不做源码高亮、write 不伪造新建/覆盖判断）；
 * 4. toolRowStats 单行统计：edit 已应用/待执行、write 行数、插件接管不给统计。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  asRecord,
  bashBodyData,
  headLines,
  inputKvEntries,
  prettyJson,
  readBodyData,
  tailLines,
  toolRowStats,
  writeBodyData,
} from '../src/conversation/tool-body-model.js'
import type { ToolTrace } from '../src/conversation/timeline-model.js'

function trace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { key: 't', toolName: 'bash', status: 'done', isError: false, ...overrides }
}

// ---------------------------------------------------------------------------
// 行切片
// ---------------------------------------------------------------------------

test('headLines：保留前 N 行并给出总行数与剩余行数', { timeout: 60_000 }, () => {
  const slice = headLines('l1\nl2\nl3\nl4', 2)
  assert.equal(slice.visible, 'l1\nl2')
  assert.equal(slice.totalLines, 4)
  assert.equal(slice.hiddenLines, 2)
  const all = headLines('l1\nl2', 12)
  assert.equal(all.hiddenLines, 0)
  assert.equal(all.visible, 'l1\nl2')
})

test('tailLines：保留最后 N 行并给出被折叠的前置行数', { timeout: 60_000 }, () => {
  const slice = tailLines('l1\nl2\nl3\nl4', 2)
  assert.equal(slice.visible, 'l3\nl4')
  assert.equal(slice.hiddenLines, 2)
  const all = tailLines('l1', 8)
  assert.equal(all.hiddenLines, 0)
})

// ---------------------------------------------------------------------------
// 键值归一
// ---------------------------------------------------------------------------

test('inputKvEntries：短单行值内联，多行/长串/嵌套值块状', { timeout: 60_000 }, () => {
  const entries = inputKvEntries({
    path: '/a.ts',
    note: 'line1\nline2',
    long: 'x'.repeat(200),
    opts: { a: 1 },
  })
  assert.equal(entries.length, 4)
  assert.deepEqual(entries[0], { key: 'path', value: '/a.ts', block: false })
  assert.equal(entries[1]!.block, true)
  assert.equal(entries[2]!.block, true)
  assert.equal(entries[3]!.block, true)
  assert.equal(entries[3]!.value, '{\n  "a": 1\n}')
  // 字符串入参与空入参
  assert.deepEqual(inputKvEntries('raw'), [{ key: 'input', value: 'raw', block: false }])
  assert.deepEqual(inputKvEntries(undefined), [])
  assert.equal(asRecord('x'), undefined)
})

test('prettyJson：异常输入不抛出', { timeout: 60_000 }, () => {
  assert.equal(prettyJson({ a: 1 }), '{\n  "a": 1\n}')
  const cyclic: Record<string, unknown> = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => prettyJson(cyclic))
})

// ---------------------------------------------------------------------------
// write / read / bash 数据提取
// ---------------------------------------------------------------------------

test('writeBodyData：路径语言与行数来自入参；bytesWritten 仅在成功时取用', { timeout: 60_000 }, () => {
  const input = { path: '/tmp/src/foo.ts', content: 'a\nb\nc' }
  const structured = { path: '/tmp/src/foo.ts', nodeId: 'local', bytesWritten: 10 }
  const done = writeBodyData(trace({ toolName: 'write', input, structuredOutput: structured }))
  assert.equal(done.path, '/tmp/src/foo.ts')
  assert.equal(done.language, 'typescript')
  assert.equal(done.lineCount, 3)
  assert.equal(done.bytesWritten, 10)
  // 失败/运行中不宣称已写字节
  assert.equal(
    writeBodyData(trace({ toolName: 'write', input, status: 'error', isError: true, structuredOutput: structured })).bytesWritten,
    undefined,
  )
  assert.equal(writeBodyData(trace({ toolName: 'write', input, status: 'running' })).bytesWritten, undefined)
  // 缺 content：不编造
  const missing = writeBodyData(trace({ toolName: 'write', input: { path: '/x' } }))
  assert.equal(missing.content, undefined)
  assert.equal(missing.lineCount, undefined)
})

test('readBodyData：structuredOutput.content 优先，spill 标记不做源码高亮', { timeout: 60_000 }, () => {
  const normal = readBodyData(
    trace({
      toolName: 'read',
      input: { path: 'src/x.py' },
      structuredOutput: { path: '/abs/src/x.py', nodeId: 'local', content: 'print(1)' },
    }),
  )
  assert.equal(normal.content, 'print(1)')
  assert.equal(normal.language, 'python')
  assert.equal(normal.isSpill, false)

  const spilled = readBodyData(
    trace({
      toolName: 'read',
      input: { path: 'big.txt' },
      resultText: 'head…\n[Artifact] id=abc path=x（调用工具 read_artifact 获取全文）',
      artifactRef: 'abc',
    }),
  )
  assert.ok(spilled.content !== undefined && spilled.content.includes('[Artifact]'))
  assert.equal(spilled.isSpill, true)
  // resultText 兜底
  const fallback = readBodyData(trace({ toolName: 'read', input: { path: 'a.md' }, resultText: '# t' }))
  assert.equal(fallback.content, '# t')
  assert.equal(fallback.language, 'markdown')
})

test('bashBodyData：命令来自入参；exitCode/timedOut 仅类型收窄', { timeout: 60_000 }, () => {
  const data = bashBodyData(
    trace({
      input: { command: 'ls -la' },
      structuredOutput: { ok: false, exitCode: 2, output: 'boom', timedOut: false },
    }),
  )
  assert.equal(data.command, 'ls -la')
  assert.equal(data.exitCode, 2)
  assert.equal(data.timedOut, false)
  const timedOut = bashBodyData(trace({ structuredOutput: { ok: false, exitCode: null, output: '', timedOut: true } }))
  assert.equal(timedOut.exitCode, null)
  assert.equal(timedOut.timedOut, true)
  const none = bashBodyData(trace({}))
  assert.equal(none.command, undefined)
  assert.equal(none.exitCode, undefined)
})

// ---------------------------------------------------------------------------
// 单行统计
// ---------------------------------------------------------------------------

function validEditMeta(): Record<string, unknown> {
  return {
    path: '/abs/x.ts',
    nodeId: 'local',
    replaced: true,
    diff: {
      rows: [
        { kind: 'context', oldLine: 1, newLine: 1, text: 'a' },
        { kind: 'remove', oldLine: 2, text: 'b' },
        { kind: 'add', newLine: 2, text: 'c' },
        { kind: 'add', newLine: 3, text: 'd' },
      ],
      addedLines: 2,
      removedLines: 1,
      firstChangedLine: 2,
      truncated: false,
    },
  }
}

test('toolRowStats：edit 完成且元数据合法才报 +N −N（已应用语义）', { timeout: 60_000 }, () => {
  const stats = toolRowStats(trace({ toolName: 'edit', structuredOutput: validEditMeta() }))
  assert.deepEqual(
    { add: stats?.addCount, remove: stats?.removeCount },
    { add: 2, remove: 1 },
  )
  assert.match(stats?.title ?? '', /已应用/)
  // 元数据非法：不给统计（不伪称已应用差异）
  assert.equal(toolRowStats(trace({ toolName: 'edit', structuredOutput: { path: '/a', replaced: true } })), undefined)
})

test('toolRowStats：edit 运行中报待执行片段统计，标题明示未应用', { timeout: 60_000 }, () => {
  const stats = toolRowStats(
    trace({
      toolName: 'edit',
      status: 'running',
      input: { path: '/a.ts', oldText: 'x = 1', newText: 'x = 2' },
    }),
  )
  assert.equal(stats?.addCount, 1)
  assert.equal(stats?.removeCount, 1)
  assert.match(stats?.title ?? '', /待执行/)
  // 运行中缺入参不给统计
  assert.equal(toolRowStats(trace({ toolName: 'edit', status: 'running' })), undefined)
  // 失败/未知不给统计
  assert.equal(
    toolRowStats(trace({ toolName: 'edit', status: 'error', isError: true, input: { oldText: 'a', newText: 'b' } })),
    undefined,
  )
})

test('toolRowStats：write 报内容行数；插件 tool.view 接管不给宿主统计', { timeout: 60_000 }, () => {
  const stats = toolRowStats(trace({ toolName: 'write', input: { path: '/a', content: 'a\nb\nc' } }))
  assert.equal(stats?.text, '3 行')
  assert.equal(toolRowStats(trace({ toolName: 'write', input: { path: '/a' } })), undefined)
  assert.equal(
    toolRowStats(
      trace({
        toolName: 'subagent',
        toolView: { pluginId: 'builtin:workflow', spec: { id: 'subagent-view', toolNames: ['subagent'] } },
      }),
    ),
    undefined,
  )
  assert.equal(toolRowStats(trace({ toolName: 'bash', input: { command: 'ls' } })), undefined)
})
