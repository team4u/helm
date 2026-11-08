/**
 * helm-hub 生产静态托管（packages/web/dist）专项测试。
 *
 * 覆盖：根路径 / 与 index.html、/assets/* 带 hash 资源（Content-Type 与
 * immutable 缓存）、SPA 前端路由回退（无扩展名路径回 index.html）、
 * 带扩展名缺失文件 404、.. 路径穿越拦截与符号链接逃逸拒绝、
 * webDistDir: false 禁用、/api/* 未知路由仍返回 JSON 404。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createHubHandler, type HubHandlerOptions } from '../src/http/hub.js'
import { createHubHandler as createHandlerLegacy } from '../src/http/index.js'
import type { KernelRuntimeLike, WorkflowServiceLike, EventHub } from '../src/http/index.js'
import { AuthService } from '../src/services/index.js'

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

const workflows: WorkflowServiceLike = {
  list: () => [],
  listRuns: () => [],
  run: async () => {
    throw new Error('unused')
  },
  getRun: async () => undefined,
  wait: async () => {},
  abort: async () => {},
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
  handler = createHubHandler({ kernel: makeKernel(dataDir), workflows, webDistDir: webDist })
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

test('HEAD / 同 GET 状态码与响应头', { timeout: 60_000 }, async () => {
  const res = await handler(new Request(`${BASE}/`, { method: 'HEAD' }))
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8')
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
  const disabled = createHubHandler({ kernel: makeKernel(dataDir), workflows, webDistDir: false })
  const res = await call(disabled, 'GET', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
  const asset = await call(disabled, 'GET', '/assets/app-B1b2C3.js')
  assert.equal(asset.status, 404)
})

test('指向不存在目录的 webDistDir：探测失败回落 JSON 404（不抛错）', { timeout: 60_000 }, async () => {
  const handler2 = createHubHandler({
    kernel: makeKernel(dataDir),
    workflows,
    webDistDir: join(dataDir, 'no-such-dist'),
  })
  const res = await call(handler2, 'GET', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})

test('旧双参调用形态（kernel, workflows）保持兼容：缺省 webDistDir 探测', { timeout: 60_000 }, async () => {
  const legacy = createHandlerLegacy(makeKernel(dataDir), workflows)
  // 缺省探测依赖实际构建产物；构建后应走 SPA 回退，未构建时才返回 JSON 404。
  const hasDefaultDist = existsSync(new URL('../../web/dist/index.html', import.meta.url))
  const res = await call(legacy, 'GET', '/not-a-real-dist-check')
  assert.equal(res.status, hasDefaultDist ? 200 : 404)
  assert.equal(res.headers.get('content-type'), hasDefaultDist ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8')
})

test('非 GET/HEAD 方法（POST /）不进静态托管，回落 JSON 404', { timeout: 60_000 }, async () => {
  const res = await call(handler, 'POST', '/')
  assert.equal(res.status, 404)
  assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
})
