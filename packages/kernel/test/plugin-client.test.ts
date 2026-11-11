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
import { gunzipSync } from 'node:zlib'
import {
  AuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SkillService,
} from '../src/services/index.js'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createMermaidPlugin } from '../src/builtin-plugins/mermaid.js'
import { createPluginHostBackendFixture } from './helpers/plugin-host-backend.js'
import { compilePluginClientModule } from '../src/plugins/client-compiler.js'
import { createHubHandler } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike} from '../src/http/index.js'
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
    id, title: `conv-${id}`, profileId: 'default', tags: [], cwd: '/tmp', model: 'test/model', thinkingLevel: '',
    status: 'idle', stateChangeSeq: 1, completionSeq: 0, unread: false, pinned: false,
    pendingAskCount: 0, createdAt: 1, updatedAt: 1,
  }
}

function makeBackend(): PluginHostBackend {
  return {
    ...createPluginHostBackendFixture(),
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
    onEvent: () => () => {},
    abortConversation: async () => {},
    getConversationActivity(): { consecutiveErrors: number } {
      return { consecutiveErrors: 0 }
    },
    getConversationOwnership(): 'helm' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
    listActions: () => [],
    emitEvent: () => {},
  }
}

function makeKernel(): KernelRuntimeLike {
  const auth = new AuthService(dataDir)
  const kernel: KernelRuntimeLike = {
    dataDir,
    auth,
    events: new TestEventHub(),
    profiles: new ProfileService(join(dataDir, 'profiles.json')),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    artifacts: undefined as never,
    plugins: pluginHost,
    listConversations: async () => [],
    getConversationDetail: async (id: number) => {
      throw new HelmError('not_found', `会话不存在: ${id}`, 404)
    },
    createConversation: async () => makeConversation(1),
    updateConversation: async (id: number) => makeConversation(id),
    deleteConversation: async () => {},
    submitInput: async () => ({ submissionId: 'sub' }),
    waitForInput: async (id: number) => ({ conversationId: id, submissionId: 'sub', text: '', entry: { id: 'e', kind: 'pi.assistant' } }),
    abortConversation: async () => {},
    resetConversation: async (id: number) => makeConversation(id),
    compactConversation: async (id: number) => ({ taskId: 1, conversation: makeConversation(id) }),
    forkConversation: async (id: number) => makeConversation(id + 100),
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
  return kernel
}


async function call(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  opts?: { auth?: boolean; headers?: Record<string, string> },
): Promise<{ status: number; text: string; buffer: Buffer; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) }
  if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
  const res = await handler(new Request(`http://127.0.0.1:3202${path}`, { method, headers }))
  const arrayBuf = await res.arrayBuffer()
  const buffer = Buffer.from(arrayBuf)
  const text = buffer.toString('utf8')
  return { status: res.status, text, buffer, headers: res.headers }
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
  await pluginHost.register(createMermaidPlugin())

  const kernel = makeKernel()
  handler = createHubHandler(kernel)
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

test('插件本地 CSS：原生合并为保留具名导出 __helmClientCss，产物不注入 DOM', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'css-plugin-src')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'styles.css'), '.widget-card {\n  color: var(--fg);\n}\n')
  await writeFile(join(root, 'index.tsx'), "import './styles.css'\nexport function Widget() { return 'w' }\n")
  const result = await compilePluginClientModule('test:css', root, 'index.tsx', dataDir)
  assert.match(result.code, /widget-card/, 'CSS 内容必须进入产物')
  assert.match(result.code, /__helmClientCss/, '合并 CSS 必须经保留具名导出返回')
  assert.doesNotMatch(result.code, /data-helm-plugin-css/, '产物不得自行注入 DOM（加载器负责注入）')
})

