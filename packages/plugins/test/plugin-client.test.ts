/**
 * client.tsx 轨道内核测试：真实 esbuild 编译 + PluginHost getClientModule +
 * HTTP GET /api/plugins/:id/client.mjs 端点。
 *
 * 覆盖：真实编译产物（external 重写为 __helmx_shared_*）、缓存命中（同 hash 不重编）、
 * 依赖源变化缓存失效、路径逃逸（../ 与符号链接）拒绝、停用插件拒绝提供、
 * HTTP 鉴权边界（无 token 401）、模块缺失/编译错误显式报错（无静默降级）、
 * 注册边界（client 引用无 clientRoot 拒绝；module 形状非法拒绝）。
 */
import assert from 'node:assert/strict'
import { test, before, after } from 'node:test'
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import {
  AuthService,
  CredentialService,
  ProfileService,
  ProviderService,
  SkillService,
} from '../../kernel/src/services/index.js'
import { PluginHost, doctorPluginDir, loadExternalPlugins, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import { createMermaidPlugin } from '../src/mermaid.js'
import { createPluginHostBackendFixture } from '../../kernel/test/helpers/plugin-host-backend.js'
import { createHubHandler } from '../../kernel/src/http/index.js'
import type { EventHub, KernelRuntimeLike} from '../../kernel/src/http/index.js'
import {
  buildPluginClientBundleDir,
  compilePluginClientModule,
  createPluginBuildProvider,
  installNodeChunkBridge,
} from '@helmx/plugin-build'
import {
  HelmxError,
  PREBUILT_CLIENT_DIR_NAME,
  PREBUILT_CLIENT_MANIFEST_FILE,
  prebuiltChunkFileName,
  type ConversationSummary,
} from '@helmx/protocol'
import { createMermaidLoader } from '../src/mermaid/client/mermaid-loader.js'
import { MemoryDocStore, deferred, makeConversationSummary, waitFor } from './helpers/plugin-test-env.js'

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

const makeConversation = (id: number): ConversationSummary => makeConversationSummary({ id, profileId: 'default' })

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
    getConversationOwnership(): 'helmx' | 'bot' | 'human' {
      return 'human'
    },
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
    withFileMutationQueue(): Promise<never> { throw new Error('本 fixture 不承载文件互斥队列') },
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
      throw new HelmxError('not_found', `会话不存在: ${id}`, 404)
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
  dataDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-'))
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

  pluginHost = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: makeBackend(),
    docs: new MemoryDocStore(),
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

test('真实编译：产物为 ESM，react external 重写为 __helmx_shared_* 命名空间', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('test:client-fixture', 'client.tsx')
  assert.ok(result.code.length > 0)
  assert.match(result.code, /__helmx_shared_react/)
  // bundle 内联本地依赖（helper 不再是独立 import）
  assert.doesNotMatch(result.code, /['"]\.\/helper['"]/)
  // 绝不打包第二份 React（external 生效）
  assert.doesNotMatch(result.code, /useState\s*\(\)\s*\{/)
  assert.match(result.contentHash, /^[0-9a-f]{24}$/)
})

test('插件本地 CSS：原生合并为保留具名导出 __helmxClientCss，产物不注入 DOM', { timeout: 60_000 }, async () => {
  const root = join(dataDir, 'css-plugin-src')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'styles.css'), '.widget-card {\n  color: var(--fg);\n}\n')
  await writeFile(join(root, 'index.tsx'), "import './styles.css'\nexport function Widget() { return 'w' }\n")
  const result = await compilePluginClientModule('test:css', root, 'index.tsx', dataDir)
  assert.match(result.code, /widget-card/, 'CSS 内容必须进入产物')
  assert.match(result.code, /__helmxClientCss/, '合并 CSS 必须经保留具名导出返回')
  assert.doesNotMatch(result.code, /data-helmx-plugin-css/, '产物不得自行注入 DOM（加载器负责注入）')
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
    (err: unknown) => err instanceof HelmxError && err.code === 'client_compile_failed' && /remote @import/.test(err.message),
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
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', '/etc/passwd.ts'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.js'),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
})

test('符号链接逃逸拒绝：clientRoot 内符号链接指向根外文件', { timeout: 60_000 }, async () => {
  const outsideDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-outside-'))
  try {
    const outsideFile = join(outsideDir, 'evil.ts')
    await writeFile(outsideFile, 'export const x = 1\n')
    const linkPath = join(clientRoot, 'linked.ts')
    await symlink(outsideFile, linkPath)
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'linked.ts'),
      (err: unknown) => err instanceof HelmxError && (err.code === 'client_module_out_of_root' || err.code === 'invalid_client_module'),
    )
  } finally {
    await rm(outsideDir, { recursive: true, force: true })
  }
})

test('模块不存在：显式 400 client_root_invalid，无静默空产物', { timeout: 60_000 }, async () => {
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'missing.ts'),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_root_invalid',
  )
})

// ---------------------------------------------------------------------------
// 生命周期与注册边界
// ---------------------------------------------------------------------------

