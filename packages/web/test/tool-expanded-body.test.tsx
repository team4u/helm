/**
 * 宿主内置工具展开体交互测试（happy-dom）：
 * 1. edit：running 待执行片段（无文件行号）→ done 已应用差异（真实行号），
 *    failure 错误 + 未应用片段（绝不显示已应用差异），非法/缺失元数据显式
 *    诊断并默认展开原始数据；词级加深；服务端截断提示与折叠展开；大输入
 *    超预算提示并保留原始参数入口；
 * 2. write：源码预览前 12 行 / 共 N 行 / 展开全部 / 复制完整源码；
 * 3. read：spill 不做源码高亮且保留产物入口；普通结果按路径语言高亮；
 * 4. bash：命令复制头、输出默认尾 8 行、已折叠前 N 行与展开全部、退出码；
 * 5. 通用工具：键值展示 + 原始数据展开保留完整 JSON 入参与原始输出；
 * 6. TraceRow：无插件接管可点击展开内置体；tool.view inline 接管后行静默
 *    不再提供内置展开体（插件行为不变）；单行统计 +N −N / N 行。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'
import type { ToolTrace } from '../src/conversation/timeline-model.js'
import { ToolExpandedBody } from '../src/conversation/ToolExpandedBody.js'

const e = React.createElement

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React
const { TraceRow } = await import('../src/conversation/ConversationTimeline.js')

// ---------------------------------------------------------------------------
// 挂载工具
// ---------------------------------------------------------------------------

interface Mount {
  host: HTMLElement
  render: (element: React.ReactElement) => Promise<void>
  unmount: () => void
}

function createMount(): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let root: Root | null = createRoot(container)
  return {
    host: container,
    render: async (element: React.ReactElement) => {
      await act(async () => {
        root?.render(element)
      })
    },
    unmount: () => {
      act(() => {
        root?.unmount()
        root = null
        container.remove()
      })
    },
  }
}

const store = makeTestStore()
const modalCalls: Array<{ kind: string; artifactId?: string }> = []
store.setActiveModal = ((modal: { kind: string; artifactId?: string }) => {
  modalCalls.push({ kind: modal.kind, artifactId: modal.artifactId })
}) as typeof store.setActiveModal

function bodyUi(tool: ToolTrace): React.ReactElement {
  return e(HelmStoreContext.Provider, { value: store }, e(ToolExpandedBody, { tool, conversationId: 1 }))
}

function rowUi(tool: ToolTrace, defaultOpen = false): React.ReactElement {
  return e(
    HelmStoreContext.Provider,
    { value: store },
    e(TraceRow, { tool, conversationId: 1, defaultOpen, siblingCalls: [] }),
  )
}

function trace(overrides: Partial<ToolTrace> = {}): ToolTrace {
  return { key: 't1', toolName: 'bash', status: 'done', isError: false, ...overrides }
}

function validEditMeta(rows: unknown[] = [], truncated = false): Record<string, unknown> {
  return {
    path: '/abs/x.ts',
    nodeId: 'local',
    replaced: true,
    diff: {
      rows,
      addedLines: rows.filter((r) => (r as { kind?: string }).kind === 'add').length,
      removedLines: rows.filter((r) => (r as { kind?: string }).kind === 'remove').length,
      firstChangedLine: 1,
      truncated,
    },
  }
}

/** 统计 pre 里的可见行数（SyntaxCode 高亮前后 textContent 行数一致）。 */
function preLineCount(host: HTMLElement, selector: string): number {
  const pre = host.querySelector(selector)
  return pre?.textContent?.split('\n').length ?? 0
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

test('edit running：显示待执行的变更片段，不带文件行号', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'running',
          input: { path: '/a.ts', oldText: 'const a = 1\nrest', newText: 'const a = 2\nrest' },
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /待执行的变更片段/)
    assert.equal(m.host.querySelectorAll('.trace-diff-num').length, 0, '待执行片段不得伪造文件行号')
    assert.ok(m.host.querySelector('.trace-diff-pending'), '使用片段差异形态')
    assert.ok(m.host.textContent?.includes('−'), '存在删除行符号')
    assert.ok(m.host.textContent?.includes('+'), '存在新增行符号')
  } finally {
    m.unmount()
  }
})

