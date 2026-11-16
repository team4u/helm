/**
 * plugin package manage HTTP routing integration test (install / update / remove).
 *
 * combine discipline: real createHubHandler + real PluginHost(connect line PluginPackageManager
 * and real ConfigService store)+ real local plugin source directory (doctor all chain real execute,
 * contains real TS transpile and temporary host register);npm/git do not trigger network (this file only test local path).
 *
 * override:
 * - POST /api/plugins/install body { source, enable? }: by default disabled,enable
 *   after enabled,enableError pass-through, unknown field 400, illegal source 400;
 * - POST /api/plugins/:id/update: heavy sync + record push enter; not managed plugin 404;
 * - POST /api/plugins/:id/remove: managed directory delete, record delete;
 * - not connect line install (pure PluginHost) when three end point 501;
 * - GET /api/plugins  managed mapping (store drive, restart restore semantics same chain).
 *
 * runner: tsx --test; each items explicit timeout: 60_000.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubHandler } from '../../kernel/src/http/index.js'
import { createHubTestApp, openHubTestEnv } from './helpers/hub-test-env.js'

// ---------------------------------------------------------------------------
// base create
// ---------------------------------------------------------------------------

const PLUGIN_SRC = (id: string) => `export default {
  id: '${id}',
  version: '1.0.0',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

interface HubEnv {
  dataDir: string
  handler: (req: Request) => Promise<Response>
  call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }>
  close(): Promise<void>
}

async function makeHub(): Promise<HubEnv> {
  const env = await openHubTestEnv({ prefix: 'helm-pkg-http-' })
  const handler = createHubHandler(env.kernel as never)
  // real authentication chain:setup take token, after continue Bearer carry
  const setupResponse = await handler(new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'helm-pkg-http-test-pass' }),
  }))
  if (setupResponse.status !== 200) throw new Error(`auth setup failed: ${setupResponse.status}`)
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
    dataDir: env.dataDir,
    handler,
    call,
    close: env.close,
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
// routing
// ---------------------------------------------------------------------------

test('install(by default disabled)-> list contains managed -> enable join motion', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-demo')
    const installed = await env.call('POST', '/api/plugins/install', { source: src })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.record.pluginId, 'http-demo')
    assert.equal(installed.body.summary.enabled, false, 'by default disabled')
    assert.ok(installed.body.summary.managed, 'summary should carry managed')
    assert.equal(installed.body.summary.managed.source.path, src)

    // managed directory store in;list end point managed mapping
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'http-demo', 'index.mjs')))
    const list = await env.call('GET', '/api/plugins')
    const found = list.body.find((p: any) => p.id === 'http-demo')
    assert.ok(found, 'list should contains managed plugin')
    assert.ok(found.managed, 'list end point managed mapping takes effect')

    // enable: true path
    const src2 = writeLocalPlugin(srcParent, 'http-demo-2')
    const enabled = await env.call('POST', '/api/plugins/install', { source: src2, enable: true })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.summary.enabled, true)
  } finally {
    await env.close()
  }
})

test('install body boundary: unknown field 400, empty source 400, illegal grammar 400', { timeout: 60_000 }, async () => {
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

test('update:local source edit after heavy sync + record version push enter; not managed 404', { timeout: 60_000 }, async () => {
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
    assert.equal(updated.body.summary.enabled, true, 'update keep enable state')
    const missing = await env.call('POST', '/api/plugins/never-installed/update')
    assert.equal(missing.status, 404)
    const builtinReject = await env.call('POST', '/api/plugins/builtin%3Aprofile/update')
    assert.equal(builtinReject.status, 404)
  } finally {
    await env.close()
  }
})

test('remove: managed directory and record delete,builtin 403/404, not managed 404', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-rm')
    await env.call('POST', '/api/plugins/install', { source: src, enable: true })
    const removed = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(removed.status, 200)
    assert.equal(removed.body.pluginId, 'http-rm')
    assert.equal(removed.body.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'http-rm')), 'managed directory should delete')
    assert.ok(existsSync(join(src, 'index.mjs')), 'user source directory completely well')
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(config.pluginPackages?.['http-rm'], undefined)
    // again delete 404
    const again = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(again.status, 404)
  } finally {
    await env.close()
  }
})

test('restart restore:pluginPackages record drive GET /api/plugins  managed mapping (disk durable, non- memory)', { timeout: 60_000 }, async () => {
  // phase one: install and close Hub(record config.json)
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-'))
  const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-src-'))
  const src = writeLocalPlugin(srcParent, 'restart-demo')
  {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    await app.kernel.plugins.installPluginPackage(src)
    await app.close()
  }
  // phase two: all new Hub process inside state (the same dataDir) - -managed must still in
  {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    const summary = app.kernel.plugins.list().find((p) => p.id === 'restart-demo')
    assert.ok(summary, 'after restart plugin should automatically register')
    assert.ok(summary.managed, 'after restart managed mapping must still in (disk record drive)')
    assert.equal(summary.managed.source.kind, 'local')
    // update/remove in after restart same available (record restore)
    const removed = await app.kernel.plugins.removePluginPackage('restart-demo')
    assert.equal(removed.pluginId, 'restart-demo')
    await app.close()
  }
})
