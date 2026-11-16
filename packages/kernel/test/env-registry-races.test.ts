import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'
import { NodeRegistry, type HubConnectionLocal } from '../src/env/registry.js'

// only isolated register table state machine; actual WS/birpc link by env-fabric and env-app two group override.
class RegistrySocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

test('local machine Scoped env will not again inherit host or one by one invoke fabricate HELM_TOKEN', { timeout: 60_000 }, async () => {
  const previous = process.env.HELM_TOKEN
  process.env.HELM_TOKEN = 'host-private-credential'
  const fabric = createEnvFabric({ envOptions: () => ({ HELM_CONVERSATION_ID: '8' }) })
  try {
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd(), conversationId: 8 })
    let text = ''
    const result = await env.exec([process.execPath, '-e', 'process.stdout.write(process.env.HELM_TOKEN ?? "absent")'], {
      env: { HELM_TOKEN: 'spoofed-credential' }, onOutput: (chunk) => { text += chunk },
    }, BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.equal(text, 'absent')
  } finally {
    if (previous === undefined) delete process.env.HELM_TOKEN
    else process.env.HELM_TOKEN = previous
    await fabric.dispose()
  }
})

test('without composer local machine Scoped env strip except host all managed HELM_* variable (fail-closed)', { timeout: 60_000 }, async () => {
  const saved: Record<string, string | undefined> = {}
  // first staged and empty host since has all HELM_* variable: this test in Helm hosting host environment run
  // when, host bash etc. managed tool day however inject HELM_NODE_INSTANCE_ID /
  // HELM_NODE_CONTROL_ENDPOINT etc. node control variable - - kernel composeExecutionEnv only
  // strip except itself managed eight meta group, node control variable belong node guard semantics, legal pass-through, will let under way
  // /^helm_/i probe needle host leftover mistakenly judge is kernel strip except failed. test semantics only for under way inject.
  for (const key of Object.keys(process.env)) {
    if (/^helm_/i.test(key)) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  }
  const injected: Array<[string, string]> = [
    ['HELM_TOKEN', 'host-token'],
    ['helm_token', 'host-token-variant'],
    ['HELM_CONVERSATION_ID', '999'],
    ['HELM_CWD', '/wrong'],
    ['HELM_ENV', '1'],
    ['HELM_DATA_DIR', '/host/data'],
    ['HELM_HUB_URL', 'http://wrong:1'],
    ['HELM_NODE_ID', 'wrong-node'],
    ['HELM_EXECUTION_SCOPE', 'helm-stale-host-scope'],
  ]
  for (const [key, value] of injected) {
    if (!(key in saved)) saved[key] = process.env[key]
    process.env[key] = value
  }
  const fabric = createEnvFabric({})
  try {
    // without envOptions(without conversation effect domain): host inherit must not carry any managed HELM_* value.
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd() })
    let text = ''
    const result = await env.exec(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^helm_/i.test(k))))'],
      { onOutput: (chunk) => { text += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(text), [], 'host managed HELM_* variable (contains large small write change body) must all strip except')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fabric.dispose()
  }
})

test('composer provide managed variable still takes effect (bind set key do not by host strip except mistakenly damage)', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({
    envOptions: ({ conversationId, cwd }) => ({
      HELM_CONVERSATION_ID: String(conversationId ?? 0),
      HELM_CWD: cwd,
      HELM_ENV: '1',
    }),
  })
  try {
    const env = fabric.envForTarget({ conversationId: 5, nodeId: 'local', cwd: process.cwd() })
    let text = ''
    const result = await env.exec(
      [process.execPath, '-e', 'process.stdout.write(process.env.HELM_CONVERSATION_ID + "|" + process.env.HELM_ENV)'],
      { onOutput: (chunk) => { text += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.ok, true)
    assert.equal(text, '5|1')
  } finally {
    await fabric.dispose()
  }
})

test('new connect top replace old after connect event routing bind set new publish proxy', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => true })
  const sockets = [new RegistrySocket(), new RegistrySocket()]
  const bindings: HubConnectionLocal[] = []
  const outputs: string[] = []
  registry.addOutputSink('box', (event) => outputs.push(event.text))
  try {
    for (const socket of sockets) {
      const result = await registry.register(socket as unknown as WebSocket, { nodeId: 'box', token: 'box:test', hostname: 'test', platform: 'linux' }, (bound) => {
        bindings.push(bound)
        return { $close() {} } as never
      })
      assert.equal(result.accepted, true)
    }
    bindings[0]!.onEnvExecOutput({ execId: 'same', stream: 'stdout', text: 'old' })
    bindings[1]!.onEnvExecOutput({ execId: 'same', stream: 'stdout', text: 'new' })
    assert.deepEqual(outputs, ['new'])
    assert.equal(sockets[0]!.readyState, 3)
  } finally { await registry.close() }
})

test('cancelled offline wait for and already close register table will not hang caller', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => false })
  const cancel = new AbortController()
  cancel.abort()
  assert.equal(await registry.waitForNodeOnline('offline', withAbortSignal(cancel.signal, BACKGROUND_CONTEXT)), undefined)
  await registry.close()
  assert.equal(await registry.waitForNodeOnline('offline', BACKGROUND_CONTEXT), undefined)
})
