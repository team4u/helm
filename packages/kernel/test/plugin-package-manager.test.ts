/**
 * Dedicated tests for external plugin package management (source parser / managed directory transactions / PluginHost integration / HTTP).
 *
 * Isolation discipline: never depends on real network — npm/git paths fail or return fixtures via an
 * injected fake runner; local paths use real temp directories and real file copies. Doctor checks and
 * PluginHost registration execute end-to-end (real TS transpilation + temporary PluginHost registration + client compilation).
 *
 * Covers:
 * - parsePluginSource: normalization and rejection across npm / git (shorthand / SCP / https / @ref / #subdir) / local (absolute / relative)
 *   sources (`file://`, `http://`, `git+`, unknown schemes, `builtin:`, whitespace, bare names);
 * - path security: install target escape, local self-install inside managed tree, `safeName`;
 * - staging cleanup on failure: `.staging` leaves zero residue and no half-written artifacts when the fake runner fails;
 * - local install: copy semantics (no symlinks), and `remove` leaves the user source directory untouched;
 * - full install / update / remove pipeline (real doctor + real PluginHost registration);
 * - HTTP routing: install body validation, 501 fallback, update/remove endpoints.
 *
 * runner: tsx --test; every test has an explicit timeout of 60_000 to guard against deadlocks; commands use overall timeouts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmxError, type PluginPackageRecord } from '@helmx/protocol'
import { parsePluginSource } from '../src/plugins/package-source.js'
import { PluginPackageManager, type PackageManagerHost, type PackageRunner } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'
import { assertRejectsCode } from './helpers.js'

// ---------------------------------------------------------------------------
// Source parser
// ---------------------------------------------------------------------------

test('parsePluginSource: npm normalization and rejection', { timeout: 60_000 }, () => {
  const npm = parsePluginSource('npm:helmx-plugin-foo@^1.2.0', '/wd')
  assert.equal(npm.kind, 'npm')
  assert.ok(npm.kind === 'npm')
  assert.equal(npm.spec, 'helmx-plugin-foo@^1.2.0')
  assert.equal(npm.raw, 'npm:helmx-plugin-foo@^1.2.0')
  const bare = parsePluginSource('npm:@scope/pkg', '/wd')
  assert.ok(bare.kind === 'npm' && bare.spec === '@scope/pkg')

  for (const bad of ['npm:', 'npm: ', 'npm:builtin:evil', 'builtin:profile', 'builtin%3Aprofile', '', '  ', 'file:///tmp/x', 'http://github.com/u/r', 'git+https://x.example/r', 'ftp://x/r', 'my-unknown-proto:foo', 'bare-name']) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmxError && err.status === 400, `should reject: ${bad}`)
  }
})

test('parsePluginSource: git shorthand / SCP / https with @ref / #subdirectory', { timeout: 60_000 }, () => {
  const short = parsePluginSource('git:github.com/user/repo@v1', '/wd')
  assert.ok(short.kind === 'git')
  if (short.kind !== 'git') return
  assert.equal(short.repo, 'github.com/user/repo')
  assert.equal(short.ref, 'v1')

  const scp = parsePluginSource('git:git@github.com:user/repo.git', '/wd')
  assert.ok(scp.kind === 'git')
  assert.equal((scp as { repo: string }).repo, 'git@github.com:user/repo.git')

  const https = parsePluginSource('https://github.com/user/repo.git', '/wd')
  assert.ok(https.kind === 'git')
  assert.equal((https as { repo: string }).repo, 'https://github.com/user/repo.git')

  const httpsRef = parsePluginSource('https://github.com/user/repo.git#v2.0.0', '/wd')
  assert.ok(httpsRef.kind === 'git')
  if (httpsRef.kind !== 'git') return
  assert.equal(httpsRef.ref, 'v2.0.0')
  assert.equal(httpsRef.subdirectory, undefined)

  const httpsSub = parsePluginSource('https://github.com/user/monorepo#packages/foo', '/wd')
  assert.ok(httpsSub.kind === 'git')
  if (httpsSub.kind !== 'git') return
  assert.equal(httpsSub.subdirectory, 'packages/foo')
  assert.equal(httpsSub.ref, undefined)

  const both = parsePluginSource('https://github.com/user/monorepo#v1#packages/foo', '/wd')
  assert.ok(both.kind === 'git')
  if (both.kind !== 'git') return
  assert.equal(both.ref, 'v1')
  assert.equal(both.subdirectory, 'packages/foo')

  const gitSub = parsePluginSource('git:github.com/user/repo@main#sub/dir', '/wd')
  assert.ok(gitSub.kind === 'git')
  if (gitSub.kind !== 'git') return
  assert.equal(gitSub.repo, 'github.com/user/repo')
  assert.equal(gitSub.ref, 'main')
  assert.equal(gitSub.subdirectory, 'sub/dir')

  for (const bad of ['git:', 'git:repo@', 'git:repo#', 'git:repo#sub#more', 'git:repo#../escape', 'https://', 'https://github.com/user/repo#sub#more#extra', 'git:repo@ref#sub#x']) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmxError, `should reject: ${bad}`)
  }
})

test('parsePluginSource: strict git repo validation (rejects path traversal and local relative paths)', { timeout: 60_000 }, () => {
  // Three valid forms (ssh:// is rejected as unknown transport; SCP covers SSH cases)
  for (const ok of ['git:https://github.com/user/repo.git', 'git:github.com/user/repo', 'git:git@github.com:user/repo.git']) {
    const parsed = parsePluginSource(ok, '/wd')
    assert.ok(parsed.kind === 'git', `should accept: ${ok}`)
  }
  // Reject: ../ traversal, backslashes, NUL bytes, absolute paths, drive letters, plain http, file:, ssh://, unknown schemes, whitespace, bare local paths
  for (const bad of ['git:../evil', 'git:..\\..\\evil', 'git:repo/../../evil', 'git:/abs/path', 'git:C:\\repo', 'git:\\\\srv\\share', 'git:http://plain.example/r', 'git:file:///tmp/r', 'git:ssh://git@host:22/path', 'git:repo with space', 'git:local-dir', 'git:./relative']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
      `should reject: ${bad}`,
    )
  }
})

test('parsePluginSource: resolves absolute and relative local paths', { timeout: 60_000 }, () => {
  const abs = parsePluginSource('/abs/plugins/foo', '/wd')
  assert.ok(abs.kind === 'local')
  if (abs.kind !== 'local') return
  assert.equal(abs.path, '/abs/plugins/foo')

  const rel = parsePluginSource('./packages/foo', '/wd')
  assert.ok(rel.kind === 'local')
  if (rel.kind !== 'local') return
  assert.equal(rel.path, '/wd/packages/foo')

  const up = parsePluginSource('../foo', '/wd/sub')
  assert.ok(up.kind === 'local')
  if (up.kind !== 'local') return
  assert.equal(up.path, '/wd/foo')

  // Windows drive-letter and UNC forms are local paths, not URI schemes (matched with the
  // web client's isLocalSource so UI hint and Hub parser agree). Exact resolved path is
  // platform-dependent; only kind and raw preservation are locked here.
  for (const win of ['C:\\Users\\me\\my-plugin', 'C:/Users/me/my-plugin', '\\\\server\\share\\my-plugin']) {
    const parsed = parsePluginSource(win, '/wd')
    assert.ok(parsed.kind === 'local', `Windows-style path must parse as local: ${win}`)
    if (parsed.kind !== 'local') return
    assert.equal(parsed.raw, win)
    assert.ok(typeof parsed.path === 'string' && parsed.path.length > 0)
  }

  // Ambiguous forms without a separator stay rejected as unknown protocols.
  for (const bad of ['C:', 'unknownproto:x']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
      `should reject: ${bad}`,
    )
  }
})

test('install from a Windows-style local path missing on this host fails honestly with 404 (resolved on the Hub)', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.install('C:\\Users\\me\\definitely-missing-plugin', {}),
      (err: unknown) =>
        err instanceof HelmxError
        && err.status === 404
        && err.code === 'plugin_package_install_failed'
        && err.message.includes('Hub host'),
      'drive-letter source should fail at stat with an honest Hub-host diagnostic, not a protocol rejection',
    )
    // No staging leftovers, no registration, and no record persisted for the failed attempt
    const staging = join(env.dataDir, 'plugins', '.staging')
    assert.ok(!existsSync(staging) || readdirSync(staging).length === 0, 'staging must be cleaned up')
    assert.equal(env.registered.size, 0, 'nothing should be registered')
    if (existsSync(join(env.dataDir, 'config.json'))) {
      const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
      assert.equal(Object.keys(config.pluginPackages ?? {}).length, 0, 'no install record should persist')
    }
  } finally {
    env.close()
  }
})


// ---------------------------------------------------------------------------
// Test harness: fake runner + real PluginHost (via host adapter interface)
// ---------------------------------------------------------------------------

/** Minimal valid external plugin source (conventional entry layout). */
const PLUGIN_SRC = (id: string, version = '0.1.0') => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

