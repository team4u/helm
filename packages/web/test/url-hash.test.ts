import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { parseScreenTargetQuery } from '../src/lib/types.js'
import {
  formatLocationHash,
  isSameLocationState,
  parseLocationHash,
  serializeHash,
  shouldPushLocationHistory,
  type WorkspaceLocationState,
} from '../src/lib/url-hash-model.js'
import { isSameResolvedTarget, resolveTargetString } from '../src/lib/types.js'

const conversation = (conversationId: number): WorkspaceLocationState => ({
  primaryTarget: { kind: 'conversation', conversationId },
  splitTarget: null,
  workbenchOpen: false,
  workbenchTab: 'artifacts',
  activeModal: null,
})

const roundtrip = (state: WorkspaceLocationState): WorkspaceLocationState =>
  parseLocationHash(formatLocationHash(state))

// ---------------------------------------------------------------------------
// parseLocationHash：主屏、分屏、工作台与弹窗
// ---------------------------------------------------------------------------

test('parse: 会话主屏（#/c/<id>）与空 Hash 默认角色中心', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/c/42')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 42 })
  assert.equal(parsed.splitTarget, null)
  assert.equal(parsed.workbenchOpen, false)
  assert.equal(parsed.workbenchTab, 'artifacts')
  assert.equal(parsed.activeModal, null)
  // "" / "#" / "#/" 均解析为默认角色中心（无会话依赖，零会话可用）
  for (const raw of ['', '#', '#/']) {
    const empty = parseLocationHash(raw)
    assert.deepEqual(empty.primaryTarget, { kind: 'profiles' })
    assert.equal(empty.splitTarget, null)
    assert.equal(empty.workbenchOpen, false)
    assert.equal(empty.activeModal, null)
  }
})

test('parse: 插件全屏视图（#/s/<pluginId>/<screenId>，pluginId 含冒号保持可读）', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/s/builtin:herdr/overview')
  assert.deepEqual(parsed.primaryTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
  // 百分号编码形式同样可解析（与 resolveTargetString 的 lastIndexOf 切分语义一致）
  const encoded = parseLocationHash('#/s/builtin%3Aherdr/overview')
  assert.deepEqual(encoded.primaryTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
})

test('parse: 分屏参数 split（会话与插件视图、编码形式）', { timeout: 60_000 }, () => {
  const convSplit = parseLocationHash('#/c/1?split=c/42')
  assert.deepEqual(convSplit.splitTarget, { kind: 'conversation', conversationId: 42 })
  const screenSplit = parseLocationHash('#/c/1?split=s/builtin:herdr/overview')
  assert.deepEqual(screenSplit.splitTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
  const encodedSplit = parseLocationHash('#/c/1?split=s%2Fbuiltin%3Aherdr%2Foverview')
  assert.deepEqual(encodedSplit.splitTarget, { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' })
})

test('parse: 模型中心全局默认 Tab（#/models?tab=defaults）与旧 id=defaults 深链升级', { timeout: 60_000 }, () => {
  // 新契约：tab=defaults 直达全局默认 Tab
  assert.deepEqual(parseLocationHash('#/models?tab=defaults').primaryTarget, {
    kind: 'models',
    tab: 'defaults',
  })
  // 与供应商抽屉深链正交组合：providerId + tab 同时保留
  const combo = parseLocationHash('#/models?id=anthropic&tab=defaults')
  assert.deepEqual(combo.primaryTarget, { kind: 'models', providerId: 'anthropic', tab: 'defaults' })
  // 旧深链 id=defaults（虚拟卡片）自动升级为全局默认 Tab
  assert.deepEqual(parseLocationHash('#/models?id=defaults').primaryTarget, {
    kind: 'models',
    tab: 'defaults',
  })
  // 非法 tab 值静默丢弃（仅接受 defaults）
  assert.deepEqual(parseLocationHash('#/models?tab=providers').primaryTarget, { kind: 'models' })
  assert.deepEqual(parseLocationHash('#/models?tab=unknown').primaryTarget, { kind: 'models' })
  // 分屏目标同样支持 tab=defaults
  const split = parseLocationHash('#/c/1?split=models%3Ftab%3Ddefaults')
  assert.deepEqual(split.splitTarget, { kind: 'models', tab: 'defaults' })
})

test('format: 模型中心 tab=defaults 序列化与往返无损；providers 缺省不序列化', { timeout: 60_000 }, () => {
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'models', tab: 'defaults' } }),
    '#/models?tab=defaults',
  )
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: { kind: 'models', tab: 'providers' } }),
    '#/models',
  )
  // providerId + tab 组合
  assert.equal(
    formatLocationHash({
      ...conversation(1),
      primaryTarget: { kind: 'models', providerId: 'anthropic', tab: 'defaults' },
    }),
    '#/models?id=anthropic&tab=defaults',
  )
  // 往返无损
  const state: WorkspaceLocationState = {
    ...conversation(1),
    primaryTarget: { kind: 'models', tab: 'defaults' },
  }
  assert.deepEqual(roundtrip(state), state)
  // tab 差异参与位置比较；同中心切 Tab 不入历史栈（replace）
  const providersState: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'models' } }
  const defaultsState: WorkspaceLocationState = {
    ...conversation(1),
    primaryTarget: { kind: 'models', tab: 'defaults' },
  }
  assert.equal(isSameLocationState(providersState, defaultsState), false)
  assert.equal(shouldPushLocationHistory(providersState, defaultsState), false)
  assert.equal(shouldPushLocationHistory(defaultsState, providersState), false)
})

test('parse: 工作台参数 wb（开、Tab 值与缺省关闭）', { timeout: 60_000 }, () => {
  const open = parseLocationHash('#/c/1?wb=artifacts')
  assert.equal(open.workbenchOpen, true)
  assert.equal(open.workbenchTab, 'artifacts')
  const closed = parseLocationHash('#/c/1')
  assert.equal(closed.workbenchOpen, false)
  assert.equal(closed.workbenchTab, 'artifacts')
  // wb 存在但值为空：视为打开且 Tab 回退默认 artifacts；wb=tasks 解析为插件面板 ID
  const emptyTab = parseLocationHash('#/c/1?wb=')
  assert.equal(emptyTab.workbenchOpen, true)
  assert.equal(emptyTab.workbenchTab, 'artifacts')
  const pluginTab = parseLocationHash('#/c/1?wb=tasks')
  assert.equal(pluginTab.workbenchOpen, true)
  assert.equal(pluginTab.workbenchTab, 'tasks')
})

