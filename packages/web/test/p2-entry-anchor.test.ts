/**
 * P2 修复测试：timeline.entry.action 真实 entry 锚点。
 *
 * 缺口回顾：此前 ConversationTimeline 人类消息 hover 条人为拼出
 * { id, kind, role } 占位 entry，assistant 回合也人为拼
 * { id: anchorId, kind: 'pi.assistant', role: 'assistant' }（anchorId 取
 * turn.entryIds 最后一项，可能是 pi.tool-result），丢失真实
 * ConversationEntry.data / metadata；插件 timeline.renderer 自定义条目也
 * 没有 entry action 挂载。
 *
 * 本文件断言：
 * 1. DOM/SSR：client/json 轨可读到真实 entry.data（非占位）；
 * 2. payload entryId 必须等于传入真实 entry.id；
 * 3. kind 精确过滤：动作声明 kinds 不含真实 kind 时不渲染；
 * 4. assistant 锚点必须是真实 pi.assistant（带 assistant 正文），绝不能是
 *    pi.tool-result；live 回合无持久锚点时不渲染（不伪造）；
 * 5. generic plugin entry（timeline.renderer 自定义 kind 条目）也有 entry
 *    action，按真实 entry.kind 过滤；声明 roles 的动作不命中无角色条目；
 * 6. queued 人类消息（无持久锚点）不渲染 entry action；
 * 7. rewind 覆盖条目不得复活为锚点；保留宿主复制/分叉语义不受干扰。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type {
  ConversationEntry,
  ConversationLive,
  ConversationSummary,
  PluginUiContribution,
  UiActionSpec,
} from '@helm/protocol'
import { groupUiContributions } from '../src/lib/types.js'
import { timelineEntryActionContextOf } from '../src/conversation/action-model.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { makeTestStore } from './helpers/store.js'

const e = React.createElement
;(globalThis as Record<string, unknown>).React = React

// client 轨组件种子：渲染真实 entry 数据（{$data.entry...} 等价物），供断言。
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
seedPluginClientModule('p', 'entry-badge.tsx', {
  EntryBadge: (props: Record<string, unknown>) => {
    const entry = (props['entry'] ?? {}) as { id?: string; kind?: string; data?: { ref?: string } }
    return e('span', null, `${entry.id ?? ''}:${entry.kind ?? ''}:${entry.data?.ref ?? ''}`)
  },
})
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

function conv(partial: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${partial.id}`,
    profileId: 'coder',
    tags: [],
    cwd: '/tmp',
    model: 'zhipu/glm-4.6',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 1,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: partial.id * 1000,
    updatedAt: partial.id * 1000,
    ...partial,
  }
}

const humanConv = conv({ id: 10 })

/** client 轨动作：渲染真实 entry 数据文本，供断言（json 轨已移除内核）。 */
const jsonAction = (id: string, label: string, extra: Record<string, unknown> = {}): PluginUiContribution => ({
  pluginId: 'p',
  surface: 'timeline.entry.action',
  spec: {
    id,
    label,
    actionId: 'act',
    client: { module: 'entry-badge.tsx', export: 'EntryBadge' },
    ...extra,
  },
})

function renderTimeline(
  entries: ConversationEntry[],
  contributions: PluginUiContribution[],
  conversation: ConversationSummary = humanConv,
  live?: ConversationLive,
): string {
  const store = makeTestStore({
    conversations: [conversation],
    groupedUi: groupUiContributions(contributions),
  })
  return renderToString(
    e(
      HelmStoreContext.Provider,
      { value: store },
      e(ConversationTimeline, {
        conversation,
        detailEntries: entries,
        ...(live !== undefined ? { live } : {}),
        onRequestEdit: () => {},
      }),
    ),
  )
}

// ---------------------------------------------------------------------------
// 1. 纯函数：真实 entry -> 匹配上下文
// ---------------------------------------------------------------------------

