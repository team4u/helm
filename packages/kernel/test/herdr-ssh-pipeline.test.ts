import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { createHerdrTransport } from '../src/builtin-plugins/herdr/transport.js'

async function sshFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'helm-ssh-pipeline-'))
  const bin = join(root, 'bin')
  await mkdir(bin)
  const argsLog = join(root, 'argv.log')
  await writeFile(join(bin, 'ssh'), '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HELM_SSH_ARGS_LOG"\nexec /usr/bin/python3 -u -\n', { mode: 0o700 })
  const previous = { path: process.env.PATH, log: process.env.HELM_SSH_ARGS_LOG }
  process.env.PATH = `${bin}:${previous.path ?? ''}`
  process.env.HELM_SSH_ARGS_LOG = argsLog
  t.after(async () => {
    if (previous.path === undefined) delete process.env.PATH
    else process.env.PATH = previous.path
    if (previous.log === undefined) delete process.env.HELM_SSH_ARGS_LOG
    else process.env.HELM_SSH_ARGS_LOG = previous.log
    await rm(root, { recursive: true, force: true })
  })
  return { root, argsLog }
}

test('SSH 入口原样转交 stdin 给 Python，真实生产脚本能调用 socket RPC', { timeout: 60_000 }, async (t) => {
  const { root, argsLog } = await sshFixture(t)
  const socketPath = join(root, 'herdr.sock')
  const requests: Array<{ id: string; method: string; params: Record<string, unknown> }> = []
  const server = createServer((socket) => {
    let input = ''
    socket.on('data', (chunk) => {
      input += chunk.toString('utf8')
      if (!input.includes('\n')) return
      const request = JSON.parse(input.slice(0, input.indexOf('\n')))
      requests.push(request)
      socket.end(`${JSON.stringify({ id: request.id, result: { type: 'ok' } })}\n`)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())))
  const secret = 'pipeline-secret-only-in-stdin'
  const transport = createHerdrTransport({ redact: (text) => text.replaceAll(secret, '[REDACTED]') })
  const result = await transport.call({ machine: 'fixture-host', socketPath }, 'tab.create', { env: { PRIVATE_TOKEN: secret } }, { timeoutMs: 3_000 })
  assert.deepEqual(result, { type: 'ok' })
  assert.equal(requests.length, 1)
  assert.equal(requests[0]?.method, 'tab.create')
  assert.deepEqual(requests[0]?.params.env, { PRIVATE_TOKEN: secret })
  assert.ok(!(await readFile(argsLog, 'utf8')).includes(secret), '机密不能出现在 SSH 参数中')
})

test('同一 SSH stdin 生产脚本完成远端文件读取、删除与 Gate 环境注入', { timeout: 60_000 }, async (t) => {
  const { root } = await sshFixture(t)
  await mkdir(join(root, '.helm'))
  await writeFile(join(root, '.helm', 'wf-out-pipeline.json'), '{"answer":42}')
  const secret = 'pipeline-gate-secret'
  const transport = createHerdrTransport({ redact: (text) => text.replaceAll(secret, '[REDACTED]') })
  const target = { machine: 'fixture-host' }
  assert.equal(await transport.readOutput(target, root, 'wf-out-pipeline.json'), '{"answer":42}')
  await transport.removeOutput(target, root, 'wf-out-pipeline.json')
  await assert.rejects(transport.readOutput(target, root, 'wf-out-pipeline.json'), (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'herdr_output_missing')
  const gate = await transport.runGate(target, 'printf "%s" "$PRIVATE_TOKEN"', root, undefined, { PRIVATE_TOKEN: secret })
  assert.deepEqual(gate, { ok: true, output: '[REDACTED]' })
})

test('本机与 SSH 交接文件均拒绝通过 .helm 父目录软链越界', { timeout: 60_000 }, async (t) => {
  const { root } = await sshFixture(t)
  const cwd = join(root, 'task')
  const outside = join(root, 'outside')
  await mkdir(cwd)
  await mkdir(outside)
  await writeFile(join(outside, 'wf-out-parent.json'), '{"private":true}')
  await symlink(outside, join(cwd, '.helm'))
  const transport = createHerdrTransport()
  for (const target of [{}, { machine: 'fixture-host' }]) {
    await assert.rejects(transport.readOutput(target, cwd, 'wf-out-parent.json'), '读取不得越过工作目录')
    await assert.rejects(transport.removeOutput(target, cwd, 'wf-out-parent.json'), '删除不得越过工作目录')
    assert.equal(await readFile(join(outside, 'wf-out-parent.json'), 'utf8'), '{"private":true}')
  }
})
