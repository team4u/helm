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
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { HelmError, type ConversationSummary, type MaybePromise } from '@helm/protocol'
import { PluginHost, type PluginDocStore, type PluginHostBackend } from '../src/plugins/index.js'
import {
  registerSuperAgentWatchdog,
} from '../src/builtin-plugins/superagent/watchdog.js'
import type {
  SuperAgentDependencies,
  SuperAgentWatchdogRuntime,
} from '../src/builtin-plugins/superagent/contracts.js'
import type { ProfileService, SkillService } from '../src/services/index.js'

function makeSummary(id: number): ConversationSummary {
  return {
    id,
    title: `conv-${id}`,
    profileId: 'assistant',
    tags: [],
    cwd: '/tmp',
    model: '',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  }
}

class MemoryDocStore implements PluginDocStore {
  readonly store = new Map<string, unknown>()
  get<T>(key: string, initial: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : initial
  }
  set<T>(key: string, value: T): void {
    this.store.set(key, structuredClone(value))
  }
  async flush(): Promise<void> {}
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test('service stop 等待已进入采集的在途 tick，插件释放前完成 Doc 写入', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-tick-close-'))
  const conversations = new Map<number, ConversationSummary>([[1, makeSummary(1)]])
  const eventListeners = new Map<string, Array<(payload: unknown) => MaybePromise<void>>>()
  const entered = deferred()
  const release = deferred()
  const docs = new MemoryDocStore()
  let wrote = false

  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => makeSummary(1),
    listConversations: () => [...conversations.values()],
    getConversation: (id) => conversations.get(id)!,
    updateConversation: async (id) => conversations.get(id)!,
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    getConversationActivity: () => ({ consecutiveErrors: 0 }),
    getConversationOwnership: () => 'helm',
    get isClosing() {
      return false
    },
    createAsk: async () => { throw new HelmError('unsupported', '本测试不建 Ask', 400) },
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
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: async () => ({ removed: false, worktreeId: '', path: '', branch: '', nodeId: '', branchDeleted: false }),
    invokeAction: async () => ({}),
    prepareAction: () => ({ idempotent: false }),
    execEnv: async () => { throw new HelmError('unsupported', '本 fixture 不执行节点命令', 501) },
    listActions: () => [],
  }

  const deps: SuperAgentDependencies = {
    dataDir,
    profiles: {} as ProfileService,
    skills: {} as SkillService,
    subscribeConversationEntries: () => () => {},
    getConversationDetail: async (id) => ({ ...makeSummary(id), entries: [] }),
    listArtifacts: async () => [],
    abortConversation: async () => {},
    getConversationOwnership: () => 'helm',
    isClosing: () => false,
    setRouterMode: async () => {},
    redact: (t) => t,
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

  const host = new PluginHost({ dataDir, host: backend, docs })
  await host.register({
    id: 'builtin:superagent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, deps, runtime)
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
    (error: unknown) => error instanceof HelmError,
  )
  rmSync(dataDir, { recursive: true, force: true })
})
