/**
 * builtin:superagent Watchdog §3.1 专属单测：watchdog_inspect 的 activeProcesses
 * 进程占用快照（PluginHost + 受控注入依赖，不起真实内核）。
 *
 * 覆盖：
 * 1. inspectConversation 经 host.inspectNodePathUsage({nodeId: summary.nodeId
 *    ?? 'local', path: summary.cwd}) 现查会话工作目录占用，逐项脱敏为
 *    {pid, name, source, path}（name 读取失败时缺省项同样缺省）。
 * 2. 探测失败（节点离线 / 平台不支持等显式报错）→ activeProcesses 字段缺省，
 *    主消息（conversation/entries）照常返回，绝不伪造空清单冒充无占用。
 * 3. cwd 为空 → 不发起探测，字段缺省。
 * 4. 输出 schema：activeProcesses 数组项 {pid, name?, source, path} 通过
 *    动作出参校验（additionalProperties:false）。
 * 5. 技能资产接入：code-hang-loop.md 进入 WATCHDOG_PLAYBOOK_SKILL_ASSET
 *    且 SKILL.md 索引含该手册。
 */
import { createPluginBuildProvider } from '@helmx/plugin-build'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  HelmxError,
  type ConversationSummary,
  type MaybePromise,
  type NodePathUsage,
  type PluginDefinition,
} from '@helmx/protocol'
import {
  PluginHost,
  type PluginHostBackend,
} from '../../kernel/src/plugins/index.js'
import { hostBackendStub } from '../../kernel/test/helpers/host-backend-stub.js'
import { registerSuperAgentWatchdog } from '../src/superagent/watchdog.js'
import {
  WATCHDOG_PLAYBOOK_SKILL_ASSET,
  WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD,
} from '../src/superagent/assets.js'
import type {
  SuperAgentConfig,
  SuperAgentWatchdogRuntime,
} from '../src/superagent/contracts.js'
import {
  MemoryDocStore,
  makeConversationSummary as baseConversationSummary,
} from './helpers/plugin-test-env.js'

const PLUGIN_ID = 'builtin:superagent'

const makeConversationSummary = (id: number, over: Partial<ConversationSummary> = {}): ConversationSummary =>
  baseConversationSummary({ id, cwd: '/tmp/helmx-workdir', model: 'faux/faux-1', status: 'working', stateChangeSeq: 10, ...over })

interface InspectHarnessOptions {
  summary: ConversationSummary
  /** inspectNodePathUsage 受控实现：入参记录 + 返回值或抛错。 */
  pathUsage: (input: { nodeId: string; path: string }) => MaybePromise<NodePathUsage>
  /** 脱敏函数（默认恒等；用可观察变换验证脱敏链路）。 */
  redact?: (text: string) => string
}

