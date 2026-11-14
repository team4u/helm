/**
 * artifacts put/get 本地路径语义回归：
 * - 相对路径唯一按 CLI 调用方 cwd 解析为绝对路径（HELM_ENV=1 且 HELM_CWD 不同
 *   也不静默切换、不全盘查找——目录差异属合法 cd，仅作诊断附注）；
 * - put 读取失败给出 requestedPath / resolvedPath / cliCwd（+ 会话 cwd）结构化诊断；
 * - put 读取失败发生在建连之前：零 HTTP 请求（不访问 Hub）；
 * - get --output 按调用方 cwd 解析、真实落盘，bytes 用实际字节数（chunked 响应
 *   无 Content-Length 头仍可靠），written 回显绝对路径；写失败诊断含绝对路径。
 * 隔离手法：runCli cwd 注入（禁止 process.chdir 并发污染）+ 临时目录 + 模拟 Hub。
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
  url: string
  rawBody?: Buffer
  headers: Record<string, string | string[] | undefined>
}

interface Hub {
  url: string
  hits: Hit[]
  close(): Promise<void>
}

/** 模拟 Hub：产物上传路由 + 可选 chunked（无 Content-Length）二进制内容路由。 */
async function startHub(content?: Buffer): Promise<Hub> {
  const hits: Hit[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      hits.push({
        method: req.method!,
        url: req.url!,
        headers: { ...req.headers },
        ...(rawBody.length > 0 ? { rawBody } : {}),
      })
      if (req.method === 'POST' && req.url === '/api/conversations/3/artifacts') {
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'art-1',
            conversationId: 3,
            name: 'report.bin',
            size: rawBody.length,
            mimeType: 'application/octet-stream',
            createdAt: 1,
          }),
        )
        return
      }
      if (req.method === 'GET' && req.url === '/api/artifacts/art-9/content' && content !== undefined) {
        // chunkedEncoding 抑制自动 Content-Length：验证 bytes 不依赖该头。
        res.chunkedEncoding = true
        res.writeHead(200, { 'content-type': 'application/octet-stream' })
        res.end(content)
        return
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'not_found', message: `无路由 ${req.method} ${req.url}` } }))
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

interface Captured {
  out: string
  err: string
  code: number
}

/** cwd 注入式执行：不 process.chdir，避免并发污染同进程其他测试。 */
async function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<Captured> {
  let out = ''
  let err = ''
  const code = await runCli(argv, { env, cwd, stdout: (t) => (out += t), stderr: (t) => (err += t) })
  return { out, err, code }
}

async function tempDir(prefix: string): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), prefix))
}

function makeEnv(hubUrl: string, dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: dataDir, HELM_TOKEN: 't-test', ...extra }
}

// ---------------------------------------------------------------------------
// put：相对路径按调用方 cwd 解析
// ---------------------------------------------------------------------------

test('put：相对路径按 CLI cwd 解析；HELM_ENV=1 且 HELM_CWD 不同仍读取调用者目录', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-caller-')
  const sessionDir = await tempDir('helm-cli-art-session-') // 会话 cwd：没有该文件
  const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89])
  await fsp.writeFile(path.join(callerDir, 'report.bin'), content)
  const hub = await startHub()
  try {
    const r = await run(
      ['artifacts', 'put', 'report.bin', '3', '--json'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
      callerDir,
    )
    assert.equal(r.code, 0, r.err)
    assert.equal(JSON.parse(r.out).id, 'art-1')
    const hit = hub.hits.at(-1)!
    assert.equal(hit.method, 'POST')
    assert.equal(hit.url, '/api/conversations/3/artifacts')
    assert.equal(hit.headers['x-artifact-filename'], 'report.bin')
    assert.deepEqual([...hit.rawBody!], [...content], '上传字节与调用者目录文件一致')
  } finally {
    await hub.close()
  }
})