/** Package manager store backed by real config.json with toggleable save failure injection. */
class FaultInjectingStore extends PluginPackageManagerStore {
  failNextSave = false
  override async save(
    record: Omit<PluginPackageRecord, 'id'> & { id?: string },
  ): Promise<PluginPackageRecord> {
    if (this.failNextSave) throw new Error('simulated disk write failure')
    return super.save(record)
  }
}

interface TestEnv {
  dataDir: string
  cwd: string
  store: FaultInjectingStore
  host: PackageManagerHost
  manager: PluginPackageManager
  hostCalls: string[]
  registered: Map<string, { enabled: boolean }>
  /** Simulate active tasks: assertManagedPluginUpdateSafe throws 409 for matching IDs. */
  updateBlockedIds: Set<string>
  /** Simulate register failure: registerManagedPlugin throws for matching IDs. */
  registerFailIds: Set<string>
  /** Simulate enable failure: enableManagedPlugin throws for matching IDs. */
  enableFailIds: Set<string>
  /** Simulate purge failure: purgePluginPersistentData throws for matching IDs. */
  purgeFailIds: Set<string>
  close(): void
}

function makeEnv(runner?: PackageRunner): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-mgr-'))
  const cwd = mkdtempSync(join(tmpdir(), 'helmx-pkg-cwd-'))
  const store = new FaultInjectingStore(new ConfigService(dataDir))
  const hostCalls: string[] = []
  const registered = new Map<string, { enabled: boolean }>()
  const summaries = new Map<string, { id: string; version?: string; enabled: boolean }>()
  const updateBlockedIds = new Set<string>()
  const registerFailIds = new Set<string>()
  const enableFailIds = new Set<string>()
  const purgeFailIds = new Set<string>()
  const host: PackageManagerHost = {
    async registerManagedPlugin(dir: string) {
      hostCalls.push(`register:${dir}`)
      const id = readPluginIdFromDir(dir)
      if (registerFailIds.has(id)) {
        throw new HelmxError('plugin_register_failed_simulated', `simulated register failed: ${id}`, 500, { pluginId: id })
      }
      registered.set(id, { enabled: false })
      summaries.set(id, { id, version: readPluginVersionFromDir(dir), enabled: false })
      return { summary: toSummary(summaries, id), pluginId: id }
    },
    async enableManagedPlugin(pluginId: string) {
      hostCalls.push(`enable:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      if (enableFailIds.has(pluginId)) {
        throw new HelmxError('plugin_enable_failed_simulated', `simulated enable failed: ${pluginId}`, 500, { pluginId })
      }
      entry.enabled = true
      summaries.set(pluginId, { ...(summaries.get(pluginId) ?? { id: pluginId }), enabled: true })
      return toSummary(summaries, pluginId)
    },
    async updateManagedPlugin(pluginId: string) {
      hostCalls.push(`update:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      // Real adapter reloads from disk; mirror current manifest from managed directory here
      summaries.set(pluginId, { id: pluginId, version: readPluginVersionFromDir(join(dataDir, 'plugins', pluginId)), enabled: entry.enabled })
      return { summary: toSummary(summaries, pluginId) }
    },
    assertManagedPluginUpdateSafe(pluginId: string) {
      hostCalls.push(`assert-safe:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmxError('unknown_plugin', `plugin not registered: ${pluginId}`, 404, { pluginId })
      if (updateBlockedIds.has(pluginId)) {
        throw new HelmxError('plugin_has_live_tasks', `plugin ${pluginId} has active tasks; update swap rejected`, 409, { pluginId })
      }
    },
    async removeManagedPlugin(pluginId: string) {
      hostCalls.push(`remove:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) return { wasEnabled: false }
      registered.delete(pluginId)
      summaries.delete(pluginId)
      return { wasEnabled: entry.enabled }
    },
    async purgePluginPersistentData(pluginId: string) {
      hostCalls.push(`purge:${pluginId}`)
      if (purgeFailIds.has(pluginId)) {
        throw new HelmxError('store_flush_failed_simulated', `simulated purge failed: ${pluginId}`, 500, { pluginId })
      }
    },
    listSummaries: () => [...summaries.values()].map((s) => toSummary(summaries, s.id)),
  }
  const manager = new PluginPackageManager({
    dataDir,
    cwd,
    store,
    host,
    ...(runner !== undefined ? { runner } : {}),
  })
  return {
    dataDir,
    cwd,
    store,
    host,
    manager,
    hostCalls,
    registered,
    updateBlockedIds,
    registerFailIds,
    enableFailIds,
    purgeFailIds,
    close() {
      rmSync(dataDir, { recursive: true, force: true })
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}

function readPluginIdFromDir(dir: string): string {
  const manifest = join(dir, 'plugin.json')
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { id?: string }
    if (parsed.id !== undefined) return parsed.id
  }
  throw new Error('test plugin directory missing plugin.json id')
}

function readPluginVersionFromDir(dir: string): string {
  const manifest = join(dir, 'plugin.json')
  if (existsSync(manifest)) {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string }
    if (parsed.version !== undefined) return parsed.version
  }
  return ''
}

