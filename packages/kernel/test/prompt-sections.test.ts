import assert from 'node:assert/strict'
import test from 'node:test'
import { systemSectionsOf, withSections } from '../src/runtime/runtime-helpers.js'

test('eventually sections replace clear after continue system patch, deactivate after action refer quote do not via back put re-', { timeout: 60_000 }, () => {
  const history = { role: 'user', content: 'continue' }
  const messages = [
    { role: 'system', content: 'host', sections: { 'profile.system': 'SYS', 'prompt.actions': 'old directory' } },
    history,
    {
      role: 'system',
      content: 'plugin message',
      sections: { 'prompt.actions': 'more late old directory', 'plugin.context': 'keep context' },
      toolsRemoved: ['old_tool'],
    },
  ]
  const desired = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'plugin.context', text: 'keep context' },
  ]
  const original = JSON.stringify(messages)
  const cleared = withSections(messages, desired)
  assert.deepEqual(systemSectionsOf(cleared), desired)
  assert.equal(cleared[1], history, 'user history keep original reference')
  assert.equal(cleared[2]!['content'], 'plugin message')
  assert.deepEqual(cleared[2]!['toolsRemoved'], ['old_tool'], 'other system field keep')
  assert.equal(JSON.stringify(messages), original, 'do not change write original message')

  const updated = [...desired, { id: 'prompt.actions', text: 'new directory' }]
  assert.deepEqual(systemSectionsOf(withSections(messages, updated)), updated, 'new directory do not by after continue old patch override')
})
