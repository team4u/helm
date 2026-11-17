import assert from 'node:assert/strict'
import test from 'node:test'
import { systemSectionsOf, withSections } from '../src/runtime/runtime-helpers.js'

test('final sections replacement clears trailing system patches so deactivated action references cannot leak back via fallback', { timeout: 60_000 }, () => {
  const history = { role: 'user', content: 'continue' }
  const messages = [
    { role: 'system', content: 'host', sections: { 'profile.system': 'SYS', 'prompt.actions': 'stale catalog' } },
    history,
    {
      role: 'system',
      content: 'plugin message',
      sections: { 'prompt.actions': 'later stale catalog', 'plugin.context': 'keep context' },
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
  assert.equal(cleared[1], history, 'user history preserves object reference')
  assert.equal(cleared[2]!['content'], 'plugin message')
  assert.deepEqual(cleared[2]!['toolsRemoved'], ['old_tool'], 'other system fields remain preserved')
  assert.equal(JSON.stringify(messages), original, 'does not mutate original messages')

  const updated = [...desired, { id: 'prompt.actions', text: 'fresh catalog' }]
  assert.deepEqual(systemSectionsOf(withSections(messages, updated)), updated, 'new catalog is not overwritten by trailing stale patches')
})
