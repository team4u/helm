/**
 * Dedicated tests for helmx-hub production static hosting (packages/web/dist).
 *
 * Covers: path / and index.html, hashed /assets/* files (Content-Type and immutable cache),
 * SPA client-side routing fallback (extensionless paths return index.html), 404 for missing
 * files with extensions, '..' traversal blocking and symlink escape rejection, body stripping
 * for HEAD inside Response layer (preserving content-length), disabling via webDistDir: false,
 * real IO faults (EACCES/ELOOP) never disguised as 404, JSON 404 preserved for unknown /api/* routes,
 * and startHub(port: 0) production integration (explicit dir / disabled / missing dir startup error).
 *
 * Runner: tsx --test; every case has explicit timeout: 60_000 against deadlocks.
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubHandler, startHub, type HubHandlerOptions } from '../src/http/index.js'
import { createHubHandler as createHandlerLegacy } from '../src/http/index.js'
import type { KernelRuntimeLike, EventHub } from '../src/http/index.js'
import { AuthService } from '../src/services/index.js'
import { HelmxError } from '@helmx/protocol'

// ---------------------------------------------------------------------------
// Test fixture (minimal kernel shape + real AuthService)
// ---------------------------------------------------------------------------

class TestEventHub implements EventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

function makeKernel(dataDir: string): KernelRuntimeLike {
  return {
    dataDir,
    auth: new AuthService(dataDir),
    events: new TestEventHub(),
    profiles: undefined as never,
    skills: undefined as never,
    credentials: undefined as never,
    providers: undefined as never,
    artifacts: undefined as never,
    plugins: undefined as never,
    listConversations: async () => [],
    getConversationDetail: async () => {
      throw new Error('unused')
    },
    getConversationEntry: async () => {
      throw new Error('unused')
    },
    createConversation: async () => {
      throw new Error('unused')
    },
    updateConversation: async () => {
      throw new Error('unused')
    },
    deleteConversation: async () => {},
    submitInput: async () => {
      throw new Error('unused')
    },
    waitForInput: async () => {
      throw new Error('unused')
    },
    abortConversation: async () => {},
    resetConversation: async () => {
      throw new Error('unused')
    },
    compactConversation: async () => {
      throw new Error('unused')
    },
    forkConversation: async () => {
      throw new Error('unused')
    },
    listAsks: async () => [],
    answerAsk: async () => {},
    cancelAsk: async () => {},
    search: async () => [],
    listModels: () => ({ models: [], thinkingLevels: {} }),
    listModelProviders: () => [],
    listNodes: () => [],
    issueNodeToken: () => ({ nodeId: 'local', token: 'local:t', createdAt: 1 }),
    removeNode: async () => {},
    execEnv: async () => ({ ok: true, exitCode: 0, output: '', timedOut: false }),
  }
}

const BASE = 'http://127.0.0.1:3202'

async function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
): Promise<{ status: number; text: string; headers: Headers }> {
  const res = await handler(new Request(`${BASE}${path}`, { method }))
  return { status: res.status, text: await res.text(), headers: res.headers }
}

let dataDir: string
let webDist: string
let handler: (req: Request) => Promise<Response>
let token: string | undefined

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helmx-static-'))
  webDist = join(dataDir, 'web-dist')
  await mkdir(join(webDist, 'assets'), { recursive: true })
  await writeFile(join(webDist, 'index.html'), '<!doctype html><html><body>helmx web</body></html>')
  await writeFile(join(webDist, 'assets', 'app-B1b2C3.js'), 'console.log("app")')
  await writeFile(join(webDist, 'assets', 'style-D4e5F6.css'), 'body{margin:0}')
  await writeFile(join(webDist, 'favicon.ico'), Buffer.from([0, 0, 1, 0]))
  await writeFile(join(webDist, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  handler = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: webDist })
  // Complete setup once (AuthService state is persisted in dataDir; repeating setup returns 409)
  token = (await new AuthService(dataDir).setup('static-test-password')).token
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Core static serving
// ---------------------------------------------------------------------------

test('path / returns index.html (text/html + no-cache)', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.ok(res.text.includes('helmx web'))
})

test('HEAD / strips body in Response layer: identical status code and headers (includes content-length)', { timeout: 60_000 }, async () => {
  const res = await handler(new Request(`${BASE}/`, { method: 'HEAD' }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  const len = res.headers.get('content-length')
  assert.ok(len !== null && Number(len) > 0, `HEAD should preserve GET content-length (actual ${len})`)
  // Body is already stripped at Web Standard handler level (without relying on Node layer discarding it)
  assert.ok(res.body === null || (await res.text()) === '')
})

test('hashed static assets: proper Content-Type and immutable long-lived cache', { timeout: 60_000 }, async () => {
  const js = await call(handler, 'GET', '/assets/app-B1b2C3.js')
  assert.equal(js.status, 200)
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
  assert.equal(js.headers.get('cache-control'), 'public, max-age=31536000, immutable')
  assert.equal(js.text, 'console.log("app")')

  const css = await call(handler, 'GET', '/assets/style-D4e5F6.css')
  assert.equal(css.status, 200)
  assert.equal(css.headers.get('content-type'), 'text/css; charset=utf-8')
  assert.equal(css.headers.get('cache-control'), 'public, max-age=31536000, immutable')

  const ico = await call(handler, 'GET', '/favicon.ico')
  assert.equal(ico.status, 200)
  assert.equal(ico.headers.get('content-type'), 'image/x-icon')

  const svg = await call(handler, 'GET', '/logo.svg')
  assert.equal(svg.status, 200)
  assert.equal(svg.headers.get('content-type'), 'image/svg+xml')
})

test('SPA client route fallback: extensionless paths return index.html (200 text/html)', { timeout: 60_000 }, async () => {
  for (const path of ['/conversations/42', '/settings', '/plugins/builtin:superagent/recall-graph', '/some/deep/route']) {
    const res = await call(handler, 'GET', path)
    assert.equal(res.status, 200, `path ${path} should fall back to index.html`)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.ok(res.text.includes('helmx web'), `path ${path} should return index.html content`)
  }
})

test('missing file with extension: 404 (HTML fallback must not hide missing assets)', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/missing.js')
  assert.equal(res.status, 404)
  const css = await call(handler, 'GET', '/assets/not-built-aaa.css')
  assert.equal(css.status, 404)
})

test('.. traversal interception: requests resolving outside webDistDir return 404', { timeout: 60_000 }, async () => {
  // Node fetch Request normalizes ../ in URLs; test both encoded segments and explicit Request construction
  const encoded = await call(handler, 'GET', '/%2e%2e/config.json')
  assert.equal(encoded.status, 404)
  // Construct URL directly (preserving .. semantics) to test again
  const url = new URL(`${BASE}/../config.json`)
  const res = await handler(new Request(url, { method: 'GET' }))
  assert.ok(res.status === 404 || res.status === 400, `traversal request must be rejected (actual ${res.status})`)
  assert.ok(!res.headers.get('content-type')?.includes('json'))
})

test('symlink escape rejected: symlink inside webDistDir pointing outside returns 404', { timeout: 60_000 }, async () => {
  const secretFile = join(dataDir, 'secret.json')
  await writeFile(secretFile, '{"secret":true}')
  await symlink(secretFile, join(webDist, 'leaked.json'))
  try {
    const res = await call(handler, 'GET', '/leaked.json')
    assert.equal(res.status, 404)
    assert.ok(!res.text.includes('secret'))
  } finally {
    await rm(join(webDist, 'leaked.json'), { force: true })
  }
})

test('extensionless out-of-bounds symlink cannot fake SPA success: still 404, no index.html fallback', { timeout: 60_000 }, async () => {
  const secretFile = join(dataDir, 'secret2.json')
  await writeFile(secretFile, '{"secret":true}')
  await symlink(secretFile, join(webDist, 'leaked-noext'))
  try {
    const res = await call(handler, 'GET', '/leaked-noext')
    assert.equal(res.status, 404, 'out-of-bounds target must return 404, never fake success via SPA fallback')
    assert.ok(!res.text.includes('secret'))
  } finally {
    await rm(join(webDist, 'leaked-noext'), { force: true })
  }
})

test('root path is a file (not directory): explicitly specifying webDistDir reports web_dist_invalid', { timeout: 60_000 }, async () => {
  const filePath = join(dataDir, 'not-a-dir')
  await writeFile(filePath, 'x')
  const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: filePath })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  const body = JSON.parse(res.text) as { error: { code: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
})

test('real IO failure (ELOOP) returns explicit 500, never disguised as 404 (applies even as root)', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helmx-static-eloop-'))
  try {
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'x')
    const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: root })
    // Self-referential symlink loop: realpath throws ELOOP (real IO fault, not missing), reproducible even as root/win
    await symlink(join(root, 'assets', 'loop.js'), join(root, 'assets', 'loop.js'))
    const res = await call(handler2, 'GET', '/assets/loop.js')
    assert.equal(res.status, 500, 'ELOOP must return explicit 500 (only missing files return 404)')
    const body = JSON.parse(res.text) as { error: { code: string } }
    assert.equal(body.error.code, 'internal_error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('unknown /api route still returns JSON 404 not_found (static hosting must not swallow API namespace)', { timeout: 60_000 }, async () => {
  assert.ok(token, 'setup should have completed auth')
  const res = await handler(
    new Request(`${BASE}/api/unknown-endpoint`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  )
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(await res.text()) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

test('exact /api path (no trailing segment) also routes through API router', { timeout: 60_000 }, async () => {
  assert.ok(token)
  const res = await handler(
    new Request(`${BASE}/api`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  )
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(await res.text()) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

// ---------------------------------------------------------------------------
// Toggles and compatibility
// ---------------------------------------------------------------------------

test('webDistDir: false disables static hosting (non-/api returns JSON 404)', { timeout: 60_000 }, async () => {
  const disabled = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: false })
  const res = await call(disabled, 'GET', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const asset = await call(disabled, 'GET', '/assets/app-B1b2C3.js')
  assert.equal(asset.status, 404)
})

test('webDistDir pointing to missing directory: explicit diagnostic web_dist_invalid (never silently disabled)', { timeout: 60_000 }, async () => {
  const handler2 = createHubHandler({
    kernel: makeKernel(dataDir),
    webDistDir: join(dataDir, 'no-such-dist'),
  })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(res.text) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
  assert.ok(body.error.message.includes('no-such-dist'), 'diagnostic should contain concrete directory path')
})

test('single-arg invocation (kernel): disables static hosting by default (pure API, no default directory probing)', { timeout: 60_000 }, async () => {
  const legacy = createHandlerLegacy(makeKernel(dataDir))
  // Kernel performs no default directory probing (web dir is a hub product policy): regardless of any sibling web dist,
  // non-/api always returns JSON 404; embedded Kernel HTTP defaults never vary by environment.
  const res = await call(legacy, 'GET', '/not-a-real-dist-check')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('non-GET/HEAD method (POST /) bypasses static hosting and returns JSON 404', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'POST', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

// ---------------------------------------------------------------------------
// startHub (production node layer) integration: webDistDir pass-through
// ---------------------------------------------------------------------------

test('startHub(port:0) with explicit webDistDir: real HTTP static delivery + HEAD without body', { timeout: 60_000 }, async () => {
  const hub = await startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: webDist })
  try {
    const res = await fetch(`${hub.url}/assets/app-B1b2C3.js`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await res.text(), 'console.log("app")')

    const head = await fetch(`${hub.url}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    const len = head.headers.get('content-length')
    assert.ok(len !== null && Number(len) > 0, `production HEAD should preserve content-length (actual ${len})`)
    assert.equal(await head.text(), '', 'production HEAD returns empty body')

    const spa = await fetch(`${hub.url}/conversations/42`)
    assert.equal(spa.status, 200)
    assert.ok((await spa.text()).includes('helmx web'))
  } finally {
    await hub.close()
  }
})

test('startHub(port:0) with webDistDir: false: static hosting disabled, non-/api returns JSON 404', { timeout: 60_000 }, async () => {
  const hub = await startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: false })
  try {
    const res = await fetch(`${hub.url}/`)
    assert.equal(res.status, 404)
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
    const asset = await fetch(`${hub.url}/assets/app-B1b2C3.js`)
    assert.equal(asset.status, 404)
  } finally {
    await hub.close()
  }
})

test('startHub(port:0) with explicit nonexistent directory: startup fails explicitly (never silently disabled)', { timeout: 60_000 }, async () => {
  await assert.rejects(
    startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: join(dataDir, 'no-such-dist') }),
    (err: unknown) => err instanceof HelmxError && err.code === 'web_dist_invalid',
  )
})

// ---------------------------------------------------------------------------
// static gzip
// ---------------------------------------------------------------------------

test('static text asset gzip: compresses above threshold, valid Vary/Content-Length, hits cache, skips PNG', { timeout: 60_000 }, async () => {
  const bigJs = `console.log(${JSON.stringify('v'.repeat(4096))});\n`
  await writeFile(join(webDist, 'assets', 'big-A1b2.js'), bigJs)
  const smallJs = 'console.log(1)\n'
  await writeFile(join(webDist, 'assets', 'small-B2c3.js'), smallJs)
  await writeFile(join(webDist, 'assets', 'img-C3d4.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(2048).fill(1)]))

  const authed = (path: string, headers: Record<string, string> = {}): Request =>
    new Request(`${BASE}${path}`, {
      headers: { ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}), ...headers },
    })

  // >1KiB text + Accept-Encoding: gzip -> compressed, round-trips cleanly
  const gzReq = authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip', origin: 'http://x' })
  const gzRes = await handler(gzReq)
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip')
  const vary = (gzRes.headers.get('vary') ?? '').toLowerCase().split(',').map((token) => token.trim())
  assert.ok(vary.includes('accept-encoding'), `static compression must preserve Accept-Encoding: ${vary}`)
  assert.ok(vary.includes('origin'), `CORS must not overwrite Vary compression negotiation: ${vary}`)
  const gzBytes = new Uint8Array(await gzRes.arrayBuffer())
  assert.equal(Number(gzRes.headers.get('content-length')), gzBytes.byteLength)
  assert.equal(gunzipSync(gzBytes).toString('utf8'), bigJs, 'decompressed bytes match original text')

  // Second request hits cache (identical output)
  const gzAgain = await handler(authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip' }))
  assert.equal(gzAgain.headers.get('content-encoding'), 'gzip')
  assert.equal(gunzipSync(new Uint8Array(await gzAgain.arrayBuffer())).toString('utf8'), bigJs, 'cache hit output matches original')

  // <1KiB text stays uncompressed; client without Accept-Encoding: gzip gets identity
  const small = await handler(authed('/assets/small-B2c3.js', { 'accept-encoding': 'gzip' }))
  assert.equal(small.headers.get('content-encoding'), null)
  await small.text()
  const identity = await handler(authed('/assets/big-A1b2.js'))
  assert.equal(identity.headers.get('content-encoding'), null)
  assert.equal(await identity.text(), bigJs)

  // PNG (incompressible format) stays uncompressed
  const png = await handler(authed('/assets/img-C3d4.png', { 'accept-encoding': 'gzip' }))
  assert.equal(png.headers.get('content-encoding'), null)
  assert.equal(Number(png.headers.get('content-length')), 2052)
  await png.arrayBuffer()

  // HEAD and GET share compression headers with empty body
  const head = await handler(new Request(`${BASE}/assets/big-A1b2.js`, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }))
  assert.equal(head.headers.get('content-encoding'), 'gzip')
  assert.ok(head.body === null || (await head.text()) === '')
})