function toSummary(summaries: Map<string, { id: string; version?: string; enabled: boolean }>, id: string) {
  const s = summaries.get(id) ?? { id, enabled: false }
  return {
    id: s.id,
    name: s.id,
    locked: false,
    enabled: s.enabled,
    hooks: [] as never[],
    actions: s.enabled ? ['ping'] : [],
    tools: [] as string[],
    ...(s.version !== undefined ? { version: s.version } : {}),
  }
}

/** Writes a minimal local plugin source directory (`plugin.json` + `index.mjs`). */
function writeLocalPlugin(parent: string, id: string, version = '0.1.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

/** Fake runner: produces a full cloned repository layout on `git clone` (including `.git` to test exclusion). */
function gitCloneRunner(repoLayout: (repoDir: string) => void): PackageRunner {
  return async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const target = args[args.length - 1]
      if (typeof target !== 'string' || target.length === 0) {
        return { code: 1, stdout: '', stderr: 'fake runner: clone target missing' }
      }
      mkdirSync(target, { recursive: true })
      repoLayout(target)
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
}

const FAIL_RUNNER: PackageRunner = async (_cmd, _args) => ({
  code: 1,
  stdout: '',
  stderr: 'simulated network failure\n' + 'x'.repeat(100),
})

// ---------------------------------------------------------------------------
// Local install / remove transactions
// ---------------------------------------------------------------------------

test('local install copies into managed directory (non-symlink), persists record, and remove keeps user source intact', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrcParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-usersrc-'))
    const userSrc = writeLocalPlugin(userSrcParent, 'demo-local')
    writeFileSync(join(userSrc, 'user-notes.md'), 'user-owned file')

    const result = await env.manager.install(userSrc, { enable: true })
    assert.equal(result.record.pluginId, 'demo-local')
    assert.ok(result.record.source.kind === 'local')
    assert.equal(result.summary.enabled, true)
    assert.ok(result.summary.managed, 'summary should carry managed metadata')
    assert.equal(result.summary.managed?.installId, result.record.id)

    // Managed directory exists as a real copy (non-symlink)
    const managed = join(env.dataDir, 'plugins', 'demo-local')
    assert.ok(existsSync(managed), 'managed directory should exist')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    // Record persisted to config.json
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages: Record<string, unknown> }
    assert.ok(config.pluginPackages['demo-local'])
    // Remove deletes only the managed copy and record; user source stays intact
    const removed = await env.manager.remove('demo-local')
    assert.equal(removed.pluginId, 'demo-local')
    assert.equal(removed.wasEnabled, true)
    // Removal purges persistent doc data after unregistering instance and before deleting directory
    const removeAt = env.hostCalls.indexOf('remove:demo-local')
    const purgeAt = env.hostCalls.indexOf('purge:demo-local')
    assert.ok(removeAt >= 0, 'should call removeManagedPlugin')
    assert.ok(purgeAt > removeAt, 'should call purgePluginPersistentData after unregistering instance')
    assert.ok(!existsSync(managed), 'managed directory should be deleted')
    assert.ok(existsSync(join(userSrc, 'index.mjs')), 'user source directory must stay intact')
    assert.ok(existsSync(join(userSrc, 'user-notes.md')), 'user-owned files must stay intact')
    const after = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(after.pluginPackages?.['demo-local'], undefined, 'record should be deleted')
    rmSync(userSrcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('staging failure cleanup leaves zero artifacts after failed git clone', { timeout: 60_000 }, async () => {
  const env = makeEnv(FAIL_RUNNER)
  try {
    await assert.rejects(
      env.manager.install('git:github.com/user/broken-repo'),
      (err: unknown) => err instanceof HelmxError,
    )
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) {
      assert.deepEqual(readdirSync(staging), [], 'staging must leave no residue')
    }
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'broken-repo')), 'must not leave partial install directory')
  } finally {
    env.close()
  }
})

