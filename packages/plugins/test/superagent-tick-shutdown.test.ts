/**
 * 巡检收敛与关停语义（watchdog 移交 builtin:superagent 后）。
 *
 * 原内核 watchdogTick 关闭等待语义已随定时器删除；收敛责任转移到
 * superagent-watchdog service 的 stop：先停定时器，再有界等在途 tick
 * （PluginHost 受控停止窗口允许最终 doc 写入，插件释放后无残留回调写）。
 * 本文件用受控 PluginHost + watchdog 模块直接验证 dispose（close 语义）路径；
 * disable 路径的在途拒绝（409 plugin_has_live_tasks）由 watchdog 主测试覆盖。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { HelmxError, type ConversationSummary, type MaybePromise } from '@helmx/protocol'
import { PluginHost, type PluginHostBackend } from '../../kernel/src/plugins/index.js'
import {
  registerSuperAgentWatchdog,
} from '../src/superagent/watchdog.js'
import type { SuperAgentWatchdogRuntime } from '../src/superagent/contracts.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'
import {
  MemoryDocStore,
  deferred,
  makeConversationSummary,
  useTempDir,
} from './helpers/plugin-test-env.js'

const makeSummary = (id: number): ConversationSummary => makeConversationSummary({ id, model: '' })

test('service stop 等待已进入采集的在途 tick，插件释放前完成 Doc 写入', { timeout: 60_000 }, async (t) => {
  const dataDir = useTempDir(t, 'helmx-tick-close-')
  const conversations = new Map<number, ConversationSummary>([[1, makeSummary(1)]])
  const eventListeners = new Map<string, Array<(payload: unknown) => MaybePromise<void>>>()
  const entered = deferred()
  const release = deferred()
  const docs = new MemoryDocStore()
  let wrote = false

  const backend: PluginHostBackend = {
    ...hostBackendStub(),
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => makeSummary(1),
    listConversations: () => [...conversations.values()],
    getConversation: (id) => conversations.get(id)!,
    updateConversation: async (id) => conversations.get(id)!,
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    getConversationOwnership: () => 'helmx',
    isClosing: () => false,
    createAsk: async () => { throw new HelmxError('unsupported', '本测试不建 Ask', 400) },
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: (type, listener) => {
      const list = eventListeners.get(type) ?? []
      list.push(listener)
      eventListeners.set(type, list)
      return () => {
        const cur = eventListeners.get(type) ?? []
        const idx = cur.indexOf(listener)
        if (idx >= 0) cur.splice(idx, 1)
      }
    },
    emitEvent: async (type, payload) => {
      // 受控采集监听：进入后挂起，释放后经 doc 写入收尾（模拟 superagent 侧
      // evaluateCollection 在采集返回后的最终写入语义）。
      if (type === 'diagnostics.collect') {
        entered.resolve()
        await release.promise
        docs.set('builtin:superagent:watchdog-dedup', { version: 1, fired: {} })
        wrote = true
      }
    },
    getConversationDetail: async (id) => ({ ...makeSummary(id), entries: [] }),
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    execEnv: async () => { throw new HelmxError('unsupported', '本 fixture 不执行节点命令', 501) },
  }

  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => ({
      routerMode: true,
      mutedSources: '',
      watchdogEnabled: true,
      stalledAfterMs: 60_000,
      abortAfterMs: 600_000,
      errorThreshold: 3,
    }),
    getRouterConversationId: () => 100,
    getWatchdogConversationId: () => 200,
    track: async <T,>(_label: string, task: () => Promise<T>) => task(),
  }

  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs })
  await host.register({
    id: 'builtin:superagent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, runtime)
    },
  })

  const tick = host.invokeAction('builtin:superagent', 'watchdog_tick', {})
  await entered.promise
  let stopDone = false
  // dispose（close 语义）：不检查 liveTasks，直接 stop 服务——stop 必须先等
  // 在途 tick 收敛（受控等待，不撕裂写 doc 的巡检）。
  const stopping = host.dispose().then(() => { stopDone = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setImmediate(resolve))
  // 在途 tick 未收敛前 dispose 不得完成。
  assert.equal(stopDone, false, 'stop 必须等在途 tick 收敛')
  release.resolve()
  await tick
  await stopping
  assert.equal(wrote, true, '在途巡检的最终写入在插件释放前完成')
  // 停用后动作显式拒绝（无幻影入口）。
  await assert.rejects(
    host.invokeAction('builtin:superagent', 'watchdog_tick', {}),
    (error: unknown) => error instanceof HelmxError,
  )
})
