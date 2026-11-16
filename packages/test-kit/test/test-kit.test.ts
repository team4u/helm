/**
 * `@helm/test-kit` 单元测试：覆盖同构 DTO 工厂、异步控制工具、Node 目录与环境隔离、
 * HTTP Mock Hub 与 Git 模板夹具全部公开契约。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import {
  assertRejectsCode,
  deferred,
  jsonResponse,
  makeConversationSummary,
  makePluginSummary,
  makeProfile,
  sleep,
  waitFor,
} from '../src/index.js'
import {
  HOST_MANAGED_HELM_ENV_NAMES,
  assertRejectsCode as assertRejectsCodeNode,
  cleanupDir,
  makeTempDir,
  sanitizedHostEnv,
  useTempDir,
  waitForCondition,
} from '../src/node.js'
import { startMockHub } from '../src/http.js'
import { createGitTemplate, initGitRepo } from '../src/git.js'

const SRC_INDEX_PATH = fileURLToPath(new URL('../src/index.ts', import.meta.url))

test('src/index.ts 保持纯同构：零 node:* 运行时或类型导入', { timeout: 60_000 }, () => {
  const sourceText = readFileSync(SRC_INDEX_PATH, 'utf8')
  const sf = ts.createSourceFile(SRC_INDEX_PATH, sourceText, ts.ScriptTarget.Latest, true)
  const specifiers: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        specifiers.push(node.moduleSpecifier.text)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  assert.ok(specifiers.length > 0, '应至少包含 @helm/protocol/browser 类型导入')
  for (const spec of specifiers) {
    assert.ok(!spec.startsWith('node:'), `src/index.ts 不得导入 node:* 模块: ${spec}`)
    assert.equal(spec, '@helm/protocol/browser', `src/index.ts 仅应从 @helm/protocol/browser 导入契约: ${spec}`)
  }
})

test('DTO 工厂：makeConversationSummary / makeProfile / makePluginSummary 默认值与覆写语义', { timeout: 60_000 }, () => {
  const convDefault = makeConversationSummary()
  assert.equal(convDefault.id, 1)
  assert.equal(convDefault.title, 'conv-1')
  assert.equal(convDefault.profileId, 'assistant')
  assert.deepEqual(convDefault.tags, [])
  assert.equal(convDefault.status, 'idle')

  const convCustom = makeConversationSummary({
    id: 42,
    status: 'working',
    ownedBy: 'helm',
    tags: ['worker'],
  })
  assert.equal(convCustom.id, 42)
  assert.equal(convCustom.title, 'conv-42')
  assert.equal(convCustom.status, 'working')
  assert.equal(convCustom.ownedBy, 'helm')
  assert.deepEqual(convCustom.tags, ['worker'])

  const convTitled = makeConversationSummary({ id: 7, title: '主屏会话' })
  assert.equal(convTitled.title, '主屏会话')

  const profileDefault = makeProfile()
  assert.deepEqual(profileDefault, { id: 'assistant', name: 'assistant' })
  const profileCustom = makeProfile({ id: 'coder', name: '代码助手', model: 'openai/gpt-5' })
  assert.equal(profileCustom.id, 'coder')
  assert.equal(profileCustom.name, '代码助手')
  assert.equal(profileCustom.model, 'openai/gpt-5')

  const pluginDefault = makePluginSummary()
  assert.equal(pluginDefault.id, 'test:plugin')
  assert.equal(pluginDefault.name, 'test:plugin')
  assert.equal(pluginDefault.enabled, true)
  assert.equal(pluginDefault.locked, false)
  assert.deepEqual(pluginDefault.hooks, [])
  assert.deepEqual(pluginDefault.actions, [])
  assert.deepEqual(pluginDefault.tools, [])

  const pluginCustom = makePluginSummary({
    id: 'builtin:workflow',
    name: '工作流引擎',
    locked: false,
    enabled: false,
    status: 'disabled',
    tools: ['subagent'],
  })
  assert.equal(pluginCustom.id, 'builtin:workflow')
  assert.equal(pluginCustom.name, '工作流引擎')
  assert.equal(pluginCustom.enabled, false)
  assert.equal(pluginCustom.status, 'disabled')
  assert.deepEqual(pluginCustom.tools, ['subagent'])
})

test('deferred / sleep / waitFor / jsonResponse 同构异步与响应工具', { timeout: 60_000 }, async () => {
  const okGate = deferred<string>()
  let settled = false
  void okGate.promise.then((value) => {
    if (value === 'done') settled = true
  })
  assert.equal(settled, false)
  okGate.resolve('done')
  await waitFor(() => settled)
  assert.equal(settled, true)

  const failGate = deferred<void>()
  failGate.reject(new Error('boom'))
  await assert.rejects(failGate.promise, /boom/)

  const t0 = Date.now()
  await sleep(15)
  assert.ok(Date.now() - t0 >= 5, 'sleep 应至少等待约指定毫秒数')

  let polls = 0
  await waitForCondition(async () => {
    polls += 1
    return polls >= 3
  }, { timeoutMs: 2_000, intervalMs: 5 })
  assert.ok(polls >= 3)

  await assert.rejects(
    waitFor(() => false, { timeoutMs: 30, intervalMs: 5, message: '自定义超时说明' }),
    /自定义超时说明/,
  )
  await assert.rejects(
    waitFor(() => false, { timeoutMs: 0, message: '零超时立即失败' }),
    /零超时立即失败/,
  )

  const res = jsonResponse({ ok: true, n: 1 }, 201, { 'x-trace': 'abc' })
  assert.equal(res.status, 201)
  assert.equal(res.headers.get('content-type'), 'application/json')
  assert.equal(res.headers.get('x-trace'), 'abc')
  assert.deepEqual(await res.json(), { ok: true, n: 1 })

  const emptyRes = jsonResponse(undefined, 204)
  assert.equal(emptyRes.status, 204)
  assert.equal(await emptyRes.text(), '')
})

test('assertRejectsCode（同构版与 node:assert 版）严格校验错误码与状态码', { timeout: 60_000 }, async () => {
  class CodedError extends Error {
    readonly code: string
    readonly status?: number
    constructor(code: string, message: string, status?: number) {
      super(message)
      this.code = code
      this.status = status
    }
  }

  for (const checkFn of [assertRejectsCode, assertRejectsCodeNode]) {
    const caught = await checkFn(async () => {
      throw new CodedError('plugin_in_use', 'occupied', 409)
    }, 'plugin_in_use', 409)
    assert.ok(caught instanceof CodedError)

    await checkFn(async () => {
      throw new CodedError('not_found', 'missing')
    }, 'not_found')

    await assert.rejects(
      checkFn(async () => 'ok', 'not_found'),
      /预期抛出错误码 not_found/,
    )
    await assert.rejects(
      checkFn(async () => {
        throw new CodedError('other_code', 'mismatch')
      }, 'not_found'),
      /预期错误码 not_found，实际为 other_code/,
    )
    await assert.rejects(
      checkFn(async () => {
        throw new CodedError('not_found', 'no status')
      }, 'not_found', 404),
      /预期错误状态码 404，实际为 undefined/,
    )
  }

  await assert.rejects(
    assertRejectsCodeNode(async () => 'ok', 'not_found'),
    (err: unknown) => err instanceof assert.AssertionError,
  )
})

test('useTempDir / makeTempDir / cleanupDir 生命周期自动清理与显式清理', { timeout: 60_000 }, async () => {
  const callbacks: Array<() => void | Promise<void>> = []
  const fakeContext = {
    after(fn: () => void | Promise<void>) {
      callbacks.push(fn)
    },
  }
  const autoDir = useTempDir(fakeContext, 'helm-test-kit-auto-')
  assert.ok(existsSync(autoDir))
  writeFileSync(join(autoDir, 'marker.txt'), 'ok', 'utf8')
  assert.equal(callbacks.length, 1)
  await callbacks[0]!()
  assert.equal(existsSync(autoDir), false)

  const manualDir = await makeTempDir('helm-test-kit-manual-')
  assert.ok(existsSync(manualDir))
  writeFileSync(join(manualDir, 'a.txt'), '1', 'utf8')
  await cleanupDir(manualDir)
  assert.equal(existsSync(manualDir), false)
  // 重复清理不存在目录应保持幂等
  await cleanupDir(manualDir)
})

test('sanitizedHostEnv 大小写不敏感剥除受管变量并支持安全覆写', { timeout: 60_000 }, () => {
  const saved: Record<string, string | undefined> = {}
  const keysToTouch = [
    ...HOST_MANAGED_HELM_ENV_NAMES,
    'helm_token',
    'Helm_Cwd',
    'HELM_TEST_KIT_KEEP',
  ]
  for (const key of keysToTouch) {
    saved[key] = process.env[key]
  }
  try {
    for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
      process.env[name] = `host-${name}`
    }
    process.env['helm_token'] = 'lower-host-token'
    process.env['Helm_Cwd'] = '/host/mixed-case'
    process.env['HELM_TEST_KIT_KEEP'] = 'preserve-me'

    const clean = sanitizedHostEnv()
    for (const name of HOST_MANAGED_HELM_ENV_NAMES) {
      assert.equal(clean[name], undefined, `应剥除 ${name}`)
    }
    assert.equal(clean['helm_token'], undefined)
    assert.equal(clean['Helm_Cwd'], undefined)
    assert.equal(clean['HELM_TEST_KIT_KEEP'], 'preserve-me')
    assert.equal(process.env['HELM_TOKEN'], 'host-HELM_TOKEN', '不得修改全局 process.env')

    const overridden = sanitizedHostEnv({
      HELM_HUB_URL: 'http://127.0.0.1:4444',
      HELM_TEST_KIT_KEEP: undefined,
    })
    assert.equal(overridden['HELM_HUB_URL'], 'http://127.0.0.1:4444')
    assert.equal(overridden['HELM_TOKEN'], undefined)
    assert.equal('HELM_TEST_KIT_KEEP' in overridden, false)
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('startMockHub：默认 actions、多种响应形式、命中记录与 autoRegisterCleanup', { timeout: 60_000 }, async (t) => {
  const hub = await startMockHub(
    {
      'POST /api/echo': async (body) => ({ status: 201, body: { echoed: body } }),
      'GET /api/text': () => ({ body: 'hello plain text' }),
      'GET /api/web-res': () => jsonResponse({ viaResponse: true }, 202, { 'x-custom': 'yes' }),
      'GET /api/empty': () => ({ status: 204 }),
      'GET /api/raw': (_body, _req, res) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: ping\ndata: ok\n\n')
        res.end()
        return null
      },
      'GET /api/boom': () => {
        throw new Error('route crashed')
      },
    },
    {
      defaultActions: [{ pluginId: 'demo', id: 'act' }],
      autoRegisterCleanup: t,
    },
  )

  const actionsRes = await fetch(`${hub.url}/api/actions`)
  assert.equal(actionsRes.status, 200)
  assert.deepEqual(await actionsRes.json(), [{ pluginId: 'demo', id: 'act' }])

  const echoRes = await fetch(`${hub.url}/api/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1', 'x-meta': 'v' },
    body: JSON.stringify({ n: 7 }),
  })
  assert.equal(echoRes.status, 201)
  assert.deepEqual(await echoRes.json(), { echoed: { n: 7 } })

  const textRes = await fetch(`${hub.url}/api/text`, {
    method: 'POST',
  })
  assert.equal(textRes.status, 404)
  assert.equal((await textRes.json() as { error: { code: string } }).error.code, 'not_found')

  const plainRes = await fetch(`${hub.url}/api/text`)
  assert.equal(plainRes.status, 200)
  assert.match(plainRes.headers.get('content-type') ?? '', /^text\/plain/)
  assert.equal(await plainRes.text(), 'hello plain text')

  const webRes = await fetch(`${hub.url}/api/web-res`)
  assert.equal(webRes.status, 202)
  assert.equal(webRes.headers.get('x-custom'), 'yes')
  assert.deepEqual(await webRes.json(), { viaResponse: true })

  const emptyRes = await fetch(`${hub.url}/api/empty`)
  assert.equal(emptyRes.status, 204)

  const rawRes = await fetch(`${hub.url}/api/raw`)
  assert.equal(rawRes.status, 200)
  assert.equal(await rawRes.text(), 'event: ping\ndata: ok\n\n')

  const boomRes = await fetch(`${hub.url}/api/boom`)
  assert.equal(boomRes.status, 500)
  assert.equal((await boomRes.json() as { error: { code: string } }).error.code, 'mock_hub_error')

  assert.equal(hub.hits, hub.recorded.hits)
  const echoHit = hub.hits.find((h) => h.path === '/api/echo')
  assert.ok(echoHit)
  assert.equal(echoHit.method, 'POST')
  assert.deepEqual(echoHit.body, { n: 7 })
  assert.equal(echoHit.authorization, 'Bearer tok-1')
  assert.equal(echoHit.headers['x-meta'], 'v')

  // 手动 close 后 autoRegisterCleanup 再次调用 close 应幂等成功
  await hub.close()
  await hub.close()

  // 覆写 GET /api/actions、Buffer 响应与纯文本/二进制请求体记录
  const customHub = await startMockHub(
    {
      'GET /api/actions': () => ({ body: [{ pluginId: 'custom', id: 'override' }] }),
      'POST /api/blob': () => ({
        status: 200,
        body: Buffer.from([1, 2, 3, 4]),
        headers: { 'Content-Type': 'application/x-custom-bin' },
      }),
      'POST /api/plain': (body) => ({ body: { got: body } }),
    },
    { autoRegisterCleanup: t },
  )
  const customActions = await fetch(`${customHub.url}/api/actions`)
  assert.deepEqual(await customActions.json(), [{ pluginId: 'custom', id: 'override' }])

  const blobPayload = Uint8Array.from([9, 8, 7])
  const blobRes = await fetch(`${customHub.url}/api/blob`, {
    method: 'POST',
    body: blobPayload,
  })
  assert.equal(blobRes.headers.get('content-type'), 'application/x-custom-bin')
  assert.deepEqual(new Uint8Array(await blobRes.arrayBuffer()), Uint8Array.from([1, 2, 3, 4]))
  const blobHit = customHub.hits.find((h) => h.path === '/api/blob')
  assert.ok(blobHit?.rawBody)
  assert.deepEqual(new Uint8Array(blobHit.rawBody), blobPayload)

  const plainPostRes = await fetch(`${customHub.url}/api/plain`, {
    method: 'POST',
    body: 'raw-text-body',
  })
  assert.deepEqual(await plainPostRes.json(), { got: 'raw-text-body' })
})

test('initGitRepo 与 createGitTemplate：初始化仓库与 cpSync 隔离克隆', { timeout: 60_000 }, (t) => {
  const scratch = useTempDir(t, 'helm-test-kit-git-')
  const standalone = join(scratch, 'standalone')
  initGitRepo(standalone, { 'nested/hello.txt': 'hello\n' })
  const standaloneBranch = execFileSync('git', ['branch', '--show-current'], {
    cwd: standalone,
    encoding: 'utf8',
  }).trim()
  assert.equal(standaloneBranch, 'main')
  assert.equal(readFileSync(join(standalone, 'nested/hello.txt'), 'utf8'), 'hello\n')

  const emptyRepo = join(scratch, 'empty')
  initGitRepo(emptyRepo, {})
  const emptyLog = execFileSync('git', ['log', '-1', '--pretty=%s'], {
    cwd: emptyRepo,
    encoding: 'utf8',
  }).trim()
  assert.equal(emptyLog, 'init')

  const template = createGitTemplate('helm-test-kit-tpl-', (dir) => {
    writeFileSync(join(dir, 'base.txt'), 'base-v1\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'add base'], { cwd: dir })
  })
  try {
    const copyA = template.cloneTo(join(scratch, 'copy-a'))
    const copyB = template.cloneTo(join(scratch, 'copy-b'))
    assert.equal(readFileSync(join(copyA, 'base.txt'), 'utf8'), 'base-v1\n')
    assert.equal(readFileSync(join(copyB, 'base.txt'), 'utf8'), 'base-v1\n')

    // copyA 新增提交不影响 copyB 与模板
    writeFileSync(join(copyA, 'base.txt'), 'modified-in-a\n', 'utf8')
    execFileSync('git', ['add', '.'], { cwd: copyA })
    execFileSync('git', ['-c', 'commit.gpgsign=false', 'commit', '-qm', 'commit in a'], { cwd: copyA })

    assert.equal(readFileSync(join(copyB, 'base.txt'), 'utf8'), 'base-v1\n')
    assert.equal(readFileSync(join(template.templateDir, 'base.txt'), 'utf8'), 'base-v1\n')
    const statusB = execFileSync('git', ['status', '--porcelain'], { cwd: copyB, encoding: 'utf8' })
    assert.equal(statusB, '')
  } finally {
    template.cleanup()
  }
  assert.equal(existsSync(template.templateDir), false)

  // setup 异常时应自动清理临时模板目录
  const uniquePrefix = `helm-test-kit-fail-${Date.now()}-${Math.random().toString(36).slice(2)}-`
  assert.throws(
    () =>
      createGitTemplate(uniquePrefix, (dir) => {
        writeFileSync(join(dir, 'partial.txt'), 'temp', 'utf8')
        throw new Error('setup failed')
      }),
    /setup failed/,
  )
  assert.deepEqual(
    readdirSync(tmpdir()).filter((name) => name.startsWith(uniquePrefix)),
    [],
    'setup 抛错后不应遗留临时模板目录',
  )
})
