import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import {
  formatLocationHash,
  isSameLocationState,
  parseHash,
  parseLocationHash,
  serializeHash,
  shouldPushLocationHistory,
  upgradeLegacyLocationState,
  type WorkspaceLocationState,
} from '../src/lib/url-hash-model.js'
import { isSameResolvedTarget, resolveTargetString, type ResolvedTarget } from '../src/lib/types.js'

const baseState = (target: ResolvedTarget): WorkspaceLocationState => ({
  primaryTarget: target,
  splitTarget: null,
  workbenchOpen: false,
  workbenchTab: 'artifacts',
  activeModal: null,
})

// ---------------------------------------------------------------------------
// 1. serializeHash 与 formatLocationHash 序列化契约
// ---------------------------------------------------------------------------

test('serializeHash: 四大中心基础路由分别输出 #/profiles, #/skills, #/nodes, #/models', { timeout: 60_000 }, () => {
  const centers: Array<{ kind: 'profiles' | 'skills' | 'nodes' | 'models'; expected: string }> = [
    { kind: 'profiles', expected: '#/profiles' },
    { kind: 'skills', expected: '#/skills' },
    { kind: 'nodes', expected: '#/nodes' },
    { kind: 'models', expected: '#/models' },
  ]

  for (const { kind, expected } of centers) {
    assert.equal(serializeHash({ target: { kind } }), expected)
    assert.equal(serializeHash({ primaryTarget: { kind } }), expected)
    assert.equal(serializeHash({ kind }), expected)
    assert.equal(formatLocationHash(baseState({ kind })), expected)
  }
})

test('serializeHash: 携带选中子项时输出 ?id=<id>（参数正确编码）', { timeout: 60_000 }, () => {
  assert.equal(
    serializeHash({ kind: 'profiles', profileId: 'superagent' }),
    '#/profiles?id=superagent',
  )
  assert.equal(
    serializeHash({ kind: 'profiles', profileId: 'worker:analysis' }),
    '#/profiles?id=worker%3Aanalysis',
  )
  assert.equal(
    serializeHash({ kind: 'skills', skillId: 'git-commit' }),
    '#/skills?id=git-commit',
  )
  assert.equal(
    serializeHash({ kind: 'nodes', nodeId: 'gpu-server-1' }),
    '#/nodes?id=gpu-server-1',
  )
  assert.equal(
    serializeHash({ kind: 'models', providerId: 'anthropic' }),
    '#/models?id=anthropic',
  )
})

test('serializeHash: 空或空白 id 视为无选中子项，仅输出基础路由', { timeout: 60_000 }, () => {
  assert.equal(serializeHash({ kind: 'profiles', profileId: '' }), '#/profiles')
  assert.equal(serializeHash({ kind: 'skills', skillId: '' }), '#/skills')
  assert.equal(serializeHash({ kind: 'nodes', nodeId: '' }), '#/nodes')
  assert.equal(serializeHash({ kind: 'models', providerId: '' }), '#/models')
})

test('serializeHash: 四大中心作为主屏时与分屏、工作台、弹窗正交组合', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'profiles', profileId: 'superagent' },
    splitTarget: { kind: 'models', providerId: 'anthropic' },
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    activeModal: { kind: 'conversation-drawer', conversationId: 5 },
  }
  const hash = formatLocationHash(state)
  const search = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  assert.equal(hash.startsWith('#/profiles?'), true)
  assert.equal(search.get('id'), 'superagent')
  assert.equal(search.get('split'), 'models?id=anthropic')
  assert.equal(search.get('wb'), 'artifacts')
  assert.equal(search.get('modal'), 'drawer')
})

// ---------------------------------------------------------------------------
// 2. parseHash 与 parseLocationHash 反向解析契约
// ---------------------------------------------------------------------------

