/**
 * artifacts put/get 本地路径语义回归（纯进程内：零 HTTP listener）：
 * - 相对路径唯一按 CLI 调用方 cwd 解析为绝对路径（HELM_ENV=1 且 HELM_CWD 不同
 *   也不静默切换、不全盘查找——目录差异属合法 cd，仅作诊断附注）；
 * - put 读取失败给出 requestedPath / resolvedPath / cliCwd（+ 会话 cwd）结构化诊断，
 *   且发生在建连之前：零 fetch 调用（不访问 Hub）；
 * - get --output 按调用方 cwd 解析、真实落盘，bytes 用实际字节数（stub Response
 *   无 Content-Length 头仍可靠），written 回显绝对路径；写失败诊断含绝对路径。
 * 隔离手法：runCli cwd 注入（禁止 process.chdir）+ options.fetch 内存 stub
 * （记录请求并返回真实 Response，符合 test:unit「CLI 不起真实服务」约定）；
 * 文件读写为真实磁盘操作，mkdtemp 目录一律 t.after 递归清理。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {
  jsonResponse,
  makeCliEnv,
  parseCliError,
  runCliCaptured,
  useTempDir,
} from './helpers/cli-harness.js'

interface RecordedFetch {
  method: string
  pathname: string
  headers: Record<string, string>
  body?: unknown
  response: Response
}

type RouteHandler = (init: RequestInit | undefined) => Response

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status)
}

/**
 * 内存 Hub stub：按 `<METHOD> <pathname>` 路由，记录每次 fetch 调用（含返回的
 * Response 本体，供测试断言响应头现场）。未匹配路由一律 404 信封，绝不静默放行。
 */
function makeHubStub(routes: Record<string, RouteHandler>): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit & { headers?: Record<string, string> }) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const handler = routes[`${method} ${url.pathname}`]
    const response = handler !== undefined ? handler(init) : errorResponse(404, 'not_found', `无路由 ${method} ${url.pathname}`)
    calls.push({ method, pathname: url.pathname, headers: { ...(init?.headers ?? {}) }, body: init?.body, response })
    return response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** 上传路由：透传请求 body 字节，回填完整 ArtifactMetadata（含 path）。 */
function uploadRoute(conversationId: number, name: string): RouteHandler {
  return (init) => {
    const body = init?.body as Uint8Array
    assert.ok(body instanceof Uint8Array, '上传 body 应为二进制 Uint8Array')
    return jsonResponse(
      {
        id: 'art-1',
        conversationId,
        kind: 'upload',
        name,
        path: `artifacts/${conversationId}/${name}`,
        mimeType: 'application/octet-stream',
        size: body.byteLength,
        createdAt: 1,
      },
      201,
    )
  }
}

/** HELM_HUB_URL 仅作占位基底：fetch 已被 stub，绝不真实拨号。 */
function makeStubEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return makeCliEnv('http://127.0.0.1:9', dataDir, extra)
}

// ---------------------------------------------------------------------------
// put：相对路径按调用方 cwd 解析
// ---------------------------------------------------------------------------

test('put：相对路径按 CLI cwd 解析；HELM_ENV=1 且 HELM_CWD 不同仍读取调用者目录', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helm-cli-art-session-') // 会话 cwd：没有该文件
  const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89])
  await fsp.writeFile(path.join(callerDir, 'report.bin'), content)
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'report.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'report.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 0, r.err)
  const metadata = JSON.parse(r.out)
  assert.equal(metadata.id, 'art-1')
  assert.equal(metadata.path, 'artifacts/3/report.bin')
  const hit = hub.calls.at(-1)!
  assert.equal(hit.method, 'POST')
  assert.equal(hit.pathname, '/api/conversations/3/artifacts')
  assert.equal(hit.headers['x-artifact-filename'], 'report.bin')
  assert.deepEqual([...(hit.body as Uint8Array)], [...content], '上传字节与调用者目录文件一致')
})

test('put：同一相对路径在会话 cwd 下存在、调用者 cwd 下缺失 → ENOENT（不静默切换、不全盘查找）', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helm-cli-art-session-')
  await fsp.writeFile(path.join(sessionDir, 'only-in-session.bin'), 'x') // 仅会话目录有
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'only-in-session.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'only-in-session.bin', '3'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('读取上传文件失败'), `stderr 应含读取失败：${r.err}`)
  assert.ok(r.err.includes('only-in-session.bin') && r.err.includes(callerDir), `stderr 应含请求路径与 CLI cwd：${r.err}`)
  assert.ok(r.err.includes(sessionDir), `stderr 应附注会话 cwd：${r.err}`)
  assert.equal(hub.calls.length, 0, '读取失败不得访问 Hub（零 fetch 调用）')
})

// ---------------------------------------------------------------------------
// put：ENOENT 结构化诊断
// ---------------------------------------------------------------------------