test('parse: 六种弹窗及子项 ID（profiles/providers/skills/plugins/nodes/artifact）', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/c/1?modal=profiles').activeModal, { kind: 'profile-editor' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=profiles&id=watchdog').activeModal, { kind: 'profile-editor', profileId: 'watchdog' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=providers').activeModal, { kind: 'provider-auth' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=skills').activeModal, { kind: 'skill-viewer' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=skills&id=git-commit').activeModal, { kind: 'skill-viewer', skillId: 'git-commit' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=plugins').activeModal, { kind: 'plugin-settings' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=plugins&id=builtin:herdr').activeModal, { kind: 'plugin-settings', pluginId: 'builtin:herdr' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=nodes').activeModal, { kind: 'nodes' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=nodes&id=gpu-server').activeModal, { kind: 'nodes', nodeId: 'gpu-server' })
  assert.deepEqual(parseLocationHash('#/c/1?modal=artifact&id=art-123&conv=42').activeModal, {
    kind: 'artifact-preview',
    artifactId: 'art-123',
    conversationId: 42,
  })
  assert.deepEqual(parseLocationHash('#/c/1?modal=drawer&id=42').activeModal, {
    kind: 'conversation-drawer',
    conversationId: 42,
  })
})

// ---------------------------------------------------------------------------
// formatLocationHash：规范形式与往返
// ---------------------------------------------------------------------------

test('format: 会话目标输出规范 #/c/<id>', { timeout: 60_000 }, () => {
  assert.equal(formatLocationHash(conversation(1)), '#/c/1')
})

test('format: command-palette 是瞬态弹窗，不序列化进 URL', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = { ...conversation(1), activeModal: { kind: 'command-palette' } }
  assert.equal(formatLocationHash(state), '#/c/1')
})

test('format: 组合状态（视图主屏 + 会话分屏 + 工作台 + 弹窗子项，URLSearchParams 规范编码）', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
    splitTarget: { kind: 'conversation', conversationId: 42 },
    workbenchOpen: true,
    workbenchTab: 'plugin:builtin:herdr/panel-x',
    activeModal: { kind: 'skill-viewer', skillId: 'git-commit' },
  }
  const hash = formatLocationHash(state)
  // query 部分是标准 URLSearchParams.toString()：值内 / 与 : 均编码；
  // 路径 segment 仅保留冒号可读（builtin:herdr）。
  assert.equal(
    hash,
    '#/s/builtin:herdr/overview?split=c%2F42&wb=plugin%3Abuiltin%3Aherdr%2Fpanel-x&modal=skills&id=git-commit',
  )
  // 用 URLSearchParams 解析断言等价：不依赖手写编码预期。
  const query = new URLSearchParams(hash.slice(hash.indexOf('?') + 1))
  assert.equal(query.get('split'), 'c/42')
  assert.equal(query.get('wb'), 'plugin:builtin:herdr/panel-x')
  assert.equal(query.get('modal'), 'skills')
  assert.equal(query.get('id'), 'git-commit')
  assert.deepEqual(roundtrip(state), state)
})

test('roundtrip: 全部位置形态双向往返无损', { timeout: 60_000 }, () => {
  const states: WorkspaceLocationState[] = [
    conversation(1),
    conversation(777),
    {
      primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' },
      splitTarget: { kind: 'screen', pluginId: 'builtin:superagent', screenId: 'router' },
      workbenchOpen: false,
      workbenchTab: 'artifacts',
      activeModal: null,
    },
    { ...conversation(1), splitTarget: { kind: 'conversation', conversationId: 42 } },
    { ...conversation(1), workbenchOpen: true, workbenchTab: 'artifacts' },
    { ...conversation(1), activeModal: { kind: 'profile-editor' } },
    { ...conversation(1), activeModal: { kind: 'profile-editor', profileId: 'watchdog' } },
    { ...conversation(1), activeModal: { kind: 'provider-auth' } },
    { ...conversation(1), activeModal: { kind: 'skill-viewer', skillId: 'web-search' } },
    { ...conversation(1), activeModal: { kind: 'plugin-settings', pluginId: 'builtin:herdr' } },
    { ...conversation(1), activeModal: { kind: 'nodes', nodeId: 'gpu-server' } },
    { ...conversation(1), activeModal: { kind: 'artifact-preview', artifactId: 'art-9' } },
    { ...conversation(1), activeModal: { kind: 'artifact-preview', artifactId: 'art-9', conversationId: 42 } },
    { ...conversation(1), activeModal: { kind: 'conversation-drawer', conversationId: 11 } },
  ]
  for (const state of states) {
    const back = roundtrip(state)
    assert.equal(isSameLocationState(back, state), true, `roundtrip failed: ${JSON.stringify(state)}`)
  }
})

// ---------------------------------------------------------------------------
// 边界防御：非法 / 脏 Hash 输入
// ---------------------------------------------------------------------------

test('parse: 非法主屏路径回退默认角色中心（无 NaN / 空段）', { timeout: 60_000 }, () => {
  for (const raw of ['#/c/abc', '#/c/0', '#/c/-5', '#/c/1.5', '#/c/ 1', '#/unknown', '#/s/onlyone', '#/s//x', '#/s/x/', '#/c/9999999999999999999999']) {
    const parsed = parseLocationHash(raw)
    assert.deepEqual(parsed.primaryTarget, { kind: 'profiles' }, raw)
  }
})

test('parse: 非法分屏值忽略为 null', { timeout: 60_000 }, () => {
  for (const raw of ['#/c/1?split=bad', '#/c/1?split=', '#/c/1?split=c/0', '#/c/1?split=c/abc', '#/c/1?split=s/only-plugin', '#/c/1?split=x/1']) {
    assert.equal(parseLocationHash(raw).splitTarget, null, raw)
  }
})

