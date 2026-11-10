/**
 * 新增核心命令测试：nodes / env exec / api 逃生舱 / conversations --node /
 * profiles 语义化 flag / plugins config --set / 管理面故障隔离。
 * 真实 HTTP server 模拟 Hub 契约（cli.test.ts 同款模式），验证路径、方法、
 * 请求体、退出码语义与 --json / 人类可读输出。每项显式 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'
import { coreCommands } from '../src/commands/index.js'
import { updateCliCredentials } from '../src/credentials.js'
import { CliError } from '../src/errors.js'

interface Hit {
  method: string
  path: string
  body?: unknown
  authorization?: string
}

/** 模拟 Hub：routes 形如 { 'GET /api/x': (body) => entity }；GET /api/actions 可被覆盖（含 500 场景）。 */
async function startHub(
  routes: Record<string, (body: unknown, req: http.IncomingMessage, res: http.ServerResponse) => { status?: number; body?: unknown } | null>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      const full = `${req.method} ${req.url}`
      hits.push({ method: req.method!, path: req.url!, body, authorization: req.headers['authorization'] })
      const handler = routes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body, req, res)
      if (result === null) return // 流式端点已手工写响应
      const status = result.status ?? 200
      if (result.body === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': typeof result.body === 'string' ? 'text/plain; charset=utf-8' : 'application/json' })
      res.end(typeof result.body === 'string' ? result.body : JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

async function run(argv: string[], env: NodeJS.ProcessEnv): Promise<{ out: string; err: string; code: number }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-nodes-'))
}

const LOCAL_HEALTH = {
  collectedAt: 1730000000000,
  uptimeSec: 86400,
  loadAvg: [0.5, 0.25, 0.125],
  memFreeBytes: 8 * 1024 ** 3,
  memTotalBytes: 32 * 1024 ** 3,
  diskFreeBytes: 100 * 1024 ** 3,
  diskTotalBytes: 512 * 1024 ** 3,
}

const BYOM_HEALTH = {
  collectedAt: 1730000001000,
  uptimeSec: 43200,
  loadAvg: [1.5, 1.25, 1.125],
  memFreeBytes: 16 * 1024 ** 3,
  memTotalBytes: 64 * 1024 ** 3,
}

const NODE_LIST = [
  { id: 'local', kind: 'local', online: true, hostname: 'box-a', platform: 'linux', health: LOCAL_HEALTH },
  {
    id: 'gpu-box',
    kind: 'byom',
    online: true,
    hostname: 'gpu',
    platform: 'linux',
    connectedAt: 1,
    lastSeenAt: 2,
    health: BYOM_HEALTH,
  },
  { id: 'laptop', kind: 'byom', online: false, hostname: 'mbp', platform: 'darwin' },
]

// ---------------------------------------------------------------------------
// 1. nodes list / issue / remove
// ---------------------------------------------------------------------------

test('nodes list：GET /api/nodes；--json 原始数组、人类模式关键列表格', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/nodes': () => ({ body: NODE_LIST }),
  })
  try {
    const json = await run(['nodes', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), NODE_LIST)
    assert.equal(hub.hits.at(-1)?.path, '/api/nodes')
    assert.equal(hub.hits.at(-1)?.method, 'GET')

    const human = await run(['nodes', 'list'], makeEnv(hub.url, dir))
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /gpu-box/)
    assert.match(human.out, /byom/)
    assert.match(human.out, /false/)
    assert.match(human.out, /hostname/)
    assert.match(human.out, /platform/)
  } finally {
    await hub.close()
  }
})

test('nodes list --json：透传节点 health 健康快照（local 与在线 BYOM；离线节点无 health 键）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/nodes': () => ({ body: NODE_LIST }),
  })
  try {
    const r = await run(['nodes', 'list', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const nodes = JSON.parse(r.out) as Array<{ id: string; health?: Record<string, unknown> }>
    // local 节点：完整健康快照原样透传。
    const local = nodes.find((n) => n.id === 'local')!
    assert.deepEqual(local.health, LOCAL_HEALTH, 'local health 快照必须原样透传（含磁盘字段）')
    // 在线 BYOM 节点：心跳/注册捎带的快照原样透传（缺磁盘字段时不得伪造）。
    const byom = nodes.find((n) => n.id === 'gpu-box')!
    assert.deepEqual(byom.health, BYOM_HEALTH, '在线 BYOM health 快照必须原样透传')
    assert.equal('diskFreeBytes' in (byom.health ?? {}), false, '未上报磁盘字段不得伪造')
    // 离线节点：不残留过期 health。
    const offline = nodes.find((n) => n.id === 'laptop')!
    assert.equal(offline.health, undefined, '离线节点不得残留过期 health')
    assert.equal('health' in offline, false)
  } finally {
    await hub.close()
  }
})

