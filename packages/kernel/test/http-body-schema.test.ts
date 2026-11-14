/**
 * HTTP body 边界 schema 化后的行为 parity 回归：
 * 机械类型/形状/未知字段校验迁移到 JSON Schema（AJV）后，必须与原手写
 * 校验保持同一拒绝面——特别是：
 * - 未知字段仍一律 400（auth setup/login 例外：历史上即未拒绝，保持宽容）；
 * - 显式 null 与缺省同拒（不当缺省静默忽略）；
 * - trim 语义差异端点各自锁定（install source 拒空白；models refresh
 *   provider 仅拒空串；upgrade targetVersion 允许首尾空白）；
 * - 安全整数上界（fork entryId / withdraw submissionId / input
 *   replaceFromEntryId 拒 2^60）；
 * - 错误可诊断：details.errors 携带 AJV 字段路径。
 * 以及薄分发后的路由 parity（多余段 404 / 方法不匹配 405|404 各归其位）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmError } from '@helm/protocol'
import { handleApi } from '../src/http/routes.js'
import { ValidationError } from '../src/http/validate.js'
import type { KernelRuntimeLike } from '../src/http/contracts.js'

type CallLog = Record<string, unknown[]>

function newCallLog(): CallLog {
  return {
    authSetup: [], authLogin: [], credentialSet: [], providersSave: [],
    pluginDisable: [], pluginConfig: [], actionInvoke: [], submitInput: [],
    resetConversation: [], forkConversation: [], answerAsk: [], withdrawQueuedInput: [],
    setDefaultModel: [], setDisabledModels: [], issueNodeToken: [],
    upgradeNode: [], startNodeForward: [], execEnv: [],
  }
}

function makeKernel(calls: CallLog = newCallLog()): KernelRuntimeLike {
  const kernel = {
    dataDir: '/tmp/helm-schema-parity',
    auth: {
      status: async () => ({ configured: true }),
      verifyToken: async () => true,
      setup: async (password: string) => {
        calls.authSetup!.push(password)
        return { token: 'issued-token' } as never
      },
      login: async (password: string) => {
        calls.authLogin!.push(password)
        return { token: 'issued-token' } as never
      },
    },
    events: { response: () => new Response(null, { status: 200 }) },
    profiles: {
      list: async () => [],
      get: async () => undefined,
      save: async (p: unknown) => p,
      delete: async () => {},
      getSystem: async () => '',
    },
    skills: { list: async () => [], readFile: async () => '' },
    credentials: {
      list: async () => [],
      set: async (id: string, value: string) => {
        calls.credentialSet!.push([id, value])
      },
      delete: async () => {},
    },
    providers: {
      list: async () => [],
      save: async (items: unknown) => {
        calls.providersSave!.push(items)
        return items
      },
    },
    artifacts: {
      get: async () => { throw new HelmError('not_found', 'x', 404) },
      list: async () => [],
      writeUploaded: async () => { throw new HelmError('not_found', 'x', 404) },
    },
    plugins: {
      list: async () => [],
      enable: async () => {},
      disable: async (id: string, opts?: { force?: boolean }) => {
        calls.pluginDisable!.push([id, opts])
      },
      listActions: async () => [],
      invokeAction: async (pluginId: string, actionId: string, input: unknown, ctx?: { conversationId?: number }) => {
        calls.actionInvoke!.push([pluginId, actionId, input, ctx])
        return null
      },
      getConfig: () => ({}),
      getConfigSchema: () => ({}),
      setConfig: (id: string, values: unknown) => {
        calls.pluginConfig!.push([id, values])
      },
      listRoutes: () => [],
      getPublicDoc: async () => ({ pluginId: 'p', name: 'n', value: {} }),
      getPublicSessionDoc: () => {
        throw new HelmError('not_found', 'doc 不存在', 404)
      },
      getClientModule: async () => {
        throw new HelmError('not_implemented', '未接线', 501)
      },
    },
    async listConversations() { return [] },
    async getConversationDetail(id: number) { throw new HelmError('not_found', `会话不存在: ${id}`, 404) },
    async createConversation() { throw new HelmError('not_found', 'x', 404) },
    async updateConversation() { throw new HelmError('not_found', 'x', 404) },
    async deleteConversation() { throw new HelmError('not_found', 'x', 404) },
    async submitInput(id: number, text: string, opts?: unknown) {
      calls.submitInput!.push([id, text, opts])
      return { submissionId: 'sub-1' }
    },
    async withdrawQueuedInput(id: number, opts: { submissionId: number }) {
      calls.withdrawQueuedInput!.push([id, opts])
      return { status: 'withdrawn' } as never
    },
    async waitForInput() { throw new HelmError('not_found', 'x', 404) },
    async abortConversation() {},
    async resetConversation(id: number, opts?: unknown) {
      calls.resetConversation!.push([id, opts])
      return { id }
    },
    async compactConversation() { throw new HelmError('not_found', 'x', 404) },
    async forkConversation(id: number, opts: unknown) {
      calls.forkConversation!.push([id, opts])
      return { id: id + 100 }
    },
    async listAsks() { return [] },
    async answerAsk(id: string, answers: unknown, expectedStateSeq?: number) {
      calls.answerAsk!.push([id, answers, expectedStateSeq])
    },
    async cancelAsk() {},
    async search() { return [] },
    listModels: async () => ({ models: [], thinkingLevels: {} }),
    setDisabledModels: async (provider: string | undefined, disabledModels: string[]) => {
      calls.setDisabledModels!.push([provider, disabledModels])
      return { models: [], thinkingLevels: {} }
    },
    setDefaultModel: async (model?: string, thinkingLevel?: string) => {
      calls.setDefaultModel!.push([model, thinkingLevel])
    },
    listModelProviders: async () => [],
    async listNodes() { return [] },
    async issueNodeToken(nodeId: string) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
        throw new HelmError('validation_error', 'nodeId 需匹配节点 ID 规则', 400, { nodeId })
      }
      calls.issueNodeToken!.push(nodeId)
      return { nodeId, token: 'node-token', createdAt: 0 } as never
    },
    async removeNode() {},
    checkNodeUpgrade: async () => ({ currentVersion: '1.0.0', latestVersion: '1.0.0', updateAvailable: false }),
    upgradeNode: async (nodeId: string, input?: unknown) => {
      calls.upgradeNode!.push([nodeId, input])
      return { ok: true, previousVersion: '1.0.0', targetVersion: '1.1.0', upgraded: true } as never
    },
    startNodeForward: async (nodeId: string, input: unknown) => {
      calls.startNodeForward!.push([nodeId, input])
      return {
        forwardId: 'fwd-11111111-2222-3333-4444-555555555555',
        nodeId, listenHost: '127.0.0.1', listenPort: 1, targetPort: 2,
        activeConnections: 0, totalConnections: 0,
      } as never
    },
    stopNodeForward: async () => {},
    getNodeForward: () => undefined,
    listNodeForwards: () => [],
    onNodeForwardEvent: () => () => {},
    execEnv: async (req: unknown) => {
      calls.execEnv!.push(req)
      return { ok: true, exitCode: 0, stdout: '', stderr: '', timedOut: false } as never
    },
  }
  return kernel as unknown as KernelRuntimeLike
}

async function call(
  kernel: KernelRuntimeLike,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; code?: string; json: any }> {
  try {
    const response = await handleApi(
      new Request(`http://hub${path}`, {
        method,
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
      }),
      kernel,
    )
    const json = (await response.json().catch(() => undefined)) as any
    return { status: response.status, code: json?.error?.code, json }
  } catch (error) {
    // ValidationError / HelmError 直接抛出（生产由 hub.ts 统一映射结构化响应）。
    if (error instanceof HelmError) return { status: error.status, code: error.code, json: undefined }
    throw error
  }
}

async function expect400(kernel: KernelRuntimeLike, method: string, path: string, body?: unknown, why?: string) {
  const res = await call(kernel, method, path, body)
  assert.equal(res.status, 400, `应 400 拒绝 ${why ?? JSON.stringify(body)}`)
  assert.equal(res.code, 'validation_error')
}

// ---------------------------------------------------------------------------
// 会话 body
// ---------------------------------------------------------------------------

test('input body：text 空串合法（202）；附件 ID/去重/空数组、枚举与安全整数边界', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/input', { text: '' })
  assert.equal(ok.status, 202)
  const submitted = calls.submitInput as unknown[][]
  assert.deepEqual(submitted[0], [1, '', {}])

  const dedup = await call(kernel, 'POST', '/api/conversations/1/input', { text: 'x', attachments: ['a', 'a', 'b'] })
  assert.equal(dedup.status, 202)
  assert.deepEqual(submitted[1]![2], { attachments: ['a', 'b'] })

  const emptyArr = await call(kernel, 'POST', '/api/conversations/1/input', { text: 'x', attachments: [] })
  assert.equal(emptyArr.status, 202)
  assert.deepEqual(submitted[2]![2], {})

  for (const bad of [
    {},
    { text: 1 },
    { text: 'x', whenBusy: 'nope' },
    { text: 'x', origin: 'robot' },
    { text: 'x', meta: [1] },
    { text: 'x', meta: 'str' },
    { text: 'x', attachments: 'a' },
    { text: 'x', attachments: ['bad id!'] },
    { text: 'x', replaceFromEntryId: 2 ** 60 },
    { text: 'x', replaceFromEntryId: 0 },
    { text: 'x', unknown: 1 },
  ]) {
    await expect400(kernel, 'POST', '/api/conversations/1/input', bad)
  }
})

test('fork/withdraw：安全正整数上界拒 2^60；未知字段拒；title 空串拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/fork', { entryId: 5, title: '分叉' })
  assert.equal(ok.status, 201)
  assert.deepEqual(calls.forkConversation![0], [1, { entryId: 5, title: '分叉' }])
  for (const bad of [
    {},
    { entryId: 1.5 },
    { entryId: 0 },
    { entryId: 2 ** 60 },
    { entryId: 1, title: '' },
    { entryId: 1, extra: 2 },
  ]) {
    await expect400(kernel, 'POST', '/api/conversations/1/fork', bad)
  }
  const w = await call(kernel, 'POST', '/api/conversations/1/withdraw', { submissionId: 9 })
  assert.equal(w.status, 200)
  await expect400(kernel, 'POST', '/api/conversations/1/withdraw', { submissionId: 2 ** 60 })
  await expect400(kernel, 'POST', '/api/conversations/1/withdraw', {})
})

test('reset body：handoff 空串合法；未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/reset', { handoff: '' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.resetConversation![0], [1, { handoff: '' }])
  await expect400(kernel, 'POST', '/api/conversations/1/reset', { handoff: 'x', extra: 1 })
})

test('ask answer：answers 逐值字符串、expectedStateSeq 非负整数、未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/asks/ask-1/answer', { answers: { a: 'x', b: '' }, expectedStateSeq: 0 })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.answerAsk![0], ['ask-1', { a: 'x', b: '' }, 0])
  for (const bad of [
    {},
    { answers: [] },
    { answers: 'x' },
    { answers: { a: 1 } },
    { answers: { a: 'x' }, expectedStateSeq: -1 },
    { answers: { a: 'x' }, expectedStateSeq: 1.5 },
    { answers: { a: 'x' }, extra: 1 },
  ]) {
    await expect400(kernel, 'POST', '/api/asks/ask-1/answer', bad)
  }
})

// ---------------------------------------------------------------------------
// 模型目录 body
// ---------------------------------------------------------------------------

test('models/default：空对象/空 body/显式 null/类型错/未知字段均 400；部分更新透传', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'PUT', '/api/models/default', { thinkingLevel: 'high' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.setDefaultModel![0], [undefined, 'high'])
  const clearModel = await call(kernel, 'PUT', '/api/models/default', { model: '' })
  assert.equal(clearModel.status, 200)
  assert.deepEqual(calls.setDefaultModel![1], ['', undefined])
  for (const bad of [{}, { model: null }, { thinkingLevel: 3 }, { other: 'high' }, '"str"', '[]']) {
    await expect400(kernel, 'PUT', '/api/models/default', bad)
  }
  const rawEmpty = await call(kernel, 'PUT', '/api/models/default', undefined)
  assert.equal(rawEmpty.status, 400)
  assert.equal(calls.setDefaultModel!.length, 2)
})

test('models/filter：disabledModels 必填字符串数组；未知字段/类型错 400', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'PUT', '/api/models/filter', { provider: 'p', disabledModels: ['m1'] })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.setDisabledModels![0], ['p', ['m1']])
  for (const bad of [
    {},
    undefined,
    { disabledModels: 'x' },
    { disabledModels: [1] },
    { provider: 1, disabledModels: [] },
    { disabledModels: [], extra: 1 },
  ]) {
    await expect400(kernel, 'PUT', '/api/models/filter', bad)
  }
})

test('models/refresh：=== "" 才拒（空白串历史放行）；provider+providers 合并；force 类型错拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const refreshCalls: unknown[] = []
  const kernel = makeKernel(calls)
  ;(kernel as { refreshModels?: unknown }).refreshModels = async (options?: unknown) => {
    refreshCalls.push(options)
    return { refreshed: [] } as never
  }
  // 空 body / {} 全量刷新（两次调用各记一条）。
  const emptyBody = await call(kernel, 'POST', '/api/models/refresh', undefined)
  assert.equal(emptyBody.status, 200)
  const emptyObj = await call(kernel, 'POST', '/api/models/refresh', {})
  assert.equal(emptyObj.status, 200)
  assert.deepEqual(refreshCalls[0], {})
  assert.deepEqual(refreshCalls[1], {})
  // 空白串 provider 历史上放行（仅 === '' 拒），schema 保持同一宽容度。
  const space = await call(kernel, 'POST', '/api/models/refresh', { provider: ' ' })
  assert.equal(space.status, 200, 'provider 空白串应放行（=== "" 语义）')
  assert.deepEqual(refreshCalls[2], { providers: [' '] })
  // provider + providers 合并。
  const merged = await call(kernel, 'POST', '/api/models/refresh', { provider: 'a', providers: ['b', 'c'], force: true })
  assert.equal(merged.status, 200)
  assert.deepEqual(refreshCalls[3], { providers: ['a', 'b', 'c'], force: true })
  for (const bad of [
    { provider: '' },
    { providers: ['a', ''] },
    { providers: 'a' },
    { force: 1 },
    { force: 'yes' },
    { extra: true },
  ]) {
    await expect400(kernel, 'POST', '/api/models/refresh', bad)
  }
})

test('providers PUT：数组与 { providers } 包裹同规；逐项字段错/未知项字段 400', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const good = {
    id: 'faux', protocol: 'openai', baseUrl: 'https://api.example.com', models: ['m'], enabled: true,
  }
  const asArray = await call(kernel, 'PUT', '/api/providers', [good])
  assert.equal(asArray.status, 200)
  const wrapped = await call(kernel, 'PUT', '/api/providers', { providers: [good] })
  assert.equal(wrapped.status, 200)
  assert.equal(calls.providersSave!.length, 2)
  for (const bad of [
    '"str"',
    42,
    {},
    { providers: 'x' },
    { providers: [{}] },
    { providers: [{ ...good, id: 'bad id!' }] },
    { providers: [{ ...good, protocol: 'grpc' }] },
    { providers: [{ ...good, baseUrl: 'ftp://x' }] },
    { providers: [{ ...good, models: 'm' }] },
    { providers: [{ ...good, enabled: 'yes' }] },
    { providers: [{ ...good, extra: 1 }] },
    { providers: [{ id: 'faux', protocol: 'openai', baseUrl: 'https://x', models: [] }] },
    { providers: [good], extra: 1 },
  ]) {
    await expect400(kernel, 'PUT', '/api/providers', bad)
  }
})

test('credentials PUT：value 1..64k 必填；未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'PUT', '/api/credentials/faux', { value: 'k' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.credentialSet![0], ['faux', 'k'])
  await expect400(kernel, 'PUT', '/api/credentials/faux', { value: '' })
  await expect400(kernel, 'PUT', '/api/credentials/faux', { value: 'k', extra: 1 })
  await expect400(kernel, 'PUT', '/api/credentials/faux', {})
  await expect400(kernel, 'PUT', '/api/credentials/faux', { value: 'x'.repeat(64 * 1024 + 1) })
})

// ---------------------------------------------------------------------------
// 插件 body
// ---------------------------------------------------------------------------

test('actions invoke：input 必填（null 合法）；conversationId 正整数；未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const withNull = await call(kernel, 'POST', '/api/actions/builtin:x/echo', { input: null })
  assert.equal(withNull.status, 200)
  const invoked = calls.actionInvoke as unknown[][]
  assert.deepEqual(invoked[0], ['builtin:x', 'echo', null, undefined])
  const withCtx = await call(kernel, 'POST', '/api/actions/builtin:x/echo', { input: { a: 1 }, conversationId: 3 })
  assert.equal(withCtx.status, 200)
  assert.deepEqual(invoked[1]![3], { conversationId: 3 })
  for (const bad of [
    {},
    { conversationId: 3 },
    { input: {}, conversationId: 1.5 },
    { input: {}, conversationId: 0 },
    { input: {}, extra: 1 },
  ]) {
    await expect400(kernel, 'POST', '/api/actions/builtin:x/echo', bad)
  }
})

test('plugins disable body：仅 force 布尔；body 与 query force 同义', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/plugins/builtin:x/disable', { force: true })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.pluginDisable![0], ['builtin:x', { force: true }])
  const viaQuery = await call(kernel, 'POST', '/api/plugins/builtin:x/disable?force=1')
  assert.equal(viaQuery.status, 200)
  assert.deepEqual(calls.pluginDisable![1], ['builtin:x', { force: true }])
  await expect400(kernel, 'POST', '/api/plugins/builtin:x/disable', { force: 'yes' })
  await expect400(kernel, 'POST', '/api/plugins/builtin:x/disable', { extra: 1 })
})

test('plugins config PUT：values 标量映射；数组/嵌套对象/未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'PUT', '/api/plugins/builtin:x/config', { values: { a: 'x', b: 1, c: null, d: true } })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.pluginConfig![0], ['builtin:x', { a: 'x', b: 1, c: null, d: true }])
  for (const bad of [
    {},
    { values: [] },
    { values: 'x' },
    { values: { nested: { deep: 1 } } },
    { values: { arr: [1] } },
    { values: {}, extra: 1 },
  ]) {
    await expect400(kernel, 'PUT', '/api/plugins/builtin:x/config', bad)
  }
})

// ---------------------------------------------------------------------------
// 节点 body（issue / upgrade / forward / env exec）
// ---------------------------------------------------------------------------

test('nodes issue：nodeId 非空必填；未知字段在 HTTP 边界拒（服务层模式校验兜底）', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/nodes/issue', { nodeId: 'node.a-1' })
  assert.equal(ok.status, 201)
  assert.equal(calls.issueNodeToken![0], 'node.a-1')
  await expect400(kernel, 'POST', '/api/nodes/issue', {})
  await expect400(kernel, 'POST', '/api/nodes/issue', { nodeId: '' })
  await expect400(kernel, 'POST', '/api/nodes/issue', { nodeId: 1 })
  await expect400(kernel, 'POST', '/api/nodes/issue', { nodeId: 'x', extra: 1 })
})

test('nodes upgrade：attemptId 不可控；targetVersion 保留首尾空白原值透传；严格 SemVer 与 URL 边界', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  // 空 body 合法（升级到 latest）。
  const empty = await call(kernel, 'POST', '/api/nodes/node-a/upgrade')
  assert.equal(empty.status, 200)
  assert.deepEqual(calls.upgradeNode![0], ['node-a', {}])
  // trim 后合法的版本保留原始值透传（原实现 trim 后校验、原值传递）。
  const spaced = await call(kernel, 'POST', '/api/nodes/node-a/upgrade', { targetVersion: '  v1.2.3  ' })
  assert.equal(spaced.status, 200)
  assert.deepEqual(calls.upgradeNode![1], ['node-a', { targetVersion: '  v1.2.3  ' }])
  for (const bad of [
    { attemptId: 'user-controlled' },
    { force: 'yes' },
    { registryUrl: 'javascript:alert(1)' },
    { registryUrl: 'ftp://x' },
    { targetVersion: null },
    { targetVersion: 1 },
    { targetVersion: 'x'.repeat(65) },
    { targetVersion: '   ' },
    { targetVersion: '1.2' },
    { targetVersion: '1.2.3-+bad' },
  ]) {
    await expect400(kernel, 'POST', '/api/nodes/node-a/upgrade', bad)
  }
  // upgrade/check?registryUrl 非 http(s) 同拒。
  const badCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=ftp://x')
  assert.equal(badCheck.status, 400)
  const okCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=https://registry.example.com')
  assert.equal(okCheck.status, 200)
})

test('nodes forward：主机名禁空白与控制字符、端口 1..65535、未知字段拒', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/nodes/node-a/forward', { listenHost: '127.0.0.1', listenPort: 18080, targetPort: 80 })
  assert.equal(ok.status, 201)
  const forwards = calls.startNodeForward as unknown[][]
  assert.deepEqual(forwards[0]![1], {
    listenHost: '127.0.0.1', listenPort: 18080, targetPort: 80,
  })
  const withTarget = await call(kernel, 'POST', '/api/nodes/node-a/forward', { listenHost: 'db.internal', listenPort: 1, targetHost: 'remote', targetPort: 2 })
  assert.equal(withTarget.status, 201)
  assert.deepEqual(forwards[1]![1], {
    listenHost: 'db.internal', listenPort: 1, targetHost: 'remote', targetPort: 2,
  })
  for (const bad of [
    {},
    { listenHost: '127.0.0.1', listenPort: 18080 },
    { listenHost: 'x', listenPort: 1, targetPort: 2, targetHost: 'bad host' },
    { listenHost: 'x', listenPort: 1, targetPort: 2, targetHost: ' leading' },
    { listenHost: 'a b', listenPort: 1, targetPort: 2 },
    { listenHost: 'a\tb', listenPort: 1, targetPort: 2 },
    { listenHost: 'a\x01b', listenPort: 1, targetPort: 2 },
    { listenHost: '', listenPort: 1, targetPort: 2 },
    { listenHost: 'x', listenPort: 0, targetPort: 2 },
    { listenHost: 'x', listenPort: 65536, targetPort: 2 },
    { listenHost: 'x', listenPort: 1.5, targetPort: 2 },
    { listenHost: 'x', listenPort: 1, targetPort: 2, extra: true },
  ]) {
    await expect400(kernel, 'POST', '/api/nodes/node-a/forward', bad)
  }
})

test('env exec：command 形状、env 键值、cwd 绝对性、数值边界与未知字段', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const str = await call(kernel, 'POST', '/api/env/exec', { command: 'echo hi' })
  assert.equal(str.status, 200)
  const execs = calls.execEnv as Array<{ command: string | string[] }>
  assert.deepEqual(execs[0]!.command, 'echo hi')
  const arr = await call(kernel, 'POST', '/api/env/exec', { command: ['echo', 'hi'], cwd: 'C:\\work', nodeId: 'n1', conversationId: 2, env: { A_B: 'v' }, timeoutMs: 5000 })
  assert.equal(arr.status, 200)
  assert.deepEqual(calls.execEnv![1], {
    command: ['echo', 'hi'], cwd: 'C:\\work', nodeId: 'n1', conversationId: 2, env: { A_B: 'v' }, timeoutMs: 5000,
  })
  const unc = await call(kernel, 'POST', '/api/env/exec', { command: 'x', cwd: '\\\\srv\\share\\dir' })
  assert.equal(unc.status, 200)
  for (const bad of [
    {},
    { command: '' },
    { command: ' ' },
    { command: [] },
    { command: [1] },
    { command: 1 },
    { command: 'x', nodeId: 'bad node!' },
    { command: 'x', nodeId: '' },
    { command: 'x', cwd: 'relative/dir' },
    { command: 'x', cwd: 'C:relative' },
    { command: 'x', conversationId: 0 },
    { command: 'x', conversationId: 1.5 },
    { command: 'x', env: { 'bad-key': 'v' } },
    { command: 'x', env: { A: 1 } },
    { command: 'x', env: { A: 'v\u0000w' } },
    { command: 'x', timeoutMs: 0 },
    { command: 'x', timeoutMs: 600001 },
    { command: 'x', stream: 'yes' },
    { command: 'x', unknown: 1 },
  ]) {
    await expect400(kernel, 'POST', '/api/env/exec', bad)
  }
})

// ---------------------------------------------------------------------------
// auth 宽容度与错误可诊断性
// ---------------------------------------------------------------------------

test('auth setup/login：未知字段历史未拒，schema 保持同一宽容度（password 形状仍严格）', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const withExtra = await call(kernel, 'POST', '/api/auth/setup', { password: 'long-enough-password', extra: 1 })
  assert.equal(withExtra.status, 200)
  assert.equal(calls.authSetup![0], 'long-enough-password')
  await expect400(kernel, 'POST', '/api/auth/setup', {})
  await expect400(kernel, 'POST', '/api/auth/setup', { password: '' })
  await expect400(kernel, 'POST', '/api/auth/setup', { password: 1 })
})

test('schema 拒绝携带 AJV 字段路径诊断（details.errors 非空，可定位字段）', { timeout: 60_000 }, async () => {
  await assert.rejects(
    handleApi(
      new Request('http://hub/api/models/filter', {
        method: 'PUT',
        body: JSON.stringify({ disabledModels: 'x', provider: 1 }),
        headers: { 'content-type': 'application/json' },
      }),
      makeKernel(),
    ),
    (error: unknown) => {
      assert.ok(error instanceof ValidationError, '错误类型为 ValidationError（HelmError 400 子类）')
      const details = (error as ValidationError).details as { errors?: Array<{ instancePath?: string }> } | undefined
      assert.ok(Array.isArray(details?.errors) && details!.errors!.length > 0, 'details.errors 携带 AJV 错误清单')
      const paths = details!.errors!.map((e) => e.instancePath).join(' ')
      assert.match(paths, /disabledModels/)
      assert.match(paths, /provider/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 薄分发路由 parity（多余段 404 / 方法不匹配 405|404 各归其位）
// ---------------------------------------------------------------------------

test('路由 parity：多余段与未匹配方法不落入操作分支', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  // 多余段 / 未匹配方法 → 404（原实现各领域语义）。
  for (const [m, p] of [
    ['GET', '/api/auth/status/foo'],
    ['GET', '/api/auth/setup'],
    ['GET', '/api/events/x'],
    ['POST', '/api/events'],
    ['GET', '/api/search/x'],
    ['POST', '/api/search'],
    ['GET', '/api/models/providers/extra'],
    ['POST', '/api/models'],
    ['PUT', '/api/models/refresh'],
    ['GET', '/api/providers/x'],
    ['GET', '/api/plugins/config'],
    ['POST', '/api/plugins/builtin:x/config/extra'],
    ['GET', '/api/nodes/n1/upgrade/check/extra'],
    ['PUT', '/api/nodes/issue'],
    ['GET', '/api/conversations/1/input/x'],
    ['DELETE', '/api/asks/ask-1'],
    ['PUT', '/api/actions/a/b'],
    ['POST', '/api/artifacts/a/content'],
    ['GET', '/api/env/exec'],
  ] as const) {
    const res = await call(kernel, m, p)
    assert.equal(res.status, 404, `${m} ${p} 应 404`)
  }
  // skills 集合非 GET：原实现落入 requireIdParam('') → 400（保持）。
  await expect400(kernel, 'POST', '/api/skills')
  // 方法不匹配：会话与 profile 集合/个体、providers、插件 config 为 405。
  for (const [m, p] of [
    ['PUT', '/api/conversations'],
    ['POST', '/api/conversations/1'],
    ['PUT', '/api/profiles'],
    ['POST', '/api/profiles/assistant'],
    ['POST', '/api/providers'],
    ['POST', '/api/plugins/builtin:x/config'],
  ] as const) {
    const res = await call(kernel, m, p)
    assert.equal(res.status, 405, `${m} ${p} 应 405`)
    assert.equal(res.code, 'method_not_allowed')
  }
})