test('edit pending → success：完成且元数据合法后切换为内核真实差异（真实行号）', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const input = { path: '/a.ts', oldText: 'const a = 1', newText: 'const a = 2' }
    await m.render(bodyUi(trace({ toolName: 'edit', status: 'running', input })))
    assert.match(m.host.textContent ?? '', /待执行的变更片段/)

    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'done',
          input,
          structuredOutput: validEditMeta([
            { kind: 'context', oldLine: 9, newLine: 9, text: 'function f() {' },
            { kind: 'remove', oldLine: 10, text: '  const a = 1' },
            { kind: 'add', newLine: 10, text: '  const a = 2' },
            { kind: 'context', oldLine: 11, newLine: 11, text: '}' },
          ]),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /已应用的差异/)
    assert.match(m.host.textContent ?? '', /\/abs\/x\.ts/)
    const nums = [...m.host.querySelectorAll('.trace-diff-num')].map((n) => n.textContent)
    assert.ok(nums.includes('10'), '显示真实文件行号 10')
    assert.ok(m.host.querySelector('.trace-diff-row-remove'))
    assert.ok(m.host.querySelector('.trace-diff-row-add'))
    assert.ok(m.host.querySelector('.trace-diff-row-context'))
    assert.equal(m.host.querySelector('.trace-diff-pending'), null, '不再显示片段形态')
  } finally {
    m.unmount()
  }
})

test('edit failure：错误与请求的变更片段（执行失败不判定文件已变），绝不显示已应用差异', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          status: 'error',
          isError: true,
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          resultText: 'edit_failed: oldText 在 /a.ts 中出现 2 次（需唯一匹配）',
          structuredOutput: validEditMeta([{ kind: 'add', newLine: 1, text: '伪造' }]),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /edit_failed: oldText 在 \/a\.ts 中出现 2 次/)
    assert.match(m.host.textContent ?? '', /请求的变更片段（执行失败，不判定文件是否已变）/)
    assert.doesNotMatch(m.host.textContent ?? '', /已应用的差异/)
    assert.equal(m.host.querySelector('.trace-diff-num'), null, '失败态无文件行号')
    assert.ok(m.host.textContent?.includes('/a.ts'), '失败保留目标路径')
  } finally {
    m.unmount()
  }
})

test('edit 成功但元数据缺失/非法：显式诊断并默认展开原始数据，不伪造差异', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          structuredOutput: { path: '/a.ts', nodeId: 'local', replaced: true },
          resultText: 'edit_ok: /a.ts（节点 local）',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /元数据缺失或非法/)
    assert.equal(m.host.querySelector('.trace-diff'), null, '不渲染任何差异表')
    const rawBtn = m.host.querySelector('.trace-raw .trace-inline-btn') as HTMLElement
    assert.ok(rawBtn)
    assert.equal(rawBtn.getAttribute('aria-expanded'), 'true', '原始数据默认展开')
    assert.match(m.host.textContent ?? '', /"oldText": "x"/)
    assert.match(m.host.textContent ?? '', /edit_ok: \/a\.ts/)
  } finally {
    m.unmount()
  }
})

test('edit unknown：与 running/done/error 区分，不虚构执行状态', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(trace({ toolName: 'edit', status: 'unknown', input: { path: '/a.ts', oldText: 'x', newText: 'y' } })),
    )
    assert.match(m.host.textContent ?? '', /结果未知/)
    assert.doesNotMatch(m.host.textContent ?? '', /待执行的变更片段/)
    assert.doesNotMatch(m.host.textContent ?? '', /已应用的差异/)
  } finally {
    m.unmount()
  }
})