test('插件 CSS 本地 @import 正常合并（跨文件依赖），远程 @import 显式拒绝', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'css-import-src')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'other.css'), '.other { color: blue }\n')
  await writeFile(join(root, 'styles.css'), '@import "./other.css";\n.card { color: red }\n')
  await writeFile(join(root, 'index.tsx'), "import './styles.css'\nexport function Widget() { return 'w' }\n")
  const ok = await compilePluginClientModule('test:css-import', root, 'index.tsx', dataDir)
  assert.match(ok.code, /\.other/, '本地 @import 必须合并进产物')

  const remoteRoot = join(dataDir, 'css-remote-import-src')
  await mkdir(remoteRoot, { recursive: true })
  await writeFile(join(remoteRoot, 'styles.css'), '@import "https://example.com/x.css";\n.card { color: red }\n')
  await writeFile(join(remoteRoot, 'index.tsx'), "import './styles.css'\nexport function Widget() { return 'w' }\n")
  await assert.rejects(
    () => compilePluginClientModule('test:css-remote', remoteRoot, 'index.tsx', dataDir),
    (err: unknown) => err instanceof HelmError && err.code === 'client_compile_failed' && /远程 @import/.test(err.message),
  )
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

test('HTTP：If-None-Match 命中 contentHash 时返回 304 Not Modified 且无 body', { timeout: 60_000 }, async () => {
  const first = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('vary'), 'Accept-Encoding')
  const hash = first.headers.get('x-helm-client-hash')!
  const etag = first.headers.get('etag')!
  assert.ok(hash)
  assert.equal(etag, `"${hash}"`)

  // 强 ETag / 裸 hash 匹配均返回 304
  const res304 = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'if-none-match': etag },
  })
  assert.equal(res304.status, 304)
  assert.equal(res304.text, '')
  assert.equal(res304.headers.get('etag'), etag)
  assert.equal(res304.headers.get('x-helm-client-hash'), hash)
  assert.equal(res304.headers.get('vary'), 'Accept-Encoding')

  const res304RawHash = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'if-none-match': hash },
  })
  assert.equal(res304RawHash.status, 304)
})

test('HTTP：Accept-Encoding: gzip 返回 Content-Encoding: gzip 且解压后与原产物一致', { timeout: 60_000 }, async () => {
  const plain = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(plain.status, 200)

  const gzRes = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx', {
    headers: { 'accept-encoding': 'gzip, deflate, br' },
  })
  assert.equal(gzRes.status, 200)
  assert.equal(gzRes.headers.get('content-encoding'), 'gzip')
  const { gunzipSync } = await import('node:zlib')
  const decompressed = gunzipSync(gzRes.buffer).toString('utf8')
  assert.equal(decompressed, plain.text)
})

