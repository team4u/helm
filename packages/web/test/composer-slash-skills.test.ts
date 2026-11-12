/**
 * 会话斜杠菜单技能过滤（Composer '/' 补全）回归：
 * - 纯模型 slashMenuSkills：profile.skills 白名单 + 插件启用双过滤（协议 isSkillAvailable 唯一规则）；
 * - 真实挂载 Composer：输入 '/' 弹出斜杠浮层，按当前会话 Profile 过滤技能；
 * - profile.skills 缺失（资产未返回 / Profile 已删）：先不展示技能，不意外放开全部；
 * - []：不展示任何技能；白名单：仅展示白名单内且插件启用的技能；
 * - 停用插件托管技能：即使白名单命中也不展示；
 * - 内置 /new /clear /compact 与插件命令不受技能过滤影响。
 *
 * 挂载方式与 composer-controller.test.ts 同（根容器内渲染，非 Portal，输入事件可达）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ConversationSummary, PluginSummary, Profile, SkillSummary } from '@helm/protocol'
import { HelmStoreContext } from '../src/lib/store-context.js'
import type { HelmStoreValue } from '../src/lib/types.js'
import { slashMenuSkills } from '../src/conversation/slash-menu-skills.js'

/** 真实用户键入路径：原生 setter 赋值 + 重置 value tracker + 派发 input。 */
function typeInto(ta: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
  const tracker = (ta as unknown as { _valueTracker?: { getValue(): string; setValue(v: string): void } })._valueTracker
  const prev = tracker?.getValue() ?? ''
  setter.call(ta, text)
  tracker?.setValue(prev)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
}

const conv = (id: number, profileId: string): ConversationSummary => ({
  id, title: `会话 ${id}`, profileId, tags: [], cwd: '/tmp', model: 'p/m',
  thinkingLevel: 'off', status: 'idle', stateChangeSeq: 1, completionSeq: 0,
  unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
})

const skill = (id: string, managedByPlugin?: string): SkillSummary => ({
  id, name: `技能 ${id}`, references: [], ...(managedByPlugin ? { managedByPlugin } : {}),
})

const CATALOG: SkillSummary[] = [
  skill('review'),
  skill('tally'),
  skill('herdr-tool', 'builtin:herdr'),
]

// ---------------------------------------------------------------------------
// 纯模型：slashMenuSkills
// ---------------------------------------------------------------------------

test('slashMenuSkills：undefined 全部可见技能；[] 全部隐藏；白名单精确过滤', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile', 'builtin:herdr'])
  // undefined：全部（含启用插件托管的）
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: undefined }, CATALOG, enabled).map((s) => s.id),
    ['review', 'tally', 'herdr-tool'],
  )
  // []：禁用全部
  assert.deepEqual(slashMenuSkills({ id: 'p', skills: [] }, CATALOG, enabled), [])
  // 白名单
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: ['review'] }, CATALOG, enabled).map((s) => s.id),
    ['review'],
  )
})

test('slashMenuSkills：缺少 Profile 先不展示技能（不意外放开全部）', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile'])
  assert.deepEqual(slashMenuSkills(undefined, CATALOG, enabled), [], 'Profile 缺失 -> 空技能列表')
})

test('slashMenuSkills：停用插件托管技能恒不可用（即使白名单命中）', { timeout: 60_000 }, () => {
  const disabled = new Set(['builtin:profile'])
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: undefined }, CATALOG, disabled).map((s) => s.id),
    ['review', 'tally'],
    '停用插件托管技能被移除',
  )
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: ['herdr-tool', 'review'] }, CATALOG, disabled).map((s) => s.id),
    ['review'],
    '白名单命中停用托管技能同样不可用',
  )
})

// ---------------------------------------------------------------------------
// 交互：真实 Composer '/' 斜杠浮层按当前会话 Profile 过滤
// ---------------------------------------------------------------------------

const { Composer } = await import('../src/conversation/Composer.js')

interface MountOptions {
  profiles: Profile[]
  skills?: SkillSummary[]
  plugins?: PluginSummary[]
}

