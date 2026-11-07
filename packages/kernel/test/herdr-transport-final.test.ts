import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createHerdrTransport, isValidMachineName } from '../src/builtin-plugins/herdr/transport.js'

async function tempRoot(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'helm-transport-final-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

// SSH 仅替换网络入口；完整生产 stdin 源码交给真实 Python，业务操作未被替换。
async function pythonChannel(t: TestContext, root: string) {
  const bin = join(root, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nexec /usr/bin/python3 -u -\n', { mode: 0o700 })
  const previousPath = process.env.PATH
  process.env.PATH = `${bin}:${previousPath ?? ''}`
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
  })
}

async function socketServer(t: TestContext, root: string, respond: (request: Record<string, unknown>, socket: Socket) => void) {
  const sockets = new Set<Socket>()
  const socketPath = join(root, 'herdr.sock')
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      const newline = input.indexOf('\n')
      if (newline >= 0) respond(JSON.parse(input.slice(0, newline)), socket)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(async () => {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  })
  return socketPath
}

test('本机 transport Gate 在传入的 cwd 实际执行', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  const result = await createHerdrTransport().runGate({}, 'pwd', root)
  assert.deepEqual(result, { ok: true, output: `${root}\n` })
})

test('无限期 agent.wait 在对端保持半开且不响应时也能被 abort 立即终止', { timeout: 60_000 }, async (t) => {
  const root = await tempRoot(t)
  let received!: () => void
  const ready = new Promise<void>((resolve) => { received = resolve })
  const socketPath = await socketServer(t, root, () => { received() })
  const controller = new AbortController()
  const pending = createHerdrTransport().call({ socketPath }, 'agent.wait', { target: 'p1' }, { signal: controller.signal })
  const observed = pending.then(() => undefined, (error: unknown) => error)
  await ready
  controller.abort()
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), 500) })
  const error = await Promise.race([observed, deadline])
  clearTimeout(timer)
  assert.ok(error, 'abort 必须主动结算，不能等待对端关闭读取方向')
  assert.equal((error as { code?: string }).code, 'herdr_aborted')
})

test('SSH machine 保留常见别名并校验真实 IPv6 形态', { timeout: 60_000 }, () => {
  for (const machine of ['work_host', 'user@work_host', '::1', '[2001:db8::1]', 'user@[2001:db8::1]']) {
    assert.equal(isValidMachineName(machine), true, `合法目标：${machine}`)
  }
  for (const machine of ['::::', 'user@::::', '-oProxyCommand=bad', 'user@host;bad']) {
    assert.equal(isValidMachineName(machine), false, `非法目标：${machine}`)
  }
})

for (const remote of [false, true]) {
  test(`${remote ? 'SSH' : '本机'}缺少 .helm 目录时读取为缺文件，删除保持幂等`, { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    if (remote) await pythonChannel(t, root)
    const transport = createHerdrTransport()
    const target = remote ? { machine: 'fixture-host' } : {}
    await assert.rejects(transport.readOutput(target, root, 'wf-out-missing.md'), { code: 'herdr_output_missing' })
    await transport.removeOutput(target, root, 'wf-out-missing.md')
  })

  test(`${remote ? 'SSH' : '本机'}RPC 拒绝没有关联 id 的响应`, { timeout: 60_000 }, async (t) => {
    const root = await tempRoot(t)
    if (remote) await pythonChannel(t, root)
    const socketPath = await socketServer(t, root, (_request, socket) => {
      socket.end(`${JSON.stringify({ result: { type: 'ok' } })}\n`)
    })
    const target = remote ? { machine: 'fixture-host', socketPath } : { socketPath }
    await assert.rejects(createHerdrTransport().call(target, 'tab.close', { tab_id: 't1' }, { timeoutMs: 3_000 }), { code: 'herdr_protocol' })
  })
}
