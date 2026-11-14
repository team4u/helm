/**
 * 时间线上下文分割线（ContextDivider）DOM 回归：
 * - pi.compaction 的 summary 可展开查看（收起/展开交互）；
 * - pi.reset 的 handoff 展开行为保持不变；
 * - 无摘要（summary/handoff 为空）时不渲染展开按钮。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import * as React from 'react'
import { act } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ConversationEntry, ConversationSummary } from '@helm/protocol'
import { makeTestStore } from './helpers/store.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'

try {
  GlobalRegistrator.register()
} catch {
  // 已注册
}
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import('react-dom/client')
const { HelmStoreContext } = await import('../src/lib/store-context.js')
const e = React.createElement

const savedResizeObserver = globalThis.ResizeObserver
;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

let root: Root | undefined
let host: HTMLElement | undefined

afterEach(() => {
  if (root !== undefined) act(() => root?.unmount())
  root = undefined
  host?.remove()
  host = undefined
  document.body.innerHTML = ''
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver
})

const conv: ConversationSummary = {
  id: 1, title: '会话 1', profileId: 'assistant', tags: [], cwd: '/tmp',
  model: 'faux/faux-1', thinkingLevel: '', status: 'idle',
  stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
  pendingAskCount: 0, createdAt: 0, updatedAt: 0,
}

function entry(id: string, kind: string, extra: Partial<ConversationEntry> = {}): ConversationEntry {
  return { id, kind, ...extra }
}

async function renderTimeline(entries: ConversationEntry[]): Promise<HTMLElement> {
  const store = makeTestStore({
    conversations: [conv],
    conversationDetails: { [conv.id]: { ...conv, entries } },
  })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  await act(async () => {
    root!.render(
      e(
        HelmStoreContext.Provider,
        { value: store },
        e(ConversationTimeline, {
          conversation: conv,
          detailEntries: entries,
          onRequestEdit: () => {},
        }),
      ),
    )
  })
  return host
}

function expandButtons(host: HTMLElement): HTMLButtonElement[] {
  return Array.from(host.querySelectorAll<HTMLButtonElement>('button.context-divider-expand-btn'))
}

test('pi.compaction：摘要可展开/收起；无摘要不渲染展开按钮', { timeout: 60_000 }, async () => {
  const host = await renderTimeline([
    entry('1', 'pi.assistant', { model: [{ role: 'assistant', content: [{ type: 'text', text: '旧上下文' }] }] }),
    entry('2', 'pi.compaction', { model: [{ role: 'user', content: '本阶段完成了三件事：甲、乙、丙。' }] }),
    entry('3', 'pi.compaction', { model: [{ role: 'user', content: '' }] }),
  ])
  const buttons = expandButtons(host)
  assert.equal(buttons.length, 1, '仅携带摘要的 compaction 渲染展开按钮')
  assert.match(buttons[0]!.textContent ?? '', /展开精简摘要/)
  // 展开后正文可见；再点收起。
  act(() => { buttons[0]!.click() })
  assert.match(host.textContent ?? '', /本阶段完成了三件事：甲、乙、丙。/)
  const collapse = expandButtons(host)[0]!
  assert.match(collapse.textContent ?? '', /收起精简摘要/)
  act(() => { collapse.click() })
  assert.ok(!(host.textContent ?? '').includes('本阶段完成了三件事'))
})

test('pi.reset：交接摘要展开行为保持', { timeout: 60_000 }, async () => {
  const host = await renderTimeline([
    entry('1', 'pi.reset', { data: { handoff: '交接摘要正文' } }),
  ])
  const buttons = expandButtons(host)
  assert.equal(buttons.length, 1)
  assert.match(buttons[0]!.textContent ?? '', /展开交接摘要/)
  act(() => { buttons[0]!.click() })
  assert.match(host.textContent ?? '', /交接摘要正文/)
  assert.match(host.textContent ?? '', /上下文已重置/)
})
