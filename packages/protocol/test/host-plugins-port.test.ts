/**
 * HelmHostPluginsPort contract lock tests (pure type shapes, no runtime dependencies):
 * - HelmHostApi.plugins mounts HelmHostPluginsPort and keeps the existing
 *   listPlugins/listUi compatibility entries;
 * - port method signatures (list/listUi synchronous snapshots; doctor/install/
 *   update/remove/enable/disable asynchronous);
 * - result types reuse the existing PluginDoctorReport / PluginInstallResult /
 *   PluginUpdateResult / PluginRemoveResult / PluginSummary — no second model set;
 * - BackendPluginsLifecyclePort corresponds one-to-one with the ctx.host.plugins
 *   write-side methods (the host backend's narrowed surface).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  AgentSpawnRequest,
  BackendPluginsLifecyclePort,
  HelmHostApi,
  HelmHostPluginsPort,
  PluginDoctorReport,
  PluginInstallResult,
  PluginRemoveResult,
  PluginSummary,
  PluginToolSpec,
  PluginUpdateResult,
} from '@helm/protocol'

test('HelmHostApi.plugins mounts HelmHostPluginsPort and keeps the listPlugins/listUi compatibility entries', { timeout: 60_000 }, () => {
  // Compile-time type checks: ensure HelmHostApi mounts HelmHostPluginsPort and keeps the existing read-only method signatures
  type HasPlugins = HelmHostApi['plugins'] extends HelmHostPluginsPort ? true : false
  type HasListPlugins = HelmHostApi['listPlugins'] extends () => PluginSummary[] ? true : false
  type HasListUi = HelmHostApi['listUi'] extends () => unknown[] ? true : false
  const typeLocks: [HasPlugins, HasListPlugins, HasListUi] = [true, true, true]
  assert.deepEqual(typeLocks, [true, true, true])
})

test('HelmHostPluginsPort method signatures and existing result models (compile-time shape lock)', { timeout: 60_000 }, () => {
  const port: HelmHostPluginsPort = {
    list: (): PluginSummary[] => [],
    listUi: () => [],
    doctor: async (t: { dir?: string; id?: string }): Promise<PluginDoctorReport> =>
      ({ dir: t.dir ?? '/x', ok: true, checks: [], screens: ['main'] }),
    install: async (s: string, o?: { enable?: boolean }): Promise<PluginInstallResult> =>
      ({ record: null as never, summary: null as never, ...(o?.enable ? {} : {}) }),
    update: async (): Promise<PluginUpdateResult> => ({ record: null as never, summary: null as never, changed: false, previousVersion: '' }),
    remove: async (): Promise<PluginRemoveResult> => ({ pluginId: 'x', installPath: '/x', wasEnabled: false, installId: 'i' }),
    enable: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: true, hooks: [], actions: [], tools: [] }),
    disable: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }),
  }
  const methodNames: (keyof HelmHostPluginsPort)[] = [
    'list',
    'listUi',
    'doctor',
    'install',
    'update',
    'remove',
    'enable',
    'disable',
  ]
  for (const name of methodNames) {
    assert.equal(typeof port[name], 'function')
  }
})

test('PluginDoctorReport.screens is an additive optional field (type guards and structural defense)', { timeout: 60_000 }, () => {
  type ScreensOptional = undefined extends PluginDoctorReport['screens'] ? true : false
  type ScreensType = string[] extends NonNullable<PluginDoctorReport['screens']> ? true : false
  const checks: [ScreensOptional, ScreensType] = [true, true]
  assert.deepEqual(checks, [true, true])

  // Without the screens field it defaults to undefined and is still a valid shape (nothing fabricated)
  const withoutScreens: PluginDoctorReport = { dir: '/x', ok: false, checks: [] }
  assert.equal(withoutScreens.screens, undefined)
})

test('BackendPluginsLifecyclePort write-side methods correspond one-to-one with ctx.host.plugins', { timeout: 60_000 }, () => {
  const backend: BackendPluginsLifecyclePort = {
    doctorPlugin: async (): Promise<PluginDoctorReport> => ({ dir: '/x', ok: true, checks: [] }),
    installPlugin: async (): Promise<PluginInstallResult> => ({ record: null as never, summary: null as never }),
    updatePlugin: async (): Promise<PluginUpdateResult> => ({ record: null as never, summary: null as never, changed: false, previousVersion: '' }),
    removePlugin: async (): Promise<PluginRemoveResult> => ({ pluginId: 'x', installPath: '/x', wasEnabled: false, installId: 'i' }),
    enablePlugin: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: true, hooks: [], actions: [], tools: [] }),
    disablePlugin: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }),
  }
  const methods: (keyof BackendPluginsLifecyclePort)[] = [
    'doctorPlugin',
    'installPlugin',
    'updatePlugin',
    'removePlugin',
    'enablePlugin',
    'disablePlugin',
  ]
  for (const m of methods) {
    assert.equal(typeof backend[m], 'function')
  }
})

test('AgentSpawnRequest reattach/requestId and PluginToolSpec replay contract fields', { timeout: 60_000 }, () => {
  const spawnWithReattach: AgentSpawnRequest = {
    parentConversationId: 1,
    prompt: 'resume work',
    requestId: 'req-1',
    reattach: {
      conversationId: 2,
      executionId: 'exec-2',
      effectiveCwd: '/repo',
    },
  }
  assert.equal(spawnWithReattach.requestId, 'req-1')
  assert.equal(spawnWithReattach.reattach?.conversationId, 2)
  assert.equal(spawnWithReattach.reattach?.executionId, 'exec-2')
  assert.equal(spawnWithReattach.reattach?.effectiveCwd, '/repo')

  const safeTool: PluginToolSpec = {
    name: 'demo_tool',
    description: 'demo',
    inputSchema: { type: 'object' },
    replay: 'safe',
    execute: () => ({ ok: true }),
  }
  const unsafeTool: PluginToolSpec = {
    ...safeTool,
    replay: 'unsafe',
  }
  assert.equal(safeTool.replay, 'safe')
  assert.equal(unsafeTool.replay, 'unsafe')
})
