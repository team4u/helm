/**
 * Behavior-parity regression tests after migrating HTTP body boundary validation to JSON Schema (AJV):
 * Mechanical type/shape/unknown-field validation moved to JSON Schema must retain identical rejection
 * criteria to the hand-written checks, especially:
 * - Unknown fields still universally return 400 (except auth setup/login, which keep wider compatibility);
 * - Explicit null and undefined are both rejected (not silently treated as absent);
 * - Endpoint-specific trim semantics are pinned (install source rejects whitespace; models refresh
 *   provider only rejects empty string; upgrade targetVersion allows leading/trailing whitespace);
 * - Safe integer upper bounds (fork entryId / withdraw submissionId / input replaceFromEntryId reject 2^60);
 * - Diagnostic errors: details.errors carries AJV field paths;
 * - UTF-16 code-unit length bounds: AJV maxLength counts Unicode code points (surrogate pairs count as 1),
 *   differing from string.length (code units); non-BMP chars must not loosen schema bounds (guards restore
 *   exact rejection thresholds while accepting boundary-exact values);
 * - Route parity after thin dispatch (extra path segments 404 / mismatched methods 405|404 per domain).
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
    setDefaultModel: [], setModelThinkingDefault: [], setDisabledModels: [], issueNodeToken: [],
    upgradeNode: [], startNodeForward: [], execEnv: [],
  }
}

function makeKernel(calls: CallLog = newCallLog()): KernelRuntimeLike {
  /** Mutable per-model defaults mirror so GET/PUT echoes reflect the setModelThinkingDefault calls. */
  const modelThinkingLevels: Record<string, string> = {}
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
        throw new HelmError('not_found', 'doc not found', 404)
      },
      getClientModule: async () => {
        throw new HelmError('not_implemented', 'not wired', 501)
      },
    },
    async listConversations() { return [] },
    async getConversationDetail(id: number) { throw new HelmError('not_found', `conversation not found: ${id}`, 404) },
    async getConversationEntry(id: number, entryId: number) { throw new HelmError('not_found', `entry ${entryId} not found in conversation ${id}`, 404) },
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
    listModels: async () => ({
      models: [],
      thinkingLevels: {},
      ...(Object.keys(modelThinkingLevels).length > 0 ? { modelThinkingLevels: { ...modelThinkingLevels } } : {}),
    }),
    setDisabledModels: async (provider: string | undefined, disabledModels: string[]) => {
      calls.setDisabledModels!.push([provider, disabledModels])
      return { models: [], thinkingLevels: {} }
    },
    setDefaultModel: async (
      model?: string,
      thinkingLevel?: string,
      compactionModel?: string,
      compactionThinkingLevel?: string,
      levels?: Record<string, string>,
      update?: { model: string; level: string },
    ) => {
      const args: unknown[] = compactionThinkingLevel !== undefined
        ? [model, thinkingLevel, compactionModel, compactionThinkingLevel]
        : compactionModel !== undefined
          ? [model, thinkingLevel, compactionModel]
          : [model, thinkingLevel]
      if (levels !== undefined) args.push(levels)
      if (update !== undefined) args.push(update)
      calls.setDefaultModel!.push(args)
      if (levels !== undefined) {
        for (const key of Object.keys(modelThinkingLevels)) delete modelThinkingLevels[key]
        Object.assign(modelThinkingLevels, levels)
      }
      if (update !== undefined) {
        if (update.level === '') delete modelThinkingLevels[update.model]
        else modelThinkingLevels[update.model] = update.level
      }
    },
    setModelThinkingDefault: async (model: string, level: string) => {
      calls.setModelThinkingDefault!.push([model, level])
      if (level === '') delete modelThinkingLevels[model]
      else modelThinkingLevels[model] = level
    },
    listModelProviders: async () => [],
    async listNodes() { return [] },
    async issueNodeToken(nodeId: string) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(nodeId)) {
        throw new HelmError('validation_error', 'nodeId must match node ID format', 400, { nodeId })
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
    // ValidationError / HelmError thrown directly (mapped uniformly into structured responses by hub.ts).
    if (error instanceof HelmError) return { status: error.status, code: error.code, json: undefined }
    throw error
  }
}

