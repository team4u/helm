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

test('PluginPackageSource：npm/git/local 三变体判别联合与类型守卫', { timeout: 60_000 }, () => {
  function describeSource(src: PluginPackageSource): string {
    switch (src.kind) {
      case 'npm':
        return `npm:${src.spec}`
      case 'git':
        return `git:${src.repo}#${src.ref ?? src.subdirectory ?? 'HEAD'}`
      case 'local':
        return `local:${src.path}`
    }
  }

  assert.equal(
    describeSource({ kind: 'npm', raw: 'npm:helm-plugin-foo@^1.2.0', spec: 'helm-plugin-foo@^1.2.0' }),
    'npm:helm-plugin-foo@^1.2.0',
  )
  assert.equal(
    describeSource({
      kind: 'git',
      raw: 'git:https://github.com/u/helm-plugin-foo.git@v1.2.0',
      repo: 'https://github.com/u/helm-plugin-foo.git',
      ref: 'v1.2.0',
    }),
    'git:https://github.com/u/helm-plugin-foo.git#v1.2.0',
  )
  assert.equal(
    describeSource({
      kind: 'git',
      raw: 'https://github.com/u/monorepo#main',
      repo: 'https://github.com/u/monorepo',
      subdirectory: 'packages/foo',
    }),
    'git:https://github.com/u/monorepo#packages/foo',
  )
  assert.equal(
    describeSource({ kind: 'local', raw: '/abs/helm-plugin-foo', path: '/abs/helm-plugin-foo' }),
    'local:/abs/helm-plugin-foo',
  )
})

test('PluginPackageRecord / install / update / remove 结果模型契约锁定', { timeout: 60_000 }, () => {
  type RecordKeys = keyof PluginPackageRecord
  type InstallKeys = keyof PluginInstallResult
  type UpdateKeys = keyof PluginUpdateResult
  type RemoveKeys = keyof PluginRemoveResult

  type RequiredRecord = ['id', 'pluginId', 'source', 'installPath', 'version', 'installedAt', 'updatedAt'][number] extends RecordKeys ? true : false
  type RequiredInstall = ['record', 'summary'][number] extends InstallKeys ? true : false
  type RequiredUpdate = ['record', 'summary', 'changed', 'previousVersion'][number] extends UpdateKeys ? true : false
  type RequiredRemove = ['pluginId', 'installPath', 'wasEnabled', 'installId'][number] extends RemoveKeys ? true : false

  const typeLocks: [RequiredRecord, RequiredInstall, RequiredUpdate, RequiredRemove] = [true, true, true, true]
  assert.deepEqual(typeLocks, [true, true, true, true])
})

test('PluginSummary.managed 为 additive 可选字段（类型守卫与结构防御）', { timeout: 60_000 }, () => {
  type ManagedOptional = undefined extends PluginSummary['managed'] ? true : false
  const optCheck: ManagedOptional = true
  assert.equal(optCheck, true)

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
