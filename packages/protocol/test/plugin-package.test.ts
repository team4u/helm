/**
 * 外部插件包管理共享契约锁定测试（纯类型形状 + source grammar 类型面）。
 * protocol 只放可串行化类型；解析器由 kernel 实现，此处仅锁定类型契约：
 * - PluginPackageSource 三态判别联合（npm/git/local）与各变体字段；
 * - PluginPackageRecord / PluginInstallResult / PluginUpdateResult /
 *   PluginRemoveResult 关键字段；
 * - PluginSummary.managed 为 additive 可选元数据（现有契约不破坏）；
 * - CORE_CLI_COMMAND_PATHS 含 plugins install/update/remove 三个命令路径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  CORE_CLI_COMMAND_PATHS,
  type PluginInstallResult,
  type PluginPackageRecord,
  type PluginPackageSource,
  type PluginRemoveResult,
  type PluginSummary,
  type PluginUpdateResult,
} from '@helm/protocol'

test('PluginPackageSource：npm/git/local 三变体判别联合可构造且 kind 判别', { timeout: 60_000 }, () => {
  const npm: PluginPackageSource = { kind: 'npm', raw: 'npm:helm-plugin-foo@^1.2.0', spec: 'helm-plugin-foo@^1.2.0' }
  const git: PluginPackageSource = {
    kind: 'git',
    raw: 'git:https://github.com/u/helm-plugin-foo.git@v1.2.0',
    repo: 'https://github.com/u/helm-plugin-foo.git',
    ref: 'v1.2.0',
  }
  const gitSubdir: PluginPackageSource = {
    kind: 'git',
    raw: 'https://github.com/u/monorepo#main',
    repo: 'https://github.com/u/monorepo',
    subdirectory: 'packages/foo',
  }
  const local: PluginPackageSource = { kind: 'local', raw: '/abs/helm-plugin-foo', path: '/abs/helm-plugin-foo' }
  assert.equal(npm.kind, 'npm')
  assert.equal(git.kind, 'git')
  assert.equal(gitSubdir.ref, undefined)
  assert.equal(gitSubdir.subdirectory, 'packages/foo')
  assert.equal(local.kind, 'local')
})

test('PluginPackageRecord / install / update / remove 结果形状', { timeout: 60_000 }, () => {
  const record: PluginPackageRecord = {
    id: 'inst-1',
    pluginId: 'helm-plugin-foo',
    source: { kind: 'npm', raw: 'npm:helm-plugin-foo@^1', spec: 'helm-plugin-foo@^1' },
    installPath: '/data/plugins/helm-plugin-foo',
    version: '1.2.0',
    installedAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  }
  const summary: PluginSummary = {
    id: 'helm-plugin-foo',
    name: 'helm-plugin-foo',
    locked: false,
    enabled: false,
    hooks: [],
    actions: [],
    tools: [],
    managed: {
      source: record.source,
      installId: record.id,
      installedVersion: record.version,
      installedAt: record.installedAt,
    },
  }
  const install: PluginInstallResult = { record, summary }
  const update: PluginUpdateResult = {
    record: { ...record, version: '1.3.0', updatedAt: 1_700_000_100_000 },
    summary: { ...summary, enabled: true },
    changed: true,
    previousVersion: '1.2.0',
  }
  const remove: PluginRemoveResult = {
    pluginId: 'helm-plugin-foo',
    installPath: record.installPath,
    wasEnabled: true,
    installId: record.id,
  }
  assert.equal(install.record.id, 'inst-1')
  assert.equal(install.summary.managed?.installId, 'inst-1')
  assert.equal(update.changed, true)
  assert.equal(remove.wasEnabled, true)
})

test('PluginSummary.managed 为 additive 可选（无 managed 的既有形状仍合法）', { timeout: 60_000 }, () => {
  const legacy: PluginSummary = {
    id: 'builtin:profile',
    name: 'profile',
    locked: true,
    enabled: true,
    hooks: [],
    actions: [],
    tools: [],
  }
  assert.equal(legacy.managed, undefined)
})

test('CORE_CLI_COMMAND_PATHS 含 plugins install/update/remove 且不重复', { timeout: 60_000 }, () => {
  const paths = [...CORE_CLI_COMMAND_PATHS]
  for (const cmd of ['plugins install', 'plugins update', 'plugins remove']) {
    assert.ok(paths.includes(cmd), `应包含 ${cmd}`)
  }
  assert.equal(new Set(paths).size, paths.length, '命令路径不得重复')
})