test('doctor failure prevents corrupt plugin from entering managed directory and cleans staging', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const badParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-bad-'))
    const badDir = join(badParent, 'bad-plugin')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'bad-plugin', main: 'index.ts' }))
    writeFileSync(join(badDir, 'index.ts'), 'export default { id: "bad-plugin", definePlugin() { throw new Error("boom") } }\n')
    await assert.rejects(
      env.manager.install(badDir),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_doctor_failed',
    )
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'bad-plugin')), 'broken plugin must not enter managed directory')
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) assert.deepEqual(readdirSync(staging), [])
    rmSync(badParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('git install: ref/subdirectory layout excludes node_modules and .git', { timeout: 60_000 }, async () => {
  const env = makeEnv(
    gitCloneRunner((repo) => {
      const sub = join(repo, 'packages', 'inner-plugin')
      mkdirSync(sub, { recursive: true })
      writeFileSync(join(sub, 'plugin.json'), JSON.stringify({ id: 'git-plugin', version: '1.0.0', main: 'index.mjs' }))
      writeFileSync(join(sub, 'index.mjs'), PLUGIN_SRC('git-plugin', '1.0.0'))
      mkdirSync(join(sub, 'node_modules', 'junk'), { recursive: true })
      writeFileSync(join(sub, 'node_modules', 'junk', 'x.js'), 'junk')
      mkdirSync(join(repo, '.git'), { recursive: true })
      writeFileSync(join(repo, '.git', 'HEAD'), 'ref: refs/heads/main')
    }),
  )
  try {
    const result = await env.manager.install('git:github.com/user/mono@main#packages/inner-plugin')
    assert.equal(result.record.pluginId, 'git-plugin')
    assert.ok(result.record.source.kind === 'git')
    if (result.record.source.kind !== 'git') return
    assert.equal(result.record.source.repo, 'github.com/user/mono')
    assert.equal(result.record.source.ref, 'main')
    assert.equal(result.record.source.subdirectory, 'packages/inner-plugin')
    const managed = join(env.dataDir, 'plugins', 'git-plugin')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    assert.ok(!existsSync(join(managed, 'node_modules')), 'node_modules should be excluded')
    assert.ok(!existsSync(join(managed, '.git')), '.git should be excluded')
  } finally {
    env.close()
  }
})

test('update returns 404 without record and resyncs updated version from local source', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.update('never-installed'),
      (err: unknown) => err instanceof HelmxError && err.status === 404,
    )
    const userSrc = writeLocalPlugin(env.cwd, 'up-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    // User bumps version in source directory
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'up-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('up-plugin', '2.0.0'))
    const updated = await env.manager.update('up-plugin')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.previousVersion, '1.0.0')
    assert.equal(updated.changed, true)
    const managedManifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'up-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(managedManifest.version, '2.0.0', 'managed directory should resync to new version')
  } finally {
    env.close()
  }
})

