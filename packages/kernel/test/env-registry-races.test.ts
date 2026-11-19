import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'
import { NodeRegistry, type HubConnectionLocal } from '../src/env/registry.js'

// Isolated registry state machine tests; actual WS/birpc wiring covered by env-fabric and env-app suites.
class RegistrySocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

test('local ScopedEnv never inherits host or per-call forged HELMX_TOKEN', { timeout: 60_000 }, async () => {
  const previous = process.env.HELMX_TOKEN
  process.env.HELMX_TOKEN = 'host-private-credential'
  const fabric = createEnvFabric({ envOptions: () => ({ HELMX_CONVERSATION_ID: '8' }) })
  try {
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd(), conversationId: 8 })
    let text = ''
    const result = await env.exec([process.execPath, '-e', 'process.stdout.write(process.env.HELMX_TOKEN ?? "absent")'], {
      env: { HELMX_TOKEN: 'spoofed-credential' }, onOutput: (chunk) => { text += chunk },
    }, BACKGROUND_CONTEXT)
    assert.equal(result.ok, true)
    assert.equal(text, 'absent')
  } finally {
    if (previous === undefined) delete process.env.HELMX_TOKEN
    else process.env.HELMX_TOKEN = previous
    await fabric.dispose()
  }
})

test('local ScopedEnv without composer strips all host-managed HELMX_* variables (fail-closed)', { timeout: 60_000 }, async () => {
  const saved: Record<string, string | undefined> = {}
  // Save and clear all pre-existing host HELMX_* vars first: when running under a Helmx-hosted bash session,
  // external host wrappers inject node control vars like HELMX_NODE_INSTANCE_ID / HELMX_NODE_CONTROL_ENDPOINT.
  // composeExecutionEnv intentionally strips only its 8 self-managed keys while letting daemon control vars
  // pass through, which would otherwise cause /^helmx_/i assertions below to misreport leftovers.
  for (const key of Object.keys(process.env)) {
    if (/^helmx_/i.test(key)) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  }
  const injected: Array<[string, string]> = [
    ['HELMX_TOKEN', 'host-token'],
    ['helmx_token', 'host-token-variant'],
    ['HELMX_CONVERSATION_ID', '999'],
    ['HELMX_CWD', '/wrong'],
    ['HELMX_ENV', '1'],
    ['HELMX_DATA_DIR', '/host/data'],
    ['HELMX_HUB_URL', 'http://wrong:1'],
    ['HELMX_NODE_ID', 'wrong-node'],
    ['HELMX_EXECUTION_SCOPE', 'helmx-stale-host-scope'],
  ]
  for (const [key, value] of injected) {
    if (!(key in saved)) saved[key] = process.env[key]
    process.env[key] = value
  }
  const fabric = createEnvFabric({})
  try {
    // Without envOptions (no conversation scope): inherited host env must carry zero managed HELMX_* keys.
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd() })
    let text = ''
    const result = await env.exec(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^helmx_/i.test(k))))'],
      { onOutput: (chunk) => { text += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(text), [], 'all host-managed HELMX_* variables (including case variants) must be stripped')
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await fabric.dispose()
  }
})

test('composer-supplied managed variables still take effect (bound keys unaffected by host stripping)', { timeout: 60_000 }, async () => {
  const fabric = createEnvFabric({
    envOptions: ({ conversationId, cwd }) => ({
      HELMX_CONVERSATION_ID: String(conversationId ?? 0),
      HELMX_CWD: cwd,
      HELMX_ENV: '1',
    }),
  })
  try {
    const env = fabric.envForTarget({ conversationId: 5, nodeId: 'local', cwd: process.cwd() })
    let text = ''
    const result = await env.exec(
      [process.execPath, '-e', 'process.stdout.write(process.env.HELMX_CONVERSATION_ID + "|" + process.env.HELMX_ENV)'],
      { onOutput: (chunk) => { text += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.ok, true)
    assert.equal(text, '5|1')
  } finally {
    await fabric.dispose()
  }
})

test('newer connection supersedes old connection without routing stale callbacks through old binding', { timeout: 60_000 }, async () => {
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

test('aborted offline wait and closed registry never hang callers', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => false })
  const cancel = new AbortController()
  cancel.abort()
  assert.equal(await registry.waitForNodeOnline('offline', withAbortSignal(cancel.signal, BACKGROUND_CONTEXT)), undefined)
  await registry.close()
  assert.equal(await registry.waitForNodeOnline('offline', BACKGROUND_CONTEXT), undefined)
})
