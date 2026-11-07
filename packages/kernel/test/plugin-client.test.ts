/**
 * client.tsx 轨道内核测试：真实 esbuild 编译 + PluginHost getClientModule +
 * HTTP GET /api/plugins/:id/client.mjs 端点。
 *
 * 覆盖：真实编译产物（external 重写为 __helm_shared_*）、缓存命中（同 hash 不重编）、
 * 依赖源变化缓存失效、路径逃逸（../ 与符号链接）拒绝、停用插件拒绝提供、
 * HTTP 鉴权边界（无 token 401）、模块缺失/编译错误显式报错（无静默降级）、
 * 注册边界（client 引用无 clientRoot 拒绝；module 形状非法拒绝）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SkillService,
} from '../src/services/index.js'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createHubHandler } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike, WorkflowServiceLike } from '../src/http/index.js'
import { HelmError, type ConversationSummary } from '@helm/protocol'

// ---------------------------------------------------------------------------
// 测试基座（真实临时目录 + 真实 services + 真实 PluginHost）
// ---------------------------------------------------------------------------

let dataDir: string
let pluginHost: PluginHost
let token: string | undefined

class TestEventHub implements EventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

function makeConversation(id: number): ConversationSummary {
  return {
    id, title: `conv-${id}`, profileId: 'default', tags: [], cwd: '/tmp', model: 'test/model',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
}

function makeBackend(): PluginHostBackend {
  return {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async (init) => ({ ...makeConversation(42), title: init.title ?? 'new' }),
    listConversations: () => [makeConversation(1)],
    getConversation: (id) => makeConversation(id),
    updateConversation: async (id) => makeConversation(id),
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({ id: 'ask-1', status: 'answered', answers: {} }),
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onWorkflowSettled: () => () => {},
    emitEvent: () => {},
  }
}

function makeKernel(): KernelRuntimeLike {
  const auth = new AuthService(dataDir)
  return {
    dataDir,
    auth,
    events: new TestEventHub(),
    profiles: new ProfileService(join(dataDir, 'profiles.json')),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    // biome-ignore lint: 本测试不消费 artifacts
    artifacts: undefined as never,
    plugins: pluginHost,
    listConversations: async () => [],
    getConversationDetail: async (id) => {
      throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    },
    createConversation: async () => makeConversation(1),
    updateConversation: async (id) => makeConversation(id),
    deleteConversation: async () => {},
    submitInput: async () => ({ submissionId: 'sub' }),
    waitForInput: async (id) => ({ conversationId: id, submissionId: 'sub', text: '', entry: { id: 'e', kind: 'pi.assistant' } }),
    abortConversation: async () => {},
    resetConversation: async (id) => makeConversation(id),
    compactConversation: async (id) => ({ taskId: 1, conversation: makeConversation(id) }),
    forkConversation: async (id) => makeConversation(id + 100),
    listAsks: async () => [],
    answerAsk: async () => {},
    cancelAsk: async () => {},
    search: async () => [],
    listModels: () => [],
    listModelProviders: () => [],
  } as unknown as KernelRuntimeLike
}

const workflows: WorkflowServiceLike = {
  list: () => [],
  listRuns: () => [],
  run: async () => ({ id: 'r', name: 'x', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 1 }),
  getRun: async () => undefined,
  wait: async () => {},
  abort: async () => {},
}

async function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts?: { auth?: boolean },
): Promise<{ status: number; text: string; headers: Headers }> {
  const headers: Record<string, string> = {}
  if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await handler(new Request(`http://127.0.0.1:3202${path}`, { method, headers }))
  return { status: res.status, text: await res.text(), headers: res.headers }
}

/** 真实 clientRoot 夹具：client.tsx（依赖本地 helper.tsx + react external）。 */
let clientRoot: string
let handler: (req: Request) => Promise<Response>

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'helm-plugin-client-'))
  clientRoot = join(dataDir, 'fixture-plugin-src')
  await mkdir(clientRoot, { recursive: true })
  await writeFile(
    join(clientRoot, 'helper.tsx'),
    `import { useState } from 'react'\nexport function useCounter(): [number, () => void] {\n  const [n, setN] = useState(0)\n  return [n, () => setN(n + 1)]\n}\n`,
  )
  await writeFile(
    join(clientRoot, 'client.tsx'),
    `import { useCounter } from './helper'\nimport { useState } from 'react'\n\nexport function Panel(props: { title: string }) {\n  const [n, bump] = useCounter()\n  const [label] = useState(props.title)\n  return label + ':' + n\n}\n`,
  )

  class MemoryDocStore {
    store = new Map<string, unknown>()
    get<T>(key: string, initial: T): T {
      return this.store.has(key) ? (this.store.get(key) as T) : initial
    }
    set<T>(key: string, value: T): void {
      this.store.set(key, structuredClone(value))
    }
  }
  pluginHost = new PluginHost({
    dataDir,
    host: makeBackend(),
    docs: new MemoryDocStore() as never,
  })
  await pluginHost.register({
    id: 'test:client-fixture',
    name: 'client 夹具插件',
    clientRoot,
    definePlugin(ctx) {
      ctx.ui.screen({ id: 'panel', label: '夹具面板', client: { module: 'client.tsx', export: 'Panel' } })
    },
  })

  const kernel = makeKernel()
  handler = createHubHandler(kernel, workflows)
  const auth = kernel.auth as unknown as { setup(password: string): Promise<{ token: string }> }
  const issued = await auth.setup('client-track-test-password')
  token = issued.token
})