test('timelineEntryActionContextOf：真实 kind + 文本条目附角色，其余无角色', { timeout: 60_000 }, () => {
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'helm.input' }), { kind: 'helm.input', role: 'user' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'pi.user' }), { kind: 'pi.user', role: 'user' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '1', kind: 'pi.assistant' }), { kind: 'pi.assistant', role: 'assistant' })
  // 自定义 / 簿记条目：kind 原样、无角色（声明 roles 的动作不命中）
  assert.deepEqual(timelineEntryActionContextOf({ id: '9', kind: 'superagent:worker-report' }), { kind: 'superagent:worker-report' })
  assert.deepEqual(timelineEntryActionContextOf({ id: '3', kind: 'pi.tool-result' }), { kind: 'pi.tool-result' })
})

// ---------------------------------------------------------------------------
// 2. 人类消息：真实 entry.data 可读 + payload entryId 为真实 id
// ---------------------------------------------------------------------------

test('人类消息 entry action：json 轨读到真实 entry.data（非占位拼合）', { timeout: 60_000 }, () => {
  const html = renderTimeline(
    [
      { id: '5', kind: 'helm.input', data: { text: '帮我检查', origin: 'human', ref: 'REF-HUMAN-5' } },
    ],
    [jsonAction('quote', '引用')],
  )
  // 真实 entry.id + 真实 kind + 真实 data.ref 全部可读：占位拼合拿不到 data.ref
  assert.match(html, /5:helm\.input:REF-HUMAN-5/)
})

test('kind 精确过滤：声明 kinds 不含真实 kind 的动作不渲染', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '5', kind: 'helm.input', data: { text: '帮我检查', origin: 'human', ref: 'R5' } },
  ]
  const hit = renderTimeline(entries, [jsonAction('hit', '命中', { kinds: ['helm.input'] })])
  assert.match(hit, /5:helm\.input:R5/)
  const miss = renderTimeline(entries, [jsonAction('miss', '不命中', { kinds: ['pi.assistant'] })])
  assert.doesNotMatch(miss, /R5/)
  // 兜底裸 pi.user 的 kind 也按真实值过滤
  const bareEntries: ConversationEntry[] = [{ id: '6', kind: 'pi.user', model: [{ role: 'user', content: '裸输入' }], data: { ref: 'R6' } }]
  assert.match(renderTimeline(bareEntries, [jsonAction('u', '用户兜底', { kinds: ['pi.user'] })]), /6:pi\.user:R6/)
  assert.doesNotMatch(renderTimeline(bareEntries, [jsonAction('h', '错 kind', { kinds: ['helm.input'] })]), /R6/)
})

test('queued 人类消息（无持久锚点）不渲染 entry action', { timeout: 60_000 }, () => {
  const html = renderTimeline(
    [{ id: '1', kind: 'helm.input', data: { text: '第一问', origin: 'human' } }],
    [jsonAction('quote', '引用')],
    humanConv,
    {
      conversationId: 10,
      text: '',
      tools: [],
      updatedAt: 1,
      queuedInputs: [
        { id: 'q1', submissionId: 'sub-1', text: '排队中的追问', mode: 'followUp', origin: 'human', createdAt: 1 },
      ],
    },
  )
  // 落库消息有 action；queued 胶囊（entryId=queued:sub-1）绝不能伪造 entry 渲染 action：
  // 其 hover 条内不出现任何插件动作产物（json 轨文本 / 动作按钮）。宿主
  // data-entry-id="queued:*" 是高亮定位属性，与 action 锚点无关。
  assert.match(html, /1:helm\.input:/)
  const queuedWrap = html.split('data-entry-id="queued:sub-1"')[1] ?? ''
  const queuedHover = queuedWrap.split('</span></div></div>')[0] ?? ''
  assert.doesNotMatch(queuedHover, /引用/)
  assert.doesNotMatch(queuedHover, /:helm\.input:/)
  assert.doesNotMatch(queuedHover, /:queued:/)
  // 宿主编辑/复制语义保留
  assert.match(html, /排队中 · 待当前回合结束后发送/)
})

// ---------------------------------------------------------------------------
// 3. assistant 回合：真实 pi.assistant 锚点，pi.tool-result 不可作锚
// ---------------------------------------------------------------------------

