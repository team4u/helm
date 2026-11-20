/**
 * Pure-logic unit tests for space-navigation.ts and theme-preferences.ts (zero React / DOM dependencies).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationSummary, Profile } from '@helmx/protocol'
import { ARCHIVED_TAG } from '../src/conversation/archive-model.js'
import {
  applyScreenParamsPatch,
  defaultSpaceTarget,
  standbyFallbackTarget,
  isSpaceTargetAvailable,
  partitionScreenParamsPatch,
  resolveSpaceSwitch,
  type SpaceTargetInput,
} from '../src/lib/space-navigation.js'
import {
  getStoredPreference,
  getStoredQuietNotify,
  getStoredLocale,
  getStoredLocalePreference,
  getSystemTheme,
  nextThemePreference,
  persistQuietNotify,
  persistThemePreference,
  persistLocale,
  persistLocalePreference,
  QUIET_NOTIFY_STORAGE_KEY,
  resolveBrowserLocale,
  resolveInitialLocale,
  resolveLocale,
  resolveTheme,
  THEME_STORAGE_KEY,
  LOCALE_STORAGE_KEY,
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

test('isSpaceTargetAvailable: conversation targets judged by list presence; the system center is always available', { timeout: 60_000 }, () => {
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

test('isSpaceTargetAvailable: agent passes while assets are not ready; once ready, profile existence is verified', { timeout: 60_000 }, () => {
  const target: ResolvedTarget = { kind: 'agent', profileId: 'coder' }
  assert.equal(isSpaceTargetAvailable(target, makeInput({ assetsLoaded: false, profiles: [] })), true)
  assert.equal(isSpaceTargetAvailable(target, makeInput({ assetsLoaded: true, profiles: [] })), false)
  assert.equal(
    isSpaceTargetAvailable(target, makeInput({ assetsLoaded: true, profiles: [makeProfile('coder')] })),
    true,
  )
})

test('isSpaceTargetAvailable: a screen is available only while a matching enabled contribution still exists', { timeout: 60_000 }, () => {
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

test('defaultSpaceTarget: settings returns the profile center; views takes the first ordered sidebar item resolvable to a screen', { timeout: 60_000 }, () => {
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

test('defaultSpaceTarget: conversations prefers the profile of the latest unarchived root conversation and filters disabled-plugin profiles', { timeout: 60_000 }, () => {
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
    // child conversations never compete as roots even with newer updatedAt
    makeConversation({ id: 10, profileId: 'reviewer', parentConversationId: 1, updatedAt: 999 }),
    // archived root conversations likewise do not compete
    makeConversation({ id: 11, profileId: 'reviewer', tags: [ARCHIVED_TAG], updatedAt: 900 }),
    // the latest valid root conversation (updatedAt ties take the larger id)
    makeConversation({ id: 2, profileId: 'assistant', updatedAt: 50 }),
    makeConversation({ id: 5, profileId: 'reviewer', updatedAt: 50 }),
  ]

  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({ conversations, profiles, plugins })),
    { kind: 'agent', profileId: 'reviewer' },
  )

  // the latest root's profile is gone and assets are loaded: fall back to a usable profile
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      conversations: [makeConversation({ id: 9, profileId: 'deleted-profile', updatedAt: 100 })],
      profiles,
      plugins,
      assetsLoaded: true,
    })),
    { kind: 'agent', profileId: 'assistant' },
  )

  // while assets are not fully loaded, trust the latest root conversation's profile
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      conversations: [makeConversation({ id: 9, profileId: 'loading-profile', updatedAt: 100 })],
      profiles: [],
      plugins,
      assetsLoaded: false,
    })),
    { kind: 'agent', profileId: 'loading-profile' },
  )

  // with no valid root conversation: skip disabled-plugin-managed profiles, preferring humanSelectable !== false
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({ conversations: [], profiles, plugins })),
    { kind: 'agent', profileId: 'assistant' },
  )

  // with only a humanSelectable=false visible profile left, fall back to it
  assert.deepEqual(
    defaultSpaceTarget('conversations', makeInput({
      profiles: [makeProfile('disabled-plugin-bot', { managedByPlugin: 'plugin:off' }), makeProfile('system-singleton', { humanSelectable: false })],
      plugins,
    })),
    { kind: 'agent', profileId: 'system-singleton' },
  )

  // no usable profile at all returns null
  assert.equal(defaultSpaceTarget('conversations', makeInput()), null)
})

test('resolveSpaceSwitch: same space no-op; valid memory first; stale memory cleared with a default fallback or unavailable', { timeout: 60_000 }, () => {
  const input = makeInput({
    conversations: [makeConversation({ id: 1, profileId: 'assistant', updatedAt: 10 })],
    profiles: [makeProfile('assistant')],
  })

  // already in the target space: no-op
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'conversation', conversationId: 1 }, {}, input),
    { kind: 'already-in-space' },
  )

  // 主屏停在总览：总览是带专属按钮的顶层目的地，不算「在对话空间里」——
  // 点击「对话」空间按钮必须跳回记忆目标（或空间缺省），绝不 no-op。
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'overview' }, { conversations: { kind: 'conversation', conversationId: 1 } }, input),
    { kind: 'navigate', target: { kind: 'conversation', conversationId: 1 }, clearStaleMemory: false },
  )
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'overview' }, {}, input),
    { kind: 'navigate', target: { kind: 'agent', profileId: 'assistant' }, clearStaleMemory: false },
  )

  // a valid memory hits
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'profiles' }, { conversations: { kind: 'conversation', conversationId: 1 } }, input),
    { kind: 'navigate', target: { kind: 'conversation', conversationId: 1 }, clearStaleMemory: false },
  )

  // stale memory (conversation deleted) -> marked for cleanup, falling back to the space default
  assert.deepEqual(
    resolveSpaceSwitch('conversations', { kind: 'profiles' }, { conversations: { kind: 'conversation', conversationId: 999 } }, input),
    { kind: 'navigate', target: { kind: 'agent', profileId: 'assistant' }, clearStaleMemory: true },
  )

  // views with no memory and no usable view -> unavailable, nothing to clear
  assert.deepEqual(
    resolveSpaceSwitch('views', { kind: 'profiles' }, {}, input),
    { kind: 'unavailable', clearStaleMemory: false },
  )

  // views with stale memory and no usable view either -> unavailable and the stale memory is cleared
  assert.deepEqual(
    resolveSpaceSwitch('views', { kind: 'profiles' }, { views: { kind: 'screen', pluginId: 'gone', screenId: 'view' } }, input),
    { kind: 'unavailable', clearStaleMemory: true },
  )
})

// ---------------------------------------------------------------------------
// space-navigation: standbyFallbackTarget & screen params patch
// ---------------------------------------------------------------------------

test('standbyFallbackTarget: no summary falls to the profile center; remote coordinates kept, local/empty omitted', { timeout: 60_000 }, () => {
  assert.deepEqual(standbyFallbackTarget(undefined), { kind: 'profiles' })
  assert.deepEqual(
    standbyFallbackTarget({ profileId: 'assistant', nodeId: 'local', cwd: '/tmp' }),
    { kind: 'agent', profileId: 'assistant', cwd: '/tmp' },
  )
  assert.deepEqual(
    standbyFallbackTarget({ profileId: 'assistant', nodeId: 'gpu-1', cwd: '/remote/dir' }),
    { kind: 'agent', profileId: 'assistant', nodeId: 'gpu-1', cwd: '/remote/dir' },
  )
  assert.deepEqual(
    standbyFallbackTarget({ profileId: 'assistant', nodeId: '', cwd: '' }),
    { kind: 'agent', profileId: 'assistant' },
  )
})

test('partitionScreenParamsPatch and applyScreenParamsPatch: illegal/prototype keys filtered; add/delete correct; empty params stay lean', { timeout: 60_000 }, () => {
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

  // after deleting every param, no params field remains
  const emptied = applyScreenParamsPatch(patched, [['keep', undefined], ['tab', undefined]])
  assert.deepEqual(emptied, { kind: 'screen', pluginId: 'p', screenId: 's' })
  assert.equal('params' in emptied, false)

  // non-screen targets return unchanged
  const convTarget: ResolvedTarget = { kind: 'conversation', conversationId: 1 }
  assert.equal(applyScreenParamsPatch(convTarget, validEntries), convTarget)
})

// ---------------------------------------------------------------------------
// theme-preferences
// ---------------------------------------------------------------------------

test('theme-preferences: preference read/write, cycle toggling and system scheme resolution', { timeout: 60_000 }, () => {
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

test('theme-preferences: quiet-notify toggle read/write and storage-failure-safe fallbacks', { timeout: 60_000 }, () => {
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

test('theme-preferences: UI language preference read/write, browser-default resolution and initial locale resolution', { timeout: 60_000 }, () => {
  const storage = createMemoryStorage()
  // no stored preference: undefined (the caller falls back to the browser default)
  assert.equal(getStoredLocale(storage), undefined)

  persistLocale('zh-CN', storage)
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), 'zh-CN')
  assert.equal(getStoredLocale(storage), 'zh-CN')

  persistLocale('en', storage)
  assert.equal(getStoredLocale(storage), 'en')

  // stored values normalize through normalizeLocaleTag: zh-* -> zh-CN, illegal/unsupported -> en
  storage.setItem(LOCALE_STORAGE_KEY, 'zh-TW')
  assert.equal(getStoredLocale(storage), 'zh-CN')
  storage.setItem(LOCALE_STORAGE_KEY, 'fr')
  assert.equal(getStoredLocale(storage), 'en')
  storage.setItem(LOCALE_STORAGE_KEY, 'garbage')
  assert.equal(getStoredLocale(storage), 'en')

  // browser language list: the first usable tag normalizes (zh-* -> zh-CN, anything else -> en)
  assert.equal(resolveBrowserLocale(['zh-TW', 'en-US']), 'zh-CN')
  assert.equal(resolveBrowserLocale(['zh']), 'zh-CN')
  assert.equal(resolveBrowserLocale(['en-GB', 'zh-CN']), 'en')
  assert.equal(resolveBrowserLocale(['fr-FR']), 'en')
  assert.equal(resolveBrowserLocale([]), 'en')

  // initial locale: the persisted preference wins; the default goes through the browser default
  assert.equal(resolveInitialLocale(storage, ['en-US']), 'en')
  persistLocale('zh-CN', storage)
  assert.equal(resolveInitialLocale(storage, ['en-US']), 'zh-CN')
  assert.equal(resolveInitialLocale(createMemoryStorage(), ['zh-Hant']), 'zh-CN')
  assert.equal(resolveInitialLocale(createMemoryStorage(), ['ja-JP']), 'en')

  // storage-failure safety: reads fall back to undefined; writes never throw
  const brokenStorage = {
    getItem() { throw new Error('quota/security error') },
    setItem() { throw new Error('quota/security error') },
    removeItem() { throw new Error('quota/security error') },
  }
  assert.equal(getStoredLocale(brokenStorage), undefined)
  assert.doesNotThrow(() => persistLocale('zh-CN', brokenStorage))
})

test('theme-preferences: LocalePreference auto/manual read/write and resolveLocale', { timeout: 60_000 }, () => {
  const storage = createMemoryStorage()
  // Absent storage key resolves to 'auto'
  assert.equal(getStoredLocalePreference(storage), 'auto')
  assert.equal(resolveLocale('auto', ['zh-CN']), 'zh-CN')
  assert.equal(resolveLocale('auto', ['en-US']), 'en')

  // Manual override persists explicit tag and overrides browser languages
  persistLocalePreference('zh-CN', storage)
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), 'zh-CN')
  assert.equal(getStoredLocalePreference(storage), 'zh-CN')
  assert.equal(resolveLocale('zh-CN', ['en-US']), 'zh-CN')

  persistLocalePreference('en', storage)
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), 'en')
  assert.equal(getStoredLocalePreference(storage), 'en')
  assert.equal(resolveLocale('en', ['zh-CN']), 'en')

  // Switching back to 'auto' removes the storage override
  persistLocalePreference('auto', storage)
  assert.equal(storage.getItem(LOCALE_STORAGE_KEY), null)
  assert.equal(getStoredLocalePreference(storage), 'auto')

  // Stored non-canonical values normalize via normalizeLocaleTag
  storage.setItem(LOCALE_STORAGE_KEY, 'zh-HK')
  assert.equal(getStoredLocalePreference(storage), 'zh-CN')
  storage.setItem(LOCALE_STORAGE_KEY, 'ja-JP')
  assert.equal(getStoredLocalePreference(storage), 'en')

  // Storage-failure safety
  const brokenStorage = {
    getItem() { throw new Error('quota/security error') },
    setItem() { throw new Error('quota/security error') },
    removeItem() { throw new Error('quota/security error') },
  }
  assert.equal(getStoredLocalePreference(brokenStorage), 'auto')
  assert.doesNotThrow(() => persistLocalePreference('auto', brokenStorage))
  assert.doesNotThrow(() => persistLocalePreference('zh-CN', brokenStorage))
})
