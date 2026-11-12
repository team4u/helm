import assert from 'node:assert/strict'
import { test } from 'node:test'
const ROOT_CONVERSATION_ID = 1 as const // 初始会话 id（SDK 保留 #1 承载；普通会话语义）
import {
  formatLocationHash,
  isSameLocationState,
  parseHash,
  parseLocationHash,
  serializeHash,
  shouldPushLocationHistory,
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

test('serializeHash: 插件中心基础路由输出 #/settings/plugins', { timeout: 60_000 }, () => {
  const hashFromTarget = serializeHash({ target: { kind: 'plugins' } })
  assert.equal(hashFromTarget, '#/settings/plugins')

  const hashFromPrimary = serializeHash({ primaryTarget: { kind: 'plugins' } })
  assert.equal(hashFromPrimary, '#/settings/plugins')

  const hashFromRawTarget = serializeHash({ kind: 'plugins' })
  assert.equal(hashFromRawTarget, '#/settings/plugins')

  const hashFromFullState = formatLocationHash(baseState({ kind: 'plugins' }))
  assert.equal(hashFromFullState, '#/settings/plugins')
})

test('serializeHash: 携带选中插件时输出 #/settings/plugins/<pluginId>（冒号路径段保持可读）', { timeout: 60_000 }, () => {
  const hashFromTarget = serializeHash({
    target: { kind: 'plugins', pluginId: 'builtin:workflow' },
  })
  assert.equal(hashFromTarget, '#/settings/plugins/builtin:workflow')

  const hashFromPrimary = serializeHash({
    primaryTarget: { kind: 'plugins', pluginId: 'builtin:workflow' },
  })
  assert.equal(hashFromPrimary, '#/settings/plugins/builtin:workflow')

  const hashFromRawTarget = serializeHash({
    kind: 'plugins',
    pluginId: 'builtin:workflow',
  })
  assert.equal(hashFromRawTarget, '#/settings/plugins/builtin:workflow')

  const hashFromFullState = formatLocationHash(
    baseState({ kind: 'plugins', pluginId: 'builtin:workflow' }),
  )
  assert.equal(hashFromFullState, '#/settings/plugins/builtin:workflow')
})

test('serializeHash: 空或空白 pluginId 视为无选中插件，输出 #/settings/plugins', { timeout: 60_000 }, () => {
  assert.equal(serializeHash({ target: { kind: 'plugins', pluginId: '' } }), '#/settings/plugins')
  assert.equal(
    formatLocationHash(baseState({ kind: 'plugins', pluginId: '' })),
    '#/settings/plugins',
  )
})

test('serializeHash: 插件中心作为主屏时与分屏、工作台、弹窗正交组合', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'plugins', pluginId: 'builtin:herdr' },
    splitTarget: { kind: 'conversation', conversationId: 10 },
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    activeModal: { kind: 'provider-auth' },
  }
  const hash = formatLocationHash(state)
  const search = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  assert.equal(hash.startsWith('#/settings/plugins/builtin:herdr?'), true)
  assert.equal(search.get('split'), 'c/10')
  assert.equal(search.get('wb'), 'artifacts')
  assert.equal(search.get('modal'), 'providers')
})

// ---------------------------------------------------------------------------
// 2. parseHash 与 parseLocationHash 反向解析契约
// ---------------------------------------------------------------------------

test('parseHash: #/settings/plugins 正确还原为 plugins 目标', { timeout: 60_000 }, () => {
  const parsed = parseHash('#/settings/plugins')
  assert.deepEqual(parsed.primaryTarget, { kind: 'plugins' })
  assert.deepEqual(parsed.target, { kind: 'plugins' })
  assert.equal(parsed.splitTarget, null)
  assert.equal(parsed.workbenchOpen, false)
  assert.equal(parsed.activeModal, null)

  const parsedSlash = parseLocationHash('#/settings/plugins/')
  assert.deepEqual(parsedSlash.primaryTarget, { kind: 'plugins' })
})

test('parseHash: #/settings/plugins/<pluginId> 正确还原携带 pluginId 的目标', { timeout: 60_000 }, () => {
  const parsed = parseHash('#/settings/plugins/builtin:workflow')
  assert.deepEqual(parsed.primaryTarget, { kind: 'plugins', pluginId: 'builtin:workflow' })
  assert.deepEqual(parsed.target, { kind: 'plugins', pluginId: 'builtin:workflow' })

  // 容忍百分号编码冒号的形式
  const parsedColon = parseLocationHash('#/settings/plugins/builtin%3Aworkflow')
  assert.deepEqual(parsedColon.primaryTarget, { kind: 'plugins', pluginId: 'builtin:workflow' })
})