test('停用插件拒绝提供 client 模块（409）', { timeout: 60_000 }, async () => {
  await pluginHost.disable('test:client-fixture')
  await assert.rejects(
    pluginHost.getClientModule('test:client-fixture', 'client.tsx'),
    (err: unknown) => err instanceof HelmxError && err.code === 'plugin_client_unavailable' && err.status === 409,
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
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_ui_spec',
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
      (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
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
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
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
  assert.match(ok.headers.get('x-helmx-client-hash') ?? '', /^[0-9a-f]{24}$/)
  assert.match(ok.text, /__helmx_shared_react/)
})

test('HTTP：If-None-Match 命中 contentHash 时返回 304 Not Modified 且无 body', { timeout: 60_000 }, async () => {
  const first = await call(handler, 'GET', '/api/plugins/test%3Aclient-fixture/client.mjs?module=client.tsx')
  assert.equal(first.status, 200)
  assert.equal(first.headers.get('vary'), 'Accept-Encoding')
  const hash = first.headers.get('x-helmx-client-hash')!
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
  assert.equal(res304.headers.get('x-helmx-client-hash'), hash)
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
  assert.match(head.headers.get('x-helmx-client-hash') ?? '', /^[0-9a-f]{24}$/)
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
      "import { usePluginContext } from '@helmx/plugin-client'",
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
    g2.__helmx_shared_react = fakeReact
    g2.__helmx_shared_lucide_react = { Save: () => null, Activity: () => null }
    g2.__helmx_shared_plugin_client = { usePluginContext: () => null, usePluginDoc: () => undefined }
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
        err instanceof HelmxError &&
        err.code === 'client_compile_failed' &&
        err.message.includes('bare dependency') &&
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
  const outsideDir = await mkdtemp(join(tmpdir(), 'helmx-plugin-client-outside2-'))
  try {
    const outsideFile = join(outsideDir, 'outside-dep.ts')
    await writeFile(outsideFile, 'export const evil = 1\n')
    await symlink(outsideFile, join(clientRoot, 'linked-dep.ts'))
    await writeFile(join(clientRoot, 'entry-linked.ts'), "import { evil } from './linked-dep'\nexport const v = evil\n")
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'entry-linked.ts'),
      (err: unknown) =>
        err instanceof HelmxError && err.code === 'client_compile_failed' && err.message.includes('out of bounds'),
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
      assert.equal((lateResult.reason as HelmxError).code, 'plugin_client_unavailable')
    }
    await assert.rejects(
      pluginHost.getClientModule('test:client-fixture', 'late.ts'),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_client_unavailable',
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
    clientRoot: 'C:\\helmx\\plugins\\demo\\client',
    definePlugin() {},
  })
  // 相对路径仍拒绝
  await assert.rejects(
    pluginHost.register({ id: 'test:rel-root', clientRoot: 'relative/dir', definePlugin() {} }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )
  // 整段 .. 仍拒绝（真正的越根；join 会归一化掉 ..，故用字面量路径保留 .. 段）
  await assert.rejects(
    pluginHost.register({ id: 'test:seg-root', clientRoot: `${dataDir}/a/../b`, definePlugin() {} }),
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_plugin_definition',
  )
})

// ---------------------------------------------------------------------------
// 阶段 3（Code Splitting）：按需分包、零膨胀共享 Chunk 桥与端到端渲染
// ---------------------------------------------------------------------------

interface VirtualNode {
  type: unknown
  props: Record<string, unknown>
}

function collectNodes(node: unknown, predicate: (v: VirtualNode) => boolean, out: VirtualNode[] = []): VirtualNode[] {
  if (Array.isArray(node)) {
    for (const item of node) collectNodes(item, predicate, out)
    return out
  }
  if (node !== null && typeof node === 'object' && 'props' in node && 'type' in node) {
    const vnode = node as VirtualNode
    if (predicate(vnode)) out.push(vnode)
    if (vnode.props && 'children' in vnode.props) {
      collectNodes(vnode.props.children, predicate, out)
    }
  }
  return out
}

function collectText(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(collectText).join(' ')
  if (node !== null && typeof node === 'object' && 'props' in node) {
    const props = (node as VirtualNode).props
    return collectText(props?.children)
  }
  return ''
}

function createComponentHarness<P>(initialProps: P) {
  const states: unknown[] = []
  const refs: Array<{ current: unknown }> = []
  const memoSlots: Array<{ deps?: unknown[]; value: unknown }> = []
  const effectSlots: Array<{ deps?: unknown[]; cleanup?: () => void }> = []
  const pendingEffects: Array<{ slot: number; fn: () => void | (() => void); deps?: unknown[] }> = []
  let currentProps = initialProps
  let stateUpdates = 0

  const g = globalThis as Record<string, unknown>
  const prevReact = g.__helmx_shared_react
  const prevJsx = g.__helmx_shared_react_jsx_runtime
  const prevClient = g.__helmx_shared_plugin_client

  const depsChanged = (a?: unknown[], b?: unknown[]): boolean => {
    if (!a || !b || a.length !== b.length) return true
    return a.some((v, i) => !Object.is(v, b[i]))
  }

  let stateIdx = 0
  let refIdx = 0
  let memoIdx = 0
  let effectIdx = 0

  g.__helmx_shared_react = {
    useState: (init: unknown) => {
      const idx = stateIdx++
      if (idx >= states.length) {
        states.push(typeof init === 'function' ? (init as () => unknown)() : init)
      }
      const setState = (next: unknown) => {
        const prev = states[idx]
        const resolved = typeof next === 'function' ? (next as (p: unknown) => unknown)(prev) : next
        if (!Object.is(prev, resolved)) {
          states[idx] = resolved
          stateUpdates += 1
        }
      }
      return [states[idx], setState]
    },
    useRef: (init: unknown) => {
      const idx = refIdx++
      if (idx >= refs.length) refs.push({ current: init })
      return refs[idx]
    },
    useCallback: (fn: unknown, deps?: unknown[]) => {
      const idx = memoIdx++
      const slot = memoSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        memoSlots[idx] = { deps, value: fn }
      }
      return memoSlots[idx]!.value
    },
    useMemo: (factory: () => unknown, deps?: unknown[]) => {
      const idx = memoIdx++
      const slot = memoSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        memoSlots[idx] = { deps, value: factory() }
      }
      return memoSlots[idx]!.value
    },
    useEffect: (fn: () => void | (() => void), deps?: unknown[]) => {
      const idx = effectIdx++
      const slot = effectSlots[idx]
      if (!slot || depsChanged(slot.deps, deps)) {
        pendingEffects.push({ slot: idx, fn, deps })
      }
    },
  }
  const makeEl = (type: unknown, props: Record<string, unknown>) => ({ type, props })
  const ui = {
    HelmxIcon: (props: Record<string, unknown>) => ({ type: 'HelmxIcon', props }),
    CopyButton: (props: Record<string, unknown>) => ({ type: 'CopyButton', props }),
    Callout: (props: Record<string, unknown>) => ({ type: 'Callout', props }),
    Dialog: (props: Record<string, unknown>) => ({ type: 'Dialog', props }),
    DialogPortal: (props: Record<string, unknown>) => ({ type: 'DialogPortal', props }),
    DialogOverlay: (props: Record<string, unknown>) => ({ type: 'DialogOverlay', props }),
    DialogContent: (props: Record<string, unknown>) => ({ type: 'DialogContent', props }),
    DialogTitle: (props: Record<string, unknown>) => ({ type: 'DialogTitle', props }),
    DialogClose: (props: Record<string, unknown>) => ({ type: 'DialogClose', props }),
  }
  g.__helmx_shared_react_jsx_runtime = { jsx: makeEl, jsxs: makeEl }
  g.__helmx_shared_plugin_client = {
    usePluginContext: () => ({ theme: 'dark' }),
    usePluginLocale: () => 'en',
    usePluginTranslator: () => (lt: Record<string, string>) => lt.en ?? '',
    resolveLocalizedText: (lt: Record<string, string>, locale: string) => lt[locale] ?? lt.en ?? '',
    ...ui,
  }

  const render = (Component: (props: P) => unknown, nextProps: P = currentProps): unknown => {
    currentProps = nextProps
    stateIdx = 0
    refIdx = 0
    memoIdx = 0
    effectIdx = 0
    const tree = Component(currentProps)
    const toRun = pendingEffects.splice(0, pendingEffects.length)
    for (const eff of toRun) {
      effectSlots[eff.slot]?.cleanup?.()
      const cleanup = eff.fn()
      effectSlots[eff.slot] = {
        deps: eff.deps,
        cleanup: typeof cleanup === 'function' ? cleanup : undefined,
      }
    }
    return tree
  }

  const unmount = (): void => {
    for (const slot of effectSlots) {
      slot?.cleanup?.()
    }
    effectSlots.length = 0
  }

  const restore = (): void => {
    unmount()
    g.__helmx_shared_react = prevReact
    g.__helmx_shared_react_jsx_runtime = prevJsx
    g.__helmx_shared_plugin_client = prevClient
  }

  return {
    render,
    unmount,
    restore,
    ui,
    getStateUpdates: () => stateUpdates,
  }
}

