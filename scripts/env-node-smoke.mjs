import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHelm } from '../packages/kernel/dist/index.js'
import { startHub } from '../packages/kernel/dist/http/index.js'
import { writeNodeIdentity } from '../packages/node/dist/index.js'

// 编译产物黑盒验收；所有数据和后台进程都属于本脚本，不调用外部模型。
const repository = dirname(dirname(fileURLToPath(import.meta.url)))
const root = await mkdtemp(join(tmpdir(), 'helm-env-compiled-'))
const nodeDir = join(root, 'node')
const workspace = join(root, 'workspace')
await Promise.all([mkdir(nodeDir), mkdir(workspace)])
const app = await createHelm({ dataDir: join(root, 'hub'), cwd: root, watchdogIntervalMs: 0 })
let hub
let credential

async function command(entry, args, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''; let err = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('编译命令执行超时')) }, 30_000)
    child.stdout.on('data', (chunk) => { out += chunk.toString() })
    child.stderr.on('data', (chunk) => { err += chunk.toString() })
    child.once('error', (error) => { clearTimeout(timer); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); resolve({ code, out, err }) })
  })
}
const nodeEntry = join(repository, 'packages/node/dist/cli.js')
const cliEntry = join(repository, 'packages/cli/dist/index.js')
const node = (args) => command(nodeEntry, [...args, '--data-dir', nodeDir, '--json'])
try {
  hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 })
  credential = app.kernel.auth.createProcessToken()
  const cli = (args) => command(cliEntry, args, { HELM_HUB_URL: hub.url, HELM_TOKEN: credential.token, HELM_DATA_DIR: join(root, 'client') })
  const issued = await cli(['nodes', 'issue', 'smoke-node', '--json'])
  assert.equal(issued.code, 0, issued.err)
  const token = JSON.parse(issued.out).token
  await writeNodeIdentity(nodeDir, { nodeId: 'smoke-node', token, hubUrl: hub.url })
  const started = await node(['start', '-d'])
  assert.equal(started.code, 0, started.err)
  assert.equal(JSON.parse(started.out).state, 'registered')
  const status = await node(['status'])
  assert.equal(status.code, 0, status.err)
  assert.equal(JSON.parse(status.out).state, 'registered')
  const listed = await cli(['nodes', 'list', '--json'])
  assert.equal(listed.code, 0, listed.err)
  assert.ok(JSON.parse(listed.out).some((entry) => entry.id === 'smoke-node' && entry.online))
  const remote = await cli(['env', 'exec', '--node', 'smoke-node', '--cwd', workspace, '--json', '--', 'helm status --json'])
  assert.equal(remote.code, 0, remote.err)
  assert.equal(JSON.parse(JSON.parse(remote.out).output).authenticated, true)
  const stream = await cli(['env', 'exec', '--node', 'smoke-node', '--cwd', workspace, '--stream', '--json', '--', process.execPath, '-e', 'process.stdout.write("compiled-stream-ok")'])
  assert.equal(stream.code, 0, stream.err)
  const frames = stream.out.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(frames.at(-1).type, 'exit')
  assert.equal(frames.at(-1).ok, true)
  assert.equal(frames.filter((frame) => frame.type === 'output').map((frame) => frame.text).join(''), 'compiled-stream-ok')
  const stopped = await node(['stop'])
  assert.equal(stopped.code, 0, stopped.err)
  const removed = await cli(['nodes', 'remove', 'smoke-node', '--json'])
  assert.equal(removed.code, 0, removed.err)
  console.log('EnvFabric compiled smoke passed: separate helm-node processes, registration, independent helm client, remote managed CLI, NDJSON output/exit, stop and revoke. No model was called.')
} finally {
  try { await node(['stop']) } finally {
    credential?.dispose()
    try { await hub?.close() } finally {
      await app.close()
      await rm(root, { recursive: true, force: true })
    }
  }
}
