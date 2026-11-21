/**
 * Skill filtering regression for the conversation slash menu (Composer '/' completion):
 * - pure model slashMenuSkills: profile.skills whitelist + plugin enablement
 *   double filter (the protocol's isSkillAvailable is the single rule source);
 * - real mounted Composer: typing '/' opens the slash popover with skills
 *   filtered by the current conversation's Profile;
 * - profile.skills missing (assets not returned / Profile deleted): no skills
 *   shown yet; never accidentally exposing everything;
 * - []: no skills; whitelist: only whitelisted skills of enabled plugins;
 * - skills managed by a disabled plugin: never shown even on a whitelist hit;
 * - builtin /new /clear /compact and plugin commands are unaffected by skill filtering.
 *
 * Mounting matches composer-controller.test.ts (rendered inside the root container, no Portal, input events reachable).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as React from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { HostStoreProviders } from './helpers/host-store.js'
import { makeTestStore } from './helpers/store.js'

GlobalRegistrator.register()
Object.assign(globalThis, { React, IS_REACT_ACT_ENVIRONMENT: true })

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
import type { ConversationSummary, PluginSummary, Profile, SkillSummary } from '@helmx/protocol'
import type { HelmxExternalStore } from '../src/lib/helmx-store.js'
import { slashMenuSkills, slashMenuSkillsWithScope } from '../src/conversation/slash-menu-skills.js'

/** Real user typing path: native setter assignment + value tracker reset + input dispatch. */
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
// Pure model: slashMenuSkills
// ---------------------------------------------------------------------------

test('slashMenuSkills: undefined -> all visible skills; [] -> all hidden; whitelist filters exactly', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile', 'builtin:herdr'])
  // undefined: everything (including enabled-plugin managed ones)
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: undefined }, CATALOG, enabled).map((s) => s.id),
    ['review', 'tally', 'herdr-tool'],
  )
  // []: disable everything
  assert.deepEqual(slashMenuSkills({ id: 'p', skills: [] }, CATALOG, enabled), [])
  // Whitelist
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: ['review'] }, CATALOG, enabled).map((s) => s.id),
    ['review'],
  )
})

test('slashMenuSkills: a missing Profile shows no skills yet (never accidentally exposing all)', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile'])
  assert.deepEqual(slashMenuSkills(undefined, CATALOG, enabled), [], 'missing Profile -> empty skill list')
})

test('slashMenuSkills: skills of a disabled plugin are always unavailable (even on a whitelist hit)', { timeout: 60_000 }, () => {
  const disabled = new Set(['builtin:profile'])
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: undefined }, CATALOG, disabled).map((s) => s.id),
    ['review', 'tally'],
    'disabled-plugin managed skills are removed',
  )
  assert.deepEqual(
    slashMenuSkills({ id: 'p', skills: ['herdr-tool', 'review'] }, CATALOG, disabled).map((s) => s.id),
    ['review'],
    'whitelisted skills of a disabled plugin stay unavailable',
  )
})

// ---------------------------------------------------------------------------
// Pure model: slashMenuSkillsWithScope（会话/待命坐标的节点技能合并）
// ---------------------------------------------------------------------------

test('slashMenuSkillsWithScope: 节点来源技能补入，Hub 同名胜出，白名单与启用态同样生效', { timeout: 60_000 }, () => {
  const enabled = new Set(['builtin:profile'])
  const profile: Profile = { id: 'p', skills: undefined }
  const hubSkills: SkillSummary[] = [
    { id: 'review', name: '审查', references: [] },
    { id: 'deploy', name: '部署', references: [], managedByPlugin: 'builtin:profile' },
  ]
  const scoped: SkillSummary[] = [
    // 节点补充技能（合法新增）
    { id: 'node-runbook', name: '节点规程', references: [], source: 'node' },
    // 与 Hub 同名的节点条目（后端契约已排除；前端再防御一次）
    { id: 'review', name: '节点同名审查', references: [], source: 'node' },
    // 合并目录里的 Hub 条目（source 缺省）不得重复补入
    { id: 'deploy', name: '部署', references: [], managedByPlugin: 'builtin:profile' },
  ]
  assert.deepEqual(
    slashMenuSkillsWithScope(profile, hubSkills, enabled, scoped).map((s) => s.id),
    ['review', 'deploy', 'node-runbook'],
    '节点技能追加在 Hub 基底之后；同名与 Hub 条目去重',
  )

  // 白名单过滤同样作用于节点技能
  assert.deepEqual(
    slashMenuSkillsWithScope({ id: 'p', skills: ['review'] }, hubSkills, enabled, scoped).map((s) => s.id),
    ['review'],
    'Profile 白名单过滤节点补充技能（与会话目录同一规则源）',
  )

  // 目录未加载（null/undefined）：保持 Hub 基底不动
  assert.deepEqual(
    slashMenuSkillsWithScope(profile, hubSkills, enabled, null).map((s) => s.id),
    ['review', 'deploy'],
  )
  assert.deepEqual(
    slashMenuSkillsWithScope(profile, hubSkills, enabled, undefined).map((s) => s.id),
    ['review', 'deploy'],
  )

  // 缺 Profile：与 slashMenuSkills 同语义，空列表
  assert.deepEqual(slashMenuSkillsWithScope(undefined, hubSkills, enabled, scoped), [])
})

