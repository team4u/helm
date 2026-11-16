import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Profile, SkillSummary } from '@helm/protocol'
import { ensureHappyDom } from './helpers/dom-harness.js'
import {
  buildProfileCategoryCounts,
  buildProfileModelOptions,
  filterProfiles,
  formatProfileLocation,
  formatShortModelName,
  isHerdrProfile,
  isSystemProfile,
  profileIdValid,
  resolveEffectiveProfileModel,
  resolveProfileModel,
  summarizeProfileActivity,
  summarizeProfiles,
  type ProfileCategoryTab,
} from '../src/profiles/profile-center-model.js'
import { ProfileCard } from '../src/profiles/ProfileCard.js'
import { ProfileDetailDrawer } from '../src/profiles/ProfileDetailDrawer.js'
import { ProfileCenter } from '../src/profiles/ProfileCenter.js'
import type { ModelDescriptor, NodeInfo } from '../src/lib/api.js'
import { makeTestStore } from './helpers/store.js'
import { HostStoreProviders } from './helpers/host-store.js'
import { seedPluginClientModule } from '../src/lib/plugin-client.js'
import { groupUiContributions } from '../src/lib/types.js'
import { PROFILE_DETAIL_SECTION_SLOT } from '@helm/protocol'

ensureHappyDom()

const PKG_ROOT = fileURLToPath(new URL('..', import.meta.url))
const e = React.createElement

