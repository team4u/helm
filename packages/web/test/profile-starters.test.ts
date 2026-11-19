/**
 * Profile.starters web tests:
 * 1. Pure functions: draft validation (trim/code-point caps/whitespace-only),
 *    startersToDrafts, visibleStarters;
 * 2. ProfileDetailDrawer SSR: starters editor rendering, zero emoji, error hints;
 * 3. ConversationTimeline SSR: empty conversations show starter buttons whose
 *    clicks only invoke the callback (never rendered as history edits); nothing
 *    shows with earlier pages (nextCursor)/working/queued inputs (anti-misjudge).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readHostStyles } from './helpers/host-styles.js'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ConversationEntry, ConversationSummary, InputOrigin, Profile } from '@helmx/protocol'
import {
  startersToDrafts,
  validateStarterDraft,
  validateStarterDrafts,
  visibleStarters,
  startersAtLimit,
} from '../src/profiles/profile-center-model.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { ConversationTimeline } from '../src/conversation/ConversationTimeline.js'
import { createWebTranslator } from '../src/i18n/catalog.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'

;(globalThis as Record<string, unknown>).React = React
const e = React.createElement
const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}][\u{2600}-\u{26FF}]?[\u{2700}-\u{27BF}]?/u
const STARTERS_CSS = readHostStyles()
const TIMELINE_CSS = STARTERS_CSS

// ---------------------------------------------------------------------------
// 1. Pure functions
// ---------------------------------------------------------------------------

test('starters pure functions: validation edges and shape conversion', { timeout: 60_000 }, () => {
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

test('ProfileDetailDrawer: the starters editor renders existing entries and the count (zero emoji)', { timeout: 60_000 }, () => {
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
  assert.match(html, /2\/6/, 'the count renders 2/6')
  assert.match(html, /Add starter/)
  assert.doesNotMatch(html, EMOJI_REGEX)
  // CSS primitives present
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
        ...(opts.live !== undefined ? { live: store.getConversationLive(conversation.id) } : {}),
        onRequestEdit: () => {},
        onRequestStarter: (text) => { clicks.push(text) },
      }),
    ),
  )
  return { html, clicks }
}

/** Extract the full `.timeline-center-slot` DOM fragment and its end index (verifying the center slot stays strictly separate from `.timeline-inner`). */
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

test('ConversationTimeline: empty conversations render starter buttons (not history edit anchors)', { timeout: 60_000 }, () => {
  const { html } = renderTimeline({ starters: sampleStarters })
  const slot = extractCenterSlot(html)
  assert.ok(slot !== null, 'empty conversations must render timeline-center-slot')
  assert.match(slot.html, /timeline-empty-state/)
  assert.match(slot.html, /timeline-starters/)
  const innerIndex = html.indexOf('<div class="timeline-inner">')
  assert.ok(innerIndex >= slot.endIndex, 'timeline-center-slot must close before timeline-inner')
  assert.match(html, /写周报/)
  assert.match(html, /代码审查/)
  // They are buttons (click-to-fill callbacks), not history message pills
  assert.doesNotMatch(html, /msg-human-pill/)
  assert.match(TIMELINE_CSS, /\.timeline-starter-btn/)
  assert.doesNotMatch(html, EMOJI_REGEX)
})

