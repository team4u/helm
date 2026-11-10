import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSkillAvailable, type SkillSummary } from '@helm/protocol'

const ordinary: SkillSummary = { id: 'review', name: '审查', references: [] }
const managed: SkillSummary = { ...ordinary, managedByPlugin: 'community:review' }

test('技能策略：缺省全部、空数组禁用、显式列表仅匹配 ID', { timeout: 60_000 }, () => {
  const enabled = new Set<string>()
  assert.equal(isSkillAvailable(ordinary, {}, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: [] }, enabled), false)
  assert.equal(isSkillAvailable(ordinary, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: ['other'] }, enabled), false)
})

test('技能策略：停用或未注册插件的托管技能即使在白名单内也不可用', { timeout: 60_000 }, () => {
  assert.equal(isSkillAvailable(managed, {}, new Set()), false)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, new Set()), false)
  const enabled = new Set(['community:review'])
  assert.equal(isSkillAvailable(managed, {}, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: [] }, enabled), false)
})