async function expect400(kernel: KernelRuntimeLike, method: string, path: string, body?: unknown, why?: string) {
  const res = await call(kernel, method, path, body)
  assert.equal(res.status, 400, `should reject with 400: ${why ?? JSON.stringify(body)}`)
  assert.equal(res.code, 'validation_error')
}

// ---------------------------------------------------------------------------
// Conversation bodies
// ---------------------------------------------------------------------------

test('input body: empty text allowed (202); attachment ID dedupe/empty array, enums, and safe integer bounds', { timeout: 60_000 }, async () => {
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

test('fork/withdraw: optional entryId clean anchor; safe positive integer upper bound rejects 2^60; rejects unknown fields and empty title', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/fork', { entryId: 5, title: 'fork' })
  assert.equal(ok.status, 201)
  assert.deepEqual(calls.forkConversation![0], [1, { entryId: 5, title: 'fork' }])

  const okOmitted = await call(kernel, 'POST', '/api/conversations/1/fork', {})
  assert.equal(okOmitted.status, 201)
  assert.deepEqual(calls.forkConversation![1], [1, {}])

  const okTitleOnly = await call(kernel, 'POST', '/api/conversations/1/fork', { title: 'clean anchor fork' })
  assert.equal(okTitleOnly.status, 201)
  assert.deepEqual(calls.forkConversation![2], [1, { title: 'clean anchor fork' }])

  const okNoBody = await call(kernel, 'POST', '/api/conversations/1/fork')
  assert.equal(okNoBody.status, 201)
  assert.deepEqual(calls.forkConversation![3], [1, {}])

  for (const bad of [
    { entryId: 1.5 },
    { entryId: 0 },
    { entryId: -1 },
    { entryId: 2 ** 60 },
    { entryId: '5' },
    { entryId: null },
    { title: '' },
    { entryId: 1, title: '' },
    { extra: 2 },
    { entryId: 1, extra: 2 },
  ]) {
    await expect400(kernel, 'POST', '/api/conversations/1/fork', bad)
  }
  const w = await call(kernel, 'POST', '/api/conversations/1/withdraw', { submissionId: 9 })
  assert.equal(w.status, 200)
  await expect400(kernel, 'POST', '/api/conversations/1/withdraw', { submissionId: 2 ** 60 })
  await expect400(kernel, 'POST', '/api/conversations/1/withdraw', {})
})

test('reset body: empty handoff string allowed; unknown field rejected', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'POST', '/api/conversations/1/reset', { handoff: '' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.resetConversation![0], [1, { handoff: '' }])
  await expect400(kernel, 'POST', '/api/conversations/1/reset', { handoff: 'x', extra: 1 })
})