const EMOJI_REGEX = /[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/u

// ---------------------------------------------------------------------------
// 辅助 Mock 角色与资产数据
// ---------------------------------------------------------------------------

const mockProfiles: [Profile, Profile, Profile, Profile, Profile] = [
  {
    id: 'superagent',
    name: 'SuperAgent 中枢',
    description: '系统全局总控与中枢协调路由',
    model: 'claude-3-7-sonnet',
    defaultModel: 'claude-3-7-sonnet',
    managedByPlugin: 'builtin:superagent',
    tags: ['superagent', 'router'],
    system: '你作为超级代理中枢执行总控编排',
    skills: ['search', 'bash'],
  },
  {
    id: 'watchdog',
    name: '巡检看门狗',
    description: '系统健康巡检与自愈守卫',
    model: 'gpt-4o',
    defaultModel: 'gpt-4o',
    tags: ['watchdog', 'monitor'],
    isSystem: true,
  },
  {
    id: 'herdr-worker',
    name: 'Herdr 终端专家',
    description: '外部 Herdr 终端进程对接角色',
    model: 'claude-3-5-sonnet',
    defaultModel: 'claude-3-5-sonnet',
    runtime: { kind: 'herdr', agent: 'agy' },
    tags: ['herdr', 'worker'],
    skills: undefined, // 全部可用技能
  },
  {
    id: 'code-reviewer',
    name: '代码审查助手',
    description: '严格的代码规范与缺陷审查专家',
    model: 'deepseek-r1',
    defaultModel: 'deepseek-r1',
    tags: ['custom', 'dev'],
    system: '专注进行代码逻辑审查与安全检查',
    skills: ['git-commit'],
  },
  {
    id: 'plugin-bot',
    name: '插件托管机器人',
    description: '由扩展插件动态注册的角色',
    managedByPlugin: 'custom-plugin',
    tags: ['bot'],
  },
]

const mockModels: ModelDescriptor[] = [
  {
    id: 'claude-3-7-sonnet',
    provider: 'anthropic',
    modelId: 'claude-3-7-sonnet-20250219',
    available: true,
    label: 'Claude 3.7 Sonnet',
    thinkingLevels: ['off', 'low', 'medium', 'high'],
  },
  {
    id: 'deepseek-r1',
    provider: 'deepseek',
    modelId: 'deepseek-reasoner',
    available: true,
    label: 'DeepSeek R1',
    thinkingLevels: ['off'],
  },
  {
    id: 'unconfigured-provider/unconfigured-model',
    provider: 'unconfigured-provider',
    modelId: 'unconfigured-model',
    available: false,
    label: 'Unconfigured Model',
    thinkingLevels: ['off'],
  },
]

const mockSkills: SkillSummary[] = [
  { id: 'search', name: '全网检索', description: '执行网络搜索', references: [] },
  { id: 'git-commit', name: 'Git 提交助手', description: '生成规范提交信息', references: [] },
  { id: 'bash', name: 'Bash 命令执行', description: '节点环境命令驱动', references: [] },
]

// ---------------------------------------------------------------------------
// 1. 模型纯函数单元测试
// ---------------------------------------------------------------------------

test('profile-center-model：isSystemProfile 判定规则覆盖', { timeout: 60_000 }, () => {
  assert.equal(isSystemProfile(mockProfiles[0]), true, 'superagent 视为系统角色')
  assert.equal(isSystemProfile(mockProfiles[1]), true, 'watchdog / isSystem=true 视为系统角色')
  assert.equal(isSystemProfile(mockProfiles[4]), true, 'managedByPlugin 视为系统保护角色')
  assert.equal(isSystemProfile(mockProfiles[2]), false, 'herdr-worker 属于自定义/非系统角色')
  assert.equal(isSystemProfile(mockProfiles[3]), false, 'code-reviewer 属于自定义角色')
})

test('profile-center-model：isHerdrProfile 判定规则覆盖', { timeout: 60_000 }, () => {
  assert.equal(isHerdrProfile(mockProfiles[2]), true, 'runtime.kind=herdr 属于 Herdr 角色')
  assert.equal(isHerdrProfile({ id: 'tag-herdr', tags: ['herdr'] }), true, 'tags 包含 herdr 属于 Herdr 角色')
  assert.equal(isHerdrProfile(mockProfiles[0]), false, '非 herdr 角色返回 false')
  assert.equal(isHerdrProfile(mockProfiles[3]), false, 'code-reviewer 返回 false')
})

test('profile-center-model：resolveProfileModel 优先 defaultModel 降级 model', { timeout: 60_000 }, () => {
  assert.equal(resolveProfileModel({ id: 'a', defaultModel: 'm1', model: 'm2' }), 'm1')
  assert.equal(resolveProfileModel({ id: 'b', model: 'm2' }), 'm2')
  assert.equal(resolveProfileModel({ id: 'c' }), undefined)
})

test('profile-center-model：formatShortModelName 剥离多段路径前缀并保留末段短名', { timeout: 60_000 }, () => {
  assert.equal(
    formatShortModelName('openrouter/accounts/fireworks/models/deepseek-r1-0528'),
    'deepseek-r1-0528',
  )
  assert.equal(formatShortModelName('anthropic/claude-3-7-sonnet'), 'claude-3-7-sonnet')
  assert.equal(formatShortModelName('glm-5'), 'glm-5')
  assert.equal(formatShortModelName('provider/'), 'provider/')
  assert.equal(formatShortModelName('  '), undefined)
  assert.equal(formatShortModelName(undefined), undefined)
})

test('profile-center-model：filterProfiles 分类标签筛选', { timeout: 60_000 }, () => {
  const all = filterProfiles(mockProfiles, { query: '', categoryTab: 'all' })
  assert.equal(all.length, 5)

  const system = filterProfiles(mockProfiles, { query: '', categoryTab: 'system' })
  assert.equal(system.length, 3)
  assert.deepEqual(system.map((p) => p.id), ['superagent', 'watchdog', 'plugin-bot'])

  const custom = filterProfiles(mockProfiles, { query: '', categoryTab: 'custom' })
  assert.equal(custom.length, 2)
  assert.deepEqual(custom.map((p) => p.id), ['herdr-worker', 'code-reviewer'])

  const herdr = filterProfiles(mockProfiles, { query: '', categoryTab: 'herdr' })
  assert.equal(herdr.length, 1)
  assert.equal(herdr[0]!.id, 'herdr-worker')
})

test('profile-center-model：filterProfiles 多维模糊检索', { timeout: 60_000 }, () => {
  // 1. 匹配 ID
  const resId = filterProfiles(mockProfiles, { query: 'reviewer', categoryTab: 'all' })
  assert.equal(resId.length, 1)
  assert.equal(resId[0]!.id, 'code-reviewer')

  // 2. 匹配 Name
  const resName = filterProfiles(mockProfiles, { query: '巡检', categoryTab: 'all' })
  assert.equal(resName.length, 1)
  assert.equal(resName[0]!.id, 'watchdog')

  // 3. 匹配 Description
  const resDesc = filterProfiles(mockProfiles, { query: '总控与中枢', categoryTab: 'all' })
  assert.equal(resDesc.length, 1)
  assert.equal(resDesc[0]!.id, 'superagent')

  // 4. 匹配 Tags
  const resTag = filterProfiles(mockProfiles, { query: 'dev', categoryTab: 'all' })
  assert.equal(resTag.length, 1)
  assert.equal(resTag[0]!.id, 'code-reviewer')

  // 5. 匹配 Model / defaultModel
  const resModel = filterProfiles(mockProfiles, { query: 'deepseek', categoryTab: 'all' })
  assert.equal(resModel.length, 1)
  assert.equal(resModel[0]!.id, 'code-reviewer')

  // 6. 匹配 System 提示词全文
  const resSystem = filterProfiles(mockProfiles, { query: '总控编排', categoryTab: 'all' })
  assert.equal(resSystem.length, 1)
  assert.equal(resSystem[0]!.id, 'superagent')

  // 7. 匹配 Skills 技能名称
  const resSkills = filterProfiles(mockProfiles, { query: 'git-commit', categoryTab: 'all' })
  assert.equal(resSkills.length, 1)
  assert.equal(resSkills[0]!.id, 'code-reviewer')

  // 8. 检索与分类交集门控
  const resCross = filterProfiles(mockProfiles, { query: '终端专家', categoryTab: 'system' })
  assert.equal(resCross.length, 0, '系统分类下检索自定义角色应无匹配')
})

test('profile-center-model：buildProfileCategoryCounts 与 summarizeProfiles', { timeout: 60_000 }, () => {
  const counts = buildProfileCategoryCounts(mockProfiles)
  assert.deepEqual(counts, {
    all: 5,
    system: 3,
    custom: 2,
    herdr: 1,
  })

  const summary = summarizeProfiles(mockProfiles)
  assert.deepEqual(summary, {
    total: 5,
    system: 3,
    custom: 2,
  })
})

test('profile-center-model：profileIdValid 规则校验', { timeout: 60_000 }, () => {
  assert.equal(profileIdValid('code-reviewer'), true)
  assert.equal(profileIdValid('agent-1'), true)
  assert.equal(profileIdValid(''), false)
  assert.equal(profileIdValid('UPPER'), false)
  assert.equal(profileIdValid('with space'), false)
})

test('profile-center-model：buildProfileModelOptions 仅展示已配置模型且未配置模型不出现', { timeout: 60_000 }, () => {
  const testModels: ModelDescriptor[] = [
    {
      id: 'openai/gpt-4o',
      provider: 'openai',
      modelId: 'gpt-4o',
      available: true,
      label: 'GPT-4o',
      thinkingLevels: ['off'],
    },
    {
      id: 'anthropic/claude-3-5-sonnet',
      provider: 'anthropic',
      modelId: 'claude-3-5-sonnet',
      available: false,
      label: 'Claude 3.5 Sonnet',
      thinkingLevels: ['off'],
    },
    {
      id: 'google/gemini-2.5-pro',
      provider: 'google',
      modelId: 'gemini-2.5-pro',
      available: true,
      thinkingLevels: ['off'],
    },
    {
      id: 'meta/llama-3.3-70b',
      provider: 'meta',
      modelId: 'llama-3.3-70b',
      available: false,
      thinkingLevels: ['off'],
    },
  ]

  // 1. 无当前已绑定模型：只包含系统默认与已配置可用模型，未配置模型绝对不出现
  const options1 = buildProfileModelOptions(testModels)
  assert.deepEqual(options1, [
    { value: '', label: '跟随系统默认' },
    { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
    { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  ])
  assert.equal(options1.some((o) => o.value.includes('claude')), false, '未配置模型不得出现在选项中')
  assert.equal(options1.some((o) => o.value.includes('llama')), false, '未配置模型不得出现在选项中')

  // 2. 当前角色已绑定可用模型：正常高亮可用项，不重复追加
  const options2 = buildProfileModelOptions(testModels, 'openai/gpt-4o')
  assert.deepEqual(options2, [
    { value: '', label: '跟随系统默认' },
    { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
    { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
  ])

  // 3. 当前角色已绑定历史失效/未配置模型：保留该项并清晰标注未配置，但不带出其他未配置模型
  const options3 = buildProfileModelOptions(testModels, 'anthropic/claude-3-5-sonnet')
  assert.deepEqual(options3, [
    { value: '', label: '跟随系统默认' },
    { value: 'openai/gpt-4o', label: 'GPT-4o (openai/gpt-4o)' },
    { value: 'google/gemini-2.5-pro', label: 'google/gemini-2.5-pro' },
    { value: 'anthropic/claude-3-5-sonnet', label: 'anthropic/claude-3-5-sonnet（未配置）' },
  ])
  assert.equal(options3.some((o) => o.value.includes('llama')), false, '其他未配置模型不得因当前项未配置而带出')
})

test('profile-center-model：buildProfileModelOptions 跳过已禁用模型，当前绑定恰为禁用模型时保留并标注已禁用', { timeout: 60_000 }, () => {
  const testModels: ModelDescriptor[] = [
    {
      id: 'faux/faux-1',
      provider: 'faux',
      modelId: 'faux-1',
      available: true,
      thinkingLevels: ['off'],
    },
    {
      id: 'faux/faux-2',
      provider: 'faux',
      modelId: 'faux-2',
      available: true,
      disabled: true,
      thinkingLevels: ['off'],
    },
    {
      id: 'faux/faux-3',
      provider: 'faux',
      modelId: 'faux-3',
      available: false,
      disabled: true,
      thinkingLevels: ['off'],
    },
  ]

  // 1. 禁用模型不作为正常可选项出现（无论凭据可用与否）。
  const options1 = buildProfileModelOptions(testModels)
  assert.deepEqual(options1, [
    { value: '', label: '跟随系统默认' },
    { value: 'faux/faux-1', label: 'faux/faux-1' },
  ])

  // 2. 当前绑定的模型恰为禁用模型：保留为当前配置项（不静默丢失）并标注已禁用，不重复。
  const options2 = buildProfileModelOptions(testModels, 'faux/faux-2')
  const hits = options2.filter((o) => o.value === 'faux/faux-2')
  assert.equal(hits.length, 1, '禁用模型只应保留一项，不得重复添加')
  assert.equal(hits[0]?.label, 'faux/faux-2（已禁用）')
})

// ---------------------------------------------------------------------------
// 2. ProfileCard SSR 渲染与零 Emoji 断言
// ---------------------------------------------------------------------------

test('ProfileCard：SSR 渲染结构、徽章、技能胶囊与 0 Emoji', { timeout: 60_000 }, () => {
  // 1. 系统角色卡片
  const systemHtml = renderToStaticMarkup(
    e(ProfileCard, {
      profile: mockProfiles[0],
      selected: true,
      onSelect: () => {},
    }),
  )

  assert.match(systemHtml, /class="[^"]*primary-card[^"]*is-selected[^"]*"/)
  assert.match(systemHtml, /SuperAgent 中枢/)
  assert.match(systemHtml, /superagent/)
  assert.match(systemHtml, /系统全局总控与中枢协调路由/)
  assert.match(systemHtml, /claude-3-7-sonnet/)
  assert.match(systemHtml, /2 个技能/)
  assert.match(systemHtml, /系统/) // 系统锁徽章
  assert.doesNotMatch(systemHtml, EMOJI_REGEX, '系统角色卡片渲染输出严禁含有 Emoji')

  // 2. Herdr 角色（全部可用技能）
  const herdrHtml = renderToStaticMarkup(
    e(ProfileCard, {
      profile: mockProfiles[2],
      selected: false,
      onSelect: () => {},
    }),
  )

  assert.match(herdrHtml, /Herdr 终端专家/)
  assert.match(herdrHtml, /herdr-worker/)
  assert.match(herdrHtml, /全部可用技能/)
  assert.match(herdrHtml, /Herdr/) // Herdr 徽章
  assert.doesNotMatch(herdrHtml, /is-selected/)
  assert.doesNotMatch(herdrHtml, EMOJI_REGEX, 'Herdr 卡片渲染输出严禁含有 Emoji')
})

// ---------------------------------------------------------------------------
// 3. ProfileDetailDrawer SSR 渲染与表单断言
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer：编辑已有角色模式渲染与 0 Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    models: mockModels,
    skills: mockSkills,
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3], // code-reviewer (custom)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /class="[^"]*primary-drawer-content[^"]*"/)
  assert.match(html, /代码审查助手/)
  assert.match(html, /code-reviewer/)
  assert.match(html, /严格的代码规范与缺陷审查专家/)
  assert.match(html, /系统提示词 \(SYSTEM\.md\)/)
  // 长期记忆区块由 builtin:memory 插槽注入（无插件贡献时不渲染，宿主不再硬编码）
  assert.doesNotMatch(html, /长期记忆 \(MEMORY\.md\)/)
  assert.match(html, /可用技能白名单/)
  assert.match(html, /保存角色/)
  assert.match(html, /删除角色/, '自定义角色应渲染删除按钮')
  assert.doesNotMatch(html, /unconfigured-provider\/unconfigured-model/, '未配置的模型绝对不得在 Profile 抽屉的模型选项中出现')
  assert.doesNotMatch(html, /Unconfigured Model/, '未配置的模型名称绝对不得在 Profile 抽屉的模型选项中出现')
  assert.doesNotMatch(html, EMOJI_REGEX, '已有角色抽屉渲染输出严禁含有 Emoji')
})

test('ProfileDetailDrawer：系统角色受保护禁删渲染断言', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[1], // watchdog (system)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )

  assert.match(html, /巡检看门狗/)
  assert.match(html, /系统/) // 系统锁保护徽章
  assert.doesNotMatch(html, /删除角色/, '系统内置角色严禁展示删除按钮')
  assert.doesNotMatch(html, EMOJI_REGEX, '系统角色抽屉渲染输出严禁含有 Emoji')
})

test('ProfileDetailDrawer：新建角色模式与可编辑 ID 渲染断言', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })

  const html = renderToStaticMarkup(
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

  assert.match(html, /新建智能体角色/)
  assert.match(html, /字母、数字与连字符/)
  assert.doesNotMatch(html, /删除角色/, '新建角色抽屉严禁展示删除按钮')
  assert.doesNotMatch(html, EMOJI_REGEX, '新建角色抽屉渲染输出严禁含有 Emoji')
})

