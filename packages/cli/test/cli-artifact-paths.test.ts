/**
 * artifacts put/get local path semantics regression (pure process inside: zero HTTP listener):
 * - relative path unique by CLI caller cwd parse is absolute path (HELM_ENV=1 and HELM_CWD different
 *   also not silently switch, do not all find - - directory difference belong legal cd, only act diagnose attach note);
 * - put failed to read to out requestedPath / resolvedPath / cliCwd(+ conversation cwd) structure diagnose,
 *   and occur in create connect before: zero fetch invoke (do not access Hub);
 * - get --output by caller cwd parse, real,bytes use actual byte count (stub Response
 *   without Content-Length head still can rely),written back visible absolute path; write failed diagnose contains absolute path.
 * isolated manually method:runCli cwd inject (forbidden process.chdir)+ options.fetch memory stub
 * (record request and return real Response, conforms to test:unitCLI do not start real service convention);
 * file read write is real disk operation,mkdtemp directory one rule t.after recursion clean up.
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
 * memory Hub stub: by `<METHOD> <pathname>` routing, record each time fetch invoke (contains return
 * Response this body, supply test assertion response head live). not match routing one rule 404 message seal, never static default let through.
 */
function makeHubStub(routes: Record<string, RouteHandler>): { fetchImpl: typeof fetch; calls: RecordedFetch[] } {
  const calls: RecordedFetch[] = []
  const fetchImpl = (async (input: unknown, init?: RequestInit & { headers?: Record<string, string> }) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    const handler = routes[`${method} ${url.pathname}`]
    const response = handler !== undefined ? handler(init) : errorResponse(404, 'not_found', `without routing ${method} ${url.pathname}`)
    calls.push({ method, pathname: url.pathname, headers: { ...(init?.headers ?? {}) }, body: init?.body, response })
    return response
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

/** upload routing: pass-through request body byte, back fill complete ArtifactMetadata(contains path). */
function uploadRoute(conversationId: number, name: string): RouteHandler {
  return (init) => {
    const body = init?.body as Uint8Array
    assert.ok(body instanceof Uint8Array, 'upload body should be two enter system Uint8Array')
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

/** HELM_HUB_URL only act occupy base bottom:fetch already by stub, never real dial. */
function makeStubEnv(dataDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return makeCliEnv('http://127.0.0.1:9', dataDir, extra)
}

// ---------------------------------------------------------------------------
// put: relative path by caller cwd parse
// ---------------------------------------------------------------------------

test('put: relative path by CLI cwd parse;HELM_ENV=1 and HELM_CWD different still read invoke directory', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helm-cli-art-session-') // conversation cwd: no the file
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
  assert.deepEqual([...(hit.body as Uint8Array)], [...content], 'upload byte and invoke directory file consistent')
})

test('put: the same relative path in conversation cwd under store in, invoke cwd under missing → ENOENT(not silently switch, do not all find)', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const sessionDir = useTempDir(t, 'helm-cli-art-session-')
  await fsp.writeFile(path.join(sessionDir, 'only-in-session.bin'), 'x') // only conversation directory has
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'only-in-session.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', 'only-in-session.bin', '3'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: sessionDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.ok(r.err.includes('read upload file failed'), `stderr should contains failed to read:${r.err}`)
  assert.ok(r.err.includes('only-in-session.bin') && r.err.includes(callerDir), `stderr should contains request path and CLI cwd:${r.err}`)
  assert.ok(r.err.includes(sessionDir), `stderr should attach note conversation cwd:${r.err}`)
  assert.equal(hub.calls.length, 0, 'failed to read must not access Hub(zero fetch invoke)')
})

// ---------------------------------------------------------------------------
// put:ENOENT structure diagnose
// ---------------------------------------------------------------------------

test('put:ENOENT diagnose contains requestedPath/resolvedPath/cliCwd/sessionCwd(--json details)', { timeout: 60_000 }, async (t) => {
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
  assert.equal(hub.calls.length, 0, 'failed to read must not access Hub(zero fetch invoke)')
})

test('put:HELM_ENV not settings when do not attach note conversation cwd;HELM_CWD and cwd identical also do not attach note', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'missing.bin') })
  const noEnv = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(noEnv.code, 1)
  assert.equal(parseCliError<Record<string, string>>(noEnv).details?.sessionCwd, undefined)
  assert.ok(!noEnv.err.includes('conversation cwd'), `must not attach note conversation cwd:${noEnv.err}`)

  const sameCwd = await runCliCaptured(
    ['artifacts', 'put', 'missing.bin', '3', '--json'],
    makeStubEnv(callerDir, { HELM_ENV: '1', HELM_CWD: callerDir }),
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(sameCwd.code, 1)
  assert.equal(parseCliError<Record<string, string>>(sameCwd).details?.sessionCwd, undefined)
  assert.equal(hub.calls.length, 0, 'failed to read must not access Hub(zero fetch invoke)')
})