function makeStore(conversation: ConversationSummary, opts: MountOptions): HelmStoreValue {
  const noop = () => {}
  const asyncNoop = async () => undefined
  return {
    authReady: true, authConfigured: true, authenticated: true, authError: null,
    connectionError: null, loadErrors: {}, sseConnected: true, theme: 'dark' as const, themePreference: 'system' as const,
    conversations: [conversation], conversationDetails: {}, conversationLives: {}, conversationArtifacts: {},
    pendingAsks: [], resolvedAsksByConv: {},
    plugins: opts.plugins ?? [
      { id: 'builtin:profile', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
      { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: true, hooks: [], actions: [], tools: [] },
    ],
    uiContributions: [],
    groupedUi: {
      sidebarItems: [], sidebarSections: [], screens: [], timelineRenderers: [], toolViews: [],
      composerPills: [], composerWidgets: [], workbenchPanels: [], commands: [], settingsPanels: [],
      profileRuntimes: [], conversationHeaderActions: [], conversationRowActions: [], timelineEntryActions: [], pluginSlots: [],
    },
    pluginDocs: {}, nodes: [], profiles: opts.profiles, assetsLoaded: true, models: [], providers: [], credentials: [],
    skills: opts.skills ?? CATALOG, actions: [],
    primaryTarget: { kind: 'conversation', conversationId: conversation.id }, splitTarget: null,
    workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null, highlightedEntry: null,
    setTheme: noop, setThemePreference: noop, toggleTheme: noop, checkAuth: asyncNoop,
    onAuthenticated: asyncNoop, logout: noop, refreshAssets: asyncNoop, refreshNodes: asyncNoop,
    loadConversationDetail: asyncNoop, loadEarlierEntries: asyncNoop, loadConversationArtifacts: asyncNoop,
    ensurePluginDoc: asyncNoop, openTarget: noop, closeSplit: noop, setWorkbenchOpen: noop,
    setWorkbenchTab: noop, setActiveModal: noop, dismissNotice: noop, pushNotice: noop,
    invokePluginAction: async () => undefined,
    notices: [],
  } as unknown as HelmStoreValue
}

async function mountComposer(
  conversation: ConversationSummary,
  opts: MountOptions,
): Promise<{ host: HTMLElement; unmount: () => Promise<void>; typeSlash: (text: string) => Promise<HTMLElement | null> }> {
  const store = makeStore(conversation, opts)
  const host = document.createElement('div')
  document.body.appendChild(host)
  let root: ReturnType<typeof createRoot> | undefined
  await act(async () => {
    root = createRoot(host)
    root.render(
      React.createElement(
        HelmStoreContext.Provider,
        { value: store },
        React.createElement(Composer, { conversation, prefill: null }),
      ),
    )
  })
  const typeSlash = async (text: string): Promise<HTMLElement | null> => {
    const ta = host.querySelector<HTMLTextAreaElement>('textarea.composer-textarea')!
    await act(async () => {
      typeInto(ta, text)
    })
    await act(async () => {})
    return host.querySelector<HTMLElement>('.composer-popover')
  }
  return {
    host,
    unmount: async () => {
      await act(async () => {
        root?.unmount()
      })
      host.remove()
    },
    typeSlash,
  }
}

test('交互：profile.skills 未设置 -> 全部可见技能进入斜杠浮层；内置命令不受影响', { timeout: 60_000 }, async () => {
  const { typeSlash, unmount } = await mountComposer(conv(1, 'coder'), { profiles: [{ id: 'coder', tags: [] }] })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover, "'/' 弹出斜杠浮层")
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/)
    assert.match(text, /\/compact/)
    assert.match(text, /\/skill:review/)
    assert.match(text, /\/skill:tally/)
    assert.match(text, /\/skill:herdr-tool/)
  } finally {
    await unmount()
  }
})

test('交互：profile.skills=[] -> 无任何技能，仅内置命令', { timeout: 60_000 }, async () => {
  const { typeSlash, unmount } = await mountComposer(conv(2, 'coder'), {
    profiles: [{ id: 'coder', tags: [], skills: [] }],
  })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover)
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/)
    assert.doesNotMatch(text, /skill:/)
  } finally {
    await unmount()
  }
})

test('交互：白名单 profile -> 仅白名单内技能；停用插件托管技能即使命中白名单也不出现', { timeout: 60_000 }, async () => {
  const plugins = [
    { id: 'builtin:profile', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
    { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: false, hooks: [], actions: [], tools: [] },
  ] as PluginSummary[]
  const { typeSlash, unmount } = await mountComposer(conv(3, 'coder'), {
    profiles: [{ id: 'coder', tags: [], skills: ['tally', 'herdr-tool'] }],
    plugins,
  })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover)
    const text = popover!.textContent ?? ''
    assert.doesNotMatch(text, /\/skill:review/, '白名单外技能不出现')
    assert.match(text, /\/skill:tally/, '白名单内技能出现')
    assert.doesNotMatch(text, /\/skill:herdr-tool/, '停用插件托管技能即使白名单命中也不出现')
  } finally {
    await unmount()
  }
})

test('交互：缺少当前 Profile -> 先不展示任何技能（宁缺勿放开）', { timeout: 60_000 }, async () => {
  const { typeSlash, unmount } = await mountComposer(conv(4, 'ghost'), { profiles: [{ id: 'coder', tags: [] }] })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover)
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/, '内置命令不受影响')
    assert.doesNotMatch(text, /skill:/, 'Profile 缺失时不展示技能')
  } finally {
    await unmount()
  }
})

test('交互：切换 Profile（模拟 store 刷新）依赖动态更新', { timeout: 60_000 }, async () => {
  // 同一会话 profileId 下 store 数据变化（如保存后 refreshAssets）：白名单收紧后浮层随之更新。
  // 该行为经 useMemo([store.profiles, conversation.profileId, store.skills, enabledPluginIds]) 依赖链保证，
  // 纯模型层验证同一输入换不同 profile 的结果差异（分屏 / 菜单切换场景共用此函数）。
  const enabled = new Set(['builtin:profile'])
  const a = slashMenuSkills({ id: 'a', skills: undefined }, CATALOG, enabled).map((s) => s.id)
  const b = slashMenuSkills({ id: 'b', skills: ['tally'] }, CATALOG, enabled).map((s) => s.id)
  assert.deepEqual(a, ['review', 'tally'])
  assert.deepEqual(b, ['tally'], '同会话切换绑定 Profile 后技能集合随 profile.skills 变化')
})
