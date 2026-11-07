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
