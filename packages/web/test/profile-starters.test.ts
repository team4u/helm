/**
 * Profile.starters Web 端测试：
 * 1. 纯函数：草稿校验（trim/码点上限/纯空白）、startersToDrafts、visibleStarters；
 * 2. ProfileDetailDrawer SSR：starters 编辑区块渲染、0 Emoji、错误提示；
 * 3. ConversationTimeline SSR：空白会话展示引导词按钮、点击仅回调（不渲染为
 *    历史编辑）；有更早分页（nextCursor）/运行中/排队输入时不展示（防误判）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary, InputOrigin, Profile } from '@helm/protocol'
import {
  startersToDrafts,
  validateStarterDraft,
  validateStarterDrafts,
  visibleStarters,
  startersAtLimit,
} from '../src/profiles/profile-center-model.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

;(globalThis as Record<string, unknown>).React = React
const e = React.createElement
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}][\u{2600}-\u{26FF}]?[\u{2700}-\u{27BF}]?/u
const STARTERS_CSS = readHostStyles()
const TIMELINE_CSS = STARTERS_CSS

// ---------------------------------------------------------------------------
// 1. 纯函数
// ---------------------------------------------------------------------------

test('starters 纯函数：校验边界与形态转换', { timeout: 60_000 }, () => {
  assert.equal(validateStarterDraft({ label: '标题', prompt: '内容' }), null)
  assert.equal(validateStarterDraft({ label: '  带空白  ', prompt: '内容' }), null)
  assert.match(validateStarterDraft({ label: '', prompt: 'x' })!, /Title/)
  assert.match(validateStarterDraft({ label: '   ', prompt: 'x' })!, /Title/)
  assert.match(validateStarterDraft({ label: 'x', prompt: '' })!, /whitespace only/)
  assert.match(validateStarterDraft({ label: 'x', prompt: ' \n ' })!, /whitespace only/)
  assert.equal(validateStarterDraft({ label: '🎉'.repeat(24), prompt: 'x' }), null)
  assert.match(validateStarterDraft({ label: '🎉'.repeat(25), prompt: 'x' })!, /24/)
  assert.match(validateStarterDraft({ label: 'x', prompt: 'y'.repeat(4001) })!, /4000/)

  assert.equal(validateStarterDrafts([{ label: 'a', prompt: 'b' }]), null)
  const first = validateStarterDrafts([
    { label: 'a', prompt: 'b' },
    { label: '', prompt: 'c' },
  ])
  assert.equal(first!.index, 1)

  assert.deepEqual(startersToDrafts([{ label: 'L', prompt: 'P' }]), [{ label: 'L', prompt: 'P' }])
  assert.deepEqual(startersToDrafts(undefined), [])
  assert.deepEqual(visibleStarters({ id: 'x', starters: [] }), undefined)
  assert.deepEqual(visibleStarters({ id: 'x', starters: [{ label: 'L', prompt: 'P' }] }), [{ label: 'L', prompt: 'P' }])
  assert.deepEqual(visibleStarters(undefined), undefined)
  assert.equal(startersAtLimit(Array.from({ length: 6 }, (_, i) => ({ label: `s${i}`, prompt: 'p' }))), true)
})

// ---------------------------------------------------------------------------
// 2. ProfileDetailDrawer SSR
// ---------------------------------------------------------------------------

const profileWithStarters: Profile = {
  id: 'helper',
  name: '助手',
  tags: [],
  starters: [
    { label: '写日报', prompt: '请生成今日工作日报' },
    { label: '清空收件箱', prompt: '整理我的收件箱并汇总' },
  ],
}

test('ProfileDetailDrawer：starters 编辑区块渲染既有条目与计数（0 Emoji）', { timeout: 60_000 }, () => {
  const store = makeTestStore({ profiles: [profileWithStarters], models: [] })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: profileWithStarters,
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /Empty-conversation starters/)
  assert.match(html, /写日报/)
  assert.match(html, /请生成今日工作日报/)
  assert.match(html, /清空收件箱/)
  assert.match(html, /2\/6/, '计数渲染 2/6')
  assert.match(html, /Add starter/)
  assert.doesNotMatch(html, EMOJI_REGEX)
  // CSS 原语齐备
  assert.match(STARTERS_CSS, /\.profile-starter-item/)
  assert.match(STARTERS_CSS, /\.profile-starter-remove/)
})

// ---------------------------------------------------------------------------
// 3. ConversationTimeline SSR
// ---------------------------------------------------------------------------

function convSummary(status: ConversationSummary['status'] = 'idle'): ConversationSummary {
  const now = Date.now()
  return {
    id: 7, title: '空会话', profileId: 'helper', tags: [], cwd: '/tmp',
    model: 'faux/model', thinkingLevel: '', status, stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: now, updatedAt: now,
  }
}

function renderTimeline(opts: {
  conversation?: ConversationSummary
  entries?: ConversationEntry[]
  nextCursor?: string
  omitDetail?: boolean
  loadErrors?: Record<string, string>
  starters?: Array<{ label: string; prompt: string }>
  sendingPending?: boolean
  live?: { tools?: never[]; queuedInputs: Array<{ id: string; text: string; mode: 'steer' | 'followUp'; origin: InputOrigin; createdAt: number; submissionId: string }> }
}): { html: string; clicks: string[] } {
  const conversation = opts.conversation ?? convSummary()
  const clicks: string[] = []
  const store = makeTestStore({
    conversations: [conversation],
    conversationDetails: opts.omitDetail
      ? {}
      : { [conversation.id]: { ...conversation, entries: opts.entries ?? [], ...(opts.nextCursor !== undefined ? { nextCursor: opts.nextCursor } : {}) } },
    ...(opts.loadErrors !== undefined ? { loadErrors: opts.loadErrors } : {}),
    profiles: [{ id: 'helper', starters: opts.starters }],
    ...(opts.live !== undefined ? { conversationLives: { [conversation.id]: { conversationId: conversation.id, text: '', tools: [] as never[], queuedInputs: opts.live.queuedInputs, updatedAt: 1 } } } : {}),
  })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ConversationTimeline, {
        conversation,
        detailEntries: opts.entries ?? [],
        starters: opts.starters,
        sendingPending: opts.sendingPending ?? false,
        ...(opts.live !== undefined ? { live: store.conversationLives[conversation.id] } : {}),
        onRequestEdit: () => {},
        onRequestStarter: (text) => { clicks.push(text) },
      }),
    ),
  )
  return { html, clicks }
}

/** 提取 `.timeline-center-slot` 的完整 DOM 片段及其结束下标（验证前置居中槽与 `.timeline-inner` 严格分离）。 */
function extractCenterSlot(html: string): { html: string; endIndex: number } | null {
  const marker = '<div class="timeline-center-slot">'
  const start = html.indexOf(marker)
  if (start === -1) return null
  const tagRe = /<\/?div\b[^>]*>/g
  tagRe.lastIndex = start
  let depth = 0
  let match: RegExpExecArray | null
  while ((match = tagRe.exec(html)) !== null) {
    if (match[0].startsWith('</div')) {
      depth -= 1
      if (depth === 0) {
        const endIndex = match.index + match[0].length
        return { html: html.slice(start, endIndex), endIndex }
      }
    } else {
      depth += 1
    }
  }
  return null
}