/** 组装 PluginHost + 注册 watchdog 模块（仅 inspect 链路所需最小面）。 */
async function makeInspectHarness(opts: InspectHarnessOptions) {
  const pathUsageCalls: Array<{ nodeId: string; path: string }> = []
  const backend: PluginHostBackend = {
    ...hostBackendStub(),
    redact: opts.redact ?? ((text: string) => text),
    getConversation: (id: number) => {
      if (opts.summary.id !== id) {
        throw new HelmxError('not_found', `会话不存在：${id}`, 404, { conversationId: id })
      }
      return opts.summary
    },
    getConversationDetail: async (id: number) => ({
      ...opts.summary,
      id,
      entries: [
        { id: 'e1', kind: 'message', createdAt: 1, model: [{ role: 'assistant', content: 'hello' }] },
      ],
    }),
    getConversationOwnership: () => 'helmx',
    inspectNodePathUsage: (input: { nodeId: string; path: string }) => {
      pathUsageCalls.push({ nodeId: input.nodeId, path: input.path })
      return Promise.resolve(opts.pathUsage(input))
    },
  }

  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-superagent-watchdog-inspect-'))
  const host = new PluginHost({
    buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs: new MemoryDocStore(),
  })

  const config: SuperAgentConfig = {
    routerMode: true,
    mutedSources: '',
    watchdogEnabled: true,
    stalledAfterMs: 60_000,
    abortAfterMs: 600_000,
    errorThreshold: 3,
  }
  const runtime: SuperAgentWatchdogRuntime = {
    getConfig: () => config,
    getRouterConversationId: () => 100,
    getWatchdogConversationId: () => 200,
    track: <T,>(label: string, task: () => MaybePromise<T>): Promise<T> => {
      void label
      return Promise.resolve(task())
    },
  }
  const definition: PluginDefinition = {
    id: PLUGIN_ID,
    name: 'SuperAgent',
    definePlugin(ctx) {
      registerSuperAgentWatchdog(ctx, runtime)
    },
  }
  await host.register(definition)

  return {
    host,
    pathUsageCalls,
    async inspect(conversationId: number): Promise<Record<string, unknown>> {
      return host.invokeAction(PLUGIN_ID, 'watchdog_inspect', { conversationId }) as Promise<Record<string, unknown>>
    },
    async dispose() {
      await host.dispose()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('activeProcesses：按 (nodeId ?? local, cwd) 现查并逐项脱敏为 {pid,name,source,path}', { timeout: 60_000 }, async () => {
  const h = await makeInspectHarness({
    summary: makeConversationSummary(55, { status: 'working', cwd: '/root/worktrees/hotfix' }),
    // 可观察脱敏：给字符串加标记前缀，验证 name/path 均经过 host.redact。
    redact: (text) => `[R]${text}`,
    pathUsage: (input) => {
      assert.deepEqual(input, { nodeId: 'local', path: '/root/worktrees/hotfix' })
      return {
        path: input.path,
        processes: [
          { pid: 4321, name: 'vitest', source: 'cwd', path: '/root/worktrees/hotfix' },
          { pid: 4322, source: 'fd', path: '/root/worktrees/hotfix/node_modules/.tmp' },
        ],
        matchedTotal: 2,
        processesTruncated: false,
        complete: true,
        unobservable: 0,
        diagnostics: [],
      }
    },
  })
  const out = await h.inspect(55)
  assert.equal(out['kind'], 'conversation')
  const conversation = out['conversation'] as Record<string, unknown>
  assert.deepEqual(conversation['activeProcesses'], [
    { pid: 4321, name: '[R]vitest', source: 'cwd', path: '[R]/root/worktrees/hotfix' },
    { pid: 4322, source: 'fd', path: '[R]/root/worktrees/hotfix/node_modules/.tmp' },
  ])
  // 主消息字段照常（出参已通过宿主 outputSchema 校验）。
  assert.equal(conversation['id'], 55)
  assert.equal(conversation['status'], 'working')
  assert.ok(Array.isArray(out['entries']))
  await h.dispose()
})

test('activeProcesses：显式 nodeId 透传给 inspectNodePathUsage', { timeout: 60_000 }, async () => {
  const h = await makeInspectHarness({
    summary: makeConversationSummary(56, { nodeId: 'edge-1', cwd: '/srv/data' }),
    pathUsage: () => ({
      path: '/srv/data',
      processes: [{ pid: 9, name: 'python', source: 'cwd', path: '/srv/data' }],
      matchedTotal: 1,
      processesTruncated: false,
      complete: true,
      unobservable: 0,
      diagnostics: [],
    }),
  })
  const out = await h.inspect(56)
  assert.deepEqual(h.pathUsageCalls, [{ nodeId: 'edge-1', path: '/srv/data' }])
  assert.deepEqual((out['conversation'] as Record<string, unknown>)['activeProcesses'], [
    { pid: 9, name: 'python', source: 'cwd', path: '/srv/data' },
  ])
  await h.dispose()
})

test('activeProcesses：探测失败（节点离线）→ 字段缺省，主消息照常返回不伪造空清单', { timeout: 60_000 }, async () => {
  const h = await makeInspectHarness({
    summary: makeConversationSummary(57, { nodeId: 'offline-node', cwd: '/srv/gone' }),
    pathUsage: () => {
      throw new HelmxError('node_offline', '节点 offline-node 离线', 409, { nodeId: 'offline-node' })
    },
  })
  const out = await h.inspect(57)
  const conversation = out['conversation'] as Record<string, unknown>
  assert.equal('activeProcesses' in conversation, false, '探测失败必须字段缺省而非空数组')
  assert.equal(conversation['id'], 57)
  assert.ok(Array.isArray(out['entries']) && out['entries']!.length > 0)
  await h.dispose()
})

test('activeProcesses：cwd 为空 → 不发起探测，字段缺省', { timeout: 60_000 }, async () => {
  const h = await makeInspectHarness({
    summary: makeConversationSummary(58, { cwd: '' }),
    pathUsage: () => {
      throw new HelmxError('unexpected', 'cwd 为空不得调用 inspectNodePathUsage', 500)
    },
  })
  const out = await h.inspect(58)
  const conversation = out['conversation'] as Record<string, unknown>
  assert.equal('activeProcesses' in conversation, false)
  assert.equal(h.pathUsageCalls.length, 0)
  await h.dispose()
})

test('技能资产：code-hang-loop.md 接入 WATCHDOG_PLAYBOOK_SKILL_ASSET 且 SKILL.md 索引可见', { timeout: 60_000 }, async () => {
  assert.equal(
    WATCHDOG_PLAYBOOK_SKILL_ASSET.references['code-hang-loop.md'],
    WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD,
  )
  // 模板插值完成（无残留 {{MANAGED_BY}}）。
  assert.ok(!WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD.includes('{{'))
  // 手册内容覆盖关键链路：activeProcesses / watchdog_recover / abortAfterMs。
  assert.ok(WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD.includes('activeProcesses'))
  assert.ok(WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD.includes('watchdog_recover'))
  assert.ok(WATCHDOG_PLAYBOOK_CODE_HANG_LOOP_MD.includes('abortAfterMs'))
  // SKILL.md 索引含新手册行。
  assert.ok(WATCHDOG_PLAYBOOK_SKILL_ASSET.skillMd.includes('references/code-hang-loop.md'))
})