test('parse: 未知 modal 值与 artifact 缺 id 均丢弃为 null', { timeout: 60_000 }, () => {
  assert.equal(parseLocationHash('#/c/1?modal=unknown').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=command-palette').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=artifact').activeModal, null)
  assert.equal(parseLocationHash('#/c/1?modal=artifact&id=').activeModal, null)
  // artifact 携带非法 conv（非正整数）时保留弹窗但丢弃 conversationId
  const badConv = parseLocationHash('#/c/1?modal=artifact&id=a1&conv=abc')
  assert.deepEqual(badConv.activeModal, { kind: 'artifact-preview', artifactId: 'a1' })
  // id 为空串的列表型弹窗按未指定子项处理
  assert.deepEqual(parseLocationHash('#/c/1?modal=skills&id=').activeModal, { kind: 'skill-viewer' })
})

test('parse: 非法百分号序列不抛出（decode 失败按无效段回退默认）', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/s/%E0%A4%A/x').primaryTarget, { kind: 'profiles' })
})

// ---------------------------------------------------------------------------
// 侧栏空间（sidebar 参数）：Rail 点击入链，刷新/前进/后退可还原
// ---------------------------------------------------------------------------

test('parse: 侧栏空间 sidebar（偏离隐含空间时恢复；缺省/非法值回退隐含空间）', { timeout: 60_000 }, () => {
  assert.equal(parseLocationHash('#/c/5?sidebar=settings').sidebarSpace, 'settings')
  assert.equal(parseLocationHash('#/c/5?sidebar=views').sidebarSpace, 'views')
  // 缺省不产生键 = 跟随主屏隐含空间（保持既有往返契约）
  assert.equal(parseLocationHash('#/c/5').sidebarSpace, undefined)
  assert.equal(parseLocationHash('#/profiles').sidebarSpace, undefined)
  assert.equal(parseLocationHash('#/s/builtin:herdr/overview').sidebarSpace, undefined)
  // 与隐含一致的显式值忠实保留（序列化时会去重省略）
  assert.equal(parseLocationHash('#/profiles?sidebar=settings').sidebarSpace, 'settings')
  // 非法值静默丢弃
  for (const raw of ['#/c/5?sidebar=bogus', '#/c/5?sidebar=', '#/c/5?sidebar=constructor', '#/c/5?sidebar=Views']) {
    assert.equal(parseLocationHash(raw).sidebarSpace, undefined, raw)
  }
})

test('format: 侧栏空间仅偏离隐含时序列化 sidebar；与其它参数共存且往返稳定', { timeout: 60_000 }, () => {
  assert.equal(formatLocationHash({ ...conversation(5), sidebarSpace: 'settings' }), '#/c/5?sidebar=settings')
  // 与隐含一致 / 未指定时不序列化，保持常用 URL 干净
  assert.equal(formatLocationHash({ ...conversation(5), sidebarSpace: 'conversations' }), '#/c/5')
  assert.equal(formatLocationHash(conversation(5)), '#/c/5')
  // 主屏在设置中心时隐含 settings：仅对话/视图偏离才序列化
  const center: WorkspaceLocationState = { ...conversation(5), primaryTarget: { kind: 'profiles' } }
  assert.equal(formatLocationHash({ ...center, sidebarSpace: 'settings' }), '#/profiles')
  assert.equal(formatLocationHash({ ...center, sidebarSpace: 'conversations' }), '#/profiles?sidebar=conversations')
  // 与分屏/工作台共存往返无损
  const state: WorkspaceLocationState = {
    ...conversation(5),
    splitTarget: { kind: 'conversation', conversationId: 9 },
    workbenchOpen: true,
    workbenchTab: 'artifacts',
    sidebarSpace: 'views',
  }
  const back = roundtrip(state)
  assert.equal(back.sidebarSpace, 'views')
  assert.equal(isSameLocationState(back, state), true)
  assert.equal(formatLocationHash(back), formatLocationHash(state))
})

test('isSameLocationState / shouldPushLocationHistory: 侧栏空间参与位置比较，单独变化默认 replace', { timeout: 60_000 }, () => {
  const base = conversation(1)
  // 显式值与隐含空间一致时等价（未指定 = 隐含）
  assert.equal(isSameLocationState(base, { ...base, sidebarSpace: 'conversations' }), true)
  assert.equal(isSameLocationState(base, { ...base, sidebarSpace: 'settings' }), false)
  // 仅侧栏空间变化默认 replace；Rail 点击由 setSidebarSpace 显式标记 push
  assert.equal(shouldPushLocationHistory(base, { ...base, sidebarSpace: 'settings' }), false)
})

// ---------------------------------------------------------------------------
// isSameLocationState 与 shouldPushLocationHistory
// ---------------------------------------------------------------------------

test('isSameLocationState: 五字段逐一比较；command-palette 等价于 null', { timeout: 60_000 }, () => {
  const base = conversation(1)
  assert.equal(isSameLocationState(base, conversation(1)), true)
  assert.equal(isSameLocationState(base, conversation(2)), false)
  assert.equal(isSameLocationState(base, { ...base, splitTarget: { kind: 'conversation', conversationId: 1 } }), false)
  assert.equal(isSameLocationState(base, { ...base, workbenchOpen: true, workbenchTab: 'artifacts' }), false)
  // 工作台打开时 Tab 参与比较；关闭时 Tab 只是记忆值不参与
  const openA = { ...base, workbenchOpen: true, workbenchTab: 'artifacts' }
  const openB = { ...base, workbenchOpen: true, workbenchTab: 'plugin:example/queue' }
  assert.equal(isSameLocationState(openA, openB), false)
  const closedA = { ...base, workbenchOpen: false, workbenchTab: 'artifacts' }
  const closedB = { ...base, workbenchOpen: false, workbenchTab: 'plugin:example/queue' }
  assert.equal(isSameLocationState(closedA, closedB), true)
  assert.equal(isSameLocationState(base, { ...base, activeModal: { kind: 'command-palette' } }), true)
  assert.equal(isSameLocationState(base, { ...base, activeModal: { kind: 'profile-editor' } }), false)
  assert.equal(
    isSameLocationState({ ...base, activeModal: { kind: 'skill-viewer', skillId: 'a' } }, { ...base, activeModal: { kind: 'skill-viewer', skillId: 'b' } }),
    false,
  )
})

