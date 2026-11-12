/**
 * HelmHostPluginsPort 契约锁定测试（纯类型形状，无运行时依赖）：
 * - HelmHostApi.plugins 挂载 HelmHostPluginsPort，且保留既有 listPlugins/listUi 兼容入口；
 * - 端口方法签名（list/listUi 同步快照；doctor/install/update/remove/enable/disable 异步）；
 * - 结果类型复用既有 PluginDoctorReport / PluginInstallResult / PluginUpdateResult /
 *   PluginRemoveResult / PluginSummary，不引入第二套模型；
 * - BackendPluginsLifecyclePort 与 ctx.host.plugins 写面方法一一对应（宿主后端拆窄面）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  BackendPluginsLifecyclePort,
  HelmHostApi,
  HelmHostPluginsPort,
  PluginDoctorReport,
  PluginInstallResult,
  PluginRemoveResult,
  PluginSummary,
  PluginUpdateResult,
} from '@helm/protocol'

test('HelmHostApi.plugins 挂载 HelmHostPluginsPort 且保留 listPlugins/listUi 兼容入口', { timeout: 60_000 }, () => {
  // 编译期类型校验：确保 HelmHostApi 挂载 HelmHostPluginsPort 且保留既有只读方法签名
  type HasPlugins = HelmHostApi['plugins'] extends HelmHostPluginsPort ? true : false
  type HasListPlugins = HelmHostApi['listPlugins'] extends () => PluginSummary[] ? true : false
  type HasListUi = HelmHostApi['listUi'] extends () => unknown[] ? true : false
  const typeLocks: [HasPlugins, HasListPlugins, HasListUi] = [true, true, true]
  assert.deepEqual(typeLocks, [true, true, true])
})

test('HelmHostPluginsPort 方法签名与既有结果模型（编译期形状锁定）', { timeout: 60_000 }, () => {
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

test('PluginDoctorReport.screens 为 additive 可选字段（类型守卫与结构防御）', { timeout: 60_000 }, () => {
  type ScreensOptional = undefined extends PluginDoctorReport['screens'] ? true : false
  type ScreensType = string[] extends NonNullable<PluginDoctorReport['screens']> ? true : false
  const checks: [ScreensOptional, ScreensType] = [true, true]
  assert.deepEqual(checks, [true, true])

  // 未提供 screens 字段时缺省为 undefined，仍为合法形状（不虚构）
  const withoutScreens: PluginDoctorReport = { dir: '/x', ok: false, checks: [] }
  assert.equal(withoutScreens.screens, undefined)
})

test('BackendPluginsLifecyclePort 写面方法与 ctx.host.plugins 一一对应', { timeout: 60_000 }, () => {
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