const sampleStarters = [
  { label: '写周报', prompt: '请汇总本周进展' },
  { label: '代码审查', prompt: '审查当前分支' },
]

test('ConversationTimeline：空白会话渲染引导词按钮（非历史编辑锚点）', { timeout: 60_000 }, () => {
  const { html } = renderTimeline({ starters: sampleStarters })
  const slot = extractCenterSlot(html)
  assert.ok(slot !== null, '空白会话应渲染 timeline-center-slot')
  assert.match(slot.html, /timeline-empty-state/)
  assert.match(slot.html, /timeline-starters/)
  const innerIndex = html.indexOf('<div class="timeline-inner">')
  assert.ok(innerIndex >= slot.endIndex, 'timeline-center-slot 必须在 timeline-inner 之前闭合')
  assert.match(html, /写周报/)
  assert.match(html, /代码审查/)
  // 是按钮（可点击回填），不是历史消息胶囊
  assert.doesNotMatch(html, /msg-human-pill/)
  assert.match(TIMELINE_CSS, /\.timeline-starter-btn/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('ConversationTimeline：有更早分页/运行中/发送在途/排队输入/非空历史时不渲染（防误判）', { timeout: 60_000 }, () => {
  // nextCursor 存在：历史未加载完
  const paged = renderTimeline({ starters: sampleStarters, nextCursor: '{"after":5}' })
  assert.doesNotMatch(paged.html, /timeline-starters/)
  const pagedSlot = extractCenterSlot(paged.html)
  assert.ok(pagedSlot !== null, 'nextCursor 存在时应在 timeline-center-slot 中渲染加载更早按钮')
  assert.match(pagedSlot.html, /timeline-load-older-btn/)
  assert.ok(paged.html.indexOf('<div class="timeline-inner">') >= pagedSlot.endIndex)
  // working
  const working = renderTimeline({ starters: sampleStarters, conversation: convSummary('working') })
  assert.doesNotMatch(working.html, /timeline-starters/)
  assert.doesNotMatch(working.html, /timeline-center-slot/)
  // blocked（待审批）
  const blocked = renderTimeline({ starters: sampleStarters, conversation: convSummary('blocked') })
  assert.doesNotMatch(blocked.html, /timeline-starters/)
  // 发送在途
  const sending = renderTimeline({ starters: sampleStarters, sendingPending: true })
  assert.doesNotMatch(sending.html, /timeline-starters/)
  assert.doesNotMatch(sending.html, /timeline-center-slot/)
  // 排队输入
  const queued = renderTimeline({
    starters: sampleStarters,
    live: { queuedInputs: [{ id: 'q1', submissionId: '10', text: 'x', mode: 'followUp', origin: 'human', createdAt: 1 }] },
  })
  assert.doesNotMatch(queued.html, /timeline-starters/)
  // 历史非空
  const nonEmpty = renderTimeline({
    starters: sampleStarters,
    entries: [{ id: 'e1', kind: 'helm.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
  })
  assert.doesNotMatch(nonEmpty.html, /timeline-starters/)
  assert.doesNotMatch(nonEmpty.html, /timeline-center-slot/, '非空且无前置状态时不渲染空 timeline-center-slot 占位')
  // 非空但有更早分页 / 加载错误 / 正在加载：前置居中槽包裹对应元素并位于 timeline-inner 之前
  const nonEmptyPaged = renderTimeline({
    starters: sampleStarters,
    nextCursor: '{"after":2}',
    entries: [{ id: 'e1', kind: 'helm.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
  })
  const nonEmptyPagedSlot = extractCenterSlot(nonEmptyPaged.html)
  assert.ok(nonEmptyPagedSlot !== null)
  assert.match(nonEmptyPagedSlot.html, /timeline-load-older-btn/)
  assert.ok(nonEmptyPaged.html.indexOf('<div class="timeline-inner">') >= nonEmptyPagedSlot.endIndex)

  const loadingState = renderTimeline({ omitDetail: true })
  const loadingSlot = extractCenterSlot(loadingState.html)
  assert.ok(loadingSlot !== null)
  assert.match(loadingSlot.html, /timeline-loading-state/)

  const errState = renderTimeline({
    entries: [{ id: 'e1', kind: 'helm.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
    loadErrors: { 'history:7': '历史加载失败' },
  })
  const errSlot = extractCenterSlot(errState.html)
  assert.ok(errSlot !== null)
  assert.match(errSlot.html, /历史加载失败/)
  // starters 空列表
  const emptyList = renderTimeline({ starters: [] })
  assert.doesNotMatch(emptyList.html, /timeline-starters/)
  assert.ok(extractCenterSlot(emptyList.html) !== null, '空会话仍有 empty-state 处于 timeline-center-slot')
})