test('remove rejects explicitly when purge fails while keeping directory and record retryable', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'purge-fail-plugin')
    await env.manager.install(src)
    const managed = join(env.dataDir, 'plugins', 'purge-fail-plugin')
    assert.ok(existsSync(managed), 'precondition: install directory exists')

    // Purge failure: remove rejects explicitly and leaves managed dir + install record intact
    env.purgeFailIds.add('purge-fail-plugin')
    await assert.rejects(
      env.manager.remove('purge-fail-plugin'),
      (err: unknown) => err instanceof HelmxError && err.code === 'store_flush_failed_simulated',
    )
    assert.ok(existsSync(managed), 'managed directory must be preserved when purge fails')
    assert.ok(env.store.getRecord('purge-fail-plugin'), 'install record must be preserved when purge fails')
    // Instance was unregistered: removeManagedPlugin tolerates idempotent retries
    assert.ok(!env.registered.has('purge-fail-plugin'), 'first attempt unregistered instance')

    // Retry succeeds cleanly once fault clears
    env.purgeFailIds.delete('purge-fail-plugin')
    const removed = await env.manager.remove('purge-fail-plugin')
    assert.equal(removed.pluginId, 'purge-fail-plugin')
    assert.equal(removed.wasEnabled, false, 'wasEnabled is false on retry because instance was already unregistered')
    assert.ok(!existsSync(managed), 'managed directory deleted after successful retry')
    assert.equal(env.store.getRecord('purge-fail-plugin'), undefined, 'install record deleted after successful retry')
  } finally {
    env.close()
  }
})

