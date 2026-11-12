import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatLocationHash, parseLocationHash, type WorkspaceLocationState } from '../src/lib/url-hash-model.js'

const base: WorkspaceLocationState = {
  primaryTarget: { kind: 'conversation', conversationId: 1 },
  splitTarget: null,
  workbenchOpen: false,
  workbenchTab: 'artifacts',
  activeModal: null,
}

test('Hash 边界：modal 类型不接受原型链属性', { timeout: 60_000 }, () => {
  for (const modal of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    assert.equal(parseLocationHash(`#/c/1?modal=${modal}`).activeModal, null)
  }
})

test('Hash 边界：所有路径段、查询值都按各自层级编解码', { timeout: 60_000 }, () => {
  const identifiers = ['builtin:herdr', 'hello world', '中文', 'a/b', 'a%2Fb', 'a+b&c=d?#e', '%E0%A4%A']
  for (const id of identifiers) {
    const target = { kind: 'screen' as const, pluginId: id, screenId: id }
    const state: WorkspaceLocationState = {
      ...base,
      primaryTarget: target,
      splitTarget: target,
      workbenchOpen: true,
      workbenchTab: id,
      activeModal: { kind: 'skill-viewer', skillId: id },
    }
    assert.deepEqual(parseLocationHash(formatLocationHash(state)), state, id)
  }
})

test('Hash 边界：设置中心子项段的编码斜杠不破坏层级', { timeout: 60_000 }, () => {
  // 子项值内的斜杠必须编码：%2F 属于子项值，不拆层级
  assert.deepEqual(parseLocationHash('#/settings/profiles/team%2Falpha').primaryTarget, {
    kind: 'profiles',
    profileId: 'team/alpha',
  })
  assert.deepEqual(parseLocationHash('#/views/a%2Fb/c').primaryTarget, {
    kind: 'screen',
    pluginId: 'a/b',
    screenId: 'c',
  })
  // 裸斜杠会拆出多余层级段 → 判非法回退默认
  assert.deepEqual(parseLocationHash('#/settings/profiles/team/alpha').primaryTarget, { kind: 'profiles' })
  assert.deepEqual(parseLocationHash('#/settings/skills/a/b').primaryTarget, { kind: 'profiles' })
  // 尾随斜杠归一化为中心列表页（与主路径归一化一致）；split 内不归一化，判无效
  assert.deepEqual(parseLocationHash('#/settings/profiles/').primaryTarget, { kind: 'profiles' })
  assert.equal(parseLocationHash('#/c/1?split=settings%2Fprofiles%2F').splitTarget, null)
})

test('Hash 边界：未编码的多余路径段不能冒充合法目标', { timeout: 60_000 }, () => {
  // 非法目标整体判无效 -> 回退默认角色中心（与 base 的显式会话目标无关）
  assert.deepEqual(parseLocationHash('#/views/a/b/c').primaryTarget, { kind: 'profiles' })
  assert.equal(parseLocationHash('#/c/1?split=views/a/b/c').splitTarget, null)
})