test('ProfileDetailDrawer：思考档位随所选模型展示共享分段按钮组', { timeout: 60_000 }, () => {
  // 显式绑定 claude-3-7-sonnet（thinkingLevels: off/low/medium/high）
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, model: 'claude-3-7-sonnet', defaultModel: 'claude-3-7-sonnet' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /思考档位/)
  // 复用会话输入框同款分段按钮组（composer-thinking-row 原语）
  assert.match(html, /composer-thinking-row/)
  assert.match(html, /segmented-control-btn/)
  // 首项恒为「默认」（跟随全局缺省），各档位来自模型目录
  assert.match(html, /默认/)
  assert.match(html, /medium/)
  assert.doesNotMatch(html, EMOJI_REGEX)

  // 未绑定模型的表单：跟随全局缺省，不渲染档位按钮组
  const unbound = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, model: undefined, defaultModel: undefined },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unbound, /未绑定模型时跟随全局缺省思考档位/)
  assert.doesNotMatch(unbound, /segmented-control-btn/)
})

test('ProfileDetailDrawer：默认节点绑定渲染既有值与未知节点回退', { timeout: 60_000 }, () => {
  const mockNodes: NodeInfo[] = [
    { id: 'local', kind: 'local', online: true },
    { id: 'dev-box', kind: 'byom', online: true },
    { id: 'standby-box', kind: 'byom', online: false },
  ]
  const store = makeTestStore({ models: mockModels, skills: mockSkills, nodes: mockNodes })

  // 既有绑定：表单回显已绑定节点 ID
  const bound = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, nodeId: 'dev-box' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(bound, /默认节点/)
  assert.match(bound, /dev-box/)

  // 未知既有值（节点已注销）：补「未知节点」回退项，不丢值不报错
  const unknown = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3]!, nodeId: 'ghost-node' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unknown, /ghost-node（未知节点）/)

  // 未绑定：首项为「未绑定（本机 local）」空值选项
  const unboundNode = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3],
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(unboundNode, /未绑定（本机 local）/)
  assert.doesNotMatch(unboundNode, /未知节点/)
  assert.doesNotMatch(bound, EMOJI_REGEX, '已绑定节点抽屉渲染输出严禁含有 Emoji')
  assert.doesNotMatch(unknown, EMOJI_REGEX, '未知节点回退渲染输出严禁含有 Emoji')
  assert.doesNotMatch(unboundNode, EMOJI_REGEX, '未绑定节点抽屉渲染输出严禁含有 Emoji')
})