test('assistant 回合 entry action：锚点是带 assistant 正文的真实条目，非 tool-result', { timeout: 60_000 }, () => {
  const html = renderTimeline(
    [
      { id: '1', kind: 'helm.input', data: { text: '查一下', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'call_1', name: 'bash', arguments: {} }] }],
      },
      { id: '3', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: 'ok' }] },
      {
        id: '4',
        kind: 'pi.assistant',
        data: { ref: 'REF-AI-4' },
        model: [{ role: 'assistant', content: [{ type: 'text', text: '检查完成' }] }],
      },
    ],
    [jsonAction('cite', '引用回复')],
  )
  // 锚点必须是携带正文的真实 pi.assistant 条目（id=4，data.ref 可读）。
  // 此前实现取 entryIds 最后一项拼占位：kind 恒为 pi.assistant 且无 data。
  assert.match(html, /4:pi\.assistant:REF-AI-4/)
  // 绝不出现 tool-result 被当作锚点伪造出的占位（无 data.ref 可读）
  assert.doesNotMatch(html, /3:pi\.assistant:/)
  assert.doesNotMatch(html, /3:pi\.tool-result:/)
})

test('assistant 锚点回退：无 assistant 正文时退回最后一个纯 toolCall 的 pi.assistant 条目', { timeout: 60_000 }, () => {
  const html = renderTimeline(
    [
      {
        id: '7',
        kind: 'pi.assistant',
        data: { ref: 'REF-ONLY' },
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: {} }] }],
      },
      { id: '8', kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'c', toolName: 'bash', content: 'ok' }] },
    ],
    [jsonAction('cite', '引用回复')],
  )
  assert.match(html, /7:pi\.assistant:REF-ONLY/)
})