test('put：ENOENT 诊断含 requestedPath/resolvedPath/cliCwd/sessionCwd（--json details）', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helm-cli-art-session-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'missing.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  const err = parseCliError<Record<string, string>>(r)
  assert.equal(err.code, 'read_failed')
  const d = err.details!
  assert.equal(d.requestedPath, 'missing.bin')
  assert.equal(d.resolvedPath, path.join(callerDir, 'missing.bin'))
  assert.equal(d.cliCwd, callerDir)
  assert.equal(d.sessionCwd, sessionDir)
  assert.equal(hub.calls.length, 0, '读取失败不得访问 Hub（零 fetch 调用）')
})

test('put：HELM_ENV 未设置时不附注会话 cwd；HELM_CWD 与 cwd 相同亦不附注', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'missing.bin') })
  const noEnv = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(noEnv.code, 1)
  assert.equal(parseCliError<Record<string, string>>(noEnv).details?.sessionCwd, undefined)
  assert.ok(!noEnv.err.includes('会话 cwd'), `不应附注会话 cwd：${noEnv.err}`)

  const sameCwd = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: callerDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(sameCwd.code, 1)
  assert.equal(parseCliError<Record<string, string>>(sameCwd).details?.sessionCwd, undefined)
  assert.equal(hub.calls.length, 0, '读取失败不得访问 Hub（零 fetch 调用）')
})

test('put：读取失败零 fetch 调用（绝对路径缺失同样在建连前失败）', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const otherDir = useTempDir(t, 'helm-cli-art-other-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'abs-missing.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', path.join(callerDir, 'abs-missing.bin'), '3', '--json'],
    makeStubEnv(otherDir),
    { cwd: otherDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.equal(hub.calls.length, 0, `不应有任何 fetch 调用，实得 ${JSON.stringify(hub.calls.map((c) => `${c.method} ${c.pathname}`))}`)
})

// ---------------------------------------------------------------------------
// get --output：绝对路径解析、真实落盘与实际字节数
// ---------------------------------------------------------------------------

test('get --output：按 CLI cwd 解析相对路径，written 回显绝对路径，bytes 为实际字节数（Response 无 Content-Length）', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-get-')
  await fsp.mkdir(path.join(callerDir, 'out'))
  const content = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.from('产物内容-binary')])
  const sessionDir = useTempDir(t, 'helm-cli-art-session-')
  const hub = makeHubStub({
    'GET /api/artifacts/art-9/content': () =>
      // 手工构造的 Response 不携带 Content-Length：bytes 只能来自实际落盘字节。
      new Response(content, { headers: { 'content-type': 'application/octet-stream' } }),
  })
  const env = makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir })
  const r = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'out/bin.dat', '--json'],
    env,
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 0, r.err)
  const abs = path.join(callerDir, 'out', 'bin.dat')
  const parsed = JSON.parse(r.out) as { written: string; bytes: number }
  assert.equal(parsed.written, abs)
  assert.equal(parsed.bytes, content.length)
  // 锁定前提：stub Response 确实无 Content-Length 头，bytes 断言不依赖该头。
  assert.equal(hub.calls.at(-1)!.response.headers.get('content-length'), null)
  // 真实落盘校验：字节一致。
  const onDisk = await fsp.readFile(abs)
  assert.deepEqual([...onDisk], [...content])

  // 文本模式同样回显绝对路径与字节数。
  const text = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'out/bin2.dat'],
    env,
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(text.code, 0, text.err)
  assert.ok(text.out.includes(`已写入 ${path.join(callerDir, 'out', 'bin2.dat')}`), `应回显绝对路径：${text.out}`)
  assert.ok(text.out.includes(`（${content.length} 字节）`), `应回显实际字节数：${text.out}`)
})

test('get --output：传输中断给出下载诊断且保留已有文件', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-get-')
  const output = path.join(callerDir, 'existing.bin')
  await fsp.writeFile(output, 'existing-deliverable')
  const hub = makeHubStub({
    'GET /api/artifacts/art-9/content': () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]))
        controller.error(new Error('transfer interrupted'))
      },
    }), { headers: { 'content-type': 'application/octet-stream' } }),
  })
  const r = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'existing.bin', '--json'],
    makeStubEnv(callerDir),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  const err = parseCliError<{ resolvedPath: string }>(r)
  assert.equal(err.code, 'download_failed')
  assert.equal(err.details?.resolvedPath, output)
  assert.match(err.message, /transfer interrupted/)
  assert.equal(await fsp.readFile(output, 'utf8'), 'existing-deliverable')
})

test('get --output：写入失败诊断含绝对路径与结构化 details', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-get-')
  const hub = makeHubStub({
    'GET /api/artifacts/art-9/content': () =>
      new Response(Buffer.from('data'), { headers: { 'content-type': 'application/octet-stream' } }),
  })
  const r = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'no-such-dir/bin.dat', '--json'],
    makeStubEnv(callerDir),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  const err = parseCliError<Record<string, string>>(r)
  assert.equal(err.code, 'write_failed')
  const abs = path.join(callerDir, 'no-such-dir', 'bin.dat')
  assert.ok(err.message.includes(abs), `错误消息应含绝对路径：${err.message}`)
  assert.equal(err.details?.resolvedPath, abs)
  assert.equal(err.details?.cliCwd, callerDir)
  // 下载已完成（一次 GET），仅落盘失败——与「读取失败零 fetch」形成对照。
  assert.equal(hub.calls.length, 1)
})