test('ConversationTimeline: nothing renders with earlier pages/working/sending in flight/queued inputs/non-empty history (anti-misjudge)', { timeout: 60_000 }, () => {
  // nextCursor present: history not fully loaded
  const paged = renderTimeline({ starters: sampleStarters, nextCursor: '{"after":5}' })
  assert.doesNotMatch(paged.html, /timeline-starters/)
  const pagedSlot = extractCenterSlot(paged.html)
  assert.ok(pagedSlot !== null, 'with nextCursor the load-older button must render inside timeline-center-slot')
  assert.match(pagedSlot.html, /timeline-load-older-btn/)
  assert.ok(paged.html.indexOf('<div class="timeline-inner">') >= pagedSlot.endIndex)
  // working
  const working = renderTimeline({ starters: sampleStarters, conversation: convSummary('working') })
  assert.doesNotMatch(working.html, /timeline-starters/)
  assert.doesNotMatch(working.html, /timeline-center-slot/)
  // blocked (pending approval)
  const blocked = renderTimeline({ starters: sampleStarters, conversation: convSummary('blocked') })
  assert.doesNotMatch(blocked.html, /timeline-starters/)
  // Sending in flight
  const sending = renderTimeline({ starters: sampleStarters, sendingPending: true })
  assert.doesNotMatch(sending.html, /timeline-starters/)
  assert.doesNotMatch(sending.html, /timeline-center-slot/)
  // Queued inputs
  const queued = renderTimeline({
    starters: sampleStarters,
    live: { queuedInputs: [{ id: 'q1', submissionId: '10', text: 'x', mode: 'followUp', origin: 'human', createdAt: 1 }] },
  })
  assert.doesNotMatch(queued.html, /timeline-starters/)
  // Non-empty history
  const nonEmpty = renderTimeline({
    starters: sampleStarters,
    entries: [{ id: 'e1', kind: 'helmx.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
  })
  assert.doesNotMatch(nonEmpty.html, /timeline-starters/)
  assert.doesNotMatch(nonEmpty.html, /timeline-center-slot/, 'non-empty history without preamble states must not render an empty timeline-center-slot placeholder')
  // Non-empty with earlier pages / load errors / loading: the center slot wraps those elements and stays before timeline-inner
  const nonEmptyPaged = renderTimeline({
    starters: sampleStarters,
    nextCursor: '{"after":2}',
    entries: [{ id: 'e1', kind: 'helmx.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
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
    entries: [{ id: 'e1', kind: 'helmx.input', data: { id: 'i1', text: 'hello', origin: 'human', createdAt: 1 } }],
    loadErrors: { 'history:7': '历史加载失败' },
  })
  const errSlot = extractCenterSlot(errState.html)
  assert.ok(errSlot !== null)
  assert.match(errSlot.html, /历史加载失败/)
  // Empty starters list
  const emptyList = renderTimeline({ starters: [] })
  assert.doesNotMatch(emptyList.html, /timeline-starters/)
  assert.ok(extractCenterSlot(emptyList.html) !== null, 'empty conversations still keep the empty-state inside timeline-center-slot')
})

test('ProfileDetailDrawer & validateStarterDraft: zh-CN locale renders localized drawer fields, starters and validation errors', { timeout: 60_000 }, () => {
  const zh = createWebTranslator('zh-CN')
  assert.match(validateStarterDraft({ label: '', prompt: 'x' }, zh)!, /标题去除首尾空白后不能为空/)
  assert.match(validateStarterDraft({ label: 'a', prompt: '   ' }, zh)!, /提示词不能是纯空白/)
  assert.match(validateStarterDraft({ label: '🎉'.repeat(25), prompt: 'x' }, zh)!, /最多 24 个 Unicode 码点/)
  assert.match(validateStarterDraft({ label: 'x', prompt: 'y'.repeat(4001) }, zh)!, /最多 4000 个 Unicode 码点/)

  const store = makeTestStore({
    locale: 'zh-CN',
    profiles: [profileWithStarters],
    models: [],
    nodes: [{ id: 'local', kind: 'local', online: true }],
    skills: [],
  })
  const zhEditHtml = renderToStaticMarkup(
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
  assert.match(zhEditHtml, /角色 ID/)
  assert.match(zhEditHtml, /角色名称/)
  assert.match(zhEditHtml, /角色描述/)
  assert.match(zhEditHtml, /默认模型/)
  assert.match(zhEditHtml, /思考档位/)
  assert.match(zhEditHtml, /默认节点/)
  assert.match(zhEditHtml, /工作目录/)
  assert.match(zhEditHtml, /系统提示词 \(SYSTEM\.md\)/)
  assert.match(zhEditHtml, /空白会话引导词/)
  assert.match(zhEditHtml, /添加引导词/)
  assert.match(zhEditHtml, /可用技能白名单/)
  assert.match(zhEditHtml, /删除角色/)
  assert.match(zhEditHtml, /保存角色/)
  assert.doesNotMatch(zhEditHtml, /Empty-conversation starters/)
  assert.doesNotMatch(zhEditHtml, /Save profile/)

  const zhNewHtml = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: null,
        isNew: true,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(zhNewHtml, /新建智能体角色/)
  assert.match(zhNewHtml, /未配置时使用系统默认引导提示。/)
})