test('parseHash: 旧 ?p 查询参数不再参与解码，目标只来自路径段', { timeout: 60_000 }, () => {
  // 旧 ?p 参数被静默忽略，路径段本身无子项
  const parsed = parseHash('#/settings/plugins?p=builtin:workflow')
  assert.deepEqual(parsed.primaryTarget, { kind: 'plugins' })

  // 旧顶层 #/plugins 路径形态整体非法，回退默认主屏（角色中心）
  const legacy = parseLocationHash('#/plugins?p=builtin:workflow')
  assert.deepEqual(legacy.primaryTarget, { kind: 'profiles' })
})

test('roundtrip: plugins 目标双向编解码往返无损', { timeout: 60_000 }, () => {
  const states: WorkspaceLocationState[] = [
    baseState({ kind: 'plugins' }),
    baseState({ kind: 'plugins', pluginId: 'builtin:workflow' }),
    baseState({ kind: 'plugins', pluginId: 'custom-tool' }),
    {
      primaryTarget: { kind: 'plugins', pluginId: 'builtin:workflow' },
      splitTarget: { kind: 'conversation', conversationId: 5 },
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

test('isSameResolvedTarget: plugins 目标精确比较', { timeout: 60_000 }, () => {
  assert.equal(
    isSameResolvedTarget({ kind: 'plugins' }, { kind: 'plugins' }),
    true,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'plugins', pluginId: 'builtin:workflow' },
      { kind: 'plugins', pluginId: 'builtin:workflow' },
    ),
    true,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'plugins', pluginId: 'builtin:workflow' },
      { kind: 'plugins', pluginId: 'builtin:herdr' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'plugins' },
      { kind: 'plugins', pluginId: 'builtin:workflow' },
    ),
    false,
  )
  assert.equal(
    isSameResolvedTarget(
      { kind: 'plugins' },
      { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID },
    ),
    false,
  )
})

test('resolveTargetString: 支持 plugins 与 plugins:<pluginId> 声明式目标', { timeout: 60_000 }, () => {
  assert.deepEqual(resolveTargetString('plugins', []), { kind: 'plugins' })
  assert.deepEqual(resolveTargetString('plugins:', []), { kind: 'plugins' })
  assert.deepEqual(resolveTargetString('plugins:builtin:workflow', []), {
    kind: 'plugins',
    pluginId: 'builtin:workflow',
  })
})

// ---------------------------------------------------------------------------
// 4. 历史栈策略 (shouldPushLocationHistory)
// ---------------------------------------------------------------------------

test('shouldPushLocationHistory: 跨视图切换进出插件中心走 push', { timeout: 60_000 }, () => {
  const convState = baseState({ kind: 'conversation', conversationId: 1 })
  const pluginsState = baseState({ kind: 'plugins' })
  const pluginDetailState = baseState({ kind: 'plugins', pluginId: 'builtin:workflow' })

  // 会话 -> 插件中心：push
  assert.equal(shouldPushLocationHistory(convState, pluginsState), true)
  // 插件中心 -> 会话：push
  assert.equal(shouldPushLocationHistory(pluginsState, convState), true)
  // 会话 -> 插件中心特定插件：push
  assert.equal(shouldPushLocationHistory(convState, pluginDetailState), true)
})

test('shouldPushLocationHistory: 插件中心列表打开抽屉走 push，抽屉内切换或关闭走 replace', { timeout: 60_000 }, () => {
  const pluginsState = baseState({ kind: 'plugins' })
  const detailA = baseState({ kind: 'plugins', pluginId: 'builtin:workflow' })
  const detailB = baseState({ kind: 'plugins', pluginId: 'builtin:herdr' })

  // 1. 从列表打开抽屉：push（支持浏览器后退关闭抽屉）
  assert.equal(shouldPushLocationHistory(pluginsState, detailA), true)

  // 2. 抽屉内切换不同插件：replace（避免后退栈被连续点选污染）
  assert.equal(shouldPushLocationHistory(detailA, detailB), false)

  // 3. 关闭抽屉回到列表：replace（平滑关闭，不污染后退栈）
  assert.equal(shouldPushLocationHistory(detailA, pluginsState), false)
})