test('shouldPushLocationHistory: 主屏/分屏/工作台/弹窗开关走 push', { timeout: 60_000 }, () => {
  const base = conversation(1)
  assert.equal(shouldPushLocationHistory(base, conversation(2)), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, primaryTarget: { kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview' } }), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, splitTarget: { kind: 'conversation', conversationId: 2 } }), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, workbenchOpen: true, workbenchTab: 'artifacts' }), true)
  assert.equal(shouldPushLocationHistory(base, { ...base, activeModal: { kind: 'nodes' } }), true)
  assert.equal(shouldPushLocationHistory({ ...base, activeModal: { kind: 'nodes' } }, base), true)
  // 弹窗类型切换也是 push
  assert.equal(
    shouldPushLocationHistory({ ...base, activeModal: { kind: 'skill-viewer' } }, { ...base, activeModal: { kind: 'nodes' } }),
    true,
  )
  // 产物预览切换不同 artifactId / conversationId 是 push
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1' } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a2' } },
    ),
    true,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1', conversationId: 1 } },
      { ...base, activeModal: { kind: 'artifact-preview', artifactId: 'a1', conversationId: 2 } },
    ),
    true,
  )
})

test('shouldPushLocationHistory: 同弹窗内切子项与工作台内切 Tab 走 replace', { timeout: 60_000 }, () => {
  const base = conversation(1)
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'profile-editor', profileId: 'a' } },
      { ...base, activeModal: { kind: 'profile-editor', profileId: 'b' } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'skill-viewer', skillId: 'a' } },
      { ...base, activeModal: { kind: 'skill-viewer', skillId: 'b' } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'plugin-settings', pluginId: 'builtin:herdr' } },
      { ...base, activeModal: { kind: 'plugin-settings', pluginId: 'builtin:triggers' } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'nodes', nodeId: 'local' } },
      { ...base, activeModal: { kind: 'nodes', nodeId: 'gpu-server' } },
    ),
    false,
  )
  assert.equal(
    shouldPushLocationHistory(
      { ...base, workbenchOpen: true, workbenchTab: 'artifacts' },
      { ...base, workbenchOpen: true, workbenchTab: 'artifacts' },
    ),
    false,
  )
  // 未指定子项 -> 指定子项属同弹窗内选项，同样 replace
  assert.equal(
    shouldPushLocationHistory(
      { ...base, activeModal: { kind: 'skill-viewer' } },
      { ...base, activeModal: { kind: 'skill-viewer', skillId: 'x' } },
    ),
    false,
  )
})

// ---------------------------------------------------------------------------
// 源码契约断言：HelmStoreProvider 双向同步与 4 个列表型 Modal 的深链保活
// ---------------------------------------------------------------------------
// 数据流仿真：列表型弹窗选中项双向同步（props→local 跟随、本地决策→store 守卫写回）
//
// 仿真器逐拍驱动真实决策纯函数（list-modal-selection.ts），重建 Modal 与
// Provider 的关键时序：外部深链、列表兑底、用户点选、弹窗关闭/切类型。
// 回环检测：任何一拍后 activeModal 若被写回为本弹窗但组件已不再挂载（模拟
// App.tsx 按类型条件渲染），断言失败。
// ---------------------------------------------------------------------------

import { deepLinkSelection, fallbackSelection, shouldClearSelectionInStore, shouldSyncSelectionToStore, type ListModalKind } from '../src/modals/list-modal-selection.js'
import type { ActiveModal } from '../src/lib/types.js'

interface ModalSimFrame {
  /** 本拍驱动描述（仅用于失败信息） */
  step: string
  /** 外部深链子项 id（props.initial*Id 变化）；undefined 表示未变 */
  deepLinkId?: string
  /** 列表 id 快照变化 */
  listIds?: readonly string[]
  /** 用户点选事件 */
  userPick?: string
  /** Provider 侧 activeModal 整体替换（弹窗关闭/切类型） */
  storeModalBecomes?: ActiveModal
}

const kindSub = (kind: ListModalKind, id: string): Record<string, string> => {
  switch (kind) {
    case 'profile-editor': return { profileId: id }
    case 'skill-viewer': return { skillId: id }
    case 'plugin-settings': return { pluginId: id }
    case 'nodes': return { nodeId: id }
  }
}

/** 单个列表型弹窗的简化状态机：与四个 Modal 的 effect 逻辑同构（决策函数即真实实现）。 */
function simulateListModal(kind: ListModalKind, initialId: string | undefined, frames: ModalSimFrame[]) {
  const storeWrites: string[] = []
  let storeActiveModal: ActiveModal = initialId !== undefined ? ({ kind, ...kindSub(kind, initialId) } as ActiveModal) : { kind }
  let selectedId: string | null = initialId ?? null
  let hadList = false
  let listIds: readonly string[] = []
  let mounted = true
  for (const frame of frames) {
    if (frame.storeModalBecomes !== undefined) {
      storeActiveModal = frame.storeModalBecomes
      // App.tsx 按类型条件渲染：弹窗关闭或切类型后本组件卸载。
      mounted = storeActiveModal !== null && storeActiveModal.kind === kind
    }
    if (frame.listIds !== undefined) {
      listIds = frame.listIds
      if (listIds.length > 0) hadList = true
    }
    // 外部深链：本地跟随，不写回（源头即 store/URL——store 先于 prop 变化，同步更新）。
    if (frame.deepLinkId !== undefined) {
      const next = deepLinkSelection(selectedId, frame.deepLinkId)
      if (next !== null) {
        selectedId = next
        storeActiveModal = { kind, ...kindSub(kind, next) } as ActiveModal
      }
    }
    // 用户点选：本地更新 + 守卫写回。
    if (frame.userPick !== undefined) {
      selectedId = frame.userPick
      if (mounted && shouldSyncSelectionToStore(storeActiveModal, kind, frame.userPick)) {
        storeActiveModal = { kind, ...kindSub(kind, frame.userPick) } as ActiveModal
        storeWrites.push(frame.userPick)
      }
    }
    // 列表兑底：本地更新 + 守卫写回；清单空且从未到达（skill 资产未返回）保留深链。
    // skill-viewer 清单确实清空（hadList 后为空）时无条件清选中（含 null）。
    if (frame.listIds !== undefined) {
      if (!(selectedId !== null && listIds.includes(selectedId))
        && !(kind === 'skill-viewer' && listIds.length === 0 && !hadList)) {
        const next = fallbackSelection(selectedId, listIds)
        if (next !== null || (kind === 'skill-viewer' && listIds.length === 0)) {
          selectedId = next
          if (next !== null && mounted && shouldSyncSelectionToStore(storeActiveModal, kind, next)) {
            storeActiveModal = { kind, ...kindSub(kind, next) } as ActiveModal
            storeWrites.push(next)
          }
        }
      }
    }
    // 回环检测：组件未挂载时绝不允许把 activeModal 写回为本弹窗。
    if (!mounted) {
      assert.ok(
        !(storeActiveModal !== null && storeActiveModal.kind === kind),
        `回环：${frame.step} 后已卸载的 ${kind} 把 activeModal 重新拉回本弹窗`,
      )
    }
  }
  return { selectedId, storeActiveModal, storeWrites }
}