test('live 回合无持久锚点：不渲染 entry action（不伪造），宿主分叉按钮保留', { timeout: 60_000 }, () => {
  const working = conv({ id: 11, status: 'working' })
  const html = renderTimeline(
    [
      { id: '1', kind: 'helm.input', data: { text: '跑起来', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        model: [{ role: 'assistant', content: [{ type: 'toolCall', id: 'c1', name: 'bash', arguments: {} }] }],
      },
    ],
    [jsonAction('cite', '引用回复')],
    working,
    { conversationId: 11, text: '流式输出中', tools: [{ callId: 'c1', toolName: 'bash', status: 'running' }], updatedAt: 9 },
  )
  // 人类消息 action 正常（有真实锚点）
  assert.match(html, /1:helm\.input:/)
  // live 回合 busy：hover 条整体不出现（复制/分叉/action 同一防线）
  assert.doesNotMatch(html, /引用回复/)
  assert.doesNotMatch(html, /从此处分叉新会话/)
})

test('live 快照合并进已有持久 pi.assistant 回合：busy 期间不渲染，也不伪造锚点', { timeout: 60_000 }, () => {
  const working = conv({ id: 11, status: 'working' })
  const html = renderTimeline(
    [
      { id: '1', kind: 'helm.input', data: { text: '继续', origin: 'human' } },
      {
        id: '2',
        kind: 'pi.assistant',
        data: { ref: 'REF-LIVE-2' },
        model: [{ role: 'assistant', content: [{ type: 'text', text: '开始' }] }],
      },
    ],
    [jsonAction('cite', '引用回复')],
    working,
    { conversationId: 11, text: '开始流式', tools: [], updatedAt: 9 },
  )
  // busy 回合不渲染 action，但也不能伪造锚点（turn.key 绝不出现在 entry 上下文）
  assert.doesNotMatch(html, /引用回复/)
  assert.doesNotMatch(html, /turn:/)
})

// ---------------------------------------------------------------------------
// 4. generic plugin entry（timeline.renderer 自定义条目）也消费 entry action
// ---------------------------------------------------------------------------

test('插件 timeline.renderer 自定义条目：entry action 按真实 kind 过滤并透出真实 entry', { timeout: 60_000 }, () => {
  const contributions: PluginUiContribution[] = [
    {
      pluginId: 'p',
      surface: 'timeline.renderer',
      spec: { id: 'r', matchMeta: { renderer: 'worker-report' } },
    },
    jsonAction('generic', '卡片操作'),
    jsonAction('kind-limited', '限kind', { kinds: ['superagent:worker-report'] }),
    jsonAction('kind-miss', '错kind', { kinds: ['helm.input'] }),
    jsonAction('role-limited', '限角色', { roles: ['user'] }),
  ]
  const html = renderTimeline(
    [
      {
        id: '8',
        kind: 'superagent:worker-report',
        data: { renderer: 'worker-report', ref: 'REF-CARD-8' },
      },
    ],
    contributions,
  )
  // 卡片本体渲染 + 两个命中动作（无 kinds 限定 + 真实 kind 精确命中）可读真实 data
  assert.match(html, /8:superagent:worker-report:REF-CARD-8/)
  // kind 不匹配的动作不渲染
  assert.doesNotMatch(html, /错kind/)
  // 自定义 kind 无 user/assistant 角色：声明 roles 的动作不命中
  assert.doesNotMatch(html, /限角色/)
})

// ---------------------------------------------------------------------------
// 5. action-only 轨：payload entryId 必须等于传入真实 entry.id（DOM 交互）
// ---------------------------------------------------------------------------

test('action-only entry action 点击：载荷 entryId 为真实 entry.id，kind 过滤仍生效', { timeout: 60_000 }, async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  try {
    GlobalRegistrator.register()
  } catch {
    // 同进程复用 happy-dom 全局单例
  }
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true
  const { act } = await import('react')
  const { createRoot } = await import('react-dom/client')

  const calls: Array<{ pluginId: string; actionId: string; input: Record<string, unknown>; conversationId?: number }> = []
  const store = makeTestStore({
    conversations: [humanConv],
    groupedUi: groupUiContributions([
      {
        pluginId: 'p',
        surface: 'timeline.entry.action',
        spec: { target: 'timeline:entry', id: 'pin', label: '置顶该消息', actionId: 'pin_entry', kinds: ['helm.input'] } satisfies UiActionSpec,
      },
      {
        pluginId: 'p',
        surface: 'timeline.entry.action',
        spec: { target: 'timeline:entry', id: 'wrong-kind', label: '错误kind动作', actionId: 'x', kinds: ['pi.assistant'] } satisfies UiActionSpec,
      },
    ]),
    invokePluginAction: async (pluginId, actionId, input, conversationId) => {
      calls.push({ pluginId, actionId, input: input as Record<string, unknown>, conversationId })
      return { ok: true }
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    await act(async () => {
      root.render(
        e(
          HelmStoreContext.Provider,
          { value: store },
          e(ConversationTimeline, {
            conversation: humanConv,
            detailEntries: [
              { id: '42', kind: 'helm.input', data: { text: '真实锚点', origin: 'human' } },
            ],
            onRequestEdit: () => {},
          }),
        ),
      )
    })
    const btn = host.querySelector<HTMLButtonElement>('button[aria-label="置顶该消息"]')
    assert.ok(btn !== null, 'action-only 渲染标准图标按钮')
    assert.equal(host.querySelector('button[aria-label="错误kind动作"]'), null, 'kind 不匹配不渲染')
    await act(async () => { btn.click() })
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.pluginId, 'p')
    assert.equal(calls[0]!.actionId, 'pin_entry')
    // 载荷 entryId 必须等于真实 entry.id
    assert.deepEqual(calls[0]!.input, { conversationId: 10, entryId: '42' })
    assert.equal(calls[0]!.conversationId, 10)
    // 宿主复制/编辑/分叉语义保留
    const hover = btn.closest('.msg-hover-bar')
    assert.ok(hover !== null)
    assert.equal(hover.querySelectorAll('button').length >= 3, true, '复制/编辑/分叉仍在 hover 条内')
  } finally {
    act(() => root.unmount())
    host.remove()
  }
})

// ---------------------------------------------------------------------------
// 6. rewind 覆盖条目不得作为锚点（与渲染层同口径）
// ---------------------------------------------------------------------------

test('rewind 覆盖的人类条目不渲染 entry action（不复活已覆盖锚点）', { timeout: 60_000 }, () => {
  const html = renderTimeline(
    [
      { id: '1', kind: 'helm.input', data: { text: '旧问题', origin: 'human', ref: 'OLD' } },
      { id: '2', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '旧回答' }] }] },
      { id: '3', kind: 'helm.rewind', data: { fromEntryId: 1, throughEntryId: 2 } },
      { id: '4', kind: 'helm.input', data: { text: '新问题', origin: 'human', ref: 'NEW' } },
    ],
    [jsonAction('quote', '引用')],
  )
  assert.doesNotMatch(html, /OLD/)
  assert.match(html, /4:helm\.input:NEW/)
})
