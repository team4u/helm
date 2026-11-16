import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isSkillAvailable, type SkillSummary } from '@helm/protocol'

const ordinary: SkillSummary = { id: 'review', name: 'Review', references: [] }
const managed: SkillSummary = { ...ordinary, managedByPlugin: 'community:review' }

test('skill policy: default allows all, empty array disables all, explicit lists match by ID only', { timeout: 60_000 }, () => {
  const enabled = new Set<string>()
  assert.equal(isSkillAvailable(ordinary, {}, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: [] }, enabled), false)
  assert.equal(isSkillAvailable(ordinary, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(ordinary, { skills: ['other'] }, enabled), false)
})

test('skill policy: managed skills of disabled or unregistered plugins are unavailable even when allowlisted', { timeout: 60_000 }, () => {
  assert.equal(isSkillAvailable(managed, {}, new Set()), false)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, new Set()), false)
  const enabled = new Set(['community:review'])
  assert.equal(isSkillAvailable(managed, {}, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: ['review'] }, enabled), true)
  assert.equal(isSkillAvailable(managed, { skills: [] }, enabled), false)
})