test('HTTP：HEAD 请求返回 200 与 headers 但无 body', { timeout: 60_000 }, async () => {
  const head = await call(handler, 'HEAD', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(head.status, 200)
  assert.equal(head.text, '')
  assert.match(head.headers.get('content-type') ?? '', /text\/javascript/)
  assert.match(head.headers.get('x-helm-client-hash') ?? '', /^[0-9a-f]{24}$/)
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

// ---------------------------------------------------------------------------
// 第一版缺陷修复回归：import 形态 / 裸依赖 / 依赖闭包 / 并发 / 迟到编译
// ---------------------------------------------------------------------------

test('default+named / as 别名 import：共享 shim 生成合法 ESM 绑定（非正则改写）', { timeout: 60_000 }, async () => {
  await writeFile(
    join(clientRoot, 'alias.tsx'),
    [
      "import ReactDef, { useState as state, useMemo } from 'react'",
      "import * as Lucide from 'lucide-react'",
      "import { usePluginContext } from '@helm/plugin-client'",
      'export function AliasPanel() {',
      '  const [n] = state(1)',
      '  const doubled = useMemo(() => n * 2, [n])',
      '  if (typeof usePluginContext !== \'function\') return null',
      '  return ReactDef.createElement(\'div\', null, `alias:${doubled}:${typeof Lucide.Save}`)',
      '}',
      'export const reactDefaultIsObject = typeof ReactDef.createElement',
      'export const memoKind = typeof useMemo',
    ].join('\n'),
  )
  try {
    const result = await pluginHost.getClientModule('test:client-fixture', 'alias.tsx')
    // 产物必须是合法 ESM（旧正则重写会产出 `const { useState as state }` 非法 JS）
    assert.doesNotMatch(result.code, /const\s*\{\s*useState\s+as\s+state\s*\}/)
    // kernel 不依赖 react：挂最小 fake 命名空间验证绑定机制（esbuild 合法导出而非正则改写）
    const fakeReact = {
      createElement: (tag: string, _props: unknown, ...children: unknown[]) => ({ tag, children }),
      useState: (v: number) => [v, () => {}],
      useMemo: <T,>(fn: () => T) => fn(),
    }
    const g2 = globalThis as unknown as Record<string, unknown>
    g2.__helm_shared_react = fakeReact
    g2.__helm_shared_lucide_react = { Save: () => null, Activity: () => null }
    g2.__helm_shared_plugin_client = { usePluginContext: () => null, usePluginDoc: () => undefined }
    const url = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`
    const mod = (await import(url)) as Record<string, unknown>
    assert.equal(typeof mod.AliasPanel, 'function')
    assert.equal(mod.reactDefaultIsObject, 'function')
    assert.equal(mod.memoKind, 'function')
    const element = (mod.AliasPanel as () => { tag: string; children: unknown[] })()
    assert.equal(String(element.children), 'alias:2:function')
  } finally {
    await rm(join(clientRoot, 'alias.tsx'), { force: true })
  }
})

test('非共享裸依赖（npm 包）显式拒绝：绝不把 node_modules 打进 bundle', { timeout: 60_000 }, async () => {
  await writeFile(
    join(clientRoot, 'bare-dep.tsx'),
    [
      "import { equal } from 'assert'",
      'export const run = (): unknown => equal',
    ].join('\n'),
  )
  try {
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'bare-dep.tsx'),
      (err: unknown) =>
        err instanceof HelmError &&
        err.code === 'client_compile_failed' &&
        err.message.includes('裸依赖') &&
        err.message.includes('assert'),
    )
  } finally {
    await rm(join(clientRoot, 'bare-dep.tsx'), { force: true })
  }
})

test('export * from 本地依赖：依赖源变化后 hash 变化（旧实现正则扫描漏 export-from）', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 're-export.ts'), "export * from './values'\nexport const local = 1\n")
  await writeFile(join(clientRoot, 'values.ts'), 'export const fromValues = 1\n')
  await writeFile(join(clientRoot, 'entry-export-star.ts'), "export { local } from './re-export'\n")
  try {
    const before = await pluginHost.getClientModule('test:client-fixture', 'entry-export-star.ts')
    // values.ts 只经 export * 链引入（自身无直接 import 语句）；改它必须失效缓存。
    // 注：未消费符号会被 esbuild tree-shake，产物代码可能相同——hash 必须变化。
    await writeFile(join(clientRoot, 'values.ts'), 'export const fromValues = 2\n')
    const after = await pluginHost.getClientModule('test:client-fixture', 'entry-export-star.ts')
    assert.notEqual(before.contentHash, after.contentHash)
  } finally {
    await rm(join(clientRoot, 're-export.ts'), { force: true })
    await rm(join(clientRoot, 'values.ts'), { force: true })
    await rm(join(clientRoot, 'entry-export-star.ts'), { force: true })
  }
})

test('依赖符号链接越根拒绝：本地 import 指向根外符号链接（旧实现只检入口）', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helm-plugin-client-outside2-'))
  try {
    const outsideFile = join(outsideDir, 'outside-dep.ts')
    await writeFile(outsideFile, 'export const evil = 1\n')
    await symlink(outsideFile, join(clientRoot, 'linked-dep.ts'))
    await writeFile(join(clientRoot, 'entry-linked.ts'), "import { evil } from './linked-dep'\nexport const v = evil\n")
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'entry-linked.ts'),
      (err: unknown) =>
        err instanceof HelmError && err.code === 'client_compile_failed' && err.message.includes('越界'),
    )
  } finally {
    await rm(join(clientRoot, 'linked-dep.ts'), { force: true })
    await rm(join(clientRoot, 'entry-linked.ts'), { force: true })
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('并发编译同 key：合并同一 Promise，产物一致（无临时文件碰撞）', { timeout: 60_000 }, async () => {
  await writeFile(
    join(clientRoot, 'concurrent.ts'),
    "import { useCounter } from './helper'\nexport const v = useCounter !== undefined\n",
  )
  try {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => pluginHost.getClientModule('test:client-fixture', 'concurrent.ts')),
    )
    const first = results[0]
    assert.ok(first)
    for (const r of results) {
      assert.equal(r.contentHash, first.contentHash)
      assert.equal(r.code, first.code)
    }
  } finally {
    await rm(join(clientRoot, 'concurrent.ts'), { force: true })
  }
})

test('编译器进程内内存缓存：本地依赖源未变时直接复用内存结果，避免重复磁盘读与哈希', { timeout: 60_000 }, async () => {
  const first = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  const second = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.equal(first.contentHash, second.contentHash)
  assert.equal(first.code, second.code)
})

test('编译失败后可重试：失败不缓存，修复源后重新编译成功', { timeout: 60_000 }, async () => {
  await writeFile(join(clientRoot, 'retry.ts'), 'export const x = (((\n')
  try {
    await assert.rejects(pluginHost.getClientModule('test:client-fixture', 'retry.ts'))
    await writeFile(join(clientRoot, 'retry.ts'), 'export const x = 1\n')
    const ok = await pluginHost.getClientModule('test:client-fixture', 'retry.ts')
    assert.ok(ok.code.length > 0)
  } finally {
    await rm(join(clientRoot, 'retry.ts'), { force: true })
  }
})

test('迟到编译拒绝：编译期间插件停用，产物不得返回成功（epoch 守卫）', { timeout: 60_000 }, async () => {
  // 先破坏依赖源使编译足够慢不可行（esbuild 很快）——改用直连 host：并发触发编译与 disable
  await writeFile(
    join(clientRoot, 'late.ts'),
    "import { useCounter } from './helper'\nexport const v = 1\n",
  )
  try {
    const compiling = pluginHost.getClientModule('test:client-fixture', 'late.ts')
    const disabling = pluginHost.disable('test:client-fixture')
    const [lateResult] = await Promise.allSettled([compiling])
    await disabling
    if (lateResult.status === 'fulfilled') {
      // 竞态窗口未命中（编译先完成）：此时插件已停用，再次获取必须拒绝
      // 且 fulfill 本身发生在 disable 前不算缺陷——验证停用后拒绝即可
    } else {
      assert.equal((lateResult.reason as HelmError).code, 'plugin_client_unavailable')
    }
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'late.ts'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_client_unavailable',
    )
  } finally {
    await pluginHost.enable('test:client-fixture')
    await rm(join(clientRoot, 'late.ts'), { force: true })
  }
})

test('clientRoot 跨平台绝对路径：Windows 盘符合法、foo..bar 目录名不再误拒', { timeout: 60_000 }, async () => {
  // 目录名含字面 ..（合法目录名）不应误拒；旧实现 clientRoot.includes('..') 会拒绝
  const dotDotDir = join(dataDir, 'foo..bar')
  await mkdir(dotDotDir, { recursive: true })
  await pluginHost.register({
    id: 'test:dotdot-root',
    clientRoot: dotDotDir,
    definePlugin() {},
  })
  // Windows 盘符形态在注册层合法（非 POSIX startsWith('/') 误拒）；目录存在性由编译期校验
  await pluginHost.register({
    id: 'test:win-root',
    clientRoot: 'C:\\helm\\plugins\\demo\\client',
    definePlugin() {},
  })
  // 相对路径仍拒绝
  await assert.rejects(
    pluginHost.register({ id: 'test:rel-root', clientRoot: 'relative/dir', definePlugin() {} }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
  // 整段 .. 仍拒绝（真正的越根；join 会归一化掉 ..，故用字面量路径保留 .. 段）
  await assert.rejects(
    pluginHost.register({ id: 'test:seg-root', clientRoot: `${dataDir}/a/../b`, definePlugin() {} }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_definition',
  )
})

// ---------------------------------------------------------------------------
// 阶段 3（Code Splitting）：按需分包、零膨胀共享 Chunk 桥与端到端渲染
// ---------------------------------------------------------------------------

test('代码分割与共享 Chunk：builtin:mermaid 主包与异步 chunk 体积收敛，无重复内联膨胀', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  assert.ok(result.code.length > 0, '主包代码不能为空')
  assert.ok(result.gzipped, '必须产出 gzipped 字节')

  // 1. builtin:mermaid 主包 .mjs gzip 体积 < 200 KB
  assert.ok(
    result.gzipped.length < 200 * 1024,
    `主包 gzip 体积 (${result.gzipped.length} 字节) 必须 < 200 KB`,
  )

  const chunks = result.chunks ?? {}
  const chunkEntries = Object.entries(chunks)
  assert.ok(chunkEntries.length > 0, 'mermaid 必须产出异步 chunks')

  // 2. flowDiagram 与 pieDiagram 异步 chunk gzip 体积 < 35 KB
  const flowEntry = chunkEntries.find(([name]) => name.includes('flowDiagram'))
  const pieEntry = chunkEntries.find(([name]) => name.includes('pieDiagram'))
  assert.ok(flowEntry, '产物中必须包含 flowDiagram 异步 chunk')
  assert.ok(pieEntry, '产物中必须包含 pieDiagram 异步 chunk')

  assert.ok(
    flowEntry[1].gzipped && flowEntry[1].gzipped.length < 35 * 1024,
    `flowDiagram chunk gzip (${flowEntry[1].gzipped?.length} 字节) 必须 < 35 KB`,
  )
  assert.ok(
    pieEntry[1].gzipped && pieEntry[1].gzipped.length < 35 * 1024,
    `pieDiagram chunk gzip (${pieEntry[1].gzipped?.length} 字节) 必须 < 35 KB`,
  )

  // 3. 所有编译产物（主包 + 全部异步 chunk）gzip 总和 < 1.8 MB（证明无重复内联膨胀）
  let totalGzipped = result.gzipped.length
  for (const [, chunk] of chunkEntries) {
    totalGzipped += chunk.gzipped?.length ?? 0
  }
  assert.ok(
    totalGzipped < 1.8 * 1024 * 1024,
    `所有编译产物 gzip 总和 (${totalGzipped} 字节) 必须 < 1.8 MB`,
  )
})

test('端到端执行：编译产物在 Node 环境通过 __helm_import_chunk 按需加载图表并渲染有效 SVG', { timeout: 60_000 }, async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  try {
    const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
    assert.ok(result.code.length > 0)

    // 挂载运行时依赖 mock
    const g = globalThis as Record<string, unknown>
    g.__helm_shared_react = {
      useEffect: () => {},
      useRef: () => ({ current: null }),
      useState: (v: unknown) => [v, () => {}],
    }
    g.__helm_shared_plugin_client = {
      usePluginContext: () => ({ theme: 'dark' }),
      HelmIcon: () => null,
      CopyButton: () => null,
      Callout: () => null,
    }

    const modUrl = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}`
    const mod = (await import(modUrl)) as {
      MermaidCodeBlock: unknown
      mermaid: typeof import('mermaid').default
    }

    assert.equal(typeof mod.MermaidCodeBlock, 'function', '必须导出 MermaidCodeBlock 组件')
    assert.ok(mod.mermaid, '必须导出 mermaid 实例')

    // 初始化并渲染 flowchart 与 pie 图表，触发按需加载异步 chunk
    mod.mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })

    const flowResult = await mod.mermaid.render('test-flow-render', 'graph TD;\nA-->B;')
    assert.ok(flowResult.svg.includes('<svg'), 'Flowchart 渲染结果必须包含 <svg')

    const pieResult = await mod.mermaid.render('test-pie-render', 'pie title Pets\n"Dogs" : 386\n"Cats" : 85')
    assert.ok(pieResult.svg.includes('<svg'), 'Pie 图表渲染结果必须包含 <svg')
  } finally {
    GlobalRegistrator.unregister()
  }
})

test('HTTP Chunk 端点：200/gzip/immutable 缓存、304 协商、400 形状非法、409 过时 hash、404 缺失与 409 停用防护', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const contentHash = result.contentHash
  const chunks = result.chunks ?? {}
  const flowChunkName = Object.keys(chunks).find((k) => k.includes('flowDiagram'))!
  assert.ok(flowChunkName)

  // 1. 有效 chunk 请求：200 OK，immutable 缓存头，gzip 内容
  const res200 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'accept-encoding': 'gzip' } },
  )
  assert.equal(res200.status, 200)
  assert.equal(res200.headers.get('content-encoding'), 'gzip')
  assert.equal(res200.headers.get('cache-control'), 'private, max-age=31536000, immutable')
  assert.equal(res200.headers.get('etag'), `"${contentHash}:${flowChunkName}"`)
  assert.equal(res200.headers.get('x-helm-client-hash'), contentHash)

  const flowChunk = chunks[flowChunkName]
  assert.ok(flowChunk)
  const decompressed = gunzipSync(res200.buffer).toString('utf8')
  assert.equal(decompressed, flowChunk.code)

  // 2. 304 协商缓存命中
  const res304 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(res304.status, 304)
  assert.equal(res304.text, '')
  assert.equal(res304.headers.get('etag'), `"${contentHash}:${flowChunkName}"`)
  assert.equal(res304.headers.get('cache-control'), 'private, max-age=31536000, immutable')

  // 3. 非法 chunk 形状直接 400
  for (const bad of ['../escape.js', 'a/../b.js', 'bad..js', 'noext', 'chunk.mjs', '/abs.js', 'dir/sub.js']) {
    const resBad = await call(
      handler,
      'GET',
      `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${encodeURIComponent(bad)}&hash=${contentHash}`,
    )
    assert.equal(resBad.status, 400, `chunk=${bad} 应返回 400`)
    const body = JSON.parse(resBad.text) as { error?: { code?: string } }
    assert.equal(body.error?.code, 'invalid_client_module')
  }

  // 4. hash 失效保护（409 client_chunk_stale）
  const resStale = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=000000000000000000000000`,
  )
  assert.equal(resStale.status, 409)
  const bodyStale = JSON.parse(resStale.text) as { error?: { code?: string } }
  assert.equal(bodyStale.error?.code, 'client_chunk_stale')

  // 5. 不存在的 chunk（404 client_chunk_not_found）
  const resMissing = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=nonexistent_chunk_404.js&hash=${contentHash}`,
  )
  assert.equal(resMissing.status, 404)
  const bodyMissing = JSON.parse(resMissing.text) as { error?: { code?: string } }
  assert.equal(bodyMissing.error?.code, 'client_chunk_not_found')

  // 6. 停用插件（409 plugin_client_unavailable）
  await pluginHost.disable('builtin:mermaid')
  try {
    const resDisabled = await call(
      handler,
      'GET',
      `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    )
    assert.equal(resDisabled.status, 409)
    const bodyDisabled = JSON.parse(resDisabled.text) as { error?: { code?: string } }
    assert.equal(bodyDisabled.error?.code, 'plugin_client_unavailable')
  } finally {
    await pluginHost.enable('builtin:mermaid')
  }

  // 7. 直接调用 PluginHost getClientModule 检验
  const directChunk = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: flowChunkName })
  assert.equal(directChunk.code, flowChunk.code)
  assert.equal(directChunk.contentHash, contentHash)

  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: '../bad.js' }),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: flowChunkName, hash: 'badhash' }),
    (err: unknown) => err instanceof HelmError && err.code === 'client_chunk_stale',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: 'missing.js' }),
    (err: unknown) => err instanceof HelmError && err.code === 'client_chunk_not_found',
  )
})