test('ask answer: every answer value must be string, expectedStateSeq non-negative integer, unknown fields rejected', { timeout: 60_000 }, async () => {
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
// Model catalog bodies
// ---------------------------------------------------------------------------

test('models/default: empty object/empty body/explicit null/wrong type/unknown field all 400; partial update passes through', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const ok = await call(kernel, 'PUT', '/api/models/default', { thinkingLevel: 'high' })
  assert.equal(ok.status, 200)
  assert.deepEqual(calls.setDefaultModel![0], [undefined, 'high'])
  const clearModel = await call(kernel, 'PUT', '/api/models/default', { model: '' })
  assert.equal(clearModel.status, 200)
  assert.deepEqual(calls.setDefaultModel![1], ['', undefined])
  const compactionOnly = await call(kernel, 'PUT', '/api/models/default', { compactionModel: 'faux/faux-2', compactionThinkingLevel: 'low' })
  assert.equal(compactionOnly.status, 200)
  assert.deepEqual(calls.setDefaultModel![2], [undefined, undefined, 'faux/faux-2', 'low'])
  for (const bad of [
    {},
    { model: null },
    { compactionModel: null },
    { compactionThinkingLevel: 1 },
    { thinkingLevel: 3 },
    { other: 'high' },
    '"str"',
    '[]',
    { modelThinking: 'faux/faux-1' },
    { modelThinkingLevel: 'high' },
    { modelThinking: 1, modelThinkingLevel: 'high' },
    { modelThinkingLevels: [] },
    { modelThinkingLevels: { 'faux/faux-1': 1 } },
    { modelThinking: 'faux/faux-1', modelThinkingLevel: 'high', modelThinkingLevels: {} },
  ]) {
    await expect400(kernel, 'PUT', '/api/models/default', bad)
  }
  const rawEmpty = await call(kernel, 'PUT', '/api/models/default', undefined)
  assert.equal(rawEmpty.status, 400)
  assert.equal(calls.setDefaultModel!.length, 3)
})

test('models/default: complete per-model map saves atomically with global defaults and echoes the result', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const response = await call(kernel, 'PUT', '/api/models/default', {
    model: 'faux/faux-2',
    thinkingLevel: 'medium',
    modelThinkingLevels: { 'faux/faux-1': 'high', 'openrouter/vendor/nested': 'max' },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(calls.setDefaultModel, [[
    'faux/faux-2',
    'medium',
    { 'faux/faux-1': 'high', 'openrouter/vendor/nested': 'max' },
  ]])
  assert.equal(calls.setModelThinkingDefault!.length, 0)
  assert.deepEqual(response.json.modelThinkingLevels, {
    'faux/faux-1': 'high',
    'openrouter/vendor/nested': 'max',
  })
})

test('models/default: per-model pair applies alone or together with regular fields and echoes the full map', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const pairOnly = await call(kernel, 'PUT', '/api/models/default', { modelThinking: 'faux/faux-1', modelThinkingLevel: 'high' })
  assert.equal(pairOnly.status, 200)
  assert.equal(calls.setDefaultModel!.length, 1)
  assert.deepEqual(calls.setDefaultModel![0], [undefined, undefined, { model: 'faux/faux-1', level: 'high' }])
  assert.equal(calls.setModelThinkingDefault!.length, 0)
  assert.equal(pairOnly.json.ok, true)
  assert.deepEqual(pairOnly.json.modelThinkingLevels, { 'faux/faux-1': 'high' })

  const combined = await call(kernel, 'PUT', '/api/models/default', {
    model: 'faux/faux-2',
    modelThinking: 'faux/faux-1',
    modelThinkingLevel: '',
  })
  assert.equal(combined.status, 200)
  assert.deepEqual(calls.setDefaultModel![1], ['faux/faux-2', undefined, { model: 'faux/faux-1', level: '' }])
  assert.equal(calls.setModelThinkingDefault!.length, 0)
  assert.deepEqual(combined.json.modelThinkingLevels, {})
})

test('models/filter: disabledModels required string array; unknown field/wrong type return 400', { timeout: 60_000 }, async () => {
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

test('models/refresh: rejects === "" only (preserves whitespace string); merges provider+providers; rejects invalid force type', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const refreshCalls: unknown[] = []
  const kernel = makeKernel(calls)
  ;(kernel as { refreshModels?: unknown }).refreshModels = async (options?: unknown) => {
    refreshCalls.push(options)
    return { refreshed: [] } as never
  }
  // Empty body and {} both refresh all providers (2 invocations, 1 record each).
  const emptyBody = await call(kernel, 'POST', '/api/models/refresh', undefined)
  assert.equal(emptyBody.status, 200)
  const emptyObj = await call(kernel, 'POST', '/api/models/refresh', {})
  assert.equal(emptyObj.status, 200)
  assert.deepEqual(refreshCalls[0], {})
  assert.deepEqual(refreshCalls[1], {})
  // Whitespace provider strings are historically accepted (only === '' is rejected); schema preserves compatibility.
  const space = await call(kernel, 'POST', '/api/models/refresh', { provider: ' ' })
  assert.equal(space.status, 200, 'whitespace provider string should pass (=== "" semantics)')
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

test('providers PUT: array and { providers } wrapper share rules; wrong or unknown item fields return 400', { timeout: 60_000 }, async () => {
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

test('credentials PUT: value 1..64k required; unknown field rejected', { timeout: 60_000 }, async () => {
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
// Plugin bodies
// ---------------------------------------------------------------------------

test('actions invoke: input required (null allowed); conversationId positive integer; unknown fields rejected', { timeout: 60_000 }, async () => {
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

test('plugins disable body: accepts force boolean only; body and query force share semantics', { timeout: 60_000 }, async () => {
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

test('plugins config PUT: values map scalars; arrays, nested objects, and unknown fields rejected', { timeout: 60_000 }, async () => {
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
// Node bodies (issue / upgrade / forward / env exec)
// ---------------------------------------------------------------------------

test('nodes issue: non-empty nodeId required; unknown fields rejected at HTTP boundary (pattern check falls back to service)', { timeout: 60_000 }, async () => {
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

test('nodes upgrade: attemptId disallowed; targetVersion preserves leading/trailing whitespace passthrough; strict SemVer and URL checks', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  // Empty body allowed (upgrade to latest).
  const empty = await call(kernel, 'POST', '/api/nodes/node-a/upgrade')
  assert.equal(empty.status, 200)
  assert.deepEqual(calls.upgradeNode![0], ['node-a', {}])
  // Valid trimmed version preserves original value passthrough (matches original validate-after-trim behavior).
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
  // upgrade/check?registryUrl rejects non-http(s) URLs as well.
  const badCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=ftp://x')
  assert.equal(badCheck.status, 400)
  const okCheck = await call(kernel, 'GET', '/api/nodes/node-a/upgrade/check?registryUrl=https://registry.example.com')
  assert.equal(okCheck.status, 200)
})

test('nodes forward: host names forbid whitespace and control chars, port 1..65535, unknown fields rejected', { timeout: 60_000 }, async () => {
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

test('env exec: command shape, env key/value, absolute cwd, numeric bounds, and unknown fields', { timeout: 60_000 }, async () => {
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
// Auth compatibility and diagnostic errors
// ---------------------------------------------------------------------------

test('auth setup/login: preserves wide compatibility with historical unknown fields while validating password shape strictly', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const withExtra = await call(kernel, 'POST', '/api/auth/setup', { password: 'long-enough-password', extra: 1 })
  assert.equal(withExtra.status, 200)
  assert.equal(calls.authSetup![0], 'long-enough-password')
  await expect400(kernel, 'POST', '/api/auth/setup', {})
  await expect400(kernel, 'POST', '/api/auth/setup', { password: '' })
  await expect400(kernel, 'POST', '/api/auth/setup', { password: 1 })
})

test('schema rejection attaches AJV field path diagnostics (details.errors non-empty, identifies failing fields)', { timeout: 60_000 }, async () => {
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
      assert.ok(error instanceof ValidationError, 'error type must be ValidationError (HelmError 400 subclass)')
      const details = (error as ValidationError).details as { errors?: Array<{ instancePath?: string }> } | undefined
      assert.ok(Array.isArray(details?.errors) && details!.errors!.length > 0, 'details.errors must list AJV errors')
      const paths = details!.errors!.map((e) => e.instancePath).join(' ')
      assert.match(paths, /disabledModels/)
      assert.match(paths, /provider/)
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// UTF-16 code-unit length bounds: AJV maxLength counts code points, so non-BMP chars (surrogate pairs)
// would pass wider schema limits; explicit string.length guards restore exact limits.
// 1 emoji = 1 code point = 2 UTF-16 code units = 4 UTF-8 bytes; counterexamples all stay under body byte cap.
// ---------------------------------------------------------------------------

test('UTF-16 code-unit length caps: emoji counterexamples are not loosened by AJV code-point counting (fork 200 / credential 64k / forward 255)', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  const emoji = '\uD83D\uDE00'
  // fork title <= 200 code units: 101 emoji = 101 code points (schema accepts) / 202 code units (original rejects) -> 400.
  await expect400(kernel, 'POST', '/api/conversations/1/fork', { entryId: 1, title: emoji.repeat(101) })
  // Boundary value accepted: 50 emoji + 100 ASCII = 150 code points / 200 code units -> 201.
  const forkOk = await call(kernel, 'POST', '/api/conversations/1/fork', {
    entryId: 1, title: emoji.repeat(50) + 'a'.repeat(100),
  })
  assert.equal(forkOk.status, 201)
  // credential value <= 64k code units: 32769 emoji = 65538 code units (131076 bytes, within body limit) -> 400;
  // 32768 emoji = 65536 code units exact boundary -> 200.
  await expect400(kernel, 'PUT', '/api/credentials/faux', { value: emoji.repeat(32769) })
  const credOk = await call(kernel, 'PUT', '/api/credentials/faux', { value: emoji.repeat(32768) })
  assert.equal(credOk.status, 200)
  // forward host names <= 255 code units: 'a' + 128 emoji = 129 code points / 257 code units -> 400 (both listenHost & targetHost).
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'a' + emoji.repeat(128), listenPort: 1, targetPort: 2,
  })
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'h', listenPort: 1, targetPort: 2, targetHost: 'a' + emoji.repeat(128),
  })
  const fwdOk = await call(kernel, 'POST', '/api/nodes/node-a/forward', {
    listenHost: 'a' + emoji.repeat(127), listenPort: 1, targetPort: 2,
  })
  assert.equal(fwdOk.status, 201, 'a + 127 emoji = 255 code units exact boundary should pass')
})

test('input/reset/compact UTF-16 caps govern both parser functions and HTTP mixed text', { timeout: 60_000 }, async () => {
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
  // 262145 emoji = 524290 code units > 524288 (original rejection); UTF-8 size is 1048580 bytes, triggering
  // HTTP 413 body limit first, so verify parser-layer boundary rejection directly too.
  assert.throws(() => parseInputBody({ text: emoji.repeat(262145) }), ValidationError)
  assert.throws(() => parseConversationResetBody({ handoff: emoji.repeat(262145) }), ValidationError)
  assert.throws(() => parseConversationCompactBody({ instructions: emoji.repeat(262145) }), ValidationError)
  // Exact boundary accepted: 262144 emoji = 524288 code units.
  assert.equal(parseInputBody({ text: emoji.repeat(262144) }).text.length, 524288)
  assert.deepEqual(parseConversationResetBody({ handoff: emoji.repeat(262144) }), {
    handoff: emoji.repeat(262144),
  })
  assert.deepEqual(parseConversationCompactBody({ instructions: emoji.repeat(262144) }), {
    instructions: emoji.repeat(262144),
  })
})

// ---------------------------------------------------------------------------
// Thin-dispatch routing parity (extra segments 404 / mismatched methods 405|404 per domain)
// ---------------------------------------------------------------------------

test('routing dispatch never treats Object.prototype properties as domain handlers', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const response = await call(kernel, 'GET', `/api/${name}`)
    assert.equal(response.status, 404, name)
    assert.equal(response.code, 'not_found', name)
  }
})

test('empty body passes through endpoint schema, skipping service call when required fields are missing', { timeout: 60_000 }, async () => {
  const calls = newCallLog()
  const kernel = makeKernel(calls)
  await expect400(kernel, 'POST', '/api/nodes/node-a/forward')
  assert.deepEqual(calls.startNodeForward, [])
  const reset = await call(kernel, 'POST', '/api/conversations/1/reset')
  assert.equal(reset.status, 200)
})

test('routing parity: extra segments and mismatched methods do not cross-route', { timeout: 60_000 }, async () => {
  const kernel = makeKernel()
  // Extra segments / mismatched methods -> 404 (matching original per-domain semantics).
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
  // Non-GET on skills collection: preserves requireIdParam('') -> 400.
  await expect400(kernel, 'POST', '/api/skills')
  // Mismatched methods -> 405 on conversation/profile collections & items, providers, and plugin config.
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
// Conversation and Profile thinkingLevel / model reference validation
// ---------------------------------------------------------------------------

test('conversation HTTP accepts valid thinkingLevel and clear override, rejects unknown values/types', { timeout: 60_000 }, () => {
  for (const thinkingLevel of ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
    assert.deepEqual(parseConversationPatch({ thinkingLevel }), { thinkingLevel })
  }
  for (const thinkingLevel of [null, 1, 'highest']) assert.throws(() => parseConversationPatch({ thinkingLevel }))
})

test('model IDs may contain slashes; HTTP init/patch/Profile save preserve full references', { timeout: 60_000 }, () => {
  const model = 'gateway/group/smart'
  assert.equal(parseConversationInit({ model }).model, model)
  assert.equal(parseConversationPatch({ model }).model, model)
  assert.equal(parseProfileBody({ id: 'worker', model }, { requireId: true }).model, model)
})

test('Profile HTTP saves thinkingLevel; empty string clears it back to global default', { timeout: 60_000 }, () => {
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: 'high' }, { requireId: true }).thinkingLevel, 'high')
  assert.equal(parseProfileBody({ id: 'worker', thinkingLevel: '' }, { requireId: true }).thinkingLevel, undefined)
  for (const thinkingLevel of [null, 1, 'highest']) {
    assert.throws(() => parseProfileBody({ id: 'worker', thinkingLevel }, { requireId: true }))
  }
})