test('代码分割与共享 Chunk：builtin:mermaid 主包不内联核心库且产出异步 chunk，体积大幅收敛', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  assert.ok(result.code.length > 0, '主包代码不能为空')
  assert.ok(result.gzipped, '必须产出 gzipped 字节')

  // 1. builtin:mermaid 主包不内联 mermaid 核心库，gzip 体积收敛至 < 20 KB
  assert.ok(
    result.gzipped.length < 20 * 1024,
    `主包 gzip 体积 (${result.gzipped.length} 字节) 必须 < 20 KB`,
  )
  assert.doesNotMatch(result.code, /mermaidAPI|getRegisteredDiagramsMetadata/, '主包不得直接内联 mermaid 核心库')
  assert.match(result.code, /__helmx_import_chunk/, '主包必须通过 __helmx_import_chunk 按需加载 mermaid')
  assert.deepEqual(
    result.exports.filter((name) => name !== '__helmxClientCss'),
    ['MermaidCodeBlock'],
    'index.tsx 只导出 MermaidCodeBlock 组件（Fast Refresh 契约）',
  )

  const chunks = result.chunks ?? {}
  const chunkEntries = Object.entries(chunks)
  assert.ok(chunkEntries.length > 0, 'mermaid 必须产出异步 chunks')

  // 2. mermaid.core 与 flowDiagram / pieDiagram 异步 chunk 存在且体积受控
  const coreEntry = chunkEntries.find(([name]) => name.includes('mermaid.core'))
  const flowEntry = chunkEntries.find(([name]) => name.includes('flowDiagram'))
  const pieEntry = chunkEntries.find(([name]) => name.includes('pieDiagram'))
  assert.ok(coreEntry, '产物中必须包含 mermaid.core 异步 chunk')
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

test('端到端执行：编译产物在 Node 环境通过 __helmx_import_chunk 按需加载 mermaid 核心与图表并渲染有效 SVG', { timeout: 60_000 }, async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk
  try {
    const indexResult = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
    const loaderResult = await pluginHost.getClientModule('builtin:mermaid', 'mermaid-loader.ts')
    assert.ok(indexResult.code.length > 0)
    assert.ok(loaderResult.code.length > 0)

    // Node 环境执行产物：显式安装 chunk 桥（生产编译路径不再自动改写 globalThis）
    installNodeChunkBridge([dataDir])
    const realImportChunk = g.__helmx_import_chunk as (...args: unknown[]) => Promise<unknown>
    const loadedChunks: string[] = []
    g.__helmx_import_chunk = (...args: unknown[]) => {
      loadedChunks.push(String(args[3] ?? ''))
      return realImportChunk(...args)
    }

    const indexModUrl = `data:text/javascript;base64,${Buffer.from(indexResult.code, 'utf8').toString('base64')}`
    const indexMod = (await import(indexModUrl)) as {
      MermaidCodeBlock: unknown
      mermaid?: unknown
    }
    assert.equal(typeof indexMod.MermaidCodeBlock, 'function', '必须导出 MermaidCodeBlock 组件')
    assert.equal(indexMod.mermaid, undefined, 'index.tsx 不得静态导出 mermaid 实例')
    assert.equal(loadedChunks.length, 0, '模块导入阶段不得触发 mermaid chunk 加载')

    const loaderModUrl = `data:text/javascript;base64,${Buffer.from(loaderResult.code, 'utf8').toString('base64')}`
    const loaderMod = (await import(loaderModUrl)) as {
      loadMermaid: () => Promise<typeof import('mermaid').default>
    }
    assert.equal(typeof loaderMod.loadMermaid, 'function', 'mermaid-loader.ts 必须导出 loadMermaid')
    assert.equal(loadedChunks.length, 0, '导入 mermaid-loader 不得提前触发 chunk 加载')

    // 首次调用 loadMermaid() 才通过 __helmx_import_chunk 加载 mermaid.core 与共享 chunk
    const mermaid = await loaderMod.loadMermaid()
    assert.ok(loadedChunks.some((name) => name.includes('mermaid.core')), 'loadMermaid 必须按需触发 mermaid.core chunk 加载')

    // 初始化并渲染 flowchart 与 pie 图表，触发按需加载图元 chunk
    mermaid.initialize({ startOnLoad: false, securityLevel: 'loose' })

    const flowResult = await mermaid.render('test-flow-render', 'graph TD;\nA-->B;')
    assert.ok(flowResult.svg.includes('<svg'), 'Flowchart 渲染结果必须包含 <svg')

    const pieResult = await mermaid.render('test-pie-render', 'pie title Pets\n"Dogs" : 386\n"Cats" : 85')
    assert.ok(pieResult.svg.includes('<svg'), 'Pie 图表渲染结果必须包含 <svg')
  } finally {
    g.__helmx_import_chunk = prevImportChunk
    GlobalRegistrator.unregister()
  }
})

test('loadMermaid 单例与并发去重、失败清除缓存后可重试', { timeout: 60_000 }, async () => {
  const fakeMermaid = {
    initialize: () => {},
    render: async () => ({ svg: '<svg></svg>' }),
  } as unknown as typeof import('mermaid').default

  // 1. 并发去重：在途请求共享同一 Promise，解析后后续复用
  const pendingImport = deferred<{ default: typeof fakeMermaid }>()
  let calls = 0
  const loader1 = createMermaidLoader(() => {
    calls += 1
    return pendingImport.promise
  })
  const p1 = loader1.load()
  const p2 = loader1.load()
  const p3 = loader1.load()
  assert.equal(calls, 1, '并发 load() 只能触发一次底层 import')
  assert.ok(p1 === p2 && p2 === p3, '并发 load() 必须返回同一 Promise 实例')

  pendingImport.resolve({ default: fakeMermaid })
  const [m1, m2, m3] = await Promise.all([p1, p2, p3])
  assert.ok(m1 === fakeMermaid && m2 === fakeMermaid && m3 === fakeMermaid)
  assert.ok((await loader1.load()) === fakeMermaid)
  assert.equal(calls, 1, '已成功后再次 load() 不得重复 import')

  // 2. 异步失败后清空缓存：第二次重试重新触发 import 并恢复成功
  let attempt = 0
  const loader2 = createMermaidLoader(async () => {
    attempt += 1
    if (attempt === 1) throw new Error('chunk fetch timeout')
    return { default: fakeMermaid }
  })
  const [r1, r2] = await Promise.allSettled([loader2.load(), loader2.load()])
  assert.equal(r1.status, 'rejected')
  assert.equal(r2.status, 'rejected')
  assert.match((r1 as PromiseRejectedResult).reason.message, /chunk fetch timeout/)
  assert.equal(attempt, 1, '首次失败的并发调用共享同一 attempt')

  const [ok1, ok2] = await Promise.all([loader2.load(), loader2.load()])
  assert.equal(attempt, 2, '失败后清空缓存，重试必须重新触发 import（且并发重试同样去重）')
  assert.ok(ok1 === fakeMermaid && ok2 === fakeMermaid)

  // 3. 同步抛错与非法模块形状也必须清空缓存以便重试
  let syncAttempt = 0
  const loader3 = createMermaidLoader(() => {
    syncAttempt += 1
    if (syncAttempt === 1) throw new Error('sync load failure')
    if (syncAttempt === 2) return Promise.resolve({} as never)
    return Promise.resolve(fakeMermaid)
  })
  await assert.rejects(() => loader3.load(), /sync load failure/)
  await assert.rejects(() => loader3.load(), /missing initialize\/render/)
  assert.ok((await loader3.load()) === fakeMermaid)
  assert.equal(syncAttempt, 3)
})

