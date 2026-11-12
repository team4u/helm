/**
 * 模块一测试：跨平台 HTTP 产物上传。
 * - ArtifactService.writeUploaded：二进制字节一致、文本 SecretStash 脱敏落盘、
 *   超 15 MiB 413、非法文件名 400；
 * - HTTP POST /api/conversations/:id/artifacts：
 *   - 二进制流（octet-stream + x-artifact-filename）字节一致；
 *   - JSON 分支（name + contentBase64）；
 *   - 非法 base64 400；缺文件名 400；超限 413；会话不存在 404；
 *   - 文本上传触发 stash 脱敏（秘密不落盘）；
 *   - GET 列表包含新产物。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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

// ---------------------------------------------------------------------------
// 基座
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
  return {
    id,
    title,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: 'faux/model',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function makeKernel(): KernelRuntimeLike {
  return {
    listNodes() { throw new Error('本产物 fixture 不提供节点管理') },
    async issueNodeToken() { throw new Error('本产物 fixture 不签发节点身份') },
    async removeNode() { throw new Error('本产物 fixture 不移除节点') },
    async execEnv() { throw new Error('本产物 fixture 不执行节点命令') },
    dataDir,
    auth: new AuthService(dataDir),
    events: new NoopEventHub(),
    profiles: new ProfileService(dataDir),
    skills: new SkillService(dataDir),
    credentials: new CredentialService(dataDir),
    providers: new ProviderService(dataDir),
    artifacts,
    plugins: new PluginHost({
      dataDir,
      host: undefined as unknown as PluginHostBackend,
      docs: {
        get: <T,>(_key: string, initial: T): T => initial,
        set: <T,>(_key: string, _value: T): void => {},
        deletePlugin: (_pluginId: string): void => {},
        flush: async () => {},
      },
    }),
    stash,
    async listConversations() {
      return [...conversations.values()]
    },
    async getConversationDetail(id: number) {
      const found = conversations.get(id)
      if (found === undefined) throw new HelmError('not_found', `会话不存在: ${id}`, 404)
      return { ...found, entries: [] }
    },
    async createConversation(init) {
      const id = Math.max(0, ...conversations.keys()) + 1
      const created = summary(id, init?.title ?? `会话 ${id}`)
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
      return summary(id + 100, `会话 ${id} (分叉)`)
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
  dataDir = await mkdtemp(join(tmpdir(), 'helm-upload-test-'))
  stash = new SecretStash()
  artifacts = new ArtifactService(dataDir, new InMemoryArtifactRepository(), stash)
  conversations.set(1, summary(1, '个人助理'))
  conversations.set(2, summary(2, '工作会话'))
  const kernel = makeKernel()
  handler = createHubHandler(kernel)
  // setup 拿 token
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
  await rm(dataDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// sanitizeUploadFilename 单元
// ---------------------------------------------------------------------------

test('sanitizeUploadFilename：合法名通过；非法名 400 validation_error', { timeout: 60_000 }, () => {
  assert.equal(sanitizeUploadFilename('  report.md  '), 'report.md')
  assert.equal(sanitizeUploadFilename('数据文件.json'), '数据文件.json')
  for (const bad of ['../etc/passwd', '..', '.', 'a/b', 'a\\b', 'a\0b', 'a\nb', '', '   ']) {
    assert.throws(
      () => sanitizeUploadFilename(bad),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && err.status === 400,
      `expected reject: ${JSON.stringify(bad)}`,
    )
  }
  const tooLong = 'a'.repeat(201)
  assert.throws(() => sanitizeUploadFilename(tooLong), HelmError)
  assert.equal(sanitizeUploadFilename('a'.repeat(200)), 'a'.repeat(200), '恰好 200 合法')
})

// ---------------------------------------------------------------------------
// writeUploaded 服务层
// ---------------------------------------------------------------------------

test('writeUploaded：二进制字节原样落盘（不做 UTF-8 重编码）', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([0, 255, 128, 10, 200, 1, 0xfe])
  const meta = await artifacts.writeUploaded(1, { name: 'blob.bin', bytes })
  assert.equal(meta.conversationId, 1)
  assert.equal(meta.name, 'blob.bin')
  assert.equal(meta.size, bytes.byteLength)
  assert.deepEqual([...(await artifacts.readBuffer(meta.id))], [...bytes])
})

test('writeUploaded：文本类 mime 经 SecretStash.redact 脱敏落盘（秘密不落盘）', { timeout: 60_000 }, async () => {
  stash.addRedaction('sk-super-secret-value')
  const text = 'api key is sk-super-secret-value here'
  const meta = await artifacts.writeUploaded(1, {
    name: 'notes.txt',
    bytes: new TextEncoder().encode(text),
  })
  assert.equal(meta.mimeType, 'text/plain')
  const stored = await artifacts.readContent(meta.id)
  assert.ok(!stored.includes('sk-super-secret-value'), '落盘内容不得含秘密明文')
  assert.ok(stored.includes(stash.redact('sk-super-secret-value')), '落盘内容应含脱敏占位')
})

test('writeUploaded：显式 mimeType 优先；缺省按扩展名推断', { timeout: 60_000 }, async () => {
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

test('writeUploaded：超过 15 MiB 抛 413 artifact_too_large（含 maxBytes/actualBytes）', { timeout: 60_000 }, async () => {
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
  // 恰好 15 MiB 合法（放行后立刻清理大文件目录避免拖慢后续用例）
  const exact = new Uint8Array(MAX_ARTIFACT_BYTES)
  const meta = await artifacts.writeUploaded(2, { name: 'exact.bin', bytes: exact })
  assert.equal(meta.size, MAX_ARTIFACT_BYTES)
  await artifacts.deleteConversation(2)
  conversations.set(2, summary(2, '工作会话'))
})

test('writeUploaded：非法文件名与非法会话 ID 拒绝', { timeout: 60_000 }, async () => {
  await assert.rejects(
    artifacts.writeUploaded(1, { name: '../evil', bytes: new Uint8Array(1) }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
  )
  await assert.rejects(
    artifacts.writeUploaded(-1, { name: 'ok.txt', bytes: new Uint8Array(1) }),
    /非法 conversationId/,
  )
})

// ---------------------------------------------------------------------------
// HTTP POST /api/conversations/:id/artifacts
// ---------------------------------------------------------------------------

test('HTTP 二进制流上传：octet-stream + x-artifact-filename，字节一致，201', { timeout: 60_000 }, async () => {
  const bytes = Uint8Array.from([10, 20, 30, 255, 0, 128])
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: {
      'content-type': 'application/octet-stream',
      'x-artifact-filename': encodeURIComponent('截图 final.png'),
    },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.name, '截图 final.png')
  assert.equal(res.body.mimeType, 'image/png')
  assert.equal(res.body.size, bytes.byteLength)
  const read = await artifacts.readBuffer(res.body.id as string)
  assert.deepEqual([...read], [...bytes])
})

test('HTTP 二进制流上传：?name= 查询参数与 x-artifact-mime-type', { timeout: 60_000 }, async () => {
  const bytes = new TextEncoder().encode('hello')
  const res = await call('POST', '/api/conversations/1/artifacts?name=hello.md&mimeType=text/markdown', {
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.name, 'hello.md')
  assert.equal(res.body.mimeType, 'text/markdown')
})

test('HTTP JSON 分支：contentBase64 上传（含二进制）字节一致', { timeout: 60_000 }, async () => {
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

test('HTTP JSON 分支：空 contentBase64 = 0 字节产物（合法）', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'empty.txt', contentBase64: '' }),
  })
  assert.equal(res.status, 201)
  assert.equal(res.body.size, 0)
})

test('HTTP 非法 base64 400 validation_error', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x.bin', contentBase64: '!!!not-base64!!!' }),
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP 缺文件名 400（无头也无 ?name=）', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP 二进制流超限 413 artifact_too_large（content-length 预检）', { timeout: 60_000 }, async () => {
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

test('HTTP 会话不存在 404（不留孤儿产物）', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/999/artifacts?name=x.bin', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'not_found')
})

test('HTTP 非法文件名 ../ 返回 400', { timeout: 60_000 }, async () => {
  const res = await call('POST', '/api/conversations/1/artifacts?name=../evil', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new Uint8Array([1]) as unknown as BodyInit,
  })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'validation_error')
})

test('HTTP 文本上传触发脱敏（秘密不落盘）；GET 列表包含全部产物', { timeout: 60_000 }, async () => {
  const text = 'token=sk-super-secret-value end'
  const res = await call('POST', '/api/conversations/1/artifacts?name=env.txt', {
    headers: { 'content-type': 'application/octet-stream' },
    body: new TextEncoder().encode(text) as unknown as BodyInit,
  })
  assert.equal(res.status, 201)
  const stored = await artifacts.readContent(res.body.id)
  assert.ok(!stored.includes('sk-super-secret-value'), 'HTTP 路径同样守住脱敏')
  const list = await call('GET', '/api/conversations/1/artifacts')
  assert.equal(list.status, 200)
  assert.ok(Array.isArray(list.body) && list.body.length > 0)
  assert.ok(list.body.some((m: { name: string }) => m.name === 'env.txt'))
})

test('产物读取拒绝跨会话元数据和软链越界，保持二进制字节', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'helm-artifact-boundary-'))
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
    await assert.rejects(artSvc.readBuffer('other-conversation'), /拒绝读取/)
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'outside-boundary-example')
    const linkPath = join(root, 'artifacts', '1', 'outside-link.txt')
    await symlink(outside, linkPath)
    repository.put({ ...original, id: 'link', path: 'artifacts/1/outside-link.txt' })
    await assert.rejects(artSvc.readContent('link'), /拒绝读取/)
    await assert.rejects(artSvc.spill(-1, 'call', 'text'), /conversationId/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
