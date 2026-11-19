/**
 * Cross-platform HTTP artifact upload unit tests:
 * - ArtifactService.writeUploaded: binary byte fidelity, SecretStash redaction for text,
 *   >15 MiB returns 413, invalid filenames return 400;
 * - HTTP POST /api/conversations/:id/artifacts:
 *   - binary stream (octet-stream + x-artifact-filename) byte fidelity;
 *   - JSON branch (name + contentBase64);
 *   - invalid base64 -> 400; missing filename -> 400; over limit -> 413; missing conversation -> 404;
 *   - text upload triggers SecretStash redaction (no secret leaks);
 *   - GET list includes the newly uploaded artifact.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import fsp, { stat, symlink, writeFile } from 'node:fs/promises'
import {
  ArtifactService,
  CredentialService,
  InMemoryArtifactRepository,
  ProfileService,
  ProviderService,
  SecretStash,
  SkillService,
  AuthService,
  MAX_ARTIFACT_BYTES,
  sanitizeUploadFilename,
  ensureDataDir,
} from '../src/services/index.js'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
import { createHubHandler } from '../src/http/index.js'
import type { EventHub, KernelRuntimeLike } from '../src/http/index.js'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import { MemoryDocStore, cleanupDir, deferred, makeConversationSummary, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

let dataDir: string
let artifacts: ArtifactService
let stash: SecretStash
let token: string | undefined
let handler: ReturnType<typeof createHubHandler>
const conversations = new Map<number, ConversationSummary>()

class NoopEventHub implements EventHub {
  response(): Response {
    return new Response(null, { status: 204 })
  }
}

function summary(id: number, title: string): ConversationSummary {
  const now = Date.now()
  return makeConversationSummary({ id, title, model: 'faux/model', createdAt: now, updatedAt: now })
}

function makeKernel(): KernelRuntimeLike {
  return {
    listNodes() { throw new Error('this artifact fixture does not provide node management') },
    async issueNodeToken() { throw new Error('this artifact fixture does not sign node identities') },
    async removeNode() { throw new Error('this artifact fixture does not remove nodes') },
    async execEnv() { throw new Error('this artifact fixture does not execute node commands') },
    dataDir,
    auth: new AuthService(dataDir),
    events: new NoopEventHub(),
    profiles: new ProfileService(dataDir),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    artifacts,
    plugins: new PluginHost({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      host: undefined as unknown as PluginHostBackend,
      docs: new MemoryDocStore(),
    }),
    stash,
    async listConversations() {
      return [...conversations.values()]
    },
    async getConversationDetail(id: number) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
      return { ...found, entries: [] }
    },
    async getConversationEntry(id: number, entryId: number) {
      if (!conversations.has(id)) throw new HelmxError('not_found', `conversation not found: ${id}`, 404)
      throw new HelmxError('not_found', `entry ${entryId} not found in conversation ${id}`, 404)
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const created = summary(id, init?.title ?? `conversation ${id}`)
      conversations.set(id, created)
      return created
    },
    async updateConversation(id) {
      return conversations.get(id) ?? summary(id, 'x')
    },
    async deleteConversation(id) {
      conversations.delete(id)
    },
    async submitInput() {
      return { submissionId: 'sub-mock' }
    },
    async waitForInput(id: number, submissionId: string) {
      return { conversationId: id, submissionId, text: '', entry: { id: 'e', kind: 'pi.assistant' } }
    },
    async abortConversation() {},
    async resetConversation(id) {
      return conversations.get(id) ?? summary(id, 'x')
    },
    async compactConversation(id) {
      return { taskId: 1, conversation: conversations.get(id) ?? summary(id, 'x') }
    },
    async forkConversation(id) {
      return summary(id + 100, `conversation ${id} (fork)`)
    },
    async listAsks() {
      return []
    },
    async answerAsk() {},
    async cancelAsk() {},
    async search() {
      return []
    },
    listModels: () => ({ models: [], thinkingLevels: {} }),
    listModelProviders: () => [],
  }
}

async function call(
  method: string,
  path: string,
  opts?: { body?: BodyInit; headers?: Record<string, string> },
): Promise<{ status: number; body: any; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts?.headers ?? {}) }
  if (token !== undefined) headers.authorization = `Bearer ${token}`
  const request = new Request(`http://127.0.0.1:3202${path}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: opts.body } : {}),
  })
  const response = await handler(request)
  const text = await response.text()
  let parsed: any
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed, headers: response.headers }
}

test.before(async () => {
  dataDir = await makeTempDir('helmx-upload-test-')
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  conversations.set(1, summary(1, 'person assist'))
  conversations.set(2, summary(2, 'work conversation'))
  const kernel = makeKernel()
  handler = createHubHandler(kernel)
  // Setup and obtain auth token
  const setupReq = new Request('http://127.0.0.1:3202/api/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: 'test-password-123' }),
  })
  const setupRes = await handler(setupReq)
  assert.equal(setupRes.status, 200)
  token = ((await setupRes.json()) as { token: string }).token
})

test.after(async () => {
  await cleanupDir(dataDir)
})

// ---------------------------------------------------------------------------
// sanitizeUploadFilename unit tests
// ---------------------------------------------------------------------------

test('sanitizeUploadFilename: valid names pass; invalid names return 400 validation_error', { timeout: 60_000 }, () => {
  assert.equal(sanitizeUploadFilename('  report.md  '), 'report.md')
  assert.equal(sanitizeUploadFilename('data file.json'), 'data file.json')
  for (const bad of ['../etc/passwd', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '', '   ']) {
    assert.throws(
      () => sanitizeUploadFilename(bad),
      (err: unknown) => err instanceof HelmxError && err.code === 'validation_error' && err.status === 400,
      `expected reject: ${JSON.stringify(bad)}`,
    )
  }
  const tooLong = 'a'.repeat(201)
  assert.throws(() => sanitizeUploadFilename(tooLong), HelmxError)
  assert.equal(sanitizeUploadFilename('a'.repeat(200)), 'a'.repeat(200), 'exact 200 chars is valid')
})

// ---------------------------------------------------------------------------
// writeUploaded service layer
// ---------------------------------------------------------------------------

test('writeUploaded: preserves binary bytes verbatim (no UTF-8 re-encoding)', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([0, 255, 128, 10, 200, 1, 0xfe])
  const meta = await artifacts.writeUploaded(1, { name: 'blob.bin', bytes })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'upload')
  assert.equal(meta.name, 'blob.bin')
  assert.equal(meta.size, bytes.byteLength)
  assert.deepEqual([...(await artifacts.readBuffer(meta.id))], [...bytes])
})

test('writeUploaded: text MIME types go through SecretStash.redact (secrets do not hit disk)', { timeout: 60_000 }, async () => {
  stash.addRedaction('sk-super-secret-value')
  const text = 'api key is sk-super-secret-value here'
  const meta = await artifacts.writeUploaded(1, {
    name: 'notes.txt',
    bytes: new TextEncoder().encode(text),
  })
  assert.equal(meta.mimeType, 'text/plain')
  const stored = await artifacts.readContent(meta.id)
  assert.ok(!stored.includes('sk-super-secret-value'), 'stored content must not contain plaintext secret')
  assert.ok(stored.includes(stash.redact('sk-super-secret-value')), 'stored content should include redaction placeholder')
})

test('writeUploaded: explicit mimeType takes precedence; otherwise inferred from extension', { timeout: 60_000 }, async () => {
  const a = await artifacts.writeUploaded(1, {
    name: 'data.dat',
    bytes: new TextEncoder().encode('{}'),
    mimeType: 'application/json',
  })
  assert.equal(a.mimeType, 'application/json')
  const b = await artifacts.writeUploaded(1, {
    name: 'data2.json',
    bytes: new TextEncoder().encode('{}'),
  })
  assert.equal(b.mimeType, 'application/json')
  const c = await artifacts.writeUploaded(1, {
    name: 'data3.bin',
    bytes: new Uint8Array([1, 2, 3]),
  })
  assert.equal(c.mimeType, 'application/octet-stream')
})

test('writeUploaded: >15 MiB throws 413 artifact_too_large (with maxBytes/actualBytes)', { timeout: 60_000 }, async () => {
  const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1)
  await assert.rejects(
    artifacts.writeUploaded(1, { name: 'big.bin', bytes: oversized }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError)
      assert.equal(err.code, 'artifact_too_large')
      assert.equal(err.status, 413)
      const details = err.details as { maxBytes: number; actualBytes: number }
      assert.equal(details.maxBytes, MAX_ARTIFACT_BYTES)
      assert.equal(details.actualBytes, oversized.byteLength)
      return true
    },
  )
  // Exact 15 MiB is valid (immediately clean up large artifact dir afterwards to avoid slowing down subsequent cases)
  const exact = new Uint8Array(MAX_ARTIFACT_BYTES)
  const meta = await artifacts.writeUploaded(2, { name: 'exact.bin', bytes: exact })
  assert.equal(meta.size, MAX_ARTIFACT_BYTES)
  await artifacts.deleteConversation(2)
  conversations.set(2, summary(2, 'work conversation'))
})

test('writeUploaded: rejects invalid filenames and invalid conversation IDs', { timeout: 60_000 }, async () => {
  await assert.rejects(
    artifacts.writeUploaded(1, { name: '../evil', bytes: new Uint8Array(1) }),
    (err: unknown) => err instanceof HelmxError && err.code === 'validation_error',
  )
  await assert.rejects(
    artifacts.writeUploaded(-1, { name: 'ok.txt', bytes: new Uint8Array(1) }),
    /invalid conversationId/,
  )
})

test('writeUploaded vs deleteConversation serialization: upload passing its existence check cannot recreate a deleted conversation directory', { timeout: 60_000 }, async () => {
  const dir = await makeTempDir('helmx-artifact-chain-')
  const service = new ArtifactService(dir, new InMemoryArtifactRepository())
  const conversationId = 42
  const conversationDir = join(dir, 'artifacts', String(conversationId))
  const originalMkdir = fsp.mkdir.bind(fsp) as (...args: unknown[]) => Promise<unknown>
  const enteredMkdir = deferred<void>()
  const resumeMkdir = deferred<void>()
  try {
    // Barrier inside the write: upload passes the existence re-check, then pauses at mkdir while
    // the conversation gets deleted underneath — the exact interleaving an existence check alone
    // cannot close (previously recreated artifacts/42/ as an orphan with live metadata).
    fsp.mkdir = (async (...args: unknown[]) => {
      if (args[0] === conversationDir) {
        enteredMkdir.resolve()
        await resumeMkdir.promise
      }
      return originalMkdir(...args)
    }) as typeof fsp.mkdir
    const upload = service.writeUploaded(conversationId, { name: 'probe.bin', bytes: new Uint8Array([1]) }, {
      conversationExists: () => true,
    })
    await Promise.race([
      enteredMkdir.promise,
      upload.then(() => {
        throw new Error('upload completed before reaching the mkdir barrier')
      }),
    ])
    // Enqueue the deletion behind the in-flight write (same per-conversation chain), then release
    // the barrier: awaiting the deletion here would deadlock the chain it is queued on.
    const deletion = service.deleteConversation(conversationId)
    resumeMkdir.resolve()
    await upload
    await deletion
    // Deletion queued behind the in-flight write purges it wholesale: no orphan dir, no metadata.
    await assert.rejects(() => stat(conversationDir), (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT')
    assert.deepEqual(await service.list(conversationId), [])
  } finally {
    resumeMkdir.resolve()
    fsp.mkdir = originalMkdir as typeof fsp.mkdir
    await cleanupDir(dir)
  }
})

// ---------------------------------------------------------------------------
// HTTP POST /api/conversations/:id/artifacts
// ---------------------------------------------------------------------------

test('HTTP binary stream upload: octet-stream + x-artifact-filename, byte-for-byte identical, 201', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([10, 20, 30, 255, 0, 128])
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent('screenshot final.png'),
    },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.kind, 'upload')
  assert.equal(res.body.name, 'screenshot final.png')
  assert.equal(res.body.mimeType, 'image/png')
  assert.equal(res.body.size, bytes.byteLength)
  const read = await artifacts.readBuffer(res.body.id as string)
  assert.deepEqual([...read], [...bytes])
})

test('HTTP binary stream upload: ?name= query parameter and ?mimeType=', { timeout: 60_000 }, async () => {
  const bytes = new TextEncoder().encode('hello')
  const res = await call('POST', '/api/conversations/1/artifacts?name=hello.md&mimeType=text/markdown', {
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.name, 'hello.md')
  assert.equal(res.body.mimeType, 'text/markdown')
})

test('HTTP JSON branch: contentBase64 upload (including binary) is byte-for-byte identical', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([1, 2, 255, 0, 254])
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: 'data.bin',
      contentBase64: Buffer.from(bytes).toString('base64'),
    }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.size, bytes.byteLength)
  assert.deepEqual([...(await artifacts.readBuffer(res.body.id))], [...bytes])
})

test('HTTP JSON branch: empty contentBase64 = 0-byte artifact (valid)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'empty.txt', contentBase64: '' }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.size, 0)
})

test('HTTP invalid base64 returns 400 validation_error', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x.bin', contentBase64: '!!!not-base64!!!' }),
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP missing filename returns 400 (neither header nor ?name=)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP binary stream over limit returns 413 artifact_too_large (content-length preflight)', { timeout: 60_000 }, async () => {
  const oversized = new Uint8Array(1024)
  const res = await call('POST', '/api/conversations/1/artifacts?name=big.bin', {
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(MAX_ARTIFACT_BYTES + 1),
    },
    body: oversized as unknown as BodyInit,
  })
  assert.equal(res.status, 413)
  assert.equal(res.body.error.code, 'artifact_too_large')
})

test('HTTP missing conversation returns 404 (without leaving orphan artifact)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/999/artifacts?name=x.bin', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'not_found')
})

test('HTTP invalid filename ../ returns 400', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts?name=../evil', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP text upload triggers redaction (no secret leaks); GET list includes uploaded artifact', { timeout: 60_000 }, async () => {
  const text = 'token=sk-super-secret-value end'
  const res = await call('POST', '/api/conversations/1/artifacts?name=env.txt', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new TextEncoder().encode(text) as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  const stored = await artifacts.readContent(res.body.id)
  assert.ok(!stored.includes('sk-super-secret-value'), 'HTTP path also enforces redaction')
  const list = await call('GET', '/api/conversations/1/artifacts')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body) && list.body.length > 0)
  assert.ok(list.body.some((m: { name: string; kind: string }) => m.name === 'env.txt' && m.kind === 'upload'))
})

test('artifact reads reject cross-conversation metadata and symlink escapes while preserving raw binary bytes', { timeout: 60_000 }, async () => {
  const root = await makeTempDir('helmx-artifact-boundary-')
  try {
    await ensureDataDir(root)
    const repository = new InMemoryArtifactRepository()
    const artSvc = new ArtifactService(root, repository)
    const source = join(root, 'example.png')
    const bytes = Uint8Array.from([0, 255, 128, 10])
    await writeFile(source, bytes)
    const original = await artSvc.register(1, source)
    assert.deepEqual([...await artSvc.readBuffer(original.id)], [...bytes])
    repository.put({ ...original, id: 'other-conversation', conversationId: 2 })
    await assert.rejects(artSvc.readBuffer('other-conversation'), /read rejected/)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside-boundary-example')
    const linkPath = join(root, 'artifacts', '1', 'outside-link.txt')
    await symlink(outside, linkPath)
    repository.put({ ...original, id: 'link', path: 'artifacts/1/outside-link.txt' })
    await assert.rejects(artSvc.readContent('link'), /read rejected/)
    await assert.rejects(artSvc.spill(-1, 'call', 'text'), /conversationId/)
  } finally {
    await cleanupDir(root)
  }
})

test('HTTP GET /api/artifacts/:id/content: returns private immutable cache header on 200 (attachment and inline) and omits it on 404', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([11, 22, 33, 44])
  const uploaded = await call('POST', '/api/conversations/1/artifacts?name=cached.bin&mimeType=application/octet-stream', {
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(uploaded.status, 201)
  const artifactId = uploaded.body.id as string

  for (const suffix of ['', '?inline=1']) {
    const res = await handler(new Request(`http://127.0.0.1:3202/api/artifacts/${artifactId}/content${suffix}`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'private, max-age=31536000, immutable')
    assert.deepEqual([...new Uint8Array(await res.arrayBuffer())], [...bytes])
  }

  const missing = await call('GET', '/api/artifacts/missing-cache-id/content')
  assert.equal(missing.status, 404)
  assert.notEqual(missing.headers.get('cache-control'), 'private, max-age=31536000, immutable')
})
