import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'

test('逐调用环境中的受管身份大小写变体不能覆盖 composer', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ envOptions: () => ({ HELM_TOKEN: 'managed', HELM_CONVERSATION_ID: '7' }) })
  try {
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd(), conversationId: 7 })
    let text = ''
    const result = await env.exec([process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^helm_(token|conversation_id|hub_url)$/i.test(k)))))'], {
      env: { helm_token: 'spoof', Helm_Conversation_Id: '900', helm_hub_url: 'http://spoof' },
      onOutput: (chunk) => { text += chunk },
    }, BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(text), { HELM_TOKEN: 'managed', HELM_CONVERSATION_ID: '7' })
  } finally {
    await fabric.dispose()
  }
})
