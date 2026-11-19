/**
 * Regression tests for `artifacts put/get` local path semantics (in-process only, zero HTTP listeners):
 * - relative paths resolve strictly against the CLI caller's cwd (never silently switching to HELMX_CWD
 *   when HELMX_ENV=1 or searching parent dirs; directory differences are valid cd usage and noted in diagnostics);
 * - `put` read failures report structured requestedPath / resolvedPath / cliCwd (+ sessionCwd) diagnostics
 *   before connecting (zero fetch calls to Hub);
 * - `get --output` resolves against caller cwd, writes to disk, counts actual bytes written (reliable even when
 *   stub Response omits Content-Length), and reports resolvedPath in output and write-failure diagnostics.
 * Isolation: `runCli` cwd injection (never `process.chdir`) + in-memory `options.fetch` stub
 * (records requests and returns real Response objects, matching the `test:unit` no-real-server rule);
 * disk IO uses real temp files cleaned up by `t.after`.
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
 * In-memory Hub stub: routes by `<METHOD> <pathname>` and records every fetch call (along with
 * the response body) so tests can assert on responses without leaking static defaults. Unmatched
 * routes return an explicit 404.
 */
function makeHubStub(routes: Record<string, RouteHandler>): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit & { headers?: Record<string, string> }) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const handler = routes[`${method} ${url.pathname}`]
    const response = handler !== undefined ? handler(init) : errorResponse(404, 'not_found', `no route for ${method} ${url.pathname}`)
    calls.push({ method, pathname: url.pathname, headers: { ...(init?.headers ?? {}) }, body: init?.body, response })
    return response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** Upload route: echoes the request body bytes and returns complete ArtifactMetadata (including path). */
function uploadRoute(conversationId: number, name: string): RouteHandler {
  return (init) => {
    const body = init?.body as Uint8Array
    assert.ok(body instanceof Uint8Array, 'upload body should be a binary Uint8Array')
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

/** Placeholder HELMX_HUB_URL base: fetch is stubbed, so no real sockets are dialed. */
function makeStubEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return makeCliEnv('http://127.0.0.1:9', dataDir, extra)
}

// ---------------------------------------------------------------------------
// put: relative paths resolve against caller cwd
// ---------------------------------------------------------------------------

test('put: relative path resolves against CLI cwd even when HELMX_ENV=1 and HELMX_CWD differ', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helmx-cli-art-session-') // conversation cwd without the file
  const content = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x89])
  await fsp.writeFile(path.join(callerDir, 'report.bin'), content)
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'report.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'report.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: sessionDir }),
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
  assert.deepEqual([...(hit.body as Uint8Array)], [...content], 'uploaded bytes match caller directory file')
})

test('put: relative path existing only in session cwd fails with ENOENT (never switches cwd or searches broadly)', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helmx-cli-art-session-')
  await fsp.writeFile(path.join(sessionDir, 'only-in-session.bin'), 'x') // only in session directory
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'only-in-session.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'only-in-session.bin', '3'],
    makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: sessionDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('failed to read upload file'), `stderr should include read failure: ${r.err}`)
  assert.ok(r.err.includes('only-in-session.bin') && r.err.includes(callerDir), `stderr should include requested path and CLI cwd: ${r.err}`)
  assert.ok(r.err.includes(sessionDir), `stderr should note session cwd: ${r.err}`)
  assert.equal(hub.calls.length, 0, 'read failure must not contact Hub (zero fetch calls)')
})

// ---------------------------------------------------------------------------
// put: ENOENT structured diagnostics
// ---------------------------------------------------------------------------

test('put: ENOENT diagnostics include requestedPath/resolvedPath/cliCwd/sessionCwd (--json details)', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helmx-cli-art-session-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'missing.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: sessionDir }),
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
  assert.equal(hub.calls.length, 0, 'read failure must not contact Hub (zero fetch calls)')
})

test('put: omits sessionCwd note when HELMX_ENV is unset or HELMX_CWD equals cwd', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-caller-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'missing.bin') })
  const noEnv = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(noEnv.code, 1)
  assert.equal(parseCliError<Record<string, string>>(noEnv).details?.sessionCwd, undefined)
  assert.ok(!noEnv.err.includes('conversation cwd'), `must not note conversation cwd: ${noEnv.err}`)

  const sameCwd = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: callerDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(sameCwd.code, 1)
  assert.equal(parseCliError<Record<string, string>>(sameCwd).details?.sessionCwd, undefined)
  assert.equal(hub.calls.length, 0, 'read failure must not contact Hub (zero fetch calls)')
})

