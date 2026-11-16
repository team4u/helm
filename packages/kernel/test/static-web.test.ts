/**
 * helm-hub 生产静态托管（packages/web/dist）专项测试。
 *
 * 覆盖：根路径 / 与 index.html、/assets/* 带 hash 资源（Content-Type 与
 * immutable 缓存）、SPA 前端路由回退（无扩展名路径回 index.html）、
 * 带扩展名缺失文件 404、.. 路径穿越拦截与符号链接逃逸拒绝、
 * HEAD 在 Response 层面去 body（保留 content-length）、webDistDir: false
 * 禁用、真实 IO 故障（EACCES）不伪装 404、/api/* 未知路由仍 JSON 404、
 * startHub(port:0) 生产集成（显式目录 / 禁用 / 失效目录启动报错）。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
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
// 测试基座（最小 kernel 形状 + 真实 AuthService）
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
  // setup 一次性完成（AuthService 状态持久在 dataDir 内，重复 setup 会 409）
  token = (await new AuthService(dataDir).setup('static-test-password')).token
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 基础服务
// ---------------------------------------------------------------------------

test('根路径 / 返回 index.html（text/html + no-cache）', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(res.headers.get('cache-control'), 'no-cache')
  assert.ok(res.text.includes('helm web'))
})

test('HEAD / 在 Response 层面去 body：同状态码与响应头（含 content-length）', { timeout: 60_000 }, async () => {
  const res = await handler(new Request(`${BASE}/`, { method: 'HEAD' }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
  const len = res.headers.get('content-length')
  assert.ok(len !== null && Number(len) > 0, `HEAD 应保留 GET 长度（实际 ${len}）`)
  // body 在 Web Standard handler 层面已移除（不依赖 node 层丢弃）
  assert.ok(res.body === null || (await res.text()) === '')
})

test('带 hash 静态资源：正确 Content-Type 与 immutable 长缓存', { timeout: 60_000 }, async () => {
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

test('SPA 前端路由回退：无扩展名路径回 index.html（200 text/html）', { timeout: 60_000 }, async () => {
  for (const path of ['/conversations/42', '/settings', '/plugins/builtin:superagent/recall-graph', '/some/deep/route']) {
    const res = await call(handler, 'GET', path)
    assert.equal(res.status, 200, `路径 ${path} 应回退 index.html`)
    assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.ok(res.text.includes('helm web'), `路径 ${path} 应回 index.html 内容`)
  }
})

test('带扩展名但文件不存在：404（HTML 回退会掩盖真缺失）', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'GET', '/missing.js')
  assert.equal(res.status, 404)
  const css = await call(handler, 'GET', '/assets/not-built-aaa.css')
  assert.equal(css.status, 404)
})

test('.. 路径穿越拦截：resolve 后越出 webDistDir 的请求 404', { timeout: 60_000 }, async () => {
  // Node fetch Request 会归一 URL 中的 ../；用编码段与显式构造双管齐下
  const encoded = await call(handler, 'GET', '/%2e%2e/config.json')
  assert.equal(encoded.status, 404)
  // 直接构造 URL 对象（保留 .. 语义）再发请求
  const url = new URL(`${BASE}/../config.json`)
  const res = await handler(new Request(url, { method: 'GET' }))
  assert.ok(res.status === 404 || res.status === 400, `穿越请求必须被拒（实际 ${res.status}）`)
  assert.ok(!res.headers.get('content-type')?.includes('json'))
})

test('符号链接逃逸拒绝：webDistDir 内软链指向根外文件 404', { timeout: 60_000 }, async () => {
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

test('无扩展名 symlink 越界不能伪装 SPA 成功：仍 404，不回退 index.html', { timeout: 60_000 }, async () => {
  const secretFile = join(dataDir, 'secret2.json')
  await writeFile(secretFile, '{"secret":true}')
  await symlink(secretFile, join(webDist, 'leaked-noext'))
  try {
    const res = await call(handler, 'GET', '/leaked-noext')
    assert.equal(res.status, 404, '越界目标必须 404，绝不以 SPA 回退伪装成功')
    assert.ok(!res.text.includes('secret'))
  } finally {
    await rm(join(webDist, 'leaked-noext'), { force: true })
  }
})

test('root 本身是文件（非目录）：webDistDir 显式指定时报 web_dist_invalid', { timeout: 60_000 }, async () => {
  const filePath = join(dataDir, 'not-a-dir')
  await writeFile(filePath, 'x')
  const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: filePath })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  const body = JSON.parse(res.text) as { error: { code: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
})

test('真实 IO 故障（ELOOP）显式 500，绝不伪装 404（root 用户同样生效）', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-static-eloop-'))
  try {
    await mkdir(join(root, 'assets'), { recursive: true })
    await writeFile(join(root, 'index.html'), 'x')
    const handler2 = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: root })
    // 自指 symlink 环：realpath 抛 ELOOP（真实 IO 故障，非缺失），root/win 均可触发
    await symlink(join(root, 'assets', 'loop.js'), join(root, 'assets', 'loop.js'))
    const res = await call(handler2, 'GET', '/assets/loop.js')
    assert.equal(res.status, 500, 'ELOOP 必须显式 500（缺失才 404）')
    const body = JSON.parse(res.text) as { error: { code: string } }
    assert.equal(body.error.code, 'internal_error')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('/api 未知路由仍返回 JSON 404 not_found（静态托管不吞 API 命名空间）', { timeout: 60_000 }, async () => {
  assert.ok(token, 'before 阶段应已完成 auth setup')
  const res = await handler(
    new Request(`${BASE}/api/unknown-endpoint`, { method: 'GET', headers: { authorization: `Bearer ${token}` } }),
  )
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(await res.text()) as { error: { code: string } }
  assert.equal(body.error.code, 'not_found')
})

test('精确路径 /api（无尾段）同样走 API 路由逻辑', { timeout: 60_000 }, async () => {
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
// 开关与兼容
// ---------------------------------------------------------------------------

test('webDistDir: false 禁用静态托管（非 /api 回落 JSON 404）', { timeout: 60_000 }, async () => {
  const disabled = createHubHandler({ kernel: makeKernel(dataDir), webDistDir: false })
  const res = await call(disabled, 'GET', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const asset = await call(disabled, 'GET', '/assets/app-B1b2C3.js')
  assert.equal(asset.status, 404)
})

test('指向不存在目录的 webDistDir：显式诊断 web_dist_invalid（不静默禁用）', { timeout: 60_000 }, async () => {
  const handler2 = createHubHandler({
    kernel: makeKernel(dataDir),
    webDistDir: join(dataDir, 'no-such-dist'),
  })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 500)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const body = JSON.parse(res.text) as { error: { code: string; message: string } }
  assert.equal(body.error.code, 'web_dist_invalid')
  assert.ok(body.error.message.includes('no-such-dist'), '诊断应包含具体目录路径')
})

test('单参调用形态（kernel）：缺省不启用静态托管（纯 API，不探测任何默认目录）', { timeout: 60_000 }, async () => {
  const legacy = createHandlerLegacy(makeKernel(dataDir))
  // 内核不做默认目录探测（Web 目录是 hub 产品策略）：无论仓旁是否存在 web dist，
  // 非 /api 一律 JSON 404；嵌入式 Kernel 的 HTTP 默认行为不随环境改变。
  const res = await call(legacy, 'GET', '/not-a-real-dist-check')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('非 GET/HEAD 方法（POST /）不进静态托管，回落 JSON 404', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'POST', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

// ---------------------------------------------------------------------------
// startHub（生产 node 层）集成：webDistDir 透传
// ---------------------------------------------------------------------------

test('startHub(port:0) 显式 webDistDir：真实 HTTP 静态往返 + HEAD 无 body', { timeout: 60_000 }, async () => {
  const hub = await startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: webDist })
  try {
    const res = await fetch(`${hub.url}/assets/app-B1b2C3.js`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(await res.text(), 'console.log("app")')

    const head = await fetch(`${hub.url}/`, { method: 'HEAD' })
    assert.equal(head.status, 200)
    const len = head.headers.get('content-length')
    assert.ok(len !== null && Number(len) > 0, `生产 HEAD 应保留 content-length（实际 ${len}）`)
    assert.equal(await head.text(), '', '生产 HEAD 不回 body')

    const spa = await fetch(`${hub.url}/conversations/42`)
    assert.equal(spa.status, 200)
    assert.ok((await spa.text()).includes('helm web'))
  } finally {
    await hub.close()
  }
})

test('startHub(port:0) webDistDir: false：静态托管禁用，非 /api 回 JSON 404', { timeout: 60_000 }, async () => {
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

test('startHub(port:0) 显式失效目录：启动显式报错（不静默禁用）', { timeout: 60_000 }, async () => {
  await assert.rejects(
    startHub({ kernel: makeKernel(dataDir), port: 0, webDistDir: join(dataDir, 'no-such-dist') }),
    (err: unknown) => err instanceof HelmError && err.code === 'web_dist_invalid',
  )
})

// ---------------------------------------------------------------------------
// 静态 gzip
// ---------------------------------------------------------------------------

test('静态文本资源 gzip：阈值内压缩、Vary/Content-Length 正确、缓存命中、PNG 不压缩', { timeout: 60_000 }, async () => {
  const bigJs = `console.log(${JSON.stringify('v'.repeat(4096))});\n`
  await writeFile(join(webDist, 'assets', 'big-A1b2.js'), bigJs)
  const smallJs = 'console.log(1)\n'
  await writeFile(join(webDist, 'assets', 'small-B2c3.js'), smallJs)
  await writeFile(join(webDist, 'assets', 'img-C3d4.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, ...new Array(2048).fill(1)]))

  const authed = (path: string, headers: Record<string, string> = {}): Request =>
    new Request(`${BASE}${path}`, {
      headers: { ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}), ...headers },
    })

  // >1KiB 文本 + Accept-Encoding: gzip → 压缩，解压与原文一致
  const gzReq = authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip', origin: 'http://x' })
  const gzRes = await handler(gzReq)
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip')
  const vary = (gzRes.headers.get('vary') ?? '').toLowerCase().split(',').map((token) => token.trim())
  assert.ok(vary.includes('accept-encoding'), `静态压缩必须保留 Accept-Encoding: ${vary}`)
  assert.ok(vary.includes('origin'), `CORS 不能覆盖压缩协商的 Vary: ${vary}`)
  const gzBytes = new Uint8Array(await gzRes.arrayBuffer())
  assert.equal(Number(gzRes.headers.get('content-length')), gzBytes.byteLength)
  assert.equal(gunzipSync(gzBytes).toString('utf8'), bigJs, '解压后与原文一致')

  // 二次请求走缓存（结果一致）
  const gzAgain = await handler(authed('/assets/big-A1b2.js', { 'accept-encoding': 'gzip' }))
  assert.equal(gzAgain.headers.get('content-encoding'), 'gzip')
  assert.equal(gunzipSync(new Uint8Array(await gzAgain.arrayBuffer())).toString('utf8'), bigJs, '缓存命中结果一致')

  // <1KiB 文本不压缩；不接受 gzip 的客户端拿 identity
  const small = await handler(authed('/assets/small-B2c3.js', { 'accept-encoding': 'gzip' }))
  assert.equal(small.headers.get('content-encoding'), null)
  await small.text()
  const identity = await handler(authed('/assets/big-A1b2.js'))
  assert.equal(identity.headers.get('content-encoding'), null)
  assert.equal(await identity.text(), bigJs)

  // PNG（不可压缩格式）不压缩
  const png = await handler(authed('/assets/img-C3d4.png', { 'accept-encoding': 'gzip' }))
  assert.equal(png.headers.get('content-encoding'), null)
  assert.equal(Number(png.headers.get('content-length')), 2052)
  await png.arrayBuffer()

  // HEAD 与 GET 同压缩头语义，body 为空
  const head = await handler(new Request(`${BASE}/assets/big-A1b2.js`, { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } }))
  assert.equal(head.headers.get('content-encoding'), 'gzip')
  assert.ok(head.body === null || (await head.text()) === '')
})