test('edit 已应用差异：单删单增行对词级加深', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          structuredOutput: validEditMeta([
            { kind: 'remove', oldLine: 10, text: '  const a = 1' },
            { kind: 'add', newLine: 10, text: '  const a = 2' },
          ]),
        }),
      ),
    )
    assert.ok(m.host.querySelector('.trace-diff-word-remove'), 'remove 行词级加深')
    assert.ok(m.host.querySelector('.trace-diff-word-add'), 'add 行词级加深')
    const wordAdd = m.host.querySelector('.trace-diff-content .trace-diff-word-add')?.textContent
    assert.ok(wordAdd?.includes('2'), '加深的是变化词')
  } finally {
    m.unmount()
  }
})

test('edit 服务端截断：如实提示不可取回；长差异折叠后可展开全部已传行', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const rows = Array.from({ length: 40 }, (_, i) =>
      i % 2 === 0
        ? { kind: 'remove' as const, oldLine: i + 1, text: `old ${i}` }
        : { kind: 'add' as const, newLine: i, text: `new ${i}` },
    )
    await m.render(
      bodyUi(
        trace({
          toolName: 'edit',
          input: { path: '/a.ts', oldText: 'x', newText: 'y' },
          structuredOutput: validEditMeta(rows, true),
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /无法取回未传输内容/, '服务端截断如实提示')
    assert.equal(m.host.querySelectorAll('.trace-diff-row').length, 32, '默认折叠到 32 行')
    const foldBtn = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('展开剩余')) as HTMLButtonElement
    assert.ok(foldBtn)
    await act(async () => {
      foldBtn.click()
    })
    assert.equal(m.host.querySelectorAll('.trace-diff-row').length, 40, '展开后显示全部已传输行')
  } finally {
    m.unmount()
  }
})

test('edit 大输入超预算：明确提示跳过差异计算，保留原始参数入口', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const huge = 'x'.repeat(70_000)
    await m.render(
      bodyUi(trace({ toolName: 'edit', status: 'running', input: { path: '/big.txt', oldText: huge, newText: 'y' } })),
    )
    assert.match(m.host.textContent ?? '', /片段差异未计算/)
    assert.equal(m.host.querySelector('.trace-diff'), null)
    const rawBtn = m.host.querySelector('.trace-raw .trace-inline-btn') as HTMLElement
    assert.ok(rawBtn)
    await act(async () => {
      rawBtn.click()
    })
    assert.match(m.host.textContent ?? '', /"oldText"/, '原始参数完整保留')
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// write / read / bash
// ---------------------------------------------------------------------------

let clipboardText = ''
Object.defineProperty(globalThis.navigator, 'clipboard', {
  configurable: true,
  value: { writeText: async (text: string) => {
    clipboardText = text
  } },
})

test('write：默认前 12 行 + 共 N 行 + 展开全部 + 复制完整源码', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const content = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n')
    await m.render(
      bodyUi(trace({ toolName: 'write', status: 'running', input: { path: '/s/a.ts', content } })),
    )
    assert.match(m.host.textContent ?? '', /待写入/)
    assert.equal(preLineCount(m.host, '.trace-code-sec pre'), 12, '默认前 12 行')
    const expand = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('展开全部')) as HTMLButtonElement
    assert.ok(expand)
    assert.match(expand.textContent ?? '', /共 20 行/)
    await act(async () => {
      expand.click()
    })
    assert.equal(preLineCount(m.host, '.trace-code-sec pre'), 20, '展开后完整 20 行')
    const copy = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('复制源码')) as HTMLButtonElement
    assert.ok(copy)
    await act(async () => {
      copy.click()
    })
    assert.equal(clipboardText, content, '复制的是完整源码')
  } finally {
    m.unmount()
  }
})

test('write：失败显示执行失败与错误详情（不断言未写入）；成功显示写入内容与字节事实', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'write',
          status: 'error',
          isError: true,
          input: { path: '/s/a.ts', content: 'x' },
          resultText: 'write_failed: node_offline: 节点 n1 离线',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /写入内容（执行失败）/, '失败不标“未写入”（artifact 登记失败时文件可能已写成功）')
    assert.match(m.host.textContent ?? '', /write_failed/)
    assert.match(m.host.textContent ?? '', /\/s\/a\.ts/, '失败保留目标路径')
  } finally {
    m.unmount()
  }
  const m2 = createMount()
  try {
    await m2.render(
      bodyUi(
        trace({
          toolName: 'write',
          input: { path: '/s/a.ts', content: 'x' },
          structuredOutput: { path: '/s/a.ts', nodeId: 'local', bytesWritten: 1024 },
        }),
      ),
    )
    assert.match(m2.host.textContent ?? '', /写入内容/)
    assert.match(m2.host.textContent ?? '', /已写入 1\.0 KiB|已写入 1 KiB/)
  } finally {
    m2.unmount()
  }
})

