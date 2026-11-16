import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { HelmError, type ActionManifest, type ConversationSummary } from '@helm/protocol'
import {
  RuntimeToolRegistry,
  wrapToolExecute,
  type PluginHostToolTarget,
} from '../src/runtime/tool-registry.js'
import type { HandledToolCallEntry } from '../src/runtime/hook-bridge.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { DerivedToolSpec } from '../src/plugins/index.js'

describe('RuntimeToolRegistry and wrapToolExecute unit test', { timeout: 60_000 }, () => {
  it('wrapToolExecute: hit handled cache when directly return take over result and delete cache, do not execute original tool', { timeout: 60_000 }, async () => {
    const handledToolCalls = new Map<string, HandledToolCallEntry>()
    handledToolCalls.set('call-1', {
      conversationId: 42,
      result: { output: [{ type: 'text', text: 'intercepted-result' }], isError: false },
    })

    let underlyingExecuted = false
    const wrapped = wrapToolExecute(handledToolCalls, async () => {
      underlyingExecuted = true
      return { output: [{ type: 'text', text: 'original' }] }
    })

    const res = (await wrapped({} as never, { callId: 'call-1' } as never, {})) as {
      output: Array<{ type: 'text'; text: string }>
      isError: boolean
    }
    assert.equal(underlyingExecuted, false, 'original tool execute must not by invoke')
    assert.deepEqual(res, {
      output: [{ type: 'text', text: 'intercepted-result' }],
      isError: false,
    })
    assert.equal(handledToolCalls.has('call-1'), false, 'consume after should from handled cache in delete')
  })

  it('wrapToolExecute: missed handled when pass-through invoke original tool execute', { timeout: 60_000 }, async () => {
    const handledToolCalls = new Map<string, HandledToolCallEntry>()
    let calledWith: unknown = undefined
    const wrapped = wrapToolExecute(handledToolCalls, async (args) => {
      calledWith = args
      return { output: [{ type: 'text', text: 'normal-output' }] }
    })

    const res = (await wrapped({ param: 123 } as never, { callId: 'call-none' } as never, {})) as {
      output: Array<{ type: 'text'; text: string }>
    }
    assert.deepEqual(calledWith, { param: 123 })
    assert.deepEqual(res.output, [{ type: 'text', text: 'normal-output' }])
  })

  it('installKernelTools: register helm-core extend (6 basis tool), all package wrapToolExecute', { timeout: 60_000 }, async () => {
    const installed: Extension[] = []
    const fakeRegistry = {
      install(ext: Extension) {
        installed.push(ext)
      },
    }

    const handledToolCalls = new Map<string, HandledToolCallEntry>()
    const fakeToolDeps: HelmToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t.replace(/secret/g, '[REDACTED]'),
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }

    let invokedAction: { pluginId: string; actionId: string; input: unknown } | undefined
    const demoManifest: ActionManifest = {
      pluginId: 'demo',
      id: 'test',
      description: 'test action',
      inputSchema: { type: 'object', properties: { nested: { type: 'object', properties: { deep: { type: 'string' } } } }, required: ['nested'] },
      outputSchema: { type: 'object' },
      scope: { tags: ['alpha'] },
    }
    let listedActions: ActionManifest[] = [demoManifest]
    let conversationTags: string[] = ['alpha']
    const fakeHost: PluginHostToolTarget = {
      invokeAction: async (pluginId: string, actionId: string, input: unknown) => {
        invokedAction = { pluginId, actionId, input }
        return { message: `done with secret` }
      },
      executeTool: async () => {
        throw new Error('not implemented')
      },
      listTools: () => [],
      listActions: () => listedActions,
    }

    const registryModule = new RuntimeToolRegistry({
      registry: fakeRegistry,
      toolDeps: fakeToolDeps,
      getPluginHost: () => fakeHost,
      isArtifactAuthorized: (_c, _a) => true,
      redact: (t) => t.replace(/secret/g, '[REDACTED]'),
      handledToolCalls,
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: conversationTags,
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.installKernelTools()

    assert.equal(installed.length, 1)
    const coreExt = installed[0]!
    assert.equal(coreExt.name, 'helm-core')
    assert.ok(Array.isArray(coreExt.tools))
    const toolNames = coreExt.tools!.map((t) => t.name)
    assert.deepEqual(
      toolNames.sort(),
      ['bash', 'edit', 'read', 'read_artifact', 'register_artifact', 'run_action', 'write'].sort(),
    )

    // verify run_action meta tool behavior
    const runActionTool = coreExt.tools!.find((t) => t.name === 'run_action') as unknown as {
      execute: (args: Record<string, unknown>, api: { conversationId: number }, ctx: { abortSignal?: AbortSignal }) => Promise<{
        output: Array<{ type: 'text'; text: string }>
        isError?: boolean
      }>
    }
    assert.ok(runActionTool)

    // illegal action ID
    const badIdRes = await runActionTool.execute({ actionId: 'no-dot' }, { conversationId: 1 }, {})
    assert.equal(badIdRes.isError, true)
    assert.ok(badIdRes.output[0]!.text.includes('illegal action ID'))

    // normal invoke and redaction
    const okRes = await runActionTool.execute({ actionId: 'demo.test', input: { foo: 'bar' } }, { conversationId: 1 }, {})
    assert.equal(okRes.isError, undefined)
    assert.deepEqual(invokedAction, { pluginId: 'demo', actionId: 'test', input: { foo: 'bar' } })
    assert.ok(okRes.output[0]!.text.includes('[REDACTED]'))
    assert.ok(!okRes.output[0]!.text.includes('secret'))

    // hit handled tool call when intercept
    handledToolCalls.set('call-intercepted', {
      conversationId: 1,
      result: { output: [{ type: 'text', text: 'handled-by-hook' }], isError: false },
    })
    const interceptedRes = (await (runActionTool.execute as unknown as (args: unknown, api: unknown, ctx: unknown) => Promise<unknown>)(
      { actionId: 'demo.test' },
      { conversationId: 1, callId: 'call-intercepted' },
      {},
    )) as { output: Array<{ text: string }> }
    assert.equal(interceptedRes.output[0]!.text, 'handled-by-hook')

    // describe pattern: return complete manifest(contains embed set Schema), never execute handler
    invokedAction = undefined
    const descRes = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(descRes.isError, undefined)
    assert.equal(invokedAction, undefined, 'describe pattern must not trigger invokeAction')
    const parsed = JSON.parse(descRes.output[0]!.text) as ActionManifest
    assert.equal(parsed.pluginId, 'demo')
    assert.equal(parsed.id, 'test')
    assert.deepEqual(parsed.inputSchema, demoManifest.inputSchema, 'embed set Schema must complete can read')
    assert.deepEqual(parsed.outputSchema, demoManifest.outputSchema)

    // describe: unknown action (not declaration/not enabled) explicit reject
    const unknownRes = await runActionTool.execute({ actionId: 'demo.missing', describe: true }, { conversationId: 1 }, {})
    assert.equal(unknownRes.isError, true)
    assert.ok(unknownRes.output[0]!.text.includes('not declaration action'))

    // describe:scope outside conversation reject, do not leak Schema
    conversationTags = ['beta']
    const scopedOut = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(scopedOut.isError, true)
    assert.ok(scopedOut.output[0]!.text.includes('scope'))
    assert.ok(!scopedOut.output[0]!.text.includes('deep'), 'scope outside must not leak Schema content')
    conversationTags = ['alpha']

    // describe: plugin deactivate (listActions no longer return) same reject
    listedActions = []
    const disabledRes = await runActionTool.execute({ actionId: 'demo.test', describe: true }, { conversationId: 1 }, {})
    assert.equal(disabledRes.isError, true)
    assert.ok(disabledRes.output[0]!.text.includes('not declaration action'))
  })

  it('installPluginTools and refreshPluginTools: hot install and refresh plugin DerivedToolSpec', { timeout: 60_000 }, async () => {
    const installed: Extension[] = []
    const fakeRegistry = {
      install(ext: Extension) {
        installed.push(ext)
      },
    }

    const handledToolCalls = new Map<string, HandledToolCallEntry>()
    const fakeToolDeps: HelmToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t.replace(/token-123/g, '***'),
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }

    let executedToolCall: { name: string; args: unknown; context: unknown } | undefined
    let currentTools: DerivedToolSpec[] = [
      {
        name: 'custom_search',
        description: 'search tool',
        inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
        sourcePluginId: 'test-plugin',
        sourceKind: 'tool',
      },
    ]

    const fakeHost: PluginHostToolTarget = {
      invokeAction: async () => {
        throw new Error('not implemented')
      },
      listTools: () => currentTools,
      listActions: () => [],
      executeTool: async (name: string, args: unknown, context: unknown) => {
        executedToolCall = { name, args, context }
        return `result contains token-123`
      },
    }

    const registryModule = new RuntimeToolRegistry({
      registry: fakeRegistry,
      toolDeps: fakeToolDeps,
      getPluginHost: () => fakeHost,
      isArtifactAuthorized: () => true,
      redact: (t) => t.replace(/token-123/g, '***'),
      handledToolCalls,
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.refreshPluginTools()
    assert.equal(installed.length, 1)
    assert.equal(installed[0]!.name, 'helm-plugins')
    assert.equal(installed[0]!.tools?.length, 1)
    assert.equal(installed[0]!.tools?.[0]?.name, 'custom_search')

    // execute plugin tool and inspect verify redaction and context
    const tool = installed[0]!.tools?.[0] as unknown as {
      execute: (args: unknown, api: unknown, ctx: unknown) => Promise<{
        output: Array<{ type: 'text'; text: string }>
      }>
    }
    const res = await tool.execute(
      { q: 'helm' },
      { conversationId: 10, callId: 'call-custom-1' },
      { abortSignal: undefined },
    )
    assert.deepEqual(executedToolCall, {
      name: 'custom_search',
      args: { q: 'helm' },
      context: { conversationId: 10, callId: 'call-custom-1', signal: undefined },
    })
    assert.ok(res.output[0]!.text.includes('***'))
    assert.ok(!res.output[0]!.text.includes('token-123'))

    // update list after refreshPluginTools
    currentTools = []
    registryModule.refreshPluginTools()
    assert.equal(installed.length, 2)
    assert.equal(installed[1]!.name, 'helm-plugins')
    assert.equal(installed[1]!.tools?.length, 0)
  })

  it('wrapToolExecute: underlying return after if abortSignal already abort then unify throw abort exception (keep Error reason;handled short route exception)', { timeout: 60_000 }, async () => {
    const handledToolCalls = new Map<string, HandledToolCallEntry>()
    const ac1 = new AbortController()
    const wrappedNormal = wrapToolExecute(handledToolCalls, async () => {
      ac1.abort()
      return { output: [{ type: 'text', text: 'late-ok' }] }
    })
    await assert.rejects(
      () => wrappedNormal({} as never, { callId: 'call-abort-1' } as never, { abortSignal: ac1.signal }),
      (error: unknown) => error instanceof DOMException && error.name === 'AbortError',
    )

    const ac2 = new AbortController()
    const customReason = new Error('kernel closing')
    const wrappedErrResult = wrapToolExecute(handledToolCalls, async () => {
      ac2.abort(customReason)
      return { output: [{ type: 'text', text: 'late-error-result' }], isError: true }
    })
    await assert.rejects(
      () => wrappedErrResult({} as never, { callId: 'call-abort-2' } as never, { abortSignal: ac2.signal }),
      (error: unknown) => error === customReason,
    )

    // handledToolCalls short route branch hit when do not execute original tool also do not because abortSignal throws
    const acHandled = new AbortController()
    acHandled.abort(new Error('late abort'))
    handledToolCalls.set('call-handled-abort', {
      conversationId: 1,
      result: { output: [{ type: 'text', text: 'pre-handled' }], isError: false },
    })
    const handledRes = (await wrappedNormal(
      {} as never,
      { callId: 'call-handled-abort' } as never,
      { abortSignal: acHandled.signal },
    )) as { output: Array<{ text: string }> }
    assert.equal(handledRes.output[0]!.text, 'pre-handled')
  })

  it('installKernelTools: only only read tool read and read_artifact declaration replay: "safe", the rest keep default non- safe', { timeout: 60_000 }, () => {
    const installed: Extension[] = []
    const fakeToolDeps: HelmToolDeps = {
      dataDir: '/tmp/test',
      defaultCwd: '/tmp/test',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t,
      artifacts: {
        spill: async () => ({ text: 'spill' }),
        get: async () => ({} as never),
        readContent: async () => '',
        readBuffer: async () => new Uint8Array(),
      },
    }
    const registryModule = new RuntimeToolRegistry({
      registry: {
        install(ext: Extension) {
          installed.push(ext)
        },
      },
      toolDeps: fakeToolDeps,
      getPluginHost: () => undefined,
      isArtifactAuthorized: () => true,
      redact: (t) => t,
      handledToolCalls: new Map(),
      getConversation: (id) => ({
        id,
        title: 'test',
        profileId: 'assistant',
        tags: [],
        cwd: '/tmp/test',
        model: 'faux/faux-1',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    })

    registryModule.installKernelTools()
    const tools = installed[0]!.tools!
    const byName = new Map(tools.map((t) => [t.name, t]))
    assert.equal(byName.get('read')?.replay, 'safe')
    assert.equal(byName.get('read_artifact')?.replay, 'safe')
    for (const unsafeName of ['bash', 'write', 'edit', 'register_artifact', 'run_action']) {
      assert.notEqual(byName.get(unsafeName)?.replay, 'safe', `${unsafeName} must not declaration replay: safe`)
    }
  })
})
