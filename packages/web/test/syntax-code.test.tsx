/**
 * SyntaxCode 语法高亮流式稳定性测试（happy-dom）：
 * - 流式增量帧与高亮同帧提交：模块就绪后 append 增量当帧必须仍是高亮形态，
 *   不得退回纯文本（回归锁：旧实现先渲一帧 <code>{code}</code> 纯文本，异步
 *   import 回调 setState 后再换高亮 HTML，流式期间彩色↔无色两帧交替即闪烁）；
 * - 模块缓存就绪后新挂载的代码块首帧即高亮（不闪一下纯文本）；
 * - 高亮 HTML 的 textContent 与源码一致（复制与原文展示同源）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SyntaxCode } from '../src/conversation/SyntaxCode.js'

const e = React.createElement

GlobalRegistrator.register()
;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
;(globalThis as Record<string, unknown>).React = React

interface Mount {
  host: HTMLElement
  render: (element: React.ReactElement) => void
  unmount: () => void
}

function createMount(): Mount {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  return {
    host: container,
    render: (element) => {
      act(() => {
        root.render(element)
      })
    },
    unmount: () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    },
  }
}

/** 等待谓词成立（真实定时器让首次动态 import 与其回调跑完），超时抛错。 */
async function waitUntil(predicate: () => boolean, what: string, attempts = 200): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
  }
  if (!predicate()) throw new Error(`等待超时：${what}`)
}

function codeEl(host: HTMLElement): HTMLElement {
  const el = host.querySelector('pre code')
  assert.ok(el instanceof HTMLElement, '代码块应渲染 pre > code')
  return el
}

const TS_HEAD = 'const answer: number = 42\n'
const TS_APPENDED = TS_HEAD + 'export { answer }\n'

test('流式增量帧与高亮同帧提交，不退回纯文本', async () => {
  const m = createMount()
  try {
    m.render(e(SyntaxCode, { code: TS_HEAD, language: 'typescript' }))
    // 首块：等 highlight.js/lib/common 首次加载并完成高亮（延时包进 act，异步 setState 在 act 边界提交）
    await waitUntil(() => codeEl(m.host).querySelector('span') !== null, '首次语法高亮')
    assert.equal(codeEl(m.host).textContent, TS_HEAD)

    // 流式增量：同步 act 提交的当帧（import 微任务回调尚未运行）必须仍是高亮形态
    m.render(e(SyntaxCode, { code: TS_APPENDED, language: 'typescript' }))
    assert.ok(codeEl(m.host).querySelector('span') !== null, '增量帧退回纯文本即闪烁回归')
    assert.equal(codeEl(m.host).textContent, TS_APPENDED)
  } finally {
    m.unmount()
  }
})

test('模块缓存就绪后新挂载代码块首帧即高亮', async () => {
  // 预热：确保同进程模块级缓存就绪
  const warm = createMount()
  warm.render(e(SyntaxCode, { code: 'let x = 1\n', language: 'typescript' }))
  try {
    await act(async () => {
      await waitUntil(() => codeEl(warm.host).querySelector('span') !== null, '模块缓存就绪')
    })
  } finally {
    warm.unmount()
  }

  // 重新挂载的首帧（无任何异步等待）即高亮形态
  const fresh = createMount()
  try {
    fresh.render(e(SyntaxCode, { code: TS_HEAD, language: 'typescript' }))
    assert.ok(codeEl(fresh.host).querySelector('span') !== null, '新挂载首帧应为高亮形态')
    assert.equal(codeEl(fresh.host).textContent, TS_HEAD)
  } finally {
    fresh.unmount()
  }
})