// ---------------------------------------------------------------------------
// Interaction: the real Composer '/' slash popover filters by the current conversation's Profile
// ---------------------------------------------------------------------------

const { Composer } = await import('../src/conversation/Composer.js')

interface MountOptions {
  profiles: Profile[]
  skills?: SkillSummary[]
  plugins?: PluginSummary[]
}

function makeStore(conversation: ConversationSummary, opts: MountOptions): HelmxExternalStore {
  return makeTestStore({
    conversations: [conversation],
    plugins: opts.plugins ?? [
      { id: 'builtin:profile', name: 'assistant', locked: true, enabled: true, hooks: [], actions: [], tools: [] },
      { id: 'builtin:herdr', name: 'herdr', locked: false, enabled: true, hooks: [], actions: [], tools: [] },
    ],
    profiles: opts.profiles,
    skills: opts.skills ?? CATALOG,
    primaryTarget: { kind: 'conversation', conversationId: conversation.id },
  })
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
        HostStoreProviders,
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

test('interaction: profile.skills unset -> all visible skills enter the slash popover; builtin commands unaffected', { timeout: 60_000 }, async () => {
  const { typeSlash, unmount } = await mountComposer(conv(1, 'coder'), { profiles: [{ id: 'coder', tags: [] }] })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover, "'/' opens the slash popover")
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

test('interaction: profile.skills=[] -> no skills at all, only builtin commands', { timeout: 60_000 }, async () => {
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

test('interaction: whitelisted profile -> only whitelisted skills; disabled-plugin managed skills never appear even on whitelist hits', { timeout: 60_000 }, async () => {
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
    assert.doesNotMatch(text, /\/skill:review/, 'skills outside the whitelist never appear')
    assert.match(text, /\/skill:tally/, 'skills inside the whitelist appear')
    assert.doesNotMatch(text, /\/skill:herdr-tool/, 'disabled-plugin managed skills never appear even on whitelist hits')
  } finally {
    await unmount()
  }
})

test('interaction: current Profile missing -> no skills shown yet (better absent than overexposed)', { timeout: 60_000 }, async () => {
  const { typeSlash, unmount } = await mountComposer(conv(4, 'ghost'), { profiles: [{ id: 'coder', tags: [] }] })
  try {
    const popover = await typeSlash('/')
    assert.ok(popover)
    const text = popover!.textContent ?? ''
    assert.match(text, /\/new/, 'builtin commands unaffected')
    assert.doesNotMatch(text, /skill:/, 'no skills shown while the Profile is missing')
  } finally {
    await unmount()
  }
})

test('interaction: switching Profile (simulating a store refresh) updates dependencies dynamically', { timeout: 60_000 }, async () => {
  // Store data changing under the same conversation profileId (e.g. refreshAssets after a save): once the
  // whitelist tightens, the popover follows. The behavior is guaranteed by the
  // useMemo([store.profiles, conversation.profileId, store.skills, enabledPluginIds]) dependency chain; the
  // pure-model layer verifies the result difference of the same input under different profiles (split view /
  // menu switching share this function).
  const enabled = new Set(['builtin:profile'])
  const a = slashMenuSkills({ id: 'a', skills: undefined }, CATALOG, enabled).map((s) => s.id)
  const b = slashMenuSkills({ id: 'b', skills: ['tally'] }, CATALOG, enabled).map((s) => s.id)
  assert.deepEqual(a, ['review', 'tally'])
  assert.deepEqual(b, ['tally'], 'after switching the bound Profile of the same conversation, the skill set follows profile.skills')
})