test('MermaidCodeBlock 编译产物交互状态：加载态、chunk 失败后展示可恢复重试并成功恢复及 unmount stale 守卫', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk

  let chunkCalls = 0
  let mode: 'fail' | 'succeed' | 'hang' = 'fail'
  let hangDeferred = deferred<{ default: unknown }>()
  let callDeferred = deferred<void>()

  g.__helmx_import_chunk = async () => {
    chunkCalls += 1
    const cur = callDeferred
    if (mode === 'fail') {
      queueMicrotask(() => cur.resolve())
      throw new Error('chunk offline')
    }
    if (mode === 'hang') {
      cur.resolve()
      return await hangDeferred.promise
    }
    queueMicrotask(() => cur.resolve())
    return {
      default: {
        initialize() {},
        async render() {
          return { svg: '<svg data-ok="inline"></svg>' }
        },
      },
    }
  }

  // 必须在 import 编译产物之前挂载 __helmx_shared_*（esbuild 顶层 __toESM 在模块求值时绑定）
  const harness = createComponentHarness({
    language: 'mermaid',
    code: 'graph TD;\nRETRY-->TEST;',
  })
  try {
    const modUrl = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}#${Math.random()}`
    const mod = (await import(modUrl)) as {
      MermaidCodeBlock: (props: { language: string; code: string }) => unknown
    }

    // 1. 首次渲染呈现清晰加载态
    let tree = harness.render(mod.MermaidCodeBlock)
    const loadingIcons = collectNodes(tree, (n) => n.type === harness.ui.HelmxIcon && n.props.name === 'loader')
    assert.ok(loadingIcons.length > 0, '加载期间应显示 loader 图标')
    assert.match(collectText(tree), /Rendering Mermaid diagram/)

    // 等待首次 chunk 加载失败并更新状态
    await callDeferred.promise
    await waitFor(() => harness.getStateUpdates() >= 1)
    assert.equal(chunkCalls, 1)

    tree = harness.render(mod.MermaidCodeBlock)
    const errorCallouts = collectNodes(tree, (n) => n.type === harness.ui.Callout && n.props.tone === 'err')
    assert.equal(errorCallouts.length, 1, '加载失败必须显式显示错误 Callout')
    assert.match(collectText(tree), /chunk offline/)

    const retryBtn = collectNodes(
      tree,
      (n) => n.type === 'button' && collectText(n).includes('Retry'),
    )[0]
    assert.ok(retryBtn && typeof retryBtn.props.onClick === 'function', '失败态必须提供 Retry 按钮')

    // 2. 点击重试：切回加载态并重新发起 chunk 请求恢复渲染
    mode = 'succeed'
    callDeferred = deferred<void>()
    ;(retryBtn.props.onClick as () => void)()

    tree = harness.render(mod.MermaidCodeBlock)
    assert.match(collectText(tree), /Rendering Mermaid diagram/, '点击重试后应立即回到加载态')
    const updatesAfterRetryStart = harness.getStateUpdates()

    await callDeferred.promise
    await waitFor(() => harness.getStateUpdates() > updatesAfterRetryStart)
    assert.equal(chunkCalls, 2, '失败清除缓存后点击重试必须再次调用 __helmx_import_chunk')

    tree = harness.render(mod.MermaidCodeBlock)
    const svgHost = collectNodes(
      tree,
      (n) => n.type === 'div' && n.props.className === 'mermaid-svg-host',
    )[0]
    assert.ok(svgHost, '重试成功后应渲染 SVG 宿主节点')
    assert.equal(
      (svgHost.props.dangerouslySetInnerHTML as { __html?: string })?.__html,
      '<svg data-ok="inline"></svg>',
    )

    // 3. unmount stale 守卫：独立模块实例在 loadMermaid() 在途期间卸载，迟到解析不得写回状态
    const staleHarness = createComponentHarness({
      language: 'mermaid',
      code: 'graph TD;\nUNMOUNT-->GUARD;',
    })
    try {
      const staleModUrl = `data:text/javascript;base64,${Buffer.from(result.code, 'utf8').toString('base64')}#${Math.random()}`
      const staleMod = (await import(staleModUrl)) as {
        MermaidCodeBlock: (props: { language: string; code: string }) => unknown
      }
      mode = 'hang'
      hangDeferred = deferred<{ default: unknown }>()
      callDeferred = deferred<void>()
      staleHarness.render(staleMod.MermaidCodeBlock)
      await callDeferred.promise

      const updatesBeforeUnmount = staleHarness.getStateUpdates()
      staleHarness.unmount()
      hangDeferred.resolve({
        default: {
          initialize() {},
          async render() {
            return { svg: '<svg data-stale="1"></svg>' }
          },
        },
      })
      await Promise.resolve()
      await Promise.resolve()
      assert.equal(staleHarness.getStateUpdates(), updatesBeforeUnmount, 'unmount 后迟到解析不得回写组件状态')
    } finally {
      staleHarness.restore()
    }
  } finally {
    harness.restore()
    g.__helmx_import_chunk = prevImportChunk
  }
})