test('nodes issue：POST /api/nodes/issue {nodeId}；--json 全量、人类模式突出 token', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const issued = { nodeId: 'dev-1', token: 'dev-1:sec-abc', createdAt: 123 }
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/nodes/issue': () => ({ body: issued }),
  })
  try {
    const json = await run(['nodes', 'issue', 'dev-1', '--json'], makeEnv(hub.url, dir))
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), issued)
    assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'dev-1' })

    const human = await run(['nodes', 'issue', 'dev-1'], makeEnv(hub.url, dir))
    assert.equal(human.code, 0, human.err)
    assert.match(human.out, /dev-1:sec-abc/)
    assert.match(human.out, /helm-node connect/)

    // 缺位置参数显式报错
    const missing = await run(['nodes', 'issue', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'missing_id')
  } finally {
    await hub.close()
  }
})

test('nodes remove：DELETE /api/nodes/:id；多余位置参数拒绝', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'DELETE /api/nodes/gpu-box': () => ({ status: 204 }),
  })
  try {
    const r = await run(['nodes', 'remove', 'gpu-box', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    assert.equal(hub.hits.at(-1)?.method, 'DELETE')
    assert.equal(hub.hits.at(-1)?.path, '/api/nodes/gpu-box')
    assert.equal(hub.hits.at(-1)?.body, undefined)

    const stray = await run(['nodes', 'remove', 'gpu-box', 'extra', '--json'], makeEnv(hub.url, dir))
    assert.equal(stray.code, 1)
    assert.equal((JSON.parse(stray.err) as { error: { code: string } }).error.code, 'unexpected_positional')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 2. env exec
// ---------------------------------------------------------------------------

test('env exec：--node/--cwd/--timeout/--current 全量映射 body；成功退出码 0', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false } }),
  })
  try {
    const r = await run(
      ['env', 'exec', '--node', 'gpu-box', '--cwd', '/workspace', '--timeout', '5000', '--current', '--', 'pytest', '-q'],
      makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '9' }),
    )
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, '3 passed\n')
    const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
    assert.equal(hit.method, 'POST')
    assert.deepEqual(hit.body, {
      command: ['pytest', '-q'],
      nodeId: 'gpu-box',
      cwd: '/workspace',
      timeoutMs: 5000,
      conversationId: 9,
    })

    // --json 输出完整 JSON 响应（--json 需在 -- 之前：-- 之后均为命令词项）
    const json = await run(['env', 'exec', '--json', '--', 'true'], makeEnv(hub.url, dir))
    assert.equal(json.code, 0, json.err)
    assert.deepEqual(JSON.parse(json.out), { ok: true, exitCode: 0, output: '3 passed\n', timedOut: false })
  } finally {
    await hub.close()
  }
})

test('env exec：失败命令（exitCode!==0）非零退出码；timeout / ok=false 同样失败', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': (body) => {
      const cmd = (body as { command: string[] }).command
      if (cmd[0] === 'failing') return { body: { ok: true, exitCode: 2, output: 'boom\n', timedOut: false } }
      if (cmd[0] === 'timeout-cmd') return { body: { ok: false, exitCode: null, output: '', timedOut: true } }
      return { body: { ok: true, exitCode: 0, output: 'fine\n', timedOut: false } }
    },
  })
  try {
    const failed = await run(['env', 'exec', '--', 'failing', 'x'], makeEnv(hub.url, dir))
    assert.equal(failed.code, 2)
    assert.equal(failed.out, 'boom\n')
    assert.match(failed.err, /exitCode=2/)

    const failedJson = await run(['env', 'exec', '--json', '--', 'failing'], makeEnv(hub.url, dir))
    assert.equal(failedJson.code, 2)
    assert.equal(JSON.parse(failedJson.out).exitCode, 2)
    assert.equal(JSON.parse(failedJson.err).error.code, 'env_exec_failed')

    const timedOut = await run(['env', 'exec', '--', 'timeout-cmd'], makeEnv(hub.url, dir))
    assert.equal(timedOut.code, 1)
    assert.match(timedOut.err, /超时/)

    const ok = await run(['env', 'exec', '--', 'true'], makeEnv(hub.url, dir))
    assert.equal(ok.code, 0)
  } finally {
    await hub.close()
  }
})