test('仿真: 刷新后列表未到不抹深链，列表到达后无效选中才兑底并写回 store', { timeout: 60_000 }, () => {
  // 刷新深链 modal=skills&id=web-search，首拍 skills 为空（资产未返回）。
  const r1 = simulateListModal('skill-viewer', 'web-search', [
    { step: '挂载，列表空', listIds: [] },
    { step: '列表到达且含深链 id', listIds: ['web-search', 'git-commit'] },
  ])
  assert.equal(r1.selectedId, 'web-search')
  assert.deepEqual(r1.storeActiveModal, { kind: 'skill-viewer', skillId: 'web-search' })
  // 列表到达但深链 id 不存在：兑底首项并写回。
  const r2 = simulateListModal('skill-viewer', 'ghost', [
    { step: '挂载，列表空', listIds: [] },
    { step: '列表到达但无 ghost', listIds: ['web-search', 'git-commit'] },
  ])
  assert.equal(r2.selectedId, 'web-search')
  assert.deepEqual(r2.storeActiveModal, { kind: 'skill-viewer', skillId: 'web-search' })
  assert.deepEqual(r2.storeWrites, ['web-search'])
})

test('仿真: 弹窗关闭/切类型后本地决策不得把旧弹窗重新拉回（无回环）', { timeout: 60_000 }, () => {
  // 用户点选后弹窗被关闭：后续任何兑底/点选都不得写回。
  const r = simulateListModal('nodes', 'local', [
    { step: '用户点选 gpu-server', userPick: 'gpu-server' },
    { step: '弹窗关闭', storeModalBecomes: null },
    { step: '列表兑底（已卸载）', listIds: ['local', 'gpu-server'] },
  ])
  assert.equal(r.selectedId, 'gpu-server')
  assert.equal(r.storeActiveModal, null)
  assert.deepEqual(r.storeWrites, ['gpu-server'])
  // 切换到另一弹窗类型后：本弹窗写回被守卫拒绝。
  const r2 = simulateListModal('profile-editor', 'assistant', [
    { step: '切到 skill-viewer', storeModalBecomes: { kind: 'skill-viewer' } },
    { step: '用户点选（已卸载）', userPick: 'watchdog' },
  ])
  assert.equal(r2.storeActiveModal?.kind, 'skill-viewer')
  assert.deepEqual(r2.storeWrites, [])
})

test('仿真: 外部深链同类型切换条目不被旧 selectedId 改回（无写回回环）', { timeout: 60_000 }, () => {
  // 场景：用户在弹窗内点选 b 后，手动改 hash/前进后退回到 a。
  // 正确行为：本地跟随 a，且不产生任何 store 写回（源头即 store）。
  const r = simulateListModal('plugin-settings', 'builtin:herdr', [
    { step: '用户点选 builtin:triggers', userPick: 'builtin:triggers' },
    { step: '外部深链切回 builtin:herdr', deepLinkId: 'builtin:herdr' },
    { step: '深链回声（同值再来一次）', deepLinkId: 'builtin:herdr' },
  ])
  assert.equal(r.selectedId, 'builtin:herdr')
  assert.equal((r.storeActiveModal as { pluginId?: string }).pluginId, 'builtin:herdr')
  assert.deepEqual(r.storeWrites, ['builtin:triggers'], '深链跟随帧不得产生 store 写回')
})

test('仿真: 技能清单确实清空（全部停用）时清选中；从未到达时空清单保留深链', { timeout: 60_000 }, () => {
  // 首拍列表到达（hadList=true），之后清单清空：不得保留旧选中。
  const r = simulateListModal('skill-viewer', 'web-search', [
    { step: '列表到达', listIds: ['web-search'] },
    { step: '技能全部停用，清单清空', listIds: [] },
  ])
  assert.equal(r.selectedId, null)
  // 反之：从未到达（刷新中）清单为空：保留深链选中。
  const r2 = simulateListModal('skill-viewer', 'web-search', [
    { step: '挂载，列表空且从未到达', listIds: [] },
  ])
  assert.equal(r2.selectedId, 'web-search')
})

test('仿真: 进入新建模式时仅弹窗仍是本类型才清深链子项 id', { timeout: 60_000 }, () => {
  // shouldClearSelectionInStore 直接验证：关闭/切类型后不清（不会重开旧弹窗）。
  assert.equal(shouldClearSelectionInStore({ kind: 'profile-editor', profileId: 'a' }, 'profile-editor'), true)
  assert.equal(shouldClearSelectionInStore({ kind: 'profile-editor' }, 'profile-editor'), false)
  assert.equal(shouldClearSelectionInStore(null, 'profile-editor'), false)
  assert.equal(shouldClearSelectionInStore({ kind: 'skill-viewer' }, 'profile-editor'), false)
})