test('put：同一相对路径在会话 cwd 下存在、调用者 cwd 下缺失 → ENOENT（不静默切换、不全盘查找）', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-caller-')
  const sessionDir = await tempDir('helm-cli-art-session-')
  await fsp.writeFile(path.join(sessionDir, 'only-in-session.bin'), 'x') // 仅会话目录有
  const hub = await startHub()
  try {
    const r = await run(
      ['artifacts', 'put', 'only-in-session.bin', '3'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
      callerDir,
    )
    assert.equal(r.code, 1)
    assert.ok(r.err.includes('读取上传文件失败'), `stderr 应含读取失败：${r.err}`)
    assert.ok(r.err.includes('only-in-session.bin') && r.err.includes(callerDir), `stderr 应含请求路径与 CLI cwd：${r.err}`)
    assert.ok(r.err.includes(sessionDir), `stderr 应附注会话 cwd：${r.err}`)
    assert.equal(hub.hits.length, 0, '读取失败不得访问 Hub')
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// put：ENOENT 结构化诊断
// ---------------------------------------------------------------------------

test('put：ENOENT 诊断含 requestedPath/resolvedPath/cliCwd/sessionCwd（--json details）', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-caller-')
  const sessionDir = await tempDir('helm-cli-art-session-')
  const hub = await startHub()
  try {
    const r = await run(
      ['artifacts', 'put', 'missing.bin', '3', '--json'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
      callerDir,
    )
    assert.equal(r.code, 1)
    const envelope = JSON.parse(r.err) as { error: { code: string; details: Record<string, string> } }
    assert.equal(envelope.error.code, 'read_failed')
    const d = envelope.error.details
    assert.equal(d.requestedPath, 'missing.bin')
    assert.equal(d.resolvedPath, path.join(callerDir, 'missing.bin'))
    assert.equal(d.cliCwd, callerDir)
    assert.equal(d.sessionCwd, sessionDir)
  } finally {
    await hub.close()
  }
})

test('put：HELM_ENV 未设置时不附注会话 cwd；HELM_CWD 与 cwd 相同亦不附注', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-caller-')
  const hub = await startHub()
  try {
    const noEnv = await run(
      ['artifacts', 'put', 'missing.bin', '3', '--json'],
      makeEnv(hub.url, callerDir),
      callerDir,
    )
    assert.equal(noEnv.code, 1)
    const d1 = (JSON.parse(noEnv.err) as { error: { details: Record<string, string> } }).error.details
    assert.equal(d1.sessionCwd, undefined)
    assert.ok(!noEnv.err.includes('会话 cwd'), `不应附注会话 cwd：${noEnv.err}`)

    const sameCwd = await run(
      ['artifacts', 'put', 'missing.bin', '3', '--json'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: callerDir }),
      callerDir,
    )
    assert.equal(sameCwd.code, 1)
    const d2 = (JSON.parse(sameCwd.err) as { error: { details: Record<string, string> } }).error.details
    assert.equal(d2.sessionCwd, undefined)
  } finally {
    await hub.close()
  }
})

test('put：读取失败零 HTTP 请求（含 /api/actions 均不触发）', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-caller-')
  const hub = await startHub()
  try {
    const r = await run(
      ['artifacts', 'put', path.join(callerDir, 'abs-missing.bin'), '3', '--json'],
      makeEnv(hub.url, callerDir),
      await tempDir('helm-cli-art-other-'),
    )
    assert.equal(r.code, 1)
    assert.equal(hub.hits.length, 0, `不应有任何 HTTP 请求，实得 ${JSON.stringify(hub.hits.map((h) => `${h.method} ${h.url}`))}`)
  } finally {
    await hub.close()
  }
})

// ---------------------------------------------------------------------------
// get --output：绝对路径解析、真实落盘与实际字节数
// ---------------------------------------------------------------------------

test('get --output：按 CLI cwd 解析相对路径，written 回显绝对路径，bytes 为实际字节数（chunked 无 Content-Length）', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-get-')
  await fsp.mkdir(path.join(callerDir, 'out'))
  const content = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]),
    Buffer.from('产物内容-binary'),
  ])
  const hub = await startHub(content)
  try {
    const sessionDir = await tempDir('helm-cli-art-session-')
    const r = await run(
      ['artifacts', 'get', 'art-9', '--output', 'out/bin.dat', '--json'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
      callerDir,
    )
    assert.equal(r.code, 0, r.err)
    const abs = path.join(callerDir, 'out', 'bin.dat')
    const parsed = JSON.parse(r.out) as { written: string; bytes: number }
    assert.equal(parsed.written, abs)
    assert.equal(parsed.bytes, content.length)
    // 真实落盘校验：字节一致。
    const onDisk = await fsp.readFile(abs)
    assert.deepEqual([...onDisk], [...content])

    // 文本模式同样回显绝对路径与字节数。
    const text = await run(
      ['artifacts', 'get', 'art-9', '--output', 'out/bin2.dat'],
      makeEnv(hub.url, callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
      callerDir,
    )
    assert.equal(text.code, 0, text.err)
    assert.ok(text.out.includes(`已写入 ${path.join(callerDir, 'out', 'bin2.dat')}`), `应回显绝对路径：${text.out}`)
    assert.ok(text.out.includes(`（${content.length} 字节）`), `应回显实际字节数：${text.out}`)
  } finally {
    await hub.close()
  }
})

test('get --output：写入失败诊断含绝对路径与结构化 details', { timeout: 60_000 }, async () => {
  const callerDir = await tempDir('helm-cli-art-get-')
  const hub = await startHub(Buffer.from('data'))
  try {
    const r = await run(
      ['artifacts', 'get', 'art-9', '--output', 'no-such-dir/bin.dat', '--json'],
      makeEnv(hub.url, callerDir),
      callerDir,
    )
    assert.equal(r.code, 1)
    const envelope = JSON.parse(r.err) as { error: { code: string; message: string; details: Record<string, string> } }
    assert.equal(envelope.error.code, 'write_failed')
    const abs = path.join(callerDir, 'no-such-dir', 'bin.dat')
    assert.ok(envelope.error.message.includes(abs), `错误消息应含绝对路径：${envelope.error.message}`)
    assert.equal(envelope.error.details.resolvedPath, abs)
    assert.equal(envelope.error.details.cliCwd, callerDir)
  } finally {
    await hub.close()
  }
})
