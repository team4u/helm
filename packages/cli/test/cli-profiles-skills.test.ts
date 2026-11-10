/**
 * profiles --skills/--all-skills CLI 测试：临时 HTTP server 模拟 Hub 契约。
 * 覆盖：create/update 白名单写入、[] 禁用、--all-skills 删键恢复全部、
 * 互斥与非法列表本地拒绝、合并基底保留 node/cwd/runtime/tags、
 * --input 整体替换与组合覆盖、--json 输出与 --help 帮助。
 */
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const allRoutes: Record<string, (body: unknown) => { status?: number; body?: unknown }> = {
    'GET /api/actions': () => ({ body: [] }),
    ...routes,
  }
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
      hits.push({ method: req.method!, path: req.url!, body })
      const handler = allRoutes[`${req.method} ${req.url}`]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
        return
      }
      const result = handler(body)
      const status = result.status ?? 200
      if (result.body === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
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

const tempDirs: string[] = []
after(async () => {
  await Promise.all(tempDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-cli-profiles-skills-'))
  tempDirs.push(dir)
  return dir
}

/** 模拟 Hub 侧已有 Profile（含 runtime/tags/nodeId/cwd 与旧 skills 白名单）。 */
const EXISTING_WORKER = {
  id: 'worker',
  name: 'Worker',
  model: 'faux/model',
  thinkingLevel: 'medium',
  nodeId: 'node-a',
  cwd: '/srv/work',
  tags: ['ci'],
  runtime: { kind: 'herdr', agent: 'pi', nodeId: 'node-a', workspace: '/srv/work' },
  skills: ['git-commit', 'herdr'],
  system: '# SYSTEM',
  memory: '# MEMORY',
}

test('profiles create --skills：白名单写入 body；[] 表示无技能', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/profiles': (body) => ({ body }),
  })
  try {
    const r = await run(['profiles', 'create', 'reviewer', '--name', '审查员', '--skills', '["git-commit"]', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const hit = hub.hits.find((h) => h.method === 'POST' && h.path === '/api/profiles')!
    assert.deepEqual(hit.body, { id: 'reviewer', name: '审查员', skills: ['git-commit'] })
    assert.deepEqual(JSON.parse(r.out), { id: 'reviewer', name: '审查员', skills: ['git-commit'] })

    // 空数组 = 显式禁用全部技能（键必须存在且为 []，不得被丢弃或转 undefined）
    const empty = await run(['profiles', 'create', 'minimal', '--skills', '[]', '--json'], makeEnv(hub.url, dir))
    assert.equal(empty.code, 0, empty.err)
    assert.deepEqual(hub.hits.at(-1)?.body, { id: 'minimal', skills: [] })
  } finally {
    await hub.close()
  }
})

test('profiles update --skills：GET 合并后仅替换 skills，nodeId/cwd/runtime/tags 全保留', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  try {
    const r = await run(['profiles', 'update', 'worker', '--skills', '["git-commit"]', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const put = hub.hits.find((h) => h.method === 'PUT' && h.path === '/api/profiles/worker')!
    assert.deepEqual(put.body, {
      id: 'worker',
      name: 'Worker',
      model: 'faux/model',
      thinkingLevel: 'medium',
      nodeId: 'node-a',
      cwd: '/srv/work',
      tags: ['ci'],
      runtime: EXISTING_WORKER.runtime,
      skills: ['git-commit'],
    })
    // GET 带回的 system/memory 全文不回传（剥离规则不变）
    const body = put.body as Record<string, unknown>
    assert.equal('system' in body, false)
    assert.equal('memory' in body, false)
  } finally {
    await hub.close()
  }
})

test('profiles update --skills "[]"：空数组透传（禁用全部，不丢键）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  try {
    const r = await run(['profiles', 'update', 'worker', '--skills', '[]', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const put = hub.hits.find((h) => h.method === 'PUT')!
    assert.deepEqual((put.body as Record<string, unknown>).skills, [])
    // 其余绑定字段仍在
    assert.equal((put.body as Record<string, unknown>).nodeId, 'node-a')
    assert.equal((put.body as Record<string, unknown>).cwd, '/srv/work')
  } finally {
    await hub.close()
  }
})

test('profiles update --all-skills：删除合并后的 skills 键恢复全部可用技能', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'GET /api/profiles/worker': () => ({ body: { ...EXISTING_WORKER } }),
    'PUT /api/profiles/worker': (body) => ({ body }),
  })
  try {
    const r = await run(['profiles', 'update', 'worker', '--all-skills', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    const put = hub.hits.find((h) => h.method === 'PUT')!
    const body = put.body as Record<string, unknown>
    assert.equal('skills' in body, false, 'skills 键必须被删除（undefined = 全部技能）')
    assert.equal(body.nodeId, 'node-a')
    assert.equal(body.cwd, '/srv/work')
    assert.deepEqual(body.runtime, EXISTING_WORKER.runtime)
    assert.deepEqual(body.tags, ['ci'])
  } finally {
    await hub.close()
  }
})

test('--skills 与 --all-skills 互斥：create/update 均本地拒绝 conflicting_flags（不发请求）', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/profiles': (body) => ({ body }),
  })
  try {
    const create = await run(['profiles', 'create', 'x', '--skills', '["a"]', '--all-skills', '--json'], makeEnv(hub.url, dir))
    assert.equal(create.code, 1)
    assert.equal((JSON.parse(create.err) as { error: { code: string } }).error.code, 'conflicting_flags')
    assert.equal(hub.hits.filter((h) => h.path === '/api/profiles').length, 0, '互斥错误必须在发请求前拒绝')

    const update = await run(['profiles', 'update', 'x', '--skills', '["a"]', '--all-skills', '--json'], makeEnv(hub.url, dir))
    assert.equal(update.code, 1)
    assert.equal((JSON.parse(update.err) as { error: { code: string } }).error.code, 'conflicting_flags')
  } finally {
    await hub.close()
  }
})

