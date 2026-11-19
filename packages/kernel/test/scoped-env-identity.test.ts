import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'

test('per-invocation managed identity env vars cannot be overridden by caller case variants', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({ envOptions: () => ({ HELMX_TOKEN: 'managed', HELMX_CONVERSATION_ID: '7' }) })
  try {
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd(), conversationId: 7 })
    let text = ''
    const result = await env.exec([process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => /^helmx_(token|conversation_id|hub_url)$/i.test(k)))))'], {
      env: { helmx_token: 'spoof', Helmx_Conversation_Id: '900', helmx_hub_url: 'http://spoof' },
      onOutput: (chunk) => { text += chunk },
    }, BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(text), { HELMX_TOKEN: 'managed', HELMX_CONVERSATION_ID: '7' })
  } finally {
    await fabric.dispose()
  }
})
