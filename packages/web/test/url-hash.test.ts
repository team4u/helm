import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ROOT_CONVERSATION_ID } from '@helm/protocol'
import {
  formatLocationHash,
  isSameLocationState,
  parseLocationHash,
  shouldPushLocationHistory,
  type WorkspaceLocationState,
} from '../src/lib/url-hash-model.js'

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

test('parse: 会话主屏（#/c/<id>）与空 Hash 默认根会话', { timeout: 60_000 }, () => {
  const parsed = parseLocationHash('#/c/42')
  assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: 42 })
  assert.equal(parsed.splitTarget, null)
  assert.equal(parsed.workbenchOpen, false)
  assert.equal(parsed.workbenchTab, 'artifacts')
  assert.equal(parsed.activeModal, null)
  // "" / "#" / "#/" 均解析为默认 conversation:1
  for (const raw of ['', '#', '#/']) {
    const empty = parseLocationHash(raw)
    assert.deepEqual(empty.primaryTarget, { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID })
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

test('format: 默认态输出规范 #/c/1', { timeout: 60_000 }, () => {
  assert.equal(formatLocationHash(conversation(ROOT_CONVERSATION_ID)), '#/c/1')
})

test('format: command-palette 是瞬态弹窗，不序列化进 URL', { timeout: 60_000 }, () => {
  const state: WorkspaceLocationState = { ...conversation(ROOT_CONVERSATION_ID), activeModal: { kind: 'command-palette' } }
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

test('parse: 非法主屏路径回退默认根会话（无 NaN / 空段）', { timeout: 60_000 }, () => {
  for (const raw of ['#/c/abc', '#/c/0', '#/c/-5', '#/c/1.5', '#/c/ 1', '#/unknown', '#/s/onlyone', '#/s//x', '#/s/x/', '#/c/9999999999999999999999']) {
    const parsed = parseLocationHash(raw)
    assert.deepEqual(parsed.primaryTarget, { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID }, raw)
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
  assert.deepEqual(parseLocationHash('#/s/%E0%A4%A/x').primaryTarget, { kind: 'conversation', conversationId: ROOT_CONVERSATION_ID })
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

test('契约: 四个列表型 Modal 均消费共享决策模块且写回经守卫（仿真与实现同构）', { timeout: 60_000 }, async () => {
  for (const [file, kind] of [
    ['ProfileEditorModal.tsx', 'profile-editor'],
    ['SkillViewerModal.tsx', 'skill-viewer'],
    ['PluginSettingsModal.tsx', 'plugin-settings'],
    ['NodesModal.tsx', 'nodes'],
  ] as const) {
    const source = await readSource(`../src/modals/${file}`)
    assert.match(source, /from '\.\/list-modal-selection\.js'/, `${file} 须导入共享决策模块`)
    assert.match(
      source,
      new RegExp(`shouldSyncSelectionToStore\\([\\s\\S]{0,60}'${kind.replace(':', ':')}'`),
      `${file} 守卫写回须使用自己的 kind`,
    )
    // 反模式禁止：不得再用 kind !== 自己 的 selected effect 强灌 store
    assert.ok(
      !new RegExp(`activeModal\\?\\.kind !== '${kind}'`).test(source),
      `${file} 不得存在 kind !== 自己 且强制 setActiveModal 的 effect（回环源头）`,
    )
    // 深链跟随不写回：导入 deepLinkSelection 且其 effect 段内无 setActiveModal
    if (source.includes('deepLinkSelection')) {
      const effectStart = source.indexOf('外部深链')
      const effectEnd = source.indexOf('}, [initial', effectStart)
      const effect = source.slice(effectStart, effectEnd)
      assert.ok(!effect.includes('setActiveModal'), `${file} 深链跟随帧不得写回 store（防回环）`)
    }
  }
})

test('契约: ProfileEditor 两个重复 fallback effect 已合并且 guard 仍在写回之前', { timeout: 60_000 }, async () => {
  const source = await readSource('../src/modals/ProfileEditorModal.tsx')
  assert.equal((source.match(/fallbackSelection\(/g) ?? []).length, 1, 'fallbackSelection 调用点应唯一（两个重复 effect 已合并）')
  const selectFn = source.slice(source.indexOf('const selectProfile'), source.indexOf('const reloadFromDisk'))
  assert.ok(selectFn.indexOf('guardUnsaved') < selectFn.indexOf('setActiveModal'), 'dirty guard 必须先于写回 store')
})

test('契约: SkillViewer 清单确实清空时作废加载世代，从未到达时保留深链', { timeout: 60_000 }, async () => {
  const source = await readSource('../src/modals/SkillViewerModal.tsx')
  assert.match(source, /hadSkillsRef/)
  const fallbackEffect = source.slice(source.indexOf('// 列表兑底'), source.indexOf('}, [selectedId, skills])'))
  assert.match(fallbackEffect, /loadGeneration\.current \+= 1/, '失效路径必须作废在途读取世代')
})

test('契约: PluginSettings/Nodes 空列表不覆盖深链 initial*Id', { timeout: 60_000 }, async () => {
  const pluginSource = await readSource('../src/modals/PluginSettingsModal.tsx')
  assert.match(pluginSource, /plugins\.length === 0\) return/)
  const nodesSource = await readSource('../src/modals/NodesModal.tsx')
  const fallbackEffect = nodesSource.slice(nodesSource.indexOf('// 列表为空'), nodesSource.indexOf('}, [selected, issuingMode, nodes, pendingNodeId, store])'))
  assert.match(fallbackEffect, /nodes\.length > 0/)
})
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
  // logout 用 replaceState 复位地址栏，不污染历史栈
  const logoutBody = source.slice(source.indexOf('const logout'), source.indexOf('useEffect', source.indexOf('const logout')))
  assert.match(logoutBody, /replaceState\(null, '', '#\/c\/1'\)/)
  // 诚实性纪律：snapshot 到达时不得静默重置 primaryTarget（仅保留 conversation.deleted 实时事件处理）
  assert.ok(!/applySnapshot[\s\S]{0,400}setPrimaryTarget/.test(source), 'snapshot 处理不得触碰 primaryTarget')
})