// ---------------------------------------------------------------------------
// 源码契约断言（防仿真与实现漂移：决策函数必须被真实消费）
// ---------------------------------------------------------------------------

const readSource = (relative: string): Promise<string> =>
  readFile(new URL(relative, import.meta.url), 'utf8')

test('契约: HelmStoreProvider 初始状态取自 Hash、监听外部变更、认证后才写回', { timeout: 60_000 }, async () => {
  const source = await readSource('../src/lib/HelmStoreProvider.tsx')
  // 初始状态从 window.location.hash 解析（含 SSR 安全守卫）
  assert.match(source, /parseLocationHash\(typeof window !== 'undefined' \? window\.location\.hash : ''\)/)
  // 监听外部 URL 变更（前进/后退/手动改 Hash）
  assert.match(source, /addEventListener\('hashchange'/)
  assert.match(source, /addEventListener\('popstate'/)
  // 写回仅在 authenticated 后进行：AuthGate 阶段不得用默认态覆盖用户粘贴的深链
  // （锚定写回 effect 注释；切片终点取末尾同步处，含完整 push/replace 分支）。
  const writeBackStart = source.indexOf('// 状态写回地址栏')
  const writeBackEnd = source.indexOf('lastSyncedLocation.current = locationState', source.indexOf('lastSyncedLocation.current = locationState', writeBackStart) + 1)
  const writeBack = source.slice(writeBackStart, writeBackEnd)
  assert.ok(writeBack.includes('nextHash === window.location.hash'), '写回前必须先比对当前地址栏')
  assert.ok(writeBack.includes('pushState') && writeBack.includes('replaceState'), '写回须区分 push/replace')
  // setParams push 标记与 openTarget history 选项经唯一写回 effect 消费，组件不直接操作 history
  assert.ok(writeBack.includes('pendingHistoryMode.current'), '显式历史标记须由唯一写回 effect 消费')
  const screenParamsImpl = source.slice(source.indexOf('const setScreenParams'), source.indexOf('const invokePluginAction'))
  assert.ok(!screenParamsImpl.includes('history.'), 'setScreenParams 不得直接操作浏览器历史')
  // logout 用 replaceState 复位地址栏，不污染历史栈
  const logoutBody = source.slice(source.indexOf('const logout'), source.indexOf('useEffect', source.indexOf('const logout')))
  assert.match(logoutBody, /replaceState\(null, '', '#\/profiles'\)/)
  // 诚实性纪律：snapshot 到达时不得静默重置 primaryTarget（仅保留 conversation.deleted 实时事件处理）
  assert.ok(!/applySnapshot[\s\S]{0,400}setPrimaryTarget/.test(source), 'snapshot 处理不得触碰 primaryTarget')
})

// ---------------------------------------------------------------------------
// Screen 路由参数（sp.* / ssp.* 命名空间）
// ---------------------------------------------------------------------------

test('screen params: sp.* 归主屏、ssp.* 归分屏，同一 screen 双开参数互不串扰', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/s/builtin:workflow/runs?sp.runId=wf_1&split=s/builtin:herdr/overview&ssp.node=local&ssp.status=blocked')
  assert.deepEqual(parsed.primaryTarget, {
    kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs', params: { runId: 'wf_1' },
  })
  assert.deepEqual(parsed.splitTarget, {
    kind: 'screen', pluginId: 'builtin:herdr', screenId: 'overview', params: { node: 'local', status: 'blocked' },
  })
  // 同一 screen 双开：两套命名空间各自编码，往返无损
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { tab: 'a', filter: 'x' } },
    splitTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { tab: 'b' } },
    workbenchOpen: false,
    workbenchTab: 'artifacts',
    activeModal: null,
  }
  assert.deepEqual(roundtrip(state), state)
})

test('screen params: 无参数时目标形状保持无 params 字段；切回会话自动丢弃命名空间参数', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/s/p/main').primaryTarget, { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // 主屏切回 c/<id>：sp.* 无处可挂，自然丢弃；ssp.* 仍属分屏保留
  const parsed = parseLocationHash('#/c/1?sp.k=v&split=s/p/main&ssp.k2=v2')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 1 })
  assert.deepEqual(parsed.splitTarget, { kind: 'screen', pluginId: 'p', screenId: 'main', params: { k2: 'v2' } })
  // 关闭分屏后 format 不再输出 ssp.*（状态里已无分屏目标）
  const closed: WorkspaceLocationState = { ...parsed, splitTarget: null }
  assert.equal(formatLocationHash(closed), '#/c/1')
})

test('screen params: 字典序稳定序列化，与其它查询参数共存', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = {
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { zeta: '1', alpha: '2', mid: '3' } },
    splitTarget: null,
    workbenchOpen: true,
    workbenchTab: 'tasks',
    activeModal: null,
  }
  assert.equal(formatLocationHash(state), '#/s/p/main?sp.alpha=2&sp.mid=3&sp.zeta=1&wb=tasks')
})

test('screen params: 非法键 / 空值 / 非法编码 / 未知前缀全部丢弃，不产生半损参数', { timeout: 60_000 }, () => {
  // 键不匹配 ^[A-Za-z0-9._-]+$（含空格、%、中文、括号）或空键：丢弃
  for (const raw of [
    '#/s/p/main?sp.=v',
    '#/s/p/main?sp.a%20b=v',
    '#/s/p/main?sp.a%28b%29=v',
    '#/s/p/main?sp.%E4%B8%AD=v',
    '#/s/p/main?sp.a=',
    '#/s/p/main?sp.%E0%A4%A=v',
  ]) {
    assert.deepEqual(parseLocationHash(raw).primaryTarget, { kind: 'screen', pluginId: 'p', screenId: 'main' }, raw)
  }
  // 原型键不挂上对象
  const proto = parseLocationHash('#/s/p/main?sp.__proto__=x&sp.constructor=y')
  assert.equal((proto.primaryTarget as { params?: Record<string, string> }).params, undefined)
  // 值里的特殊字符经 URLSearchParams 编码往返无损（空格、&、=、?、#）
  const weird = parseLocationHash(formatLocationHash({
    primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'main', params: { q: "a b&c=d?e#f", path: '/x/y' } },
    splitTarget: null, workbenchOpen: false, workbenchTab: 'artifacts', activeModal: null,
  }))
  const weirdParams = weird.primaryTarget.kind === 'screen' ? weird.primaryTarget.params : undefined
  assert.deepEqual(weirdParams, { q: "a b&c=d?e#f", path: '/x/y' })
  // 非 sp./ssp. 前缀的键不属于任何 screen，不误吞
  const noPrefix = parseLocationHash('#/s/p/main?runId=wf_1').primaryTarget
  assert.equal(noPrefix.kind === 'screen' ? noPrefix.params : undefined, undefined)
})

