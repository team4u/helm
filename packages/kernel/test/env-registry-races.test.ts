import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { WebSocket } from 'ws'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import { createEnvFabric } from '../src/env/fabric.js'
import { NodeRegistry, type HubConnectionLocal } from '../src/env/registry.js'

// 仅隔离注册表状态机；实际 WS/birpc 链路由 env-fabric 与 env-app 两组覆盖。
class RegistrySocket extends EventEmitter {
  OPEN = 1
  CLOSED = 3
  readyState = 1
  close() { this.readyState = 3; this.emit('close') }
}

test('本机 Scoped env 不会再次继承宿主或逐调用伪造的 HELM_TOKEN', { timeout: 60_000 }, async () => {
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

test('无 composer 的本机 Scoped env 剥除宿主全部受管 HELM_* 变量（fail-closed）', { timeout: 60_000 }, async () => {
  const saved: Record<string, string | undefined> = {}
  const injected: Array<[string, string]> = [
    ['HELM_TOKEN', 'host-token'],
    ['helm_token', 'host-token-variant'],
    ['HELM_CONVERSATION_ID', '999'],
    ['HELM_CWD', '/wrong'],
    ['HELM_ENV', '1'],
    ['HELM_DATA_DIR', '/host/data'],
    ['HELM_HUB_URL', 'http://wrong:1'],
    ['HELM_NODE_ID', 'wrong-node'],
  ]
  for (const [key, value] of injected) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
  const fabric = createEnvFabric({})
  try {
    // 无 envOptions（无会话作用域）：宿主继承不得携带任何受管 HELM_* 值。
    const env = fabric.envForTarget({ nodeId: 'local', cwd: process.cwd() })
    let text = ''
    const result = await env.exec(
      [process.execPath, '-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).filter((k) => /^helm_/i.test(k))))'],
      { onOutput: (chunk) => { text += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result.ok, true)
    assert.deepEqual(JSON.parse(text), [], '宿主受管 HELM_* 变量（含大小写变体）必须全部剥除')
  } finally {
    for (const [key] of injected) {
      const prev = saved[key]
      if (prev === undefined) delete process.env[key]
      else process.env[key] = prev
    }
    await fabric.dispose()
  }
})

test('composer 提供的受管变量仍生效（绑定键不被宿主剥除误伤）', { timeout: 60_000 }, async () => {
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

test('新连接顶替旧连接后事件路由绑定新发布代', { timeout: 60_000 }, async () => {
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

test('已取消的离线等待与已关闭注册表不会挂住调用方', { timeout: 60_000 }, async () => {
  const registry = new NodeRegistry({ authenticate: () => false })
  const cancel = new AbortController()
  cancel.abort()
  assert.equal(await registry.waitForNodeOnline('offline', withAbortSignal(cancel.signal, BACKGROUND_CONTEXT)), undefined)
  await registry.close()
  assert.equal(await registry.waitForNodeOnline('offline', BACKGROUND_CONTEXT), undefined)
})
