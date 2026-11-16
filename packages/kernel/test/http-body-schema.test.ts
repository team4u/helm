/**
 * HTTP body boundary schema after behavior parity regression:
 * mechanical type/shape/unknown field validate migration to JSON Schema(AJV) after, must and original manually write
 * validate keep the same reject side - - especially is:
 * - unknown field still one rule 400(auth setup/login exception: history on i.e. not reject, keep wide contain);
 * - explicit null and default same refuse (do not when default static default ignore);
 * - trim semantics difference end point each lock (install source refuse whitespace;models refresh
 *   provider only refuse empty string;upgrade targetVersion allows first tail whitespace);
 * - security integer on boundary (fork entryId / withdraw submissionId / input
 *   replaceFromEntryId refuse 2^60);
 * - error can diagnose:details.errors carry AJV field path.
 * - UTF-16 code meta length boundary:AJV maxLength by code point counter (proxy for compute 1),
 *   and original manually write string.length(code meta) opening path different - - contains non- BMP character reverse example
 *   must not because schema while put wide (guard restore original reject boundary, stick boundary do not mistakenly refuse).
 * and thin dispatch after routing parity(redundant segment 404 / method does not match 405|404 each archive its).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmError } from '@helm/protocol'
import { handleApi } from '../src/http/routes.js'
import {
  parseConversationCompactBody,
  parseConversationInit,
  parseConversationPatch,
  parseConversationResetBody,
  parseInputBody,
  parseProfileBody,
  ValidationError,
} from '../src/http/validate.js'
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
        throw new HelmError('not_found', 'doc missing', 404)
      },
      getClientModule: async () => {
        throw new HelmError('not_implemented', 'not connect line', 501)
      },
    },
    async listConversations() { return [] },
    async getConversationDetail(id: number) { throw new HelmError('not_found', `conversation missing: ${id}`, 404) },
    async getConversationEntry(id: number, entryId: number) { throw new HelmError('not_found', `item ${entryId} in conversation ${id} in missing`, 404) },
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
        throw new HelmError('validation_error', 'nodeId must match node ID rule', 400, { nodeId })
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
    // ValidationError / HelmError directly throw (produce by hub.ts unify mapping structure response).
    if (error instanceof HelmError) return { status: error.status, code: error.code, json: undefined }
    throw error
  }
}

async function expect400(kernel: KernelRuntimeLike, method: string, path: string, body?: unknown, why?: string) {
  const res = await call(kernel, method, path, body)
  assert.equal(res.status, 400, `should 400 reject ${why ?? JSON.stringify(body)}`)
  assert.equal(res.code, 'validation_error')
}

// ---------------------------------------------------------------------------
// conversation body
// ---------------------------------------------------------------------------

test('input body:text empty string legal (202); attachment ID/dedupe/empty array, enumeration and security integer boundary', { timeout: 60_000 }, async () => {
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

test('fork/withdraw: security positive integer on boundary refuse 2^60; unknown field refuse;title empty string refuse', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/fork', { entryId: 5, title: 'fork' })
  assert.equal(ok.status, 201)
  assert.deepEqual(calls.forkConversation![0], [1, { entryId: 5, title: 'fork' }])
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

test('reset body:handoff empty string legal; unknown field refuse', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/reset', { handoff: '' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.resetConversation![0], [1, { handoff: '' }])
  await expect400(kernel, 'POST', '/api/conversations/1/reset', { handoff: 'x', extra: 1 })
})

test('ask answer:answers one by one value string,expectedStateSeq non- negative integer, unknown field refuse', { timeout: 60_000 }, async () => {
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
// model directory body
// ---------------------------------------------------------------------------

test('models/default: empty object/empty body/explicit null/type wrong/unknown field all 400; part update pass-through', { timeout: 60_000 }, async () => {
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

test('models/filter:disabledModels required string array; unknown field/type wrong 400', { timeout: 60_000 }, async () => {
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

test('models/refresh:=== "" only then refuse (whitespace string history let through);provider+providers merge;force type wrong refuse', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const refreshCalls: unknown[] = []
  const kernel = makeKernel(calls)
  ;(kernel as { refreshModels?: unknown }).refreshModels = async (options?: unknown) => {
    refreshCalls.push(options)
    return { refreshed: [] } as never
  }
  // empty body / {} all amount refresh (two time invoke each record a).
  const emptyBody = await call(kernel, 'POST', '/api/models/refresh', undefined)
  assert.equal(emptyBody.status, 200)
  const emptyObj = await call(kernel, 'POST', '/api/models/refresh', {})
  assert.equal(emptyObj.status, 200)
  assert.deepEqual(refreshCalls[0], {})
  assert.deepEqual(refreshCalls[1], {})
  // whitespace string provider history on let through (only === '' refuse),schema keep the same wide contain.
  const space = await call(kernel, 'POST', '/api/models/refresh', { provider: ' ' })
  assert.equal(space.status, 200, 'provider whitespace string should let through (=== "" semantics)')
  assert.deepEqual(refreshCalls[2], { providers: [' '] })
  // provider + providers merge.
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

test('providers PUT: array and { providers } package wrap same rule; one by one items field wrong/unknown items field 400', { timeout: 60_000 }, async () => {
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

test('credentials PUT:value 1..64k required; unknown field refuse', { timeout: 60_000 }, async () => {
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
// plugin body
// ---------------------------------------------------------------------------

test('actions invoke:input required (null legal);conversationId positive integer; unknown field refuse', { timeout: 60_000 }, async () => {
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

test('plugins disable body: only force boolean;body and query force same meaning', { timeout: 60_000 }, async () => {
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

test('plugins config PUT:values mark amount mapping; array/embed set object/unknown field refuse', { timeout: 60_000 }, async () => {
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
// node body(issue / upgrade / forward / env exec)
// ---------------------------------------------------------------------------

test('nodes issue:nodeId non-empty required; unknown field in HTTP boundary refuse (service layer pattern validate fall back)', { timeout: 60_000 }, async () => {
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

test('nodes upgrade:attemptId cannot control;targetVersion keep first tail whitespace original value pass-through; strictly SemVer and URL boundary', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  // empty body legal (upgrade to latest).
  const empty = await call(kernel, 'POST', '/api/nodes/node-a/upgrade')
  assert.equal(empty.status, 200)
  assert.deepEqual(calls.upgradeNode![0], ['node-a', {}])
  // trim after legal version keep original value pass-through (original implement trim after validate, original value pass).
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
  // upgrade/check?registryUrl non- http(s) same refuse.
  const badCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=ftp://x')
  assert.equal(badCheck.status, 400)
  const okCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=https://registry.example.com')
  assert.equal(okCheck.status, 200)
})

test('nodes forward: host name forbid whitespace and control character, port 1..65535, unknown field refuse', { timeout: 60_000 }, async () => {
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

test('env exec:command shape,env key value,cwd absolute, count value boundary and unknown field', { timeout: 60_000 }, async () => {
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
// auth wide contain and error can diagnose
// ---------------------------------------------------------------------------

test('auth setup/login: unknown field history not refuse,schema keep the same wide contain (password shape still strictly)', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const withExtra = await call(kernel, 'POST', '/api/auth/setup', { password: 'long-enough-password', extra: 1 })
  assert.equal(withExtra.status, 200)
  assert.equal(calls.authSetup![0], 'long-enough-password')
  await expect400(kernel, 'POST', '/api/auth/setup', {})
  await expect400(kernel, 'POST', '/api/auth/setup', { password: '' })
  await expect400(kernel, 'POST', '/api/auth/setup', { password: 1 })
})

test('schema reject carry AJV field path diagnose (details.errors non-empty, can locate field)', { timeout: 60_000 }, async () => {
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
      assert.ok(error instanceof ValidationError, 'error type is ValidationError(HelmError 400 sub- class)')
      const details = (error as ValidationError).details as { errors?: Array<{ instancePath?: string }> } | undefined
      assert.ok(Array.isArray(details?.errors) && details!.errors!.length > 0, 'details.errors carry AJV error manifest')
      const paths = details!.errors!.map((e) => e.instancePath).join(' ')
      assert.match(paths, /disabledModels/)
      assert.match(paths, /provider/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// UTF-16 code meta length boundary:AJV maxLength by code point counter, non- BMP character (proxy for)
// will let schema boundary put wide; guard with original string.length(code meta) opening path restore.
// 1  emoji = 1 code point = 2 code meta = 4 UTF-8 byte, reverse example all in body byte restrict inside.
// ---------------------------------------------------------------------------

test('UTF-16 code meta length cap:emoji reverse example do not because AJV code point counter put wide (fork 200 / credential 64k / forward 255)', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const emoji = '\uD83D\uDE00'
  // fork title ≤200 code meta:101 emoji = 101 code point (schema let through)/ 202 code meta (original refuse)→ 400.
  await expect400(kernel, 'POST', '/api/conversations/1/fork', { entryId: 1, title: emoji.repeat(101) })
  // stick boundary do not mistakenly refuse:50 emoji + 100 ASCII = 150 code point / 200 code meta → 201.
  const forkOk = await call(kernel, 'POST', '/api/conversations/1/fork', {
    entryId: 1, title: emoji.repeat(50) + 'a'.repeat(100),
  })
  assert.equal(forkOk.status, 201)
  // credential value ≤64k code meta:32769 emoji = 65538 code meta (131076 byte,body limit inside)→ 400;
  // 32768 emoji = 65536 code meta stick boundary → 200.
  await expect400(kernel, 'PUT', '/api/credentials/faux', { value: emoji.repeat(32769) })
  const credOk = await call(kernel, 'PUT', '/api/credentials/faux', { value: emoji.repeat(32768) })
  assert.equal(credOk.status, 200)
  // forward host name ≤255 code meta:'a'+128 emoji = 129 code point / 257 code meta → 400(listenHost/targetHost same rule).
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'a' + emoji.repeat(128), listenPort: 1, targetPort: 2,
  })
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'h', listenPort: 1, targetPort: 2, targetHost: 'a' + emoji.repeat(128),
  })
  const fwdOk = await call(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'a' + emoji.repeat(127), listenPort: 1, targetPort: 2,
  })
  assert.equal(fwdOk.status, 201, 'a+127 emoji = 255 code meta stick boundary should let through')
})

test('input/reset/compact  UTF-16 cap also constraint parse and HTTP mixed text', { timeout: 60_000 }, async () => {
  const emoji = '\uD83D\uDE00'
  const mixed = emoji.repeat(200000) + 'a'.repeat(124289)
  assert.equal(mixed.length, 524289)
  const kernel = makeKernel()
  for (const [path, field] of [
    ['/api/conversations/1/input', 'text'],
    ['/api/conversations/1/reset', 'handoff'],
    ['/api/conversations/1/compact', 'instructions'],
  ] as const) {
    const body = { [field]: mixed }
    assert.ok(Buffer.byteLength(JSON.stringify(body)) < 1024 * 1024)
    await expect400(kernel, 'POST', path, body)
  }
  // 262145 emoji = 524290 code meta > 524288(original refuse); its UTF-8 encode 1048580 byte
  // already over 1MiB body cap,HTTP layer will first 413, reason in parse layer directly verify original reject boundary.
  assert.throws(() => parseInputBody({ text: emoji.repeat(262145) }), ValidationError)
  assert.throws(() => parseConversationResetBody({ handoff: emoji.repeat(262145) }), ValidationError)
  assert.throws(() => parseConversationCompactBody({ instructions: emoji.repeat(262145) }), ValidationError)
  // stick boundary do not mistakenly refuse:262144 emoji = 524288 code meta = original cap.
  assert.equal(parseInputBody({ text: emoji.repeat(262144) }).text.length, 524288)
  assert.deepEqual(parseConversationResetBody({ handoff: emoji.repeat(262144) }), {
    handoff: emoji.repeat(262144),
  })
  assert.deepEqual(parseConversationCompactBody({ instructions: emoji.repeat(262144) }), {
    instructions: emoji.repeat(262144),
  })
})

// ---------------------------------------------------------------------------
// thin dispatch routing parity(redundant segment 404 / method does not match 405|404 each archive its)
// ---------------------------------------------------------------------------

test('routing dispatch does not object prototype property when act domain handler', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const response = await call(kernel, 'GET', `/api/${name}`)
    assert.equal(response.status, 404, name)
    assert.equal(response.code, 'not_found', name)
  }
})

test('empty body through end point Schema, required field missing when do not invoke service', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward')
  assert.deepEqual(calls.startNodeForward, [])
  const reset = await call(kernel, 'POST', '/api/conversations/1/reset')
  assert.equal(reset.status, 200)
})

test('routing parity: redundant segment and not match method do not operation branch', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  // redundant segment / not match method → 404(original implement each domain semantics).
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
    assert.equal(res.status, 404, `${m} ${p} should 404`)
  }
  // skills set non- GET: original implement requireIdParam('') → 400(keep).
  await expect400(kernel, 'POST', '/api/skills')
  // method does not match: conversation and profile set/body,providers, plugin config is 405.
  for (const [m, p] of [
    ['PUT', '/api/conversations'],
    ['POST', '/api/conversations/1'],
    ['PUT', '/api/profiles'],
    ['POST', '/api/profiles/assistant'],
    ['POST', '/api/providers'],
    ['POST', '/api/plugins/builtin:x/config'],
  ] as const) {
    const res = await call(kernel, m, p)
    assert.equal(res.status, 405, `${m} ${p} should 405`)
    assert.equal(res.code, 'method_not_allowed')
  }
})

// ---------------------------------------------------------------------------
// conversation and Profile think Profile / model reference validate
// ---------------------------------------------------------------------------

test('conversation HTTP accept legal think Profile and clear override, reject unknown value and type', { timeout: 60_000 }, () => {
  for (const thinkingLevel of ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(parseConversationPatch({ thinkingLevel }), { thinkingLevel })
  }
  for (const thinkingLevel of [null, 1, 'highest']) assert.throws(() => parseConversationPatch({ thinkingLevel }))
})

test('model ID can contains slash,HTTP create/switch/Profile save all keep complete reference', { timeout: 60_000 }, () => {
  const model = 'gateway/group/smart'
  assert.equal(parseConversationInit({ model }).model, model)
  assert.equal(parseConversationPatch({ model }).model, model)
  assert.equal(parseProfileBody({ id: 'worker', model }, { requireId: true }).model, model)
})

test('Profile HTTP save think Profile; empty string delete and fall back global', { timeout: 60_000 }, () => {
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: 'high' }, { requireId: true }).thinkingLevel, 'high')
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: '' }, { requireId: true }).thinkingLevel, undefined)
  for (const thinkingLevel of [null, 1, 'highest']) {
    assert.throws(() => parseProfileBody({ id: 'worker', thinkingLevel }, { requireId: true }))
  }
})