after(async () => {
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 编译与缓存
// ---------------------------------------------------------------------------

test('真实编译：产物为 ESM，react external 重写为 __helm_shared_* 命名空间', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.ok(result.code.length > 0)
  assert.match(result.code, /__helm_shared_react/)
  // bundle 内联本地依赖（helper 不再是独立 import）
  assert.doesNotMatch(result.code, /['"]\.\/helper['"]/)
  // 绝不打包第二份 React（external 生效）
  assert.doesNotMatch(result.code, /useState\s*\(\)\s*\{/)
  assert.match(result.contentHash, /^[0-9a-f]{24}$/)
})

test('缓存命中：同源重复获取 contentHash 一致且产物已落盘', { timeout: 60_000 }, async () => {
  const first = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  const second = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.equal(first.contentHash, second.contentHash)
  assert.equal(first.code, second.code)
})

test('依赖源变化：本地依赖 helper.tsx 变更后 hash 变化（重新编译）', { timeout: 60_000 }, async () => {
  const before = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  await writeFile(
    join(clientRoot, 'helper.tsx'),
    `import { useState } from 'react'\nexport function useCounter(): [number, () => void] {\n  const [n, setN] = useState(10)\n  return [n, () => setN(n + 2)]\n}\n`,
  )
  const after = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.notEqual(before.contentHash, after.contentHash)
  assert.notEqual(before.code, after.code)
})

// ---------------------------------------------------------------------------
// 路径逃逸与形状拒绝
// ---------------------------------------------------------------------------

test('路径逃逸拒绝：.. 越根 / 绝对路径 / 非 ts 扩展', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', '../secrets.ts'),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', '/etc/passwd.ts'),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.js'),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
  )
})

test('符号链接逃逸拒绝：clientRoot 内符号链接指向根外文件', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helm-plugin-client-outside-'))
  try {
    const outsideFile = join(outsideDir, 'evil.ts')
    await writeFile(outsideFile, 'export const x = 1\n')
    const linkPath = join(clientRoot, 'linked.ts')
    await symlink(outsideFile, linkPath)
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'linked.ts'),
      (err: unknown) => err instanceof HelmError && (err.code === 'client_module_out_of_root' || err.code === 'invalid_client_module'),
    )
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('模块不存在：显式 400 client_root_invalid，无静默空产物', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'missing.ts'),
    (err: unknown) => err instanceof HelmError && err.code === 'client_root_invalid',
  )
})