test('shouldPushLocationHistory: 插件中心主屏下打开弹窗、工作台或分屏均正确走 push', { timeout: 60_000 }, () => {
  const pluginsState = baseState({ kind: 'plugins' })
  const drawerOpenState = baseState({ kind: 'plugins', pluginId: 'builtin:workflow' })

  // 1. 列表态下打开弹窗（activeModal）走 push
  assert.equal(
    shouldPushLocationHistory(pluginsState, { ...pluginsState, activeModal: { kind: 'provider-auth' } }),
    true,
  )
  assert.equal(
    shouldPushLocationHistory(pluginsState, { ...pluginsState, activeModal: { kind: 'profile-editor' } }),
    true,
  )

  // 2. 抽屉打开态下打开弹窗走 push
  assert.equal(
    shouldPushLocationHistory(drawerOpenState, { ...drawerOpenState, activeModal: { kind: 'nodes' } }),
    true,
  )

  // 3. 插件中心下打开工作台抽屉（workbenchOpen）走 push
  assert.equal(
    shouldPushLocationHistory(pluginsState, { ...pluginsState, workbenchOpen: true }),
    true,
  )
  assert.equal(
    shouldPushLocationHistory(drawerOpenState, { ...drawerOpenState, workbenchOpen: true }),
    true,
  )

  // 4. 插件中心下打开分屏（splitTarget）走 push
  assert.equal(
    shouldPushLocationHistory(pluginsState, {
      ...pluginsState,
      splitTarget: { kind: 'conversation', conversationId: 10 },
    }),
    true,
  )
})

// ---------------------------------------------------------------------------
// 5. 浏览器前进/后退/replace 序列一致性仿真
// ---------------------------------------------------------------------------

test('浏览器前进/后退/replace 序列一致性验证', { timeout: 60_000 }, () => {
  const history: string[] = []
  let currentIndex = -1

  const navigate = (nextState: WorkspaceLocationState) => {
    const nextHash = formatLocationHash(nextState)
    if (currentIndex >= 0) {
      const prevState = parseLocationHash(history[currentIndex]!)
      if (shouldPushLocationHistory(prevState, nextState)) {
        history.splice(currentIndex + 1)
        history.push(nextHash)
        currentIndex++
        return
      }
    }
    if (currentIndex === -1) {
      history.push(nextHash)
      currentIndex = 0
    } else {
      history[currentIndex] = nextHash
    }
  }

  // 1. 用户从根会话开始
  navigate(baseState({ kind: 'conversation', conversationId: 1 }))
  assert.equal(history[currentIndex]!, '#/c/1')
  assert.equal(history.length, 1)

  // 2. 点击左侧栏插件中心 -> push
  navigate(baseState({ kind: 'plugins' }))
  assert.equal(history[currentIndex]!, '#/settings/plugins')
  assert.equal(history.length, 2)

  // 3. 点击 workflow 卡片打开抽屉 -> push
  navigate(baseState({ kind: 'plugins', pluginId: 'builtin:workflow' }))
  assert.equal(history[currentIndex]!, '#/settings/plugins/builtin:workflow')
  assert.equal(history.length, 3)

  // 4. 抽屉内切换至 herdr -> replace（栈深保持 3，未污染后退栈）
  navigate(baseState({ kind: 'plugins', pluginId: 'builtin:herdr' }))
  assert.equal(history[currentIndex]!, '#/settings/plugins/builtin:herdr')
  assert.equal(history.length, 3)

  // 5. 用户按浏览器后退键（popstate）-> 退回上一历史帧 #/settings/plugins（抽屉收起）
  currentIndex--
  assert.equal(history[currentIndex]!, '#/settings/plugins')
  const backToPlugins = parseLocationHash(history[currentIndex]!)
  assert.deepEqual(backToPlugins.primaryTarget, { kind: 'plugins' })

  // 6. 用户再次按浏览器后退键 -> 回到 #/c/1
  currentIndex--
  assert.equal(history[currentIndex]!, '#/c/1')
  const backToConv = parseLocationHash(history[currentIndex]!)
  assert.deepEqual(backToConv.primaryTarget, { kind: 'conversation', conversationId: 1 })

  // 7. 用户点击浏览器前进键 -> 回到 #/settings/plugins
  currentIndex++
  assert.equal(history[currentIndex]!, '#/settings/plugins')

  // 8. 用户再次点击浏览器前进键 -> 还原选中的插件抽屉状态
  currentIndex++
  assert.equal(history[currentIndex]!, '#/settings/plugins/builtin:herdr')
  const forwardToDetail = parseLocationHash(history[currentIndex]!)
  assert.deepEqual(forwardToDetail.primaryTarget, {
    kind: 'plugins',
    pluginId: 'builtin:herdr',
  })

  // 9. 用户点击抽屉上的关闭按钮 -> replace 为 #/settings/plugins（不增加历史栈深度）
  navigate(baseState({ kind: 'plugins' }))
  assert.equal(history[currentIndex]!, '#/settings/plugins')
  assert.equal(history.length, 3)
})