test('put: failed to read zero fetch invoke (absolute path missing same in create connect before failed)', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-caller-')
  const otherDir = useTempDir(t, 'helm-cli-art-other-')
  const hub = makeHubStub({ 'POST /api/conversations/3/artifacts': uploadRoute(3, 'abs-missing.bin') })
  const r = await runCliCaptured(
    ['artifacts', 'put', path.join(callerDir, 'abs-missing.bin'), '3', '--json'],
    makeStubEnv(otherDir),
    { cwd: otherDir, fetch: hub.fetchImpl },
  )
  assert.equal(r.code, 1)
  assert.equal(hub.calls.length, 0, `must not has any fetch invoke, got ${JSON.stringify(hub.calls.map((c) => `${c.method} ${c.pathname}`))}`)
})

// ---------------------------------------------------------------------------
// get --output: absolute path parse, real and actual byte count
// ---------------------------------------------------------------------------

test('get --output: by CLI cwd parse relative path,written back visible absolute path,bytes is actual byte count (Response without Content-Length)', { timeout: 60_000 }, async (t) => {
  const callerDir = useTempDir(t, 'helm-cli-art-get-')
  await fsp.mkdir(path.join(callerDir, 'out'))
  const content = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]), Buffer.from('artifact content-binary')])
  const sessionDir = useTempDir(t, 'helm-cli-art-session-')
  const hub = makeHubStub({
    'GET /api/artifacts/art-9/content': () =>
      // manually work construct Response does not carry Content-Length:bytes only can from actual byte.
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
  // lock before mention:stub Response indeed without Content-Length head,bytes assertion independent of the head.
  assert.equal(hub.calls.at(-1)!.response.headers.get('content-length'), null)
  // real validate: byte consistent.
  const onDisk = await fsp.readFile(abs)
  assert.deepEqual([...onDisk], [...content])

  // text pattern same back visible absolute path and byte count.
  const text = await runCliCaptured(
    ['artifacts', 'get', 'art-9', '--output', 'out/bin2.dat'],
    env,
    { cwd: callerDir, fetch: hub.fetchImpl },
  )
  assert.equal(text.code, 0, text.err)
  assert.ok(text.out.includes(`already write ${path.join(callerDir, 'out', 'bin2.dat')}`), `should back visible absolute path:${text.out}`)
  assert.ok(text.out.includes(`(${content.length} byte)`), `should back visible actual byte count:${text.out}`)
})

test('get --output: transfer interrupt to out download diagnose and keep already has file', { timeout: 60_000 }, async (t) => {
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

test('get --output: failed to write diagnose contains absolute path and structure details', { timeout: 60_000 }, async (t) => {
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
  assert.ok(err.message.includes(abs), `error message should contains absolute path:${err.message}`)
  assert.equal(err.details?.resolvedPath, abs)
  assert.equal(err.details?.cliCwd, callerDir)
  // download completed (once GET), only failed - - and failed to read zero fetchshape into compare.
  assert.equal(hub.calls.length, 1)
})