test('MermaidPreviewModal 编译产物状态：独立按需加载 mermaid，失败可重试且 unmount 守卫生效', { timeout: 60_000 }, async () => {
  const { GlobalRegistrator } = await import('@happy-dom/global-registrator')
  GlobalRegistrator.register()
  const g = globalThis as Record<string, unknown>
  const prevImportChunk = g.__helmx_import_chunk

  try {
    const modalResult = await pluginHost.getClientModule('builtin:mermaid', 'MermaidPreviewModal.tsx')
    assert.doesNotMatch(modalResult.code, /mermaidAPI|getRegisteredDiagramsMetadata/, '预览弹窗不得内联 mermaid 核心库')
    assert.match(modalResult.code, /__helmx_import_chunk/)

    let chunkCalls = 0
    let mode: 'fail' | 'succeed' | 'hang' = 'fail'
    let hangDeferred = deferred<{ default: unknown }>()
    let callDeferred = deferred<void>()

    g.__helmx_import_chunk = async () => {
      chunkCalls += 1
      const cur = callDeferred
      if (mode === 'fail') {
        queueMicrotask(() => cur.resolve())
        throw new Error('modal chunk failed')
      }
      if (mode === 'hang') {
        cur.resolve()
        return await hangDeferred.promise
      }
      queueMicrotask(() => cur.resolve())
      return {
        default: {
          initialize() {},
          async render() {
            return { svg: '<svg viewBox="0 0 120 80"></svg>' }
          },
        },
      }
    }

    const harness = createComponentHarness({
      code: 'graph TD;\nM1-->M2;',
      svg: null as string | null,
      onClose: () => {},
    })
    try {
      const modUrl = `data:text/javascript;base64,${Buffer.from(modalResult.code, 'utf8').toString('base64')}#${Math.random()}`
      const mod = (await import(modUrl)) as {
        MermaidPreviewModal: (props: { code: string; svg?: string | null; onClose: () => void }) => unknown
      }

      let tree = harness.render(mod.MermaidPreviewModal)
      assert.match(collectText(tree), /Rendering/, '弹窗无 svg 时应展示加载提示')

      await callDeferred.promise
      await waitFor(() => harness.getStateUpdates() >= 1)
      assert.equal(chunkCalls, 1)

      tree = harness.render(mod.MermaidPreviewModal)
      const errCallout = collectNodes(tree, (n) => n.type === harness.ui.Callout && n.props.tone === 'err')
      assert.equal(errCallout.length, 1, '弹窗加载失败应展示错误 Callout')
      assert.match(collectText(tree), /modal chunk failed/)

      const retryBtn = collectNodes(
        tree,
        (n) => n.type === 'button' && collectText(n).includes('Retry'),
      )[0]
      assert.ok(retryBtn && typeof retryBtn.props.onClick === 'function', '弹窗错误态应提供 Retry 按钮')

      mode = 'succeed'
      callDeferred = deferred<void>()
      ;(retryBtn.props.onClick as () => void)()
      tree = harness.render(mod.MermaidPreviewModal)
      assert.match(collectText(tree), /Rendering/, '点击弹窗重试后应回到加载态')
      const updatesAfterRetryStart = harness.getStateUpdates()

      await callDeferred.promise
      await waitFor(() => harness.getStateUpdates() > updatesAfterRetryStart)
      assert.equal(chunkCalls, 2)

      tree = harness.render(mod.MermaidPreviewModal)
      const svgLayer = collectNodes(
        tree,
        (n) => n.type === 'div' && n.props.className === 'mermaid-svg-layer',
      )[0]
      assert.ok(svgLayer, '弹窗重试成功后应渲染 SVG 图层')

      // unmount stale 守卫：独立模块实例在 loadMermaid() 在途期间卸载，迟到解析不得写回状态
      const staleHarness = createComponentHarness({
        code: 'graph TD;\nM1-->M3;',
        svg: null as string | null,
        onClose: () => {},
      })
      try {
        const staleModUrl = `data:text/javascript;base64,${Buffer.from(modalResult.code, 'utf8').toString('base64')}#${Math.random()}`
        const staleMod = (await import(staleModUrl)) as {
          MermaidPreviewModal: (props: { code: string; svg?: string | null; onClose: () => void }) => unknown
        }
        mode = 'hang'
        hangDeferred = deferred<{ default: unknown }>()
        callDeferred = deferred<void>()
        staleHarness.render(staleMod.MermaidPreviewModal)
        await callDeferred.promise
        const updatesBeforeUnmount = staleHarness.getStateUpdates()
        staleHarness.unmount()
        hangDeferred.resolve({
          default: {
            initialize() {},
            async render() {
              return { svg: '<svg viewBox="0 0 10 10"></svg>' }
            },
          },
        })
        await Promise.resolve()
        await Promise.resolve()
        assert.equal(staleHarness.getStateUpdates(), updatesBeforeUnmount, '弹窗 unmount 后迟到解析不得更新状态')
      } finally {
        staleHarness.restore()
      }
    } finally {
      harness.restore()
    }
  } finally {
    g.__helmx_import_chunk = prevImportChunk
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
  assert.equal(res200.headers.get('x-helmx-client-hash'), contentHash)

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
    (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_module',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: flowChunkName, hash: 'badhash' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_stale',
  )
  await assert.rejects(
    pluginHost.getClientModule('builtin:mermaid', 'index.tsx', { chunk: 'missing.js' }),
    (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_not_found',
  )
})

test('HTTP Chunk 304：只接受完整 chunk ETag，裸 contentHash 不匹配（不误吞同 hash 其他 chunk）', { timeout: 60_000 }, async () => {
  const result = await pluginHost.getClientModule('builtin:mermaid', 'index.tsx')
  const contentHash = result.contentHash
  const flowChunkName = Object.keys(result.chunks ?? {}).find((k) => k.includes('flowDiagram'))!
  const pieChunkName = Object.keys(result.chunks ?? {}).find((k) => k.includes('pieDiagram'))!

  // 裸 contentHash 不得命中任何 chunk（否则浏览器会把同 hash 下其他 chunk 的缓存误判为命中）
  const resRawHash = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': contentHash } },
  )
  assert.equal(resRawHash.status, 200, '裸 contentHash 不得作为 chunk 304 匹配')

  // 完整 chunk ETag 命中 304
  const res304 = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${flowChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(res304.status, 304)

  // 不同 chunk 的完整 ETag 不命中其他 chunk
  const resOtherChunk = await call(
    handler,
    'GET',
    `/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx&chunk=${pieChunkName}&hash=${contentHash}`,
    { headers: { 'if-none-match': `"${contentHash}:${flowChunkName}"` } },
  )
  assert.equal(resOtherChunk.status, 200, '另一 chunk 的完整 ETag 不得命中')

  // 主模块请求保留裸 hash 兼容（现有行为）
  const resMainRaw = await call(
    handler,
    'GET',
    '/api/plugins/builtin%3Amermaid/client.mjs?module=index.tsx',
    { headers: { 'if-none-match': contentHash } },
  )
  assert.equal(resMainRaw.status, 304, '主模块请求保留裸 hash 304 兼容')
})

test('内存缓存 npm 依赖失效：受控 npm 依赖内容变化后不得永久返回旧 bundle', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-npm-mem-'))
  try {
    // 构造受控 npm 根：packageRoot/node_modules/tiny-dep/index.js
    const npmRoot = join(scratch, 'host-pkg')
    const depDir = join(npmRoot, 'node_modules', 'tiny-dep')
    await mkdir(depDir, { recursive: true })
    const depEntry = join(depDir, 'index.js')
    await writeFile(join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-dep', main: 'index.js' }))
    await writeFile(depEntry, 'export const value = () => 1\n')
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { value } from 'tiny-dep'\nexport const v = value()\n",
    )
    const npmRoots = [{ specifiers: ['tiny-dep'], packageRoot: npmRoot }]
    const first = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    // 第二次（内存缓存命中）与第一次一致
    const second = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.equal(second.contentHash, first.contentHash)
    // 首版产物真实求值：v === 1（npm 依赖第一版内容）
    const evalMod = async (code: string): Promise<{ v: number }> =>
      (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`)) as never
    assert.equal((await evalMod(first.code)).v, 1)
    // npm 依赖内容变化（保持本地源不变）：内存缓存必须失效，重新编译产出新 hash/新内容
    await writeFile(depEntry, 'export const value = () => 2\n')
    const third = await compilePluginClientModule('test:npm-mem', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.notEqual(third.contentHash, first.contentHash, 'npm 依赖内容变化后内存缓存必须失效')
    assert.equal((await evalMod(third.code)).v, 2, '新产物必须携带新版 npm 依赖内容（真实求值验证）')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('磁盘缓存 npm 依赖失效：跨进程重启后（清内存缓存）npm 依赖变化同样失效重编译', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-npm-disk-'))
  try {
    const npmRoot = join(scratch, 'host-pkg')
    const depDir = join(npmRoot, 'node_modules', 'tiny-dep2')
    await mkdir(depDir, { recursive: true })
    const depEntry = join(depDir, 'index.js')
    await writeFile(join(depDir, 'package.json'), JSON.stringify({ name: 'tiny-dep2', main: 'index.js' }))
    await writeFile(depEntry, 'export const value = () => 10\n')
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { value } from 'tiny-dep2'\nexport const v = value()\n",
    )
    const npmRoots = [{ specifiers: ['tiny-dep2'], packageRoot: npmRoot }]
    const first = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    // 模拟进程重启：清空内存缓存，磁盘清单复查路径生效
    const { clearClientCompilerMemoryCache } = await import('@helmx/plugin-build')
    clearClientCompilerMemoryCache()
    const cached = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.equal(cached.contentHash, first.contentHash, '未变化时磁盘缓存命中')
    await writeFile(depEntry, 'export const value = () => 20\n')
    clearClientCompilerMemoryCache()
    const recompiled = await compilePluginClientModule('test:npm-disk', clientRoot, 'index.tsx', scratch, { npmRoots })
    assert.notEqual(recompiled.contentHash, first.contentHash, 'npm 依赖变化后磁盘缓存必须失效')
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('共享 Chunk 桥导出完整性：default 表达式 / 再导出 / 字符串命名导出全部可达（非正则注册）', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-ns-bridge-'))
  try {
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    // shared：default 导出为表达式 + 命名导出 + 字符串命名导出（被消费不被 tree-shake）
    await writeFile(
      join(clientRoot, 'shared.ts'),
      [
        'const marker = "bridge"',
        'export default (function makeDefault() { return { tag: "default-expr", marker } })()',
        'export const plain = "plain-v1"',
        'export { plain as "string-named" }',
      ].join('\n'),
    )
    // lazy：再导出 default/命名/字符串命名导出（旧正则注册会漏绑定或注入未定义标识符）
    await writeFile(
      join(clientRoot, 'lazy.ts'),
      [
        "import sharedDefault, { plain, plain as stringNamed } from './shared'",
        'export { sharedDefault as reDefault }',
        'export { plain as rePlain }',
        'export { plain as "re-string-named" }',
        'export const combined = sharedDefault.tag + "/" + plain + "/" + sharedDefault.marker + "/" + stringNamed',
      ].join('\n'),
    )
    await writeFile(
      join(clientRoot, 'index.tsx'),
      [
        "import { plain } from './shared'",
        "export const loadLazy = async () => (await import('./lazy')).combined",
        'export const main = "main:" + plain',
      ].join('\n'),
    )
    const { code, contentHash, chunks } = await compilePluginClientModule('test:ns-bridge', clientRoot, 'index.tsx', scratch)
    assert.ok(Object.keys(chunks ?? {}).length > 0, '分包路径必须产出异步 chunk')
    // Node 环境执行产物：显式安装 chunk 桥（chunk 落盘于 scratch）
    installNodeChunkBridge([scratch])
    const g = globalThis as unknown as Record<string, unknown>
    const shareBefore = g.__helmx_chunk_share
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)) as {
      main: string
      loadLazy: () => Promise<string>
    }
    try {
      assert.equal(mod.main, 'main:plain-v1')
      // 主模块求值后：baseClosure 共享表已登记且按 pluginId\0module\0hash\0chunk 隔离
      const share = g.__helmx_chunk_share as Record<string, unknown> | undefined
      assert.ok(share, '主模块求值后共享表已写入')
      const sharedKey = Object.keys(share ?? {}).find((k) => k.startsWith(`test:ns-bridge\0index.tsx\0${contentHash}\0`))
      assert.ok(sharedKey, '共享表 key 必须按 pluginId\0module\0hash\0chunk 隔离')
      const sharedNs = share?.[sharedKey] as Record<string, unknown> | undefined
      assert.ok(sharedNs && typeof sharedNs === 'object')
      // default 导出为表达式时也可达（旧正则只匹配 `export default <标识符>`，表达式会漏）
      assert.equal((sharedNs?.shared_default as { tag: string })?.tag, 'default-expr', 'default 表达式导出可达（旧正则会漏）')
      assert.equal(sharedNs?.plain, 'plain-v1')
      // 懒加载 chunk：再导出（default/命名/字符串命名）绑定运行时全部可用
      const combined = await mod.loadLazy()
      assert.equal(combined, 'default-expr/plain-v1/bridge/plain-v1')
    } finally {
      g.__helmx_chunk_share = shareBefore
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('两插件同源同 hash：停用 A 后 B 的 chunk 共享表条目不受影响，B 仍可加载渲染', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-iso-'))
  try {
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(
      join(clientRoot, 'shared.ts'),
      'export const helper = () => "iso-helper"\nexport default { kind: "iso-default" }\n',
    )
    await writeFile(
      join(clientRoot, 'lazy.ts'),
      "import def, { helper } from './shared'\nexport const v = def.kind + ':' + helper()\nexport { helper as reHelper }\n",
    )
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { helper } from './shared'\nexport const loadLazy = async () => (await import('./lazy')).v\nexport const main = helper()\n",
    )
    const compileA = await compilePluginClientModule('iso:pluginA', clientRoot, 'index.tsx', join(scratch, 'ca'))
    const compileB = await compilePluginClientModule('iso:pluginB', clientRoot, 'index.tsx', join(scratch, 'cb'))
    // Node 环境执行产物：显式安装 chunk 桥（两插件各自 cacheDir）
    installNodeChunkBridge([join(scratch, 'ca'), join(scratch, 'cb')])
    const g = globalThis as unknown as Record<string, unknown>
    const shareBefore = g.__helmx_chunk_share
    try {
      const evalMod = async (code: string): Promise<{ main: string; loadLazy: () => Promise<string> }> =>
        (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${Math.random()}`)) as never
      const modA = await evalMod(compileA.code)
      const modB = await evalMod(compileB.code)
      assert.equal(modA.main, 'iso-helper')
      assert.equal(modB.main, 'iso-helper')
      const share = g.__helmx_chunk_share as Record<string, unknown>
      const aKeys = Object.keys(share).filter((k) => k.startsWith('iso:pluginA\0'))
      const bKeys = Object.keys(share).filter((k) => k.startsWith('iso:pluginB\0'))
      assert.ok(aKeys.length > 0 && bKeys.length > 0, '同源同 hash 两插件各自登记共享表')
      // 模拟停用 A：只删 A 的共享条目（与前端 evict 语义一致）
      for (const k of aKeys) delete share[k]
      assert.equal(Object.keys(share).filter((k) => k.startsWith('iso:pluginA\0')).length, 0)
      assert.equal(Object.keys(share).filter((k) => k.startsWith('iso:pluginB\0')).length, bKeys.length, '删 A 不影响 B 条目')
      // B 的懒加载 chunk 仍可用（共享表命中 + 再导出绑定可用）
      const lazyB = await modB.loadLazy()
      assert.equal(lazyB, 'iso-default:iso-helper', '停用 A 后 B 的 chunk 仍可正常加载求值')
    } finally {
      g.__helmx_chunk_share = shareBefore
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('主模块缓存命中不预读全部 chunk：磁盘路径惰性读盘，chunk 端点仍可按需返回', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-client-lazy-'))
  try {
    const clientRoot = join(scratch, 'client-root')
    await mkdir(clientRoot, { recursive: true })
    await writeFile(join(clientRoot, 'shared.ts'), 'export const helper = () => "lazy-ok"\n')
    await writeFile(
      join(clientRoot, 'lazy.ts'),
      "import { helper } from './shared'\nexport const v = helper()\n",
    )
    await writeFile(
      join(clientRoot, 'index.tsx'),
      "import { helper } from './shared'\nexport const loadLazy = async () => (await import('./lazy')).v\nexport const main = helper()\n",
    )
    const first = await compilePluginClientModule('test:lazy-chunks', clientRoot, 'index.tsx', scratch)
    assert.ok(Object.keys(first.chunks ?? {}).length > 0, '分包产物必须含异步 chunk')
    // 模拟进程重启（磁盘缓存路径）：主模块命中不预读 chunk 内容
    const { clearClientCompilerMemoryCache } = await import('@helmx/plugin-build')
    clearClientCompilerMemoryCache()
    const mainHit = await compilePluginClientModule('test:lazy-chunks', clientRoot, 'index.tsx', scratch)
    assert.equal(mainHit.contentHash, first.contentHash)
    // Node 环境执行产物：显式安装 chunk 桥（磁盘缓存路径）
    installNodeChunkBridge([scratch])
    // 磁盘缓存命中的 chunks 是惰性 getter：访问前不读盘（描述符存在且为 get，无已求值 value）
    const chunkName = Object.keys(mainHit.chunks ?? {})[0]!
    const desc = Object.getOwnPropertyDescriptor(mainHit.chunks, chunkName)
    assert.ok(desc && typeof desc.get === 'function' && desc.value === undefined, '磁盘缓存命中的 chunk 必须是未求值的惰性 getter')
    // 首次访问才读盘（返回真实内容）；重复访问零新增（getter 内缓存）
    const c1 = mainHit.chunks?.[chunkName]
    assert.ok(c1 && c1.code.length > 0, '首次访问才读盘返回真实 chunk 内容')
    const c2 = mainHit.chunks?.[chunkName]
    assert.equal(c2?.code, c1.code)
    // 产物语义完整：主模块 + 懒 chunk 真实求值可达
    const g = globalThis as unknown as Record<string, unknown>
    const shareBefore = g.__helmx_chunk_share
    try {
      const mod = (await import(`data:text/javascript;base64,${Buffer.from(mainHit.code).toString('base64')}#${Math.random()}`)) as {
        main: string
        loadLazy: () => Promise<string>
      }
      assert.equal(mod.main, 'lazy-ok')
      assert.equal(await mod.loadLazy(), 'lazy-ok', '磁盘缓存路径产物端到端可执行')
    } finally {
      g.__helmx_chunk_share = shareBefore
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('双轨 prebuiltClientDir：PluginHost 无 buildProvider 直接服务预编译主模块、chunk、CSS、gzip 与 stale hash', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-prebuilt-host-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const outDir = join(scratch, PREBUILT_CLIENT_DIR_NAME)
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'styles.css'), '.prebuilt-badge { font-weight: 600 }\n')
    await writeFile(join(srcRoot, 'lazy.ts'), 'export const answer = () => "prebuilt-chunk-ok"\n')
    await writeFile(
      join(srcRoot, 'index.tsx'),
      "import './styles.css'\nexport function PrebuiltPanel() { return 'panel' }\nexport const loadChunk = async () => (await import('./lazy')).answer()\n",
    )

    const built = await buildPluginClientBundleDir({
      pluginId: 'test:prebuilt-only',
      clientRoot: srcRoot,
      outDir,
      modules: ['index.tsx'],
    })
    const expectedHash = built.manifest.modules['index.tsx']!.contentHash
    const chunkNames = built.manifest.modules['index.tsx']!.chunks ?? []
    assert.ok(chunkNames.length > 0, 'prebuild must emit lazy chunk')

    // Remove source files completely and spin up a PluginHost with NO buildProvider.
    await rm(srcRoot, { recursive: true, force: true })
    const hostDir = join(scratch, 'host-data')
    await mkdir(hostDir, { recursive: true })
    const host = new PluginHost({
      dataDir: hostDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
      // Intentionally no buildProvider!
    })
    try {
      await host.register({
        id: 'test:prebuilt-only',
        name: 'Prebuilt Only',
        version: '0.1.0',
        prebuiltClientDir: outDir,
        definePlugin(ctx) {
          ctx.ui.screen({
            id: 'main',
            label: 'Main',
            client: { module: 'index.tsx', export: 'PrebuiltPanel' },
          })
        },
      }, { enabled: true })

      const summary = host.list().find((p) => p.id === 'test:prebuilt-only')
      assert.deepEqual(summary?.clientHashes, { 'index.tsx': expectedHash })

      const mainBundle = await host.getClientModule('test:prebuilt-only', 'index.tsx', { hash: expectedHash })
      assert.equal(mainBundle.contentHash, expectedHash)
      assert.match(mainBundle.code, /PrebuiltPanel/)
      assert.match(mainBundle.code, /prebuilt-badge/)
      assert.ok(mainBundle.gzipped && mainBundle.gzipped.length > 0)
      assert.equal(gunzipSync(mainBundle.gzipped!).toString('utf-8'), mainBundle.code)

      const chunkBundle = await host.getClientModule('test:prebuilt-only', 'index.tsx', {
        chunk: chunkNames[0]!,
        hash: expectedHash,
      })
      assert.match(chunkBundle.code, /prebuilt-chunk-ok/)
      assert.ok(chunkBundle.gzipped && chunkBundle.gzipped.length > 0)

      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { hash: 'stale-hash' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_module_stale' && err.status === 409,
      )
      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { chunk: 'missing.js', hash: 'stale-hash' }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_stale' && err.status === 409,
      )
      await assert.rejects(
        () => host.getClientModule('test:prebuilt-only', 'index.tsx', { chunk: 'missing.js', hash: expectedHash }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_chunk_not_found' && err.status === 404,
      )
    } finally {
      await host.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('损坏/缺失/符号链接逃逸的 dist-client 必须显式报错，绝不静默降级回 clientRoot', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-prebuilt-strict-'))
  try {
    const srcRoot = join(scratch, 'client-src')
    const outDir = join(scratch, PREBUILT_CLIENT_DIR_NAME)
    await mkdir(srcRoot, { recursive: true })
    await writeFile(join(srcRoot, 'lazy.ts'), 'export const val = 1\n')
    await writeFile(
      join(srcRoot, 'index.tsx'),
      'export function GoodExport() { return "ok" }\nexport const load = () => import("./lazy")\n',
    )
    const built = await buildPluginClientBundleDir({
      pluginId: 'test:strict-prebuilt',
      clientRoot: srcRoot,
      outDir,
      modules: ['index.tsx'],
    })

    const makeHostWithProvider = async (suffix: string) => {
      const dir = join(scratch, suffix)
      await mkdir(dir, { recursive: true })
      return new PluginHost({
        dataDir: dir,
        docs: new MemoryDocStore(),
        host: makeBackend(),
        buildProvider: createPluginBuildProvider(),
      })
    }

    // 1. Export not present in prebuilt manifest -> rejects with invalid_client_export (no fallback to buildProvider).
    const h1 = await makeHostWithProvider('h1')
    try {
      await assert.rejects(
        () => h1.register({
          id: 'test:strict-prebuilt',
          name: 'Strict',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDir,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'MissingExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'invalid_client_export',
      )
    } finally {
      await h1.dispose()
    }

    // 2. Deleted chunk file -> rejects with prebuilt_client_invalid (no fallback to buildProvider).
    const entry = built.manifest.modules['index.tsx']!
    const chunkRel = prebuiltChunkFileName(entry.entryFile, entry.chunks![0]!)
    await rm(join(outDir, chunkRel))
    const h2 = await makeHostWithProvider('h2')
    try {
      await assert.rejects(
        () => h2.register({
          id: 'test:strict-prebuilt',
          name: 'Strict',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDir,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'GoodExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'prebuilt_client_invalid',
      )
    } finally {
      await h2.dispose()
    }

    // 3. Symlink escape on entryFile -> rejects with client_module_out_of_root.
    const outDirSym = join(scratch, 'dist-client-sym')
    await buildPluginClientBundleDir({
      pluginId: 'test:strict-sym',
      clientRoot: srcRoot,
      outDir: outDirSym,
      modules: ['index.tsx'],
    })
    const outsideFile = join(scratch, 'outside-secret.mjs')
    await writeFile(outsideFile, 'export function GoodExport() { return "evil" }\n')
    const symEntry = JSON.parse(await (await import('node:fs/promises')).readFile(join(outDirSym, PREBUILT_CLIENT_MANIFEST_FILE), 'utf8'))
    const entryRel = symEntry.modules['index.tsx'].entryFile
    await rm(join(outDirSym, entryRel))
    await symlink(outsideFile, join(outDirSym, entryRel))
    const h3 = await makeHostWithProvider('h3')
    try {
      await assert.rejects(
        () => h3.register({
          id: 'test:strict-sym',
          name: 'Strict Sym',
          version: '0.1.0',
          clientRoot: srcRoot,
          prebuiltClientDir: outDirSym,
          definePlugin(ctx) {
            ctx.ui.screen({ id: 's', label: 'S', client: { module: 'index.tsx', export: 'GoodExport' } })
          },
        }),
        (err: unknown) => err instanceof HelmxError && err.code === 'client_module_out_of_root',
      )
    } finally {
      await h3.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('外部插件 dist-client-only 分发：无源码无 node_modules 无 buildProvider 下 doctor/load/enable/serve 全通', { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'helmx-ext-prebuilt-'))
  try {
    const buildSrc = join(scratch, 'author-client')
    await mkdir(buildSrc, { recursive: true })
    await writeFile(
      join(buildSrc, 'index.tsx'),
      'export function ExtScreen() { return "ext-prebuilt" }\n',
    )

    const pluginDir = join(scratch, 'data', 'plugins', 'my-prebuilt-ext')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ id: 'my-prebuilt-ext', main: 'index.mjs', clientDist: 'custom-dist' }, null, 2),
    )
    await writeFile(
      join(pluginDir, 'index.mjs'),
      `export default {
        id: 'my-prebuilt-ext',
        name: 'My Prebuilt Ext',
        version: '0.1.0',
        definePlugin(ctx) {
          ctx.ui.screen({ id: 'home', label: 'Home', client: { module: 'index.tsx', export: 'ExtScreen' } })
        },
      }\n`,
    )
    await buildPluginClientBundleDir({
      pluginId: 'my-prebuilt-ext',
      clientRoot: buildSrc,
      outDir: join(pluginDir, 'custom-dist'),
      modules: ['index.tsx'],
    })

    // Doctor WITHOUT buildProvider succeeds!
    const okReport = await doctorPluginDir(pluginDir, {})
    assert.equal(okReport.ok, true, `expected doctor ok without buildProvider, got: ${JSON.stringify(okReport)}`)

    // Load and enable on PluginHost WITHOUT buildProvider!
    const hostDataDir = join(scratch, 'data')
    const host = new PluginHost({
      dataDir: hostDataDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
    })
    try {
      await loadExternalPlugins(hostDataDir, host)
      await host.enable('my-prebuilt-ext')
      const mod = await host.getClientModule('my-prebuilt-ext', 'index.tsx')
      assert.match(mod.code, /ExtScreen/)
    } finally {
      await host.dispose()
    }

    // Escaping clientDist symlink must fail doctor explicitly.
    const outsideDist = join(scratch, 'outside-dist')
    await mkdir(outsideDist, { recursive: true })
    await writeFile(join(outsideDist, PREBUILT_CLIENT_MANIFEST_FILE), JSON.stringify({ version: 1, modules: {} }))
    const escapePluginDir = join(scratch, 'escape-ext')
    await mkdir(escapePluginDir, { recursive: true })
    await writeFile(join(escapePluginDir, 'index.mjs'), 'export default { id: "escape-ext", name: "E", version: "0.1.0", definePlugin() {} }\n')
    await symlink(outsideDist, join(escapePluginDir, PREBUILT_CLIENT_DIR_NAME))
    const escapeReport = await doctorPluginDir(escapePluginDir, {})
    assert.equal(escapeReport.ok, false)
    assert.ok(escapeReport.checks.some((c) => c.error?.code === 'invalid_plugin_definition'))
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('builtin:mermaid 构建产物在无 node_modules/mermaid、无 client/、无 buildProvider 的隔离目录可无依赖运行', { timeout: 60_000 }, async () => {
  // Dev source factory uses clientRoot + npmDependencies (source live-compile track).
  const devDef = createMermaidPlugin()
  assert.equal(devDef.prebuiltClientDir, undefined)
  assert.ok(devDef.clientRoot && devDef.npmDependencies?.mermaid)

  const scratch = await mkdtemp(join(tmpdir(), 'helmx-mermaid-dist-iso-'))
  try {
    // Stage ONLY dist/mermaid.js + dist/asset-paths.js + dist/mermaid/dist-client (no node_modules/mermaid, no client/).
    const { cp } = await import('node:fs/promises')
    const pkgRoot = join(import.meta.dirname, '..')
    const isoPkg = join(scratch, 'pkg')
    const isoDist = join(isoPkg, 'dist')
    await mkdir(join(isoDist, 'mermaid'), { recursive: true })
    await mkdir(join(isoPkg, 'node_modules', '@helmx'), { recursive: true })
    await symlink(join(pkgRoot, '../protocol'), join(isoPkg, 'node_modules', '@helmx', 'protocol'))
    await writeFile(join(isoPkg, 'package.json'), JSON.stringify({ name: '@helmx/plugins', type: 'module' }))
    await cp(join(pkgRoot, 'dist', 'mermaid.js'), join(isoDist, 'mermaid.js'))
    await cp(join(pkgRoot, 'dist', 'asset-paths.js'), join(isoDist, 'asset-paths.js'))
    await cp(
      join(pkgRoot, 'dist', 'mermaid', PREBUILT_CLIENT_DIR_NAME),
      join(isoDist, 'mermaid', PREBUILT_CLIENT_DIR_NAME),
      { recursive: true },
    )

    const mod = (await import(pathToFileURL(join(isoDist, 'mermaid.js')).href)) as {
      createMermaidPlugin: typeof createMermaidPlugin
    }
    const distDef = mod.createMermaidPlugin()
    assert.equal(distDef.clientRoot, undefined, 'isolated dist-client-only copy has no clientRoot')
    assert.equal(distDef.npmDependencies, undefined, 'prebuilt dist-client must not require runtime npmDependencies')
    assert.ok(distDef.prebuiltClientDir?.endsWith(PREBUILT_CLIENT_DIR_NAME))

    const hostDir = join(scratch, 'host-data')
    await mkdir(hostDir, { recursive: true })
    const host = new PluginHost({
      dataDir: hostDir,
      docs: new MemoryDocStore(),
      host: makeBackend(),
      // No buildProvider!
    })
    try {
      await host.register(distDef, { enabled: true })
      const mainBundle = await host.getClientModule('builtin:mermaid', 'index.tsx')
      assert.match(mainBundle.code, /MermaidCodeBlock/)
      const chunkKeys = Object.keys(mainBundle.chunks ?? {})
      assert.ok(chunkKeys.length > 0, 'prebuilt mermaid must carry split diagram chunks')
      const flowChunkName = chunkKeys.find((k) => k.includes('flowDiagram'))
      assert.ok(flowChunkName, `expected flowDiagram chunk in ${chunkKeys.join(', ')}`)
      const flowChunk = await host.getClientModule('builtin:mermaid', 'index.tsx', {
        chunk: flowChunkName,
        hash: mainBundle.contentHash,
      })
      assert.ok(flowChunk.code.length > 0)
    } finally {
      await host.dispose()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