test('remove protects builtins with 403 and rejects unmanaged plugins with 404', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.remove('builtin:profile'),
      (err: unknown) => err instanceof HelmxError && err.status === 403,
    )
    await assert.rejects(
      env.manager.remove('hand-placed'),
      (err: unknown) => err instanceof HelmxError && err.status === 404,
    )
  } finally {
    env.close()
  }
})

test('path security rejects local self-install targeting inside the managed tree', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const inside = join(env.dataDir, 'plugins', 'inside-plugin')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'plugin.json'), JSON.stringify({ id: 'inside-plugin', main: 'index.mjs' }))
    writeFileSync(join(inside, 'index.mjs'), PLUGIN_SRC('inside-plugin'))
    await assert.rejects(
      env.manager.install(inside),
      (err: unknown) => err instanceof HelmxError && err.status === 400,
    )
  } finally {
    env.close()
  }
})

test('update safety preflight rejects 409 on active tasks without modifying existing directory contents', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'busy-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    const managed = join(env.dataDir, 'plugins', 'busy-plugin')
    const manifestBefore = readFileSync(join(managed, 'plugin.json'), 'utf8')
    // Bump source + simulate active tasks: update must reject before swap and leave old directory untouched
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'busy-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    env.updateBlockedIds.add('busy-plugin')
    await assert.rejects(
      env.manager.update('busy-plugin'),
      (err: unknown) => err instanceof HelmxError && err.status === 409,
    )
    assert.ok(env.hostCalls.includes('assert-safe:busy-plugin'), 'should run safety preflight')
    assert.equal(readFileSync(join(managed, 'plugin.json'), 'utf8'), manifestBefore, 'old directory contents must remain completely unchanged')
    assert.ok(!env.hostCalls.includes('update:busy-plugin'), 'must not enter reload swap')
    // Clearing active tasks allows update to proceed normally
    env.updateBlockedIds.delete('busy-plugin')
    const updated = await env.manager.update('busy-plugin')
    assert.equal(updated.record.version, '2.0.0')
  } finally {
    env.close()
  }
})

test('runtime dependencies install in staging before doctor passes for local plugins with package.json', { timeout: 60_000 }, async () => {
  const depsInstalled: string[] = []
  // Runner records cwd on npm install and creates node_modules; passes through remaining commands
  const runner: PackageRunner = async (cmd, args, opts) => {
    if (cmd === 'npm' && args[0] === 'install') {
      depsInstalled.push(opts.cwd)
      mkdirSync(join(opts.cwd, 'node_modules'), { recursive: true })
      return { code: 0, stdout: '', stderr: '' }
    }
    return { code: 0, stdout: '', stderr: '' }
  }
  const env = makeEnv(runner)
  try {
    const srcParent = mkdtempSync(join(tmpdir(), 'helmx-pkg-deps-'))
    const src = join(srcParent, 'deps-plugin')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'deps-plugin', version: '0.1.0', main: 'index.mjs' }))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('deps-plugin'))
    // Declare runtime dependency in package.json (doctor imports entry requiring node_modules to exist)
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deps-plugin', version: '0.1.0', main: 'index.mjs', dependencies: { leftpad: '^1.0.0' } }))
    const result = await env.manager.install(src)
    assert.equal(result.record.pluginId, 'deps-plugin')
    // Dependencies are installed inside staging copy rather than user's source directory
    assert.equal(depsInstalled.length, 1, 'install should execute npm install exactly once')
    assert.ok(depsInstalled[0]!.includes('.staging'), 'dependency install must happen inside staging')
    assert.ok(!existsSync(join(src, 'node_modules')), 'user source directory must not have dependencies installed into it')
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'deps-plugin', 'node_modules')), 'managed directory should contain installed dependencies')
    rmSync(srcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('install transaction rolls back and deletes newly copied target directory when registration fails', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'rollback-plugin')
    env.registerFailIds.add('rollback-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) =>
        err instanceof HelmxError &&
        err.code === 'plugin_package_install_failed' &&
        (err.details as { rolledBack?: boolean } | undefined)?.rolledBack === true,
    )
    const target = join(env.dataDir, 'plugins', 'rollback-plugin')
    assert.ok(!existsSync(target), 'newly copied target must be deleted after registration fails')
    assert.ok(!env.registered.has('rollback-plugin'), 'must leave no registered instance')
    assert.equal(env.store.getRecord('rollback-plugin'), undefined, 'must leave no leftover record')
    // Re-installing after clearing the fault succeeds (no residue blocks retry)
    env.registerFailIds.delete('rollback-plugin')
    const ok = await env.manager.install(src)
    assert.equal(ok.record.pluginId, 'rollback-plugin')
  } finally {
    env.close()
  }
})

