/**
 * space-navigation.ts 与 theme-preferences.ts 纯逻辑单元测试（零 React / DOM 依赖）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, Profile } from '@helm/protocol'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import {
  applyScreenParamsPatch,
  defaultSpaceTarget,
  deletedConversationFallbackTarget,
  isSpaceTargetAvailable,
  partitionScreenParamsPatch,
  resolveSpaceSwitch,
  type SpaceTargetInput,
} from '../src/lib/space-navigation.js'
import {
  getStoredPreference,
  getStoredQuietNotify,
  getSystemTheme,
  nextThemePreference,
  persistQuietNotify,
  persistThemePreference,
  QUIET_NOTIFY_STORAGE_KEY,
  resolveTheme,
  THEME_STORAGE_KEY,
} from '../src/lib/theme-preferences.js'
import { groupUiContributions, type ResolvedTarget } from '../src/lib/types.js'

function makeConversation(overrides: Partial<ConversationSummary> & { id: number }): ConversationSummary {
  return {
    title: `会话 ${overrides.id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: overrides.id,
    updatedAt: overrides.id,
    ...overrides,
  }
}

function makeProfile(id: string, overrides: Partial<Profile> = {}): Profile {
  return { id, name: id, ...overrides }
}

function makeInput(overrides: Partial<SpaceTargetInput> = {}): SpaceTargetInput {
  return {
    conversations: [],
    profiles: [],
    plugins: [],
    assetsLoaded: true,
    grouped: groupUiContributions([]),
    ...overrides,
  }
}

function createMemoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map<string, string>(Object.entries(initial))
  return {
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
    getItem(key: string) {
      return store.get(key) ?? null
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    removeItem(key: string) {
      store.delete(key)
    },
    setItem(key: string, value: string) {
      store.set(key, String(value))
    },
  }
}

// ---------------------------------------------------------------------------
// space-navigation: isSpaceTargetAvailable
// ---------------------------------------------------------------------------

test('isSpaceTargetAvailable：会话目标按列表存在性判定，系统中心恒可用', { timeout: 60_000 }, () => {
  const input = makeInput({ conversations: [makeConversation({ id: 7 })] })
  assert.equal(isSpaceTargetAvailable({ kind: 'conversation', conversationId: 7 }, input), true)
  assert.equal(isSpaceTargetAvailable({ kind: 'conversation', conversationId: 99 }, input), false)

  for (const center of [
    { kind: 'profiles' },
    { kind: 'models' },
    { kind: 'skills' },
    { kind: 'nodes' },
    { kind: 'plugins' },
  ] satisfies ResolvedTarget[]) {
    assert.equal(isSpaceTargetAvailable(center, makeInput()), true)
  }
})

test('isSpaceTargetAvailable：agent 在资产未就绪时放行，就绪后校验角色存在性', { timeout: 60_000 }, () => {
  const target: ResolvedTarget = { kind: 'agent', profileId: 'coder' }
  assert.equal(isSpaceTargetAvailable(target, makeInput({ assetsLoaded: false, profiles: [] })), true)
  assert.equal(isSpaceTargetAvailable(target, makeInput({ assetsLoaded: true, profiles: [] })), false)
  assert.equal(
    isSpaceTargetAvailable(target, makeInput({ assetsLoaded: true, profiles: [makeProfile('coder')] })),
    true,
  )
})

test('isSpaceTargetAvailable：screen 仅在仍存在对应启用贡献时可用', { timeout: 60_000 }, () => {
  const grouped = groupUiContributions([
    { pluginId: 'test:ui', surface: 'screen', spec: { id: 'board', label: '看板' } },
  ])
  const input = makeInput({ grouped })
  assert.equal(isSpaceTargetAvailable({ kind: 'screen', pluginId: 'test:ui', screenId: 'board' }, input), true)
  assert.equal(isSpaceTargetAvailable({ kind: 'screen', pluginId: 'test:ui', screenId: 'other' }, input), false)
  assert.equal(isSpaceTargetAvailable({ kind: 'screen', pluginId: 'disabled:ui', screenId: 'board' }, input), false)
})

// ---------------------------------------------------------------------------
// space-navigation: defaultSpaceTarget & resolveSpaceSwitch
// ---------------------------------------------------------------------------

test('defaultSpaceTarget：settings 返回角色中心；views 取首个可解析为 screen 的排序侧栏项', { timeout: 60_000 }, () => {
  assert.deepEqual(defaultSpaceTarget('settings', makeInput()), { kind: 'profiles' })

  const grouped = groupUiContributions([
    { pluginId: 'p1', surface: 'sidebar.item', spec: { id: 'non-screen', label: '会话项', target: 'profiles', order: 1 } },
    { pluginId: 'p2', surface: 'sidebar.item', spec: { id: 'second', label: '第二', target: 'screen:p2/second', order: 20 } },
    { pluginId: 'p1', surface: 'sidebar.item', spec: { id: 'first', label: '第一', target: 'screen:p1/first?tab=all', order: 10 } },
  ])
  assert.deepEqual(defaultSpaceTarget('views', makeInput({ grouped })), {
    kind: 'screen',
    pluginId: 'p1',
    screenId: 'first',
    params: { tab: 'all' },
  })
  assert.equal(defaultSpaceTarget('views', makeInput()), null)
})

test('defaultSpaceTarget：conversations 优先最新未归档根会话所属角色，并过滤已停用插件角色', { timeout: 60_000 }, () => {
  const profiles = [
    makeProfile('disabled-plugin-bot', { managedByPlugin: 'plugin:off' }),
    makeProfile('system-singleton', { humanSelectable: false }),
    makeProfile('assistant'),
    makeProfile('reviewer'),
  ]
  const plugins = [
    { id: 'plugin:off', enabled: false },
    { id: 'plugin:on', enabled: true },
  ]
  const conversations = [
    // 子会话即使 updatedAt 更新也不参与根会话竞争
    makeConversation({ id: 10, profileId: 'reviewer', parentConversationId: 1, updatedAt: 999 }),
    // 已归档根会话同样不参与
    makeConversation({ id: 11, profileId: 'reviewer', tags: [ARCHIVED_TAG], updatedAt: 900 }),
    // 最新有效根会话（updatedAt 并列取 id 较大者）
    makeConversation({ id: 2, profileId: 'assistant', updatedAt: 50 }),
    makeConversation({ id: 5, profileId: 'reviewer', updatedAt: 50 }),
  ]

  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({ conversations, profiles, plugins })),
    { kind: 'agent', profileId: 'reviewer' },
  )

  // 最新根会话所属角色已失效且资产已加载：退回到可用角色
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      conversations: [makeConversation({ id: 9, profileId: 'deleted-profile', updatedAt: 100 })],
      profiles,
      plugins,
      assetsLoaded: true,
    })),
    { kind: 'agent', profileId: 'assistant' },
  )

  // 资产未加载完时信任最新根会话所属角色
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      conversations: [makeConversation({ id: 9, profileId: 'loading-profile', updatedAt: 100 })],
      profiles: [],
      plugins,
      assetsLoaded: false,
    })),
    { kind: 'agent', profileId: 'loading-profile' },
  )

  // 无有效根会话时：跳过停用插件托管角色，优先 humanSelectable !== false
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({ conversations: [], profiles, plugins })),
    { kind: 'agent', profileId: 'assistant' },
  )

  // 仅剩 humanSelectable=false 的可见角色时兜底返回该角色
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      profiles: [makeProfile('disabled-plugin-bot', { managedByPlugin: 'plugin:off' }), makeProfile('system-singleton', { humanSelectable: false })],
      plugins,
    })),
    { kind: 'agent', profileId: 'system-singleton' },
  )

  // 无任何可用角色返回 null
  assert.equal(defaultSpaceTarget('conversations', makeInput()), null)
})

test('resolveSpaceSwitch：同空间 no-op；优先可用记忆；失效记忆清理并回退缺省或报错', { timeout: 60_000 }, () => {
  const input = makeInput({
    conversations: [makeConversation({ id: 1, profileId: 'assistant', updatedAt: 10 })],
    profiles: [makeProfile('assistant')],
  })

  // 已在目标空间：no-op
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'conversation', conversationId: 1 }, {}, input),
    { kind: 'already-in-space' },
  )

  // 命中有效记忆
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'profiles' }, { conversations: { kind: 'conversation', conversationId: 1 } }, input),
    { kind: 'navigate', target: { kind: 'conversation', conversationId: 1 }, clearStaleMemory: false },
  )

  // 记忆失效（会话已删除）-> 标记清理记忆并回退空间缺省
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'profiles' }, { conversations: { kind: 'conversation', conversationId: 999 } }, input),
    { kind: 'navigate', target: { kind: 'agent', profileId: 'assistant' }, clearStaleMemory: true },
  )

  // views 无记忆且无可用视图 -> unavailable 且无需清记忆
  assert.deepEqual(
    resolveSpaceSwitch('views', { kind: 'profiles' }, {}, input),
    { kind: 'unavailable', clearStaleMemory: false },
  )

  // views 记忆失效且也无可用视图 -> unavailable 且清理失效记忆
  assert.deepEqual(
    resolveSpaceSwitch('views', { kind: 'profiles' }, { views: { kind: 'screen', pluginId: 'gone', screenId: 'view' } }, input),
    { kind: 'unavailable', clearStaleMemory: true },
  )
})

// ---------------------------------------------------------------------------
// space-navigation: deletedConversationFallbackTarget & screen params patch
// ---------------------------------------------------------------------------

test('deletedConversationFallbackTarget：无摘要回角色中心；远端坐标保留，local/空串省略', { timeout: 60_000 }, () => {
  assert.deepEqual(deletedConversationFallbackTarget(undefined), { kind: 'profiles' })
  assert.deepEqual(
    deletedConversationFallbackTarget({ profileId: 'assistant', nodeId: 'local', cwd: '/tmp' }),
    { kind: 'agent', profileId: 'assistant', cwd: '/tmp' },
  )
  assert.deepEqual(
    deletedConversationFallbackTarget({ profileId: 'assistant', nodeId: 'gpu-1', cwd: '/remote/dir' }),
    { kind: 'agent', profileId: 'assistant', nodeId: 'gpu-1', cwd: '/remote/dir' },
  )
  assert.deepEqual(
    deletedConversationFallbackTarget({ profileId: 'assistant', nodeId: '', cwd: '' }),
    { kind: 'agent', profileId: 'assistant' },
  )
})

test('partitionScreenParamsPatch 与 applyScreenParamsPatch：过滤非法键/原型键，正确增删并保持空 params 精简', { timeout: 60_000 }, () => {
  const patch = {
    tab: 'logs',
    filter: undefined,
    empty: '',
    'bad space': '1',
    ['__proto__']: 'x',
    constructor: 'y',
    prototype: 'z',
  } as Record<string, string | undefined>
  const { validEntries, invalidKeys } = partitionScreenParamsPatch(patch)
  assert.deepEqual(validEntries, [['tab', 'logs'], ['filter', undefined], ['empty', '']])
  assert.deepEqual(invalidKeys, ['bad space', '__proto__', 'constructor', 'prototype'])

  const screen: ResolvedTarget = {
    kind: 'screen',
    pluginId: 'p',
    screenId: 's',
    params: { filter: 'old', keep: 'yes' },
  }
  const patched = applyScreenParamsPatch(screen, validEntries)
  assert.deepEqual(patched, {
    kind: 'screen',
    pluginId: 'p',
    screenId: 's',
    params: { keep: 'yes', tab: 'logs' },
  })

  // 删空所有参数后不保留 params 字段
  const emptied = applyScreenParamsPatch(patched, [['keep', undefined], ['tab', undefined]])
  assert.deepEqual(emptied, { kind: 'screen', pluginId: 'p', screenId: 's' })
  assert.equal('params' in emptied, false)

  // 非 screen 目标原样返回
  const convTarget: ResolvedTarget = { kind: 'conversation', conversationId: 1 }
  assert.equal(applyScreenParamsPatch(convTarget, validEntries), convTarget)
})

// ---------------------------------------------------------------------------
// theme-preferences
// ---------------------------------------------------------------------------

test('theme-preferences：主题偏好读写、循环切换与系统配色解析', { timeout: 60_000 }, () => {
  const storage = createMemoryStorage()
  assert.equal(getStoredPreference(storage), 'system')

  persistThemePreference('dark', storage)
  assert.equal(storage.getItem(THEME_STORAGE_KEY), 'dark')
  assert.equal(getStoredPreference(storage), 'dark')

  persistThemePreference('light', storage)
  assert.equal(getStoredPreference(storage), 'light')

  persistThemePreference('system', storage)
  assert.equal(storage.getItem(THEME_STORAGE_KEY), null)
  assert.equal(getStoredPreference(storage), 'system')

  storage.setItem(THEME_STORAGE_KEY, 'invalid-value')
  assert.equal(getStoredPreference(storage), 'system')

  assert.equal(nextThemePreference('system'), 'light')
  assert.equal(nextThemePreference('light'), 'dark')
  assert.equal(nextThemePreference('dark'), 'system')

  assert.equal(getSystemTheme(() => ({ matches: true })), 'dark')
  assert.equal(getSystemTheme(() => ({ matches: false })), 'light')
  assert.equal(resolveTheme('light', 'dark'), 'light')
  assert.equal(resolveTheme('dark', 'light'), 'dark')
  assert.equal(resolveTheme('system', 'dark'), 'dark')
  assert.equal(resolveTheme('system', 'light'), 'light')
})

test('theme-preferences：安静通知开关读写与存储异常安全兜底', { timeout: 60_000 }, () => {
  const storage = createMemoryStorage()
  assert.equal(getStoredQuietNotify(storage), false)

  persistQuietNotify(true, storage)
  assert.equal(storage.getItem(QUIET_NOTIFY_STORAGE_KEY), '1')
  assert.equal(getStoredQuietNotify(storage), true)

  persistQuietNotify(false, storage)
  assert.equal(storage.getItem(QUIET_NOTIFY_STORAGE_KEY), null)
  assert.equal(getStoredQuietNotify(storage), false)

  const brokenStorage = {
    getItem() { throw new Error('quota/security error') },
    setItem() { throw new Error('quota/security error') },
    removeItem() { throw new Error('quota/security error') },
  }
  assert.equal(getStoredPreference(brokenStorage), 'system')
  assert.equal(getStoredQuietNotify(brokenStorage), false)
  assert.doesNotThrow(() => persistThemePreference('dark', brokenStorage))
  assert.doesNotThrow(() => persistQuietNotify(true, brokenStorage))
})
