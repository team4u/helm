/**
 * helm-hub produce static hosting (packages/web/dist) dedicated items test.
 *
 * override: path / and index.html,/assets/* carries hash asset (Content-Type and
 * immutable cache),SPA frontend routing fall back (without extension path back index.html),
 * carries extension missing file 404,.. path through exceeds intercept and symlink escape reject,
 * HEAD in Response layer side remove body(keep content-length),webDistDir: false
 * disable, real IO fault (EACCES) does not pretend to be 404,/api/* unknown routing still JSON 404,
 * startHub(port:0) produce collection into (explicit directory / disable / expires directory start errors).
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
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
import { HelmError } from '@helm/protocol'

// ---------------------------------------------------------------------------
// test base seat (most small kernel shape + real AuthService)
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
  dataDir = await mkdtemp(join(tmpdir(), 'helm-static-'))
  webDist = join(dataDir, 'web-dist')
  await mkdir(join(webDist, 'assets'), { recursive: true })
  await writeFile(join(webDist, 'index.html'), '<!doctype html><html><body>helm web</body></html>')
  await writeFile(join(webDist, 'assets', 'app-B1b2C3.js'), 'console.log("app")')
  await writeFile(join(webDist, 'assets', 'style-D4e5F6.css'), 'body{margin:0}')
  await writeFile(join(webDist, 'favicon.ico'), Buffer.from([0, 0, 1, 0]))
  await writeFile(join(webDist, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  handler = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: webDist })
  // setup once complete (AuthService state durable in dataDir inside, duplicate setup will 409)
  token = (await new AuthService(dataDir).setup('static-test-password')).token
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// basis service
// ---------------------------------------------------------------------------

test('path / return index.html(text/html + no-cache)', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.ok(res.text.includes('helm web'))
})

test('HEAD / in Response layer side remove body: same status code and response head (contains content-length)', { timeout: 60_000 }, async () => {
  const res = await handler(new Request(`${BASE}/`, { method: 'HEAD' }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  const len = res.headers.get('content-length')
  assert.ok(len !== null && Number(len) > 0, `HEAD should keep GET length (actual ${len})`)
  // body in Web Standard handler layer side already remove (independent of node layer discard)
  assert.ok(res.body === null || (await res.text()) === '')
})

test('carries hash static assets: correct Content-Type and immutable long cache', { timeout: 60_000 }, async () => {
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

test('SPA frontend routing fall back: without extension path back index.html(200 text/html)', { timeout: 60_000 }, async () => {
  for (const path of ['/conversations/42', '/settings', '/plugins/builtin:superagent/recall-graph', '/some/deep/route']) {
    const res = await call(handler, 'GET', path)
    assert.equal(res.status, 200, `path ${path} should fall back index.html`)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.ok(res.text.includes('helm web'), `path ${path} should back index.html content`)
  }
})

test('carries extension but file missing:404(HTML fall back will mask true missing)', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/missing.js')
  assert.equal(res.status, 404)
  const css = await call(handler, 'GET', '/assets/not-built-aaa.css')
  assert.equal(css.status, 404)
})

test('.. path through exceeds intercept:resolve after exceeds out webDistDir request 404', { timeout: 60_000 }, async () => {
  // Node fetch Request will archive one URL in ../; use encode segment and explicit construct double manage complete under
  const encoded = await call(handler, 'GET', '/%2e%2e/config.json')
  assert.equal(encoded.status, 404)
  // directly construct URL object (keep .. semantics) again request
  const url = new URL(`${BASE}/../config.json`)
  const res = await handler(new Request(url, { method: 'GET' }))
  assert.ok(res.status === 404 || res.status === 400, `through exceeds request must by refuse (actual ${res.status})`)
  assert.ok(!res.headers.get('content-type')?.includes('json'))
})

test('symlink escape reject:webDistDir inside symlink points to outside file 404', { timeout: 60_000 }, async () => {
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

test('without extension symlink out of bounds cannot disguise SPA succeeded: still 404, does not fall back index.html', { timeout: 60_000 }, async () => {
  const secretFile = join(dataDir, 'secret2.json')
  await writeFile(secretFile, '{"secret":true}')
  await symlink(secretFile, join(webDist, 'leaked-noext'))
  try {
    const res = await call(handler, 'GET', '/leaked-noext')
    assert.equal(res.status, 404, 'out of bounds target must 404, never with SPA fall back disguise succeeded')
    assert.ok(!res.text.includes('secret'))
  } finally {
    await rm(join(webDist, 'leaked-noext'), { force: true })
  }
})

test('root itself is file (non- directory):webDistDir explicit designate when report web_dist_invalid', { timeout: 60_000 }, async () => {
  const filePath = join(dataDir, 'not-a-dir')
  await writeFile(filePath, 'x')
  const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: filePath })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  const body = JSON.parse(res.text) as { error: { code: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
})

test('real IO fault (ELOOP) explicit 500, never disguise 404(root user same takes effect)', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-static-eloop-'))
  try {
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'x')
    const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: root })
    // self refer symlink ring:realpath throw ELOOP(real IO fault, non- missing),root/win all can trigger
    await symlink(join(root, 'assets', 'loop.js'), join(root, 'assets', 'loop.js'))
    const res = await call(handler2, 'GET', '/assets/loop.js')
    assert.equal(res.status, 500, 'ELOOP must explicit 500(missing only then 404)')
    const body = JSON.parse(res.text) as { error: { code: string } }
    assert.equal(body.error.code, 'internal_error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/api unknown routing still return JSON 404 not_found(static hosting do not swallow API naming empty between)', { timeout: 60_000 }, async () => {
  assert.ok(token, 'before phase should completed auth setup')
  const res = await handler(
    new Request(`${BASE}/api/unknown-endpoint`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  )
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(await res.text()) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

test('precise path /api(without tail segment) same away API routing logic', { timeout: 60_000 }, async () => {
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
// switch and compatibility
// ---------------------------------------------------------------------------

test('webDistDir: false disable static hosting (non- /api back JSON 404)', { timeout: 60_000 }, async () => {
  const disabled = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: false })
  const res = await call(disabled, 'GET', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const asset = await call(disabled, 'GET', '/assets/app-B1b2C3.js')
  assert.equal(asset.status, 404)
})

test('points to missing directory webDistDir: explicit diagnose web_dist_invalid(not silently disable)', { timeout: 60_000 }, async () => {
  const handler2 = createHubHandler({
    kernel: makeKernel(dataDir),
    webDistDir: join(dataDir, 'no-such-dist'),
  })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(res.text) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
  assert.ok(body.error.message.includes('no-such-dist'), 'diagnose should contain specific directory path')
})

test('single reference invoke form (kernel): default does not enable static hosting (pure API, do not probe any by default directory)', { timeout: 60_000 }, async () => {
  const legacy = createHandlerLegacy(makeKernel(dataDir))
  // kernel does not by default directory probe (Web directory is hub produce product policy): regardless of warehouse beside is otherwise store in web dist,
  // non- /api one rule JSON 404; embed style Kernel  HTTP by default behavior do not follow environment change.
  const res = await call(legacy, 'GET', '/not-a-real-dist-check')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('non- GET/HEAD method (POST /) does not enter static hosting, back JSON 404', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'POST', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

// ---------------------------------------------------------------------------
// startHub(produce node layer) collection into:webDistDir pass-through
// ---------------------------------------------------------------------------

test('startHub(port:0) explicit webDistDir: real HTTP static to return + HEAD without body', { timeout: 60_000 }, async () => {
  const hub = await startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: webDist })
  try {
    const res = await fetch(`${hub.url}/assets/app-B1b2C3.js`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await res.text(), 'console.log("app")')

    const head = await fetch(`${hub.url}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    const len = head.headers.get('content-length')
    assert.ok(len !== null && Number(len) > 0, `produce HEAD should keep content-length(actual ${len})`)
    assert.equal(await head.text(), '', 'produce HEAD do not back body')

    const spa = await fetch(`${hub.url}/conversations/42`)
    assert.equal(spa.status, 200)
    assert.ok((await spa.text()).includes('helm web'))
  } finally {
    await hub.close()
  }
})

test('startHub(port:0) webDistDir: false: static hosting disable, non- /api back JSON 404', { timeout: 60_000 }, async () => {
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

test('startHub(port:0) explicit expires directory: start explicit errors (not silently disable)', { timeout: 60_000 }, async () => {
  await assert.rejects(
    startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: join(dataDir, 'no-such-dist') }),
    (err: unknown) => err instanceof HelmError && err.code === 'web_dist_invalid',
  )
})

// ---------------------------------------------------------------------------
// static gzip
// ---------------------------------------------------------------------------

test('static text asset gzip: threshold inside compress,Vary/Content-Length correct, cache hit,PNG do not compress', { timeout: 60_000 }, async () => {
  const bigJs = `console.log(${JSON.stringify('v'.repeat(4096))});\n`
  await writeFile(join(webDist, 'assets', 'big-A1b2.js'), bigJs)
  const smallJs = 'console.log(1)\n'
  await writeFile(join(webDist, 'assets', 'small-B2c3.js'), smallJs)
  await writeFile(join(webDist, 'assets', 'img-C3d4.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(2048).fill(1)]))

  const authed = (path: string, headers: Record<string, string> = {}): Request =>
    new Request(`${BASE}${path}`, {
      headers: { ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}), ...headers },
    })

  // >1KiB text + Accept-Encoding: gzip → compress, decompress and original text consistent
  const gzReq = authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip', origin: 'http://x' })
  const gzRes = await handler(gzReq)
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip')
  const vary = (gzRes.headers.get('vary') ?? '').toLowerCase().split(',').map((token) => token.trim())
  assert.ok(vary.includes('accept-encoding'), `static compress must keep Accept-Encoding: ${vary}`)
  assert.ok(vary.includes('origin'), `CORS cannot override compress negotiate Vary: ${vary}`)
  const gzBytes = new Uint8Array(await gzRes.arrayBuffer())
  assert.equal(Number(gzRes.headers.get('content-length')), gzBytes.byteLength)
  assert.equal(gunzipSync(gzBytes).toString('utf8'), bigJs, 'decompress after and original text consistent')

  // second request away cache (result consistent)
  const gzAgain = await handler(authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip' }))
  assert.equal(gzAgain.headers.get('content-encoding'), 'gzip')
  assert.equal(gunzipSync(new Uint8Array(await gzAgain.arrayBuffer())).toString('utf8'), bigJs, 'cache hit result consistent')

  // <1KiB text do not compress; do not accept gzip client take identity
  const small = await handler(authed('/assets/small-B2c3.js', { 'accept-encoding': 'gzip' }))
  assert.equal(small.headers.get('content-encoding'), null)
  await small.text()
  const identity = await handler(authed('/assets/big-A1b2.js'))
  assert.equal(identity.headers.get('content-encoding'), null)
  assert.equal(await identity.text(), bigJs)

  // PNG(cannot compress format) do not compress
  const png = await handler(authed('/assets/img-C3d4.png', { 'accept-encoding': 'gzip' }))
  assert.equal(png.headers.get('content-encoding'), null)
  assert.equal(Number(png.headers.get('content-length')), 2052)
  await png.arrayBuffer()

  // HEAD and GET same compress head semantics,body is empty
  const head = await handler(new Request(`${BASE}/assets/big-A1b2.js`, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }))
  assert.equal(head.headers.get('content-encoding'), 'gzip')
  assert.ok(head.body === null || (await head.text()) === '')
})