test('put: read failure makes zero fetch calls even for missing absolute path', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-caller-')
  const otherDir = useTempDir(t, 'helmx-cli-art-other-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'abs-missing.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', path.join(callerDir, 'abs-missing.bin'), '3', '--json'],
    makeStubEnv(otherDir),
    { cwd: otherDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.equal(hub.calls.length, 0, `expected zero fetch calls, got ${JSON.stringify(hub.calls.map((c) => `${c.method} ${c.pathname}`))}`)
})

// ---------------------------------------------------------------------------
// get --output: path resolution, disk write, and byte counting
// ---------------------------------------------------------------------------

test('get --output: resolves relative path against CLI cwd, reports resolvedPath and actual bytes even without Content-Length', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-get-')
  await fsp.mkdir(path.join(callerDir, 'out'))
  const content = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.from('artifact content-binary')])
  const sessionDir = useTempDir(t, 'helmx-cli-art-session-')
  const hub = makeHubStub({
    'GET /api/artifacts/art-9/content': () =>
      // Synthetic Response omits Content-Length: bytes must come from actual bytes written.
      new Response(content, { headers: { 'content-type': 'application/octet-stream' } }),
  })
  const env = makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: sessionDir })
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
  // Precondition: stub Response has no Content-Length header, so bytes cannot rely on it.
  assert.equal(hub.calls.at(-1)!.response.headers.get('content-length'), null)
  // Verify bytes on disk match payload.
  const onDisk = await fsp.readFile(abs)
  assert.deepEqual([...onDisk], [...content])

  // Text mode also echoes resolved absolute path and byte count.
  const text = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'out/bin2.dat'],
    env,
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(text.code, 0, text.err)
  assert.ok(text.out.includes(`wrote ${path.join(callerDir, 'out', 'bin2.dat')}`), `should echo absolute path: ${text.out}`)
  assert.ok(text.out.includes(`(${content.length} bytes)`), `should echo actual byte count: ${text.out}`)
})

test('get --output: download failure prints diagnostic and keeps existing file intact', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-get-')
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

test('get --output: write failure diagnostic includes resolved path and structured details', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-art-get-')
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
  assert.ok(err.message.includes(abs), `error message should include absolute path: ${err.message}`)
  assert.equal(err.details?.resolvedPath, abs)
  assert.equal(err.details?.cliCwd, callerDir)
  // Download completed (one GET), write failed locally — contrasts with zero-fetch read failures.
  assert.equal(hub.calls.length, 1)
})

// ---------------------------------------------------------------------------
// conversations file: workspace file read (text, --json, --current, binary --output)
// ---------------------------------------------------------------------------

test('conversations file: reads text (--plain / --json / --current), rejects binary without --output, and writes --output to caller cwd', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helmx-cli-wsfile-caller-')
  const sessionDir = useTempDir(t, 'helmx-cli-wsfile-session-')
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff])
  const requestedUrls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = new URL(String(input))
    requestedUrls.push(`${url.pathname}${url.search}`)
    const filePath = url.searchParams.get('path')
    if (url.pathname === '/api/conversations/7/files/content' && filePath === 'src/app.ts') {
      return new Response('export const ok = true\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    if (url.pathname === '/api/conversations/9/files/content' && filePath === 'docs/a b.md') {
      return new Response('# Title\n', {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      })
    }
    if (url.pathname === '/api/conversations/7/files/content' && filePath === 'img/logo.png') {
      return new Response(pngBytes, {
        headers: { 'content-type': 'image/png' },
      })
    }
    return errorResponse(404, 'file_not_found', `missing ${filePath}`)
  }) as unknown as typeof fetch

  const env = makeStubEnv(callerDir, { HELMX_ENV: '1', HELMX_CWD: sessionDir, HELMX_CONVERSATION_ID: '9' })

  // Plain text output
  const plain = await runCliCaptured(['conversations', 'file', '7', 'src/app.ts'], env, { cwd: callerDir, fetch: fetchImpl })
  assert.equal(plain.code, 0, plain.err)
  assert.equal(plain.out, 'export const ok = true\n')

  // JSON output + --current
  const jsonRes = await runCliCaptured(['conversations', 'file', '--current', 'docs/a b.md', '--json'], env, { cwd: callerDir, fetch: fetchImpl })
  assert.equal(jsonRes.code, 0, jsonRes.err)
  assert.deepEqual(JSON.parse(jsonRes.out), {
    conversationId: 9,
    path: 'docs/a b.md',
    contentType: 'text/markdown; charset=utf-8',
    text: '# Title\n',
  })
  assert.equal(requestedUrls.at(-1), '/api/conversations/9/files/content?path=docs%2Fa%20b.md')

  // Binary without --output -> error code binary_content_requires_output
  const binErr = await runCliCaptured(['conversations', 'file', '7', 'img/logo.png', '--json'], env, { cwd: callerDir, fetch: fetchImpl })
  assert.equal(binErr.code, 1)
  assert.equal(parseCliError(binErr).code, 'binary_content_requires_output')

  // Binary with --output -> writes relative to CLI caller cwd (not HELMX_CWD)
  await fsp.mkdir(path.join(callerDir, 'downloads'))
  const binOut = await runCliCaptured(
    ['conversations', 'file', '7', 'img/logo.png', '--output', 'downloads/logo.png', '--json'],
    env,
    { cwd: callerDir, fetch: fetchImpl },
  )
  assert.equal(binOut.code, 0, binOut.err)
  const expectedDest = path.join(callerDir, 'downloads', 'logo.png')
  assert.deepEqual(JSON.parse(binOut.out), { written: expectedDest, bytes: pngBytes.length })
  assert.deepEqual([...(await fsp.readFile(expectedDest))], [...pngBytes])

  // Missing positional / missing --current -> client validation error without calling Hub
  const hitsBefore = requestedUrls.length
  const missingTarget = await runCliCaptured(['conversations', 'file', 'src/app.ts', '--json'], makeStubEnv(callerDir), { cwd: callerDir, fetch: fetchImpl })
  assert.equal(missingTarget.code, 1)
  assert.equal(parseCliError(missingTarget).code, 'missing_conversation_target')
  assert.equal(requestedUrls.length, hitsBefore)
})