test('env exec：单命令字符串（含空格）原样透传；缺命令/非法 timeout 显式报错', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: '', timedOut: false } }),
  })
  try {
    const shell = await run(['env', 'exec', '--', 'echo hello && echo world'], makeEnv(hub.url, dir))
    assert.equal(shell.code, 0, shell.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { command: 'echo hello && echo world' })

    // -- 之后的词项（含 --json 样式 token）均为命令一部分，不被当作全局开关
    const literal = await run(['env', 'exec', '--', 'echo', '--json'], makeEnv(hub.url, dir))
    assert.equal(literal.code, 0, literal.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { command: ['echo', '--json'] })

    const missing = await run(['env', 'exec', '--json'], makeEnv(hub.url, dir))
    assert.equal(missing.code, 1)
    assert.equal((JSON.parse(missing.err) as { error: { code: string } }).error.code, 'missing_command_target')

    const badTimeout = await run(['env', 'exec', '--json', '--timeout', '-5', '--', 'true'], makeEnv(hub.url, dir))
    assert.equal(badTimeout.code, 1)
    assert.equal((JSON.parse(badTimeout.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    // 超过上限 600000（与后端 POST /api/env/exec 校验对齐）在 CLI 侧直接拒绝：validation_error + 退出码 2
    const overTimeout = await run(['env', 'exec', '--json', '--timeout', '600001', '--', 'true'], makeEnv(hub.url, dir))
    assert.equal(overTimeout.code, 2)
    assert.equal((JSON.parse(overTimeout.err) as { error: { code: string } }).error.code, 'validation_error')
    assert.match(overTimeout.err, /600000/)
    // 请求未发向 Hub（CLI 侧先行拦截）
    assert.ok(!hub.hits.some((h) => h.path === '/api/env/exec' && (h.body as { timeoutMs?: number } | undefined)?.timeoutMs === 600001))

    // 恰好 600000 合法（边界含端）
    const boundary = await run(['env', 'exec', '--json', '--timeout', '600000', '--', 'true'], makeEnv(hub.url, dir))
    assert.equal(boundary.code, 0, boundary.err)
    assert.equal((hub.hits.filter((h) => h.path === '/api/env/exec').at(-1)?.body as { timeoutMs?: number }).timeoutMs, 600000)
  } finally {
    await hub.close()
  }
})

test('env exec --current：未传 --node 时请求体不强塞 nodeId，由 Hub 按会话绑定解析', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: 'ok\n', timedOut: false } }),
  })
  try {
    // --current 且无 --node：body 仅含 command 与 conversationId，绝无 nodeId:'local'（防误跑 Hub 本机）
    const r = await run(
      ['env', 'exec', '--current', '--', 'git', 'status'],
      makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }),
    )
    assert.equal(r.code, 0, r.err)
    const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
    assert.deepEqual(hit.body, { command: ['git', 'status'], conversationId: 12 })
    assert.ok(!('nodeId' in (hit.body as Record<string, unknown>)), '未传 --node 时不得强塞 nodeId（含 local）')
    assert.ok(!('cwd' in (hit.body as Record<string, unknown>)), '未传 --cwd 时不得覆盖会话绑定 cwd')

    // 显式 --node 仍优先（覆盖会话绑定）
    const explicit = await run(
      ['env', 'exec', '--current', '--node', 'gpu-box', '--', 'nvidia-smi'],
      makeEnv(hub.url, dir, { HELM_CONVERSATION_ID: '12' }),
    )
    assert.equal(explicit.code, 0, explicit.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { command: ['nvidia-smi'], nodeId: 'gpu-box', conversationId: 12 })

    // 无 --current 无 --node：同样不强塞（Hub 缺省 local）
    const plain = await run(['env', 'exec', '--', 'ls'], makeEnv(hub.url, dir))
    assert.equal(plain.code, 0, plain.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { command: ['ls'] })
  } finally {
    await hub.close()
  }
})

test('env exec --stream：NDJSON 逐块消费（不缓冲全响应）；失败 exitCode 传播', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 逐块写出多帧（分多个 chunk 写 socket，验证 CLI 不等全响应才开始消费）
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': (body, req, res) => {
      assert.equal((body as { stream?: boolean }).stream, true)
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'line1\n' })}\n`)
      res.write(`${JSON.stringify({ type: 'output', stream: 'stderr', text: 'warn\n' })}\n`)
      setTimeout(() => {
        res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'line2\n' })}\n`)
        res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false })}\n`)
      }, 30)
      return null
    },
  })
  try {
    const r = await run(['env', 'exec', '--stream', '--node', 'gpu-box', '--', 'build'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    assert.equal(r.out, 'line1\nwarn\nline2\n')
    const hit = hub.hits.find((h) => h.path === '/api/env/exec')!
    assert.deepEqual(hit.body, { command: ['build'], nodeId: 'gpu-box', stream: true })
  } finally {
    await hub.close()
  }

  // 失败 exitCode 经 exit 帧传播为非零退出码
  const hub2 = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': (body, req, res) => {
      void body
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 3, timedOut: false })}\n`)
      return null
    },
  })
  try {
    const failed = await run(['env', 'exec', '--stream', '--', 'failing'], makeEnv(hub2.url, dir))
    assert.equal(failed.code, 3)
    assert.equal(failed.out, '')
    assert.match(failed.err, /exitCode=3/)
  } finally {
    await hub2.close()
  }
})