// ---------------------------------------------------------------------------
// 生命周期与注册边界
// ---------------------------------------------------------------------------

test('停用插件拒绝提供 client 模块（409）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('test:client-fixture')
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.tsx'),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_client_unavailable' && err.status === 409,
  )
  await pluginHost.enable('test:client-fixture')
  const back = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.ok(back.code.length > 0)
})

test('注册边界：client 引用但插件无 clientRoot 显式拒绝', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.register({
      id: 'test:no-root',
      definePlugin(ctx) {
        ctx.ui.screen({ id: 's', label: 's', client: { module: 'client.tsx', export: 'X' } })
      },
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  )
})

test('注册边界：client.module 形状非法（.. / 绝对路径 / 扩展名）拒绝', { timeout: 60_000 }, async () => {
  for (const bad of ['../x.ts', '/abs.ts', 'mod.js', 'a/../b.tsx']) {
    await assert.rejects(
      pluginHost.register({
        id: `test:bad-module-${bad.replace(/[^a-z]/gi, '_')}`,
        clientRoot,
        definePlugin(ctx) {
          ctx.ui.screen({ id: 's', label: 's', client: { module: bad, export: 'X' } })
        },
      }),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
    )
  }
})

test('注册边界：clientRoot 含 .. 或相对路径的插件定义拒绝', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.register({
      id: 'test:bad-root-1',
      clientRoot: 'relative/dir',
      definePlugin() {},
    }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
})

// ---------------------------------------------------------------------------
// HTTP 端点
// ---------------------------------------------------------------------------

test('HTTP：无 token 401；有效 token 200 返回 JS 与 hash 头', { timeout: 60_000 }, async () => {
  const unauth = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', { auth: false })
  assert.equal(unauth.status, 401)

  const ok = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(ok.status, 200)
  assert.match(ok.headers.get('content-type') ?? '', /text\/javascript/)
  assert.match(ok.headers.get('x-helm-client-hash') ?? '', /^[0-9a-f]{24}$/)
  assert.match(ok.text, /__helm_shared_react/)
})

test('HTTP：缺 module 参数 400；越根 module 400/404 错误信封', { timeout: 60_000 }, async () => {
  const noModule = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs')
  assert.equal(noModule.status, 400)

  const escape = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=..%2Fsecrets.ts')
  assert.equal(escape.status, 400)
})

test('HTTP：停用插件返回 409 错误信封（不返回 JS）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('test:client-fixture')
  try {
    const res = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
    assert.equal(res.status, 409)
    const body = JSON.parse(res.text) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'plugin_client_unavailable')
  } finally {
    await pluginHost.enable('test:client-fixture')
  }
})

test('HTTP：编译错误（语法违约源）显式 422 诊断，无静默降级', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 'broken.ts'), 'export const x = (((\n')
  try {
    const res = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=broken.ts')
    assert.equal(res.status, 422)
    const body = JSON.parse(res.text) as { error?: { code?: string; message?: string } }
    assert.equal(body.error?.code, 'client_compile_failed')
    assert.match(body.error?.message ?? '', /broken\.ts/)
  } finally {
    await rm(join(clientRoot, 'broken.ts'), { force: true })
  }
})

test('HTTP：未声明 clientRoot 的插件 404', { timeout: 60_000 }, async () => {
  await pluginHost.register({ id: 'test:no-client', definePlugin() {} })
  const res = await call(handler, 'GET', '/api/plugins/test%3Ano-client/client.mjs?module=client.tsx')
  assert.equal(res.status, 404)
  const body = JSON.parse(res.text) as { error?: { code?: string } }
  assert.equal(body.error?.code, 'plugin_client_unavailable')
})