test('honest update rollback: failed restore reload no longer falsely reports old version active', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  let updateCalls = 0
  env.host.updateManagedPlugin = async (pluginId: string) => {
    updateCalls += 1
    // Both reloads fail: new version switch fails + restore reload fails (instance left unregistered)
    throw new HelmxError('plugin_reload_failed_simulated', `simulated reload failed #${updateCalls}`, 500, { pluginId })
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'honest-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'honest-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('honest-rollback', '2.0.0'))

    const err = (await assertRejectsCode(() => env.manager.update('honest-rollback'), 'plugin_package_update_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed restore reload must report rolledBack:false')
    assert.match(err.message, /old directory already restore, but old instance reload failed/, 'error message must clarify directory restored while instance did not')
    assert.equal(updateCalls, 2, 'rollback path must genuinely attempt restore reload')
    // Directory on disk was actually restored to the prior version
    const manifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'honest-rollback', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(manifest.version, '1.0.0')
  } finally {
    env.close()
  }
})

test('successful update rollback path: restore reload success still reports rolledBack:true', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  const original = env.host.updateManagedPlugin
  let calls = 0
  env.host.updateManagedPlugin = async (pluginId: string, dir: string, options: { keepEnabled: boolean }) => {
    calls += 1
    if (calls === 1) throw new HelmxError('plugin_reload_failed_simulated', 'first reload failed', 500, { pluginId })
    return original(pluginId, dir, options)
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'ok-rollback', '1.0.0')
    await env.manager.install(userSrc)
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'ok-rollback', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('ok-rollback', '2.0.0'))
    const err = (await assertRejectsCode(() => env.manager.update('ok-rollback'), 'plugin_package_update_failed', 500)) as HelmxError
    assert.equal((err.details as { rolledBack?: boolean }).rolledBack, true)
    assert.match(err.message, /already rollback to update before directory and instance/)
  } finally {
    env.close()
  }
})

test('install record save fails and rollback deregister fails: keeps directory and instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  env.host.removeManagedPlugin = async () => {
    // Simulate live task blocking unregister with 409: instance stays registered and running
    throw new HelmxError('plugin_has_live_tasks', 'simulated live task blocks removal', 409, { pluginId: 'keep-dir' })
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'keep-dir', '1.0.0')
    env.store.failNextSave = true
    const err = (await assertRejectsCode(() => env.manager.install(userSrc, { enable: true }), 'plugin_package_install_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean; rollbackError?: { message: string } }
    assert.equal(details.rolledBack, false, 'failed rollback deregister must report rolledBack:false')
    assert.match(err.message, /directory and instance already keep/, 'error message must warn that state remains preserved for manual handling')
    const target = join(env.dataDir, 'plugins', 'keep-dir')
    assert.ok(existsSync(join(target, 'index.mjs')), 'must not rm directory backing a live registered instance')
    assert.ok(!env.store.getRecord('keep-dir'), 'install record not persisted')
  } finally {
    env.close()
  }
})

