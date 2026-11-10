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

test('Hash 边界：未编码的多余路径段不能冒充合法插件目标', { timeout: 60_000 }, () => {
  // 非法 screen 目标整体判无效 -> 回退默认角色中心（与 base 的显式会话目标无关）
  assert.deepEqual(parseLocationHash('#/s/a/b/c').primaryTarget, { kind: 'profiles' })
  assert.equal(parseLocationHash('#/c/1?split=s/a/b/c').splitTarget, null)
})