test('parseHash: 基础路由正确还原为各中心目标', { timeout: 60_000 }, () => {
  assert.deepEqual(parseHash('#/profiles').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseHash('#/skills').primaryTarget, { kind: 'skills' })
  assert.deepEqual(parseHash('#/nodes').primaryTarget, { kind: 'nodes' })
  assert.deepEqual(parseHash('#/models').primaryTarget, { kind: 'models' })
  // 兼容 #/providers 别名
  assert.deepEqual(parseHash('#/providers').primaryTarget, { kind: 'models' })

  // 容忍尾部斜杠
  assert.deepEqual(parseLocationHash('#/profiles/').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/skills/').primaryTarget, { kind: 'skills' })
})

test('parseHash: ?id=<id> 正确还原携带对应 ID 的目标', { timeout: 60_000 }, () => {
  assert.deepEqual(
    parseHash('#/profiles?id=superagent').primaryTarget,
    { kind: 'profiles', profileId: 'superagent' },
  )
  assert.deepEqual(
    parseHash('#/skills?id=git-commit').primaryTarget,
    { kind: 'skills', skillId: 'git-commit' },
  )
  assert.deepEqual(
    parseHash('#/nodes?id=local').primaryTarget,
    { kind: 'nodes', nodeId: 'local' },
  )
  assert.deepEqual(
    parseHash('#/models?id=openai').primaryTarget,
    { kind: 'models', providerId: 'openai' },
  )
  assert.deepEqual(
    parseHash('#/providers?id=anthropic').primaryTarget,
    { kind: 'models', providerId: 'anthropic' },
  )
})

test('roundtrip: 四大中心目标双向编解码往返无损', { timeout: 60_000 }, () => {
  const states: WorkspaceLocationState[] = [
    baseState({ kind: 'profiles' }),
    baseState({ kind: 'profiles', profileId: 'watchdog' }),
    baseState({ kind: 'skills' }),
    baseState({ kind: 'skills', skillId: 'git-commit' }),
    baseState({ kind: 'nodes' }),
    baseState({ kind: 'nodes', nodeId: 'gpu-box' }),
    baseState({ kind: 'models' }),
    baseState({ kind: 'models', providerId: 'deepseek' }),
    {
      primaryTarget: { kind: 'profiles', profileId: 'coder' },
      splitTarget: { kind: 'nodes', nodeId: 'local' },
      workbenchOpen: true,
      workbenchTab: 'artifacts',
      activeModal: null,
    },
  ]

  for (const original of states) {
    const formatted = formatLocationHash(original)
    const back = parseLocationHash(formatted)
    assert.equal(
      isSameLocationState(back, original),
      true,
      `roundtrip failed: ${formatted}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 3. 目标比较 (isSameResolvedTarget) 与目标字符串解析 (resolveTargetString)
// ---------------------------------------------------------------------------

test('isSameResolvedTarget: 四大中心目标精确比较', { timeout: 60_000 }, () => {
  assert.equal(isSameResolvedTarget({ kind: 'profiles' }, { kind: 'profiles' }), true)
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles', profileId: 'coder' },
      { kind: 'profiles', profileId: 'coder' },
    ),
    true,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles', profileId: 'coder' },
      { kind: 'profiles', profileId: 'reviewer' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'profiles' },
      { kind: 'profiles', profileId: 'coder' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget({ kind: 'skills' }, { kind: 'nodes' }),
    false,
  )
})

test('resolveTargetString: 支持 profiles, skills, nodes, models 及其子 ID 声明式目标', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetString('profiles', []), { kind: 'profiles' })
  assert.deepEqual(resolveTargetString('profiles:', []), { kind: 'profiles' })
  assert.deepEqual(resolveTargetString('profiles:superagent', []), { kind: 'profiles', profileId: 'superagent' })

  assert.deepEqual(resolveTargetString('skills', []), { kind: 'skills' })
  assert.deepEqual(resolveTargetString('skills:git-commit', []), { kind: 'skills', skillId: 'git-commit' })

  assert.deepEqual(resolveTargetString('nodes', []), { kind: 'nodes' })
  assert.deepEqual(resolveTargetString('nodes:local', []), { kind: 'nodes', nodeId: 'local' })

  assert.deepEqual(resolveTargetString('models', []), { kind: 'models' })
  assert.deepEqual(resolveTargetString('models:anthropic', []), { kind: 'models', providerId: 'anthropic' })
})

// ---------------------------------------------------------------------------
// 4. 历史栈策略 (shouldPushLocationHistory)
// ---------------------------------------------------------------------------

test('shouldPushLocationHistory: 跨视图切换进出四大中心走 push', { timeout: 60_000 }, () => {
  const convState = baseState({ kind: 'conversation', conversationId: 1 })
  const profilesState = baseState({ kind: 'profiles' })
  const skillsState = baseState({ kind: 'skills' })
  const nodesState = baseState({ kind: 'nodes' })
  const modelsState = baseState({ kind: 'models' })

  // 会话 -> 角色中心：push
  assert.equal(shouldPushLocationHistory(convState, profilesState), true)
  // 角色中心 -> 技能中心：push
  assert.equal(shouldPushLocationHistory(profilesState, skillsState), true)
  // 技能中心 -> 节点中心：push
  assert.equal(shouldPushLocationHistory(skillsState, nodesState), true)
  // 节点中心 -> 模型中心：push
  assert.equal(shouldPushLocationHistory(nodesState, modelsState), true)
  // 模型中心 -> 会话：push
  assert.equal(shouldPushLocationHistory(modelsState, convState), true)
})

test('shouldPushLocationHistory: 各中心从列表打开抽屉走 push，抽屉内切换或关闭走 replace', { timeout: 60_000 }, () => {
  const profilesList = baseState({ kind: 'profiles' })
  const profileDrawerA = baseState({ kind: 'profiles', profileId: 'coder' })
  const profileDrawerB = baseState({ kind: 'profiles', profileId: 'reviewer' })

  // 1. 从列表打开抽屉：push（支持浏览器后退关闭抽屉）
  assert.equal(shouldPushLocationHistory(profilesList, profileDrawerA), true)

  // 2. 抽屉内切换不同子项：replace（避免后退栈被连续点选污染）
  assert.equal(shouldPushLocationHistory(profileDrawerA, profileDrawerB), false)

  // 3. 关闭抽屉回到列表：replace（平滑关闭，不污染后退栈）
  assert.equal(shouldPushLocationHistory(profileDrawerA, profilesList), false)

  // 技能中心同理
  const skillsList = baseState({ kind: 'skills' })
  const skillA = baseState({ kind: 'skills', skillId: 'git-commit' })
  const skillB = baseState({ kind: 'skills', skillId: 'herdr' })
  assert.equal(shouldPushLocationHistory(skillsList, skillA), true)
  assert.equal(shouldPushLocationHistory(skillA, skillB), false)
  assert.equal(shouldPushLocationHistory(skillA, skillsList), false)

  // 节点中心同理
  const nodesList = baseState({ kind: 'nodes' })
  const nodeA = baseState({ kind: 'nodes', nodeId: 'local' })
  const nodeB = baseState({ kind: 'nodes', nodeId: 'remote' })
  assert.equal(shouldPushLocationHistory(nodesList, nodeA), true)
  assert.equal(shouldPushLocationHistory(nodeA, nodeB), false)
  assert.equal(shouldPushLocationHistory(nodeA, nodesList), false)

  // 模型中心同理
  const modelsList = baseState({ kind: 'models' })
  const modelA = baseState({ kind: 'models', providerId: 'anthropic' })
  const modelB = baseState({ kind: 'models', providerId: 'openai' })
  assert.equal(shouldPushLocationHistory(modelsList, modelA), true)
  assert.equal(shouldPushLocationHistory(modelA, modelB), false)
  assert.equal(shouldPushLocationHistory(modelA, modelsList), false)
})

// ---------------------------------------------------------------------------
// 5. 兼容解析：旧的 #/c/1?modal=profiles|skills|nodes|providers 平滑升级
// ---------------------------------------------------------------------------

test('upgradeLegacyLocationState: 旧 modal 参数平滑升级为对应一级全屏中心', { timeout: 60_000 }, () => {
  const legacyProfiles = parseLocationHash('#/c/1?modal=profiles&id=watchdog')
  const upgradedProfiles = upgradeLegacyLocationState(legacyProfiles)
  assert.deepEqual(upgradedProfiles.primaryTarget, { kind: 'profiles', profileId: 'watchdog' })
  assert.equal(upgradedProfiles.activeModal, null)

  const legacySkills = parseLocationHash('#/c/1?modal=skills&id=git-commit')
  const upgradedSkills = upgradeLegacyLocationState(legacySkills)
  assert.deepEqual(upgradedSkills.primaryTarget, { kind: 'skills', skillId: 'git-commit' })
  assert.equal(upgradedSkills.activeModal, null)

  const legacyNodes = parseLocationHash('#/c/1?modal=nodes&id=gpu-server')
  const upgradedNodes = upgradeLegacyLocationState(legacyNodes)
  assert.deepEqual(upgradedNodes.primaryTarget, { kind: 'nodes', nodeId: 'gpu-server' })
  assert.equal(upgradedNodes.activeModal, null)

  const legacyProviders = parseLocationHash('#/c/1?modal=providers')
  const upgradedProviders = upgradeLegacyLocationState(legacyProviders)
  assert.deepEqual(upgradedProviders.primaryTarget, { kind: 'models' })
  assert.equal(upgradedProviders.activeModal, null)

  const legacyPlugins = parseLocationHash('#/c/1?modal=plugins&id=builtin:workflow')
  const upgradedPlugins = upgradeLegacyLocationState(legacyPlugins)
  assert.deepEqual(upgradedPlugins.primaryTarget, { kind: 'plugins', pluginId: 'builtin:workflow' })
  assert.equal(upgradedPlugins.activeModal, null)
})
