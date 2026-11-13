import assert from 'node:assert/strict'
import test from 'node:test'
import { systemSectionsOf, withSections } from '../src/runtime/runtime-helpers.js'

test('最终 sections 替换清除后续 system patch，停用后的动作指引不经回放复活', { timeout: 60_000 }, () => {
  const history = { role: 'user', content: '继续' }
  const messages = [
    { role: 'system', content: '宿主', sections: { 'profile.system': 'SYS', 'prompt.actions': '旧目录' } },
    history,
    {
      role: 'system',
      content: '插件消息',
      sections: { 'prompt.actions': '更晚的旧目录', 'plugin.context': '保留的上下文' },
      toolsRemoved: ['old_tool'],
    },
  ]
  const desired = [
    { id: 'profile.system', text: 'SYS' },
    { id: 'plugin.context', text: '保留的上下文' },
  ]
  const original = JSON.stringify(messages)
  const cleared = withSections(messages, desired)
  assert.deepEqual(systemSectionsOf(cleared), desired)
  assert.equal(cleared[1], history, '用户历史保持原引用')
  assert.equal(cleared[2]!['content'], '插件消息')
  assert.deepEqual(cleared[2]!['toolsRemoved'], ['old_tool'], '其他 system 字段保留')
  assert.equal(JSON.stringify(messages), original, '不改写原消息')

  const updated = [...desired, { id: 'prompt.actions', text: '新目录' }]
  assert.deepEqual(systemSectionsOf(withSections(messages, updated)), updated, '新目录不被后续旧 patch 覆盖')
})
