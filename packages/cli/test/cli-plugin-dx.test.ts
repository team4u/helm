/**
 * 外部插件 DX 闭环 CLI 测试：plugins doctor/reload/rescan（HTTP 映射）与
 * plugins init（本地脚手架，不访问 Hub）。
 * 真实 runCli + 模拟 Hub HTTP 契约（doctor/reload/rescan 走真实 fetch 边界）；
 * init 验证本地文件产出、非法名拒绝、非空目录保护与 --json 输出。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runCli } from '../src/index.js'

interface Hit {
  method: string
  path: string
  body?: unknown
}

async function startHub(
  routes: Record<string, (body: unknown) => { status?: number; body?: unknown }>,
): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const allRoutes: Record<string, (body: unknown) => { status?: number; body?: unknown }> = {
    'GET /api/actions': () => ({ body: [] }),
    ...routes,
  }
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8')
      let body: unknown
      if (rawBody) {
        try {
          body = JSON.parse(rawBody)
        } catch {
          body = rawBody
        }
      }
      const full = `${req.method} ${req.url}`
      hits.push({ method: req.method!, path: req.url!, body })
      const handler = allRoutes[full]
      if (!handler) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${full}` } }))
        return
      }
      const result = handler(body)
      const status = result.status ?? 200
      if (result.body === undefined) {
        res.writeHead(status)
        res.end()
        return
      }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address !== null && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

async function run(
  argv: string[],
  hubUrl: string,
  dataDir: string,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env: { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test' },
    stdout: (t) => (out += t),
    stderr: (t) => (err += t),
  })
  return { code, out, err }
}

const DOCTOR_REPORT = {
  dir: '/abs/plugin',
  pluginId: 'p1',
  ok: true,
  checks: [{ id: 'manifest', label: 'x' }],
}

test('plugins doctor：POST /api/plugins/doctor，--dir/--path/位置参数/id 均可', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/doctor': (body) => {
      if ((body as { id?: string }).id !== undefined) {
        assert.deepEqual(body, { id: 'my-pl' })
        return { body: { ...DOCTOR_REPORT, requestedId: 'my-pl' } }
      }
      assert.deepEqual(body, { path: '/abs/plugin' })
      return { body: DOCTOR_REPORT }
    },
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    // --dir（兼容别名）
    const r1 = await run(['plugins', 'doctor', '--dir', '/abs/plugin', '--json'], hub.url, dataDir)
    assert.equal(r1.code, 0, r1.err)
    assert.deepEqual(JSON.parse(r1.out), DOCTOR_REPORT)

    // --path（方案命名）
    const r2 = await run(['plugins', 'doctor', '--path', '/abs/plugin', '--json'], hub.url, dataDir)
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(JSON.parse(r2.out), DOCTOR_REPORT)

    // 位置参数为绝对路径 -> path 目标
    const r3 = await run(['plugins', 'doctor', '/abs/plugin', '--json'], hub.url, dataDir)
    assert.equal(r3.code, 0, r3.err)
    assert.deepEqual(JSON.parse(r3.out), DOCTOR_REPORT)

    // 位置参数为插件 id -> id 目标（方案 doctor [<id>]）
    const r4 = await run(['plugins', 'doctor', 'my-pl', '--json'], hub.url, dataDir)
    assert.equal(r4.code, 0, r4.err)
    assert.deepEqual(JSON.parse(r4.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

    // --id 显式 flag
    const r5 = await run(['plugins', 'doctor', '--id', 'my-pl', '--json'], hub.url, dataDir)
    assert.equal(r5.code, 0, r5.err)
    assert.deepEqual(JSON.parse(r5.out), { ...DOCTOR_REPORT, requestedId: 'my-pl' })

    assert.equal(hub.hits.length, 5)
    assert.deepEqual(hub.hits[0]!.body, { path: '/abs/plugin' })
    assert.deepEqual(hub.hits[3]!.body, { id: 'my-pl' })

    // 缺目标显式报错（不请求 Hub）
    const r6 = await run(['plugins', 'doctor', '--json'], hub.url, dataDir)
    assert.notEqual(r6.code, 0)
    assert.equal(hub.hits.length, 5, '缺参不应发起请求')

    // id 与路径互斥
    const r7 = await run(['plugins', 'doctor', 'my-pl', '--path', '/abs/plugin'], hub.url, dataDir)
    assert.notEqual(r7.code, 0)
    assert.equal(hub.hits.length, 5)
  } finally {
    await hub.close()
  }
})

test('plugins doctor：人类模式逐项输出；预检失败退出码非零', { timeout: 60_000 }, async () => {
  const failing = {
    dir: '/abs/bad',
    pluginId: 'bad',
    ok: false,
    checks: [
      { id: 'manifest', label: '清单与入口解析' },
      {
        id: 'backend',
        label: '后端模块代际导入',
        error: { code: 'plugin_load_failed', message: '语法错误' },
      },
    ],
  }
  const hub = await startHub({
    'POST /api/plugins/doctor': () => ({ body: failing }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const r = await run(['plugins', 'doctor', '--dir', '/abs/bad'], hub.url, dataDir)
    assert.notEqual(r.code, 0, 'ok=false 应非零退出')
    assert.ok(r.out.includes('[ok] manifest'))
    assert.ok(r.out.includes('[!!] backend'))
    assert.ok(r.out.includes('plugin_load_failed'))
    assert.ok(r.out.includes('结论：存在失败项'))
  } finally {
    await hub.close()
  }
})

test('plugins reload：POST /api/plugins/:id/reload（含 URI 编码）', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/my%3Apl/reload': () => ({
      body: {
        pluginId: 'my:pl',
        wasEnabled: true,
        generation: 2,
        summary: { id: 'my:pl', name: 'my:pl', locked: false, enabled: true, hooks: [], actions: ['a'], tools: [] },
      },
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const r = await run(['plugins', 'reload', 'my:pl', '--json'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as { pluginId: string; generation: number }
    assert.equal(body.pluginId, 'my:pl')
    assert.equal(body.generation, 2)
    assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/reload')
    assert.equal(hub.hits[0]!.method, 'POST')
  } finally {
    await hub.close()
  }
})

test('plugins rescan：POST /api/plugins/rescan', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/rescan': () => ({
      body: {
        registered: ['new-one'],
        skipped: 1,
        plugins: [{ id: 'new-one', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }],
      },
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const r = await run(['plugins', 'rescan', '--json'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as { registered: string[]; skipped: number }
    assert.deepEqual(body.registered, ['new-one'])
    assert.equal(hub.hits[0]!.path, '/api/plugins/rescan')
  } finally {
    await hub.close()
  }
})

test('plugins install：source 透传、--enable 请求体、人类模式输出与空 source 拒绝', { timeout: 60_000 }, async () => {
  const npmSource = 'npm:helm-plugin-foo@^1.2.0'
  const installBody = {
    record: {
      id: 'inst-1',
      pluginId: 'helm-plugin-foo',
      source: { kind: 'npm', raw: npmSource, spec: 'helm-plugin-foo@^1.2.0' },
      installPath: '/data/plugins/helm-plugin-foo',
      version: '1.2.0',
      installedAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
    },
    summary: {
      id: 'helm-plugin-foo',
      name: 'helm-plugin-foo',
      locked: false,
      enabled: false,
      hooks: [],
      actions: [],
      tools: [],
      managed: { installId: 'inst-1', installedVersion: '1.2.0', installedAt: 1_700_000_000_000, source: { kind: 'npm', raw: npmSource } },
    },
  }
  const hub = await startHub({
    'POST /api/plugins/install': (body) => {
      const enable = (body as { enable?: boolean }).enable === true
      return { body: { ...installBody, summary: { ...installBody.summary, enabled: enable } } }
    },
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    // --enable：请求体携带 enable:true，人类模式回显已启用
    const r1 = await run(['plugins', 'install', npmSource, '--enable'], hub.url, dataDir)
    assert.equal(r1.code, 0, r1.err)
    assert.deepEqual(hub.hits[0]!.body, { source: npmSource, enable: true })
    assert.ok(r1.out.includes('helm-plugin-foo 1.2.0'))
    assert.ok(r1.out.includes('已启用'))

    // 缺省：请求体仅 source，回显停用与启用提示
    const r2 = await run(['plugins', 'install', npmSource, '--json'], hub.url, dataDir)
    assert.equal(r2.code, 0, r2.err)
    assert.deepEqual(hub.hits[1]!.body, { source: npmSource })
    const install = JSON.parse(r2.out) as { record: { id: string }; summary: { managed?: { installId: string } } }
    assert.equal(install.record.id, 'inst-1')
    assert.equal(install.summary.managed?.installId, 'inst-1')

    // 空 source 显式拒绝（不请求 Hub）
    const empty = await run(['plugins', 'install', '   '], hub.url, dataDir)
    assert.notEqual(empty.code, 0)
    assert.ok(empty.err.includes('source'))
    assert.equal(hub.hits.length, 2)
  } finally {
    await hub.close()
  }
})

test('plugins update：POST /api/plugins/:id/update（含 URI 编码）与人类模式输出', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/my%3Apl/update': () => ({
      body: {
        record: {
          id: 'inst-1',
          pluginId: 'my:pl',
          source: { kind: 'npm', raw: 'npm:my-pl@^1.2.0', spec: 'my-pl@^1.2.0' },
          installPath: '/data/plugins/my:pl',
          version: '1.3.0',
          installedAt: 1_700_000_000_000,
          updatedAt: 1_700_000_100_000,
        },
        summary: { id: 'my:pl', name: 'my:pl', locked: false, enabled: true, hooks: [], actions: [], tools: [] },
        changed: true,
        previousVersion: '1.2.0',
      },
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const r = await run(['plugins', 'update', 'my:pl'], hub.url, dataDir)
    assert.equal(r.code, 0, r.err)
    assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/update')
    assert.equal(hub.hits[0]!.method, 'POST')
    assert.deepEqual(hub.hits[0]!.body, {})
    assert.ok(r.out.includes('my:pl'))
    assert.ok(r.out.includes('1.2.0 -> 1.3.0'))
  } finally {
    await hub.close()
  }
})

test('plugins remove：--json 非交互；--yes 与非交互无 --yes 的确认行为', { timeout: 60_000 }, async () => {
  const hub = await startHub({
    'POST /api/plugins/my%3Apl/remove': () => ({
      body: { pluginId: 'my:pl', installPath: '/data/plugins/my:pl', wasEnabled: true, installId: 'inst-2' },
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    // --json：机器模式非交互（不由 CLI 发确认问题），直接请求
    const r1 = await run(['plugins', 'remove', 'my:pl', '--json'], hub.url, dataDir)
    assert.equal(r1.code, 0, r1.err)
    assert.equal(hub.hits[0]!.path, '/api/plugins/my%3Apl/remove')
    const remove = JSON.parse(r1.out) as { pluginId: string; wasEnabled: boolean }
    assert.equal(remove.pluginId, 'my:pl')
    assert.equal(remove.wasEnabled, true)

    // 人类模式 --yes：非交互放行，输出已移除与清理目录
    const r2 = await run(['plugins', 'remove', 'my:pl', '--yes'], hub.url, dataDir)
    assert.equal(r2.code, 0, r2.err)
    assert.equal(hub.hits[1]!.path, '/api/plugins/my%3Apl/remove')
    assert.ok(r2.out.includes('已移除 my:pl'))
    assert.ok(r2.out.includes('/data/plugins/my:pl'))

    // 人类模式无 --yes（测试环境 stdin 非 TTY）：显式拒绝且不请求 Hub
    const r3 = await run(['plugins', 'remove', 'my:pl'], hub.url, dataDir)
    assert.notEqual(r3.code, 0)
    assert.ok(r3.err.includes('--yes'))
    assert.ok(r3.err.includes('confirmation_required') || r3.err.includes('移除'))
    assert.equal(hub.hits.length, 2, '未确认前不得请求 Hub')

    // 缺位置参数与多余位置参数均拒绝（不请求 Hub）
    const miss = await run(['plugins', 'remove'], hub.url, dataDir)
    assert.notEqual(miss.code, 0)
    const extra = await run(['plugins', 'update', 'a', 'b'], hub.url, dataDir)
    assert.notEqual(extra.code, 0)
    assert.equal(hub.hits.length, 2)
  } finally {
    await hub.close()
  }
})

test('plugins install/update/remove：四种 source 透传与 Hub 错误信封上拋', { timeout: 60_000 }, async () => {
  const sources = [
    'npm:helm-plugin-foo@^1.2.0',
    'git:https://github.com/user/helm-plugin-foo.git@v1.2.0',
    'https://github.com/user/helm-plugin-foo.git#v1.2.0',
    '/srv/helm-plugins/foo',
    './relative-plugin',
  ]
  const seen: string[] = []
  const hub = await startHub({
    'POST /api/plugins/install': (body) => {
      seen.push((body as { source: string }).source)
      return { status: 201, body: { ok: true } }
    },
    'POST /api/plugins/bad%3Apl/remove': () => ({
      status: 404,
      body: { error: { code: 'plugin_not_managed', message: '插件非受管安装' } },
    }),
  })
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    for (const source of sources) {
      const r = await run(['plugins', 'install', source, '--json'], hub.url, dataDir)
      assert.equal(r.code, 0, `source=${source}: ${r.err}`)
    }
    assert.deepEqual(seen, sources.map((source) => source))

    // Hub 结构化错误原样上拋（code/message 保留）
    const err = await run(['plugins', 'remove', 'bad:pl', '--yes', '--json'], hub.url, dataDir)
    assert.notEqual(err.code, 0)
    const envelope = JSON.parse(err.err) as { error: { code: string; message: string } }
    assert.equal(envelope.error.code, 'plugin_not_managed')
  } finally {
    await hub.close()
  }
})

test('plugins init：本地生成骨架（默认 full 模板：plugin.json + index.ts + tsconfig.json + client/index.tsx）', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    // 无 Hub 也能执行（本地命令）：用不可达 Hub 地址证明不访问
    const r = await run(['plugins', 'init', 'my-plugin', '--json'], 'http://127.0.0.1:1', dataDir)
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as { pluginId: string; dir: string; files: string[]; template: string }
    assert.equal(body.pluginId, 'my-plugin')
    assert.equal(body.template, 'full', '默认模板为 full')
    assert.ok(body.dir.startsWith(dataDir))
    for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'client/index.tsx', 'README.md']) {
      assert.ok(body.files.includes(f), `产出应含 ${f}：${JSON.stringify(body.files)}`)
    }

    const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
      id: string
      main: string
      clientRoot: string
    }
    assert.equal(manifest.id, 'my-plugin')
    assert.equal(manifest.main, 'index.ts')
    assert.equal(manifest.clientRoot, './client')
    const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
    assert.ok(index.includes(`id: 'my-plugin'`), '入口 id 与目录名一致')
    assert.ok(index.includes('definePlugin'))
    assert.ok(index.includes("module: 'index.tsx'"), 'UI 引用 client/index.tsx')
    const tsconfig = JSON.parse(await fsp.readFile(path.join(body.dir, 'tsconfig.json'), 'utf8')) as {
      compilerOptions: Record<string, unknown>
    }
    assert.ok(tsconfig.compilerOptions)
    const client = await fsp.readFile(path.join(body.dir, 'client', 'index.tsx'), 'utf8')
    assert.ok(client.includes('export function SamplePanel'))
    assert.ok(client.includes('@helm/plugin-client'), '标准模板引入宿主共享前端模块')
    assert.ok(client.includes('usePluginDoc'), '标准模板使用共享 Hook')
    assert.ok(await fsp.stat(path.join(body.dir, 'README.md')))

    // 人类模式输出后续步骤
    const r2 = await run(['plugins', 'init', 'another-one'], 'http://127.0.0.1:1', dataDir)
    assert.equal(r2.code, 0, r2.err)
    assert.ok(r2.out.includes('后续步骤'))
    assert.ok(r2.out.includes('helm plugins enable another-one'))
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins init --template minimal：仅后端探针动作，无 client 目录', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const r = await run(['plugins', 'init', 'mini-pl', '--template', 'minimal', '--json'], 'http://127.0.0.1:1', dataDir)
    assert.equal(r.code, 0, r.err)
    const body = JSON.parse(r.out) as { dir: string; files: string[]; template: string }
    assert.equal(body.template, 'minimal')
    for (const f of ['plugin.json', 'index.ts', 'tsconfig.json', 'README.md']) {
      assert.ok(body.files.includes(f))
    }
    assert.ok(!body.files.some((f) => f.startsWith('client/')), 'minimal 不生成前端文件')
    await assert.rejects(fsp.stat(path.join(body.dir, 'client')), { code: 'ENOENT' })
    const manifest = JSON.parse(await fsp.readFile(path.join(body.dir, 'plugin.json'), 'utf8')) as {
      clientRoot?: string
    }
    assert.equal(manifest.clientRoot, undefined, 'minimal 不声明 clientRoot')
    const index = await fsp.readFile(path.join(body.dir, 'index.ts'), 'utf8')
    assert.ok(index.includes("id: 'ping'"), 'minimal 含探针动作')

    // 非法模板值拒绝
    const bad = await run(['plugins', 'init', 'bad-tpl', '--template', 'huge'], 'http://127.0.0.1:1', dataDir)
    assert.notEqual(bad.code, 0)
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})

test('plugins init：非法名拒绝；非空目录默认拒绝、--force 继续', { timeout: 60_000 }, async () => {
  const dataDir = await fsp.mkdtemp(os.tmpdir() + '/helm-cli-dx-')
  try {
    const bad = await run(['plugins', 'init', 'builtin:x'], 'http://127.0.0.1:1', dataDir)
    assert.notEqual(bad.code, 0)
    const bad2 = await run(['plugins', 'init', 'bad name'], 'http://127.0.0.1:1', dataDir)
    assert.notEqual(bad2.code, 0)

    // 第一次生成；随后向同目录 init 同名插件应拒绝（非空）
    await run(['plugins', 'init', 'dup-pl'], 'http://127.0.0.1:1', dataDir)
    const dup = await run(['plugins', 'init', 'dup-pl'], 'http://127.0.0.1:1', dataDir)
    assert.notEqual(dup.code, 0)
    assert.ok(dup.err.includes('非空') || dup.err.includes('conflict'))
    // --force 继续（文件覆盖）
    const forced = await run(['plugins', 'init', 'dup-pl', '--force'], 'http://127.0.0.1:1', dataDir)
    assert.equal(forced.code, 0, forced.err)

    // --dir 自定义父目录
    const parent = path.join(dataDir, 'custom-parent')
    const r3 = await run(['plugins', 'init', 'x-pl', '--dir', parent, '--json'], 'http://127.0.0.1:1', dataDir)
    assert.equal(r3.code, 0, r3.err)
    const body3 = JSON.parse(r3.out) as { dir: string }
    assert.ok(body3.dir.startsWith(parent))
  } finally {
    await fsp.rm(dataDir, { recursive: true, force: true })
  }
})
