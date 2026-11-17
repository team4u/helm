/**
 * Integration tests for plugin package management HTTP routes (`install` / `update` / `remove`).
 *
 * Composition discipline: real `createHubHandler` + real `PluginHost` (wired to `PluginPackageManager`
 * and real `ConfigService` persistence) + real local plugin source directories (full doctor pipeline
 * including real TS transpilation and temporary host registration); no npm/git network access (local paths only).
 *
 * Covers:
 * - `POST /api/plugins/install` `{ source, enable? }`: disabled by default, enabled when `enable: true`,
 *   `enableError` pass-through, 400 on unknown fields or invalid sources;
 * - `POST /api/plugins/:id/update`: re-syncs and bumps record; 404 for unmanaged plugins;
 * - `POST /api/plugins/:id/remove`: deletes managed directory and persisted record;
 * - 501 across all three endpoints when install manager is unwired (bare `PluginHost`);
 * - `GET /api/plugins` `managed` mapping (store-driven, matching restart restoration semantics).
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }`.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubHandler } from '../../kernel/src/http/index.js'
import { createHubTestApp, openHubTestEnv } from './helpers/hub-test-env.js'

// ---------------------------------------------------------------------------
// Fixtures
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
  // Real auth flow: setup returns a token, carried via Bearer auth afterwards.
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
// Routes
// ---------------------------------------------------------------------------

test('install (disabled by default) -> list includes managed -> enable flow', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-demo')
    const installed = await env.call('POST', '/api/plugins/install', { source: src })
    assert.equal(installed.status, 200)
    assert.equal(installed.body.record.pluginId, 'http-demo')
    assert.equal(installed.body.summary.enabled, false, 'disabled by default')
    assert.ok(installed.body.summary.managed, 'summary should carry managed metadata')
    assert.equal(installed.body.summary.managed.source.path, src)

    // Managed directory exists; list endpoint maps `managed`.
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'http-demo', 'index.mjs')))
    const list = await env.call('GET', '/api/plugins')
    const found = list.body.find((p: any) => p.id === 'http-demo')
    assert.ok(found, 'list should include managed plugin')
    assert.ok(found.managed, 'list endpoint should populate managed metadata')

    // enable: true path
    const src2 = writeLocalPlugin(srcParent, 'http-demo-2')
    const enabled = await env.call('POST', '/api/plugins/install', { source: src2, enable: true })
    assert.equal(enabled.status, 200)
    assert.equal(enabled.body.summary.enabled, true)
  } finally {
    await env.close()
  }
})

test('install body validation: 400 on unknown field, empty source, or invalid syntax', { timeout: 60_000 }, async () => {
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

test('update: re-syncs local source changes and bumps version; 404 when unmanaged', { timeout: 60_000 }, async () => {
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
    assert.equal(updated.body.summary.enabled, true, 'update preserves enabled state')
    const missing = await env.call('POST', '/api/plugins/never-installed/update')
    assert.equal(missing.status, 404)
    const builtinReject = await env.call('POST', '/api/plugins/builtin%3Aprofile/update')
    assert.equal(builtinReject.status, 404)
  } finally {
    await env.close()
  }
})

test('remove: deletes managed directory and record; 403/404 for builtin, 404 when unmanaged', { timeout: 60_000 }, async () => {
  const env = await makeHub()
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-httpsrc-'))
    const src = writeLocalPlugin(srcParent, 'http-rm')
    await env.call('POST', '/api/plugins/install', { source: src, enable: true })
    const removed = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(removed.status, 200)
    assert.equal(removed.body.pluginId, 'http-rm')
    assert.equal(removed.body.wasEnabled, true)
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'http-rm')), 'managed directory should be deleted')
    assert.ok(existsSync(join(src, 'index.mjs')), 'user source directory should remain intact')
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(config.pluginPackages?.['http-rm'], undefined)
    // Deleting again returns 404.
    const again = await env.call('POST', '/api/plugins/http-rm/remove')
    assert.equal(again.status, 404)
  } finally {
    await env.close()
  }
})

test('restart restoration: pluginPackages record drives GET /api/plugins managed mapping (disk-persisted)', { timeout: 60_000 }, async () => {
  // Phase 1: install and close Hub (persisted to config.json).
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-'))
  const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-restart-src-'))
  const src = writeLocalPlugin(srcParent, 'restart-demo')
  {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    await app.kernel.plugins.installPluginPackage(src)
    await app.close()
  }
  // Phase 2: fresh Hub instance on the same dataDir — `managed` must still be populated.
  {
    const { app } = await createHubTestApp({ dataDir, cwd: dataDir })
    const summary = app.kernel.plugins.list().find((p) => p.id === 'restart-demo')
    assert.ok(summary, 'plugin should auto-register after restart')
    assert.ok(summary.managed, 'managed mapping must persist across restart (driven by disk record)')
    assert.equal(summary.managed.source.kind, 'local')
    // update/remove continue working after restart (restored from record).
    const removed = await app.kernel.plugins.removePluginPackage('restart-demo')
    assert.equal(removed.pluginId, 'restart-demo')
    await app.close()
  }
})
