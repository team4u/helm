/**
 * Shared contract lock tests for external plugin package management (pure type
 * shapes + the source grammar type surface). protocol holds only serializable
 * types; the parser is implemented in the kernel — these tests lock the type
 * contract only:
 * - the PluginPackageSource three-state discriminated union (npm/git/local) and
 *   per-variant fields;
 * - key fields of PluginPackageRecord / PluginInstallResult / PluginUpdateResult /
 *   PluginRemoveResult;
 * - PluginSummary.managed as additive optional metadata (existing contract intact);
 * - CORE_CLI_COMMAND_PATHS includes the plugins install/update/remove command paths.
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

test('PluginPackageSource: npm/git/local three-variant discriminated union with type guards', { timeout: 60_000 }, () => {
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

test('PluginPackageRecord / install / update / remove result model contract lock', { timeout: 60_000 }, () => {
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

test('PluginSummary.managed is an additive optional field (type guards and structural defense)', { timeout: 60_000 }, () => {
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

test('CORE_CLI_COMMAND_PATHS includes plugins install/update/remove without duplicates', { timeout: 60_000 }, () => {
  const paths = [...CORE_CLI_COMMAND_PATHS]
  for (const cmd of ['plugins install', 'plugins update', 'plugins remove']) {
    assert.ok(paths.includes(cmd), `should include ${cmd}`)
  }
  assert.equal(new Set(paths).size, paths.length, 'command paths must not repeat')
})