test('read：spill 输出不做源码高亮并保留产物入口；普通结果按路径语言高亮', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const spillText = 'head line\n…[输出超长，已截断…]\n[Artifact] id=abc-1 path=x（调用工具 read_artifact 获取全文）'
    await m.render(
      bodyUi(
        trace({
          toolName: 'read',
          input: { path: 'src/big.log' },
          resultText: spillText,
          structuredOutput: { path: '/abs/src/big.log', nodeId: 'local', content: spillText },
          artifactRef: 'abc-1',
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /超长已转产物/)
    assert.equal(m.host.querySelector('.trace-code-sec'), null, 'spill 不走语法高亮形态')
    const artifactBtn = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('打开完整产物')) as HTMLButtonElement
    assert.ok(artifactBtn, '保留打开完整产物入口')
    modalCalls.length = 0
    await act(async () => {
      artifactBtn.click()
    })
    assert.equal(modalCalls[0]?.artifactId, 'abc-1')
  } finally {
    m.unmount()
  }
  const m2 = createMount()
  try {
    await m2.render(
      bodyUi(
        trace({
          toolName: 'read',
          input: { path: 'src/x.py' },
          structuredOutput: { path: '/abs/src/x.py', nodeId: 'local', content: 'print("hi")\n' },
        }),
      ),
    )
    assert.match(m2.host.textContent ?? '', /读取结果/)
    assert.ok(m2.host.querySelector('.trace-code-sec pre'), '普通结果走源码预览')
    assert.equal(preLineCount(m2.host, '.trace-code-sec pre'), 1)
  } finally {
    m2.unmount()
  }
})

test('bash：命令可复制；输出默认尾 8 行、标注折叠前 N 行、可展开全部；退出码如实', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    const output = Array.from({ length: 20 }, (_, i) => `out ${i + 1}`).join('\n')
    await m.render(
      bodyUi(
        trace({
          toolName: 'bash',
          input: { command: 'pnpm test --filter @helm/web' },
          resultText: output,
          structuredOutput: { ok: false, exitCode: 2, output, timedOut: false },
        }),
      ),
    )
    assert.match(m.host.querySelector('.trace-cmd-head code')?.textContent ?? '', /pnpm test --filter @helm\/web/)
    assert.match(m.host.textContent ?? '', /退出码 2（非 0）/, '非零退出码如实展示')
    const pres = [...m.host.querySelectorAll('pre')].filter((p) => p.closest('.trace-cmd-head') === null)
    const outPre = pres.find((p) => p.textContent?.includes('out 20'))
    assert.ok(outPre)
    assert.equal(outPre?.textContent?.split('\n').length, 8, '默认输出尾 8 行')
    assert.match(m.host.textContent ?? '', /已折叠前 12 行/)
    assert.ok(m.host.textContent?.includes('out 20') && !m.host.textContent?.includes('out 5'), '仅显示尾部行')
    const expand = [...m.host.querySelectorAll('button')].find((b) => b.textContent?.includes('展开全部')) as HTMLButtonElement
    await act(async () => {
      expand.click()
    })
    assert.ok(m.host.textContent?.includes('out 5'), '展开后可见全部输出')
    const copy = m.host.querySelector('.trace-cmd-head button') as HTMLButtonElement
    await act(async () => {
      copy.click()
    })
    assert.equal(clipboardText, 'pnpm test --filter @helm/web', '复制完整命令')
  } finally {
    m.unmount()
  }
})