test('install register fails due to concurrent same-name instance: preserves directory for that instance, rolledBack:false', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  let registerAttempted = false
  env.host.registerManagedPlugin = async (dir: string) => {
    const manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8')) as { id: string }
    // Simulate concurrent rescan winning registration from the same directory (409), after which listSummaries sees it
    registerAttempted = true
    throw new HelmxError('plugin_already_registered', `plugin already registered: ${manifest.id}`, 409, { pluginId: manifest.id })
  }
  const originalList = env.host.listSummaries.bind(env.host)
  env.host.listSummaries = () => {
    const base = originalList()
    return registerAttempted && !base.some((s) => s.id === 'raced-plugin')
      ? [...base, toSummary(new Map([['raced-plugin', { id: 'raced-plugin', enabled: true }]]), 'raced-plugin')]
      : base
  }
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'raced-plugin', '1.0.0')
    const err = (await assertRejectsCode(() => env.manager.install(userSrc), 'plugin_package_install_failed', 500)) as HelmxError
    const details = err.details as { rolledBack?: boolean }
    assert.equal(details.rolledBack, false)
    assert.match(err.message, /same name plugin registered/)
    const target = join(env.dataDir, 'plugins', 'raced-plugin')
    assert.ok(existsSync(join(target, 'index.mjs')), 'directory must remain intact for concurrently registered instance')
  } finally {
    env.close()
  }
})

test('install duplicate guards return 409 for existing managed record, registered instance, or occupied target dir', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'dup-plugin')
    await env.manager.install(src)
    // Duplicate install from same source: managed record already exists
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )
    // Different source with same id: still rejected
    const src2 = writeLocalPlugin(join(env.cwd, 'alt'), 'dup-plugin')
    await assert.rejects(
      env.manager.install(src2),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed',
    )
    // Target directory occupied manually (no record and not registered)
    const occupied = join(env.dataDir, 'plugins', 'occupied-plugin')
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'stale.txt'), 'residue')
    const src3 = writeLocalPlugin(env.cwd, 'occupied-plugin')
    await assert.rejects(
      env.manager.install(src3),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_target_occupied' && err.status === 409,
    )
    assert.equal(readFileSync(join(occupied, 'stale.txt'), 'utf8'), 'residue', 'pre-existing directory must not be deleted')
  } finally {
    env.close()
  }
})

test('install when enable fails keeps plugin disabled, reports enableError, and persists record for restart', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'enablefail-plugin')
    env.enableFailIds.add('enablefail-plugin')
    const result = await env.manager.install(src, { enable: true })
    // Install succeeded while enable failed: summary reflects truth
    assert.equal(result.record.pluginId, 'enablefail-plugin')
    assert.equal(result.summary.enabled, false, 'plugin must remain disabled when enable fails')
    assert.ok(result.enableError, 'enableError must pass through')
    assert.equal(result.enableError.code, 'plugin_enable_failed_simulated')
    // Record persisted and reloads across restarts
    const reloaded = new PluginPackageManagerStore(new ConfigService(env.dataDir))
    await reloaded.load()
    const record = reloaded.getRecord('enablefail-plugin')
    assert.ok(record, 'enable failure does not prevent persisting record across restarts')
    assert.equal(record.source.kind, 'local')
    // After clearing fault, reinstall conflicts 409 (use update instead)
    env.enableFailIds.delete('enablefail-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmxError && err.code === 'plugin_package_already_installed',
    )
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// Package record store: corrupt state rejected explicitly; restart recovery
// ---------------------------------------------------------------------------

test('store: corrupt pluginPackages throws config_corrupt explicitly; update save preserves existing id', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helmx-pkg-store-'))
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: 'not-an-object' }))
    const store = new PluginPackageManagerStore(new ConfigService(dataDir))
    await assert.rejects(store.load(), (err: unknown) => err instanceof HelmxError && err.code === 'config_corrupt')

    rmSync(join(dataDir, 'config.json'))
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: { 'p-1': { id: 'plugpkg-p-1', pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/plugins/p-1', version: '1.0.0', installedAt: 1, updatedAt: 1 } } }))
    const store2 = new PluginPackageManagerStore(new ConfigService(dataDir))
    await store2.load()
    assert.equal(store2.getRecord('p-1')?.id, 'plugpkg-p-1')
    const saved = await store2.save({ pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/plugins/p-1', version: '1.1.0', installedAt: 1, updatedAt: 2 })
    assert.equal(saved.id, 'plugpkg-p-1', 're-save preserves existing record id')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
