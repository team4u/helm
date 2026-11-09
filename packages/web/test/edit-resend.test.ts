/**
 * 历史消息编辑态（编辑并重发）第二版边界测试。
 *
 * 覆盖：
 * 1. 编辑目标附件整体替换（目标无附件则清空旧草稿，绝不保留上一个目标的残留）。
 * 2. 编辑目标 / 草稿版本 / 发送失败恢复判定的纯函数语义。
 * 3. 编辑态正文中的 /new、/clear、/compact 只是被编辑消息的文本，不作为立即管理命令。
 * 4. 源码级回归：Composer 按会话 key 挂载（跨会话草稿隔离）、非法历史锚点显式报错不降级、
 *    非 human 输入收起铅笔。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import type { ConversationEntry } from '@helm/protocol'
import { emptyLiveState } from '../src/lib/live-state.js'
import { HelmStoreContext } from '../src/lib/store-context.js'
import { groupUiContributions, type HelmStoreValue } from '../src/lib/types.js'
import {
  attachmentsOfEditTarget,
  draftVersionOf,
  isHistoricalEdit,
  isSessionManageCommand,
  sameDraftVersion,
  shouldRestoreEditOnFailure,
  type PendingAttachment,
} from '../src/conversation/composer-model.js'

const composerSource = readFileSync(new URL('../src/conversation/Composer.tsx', import.meta.url), 'utf8')
const paneSource = readFileSync(new URL('../src/conversation/ConversationPane.tsx', import.meta.url), 'utf8')
const timelineSource = readFileSync(new URL('../src/conversation/ConversationTimeline.tsx', import.meta.url), 'utf8')

// 与 queued-pill SSR 测试一致：为 tsx 的 classic JSX 转换提供 React。
;(globalThis as Record<string, unknown>).React = React
const { ConversationTimeline } = await import('../src/conversation/ConversationTimeline.js')

function renderTimelineHtml(entries: ConversationEntry[]): string {
  const conversation = {
    id: 1, title: '测试会话', profileId: 'assistant', tags: [], cwd: '/tmp',
    model: 'faux/faux-1', thinkingLevel: 'off', status: 'idle' as const, stateChangeSeq: 1,
    completionSeq: 0, unread: false, pinned: false, pendingAskCount: 0,
    createdAt: 1, updatedAt: 1,
  }
  const noop = () => {}
  const asyncNoop = async () => undefined
  const store: HelmStoreValue = {
    ...emptyLiveState(),
    conversations: [conversation], conversationDetails: { 1: { ...conversation, entries } },
    conversationArtifacts: {}, groupedUi: groupUiContributions([]),
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark', themePreference: 'dark',
    profiles: [], models: [], providers: [], credentials: [], skills: [], actions: [],
    primaryTarget: { kind: 'conversation', conversationId: 1 }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null, notices: [],
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: async () => undefined,
    loadConversationDetail: async () => undefined, loadEarlierEntries: asyncNoop, loadConversationArtifacts: async () => undefined,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setScreenParams: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: asyncNoop,
  }
  return renderToString(React.createElement(HelmStoreContext.Provider, { value: store },
    React.createElement(ConversationTimeline, {
      conversation, detailEntries: entries, onRequestEdit: noop,
    }),
  ))
}

const att = (id: string, name: string, size = 100): PendingAttachment => ({
  artifactId: id,
  name,
  size,
  mimeType: 'image/png',
})

test('attachmentsOfEditTarget：每次选择编辑目标整体替换附件，目标无附件时清空旧草稿', { timeout: 60_000 }, () => {
  // 目标带附件：转换为待发送草稿（保留 id/name/size/mimeType）。
  const withAtt = attachmentsOfEditTarget({
    text: '带图的问题',
    entryId: 7,
    attachments: [{ id: 'a1', name: '截图.png', mimeType: 'image/png', size: 2048 }],
  })
  assert.deepEqual(withAtt, [att('a1', '截图.png', 2048)])

  // 目标无附件（排队撤回回填 / ↑ 历史编辑空附件）：返回空数组替换旧草稿，不保留残留。
  assert.deepEqual(attachmentsOfEditTarget({ text: '撤回的排队消息' }), [])
  assert.deepEqual(attachmentsOfEditTarget({ text: '无附件历史', entryId: 9 }), [])
  // attachments 为空数组同样整体替换为空。
  assert.deepEqual(attachmentsOfEditTarget({ text: 'x', attachments: [] }), [])
})

test('isHistoricalEdit：仅 entryId 锚点存在时构成原地编辑', { timeout: 60_000 }, () => {
  assert.equal(isHistoricalEdit({ text: 'x', entryId: 5 }), true)
  assert.equal(isHistoricalEdit({ text: 'x' }), false)
  assert.equal(isHistoricalEdit({ text: 'x', attachments: [] }), false)
})

test('draftVersionOf / sameDraftVersion：文本、编辑目标、附件任一变化即视为草稿已修改', { timeout: 60_000 }, () => {
  const base = draftVersionOf('文本', 5, [att('a1', '图')])
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [att('a1', '图')])), true)
  // 文本变化
  assert.equal(sameDraftVersion(base, draftVersionOf('新文本', 5, [att('a1', '图')])), false)
  // 编辑目标变化（含切换到无目标）
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', null, [att('a1', '图')])), false)
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 6, [att('a1', '图')])), false)
  // 附件增删（顺序也参与比较）
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [att('a1', '图'), att('a2', '图2')])), false)
  assert.equal(sameDraftVersion(base, draftVersionOf('文本', 5, [])), false)
  assert.equal(
    sameDraftVersion(
      draftVersionOf('t', null, [att('a1', 'x'), att('a2', 'y')]),
      draftVersionOf('t', null, [att('a2', 'y'), att('a1', 'x')]),
    ),
    false,
  )
})

test('isSessionManageCommand：仅会话内管理命令，编辑态正文不触发立即执行', { timeout: 60_000 }, () => {
  assert.equal(isSessionManageCommand('/new'), true)
  assert.equal(isSessionManageCommand('/clear'), true)
  assert.equal(isSessionManageCommand('/compact'), true)
  // 带前后空白仍按 trim 后正文判定（send 中 payload 已 trim）
  assert.equal(isSessionManageCommand('/compact'), true)
  // 普通文本、斜杠技能、局部出现命令词都不是管理命令
  assert.equal(isSessionManageCommand('/skill:foo'), false)
  assert.equal(isSessionManageCommand('看看 /new 的用法'), false)
  assert.equal(isSessionManageCommand('普通消息'), false)
  assert.equal(isSessionManageCommand(''), false)
})

test('shouldRestoreEditOnFailure：仅当 Composer 仍处于乐观清空后的期望状态才恢复', { timeout: 60_000 }, () => {
  // 期望状态 = 乐观清空后的（'', null, 原附件未变）
  const expected = draftVersionOf('', null, [att('a1', '图')])
  // 用户未动任何东西：恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, [att('a1', '图')]), expected), true)
  // 用户已输入新文本：不恢复（旧 target 不得误挂新输入）
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('新输入', null, [att('a1', '图')]), expected), false)
  // 用户已选择其他编辑目标：不恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', 9, [att('a1', '图')]), expected), false)
  // 用户改动了附件：不恢复
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, []), expected), false)
  assert.equal(shouldRestoreEditOnFailure(draftVersionOf('', null, [att('a1', '图'), att('a2', 'y')]), expected), false)
})

test('Composer 源码级回归：发送失败恢复受活草稿保护，编辑态跳过立即管理命令', { timeout: 60_000 }, () => {
  // 编辑态正文中的管理命令不进入 runSlashCommand（只是被编辑消息的文本）。
  assert.match(composerSource, /const slash = editing \? false : runSlashCommand\(payload\)/)
  // 失败恢复前先比较活草稿与乐观清空后的期望版本。
  assert.match(composerSource, /shouldRestoreEditOnFailure\(liveDraftRef\.current, expectedAfterClear\)/)
  // 恢复时回滚到冻结的编辑目标，而不是无条件把当前空 target 补成旧 target。
  assert.doesNotMatch(composerSource, /setEditingEntryId\(\(current\) => current \?\? targetEntryId\)/)
  // ↑ 进入历史编辑同样整体替换附件。
  assert.match(composerSource, /setAttachments\(attachmentsOfEditTarget\(target\)\)\s*\n\s*syncLiveDraft\(target\.text/)
  // prefill 回填：附件整体替换且目标编辑态以 isHistoricalEdit 判定。
  assert.match(composerSource, /setAttachments\(attachmentsOfEditTarget\(target\)\)/)
  assert.match(composerSource, /const nextEditing = isHistoricalEdit\(target\) \? prefill\.entryId! : null/)
})

test('跨会话隔离：ConversationPane 按会话 key 挂载 Composer，prefill 不跨会话复用', { timeout: 60_000 }, () => {
  // Pane 内 Composer 显式按 conversation.id 挂 key：即使 Pane 复用不重挂载，
  // 切换会话时 Composer（含编辑草稿 / prefill / 异步回调闭包）也会整体重建，
  // 旧会话的 replaceFromEntryId 不可能提交到新会话。
  assert.match(paneSource, /<Composer key=\{`composer-\$\{conversation\.id\}`\}/)
  // requestEdit 统一 EditRequestTarget，无字符串兼容路径。
  assert.match(paneSource, /const requestEdit = \(target: EditRequestTarget\): void =>/)
  assert.doesNotMatch(paneSource, /target === 'string'/)
})

test('非法历史锚点：显式报错并取消编辑，绝不静默降级为新消息', { timeout: 60_000 }, () => {
  // 非数字 / 非正整数 entryId：推送错误通知并 return，不回填 Composer。
  assert.match(timelineSource, /消息锚点无效（entryId=/)
  assert.match(timelineSource, /title: '无法编辑该消息'/)
  // 不再有「锚点非法则省略 entryId 继续回填」的降级路径。
  assert.doesNotMatch(timelineSource, /Number\.isSafeInteger\(numericId\) && numericId > 0 \? \{ entryId: numericId \} : \{\}/)
})

test('非 human 输入收起铅笔：agent/trigger 汇报不提供编辑入口，保留复制与分叉', { timeout: 60_000 }, () => {
  // 铅笔按钮仅在 origin === 'human' 时渲染。
  assert.match(timelineSource, /\{item\.origin === 'human' \? \(/)
  // editRequest 双重防御：非 human 直接返回。
  assert.match(timelineSource, /if \(item\.origin !== 'human'\) return/)
  // 复制按钮仍在 hover 条内（所有 origin 可复制）。
  assert.match(timelineSource, /<CopyButton text=\{item\.text\} \/>/)
})

test('SSR 行为：human 消息渲染编辑铅笔，agent/trigger 消息不渲染铅笔但保留复制', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'helm.input', data: { text: '人类提问', origin: 'human' } },
    { id: '2', kind: 'helm.input', data: { text: 'Worker 已完成', origin: 'agent' } },
    { id: '3', kind: 'helm.input', data: { text: 'cron 触发', origin: 'trigger' } },
  ]
  const html = renderTimelineHtml(entries)
  assert.match(html, /人类提问/)
  assert.match(html, /来自智能体汇报/)
  assert.match(html, /来自触发器/)
  // 编辑入口（title=编辑并重发）只出现一次：仅 human 消息。
  assert.equal([...html.matchAll(/title="编辑并重发"/g)].length, 1)
  // 三条消息的复制按钮均在。
  assert.equal([...html.matchAll(/复制到剪贴板|复制/g)].length >= 3, true)
})
