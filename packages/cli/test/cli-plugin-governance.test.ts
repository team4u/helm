/**
 * 插件治理 CLI 测试：plugins disable --force（409 plugin_in_use 富化提示）、
 * plugins config --unset（发送 null 重置与 --set/--unset 同 key 冲突拒绝）。
 * 真实 runCli + 模拟 Hub HTTP 契约（真实 fetch 边界）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

/**
 * 模拟 Hub：routes 键为 "METHOD path"，返回 {status?, body?}；
 * body 为 'THROW_409_IN_USE' 时返回 409 plugin_in_use 错误信封。
 */
async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
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
      hits.push({ method: req.method!, path: req.url!, body })
      const handler = routes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body)
      const status = result.status ?? 200
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body ?? null))
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

async function run(
  argv: string[],
  hubUrl: string,
  dataDir: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env: { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test' },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  })
  return { code, out, err }
}

/** 409 plugin_in_use 错误信封（含 details.usages 占用清单）。 */
const inUseResponse = (usages: Array<{ kind: string; id: string; label: string }>) => ({
  status: 409,
  body: {
    error: {
      code: 'plugin_in_use',
      message: '插件存在关联的配置或持久资源，停用后相关功能将失效',
      details: { pluginId: 'builtin:triggers', usages },
    },
  },
})

test('plugins disable：无 --force 保持无 body 请求', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/builtin%3Atriggers/disable': () => ({
      body: [{ id: 'builtin:triggers', name: '触发器', locked: false, enabled: false, hooks: [], actions: [], tools: [] }],
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const r = await run(['plugins', 'disable', 'builtin:triggers', '--json'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    // 关键回归点：未传 --force 时请求体不含 force（保持既有无 body 调用语义）
    assert.equal(hub.hits[0]!.method, 'POST')
    assert.equal((hub.hits[0]!.body as { force?: boolean } | undefined)?.force, undefined)
    assert.equal(JSON.parse(r.out)[0]?.id, 'builtin:triggers')
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins disable --force：请求携带 { force: true }', { timeout: 60_000 }, async () => {
  let sawForce: unknown
  const hub = await startHub({
    'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
      sawForce = (body as { force?: boolean } | undefined)?.force
      return {
        body: [{ id: 'builtin:triggers', name: '触发器', locked: false, enabled: false, hooks: [], actions: [], tools: [] }],
      }
    },
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const r = await run(['plugins', 'disable', 'builtin:triggers', '--force', '--json'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(hub.hits[0]!.body, { force: true })
    assert.equal(sawForce, true)
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins disable：409 plugin_in_use 时人类模式输出占用清单与 --force 提示，--json 保留信封', { timeout: 60_000 }, async () => {
  const usages = [
    { kind: 'cron_job', id: 'rule-1', label: '每日巡检（cron 0 9 * * *）' },
    { kind: 'profile_runtime', id: 'watchdog', label: '角色 watchdog 的 runtime 依赖本插件' },
  ]
  let forceSeen = false
  const hub = await startHub({
    'POST /api/plugins/builtin%3Atriggers/disable': (body) => {
      forceSeen = (body as { force?: boolean } | undefined)?.force === true
      return inUseResponse(usages)
    },
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    // 人类模式：错误消息含占用摘要与 --force 提示，退出码非零
    const r = await run(['plugins', 'disable', 'builtin:triggers'], hub.url, dataDir)
    assert.equal(r.code, 1)
    assert.equal(forceSeen, false)
    assert.ok(r.err.includes('插件存在关联'), r.err)
    assert.ok(r.err.includes('[cron_job] rule-1'), r.err)
    assert.ok(r.err.includes('[profile_runtime] watchdog'), r.err)
    assert.ok(r.err.includes('--force'), r.err)

    // --json：错误信封保留原 code 与 details（供机器消费）
    const rj = await run(['plugins', 'disable', 'builtin:triggers', '--json'], hub.url, dataDir)
    assert.equal(rj.code, 1)
    const envelope = JSON.parse(rj.err) as { error: { code: string; details: { usages: unknown[] } } }
    assert.equal(envelope.error.code, 'plugin_in_use')
    assert.equal(envelope.error.details.usages.length, 2)
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins config --unset：PUT 发送 { values: { [key]: null } }，可与 --set 组合', { timeout: 60_000 }, async () => {
  let lastBody: unknown
  const hub = await startHub({
    'PUT /api/plugins/builtin%3Aherdr/config': (body) => {
      lastBody = body
      return { body: { ok: true } }
    },
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const r = await run(
      ['plugins', 'config', 'builtin:herdr', '--unset', 'socketPath', '--json'],
      hub.url,
      dataDir,
    )
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(hub.hits[0]!.body, { values: { socketPath: null } })
    assert.deepEqual(lastBody, { values: { socketPath: null } })

    // 与 --set 组合：set 生效、unset 键为 null
    const r2 = await run(
      [
        'plugins', 'config', 'builtin:herdr',
        '--set', 'retries=5',
        '--unset', 'socketPath',
        '--unset', 'verbose',
        '--json',
      ],
      hub.url,
      dataDir,
    )
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(hub.hits[1]!.body, { values: { retries: 5, socketPath: null, verbose: null } })
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins config：--set 与 --unset 同 key 冲突报 conflicting_flags', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'PUT /api/plugins/builtin%3Aherdr/config': () => ({ body: { ok: true } }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const r = await run(
      ['plugins', 'config', 'builtin:herdr', '--set', 'verbose=true', '--unset', 'verbose', '--json'],
      hub.url,
      dataDir,
    )
    assert.equal(r.code, 1)
    const envelope = JSON.parse(r.err) as { error: { code: string; message: string } }
    assert.equal(envelope.error.code, 'conflicting_flags')
    assert.ok(envelope.error.message.includes('verbose'))
    // 冲突时不得发出 PUT 请求
    assert.equal(hub.hits.length, 0)
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins config --unset：空串与含 = 的键名拒绝（invalid_flag_value）', { timeout: 60_000 }, async () => {
  const hub = await startHub({})
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const bad = await run(['plugins', 'config', 'p1', '--unset', 'a=b', '--json'], hub.url, dataDir)
    assert.equal(bad.code, 1)
    assert.equal((JSON.parse(bad.err) as { error: { code: string } }).error.code, 'invalid_flag_value')
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins list：透传含 status/error 的 PluginSummary', { timeout: 60_000 }, async () => {
  const summary = [
    {
      id: 'builtin:profile',
      name: '角色底座',
      locked: true,
      enabled: true,
      status: 'active',
      hooks: [],
      actions: [],
      tools: [],
    },
    {
      id: 'external:broken',
      name: '坏插件',
      locked: false,
      enabled: true,
      status: 'failed',
      error: { code: 'plugin_load_failed', message: '入口导出缺失', stage: 'load' },
      hooks: [],
      actions: [],
      tools: [],
    },
  ]
  const hub = await startHub({
    'GET /api/plugins': () => ({ body: summary }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-gov-')
  try {
    const r = await run(['plugins', 'list', '--json'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    assert.deepEqual(JSON.parse(r.out), summary)
    // 人类模式：表格渲染新字段不报错且包含状态与错误信息
    const rh = await run(['plugins', 'list'], hub.url, dataDir)
    assert.equal(rh.code, 0, rh.err)
    assert.ok(rh.out.includes('failed'))
    assert.ok(rh.out.includes('plugin_load_failed'))
  } finally {
    await hub.close()
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})