test('env exec --stream --json：输出帧逐行 JSON、终态帧全量；SIGINT 取消传播', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/env/exec': (body, req, res) => {
      void body
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'step1\n' })}\n`)
      res.end(`${JSON.stringify({ type: 'exit', ok: true, exitCode: 0, timedOut: false })}\n`)
      return null
    },
  })
  try {
    const r = await run(['env', 'exec', '--stream', '--json', '--', 'build'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const lines = r.out.trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    assert.deepEqual(lines[0], { type: 'output', stream: 'stdout', text: 'step1\n' })
    assert.deepEqual(lines[1], { type: 'exit', ok: true, exitCode: 0, timedOut: false })
    // 流式请求体携带 stream: true
    assert.equal((hub.hits.find((h) => h.path === '/api/env/exec')?.body as { stream?: boolean }).stream, true)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 3. conversations create/update --node
// ---------------------------------------------------------------------------

test('conversations create/update：--node 映射 body.nodeId；原有 flag 不受影响', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/conversations': (body) => ({ body: { id: 7, ...(body as object) } }),
    'PATCH /api/conversations/7': (body) => ({ body: { id: 7, ...(body as object) } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const created = await run(
      ['conversations', 'create', '--node', 'gpu-box', '--cwd', '/workspace', '--title', '训练', '--json'],
      env,
    )
    assert.equal(created.code, 0, created.err)
    assert.deepEqual(hub.hits.find((h) => h.path === '/api/conversations')?.body, {
      nodeId: 'gpu-box',
      cwd: '/workspace',
      title: '训练',
    })

    // 原 flag 组合保持原语义（--tags/--model/--profile-id）
    const full = await run(
      ['conversations', 'create', '--profile-id', 'worker', '--model', 'openai/gpt', '--tags', 'a,b', '--json'],
      env,
    )
    assert.equal(full.code, 0, full.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { profileId: 'worker', model: 'openai/gpt', tags: ['a', 'b'] })

    const updated = await run(['conversations', 'update', '7', '--node', 'gpu-box', '--json'], env)
    assert.equal(updated.code, 0, updated.err)
    assert.deepEqual(hub.hits.find((h) => h.method === 'PATCH')?.body, { nodeId: 'gpu-box' })

    // update --node 与其他字段可组合
    const combo = await run(['conversations', 'update', '7', '--node', 'laptop', '--cwd', '/x', '--pinned', '--json'], env)
    assert.equal(combo.code, 0, combo.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'laptop', cwd: '/x', pinned: true })
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 4. profiles 语义化 flag
// ---------------------------------------------------------------------------

test('profiles create：语义化 flag（--name/--model/--node/--cwd）直接构造 Profile', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/profiles': (body) => ({ body }),
  })
  try {
    const r = await run(
      ['profiles', 'create', 'worker', '--name', '工人', '--model', 'openai/gpt-4o', '--node', 'gpu-box', '--cwd', '/workspace', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), {
      id: 'worker',
      name: '工人',
      model: 'openai/gpt-4o',
      nodeId: 'gpu-box',
      cwd: '/workspace',
    })
  } finally {
    await hub.close()
  }
})

test('profiles create：--system-file 全文进 body；语义化 flag 覆盖 --input 同名字段', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const systemFile = path.join(dir, 'SYSTEM.md')
  await fsp.writeFile(systemFile, '# 系统\n你是工人。')
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'POST /api/profiles': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const r = await run(
      ['profiles', 'create', 'worker', '--system-file', systemFile, '--json'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as Record<string, unknown>
    assert.equal(body['system'], '# 系统\n你是工人。')

    // --input 为基底，语义化 flag 覆盖对应字段（name/model 被覆盖，cwd 保留）
    const merged = await run(
      [
        'profiles', 'create',
        '--input', '{"id":"x","name":"基底","model":"old/m","cwd":"/base","extra":1}',
        '--name', '覆盖名', '--model', 'new/m',
        '--json',
      ],
      env,
    )
    assert.equal(merged.code, 0, merged.err)
    assert.deepEqual(JSON.parse(merged.out), {
      id: 'x',
      name: '覆盖名',
      model: 'new/m',
      cwd: '/base',
      extra: 1,
    })

    // 全缺报错
    const none = await run(['profiles', 'create', '--json'], env)
    assert.equal(none.code, 1)
    assert.equal((JSON.parse(none.err) as { error: { code: string } }).error.code, 'missing_update_fields')
  } finally {
    await hub.close()
  }
})

test('profiles update：语义化 flag 先 GET 合并后 PUT（整体替换契约防丢字段）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  // 既有完整配置：含 nodeId/cwd/tags/runtime 等绑定字段与 system/memory 全文
  const existing = {
    id: 'worker',
    name: '旧名',
    model: 'old/m',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    tags: ['a', 'b'],
    runtime: { kind: 'herdr', agent: 'agy' },
    system: '# 系统提示词全文',
  }
  let putBody: unknown
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/profiles/worker': () => ({ body: existing }),
    'PUT /api/profiles/worker': (body) => {
      putBody = body
      return { body }
    },
  })
  const env = makeEnv(hub.url, dir)
  try {
    // 只改 --model：GET 先于 PUT，且 PUT body 保留全部绑定字段（nodeId/cwd/tags/runtime）
    const r = await run(['profiles', 'update', 'worker', '--model', 'anthropic/sonnet', '--json'], env)
    assert.equal(r.code, 0, r.err)
    const getHit = hub.hits.find((h) => h.method === 'GET' && h.path === '/api/profiles/worker')
    const putHit = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')
    assert.ok(getHit, '语义化 flag 路径必须先 GET 完整 Profile')
    assert.ok(putHit, '随后 PUT 合并结果')
    assert.ok(hub.hits.indexOf(getHit!) < hub.hits.indexOf(putHit!), 'GET 必须先于 PUT')
    assert.deepEqual(putBody, {
      id: 'worker',
      name: '旧名',
      model: 'anthropic/sonnet',
      nodeId: 'gpu-box',
      cwd: '/workspace',
      tags: ['a', 'b'],
      runtime: { kind: 'herdr', agent: 'agy' },
    })
    // GET 带回的 system 全文不得回传（未显式给出时）
    assert.ok(!('system' in (putBody as Record<string, unknown>)))

    // 只改 --name 同样不丢 nodeId（防会话误跑 local 的回归键）
    const rename = await run(['profiles', 'update', 'worker', '--name', '新名', '--json'], env)
    assert.equal(rename.code, 0, rename.err)
    const lastPut = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
    assert.equal(lastPut['name'], '新名')
    assert.equal(lastPut['nodeId'], 'gpu-box')
    assert.equal(lastPut['cwd'], '/workspace')
    assert.ok(!('system' in lastPut))
  } finally {
    await hub.close()
  }
})

test('profiles update：显式 --system 进 body；--input 与语义化 flag 组合稳定合并', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const existing = {
    id: 'worker',
    name: '基底',
    model: 'old/m',
    nodeId: 'gpu-box',
    cwd: '/workspace',
    system: '旧系统提示词',
  }
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/profiles/worker': () => ({ body: existing }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // 显式 --system 覆盖（MEMORY.md 由 builtin:memory 插件管理，不经 Profile）
    const r = await run(
      ['profiles', 'update', 'worker', '--system', '新系统提示词', '--node', 'laptop', '--json'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    const body = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
    assert.equal(body['system'], '新系统提示词')
    assert.equal(body['nodeId'], 'laptop')
    assert.equal(body['name'], '基底')

    // --input + 语义化 flag 组合：以 GET 基底 + --input 覆盖 + flag 覆盖，字段不丢
    const merged = await run(
      [
        'profiles', 'update', 'worker',
        '--input', '{"name":"中文名","cwd":"/new-cwd"}',
        '--model', 'new/m',
        '--json',
      ],
      env,
    )
    assert.equal(merged.code, 0, merged.err)
    const body2 = hub.hits.filter((h) => h.method === 'PUT').at(-1)!.body as Record<string, unknown>
    assert.deepEqual(body2, {
      id: 'worker',
      name: '中文名',
      model: 'new/m',
      nodeId: 'gpu-box', // GET 基底保留，未丢
      cwd: '/new-cwd', // --input 覆盖
    })
  } finally {
    await hub.close()
  }
})

test('profiles update --input 单独使用：全量替换语义（无 GET）；GET 404 如实上抛', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'PUT /api/profiles/worker': (body) => ({ body }),
    'GET /api/profiles/ghost': () => ({ status: 404, body: { error: { code: 'not_found', message: '无此 Profile' } } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // --input 单独使用 = 显式全量替换：不发 GET，body 即 --input + id
    const whole = await run(
      ['profiles', 'update', 'worker', '--input', '{"name":"全量","model":"m"}', '--json'],
      env,
    )
    assert.equal(whole.code, 0, whole.err)
    assert.ok(!hub.hits.some((h) => h.method === 'GET' && h.path === '/api/profiles/worker'), '纯 --input 不得 GET')
    assert.deepEqual(hub.hits.at(-1)?.body, { name: '全量', model: 'm', id: 'worker' })

    // 语义化 flag 目标不存在：GET 404 错误信封如实上抛（不伪造基底盲改）
    const ghost = await run(['profiles', 'update', 'ghost', '--name', 'x', '--json'], env)
    assert.equal(ghost.code, 1)
    assert.equal((JSON.parse(ghost.err) as { error: { code: string } }).error.code, 'not_found')

    // 全缺报错
    const none = await run(['profiles', 'update', 'worker', '--json'], env)
    assert.equal(none.code, 1)
    assert.equal((JSON.parse(none.err) as { error: { code: string } }).error.code, 'missing_update_fields')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 5. plugins config --set
// ---------------------------------------------------------------------------

test('plugins config --set：key=value 可重复、标量语义解析；与 --input 共存覆盖同键', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/plugins/builtin%3Aherdr/config': () => ({ body: { values: { retries: 3 }, schema: {} } }),
    'PUT /api/plugins/builtin%3Aherdr/config': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const r = await run(
      ['plugins', 'config', 'builtin:herdr', '--set', 'retries=5', '--set', 'verbose=true', '--set', 'label=herdr 主机', '--json'],
      env,
    )
    assert.equal(r.code, 0, r.err)
    assert.equal(hub.hits.at(-1)?.method, 'PUT')
    assert.deepEqual(hub.hits.at(-1)?.body, {
      values: { retries: 5, verbose: true, label: 'herdr 主机' },
    })

    // --set 覆盖 --input 同键，保留其余键
    const merged = await run(
      ['plugins', 'config', 'builtin:herdr', '--input', '{"retries":9,"other":"keep"}', '--set', 'retries=1', '--json'],
      env,
    )
    assert.equal(merged.code, 0, merged.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { values: { retries: 1, other: 'keep' } })

    // 无 --set 且无 --input：保持 GET 语义
    const get = await run(['plugins', 'config', 'builtin:herdr', '--json'], env)
    assert.equal(get.code, 0, get.err)
    assert.equal(hub.hits.at(-1)?.method, 'GET')
    assert.deepEqual(JSON.parse(get.out), { values: { retries: 3 }, schema: {} })

    // 非法 --set（无 =）显式报错
    const bad = await run(['plugins', 'config', 'builtin:herdr', '--set', 'novalue', '--json'], env)
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 6. api 逃生舱
// ---------------------------------------------------------------------------

test('api GET：大小写不敏感、path 自动补齐前导 /；--field 构造 POST body', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/nodes': () => ({ body: NODE_LIST }),
    'POST /api/nodes/issue': () => ({ body: { nodeId: 'dev-1', token: 'dev-1:s', createdAt: 1 } }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // method 小写 + path 带前导 /
    const list = await run(['api', 'get', '/api/nodes', '--json'], env)
    assert.equal(list.code, 0, list.err)
    assert.deepEqual(JSON.parse(list.out), NODE_LIST)

    // method 混合大小写 + path 不带前导 /
    const list2 = await run(['api', 'Get', 'api/nodes', '--json'], env)
    assert.equal(list2.code, 0, list2.err)
    assert.equal(hub.hits.at(-1)?.method, 'GET')
    assert.equal(hub.hits.at(-1)?.path, '/api/nodes')

    const issue = await run(['api', 'POST', '/api/nodes/issue', '--field', 'nodeId=dev-1', '--json'], env)
    assert.equal(issue.code, 0, issue.err)
    assert.equal(hub.hits.at(-1)?.method, 'POST')
    assert.equal(hub.hits.at(-1)?.path, '/api/nodes/issue')
    assert.deepEqual(hub.hits.at(-1)?.body, { nodeId: 'dev-1' })

    // 非法 method 显式报错
    const bad = await run(['api', 'TRACE', '/api/nodes', '--json'], env)
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

test('api PUT --field 标量语义（number/boolean/string）；--input 整体 body', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'PUT /api/profiles/p1': (body) => ({ body }),
    'PUT /api/providers': (body) => ({ body }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const fields = await run(
      ['api', 'put', 'api/profiles/p1', '--field', 'n=42', '--field', 'ok=false', '--field', 's=纯文本', '--json'],
      env,
    )
    assert.equal(fields.code, 0, fields.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { n: 42, ok: false, s: '纯文本' })

    const whole = await run(['api', 'PUT', '/api/providers', '--input', '[{"id":"g"}]', '--json'], env)
    assert.equal(whole.code, 0, whole.err)
    assert.deepEqual(hub.hits.at(-1)?.body, [{ id: 'g' }])
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 7. 管理面故障隔离：/api/actions 500 时核心命令仍 100% 可用
// ---------------------------------------------------------------------------

test('管理面故障隔离：GET /api/actions 500 时 nodes/env/plugins 等核心命令照常执行', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    // manifest 端点炸掉（模拟坏插件拖垮动作总线）
    'GET /api/actions': () => ({ status: 500, body: { error: { code: 'internal_error', message: '坏插件 manifest' } } }),
    'GET /api/nodes': () => ({ body: NODE_LIST }),
    'POST /api/env/exec': () => ({ body: { ok: true, exitCode: 0, output: 'ok\n', timedOut: false } }),
    'POST /api/plugins/builtin%3Aevil/disable': () => ({ body: { ok: true } }),
    'GET /api/conversations': () => ({ body: [] }),
    'GET /api/profiles': () => ({ body: [] }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    // 核心命令精确匹配即执行：绝不因 /api/actions 500 阻断
    const nodes = await run(['nodes', 'list', '--json'], env)
    assert.equal(nodes.code, 0, nodes.err)
    assert.deepEqual(JSON.parse(nodes.out), NODE_LIST)

    const exec = await run(['env', 'exec', '--', 'echo', 'hi'], env)
    assert.equal(exec.code, 0, exec.err)
    assert.equal(exec.out, 'ok\n')

    const disable = await run(['plugins', 'disable', 'builtin:evil', '--json'], env)
    assert.equal(disable.code, 0, disable.err)
    assert.equal(hub.hits.at(-1)?.path, '/api/plugins/builtin%3Aevil/disable')

    const convs = await run(['conversations', 'list', '--json'], env)
    assert.equal(convs.code, 0, convs.err)
    assert.deepEqual(JSON.parse(convs.out), [])

    const profiles = await run(['profiles', 'list', '--json'], env)
    assert.equal(profiles.code, 0, profiles.err)

    // api 逃生舱同样不受影响
    const api = await run(['api', 'GET', '/api/nodes', '--json'], env)
    assert.equal(api.code, 0, api.err)

    // 仅真正的动态命令路径才拉 /api/actions 并显式报错（错误信封透传 500）
    const dynamic = await run(['some', 'plugin', 'action', '--json'], env)
    assert.equal(dynamic.code, 1)
    assert.equal((JSON.parse(dynamic.err) as { error: { code: string } }).error.code, 'internal_error')
  } finally {
    await hub.close()
  }
})

test('env exec --stream：取消传播——已到帧已消费、aborted 非零退出、服务端立即感知断开', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const seenDisconnect = { value: false }
  // NDJSON 端点：先出一帧后挂起；连接断开立即置位（验证 CLI 取消即断流，不继续拉取）
  const server = http.createServer((req, res) => {
    if (req.url === '/api/actions') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('[]')
      return
    }
    if (req.url === '/api/env/exec') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(`${JSON.stringify({ type: 'output', stream: 'stdout', text: 'frame-1\n' })}\n`)
      req.on('close', () => { seenDisconnect.value = true })
      return // 永不主动 end：只有客户端取消才断
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  let out = ''
  let err = ''
  try {
    // 经 Io.fetchImpl 注入替身：首帧后立即 abort（等价 SIGINT 的 aborted 错误路径）
    const code = await runCli(['env', 'exec', '--stream', '--', 'sleep', '10'], {
      env: makeEnv(url, dir),
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      fetch: (input, init) => {
        const ac = new AbortController()
        // 300ms 后 abort：读流阶段抛 AbortError → CliError(aborted, 130)
        setTimeout(() => ac.abort(), 300)
        return fetch(input, { ...init, signal: ac.signal })
      },
    })
    assert.equal(code, 130, `退出码需为 130（SIGINT 惯例），实得 ${code}，stderr=${err}`)
    assert.equal(out, 'frame-1\n', '取消前已到帧必须已消费（真逐块，非缓冲）')
    assert.match(err, /已取消/)
    // 服务端感知断开（fetch abort 立即断开连接）
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(seenDisconnect.value, true, '取消必须立即断流，不继续拉取')
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

test('帮助文本包含 nodes/env/api 命令说明；nodes 命令族不与动态命令冲突', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/actions': () => ({ body: [] }),
    'GET /api/nodes': () => ({ body: [] }),
  })
  const env = makeEnv(hub.url, dir)
  try {
    const help = await run(['--help'], env)
    assert.equal(help.code, 0)
    assert.match(help.out, /nodes list/)
    assert.match(help.out, /nodes issue/)
    assert.match(help.out, /nodes remove/)
    assert.match(help.out, /env exec/)
    assert.match(help.out, /api <method> <path>/)

    // nodes list 即使有同名动态声明（若 manifest 抢占）也按核心执行——已由故障隔离测试覆盖
    const nodes = await run(['nodes', 'list'], env)
    assert.equal(nodes.code, 0, nodes.err)
    assert.match(nodes.out, /\(empty\)/)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// 8. 静态命令表唯一性断言（防未来新增命令撞路径被 matchCommand exact[0] 静默吞掉）
// ---------------------------------------------------------------------------

test('静态命令表：coreCommands 路径全等唯一且互不为前缀冲突', { timeout: 60_000 }, () => {
  const commands = coreCommands() // 内部已校验，重复/前缀冲突会抛 command_table_conflict
  const paths = commands.map((c) => c.path.join(' '))
  assert.equal(new Set(paths).size, paths.length, `静态命令路径重复：${JSON.stringify(paths)}`)
  // 互不为前缀：较短路径不得是任何较长路径的头部序列
  for (const cmd of commands) {
    for (const other of commands) {
      if (cmd === other || other.path.length >= cmd.path.length) continue
      const isPrefix = other.path.every((seg, i) => seg === cmd.path[i])
    assert.equal(isPrefix, false, `命令前缀冲突："${cmd.path.join(' ')}" 会遮蔽 "${other.path.join(' ')}"`)
    }
  }
})

// ---------------------------------------------------------------------------
// 9. cli-token 锁竞态：空/半截锁文件宽限重读，陈旧残留如实判损坏
// ---------------------------------------------------------------------------

test('cli-token 锁：空锁文件刚创建不久视为持有者正在写入，等待后成功；陈旧空锁如实报 credentials_lock_broken', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const lockFile = path.join(dir, 'cli-token.lock')
  // 场景 1：模拟旧平台 fallback 的「先建空文件后写内容」慢持有者：占位空锁（新鲜 mtime），
  // 300ms 后持有者写满 owner 行、900ms 后释放。竞争方在宽限窗内等待重读，绝不误杀并发者。
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const holderOwner = `${process.pid} holder-uuid`
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${holderOwner}\n`).catch(() => {}) }, 300)
  const releaseTimer = setTimeout(() => { void fsp.rm(lockFile, { force: true }).catch(() => {}) }, 900)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:1', token: 'tok' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok')
  // 锁与临时文件不残留
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])

  // 场景 2：陈旧空锁（mtime 超过宽限窗且无人补写）→ 如实抛 credentials_lock_broken，绝不静默当无锁
  await fsp.writeFile(lockFile, '', { mode: 0o600 })
  const old = new Date(Date.now() - 60_000)
  await fsp.utimes(lockFile, old, old)
  await assert.rejects(
    updateCliCredentials(dir, { token: 'tok2' }),
    (err: unknown) => err instanceof CliError && err.code === 'credentials_lock_broken',
  )
})

test('cli-token 锁：半截锁内容同样受宽限窗保护，等待持有者完成后成功', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const lockFile = path.join(dir, 'cli-token.lock')
  // 半截内容（首 token 非 PID）+ 慢持有者在宽限窗内补写完整 owner 行随后释放
  await fsp.writeFile(lockFile, 'garbage ', { mode: 0o600 })
  const fillTimer = setTimeout(() => { void fsp.writeFile(lockFile, `${process.pid} filler\n`).catch(() => {}) }, 200)
  const releaseTimer = setTimeout(() => { void fsp.rm(lockFile, { force: true }).catch(() => {}) }, 700)
  try {
    await updateCliCredentials(dir, { hubUrl: 'http://127.0.0.1:2', token: 'tok-half' })
  } finally {
    clearTimeout(fillTimer)
    clearTimeout(releaseTimer)
  }
  const saved = JSON.parse(await fsp.readFile(path.join(dir, 'cli-token'), 'utf8')) as { token: string }
  assert.equal(saved.token, 'tok-half')
  const leftovers = (await fsp.readdir(dir)).filter((f) => f.includes('.lock') || f.includes('.tmp'))
  assert.deepEqual(leftovers, [])
})
