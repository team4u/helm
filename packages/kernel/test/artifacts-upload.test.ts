/**
 * module one test: across platform HTTP artifact upload.
 * - ArtifactService.writeUploaded: two enter system byte consistent, text SecretStash redaction,
 *   over 15 MiB 413, illegal filename 400;
 * - HTTP POST /api/conversations/:id/artifacts:
 *   - two enter system stream (octet-stream + x-artifact-filename) byte consistent;
 *   - JSON branch (name + contentBase64);
 *   - illegal base64 400; missing filename 400; over limit 413; conversation missing 404;
 *   - text upload trigger stash redaction (secret do not);
 *   - GET list contains new artifact.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { symlink, writeFile } from 'node:fs/promises'
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
import type { EventHub, KernelRuntimeLike} from '../src/http/index.js'
import { HelmError, type ConversationSummary } from '@helm/protocol'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { MemoryDocStore, cleanupDir, makeConversationSummary, makeTempDir } from './helpers.js'

// ---------------------------------------------------------------------------
// base seat
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
    listNodes() { throw new Error('this artifact fixture do not provide node manage') },
    async issueNodeToken() { throw new Error('this artifact fixture do not sign node identity') },
    async removeNode() { throw new Error('this artifact fixture do not remove node') },
    async execEnv() { throw new Error('this artifact fixture do not execute node command') },
    dataDir,
    auth: new AuthService(dataDir),
    events: new NoopEventHub(),
    profiles: new ProfileService(dataDir),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    artifacts,
    plugins: new PluginHost({ buildProvider: createPluginBuildProvider(),
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
      if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      return { ...found, entries: [] }
    },
    async getConversationEntry(id: number, entryId: number) {
      if (!conversations.has(id)) throw new HelmError('not_found', `conversation missing: ${id}`, 404)
      throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404)
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
  dataDir = await makeTempDir('helm-upload-test-')
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  conversations.set(1, summary(1, 'person assist'))
  conversations.set(2, summary(2, 'work conversation'))
  const kernel = makeKernel()
  handler = createHubHandler(kernel)
  // setup take token
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
// sanitizeUploadFilename unit
// ---------------------------------------------------------------------------

test('sanitizeUploadFilename: legal name via; illegal name 400 validation_error', { timeout: 60_000 }, () => {
  assert.equal(sanitizeUploadFilename('  report.md  '), 'report.md')
  assert.equal(sanitizeUploadFilename('data file.json'), 'data file.json')
  for (const bad of ['../etc/passwd', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '', '   ']) {
    assert.throws(
      () => sanitizeUploadFilename(bad),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
      `expected reject: ${JSON.stringify(bad)}`,
    )
  }
  const tooLong = 'a'.repeat(201)
  assert.throws(() => sanitizeUploadFilename(tooLong), HelmError)
  assert.equal(sanitizeUploadFilename('a'.repeat(200)), 'a'.repeat(200), 'exactly 200 legal')
})

// ---------------------------------------------------------------------------
// writeUploaded service layer
// ---------------------------------------------------------------------------

test('writeUploaded: two enter system byte original (does not UTF-8 heavy encode)', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([0, 255, 128, 10, 200, 1, 0xfe])
  const meta = await artifacts.writeUploaded(1, { name: 'blob.bin', bytes })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.kind, 'upload')
  assert.equal(meta.name, 'blob.bin')
  assert.equal(meta.size, bytes.byteLength)
  assert.deepEqual([...(await artifacts.readBuffer(meta.id))], [...bytes])
})

test('writeUploaded: text class mime via SecretStash.redact redaction (secret do not)', { timeout: 60_000 }, async () => {
  stash.addRedaction('sk-super-secret-value')
  const text = 'api key is sk-super-secret-value here'
  const meta = await artifacts.writeUploaded(1, {
    name: 'notes.txt',
    bytes: new TextEncoder().encode(text),
  })
  assert.equal(meta.mimeType, 'text/plain')
  const stored = await artifacts.readContent(meta.id)
  assert.ok(!stored.includes('sk-super-secret-value'), 'content must not contains secret plaintext')
  assert.ok(stored.includes(stash.redact('sk-super-secret-value')), 'content should contains redaction occupy')
})

test('writeUploaded: explicit mimeType takes precedence; default by extension push assert', { timeout: 60_000 }, async () => {
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

test('writeUploaded: exceeds 15 MiB throw 413 artifact_too_large(contains maxBytes/actualBytes)', { timeout: 60_000 }, async () => {
  const oversized = new Uint8Array(MAX_ARTIFACT_BYTES + 1)
  await assert.rejects(
    artifacts.writeUploaded(1, { name: 'big.bin', bytes: oversized }),
    (err: unknown) => {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, 'artifact_too_large')
      assert.equal(err.status, 413)
      const details = err.details as { maxBytes: number; actualBytes: number }
      assert.equal(details.maxBytes, MAX_ARTIFACT_BYTES)
      assert.equal(details.actualBytes, oversized.byteLength)
      return true
    },
  )
  // exactly 15 MiB legal (let through after immediately clean up large file directory avoid drag slow after continue case)
  const exact = new Uint8Array(MAX_ARTIFACT_BYTES)
  const meta = await artifacts.writeUploaded(2, { name: 'exact.bin', bytes: exact })
  assert.equal(meta.size, MAX_ARTIFACT_BYTES)
  await artifacts.deleteConversation(2)
  conversations.set(2, summary(2, 'work conversation'))
})

test('writeUploaded: illegal filename and illegal conversation ID reject', { timeout: 60_000 }, async () => {
  await assert.rejects(
    artifacts.writeUploaded(1, { name: '../evil', bytes: new Uint8Array(1) }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
  )
  await assert.rejects(
    artifacts.writeUploaded(-1, { name: 'ok.txt', bytes: new Uint8Array(1) }),
    /illegal conversationId/,
  )
})

// ---------------------------------------------------------------------------
// HTTP POST /api/conversations/:id/artifacts
// ---------------------------------------------------------------------------

test('HTTP two enter system stream upload:octet-stream + x-artifact-filename, byte consistent,201', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([10, 20, 30, 255, 0, 128])
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent('truncate diagram final.png'),
    },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.kind, 'upload')
  assert.equal(res.body.name, 'truncate diagram final.png')
  assert.equal(res.body.mimeType, 'image/png')
  assert.equal(res.body.size, bytes.byteLength)
  const read = await artifacts.readBuffer(res.body.id as string)
  assert.deepEqual([...read], [...bytes])
})

test('HTTP two enter system stream upload:?name= query parameter and x-artifact-mime-type', { timeout: 60_000 }, async () => {
  const bytes = new TextEncoder().encode('hello')
  const res = await call('POST', '/api/conversations/1/artifacts?name=hello.md&mimeType=text/markdown', {
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.name, 'hello.md')
  assert.equal(res.body.mimeType, 'text/markdown')
})

test('HTTP JSON branch:contentBase64 upload (contains two enter system) byte consistent', { timeout: 60_000 }, async () => {
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

test('HTTP JSON branch: empty contentBase64 = 0 byte artifact (legal)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'empty.txt', contentBase64: '' }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.size, 0)
})

test('HTTP illegal base64 400 validation_error', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x.bin', contentBase64: '!!!not-base64!!!' }),
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP missing filename 400(without head also without ?name=)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP two enter system stream over limit 413 artifact_too_large(content-length preflight)', { timeout: 60_000 }, async () => {
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

test('HTTP conversation missing 404(do not orphan child artifact)', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/999/artifacts?name=x.bin', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'not_found')
})

test('HTTP illegal filename ../ return 400', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts?name=../evil', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP text upload trigger redaction (secret do not);GET list contains all artifact', { timeout: 60_000 }, async () => {
  const text = 'token=sk-super-secret-value end'
  const res = await call('POST', '/api/conversations/1/artifacts?name=env.txt', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new TextEncoder().encode(text) as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  const stored = await artifacts.readContent(res.body.id)
  assert.ok(!stored.includes('sk-super-secret-value'), 'HTTP path same guard redaction')
  const list = await call('GET', '/api/conversations/1/artifacts')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body) && list.body.length > 0)
  assert.ok(list.body.some((m: { name: string; kind: string }) => m.name === 'env.txt' && m.kind === 'upload'))
})

test('artifact read reject across conversation metadata and symlink out of bounds, keep two enter system byte', { timeout: 60_000 }, async () => {
  const root = await makeTempDir('helm-artifact-boundary-')
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
    await assert.rejects(artSvc.readBuffer('other-conversation'), /reject read/)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside-boundary-example')
    const linkPath = join(root, 'artifacts', '1', 'outside-link.txt')
    await symlink(outside, linkPath)
    repository.put({ ...original, id: 'link', path: 'artifacts/1/outside-link.txt' })
    await assert.rejects(artSvc.readContent('link'), /reject read/)
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
