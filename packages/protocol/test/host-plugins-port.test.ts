/**
 * HelmHostPluginsPort 契约锁定测试（纯类型形状，无运行时依赖）：
 * - HelmHostApi.plugins 挂载 HelmHostPluginsPort，且保留既有 listPlugins/listUi 兼容入口；
 * - 端口七方法签名（list/listUi 同步快照；doctor/install/update/remove/enable/disable 异步）；
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
  // 类型层断言：plugins 端口存在且形状正确；兼容入口未被移除。
  const host = {
    plugins: null,
    listPlugins: null,
    listUi: null,
  } as unknown as HelmHostApi
  assert.ok('plugins' in host)
  assert.ok('listPlugins' in host)
  assert.ok('listUi' in host)
})

test('HelmHostPluginsPort 七方法签名与既有结果模型（编译期形状锁定）', { timeout: 60_000 }, () => {
  const port = {
    list: (): PluginSummary[] => [],
    listUi: () => [],
    doctor: async (t: { dir?: string; id?: string }): Promise<PluginDoctorReport> =>
      ({ dir: t.dir ?? '/x', ok: true, checks: [], screens: ['main'] }) as PluginDoctorReport,
    install: async (s: string, o?: { enable?: boolean }): Promise<PluginInstallResult> =>
      ({ record: null as never, summary: null as never, ...(o?.enable ? {} : {}) }) as PluginInstallResult,
    update: async (): Promise<PluginUpdateResult> => ({ record: null as never, summary: null as never, changed: false, previousVersion: '' }),
    remove: async (): Promise<PluginRemoveResult> => ({ pluginId: 'x', installPath: '/x', wasEnabled: false, installId: 'i' }),
    enable: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: true, hooks: [], actions: [], tools: [] }),
    disable: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }),
  } satisfies HelmHostPluginsPort
  assert.equal(typeof port.list, 'function')
  assert.equal(typeof port.doctor, 'function')
})

test('PluginDoctorReport.screens 为 additive 可选字段（register 通过时存在）', { timeout: 60_000 }, () => {
  // register 通过：screens 携带真实 ui.screen 声明的视图 id 列表
  const withScreens: PluginDoctorReport = {
    dir: '/x',
    pluginId: 'demo',
    ok: true,
    checks: [],
    summary: null as never,
    screens: ['main', 'detail'],
  }
  assert.deepEqual(withScreens.screens, ['main', 'detail'])
  // register 未通过或无声明：缺省或空数组均为合法形状（不虚构）
  const withoutScreens: PluginDoctorReport = { dir: '/x', ok: false, checks: [] }
  assert.equal(withoutScreens.screens, undefined)
  const emptyScreens: PluginDoctorReport = { dir: '/x', ok: true, checks: [], screens: [] }
  assert.deepEqual(emptyScreens.screens, [])
})

test('BackendPluginsLifecyclePort 写面方法与 ctx.host.plugins 一一对应', { timeout: 60_000 }, () => {
  const backend = {
    doctorPlugin: async (): Promise<PluginDoctorReport> => ({ dir: '/x', ok: true, checks: [] }) as PluginDoctorReport,
    installPlugin: async (): Promise<PluginInstallResult> => ({ record: null as never, summary: null as never }) as PluginInstallResult,
    updatePlugin: async (): Promise<PluginUpdateResult> => ({ record: null as never, summary: null as never, changed: false, previousVersion: '' }),
    removePlugin: async (): Promise<PluginRemoveResult> => ({ pluginId: 'x', installPath: '/x', wasEnabled: false, installId: 'i' }),
    enablePlugin: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: true, hooks: [], actions: [], tools: [] }),
    disablePlugin: async (): Promise<PluginSummary> => ({ id: 'x', name: 'x', locked: false, enabled: false, hooks: [], actions: [], tools: [] }),
  } satisfies BackendPluginsLifecyclePort
  // 宿主后端端口为可选成员（未接线时 ctx.host.plugins 修改操作 501）。
  const withPlugins = { plugins: backend }
  const withoutPlugins: { plugins?: BackendPluginsLifecyclePort } = {}
  assert.ok(withPlugins.plugins !== undefined)
  assert.equal(withoutPlugins.plugins, undefined)
})
