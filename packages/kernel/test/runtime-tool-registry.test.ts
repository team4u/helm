import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Extension, ToolRegistration } from '@earendil-works/pi-durable'
import { HelmError } from '@helm/protocol'
import {
  RuntimeToolRegistry,
  wrapToolExecute,
  type PluginHostToolTarget,
} from '../src/runtime/tool-registry.js'
import type { HandledToolCallEntry } from '../src/runtime/hook-bridge.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { DerivedToolSpec } from '../src/plugins/index.js'

describe('RuntimeToolRegistry 与 wrapToolExecute 单元测试', { timeout: 60_000 }, () => {
  it('wrapToolExecute：命中 handled 缓存时直接返回接管结果并删除缓存，不执行原工具', { timeout: 60_000 }, async () => {
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
    assert.equal(underlyingExecuted, false, '原工具执行器不应被调用')
    assert.deepEqual(res, {
      output: [{ type: 'text', text: 'intercepted-result' }],
      isError: false,
    })
    assert.equal(handledToolCalls.has('call-1'), false, '消费后应从 handled 缓存中删除')
  })

  it('wrapToolExecute：未命中 handled 时透传调用原工具执行器', { timeout: 60_000 }, async () => {
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

  it('installKernelTools：注册 helm-core 扩展（6 个基础工具），均包 wrapToolExecute', { timeout: 60_000 }, async () => {
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
    const fakeHost: PluginHostToolTarget = {
      invokeAction: async (pluginId: string, actionId: string, input: unknown) => {
        invokedAction = { pluginId, actionId, input }
        return { message: `done with secret` }
      },
      executeTool: async () => {
        throw new Error('not implemented')
      },
      listTools: () => [],
    }

    const registryModule = new RuntimeToolRegistry({
      registry: fakeRegistry,
      toolDeps: fakeToolDeps,
      getPluginHost: () => fakeHost,
      isArtifactAuthorized: (_c, _a) => true,
      redact: (t) => t.replace(/secret/g, '[REDACTED]'),
      handledToolCalls,
    })

    registryModule.installKernelTools()

    assert.equal(installed.length, 1)
    const coreExt = installed[0]!
    assert.equal(coreExt.name, 'helm-core')
    assert.ok(Array.isArray(coreExt.tools))
    const toolNames = coreExt.tools!.map((t) => t.name)
    assert.deepEqual(toolNames.sort(), ['bash', 'edit', 'read', 'read_artifact', 'run_action', 'write'].sort())

    // 验证 run_action 元工具行为
    const runActionTool = coreExt.tools!.find((t) => t.name === 'run_action') as unknown as {
      execute: (args: Record<string, unknown>, api: { conversationId: number }, ctx: { abortSignal?: AbortSignal }) => Promise<{
        output: Array<{ type: 'text'; text: string }>
        isError?: boolean
      }>
    }
    assert.ok(runActionTool)

    // 非法动作 ID
    const badIdRes = await runActionTool.execute({ actionId: 'no-dot' }, { conversationId: 1 }, {})
    assert.equal(badIdRes.isError, true)
    assert.ok(badIdRes.output[0]!.text.includes('非法动作 ID'))

    // 正常调用并脱敏
    const okRes = await runActionTool.execute({ actionId: 'demo.test', input: { foo: 'bar' } }, { conversationId: 1 }, {})
    assert.equal(okRes.isError, undefined)
    assert.deepEqual(invokedAction, { pluginId: 'demo', actionId: 'test', input: { foo: 'bar' } })
    assert.ok(okRes.output[0]!.text.includes('[REDACTED]'))
    assert.ok(!okRes.output[0]!.text.includes('secret'))

    // 命中 handled tool call 时拦截
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
  })

  it('installPluginTools 与 refreshPluginTools：热装与刷新插件 DerivedToolSpec', { timeout: 60_000 }, async () => {
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
        description: '搜索工具',
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
    })

    registryModule.refreshPluginTools()
    assert.equal(installed.length, 1)
    assert.equal(installed[0]!.name, 'helm-plugins')
    assert.equal(installed[0]!.tools?.length, 1)
    assert.equal(installed[0]!.tools?.[0]?.name, 'custom_search')

    // 执行插件工具并检验脱敏与上下文
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

    // 更新列表后 refreshPluginTools
    currentTools = []
    registryModule.refreshPluginTools()
    assert.equal(installed.length, 2)
    assert.equal(installed[1]!.name, 'helm-plugins')
    assert.equal(installed[1]!.tools?.length, 0)
  })
})
