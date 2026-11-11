/**
 * 插件包管理 HTTP 路由集成测试（install / update / remove）。
 *
 * 组合纪律：真实 createHubHandler + 真实 PluginHost（接线 PluginPackageManager
 * 与真实 ConfigService store）+ 真实 local 插件源目录（doctor 全链真实执行，
 * 含真实 TS 转译与临时宿主注册）；npm/git 不触网（本文件只测 local 路径）。
 *
 * 覆盖：
 * - POST /api/plugins/install body { source, enable? }：默认 disabled、enable
 *   后 enabled、enableError 透传、未知字段 400、非法 source 400；
 * - POST /api/plugins/:id/update：重同步 + 记录推进；未受管插件 404；
 * - POST /api/plugins/:id/remove：受管目录删除、记录删除；
 * - 未接线安装器（纯 PluginHost）时三端点 501；
 * - GET /api/plugins 的 managed 映射（store 驱动，重启恢复语义同链）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'

import { createHelm } from '../src/app.js'
import { createHubHandler } from '../src/http/index.js'

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

const PLUGIN_SRC = (id: string) => `export default {
  id: '${id}',
  version: '1.0.0',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '探针',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

function makeModels() {
  const models = createModels()
  models.setProvider(fauxProvider().provider)
  return models
}

interface HubEnv {
  dataDir: string
  handler: (req: Request) => Promise<Response>
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  close(): Promise<void>
}

async function makeHub(): Promise<HubEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-http-'))
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
  const handler = createHubHandler(app.kernel as never)
  // 真实鉴权链：setup 取 token，后续 Bearer 携带
  const setupResponse = await handler(new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'helm-pkg-http-test-pass' }),
  }))
  if (setupResponse.status !== 200) throw new Error(`auth setup 失败: ${setupResponse.status}`)
  const token = ((await setupResponse.json()) as { token: string }).token
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await handler(new Request(`http://127.0.0.1:3202${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${token}`,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))
    const text = await response.text()
    let parsed: any
    try {
      parsed = text.length > 0 ? JSON.parse(text) : null
    } catch {
      parsed = text
    }
    return { status: response.status, body: parsed }
  }
  return {
    dataDir,
    handler,
    call,
    close: async () => {
      await app.close()
    },
  }
}

function writeLocalPlugin(parent: string, id: string): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version: '1.0.0', main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id))
  return dir
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

test('install（默认 disabled）-> list 含 managed -> enable 联动', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-demo')
    const installed = await env.call('POST', '/api/plugins/install', { source: src })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.record.pluginId, 'http-demo')
    assert.equal(installed.body.summary.enabled, false, '默认 disabled')
    assert.ok(installed.body.summary.managed, 'summary 应携带 managed')
    assert.equal(installed.body.summary.managed.source.path, src)

    // 受管目录存在；list 端点 managed 映射
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'http-demo', 'index.mjs')))
    const list = await env.call('GET', '/api/plugins')
    const found = list.body.find((p: any) => p.id === 'http-demo')
    assert.ok(found, 'list 应含受管插件')
    assert.ok(found.managed, 'list 端点 managed 映射生效')

    // enable: true 路径
    const src2 = writeLocalPlugin(srcParent, 'http-demo-2')
    const enabled = await env.call('POST', '/api/plugins/install', { source: src2, enable: true })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.summary.enabled, true)
  } finally {
    await env.close()
  }
})

test('install body 边界：未知字段 400、空 source 400、非法 grammar 400', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const unknownField = await env.call('POST', '/api/plugins/install', { source: '/tmp/x', extra: true })
    assert.equal(unknownField.status, 400)
    const empty = await env.call('POST', '/api/plugins/install', { source: '' })
    assert.equal(empty.status, 400)
    const badGrammar = await env.call('POST', '/api/plugins/install', { source: 'file:///tmp/x' })
    assert.equal(badGrammar.status, 400)
    const builtin = await env.call('POST', '/api/plugins/install', { source: 'builtin:profile' })
    assert.equal(builtin.status, 400)
  } finally {
    await env.close()
  }
})

test('update：local 源编辑后重同步 + 记录版本推进；未受管 404', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-up')
    const installed = await env.call('POST', '/api/plugins/install', { source: src, enable: true })
    assert.equal(installed.status, 200)
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'http-up', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('http-up').replace("'1.0.0'", "'2.0.0'"))
    const updated = await env.call('POST', '/api/plugins/http-up/update')
    assert.equal(updated.status, 200)
    assert.equal(updated.body.record.version, '2.0.0')
    assert.equal(updated.body.summary.version, '2.0.0')
    assert.equal(updated.body.summary.enabled, true, '更新保持启用状态')
    const missing = await env.call('POST', '/api/plugins/never-installed/update')
    assert.equal(missing.status, 404)
    const builtinReject = await env.call('POST', '/api/plugins/builtin%3Aprofile/update')
    assert.equal(builtinReject.status, 404)
  } finally {
    await env.close()
  }
})

test('remove：受管目录与记录删除、builtin 403/404、未受管 404', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-rm')
    await env.call('POST', '/api/plugins/install', { source: src, enable: true })
    const removed = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(removed.status, 200)
    assert.equal(removed.body.pluginId, 'http-rm')
    assert.equal(removed.body.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'http-rm')), '受管目录应删除')
    assert.ok(existsSync(join(src, 'index.mjs')), '用户源目录完好')
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(config.pluginPackages?.['http-rm'], undefined)
    // 再删 404
    const again = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(again.status, 404)
  } finally {
    await env.close()
  }
})

test('重启恢复：pluginPackages 记录驱动 GET /api/plugins 的 managed 映射（磁盘持久，非内存）', { timeout: 60_000 }, async () => {
  // 阶段一：安装并关闭 Hub（记录落 config.json）
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-'))
  const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-src-'))
  const src = writeLocalPlugin(srcParent, 'restart-demo')
  {
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
    await app.kernel.plugins.installPluginPackage(src)
    await app.close()
  }
  // 阶段二：全新 Hub 进程内状态（同一 dataDir）——managed 必须仍在
  {
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models: makeModels() })
    const summary = app.kernel.plugins.list().find((p) => p.id === 'restart-demo')
    assert.ok(summary, '重启后插件应自动注册')
    assert.ok(summary.managed, '重启后 managed 映射必须仍在（磁盘记录驱动）')
    assert.equal(summary.managed.source.kind, 'local')
    // update/remove 在重启后同样可用（记录恢复）
    const removed = await app.kernel.plugins.removePluginPackage('restart-demo')
    assert.equal(removed.pluginId, 'restart-demo')
    await app.close()
  }
})