test('bash：运行中无输出如实提示，不伪造输出', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(bodyUi(trace({ toolName: 'bash', status: 'running', input: { command: 'sleep 1' } })))
    assert.match(m.host.textContent ?? '', /执行中，暂无输出/)
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

test('通用工具：键值展示多行入参；原始数据展开保留完整 JSON 与原始输出', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      bodyUi(
        trace({
          toolName: 'gate',
          input: { question: '是否继续部署？', options: ['继续', '终止'], context: 'step1\nstep2' },
          resultText: 'approved',
          structuredOutput: { decision: '继续' },
        }),
      ),
    )
    assert.match(m.host.textContent ?? '', /是否继续部署？/)
    assert.ok(m.host.querySelector('.trace-kv'), '键值形态渲染')
    const rawBtn = m.host.querySelector('.trace-raw .trace-inline-btn') as HTMLElement
    assert.equal(rawBtn.getAttribute('aria-expanded'), 'false', '原始数据默认收起')
    await act(async () => {
      rawBtn.click()
    })
    const text = m.host.textContent ?? ''
    assert.match(text, /"question": "是否继续部署？"/, '完整 JSON 入参不丢')
    assert.match(text, /"decision": "继续"/, '结构化结果保留')
    assert.match(text, /approved/, '原始输出保留')
  } finally {
    m.unmount()
  }
})

// ---------------------------------------------------------------------------
// TraceRow 集成（无插件接管使用内置体；tool.view 接管行为不变）
// ---------------------------------------------------------------------------

test('TraceRow：无插件接管时点击展开内置展开体，再点击收起', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(rowUi(trace({ toolName: 'bash', input: { command: 'ls' }, resultText: 'a\nb' })))
    const row = m.host.querySelector('.trace-row') as HTMLElement
    assert.equal(row.getAttribute('role'), 'button')
    await act(async () => {
      row.click()
    })
    assert.ok(m.host.querySelector('.trace-expanded-body'), '展开内置体')
    assert.match(m.host.textContent ?? '', /原始数据/)
    await act(async () => {
      row.click()
    })
    assert.equal(m.host.querySelector('.trace-expanded-body'), null, '再次点击收起')
  } finally {
    m.unmount()
  }
})

test('TraceRow：tool.view inline 接管后行静默，不提供宿主内置展开体', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(
      rowUi(
        trace({
          toolName: 'subagent',
          toolView: { pluginId: 'builtin:workflow', spec: { id: 'subagent-view', toolNames: ['subagent'] } },
        }),
      ),
    )
    const row = m.host.querySelector('.trace-row') as HTMLElement
    assert.ok(row)
    assert.ok(row.classList.contains('trace-row-static'), '插件接管后行不可展开')
    assert.equal(row.getAttribute('role'), null)
    assert.ok(m.host.querySelector('.trace-toolview'), '插件视图仍在行下方渲染')
    await act(async () => {
      row.click()
    })
    assert.equal(m.host.querySelector('.trace-expanded-body'), null, '不出现宿主内置展开体')
  } finally {
    m.unmount()
  }
})

test('TraceRow：单行统计 write 行数与 edit +N −N；无统计不渲染徽标', { timeout: 60_000 }, async () => {
  const m = createMount()
  try {
    await m.render(rowUi(trace({ toolName: 'write', input: { path: '/a', content: 'a\nb\nc' } })))
    const stats = m.host.querySelector('.trace-row-stats')
    assert.match(stats?.textContent ?? '', /3 行/)

    await m.render(
      rowUi(
        trace({
          toolName: 'edit',
          structuredOutput: validEditMeta([
            { kind: 'remove', oldLine: 2, text: 'a' },
            { kind: 'add', newLine: 2, text: 'b' },
            { kind: 'add', newLine: 3, text: 'c' },
          ]),
        }),
      ),
    )
    const editStats = m.host.querySelector('.trace-row-stats')
    assert.match(editStats?.textContent ?? '', /\+2/)
    assert.match(editStats?.textContent ?? '', /−1/)
    assert.match(editStats?.getAttribute('title') ?? '', /已应用/)

    await m.render(rowUi(trace({ toolName: 'bash', input: { command: 'ls' } })))
    assert.equal(m.host.querySelector('.trace-row-stats'), null, '无统计不渲染徽标')
  } finally {
    m.unmount()
  }
})