// isSameResolvedTarget / resolveTargetString / parseScreenTargetQuery 已在文件头部统一导入。

test('screen params: isSameResolvedTarget 浅比较 params，仅 params 变化不入历史栈', { timeout: 60_000 }, () => {
  const base = conversation(1)
  const screen = (params: Record<string, string> | undefined) => ({
    ...(params === undefined ? {} : { params }),
    kind: 'screen' as const,
    pluginId: 'p',
    screenId: 'main',
  })
  // 同目标不同 params 不等价；params 与无 params 也不等价
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen({ a: '2' })), false)
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen(undefined)), false)
  assert.equal(isSameResolvedTarget(screen({ a: '1' }), screen({ a: '1' })), true)
  assert.equal(isSameResolvedTarget(screen({ a: '1', b: '2' }), screen({ b: '2', a: '1' })), true)
  // 仅 params 变化：replace（不污染后退栈）
  const withParams = { ...base, primaryTarget: screen({ runId: 'wf_1' }) }
  const changedParams = { ...base, primaryTarget: screen({ runId: 'wf_2' }) }
  assert.equal(shouldPushLocationHistory(withParams, changedParams), false)
  // 跨 screen 坐标或会话切换仍 push；同坐标删除全部参数属参数变化仍 replace
  const otherScreen: typeof withParams = { ...base, primaryTarget: { kind: 'screen', pluginId: 'p', screenId: 'other' } }
  assert.equal(shouldPushLocationHistory(withParams, otherScreen), true)
  assert.equal(shouldPushLocationHistory(withParams, { ...base, primaryTarget: screen(undefined) }), false)
  assert.equal(shouldPushLocationHistory(withParams, conversation(2)), true)
  // isSameLocationState 整体感知 params 差异
  assert.equal(isSameLocationState(withParams, changedParams), false)
})

// ---------------------------------------------------------------------------
// resolveTargetString：screen:<pluginId>/<screenId>?k=v 严格解析
// ---------------------------------------------------------------------------

// resolveTargetString 直携参数解析（sidebar target / helm:open 真实入口）