// ---------------------------------------------------------------------------
// 4. ProfileCenter 一级全屏中心 SSR 渲染测试
// ---------------------------------------------------------------------------

test('ProfileCenter：全屏中心顶栏、检索栏、卡片流网格与 0 Emoji', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    profiles: mockProfiles,
    models: mockModels,
    skills: mockSkills,
    primaryTarget: { kind: 'profiles' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileCenter, {
        isSplit: false,
        inlineDrawer: true,
      }),
    ),
  )

  // 1. 顶栏要素
  assert.match(html, /data-view="profile-center"/)
  assert.match(html, /智能体角色中心/)
  assert.match(html, /新建角色/)

  // 2. 工具栏搜索与分类标签
  assert.match(html, /搜索角色名称、ID、模型、标签或技能…/)
  assert.match(html, /全部/)
  assert.match(html, /内置/)
  assert.match(html, /自定义/)
  assert.match(html, /Herdr/)

  // 3. 卡片网格流
  assert.match(html, /SuperAgent 中枢/)
  assert.match(html, /巡检看门狗/)
  assert.match(html, /Herdr 终端专家/)
  assert.match(html, /代码审查助手/)

  assert.doesNotMatch(html, EMOJI_REGEX, 'ProfileCenter 渲染输出全程严禁含有 Emoji')
})