test('非法 --skills 列表本地拒绝：非字符串数组 / 非数组 JSON', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({})
  try {
    const numbers = await run(['profiles', 'create', 'x', '--skills', '[1,2]', '--json'], makeEnv(hub.url, dir))
    assert.equal(numbers.code, 1)
    assert.equal((JSON.parse(numbers.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    const mixed = await run(['profiles', 'create', 'x', '--skills', '["a",1]', '--json'], makeEnv(hub.url, dir))
    assert.equal(mixed.code, 1)
    assert.equal((JSON.parse(mixed.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    const notArray = await run(['profiles', 'create', 'x', '--skills', '"git-commit"', '--json'], makeEnv(hub.url, dir))
    assert.equal(notArray.code, 1)
    assert.equal((JSON.parse(notArray.err) as { error: { code: string } }).error.code, 'invalid_flag_value')

    const update = await run(['profiles', 'update', 'x', '--skills', '{"a":1}', '--json'], makeEnv(hub.url, dir))
    assert.equal(update.code, 1)
    assert.equal((JSON.parse(update.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
  }
})

test('--input 整体替换语义保持：skills 键原样透传；与语义化 flag 组合时覆盖对应字段', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'PUT /api/profiles/solo': (body) => ({ body }),
  })
  try {
    // --input 单独使用：全量替换，skills 原样（含 undefined 语义：不带 skills 键）
    const whole = await run(
      ['profiles', 'update', 'solo', '--input', '{"name":"Solo","nodeId":"node-b","cwd":"/w"}', '--json'],
      makeEnv(hub.url, dir),
    )
    assert.equal(whole.code, 0, whole.err)
    const put = hub.hits.find((h) => h.method === 'PUT')!
    assert.deepEqual(put.body, { name: 'Solo', nodeId: 'node-b', cwd: '/w', id: 'solo' })
    assert.equal(hub.hits.some((h) => h.method === 'GET'), false, '纯 --input 不触发 GET 合并')

    // --input 携带 skills 与 --skills 同给：语义化 flag 覆盖对应字段
    const hub2 = await startHub({
      'GET /api/profiles/solo': () => ({ body: { id: 'solo', name: 'Solo', skills: ['old'] } }),
      'PUT /api/profiles/solo': (body) => ({ body }),
    })
    try {
      const combined = await run(
        ['profiles', 'update', 'solo', '--input', '{"name":"Solo","skills":["from-input"]}', '--skills', '["git-commit"]', '--json'],
        makeEnv(hub2.url, dir),
      )
      assert.equal(combined.code, 0, combined.err)
      const put2 = hub2.hits.find((h) => h.method === 'PUT')!
      assert.deepEqual((put2.body as Record<string, unknown>).skills, ['git-commit'])

      // --input 携带 skills 与 --all-skills 同给：合并层先赋值、语义层删键，最终无 skills
      const withAll = await run(
        ['profiles', 'update', 'solo', '--input', '{"skills":["from-input"]}', '--all-skills', '--json'],
        makeEnv(hub2.url, dir),
      )
      assert.equal(withAll.code, 0, withAll.err)
      const put3 = hub2.hits.filter((h) => h.method === 'PUT').at(-1)!
      assert.equal('skills' in (put3.body as Record<string, unknown>), false)
    } finally {
      await hub2.close()
    }
  } finally {
    await hub.close()
  }
})

test('--help 与 --json 输出：帮助展示 --skills/--all-skills，JSON 输出 Hub 回显', { timeout: 60_000 }, async () => {
  const dir = await tempDir()
  const hub = await startHub({
    'POST /api/profiles': (body) => ({ body }),
  })
  try {
    const createHelp = await run(['profiles', 'create', '--help'], makeEnv(hub.url, dir))
    assert.equal(createHelp.code, 0)
    assert.match(createHelp.out, /--skills <json>/)
    assert.match(createHelp.out, /--all-skills <boolean>/)
    assert.match(createHelp.out, /互斥/)

    const updateHelp = await run(['profiles', 'update', '--help'], makeEnv(hub.url, dir))
    assert.equal(updateHelp.code, 0)
    assert.match(updateHelp.out, /--skills <json>/)
    assert.match(updateHelp.out, /--all-skills <boolean>/)

    // --json 模式输出 Hub 响应原文（含 skills 字段）
    const r = await run(['profiles', 'create', 'bot', '--skills', '["git-commit","herdr"]', '--json'], makeEnv(hub.url, dir))
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), { id: 'bot', skills: ['git-commit', 'herdr'] })
  } finally {
    await hub.close()
  }
})