test('resolveTargetString: screen 查询串解析进 params（helm:open / sidebar target 直携参数）', { timeout: 60_000 }, () => {
  assert.deepEqual(
    resolveTargetString('screen:builtin:workflow/runs?runId=wf_1&tab=all', []),
    { kind: 'screen', pluginId: 'builtin:workflow', screenId: 'runs', params: { runId: 'wf_1', tab: 'all' } },
  )
  // 无查询串：保持无 params 字段（与既有形状兼容）
  assert.deepEqual(resolveTargetString('screen:p/main', []), { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // 值可含编码后的特殊字符
  assert.deepEqual(
    resolveTargetString('screen:p/main?q=a%20b%26c', []),
    { kind: 'screen', pluginId: 'p', screenId: 'main', params: { q: 'a b&c' } },
  )
})

test('resolveTargetString: 非法查询串整体判无效（重复键 / 空键值 / 非法键 / 非法编码 / 无等号）', { timeout: 60_000 }, () => {
  for (const raw of [
    'screen:p/main?k=v&k=v2',       // 重复键
    'screen:p/main?=v',              // 空键
    'screen:p/main?k=',              // 空值
    'screen:p/main?k',               // 无等号
    'screen:p/main?a b=v',           // 键含空格
    'screen:p/main?__proto__=x',     // 原型键
    'screen:p/main?constructor=x',   // 原型键
    'screen:p/main?k=%E0%A4%A',      // 非法百分号编码
    'screen:p/main?&',               // 空片段
  ]) {
    assert.equal(resolveTargetString(raw, []), null, raw)
  }
  // 空查询串（尾部孤立 ?）视为无参数，目标仍合法
  assert.deepEqual(resolveTargetString('screen:p/main?', []), { kind: 'screen', pluginId: 'p', screenId: 'main' })
  // parseScreenTargetQuery 直接验证三态
  assert.equal(parseScreenTargetQuery(''), undefined)
  assert.equal(parseScreenTargetQuery('k=%E0%A4%A'), null)
  assert.deepEqual(parseScreenTargetQuery('b=2&a=1'), { a: '1', b: '2' })
})

// ---------------------------------------------------------------------------
// agent 待命目标（#/a/<profileId>，草稿环境 node/cwd 主/分屏往返）
// ---------------------------------------------------------------------------

test('parse: agent 待命目标路径与非法形式', { timeout: 60_000 }, () => {
  assert.deepEqual(parseLocationHash('#/a/assistant').primaryTarget, { kind: 'agent', profileId: 'assistant' })
  // profileId 含冒号保持可读；百分号编码形式同样可解析
  assert.deepEqual(parseLocationHash('#/a/builtin:herdr').primaryTarget, { kind: 'agent', profileId: 'builtin:herdr' })
  assert.deepEqual(parseLocationHash('#/a/builtin%3Aherdr').primaryTarget, { kind: 'agent', profileId: 'builtin:herdr' })
  // profileId 含斜杠必须编码；裸斜杠/空段/孤立 a 判非法回退默认
  assert.deepEqual(parseLocationHash('#/a/team%2Falpha').primaryTarget, { kind: 'agent', profileId: 'team/alpha' })
  for (const raw of ['#/a/', '#/a', '#/a/foo/bar', '#/a/%E0%A4%A']) {
    assert.deepEqual(parseLocationHash(raw).primaryTarget, { kind: 'profiles' }, raw)
  }
})

test('parse/format: agent 草稿环境 node/cwd 主屏与分屏各自往返', { timeout: 60_000 }, () => {
  // 主屏：node 与 cwd 为顶层查询参数；cwd 斜杠由 URLSearchParams 编码
  const primary = parseLocationHash('#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork')
  assert.deepEqual(primary.primaryTarget, { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/remote/work' })
  assert.equal(
    formatLocationHash({ ...conversation(1), primaryTarget: primary.primaryTarget }),
    '#/a/assistant?node=remote-1&cwd=%2Fremote%2Fwork',
  )
  assert.deepEqual(roundtrip({ ...conversation(1), primaryTarget: primary.primaryTarget }).primaryTarget, primary.primaryTarget)

  // 只带 node 或只带 cwd 同样合法
  assert.deepEqual(parseLocationHash('#/a/assistant?node=remote-1').primaryTarget, {
    kind: 'agent', profileId: 'assistant', nodeId: 'remote-1',
  })
  assert.deepEqual(parseLocationHash('#/a/assistant?cwd=%2Fw').primaryTarget, {
    kind: 'agent', profileId: 'assistant', cwd: '/w',
  })
  // 空串参数视为未设置
  assert.deepEqual(parseLocationHash('#/a/assistant?node=&cwd=').primaryTarget, { kind: 'agent', profileId: 'assistant' })

  // 分屏：agent 环境编码在 split 值内部，与主屏同名参数互不串扰
  const splitHash = formatLocationHash({
    ...conversation(1),
    primaryTarget: { kind: 'agent', profileId: 'assistant', nodeId: 'main-node', cwd: '/main' },
    splitTarget: { kind: 'agent', profileId: 'coder', nodeId: 'remote-1', cwd: '/remote/work' },
  })
  // split 值由 URLSearchParams 整体转义（内层 cwd 的 / 二次编码为 %252F）
  assert.equal(splitHash, '#/a/assistant?node=main-node&cwd=%2Fmain&split=a%2Fcoder%3Fnode%3Dremote-1%26cwd%3D%252Fremote%252Fwork')
  const parsedSplit = parseLocationHash(splitHash)
  assert.deepEqual(parsedSplit.primaryTarget, { kind: 'agent', profileId: 'assistant', nodeId: 'main-node', cwd: '/main' })
  assert.deepEqual(parsedSplit.splitTarget, { kind: 'agent', profileId: 'coder', nodeId: 'remote-1', cwd: '/remote/work' })
  // 整体往返无损
  assert.deepEqual(roundtrip(parseLocationHash(splitHash)), parseLocationHash(splitHash))

  // 手写深链：split 内嵌查询串也能解析
  const handWritten = parseLocationHash(`#/c/1?split=${encodeURIComponent('a/coder?cwd=/srv')}`)
  assert.deepEqual(handWritten.splitTarget, { kind: 'agent', profileId: 'coder', cwd: '/srv' })
})

test('历史策略: agent 坐标级变化 push，仅草稿环境变化 replace', { timeout: 60_000 }, () => {
  const base: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'agent', profileId: 'assistant' } }
  const envChanged: WorkspaceLocationState = {
    ...base,
    primaryTarget: { kind: 'agent', profileId: 'assistant', nodeId: 'remote-1', cwd: '/r' },
  }
  // 同 profileId 仅环境变化：位置不同但 replace（不污染后退栈）
  assert.equal(isSameLocationState(base, envChanged), false)
  assert.equal(shouldPushLocationHistory(base, envChanged), false)
  assert.equal(shouldPushLocationHistory(envChanged, base), false)
  // 会话 <-> 待命 / 不同智能体待命：坐标级变化 push
  assert.equal(shouldPushLocationHistory(conversation(1), base), true)
  assert.equal(shouldPushLocationHistory(base, conversation(1)), true)
  const otherAgent: WorkspaceLocationState = { ...base, primaryTarget: { kind: 'agent', profileId: 'coder' } }
  assert.equal(shouldPushLocationHistory(base, otherAgent), true)
  // agent 与角色中心（profiles）互为坐标级变化
  const profilesState: WorkspaceLocationState = { ...conversation(1), primaryTarget: { kind: 'profiles' } }
  assert.equal(shouldPushLocationHistory(base, profilesState), true)
  // serializeHash 直接接收 agent 目标
  assert.equal(serializeHash({ kind: 'agent', profileId: 'assistant', nodeId: 'r', cwd: '/w' }), '#/a/assistant?node=r&cwd=%2Fw')
})

test('parse: 空缺 conversation:profile 仍返回 null（不静默降级到待命页）', { timeout: 60_000 }, () => {
  // conversation:profile:<id> 保持常驻会话查找语义（插件 singleton 不受 agent 目标影响）
  assert.equal(resolveTargetString('conversation:profile:none', []), null)
  // agent:<id> 声明式目标进入待命态；空 id 判无效
  assert.deepEqual(resolveTargetString('agent:assistant', []), { kind: 'agent', profileId: 'assistant' })
  assert.equal(resolveTargetString('agent:', []), null)
  assert.equal(resolveTargetString('agent', []), null)
})

test('isSameResolvedTarget: agent 目标按 profileId/nodeId/cwd 比较', { timeout: 60_000 }, () => {
  const a = { kind: 'agent', profileId: 'p' } as const
  assert.equal(isSameResolvedTarget(a, { kind: 'agent', profileId: 'p' }), true)
  assert.equal(isSameResolvedTarget(a, { kind: 'agent', profileId: 'q' }), false)
  assert.equal(isSameResolvedTarget({ kind: 'agent', profileId: 'p', nodeId: 'r' }, { kind: 'agent', profileId: 'p' }), false)
  assert.equal(
    isSameResolvedTarget({ kind: 'agent', profileId: 'p', nodeId: 'r', cwd: '/w' }, { kind: 'agent', profileId: 'p', nodeId: 'r', cwd: '/w' }),
    true,
  )
  assert.equal(isSameResolvedTarget(a, { kind: 'profiles', profileId: 'p' }), false)
})