test('ProfileCenter：空状态渲染断言', { timeout: 60_000 }, () => {
  const store = makeTestStore({
    profiles: [],
    primaryTarget: { kind: 'profiles' },
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileCenter, {
        isSplit: true,
        onCloseSplit: () => {},
        inlineDrawer: true,
      }),
    ),
  )

  assert.match(html, /primary-center is-split/)
  assert.match(html, /未找到匹配的角色/)
  assert.match(html, /请尝试调整搜索关键字或切换分类标签/)
  assert.doesNotMatch(html, EMOJI_REGEX, '空状态渲染严禁含有 Emoji')
})

// ---------------------------------------------------------------------------
// builtin:memory 插槽注入（ProfileDetailDrawer 宿主零记忆业务硬编码）
// ---------------------------------------------------------------------------

test('ProfileDetailDrawer：经 PluginSlot 渲染 builtin:memory 注入的长期记忆区块', { timeout: 60_000 }, () => {
  function ProfileMemorySectionProbe(props: { profileId: string; isNew: boolean; disabled: boolean }) {
    return React.createElement(
      'section',
      { className: 'section-flat', 'data-probe': 'memory' },
      React.createElement('span', null, `长期记忆 (${props.profileId})`),
      props.isNew ? '请先创建角色' : '启用长期记忆',
    )
  }
  seedPluginClientModule('builtin:memory', 'index.tsx', { ProfileMemorySection: ProfileMemorySectionProbe })

  const store = makeTestStore({
    models: mockModels,
    skills: mockSkills,
    groupedUi: groupUiContributions([
      {
        pluginId: 'builtin:memory',
        surface: 'plugin.slot',
        spec: {
          id: 'profile-memory-section',
          target: PROFILE_DETAIL_SECTION_SLOT,
          client: { module: 'index.tsx', export: 'ProfileMemorySection' },
        },
      },
    ]),
  })

  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3], // code-reviewer (custom)
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /data-probe="memory"/, 'memory 插件插槽应经 PluginSlot 渲染')
  assert.match(html, /长期记忆 \(code-reviewer\)/, '插槽收到 profileId props')
  assert.match(html, /启用长期记忆/, '插槽内容实际渲染（非 fallback）')
})

test('ProfileDetailDrawer：无 memory 插件贡献时不渲染长期记忆区块（宿主无硬编码）', { timeout: 60_000 }, () => {
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: mockProfiles[3],
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.doesNotMatch(html, /长期记忆/, '无插件贡献时不得出现记忆区块')
})

test('profile-center-model: 有效模型/全局继承解析、节点工作目录与会话活跃态汇总', { timeout: 60_000 }, () => {
  const bound = resolveEffectiveProfileModel(
    { ...mockProfiles[3], thinkingLevel: 'high' },
    { defaultModel: 'openai/gpt-4o', defaultThinkingLevel: 'medium' },
  )
  assert.deepEqual(bound, { model: 'deepseek-r1', thinkingLevel: 'high', source: 'bound' })

  const inherited = resolveEffectiveProfileModel(
    { id: 'worker', name: 'Worker' },
    { defaultModel: 'openai/gpt-4o', defaultThinkingLevel: 'low' },
  )
  assert.deepEqual(inherited, { model: 'openai/gpt-4o', thinkingLevel: 'low', source: 'global' })

  const unset = resolveEffectiveProfileModel({ id: 'worker', name: 'Worker' }, null)
  assert.deepEqual(unset, { source: 'unset' })

  assert.deepEqual(formatProfileLocation({ id: 'x', nodeId: 'gpu-1', cwd: '/srv/app' }), {
    nodeId: 'gpu-1',
    isRemoteNode: true,
    cwd: '/srv/app',
  })
  assert.deepEqual(formatProfileLocation({ id: 'x' }), {
    nodeId: 'local',
    isRemoteNode: false,
    cwd: undefined,
  })

  const workingActivity = summarizeProfileActivity(
    { id: 'coder', name: 'Coder' },
    [
      {
        id: 1,
        title: 'Task 1',
        profileId: 'coder',
        tags: [],
        cwd: '/tmp',
        model: 'm',
        thinkingLevel: '',
        status: 'working',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    [],
  )
  assert.equal(workingActivity.conversationCount, 1)
  assert.equal(workingActivity.stateKind, 'working')
  assert.equal(workingActivity.stateLabel, '运行中')

  const disabledActivity = summarizeProfileActivity(
    { id: 'herdr-worker', managedByPlugin: 'builtin:herdr' },
    [],
    [
      {
        id: 'builtin:herdr',
        name: 'Herdr',
        enabled: false,
        locked: false,
        tools: [],
        actions: [],
        hooks: [],
      },
    ],
  )
  assert.equal(disabledActivity.managingPluginDisabled, true)
  assert.equal(disabledActivity.stateKind, 'plugin-disabled')
  assert.equal(disabledActivity.stateLabel, '插件已停用')
})

test('ProfileCard: 展示继承全局模型、节点与工作目录、会话数及右下角「对话」直达且阻止冒泡', { timeout: 60_000 }, async () => {
  const { act } = await import('react')
  const ReactDOMClient = await import('react-dom/client')
  const openedTargets: unknown[] = []
  let selectCalls = 0

  const profileWithNode: Profile = {
    id: 'remote-dev',
    name: '远程研发助手',
    description: '在 GPU 节点运行',
    nodeId: 'gpu-node-1',
    cwd: '/data/workspace/helm',
    skills: ['helm-cli'],
  }

  const store = makeTestStore({
    defaultModelInfo: { defaultModel: 'anthropic/claude-3-7-sonnet', defaultThinkingLevel: 'high' },
    conversations: [
      {
        id: 11,
        title: '调试任务',
        profileId: 'remote-dev',
        tags: [],
        cwd: '/data/workspace/helm',
        model: 'anthropic/claude-3-7-sonnet',
        thinkingLevel: 'high',
        status: 'blocked',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: true,
        pinned: false,
        pendingAskCount: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    openTarget: (target) => {
      openedTargets.push(target)
    },
  })

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOMClient.createRoot(host)

  try {
    await act(async () => {
      root.render(
        e(
          HostStoreProviders,
          { value: store },
          e(ProfileCard, {
            profile: profileWithNode,
            onSelect: () => {
              selectCalls++
            },
          }),
        ),
      )
    })

    const text = host.textContent ?? ''
    const modelLabel = host.querySelector('.primary-card-pills .primary-card-pill-label')
    const modelSuffix = host.querySelector('.primary-card-pills .primary-card-pill-suffix')
    const modelPill = modelLabel?.closest('.primary-card-pill')
    assert.equal(modelLabel?.textContent, 'claude-3-7-sonnet')
    assert.equal(modelSuffix?.textContent, '· high')
    assert.equal(
      modelPill?.getAttribute('title'),
      '继承全局默认模型：anthropic/claude-3-7-sonnet（思考档位：high）',
    )
    assert.match(text, /全局默认/)
    assert.match(text, /gpu-node-1 · \/data\/workspace\/helm/)
    assert.match(text, /待审批/)
    assert.match(text, /关联 1 个会话/)
    assert.equal(host.querySelectorAll('[style]').length, 0, 'ProfileCard 严禁残留内联 style')
    assert.doesNotMatch(host.innerHTML, EMOJI_REGEX, 'ProfileCard 严禁包含 Emoji')

    const chatBtn = Array.from(host.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('对话'),
    )
    assert.ok(chatBtn, 'ProfileCard 右下角应渲染对话按钮')
    await act(async () => {
      chatBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    assert.equal(selectCalls, 0, '点击「对话」按钮必须 stopPropagation 不触发卡片选中')
    assert.deepEqual(openedTargets, [{ kind: 'agent', profileId: 'remote-dev' }])
  } finally {
    await act(async () => {
      root.unmount()
    })
    host.remove()
  }
})

test('ProfileCard: 超长全路径模型仅展示短名与独立档位后缀，完整路径保留在悬浮 title', { timeout: 60_000 }, () => {
  const longPathModel = 'openrouter/accounts/fireworks/models/Qwen3-235B-A22B-Instruct-2507'
  const html = renderToStaticMarkup(
    e(ProfileCard, {
      profile: {
        id: 'architect',
        name: '架构师',
        model: longPathModel,
        thinkingLevel: 'xhigh',
      },
      onSelect: () => {},
    }),
  )
  assert.match(html, /class="primary-card-pill-label">Qwen3-235B-A22B-Instruct-2507<\/span>/)
  assert.match(html, /class="primary-card-pill-suffix">· xhigh<\/span>/)
  assert.match(html, new RegExp(`title="绑定模型：${longPathModel}（思考档位：xhigh）"`))
  assert.doesNotMatch(html, />openrouter\/accounts\/fireworks\/models\//)

  // 未配置绑定模型且无全局默认时展示「跟随全局默认」
  const unsetHtml = renderToStaticMarkup(
    e(ProfileCard, {
      profile: { id: 'plain', name: '普通角色' },
      defaultModelInfo: null,
      onSelect: () => {},
    }),
  )
  assert.match(unsetHtml, /class="primary-card-pill-label">跟随全局默认<\/span>/)
})

test('ProfileDetailDrawer: 关闭按钮使用 .btn-icon-sm 且源码零 .callout--* 旧类', { timeout: 60_000 }, () => {
  const files = [
    'src/profiles/profile-center-model.ts',
    'src/profiles/ProfileCard.tsx',
    'src/profiles/ProfileCenter.tsx',
    'src/profiles/ProfileDetailDrawer.tsx',
  ]
  for (const rel of files) {
    const content = readFileSync(join(PKG_ROOT, rel), 'utf-8')
    assert.ok(!content.includes('callout--'), `${rel} 不得残留 callout--* 旧类`)
  }
  const store = makeTestStore({ models: mockModels, skills: mockSkills })
  const html = renderToStaticMarkup(
    e(
      HostStoreProviders,
      { value: store },
      e(ProfileDetailDrawer, {
        profile: { ...mockProfiles[3], thinkingLevel: 'xhigh' },
        isNew: false,
        open: true,
        inline: true,
        onClose: () => {},
      }),
    ),
  )
  assert.match(html, /btn btn-ghost btn-icon-sm/, '关闭按钮应使用固定宽高 .btn-icon-sm')
  assert.match(html, /callout callout-warn/, '不支持的思考档位提示应使用统一 .callout-warn')
})
