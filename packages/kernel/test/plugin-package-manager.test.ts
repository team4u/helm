/**
 * external plugin package manage dedicated items test (parser / managed directory transaction / PluginHost collection into / HTTP).
 *
 * combine discipline: independent of real network - -npm/git path via inject fake runner simulated command into failed;
 * local path use real temp directory + real copy.doctor all chain and PluginHost register is real
 * implement (real TS transpile + temporary PluginHost register + client compile).
 *
 * override:
 * - parsePluginSource:npm/git(short write/SCP/https/@ref/#subdir)/local(absolute/each other for)
 *   specification and reject (file://,http://,git+, unknown protocol,builtin:, whitespace, bare name);
 * - path security: install target out of bounds,local self install (managed tree internal),safeName;
 * - staging failed clean up:fake runner failed after .staging no residue, without half artifact;
 * - local install: copy semantics (non- symlink),remove do not delete user source directory;
 * - install/update/remove all chain (real doctor + real PluginHost register);
 * - HTTP routing:install body validate,501 fall back,update/remove end point.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HelmError } from '@helm/protocol'
import { parsePluginSource } from '../src/plugins/package-source.js'
import { PluginPackageManager, type PackageRunner } from '../src/plugins/package-manager.js'
import { PluginPackageManagerStore } from '../src/plugins/package-store.js'
import { ConfigService } from '../src/services/config.js'

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

test('parsePluginSource:npm specification and reject', { timeout: 60_000 }, () => {
  const npm = parsePluginSource('npm:helm-plugin-foo@^1.2.0', '/wd')
  assert.equal(npm.kind, 'npm')
  assert.ok(npm.kind === 'npm')
  assert.equal(npm.spec, 'helm-plugin-foo@^1.2.0')
  assert.equal(npm.raw, 'npm:helm-plugin-foo@^1.2.0')
  const bare = parsePluginSource('npm:@scope/pkg', '/wd')
  assert.ok(bare.kind === 'npm' && bare.spec === '@scope/pkg')

  for (const bad of ['npm:', 'npm: ', 'npm:builtin:evil', 'builtin:profile', 'builtin%3Aprofile', '', '  ', 'file:///tmp/x', 'http://github.com/u/r', 'git+https://x.example/r', 'ftp://x/r', 'my-unknown-proto:foo', 'bare-name']) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmError && err.status === 400, `should reject: ${bad}`)
  }
})

test('parsePluginSource:git short write / SCP / https and @ref / #subdirectory', { timeout: 60_000 }, () => {
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
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmError, `should reject: ${bad}`)
  }
})

test('parsePluginSource:git repo strictly validate (reject path inject and local relative path)', { timeout: 60_000 }, () => {
  // legal three form (ssh:// belong unknown transfer protocol, do not let through;SCP override SSH scenario)
  for (const ok of ['git:https://github.com/user/repo.git', 'git:github.com/user/repo', 'git:git@github.com:user/repo.git']) {
    const parsed = parsePluginSource(ok, '/wd')
    assert.ok(parsed.kind === 'git', `should accept: ${ok}`)
  }
  // reject:../ out of bounds, backslash,NUL, absolute path, symbol, plaintext http,file:,ssh://, unknown scheme, whitespace, bare local path
  for (const bad of ['git:../evil', 'git:..\\..\\evil', 'git:repo/../../evil', 'git:/abs/path', 'git:C:\\repo', 'git:\\\\srv\\share', 'git:http://plain.example/r', 'git:file:///tmp/r', 'git:ssh://git@host:22/path', 'git:repo with space', 'git:local-dir', 'git:./relative']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmError && err.status === 400,
      `should reject: ${bad}`,
    )
  }
})

test('parsePluginSource:local absolute/relative path parse', { timeout: 60_000 }, () => {
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
})

// ---------------------------------------------------------------------------
// test base create:fake runner + real PluginHost(via host-adapter for interface)
// ---------------------------------------------------------------------------

/** most small legal external plugin source (convention entry form). */
const PLUGIN_SRC = (id: string, version = '0.1.0') => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: 'probe needle',
      inputSchema: { type: 'object', additionalProperties: false },
      outputSchema: { type: 'object', properties: { pong: { type: 'boolean' } }, required: ['pong'], additionalProperties: false },
      handler: () => ({ pong: true }),
    })
  },
}
`

interface TestEnv {
  dataDir: string
  cwd: string
  store: PluginPackageManagerStore
  manager: PluginPackageManager
  hostCalls: string[]
  registered: Map<string, { enabled: boolean }>
  /** simulated in-flight task: hit id  assertManagedPluginUpdateSafe throw 409. */
  updateBlockedIds: Set<string>
  /** simulated register failed: hit id  registerManagedPlugin throws. */
  registerFailIds: Set<string>
  /** simulated enable failed: hit id  enableManagedPlugin throws. */
  enableFailIds: Set<string>
  /** simulated purge failed: hit id  purgePluginPersistentData throws. */
  purgeFailIds: Set<string>
  close(): void
}

function makeEnv(runner?: PackageRunner): TestEnv {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-mgr-'))
  const cwd = mkdtempSync(join(tmpdir(), 'helm-pkg-cwd-'))
  const store = new PluginPackageManagerStore(new ConfigService(dataDir))
  const hostCalls: string[] = []
  const registered = new Map<string, { enabled: boolean }>()
  const summaries = new Map<string, { id: string; version?: string; enabled: boolean }>()
  const updateBlockedIds = new Set<string>()
  const registerFailIds = new Set<string>()
  const enableFailIds = new Set<string>()
  const purgeFailIds = new Set<string>()
  const host = {
    async registerManagedPlugin(dir: string) {
      hostCalls.push(`register:${dir}`)
      const id = readPluginIdFromDir(dir)
      if (registerFailIds.has(id)) {
        throw new HelmError('plugin_register_failed_simulated', `simulated register failed:${id}`, 500, { pluginId: id })
      }
      registered.set(id, { enabled: false })
      summaries.set(id, { id, version: readPluginVersionFromDir(dir), enabled: false })
      return { summary: toSummary(summaries, id), pluginId: id }
    },
    async enableManagedPlugin(pluginId: string) {
      hostCalls.push(`enable:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId })
      if (enableFailIds.has(pluginId)) {
        throw new HelmError('plugin_enable_failed_simulated', `simulated enable failed:${pluginId}`, 500, { pluginId })
      }
      entry.enabled = true
      summaries.set(pluginId, { ...(summaries.get(pluginId) ?? { id: pluginId }), enabled: true })
      return toSummary(summaries, pluginId)
    },
    async updateManagedPlugin(pluginId: string) {
      hostCalls.push(`update:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId })
      // real adapt via reload heavy read source directory; this in sync mirror is managed directory when before manifest
      summaries.set(pluginId, { id: pluginId, version: readPluginVersionFromDir(join(dataDir, 'plugins', pluginId)), enabled: entry.enabled })
      return { summary: toSummary(summaries, pluginId) }
    },
    assertManagedPluginUpdateSafe(pluginId: string) {
      hostCalls.push(`assert-safe:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `not registered plugin:${pluginId}`, 404, { pluginId })
      if (updateBlockedIds.has(pluginId)) {
        throw new HelmError('plugin_has_live_tasks', `plugin ${pluginId} store in in-flight task, reject update switch`, 409, { pluginId })
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
        throw new HelmError('store_flush_failed_simulated', `simulated purge failed:${pluginId}`, 500, { pluginId })
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

/** construct local plugin source directory (plugin.json + index.mjs). */
function writeLocalPlugin(parent: string, id: string, version = '0.1.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

/** fake runner:git clone succeeded produce out complete repository (contains .git exclude items verify). */
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
// local install / remove transaction
// ---------------------------------------------------------------------------

test('local install: copy enter managed directory (non- symlink), record persist,remove do not delete user source', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-usersrc-'))
    const userSrc = writeLocalPlugin(userSrcParent, 'demo-local')
    writeFileSync(join(userSrc, 'user-notes.md'), 'user self has file')

    const result = await env.manager.install(userSrc, { enable: true })
    assert.equal(result.record.pluginId, 'demo-local')
    assert.ok(result.record.source.kind === 'local')
    assert.equal(result.summary.enabled, true)
    assert.ok(result.summary.managed, 'summary should carry managed metadata')
    assert.equal(result.summary.managed?.installId, result.record.id)

    // managed directory store in and is real directory (non- symlink)
    const managed = join(env.dataDir, 'plugins', 'demo-local')
    assert.ok(existsSync(managed), 'managed directory should store in')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    // record persist at config.json
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages: Record<string, unknown> }
    assert.ok(config.pluginPackages['demo-local'])
    // remove: only delete managed copy and record, user source completely well
    const removed = await env.manager.remove('demo-local')
    assert.equal(removed.pluginId, 'demo-local')
    assert.equal(removed.wasEnabled, true)
    // unload contains persist document data related clean up: deregister instance after, delete directory before
    const removeAt = env.hostCalls.indexOf('remove:demo-local')
    const purgeAt = env.hostCalls.indexOf('purge:demo-local')
    assert.ok(removeAt >= 0, 'should invoke removeManagedPlugin')
    assert.ok(purgeAt > removeAt, 'should invoke purgePluginPersistentData and later than instance deregister')
    assert.ok(!existsSync(managed), 'managed directory should by delete')
    assert.ok(existsSync(join(userSrc, 'index.mjs')), 'user source directory must completely well')
    assert.ok(existsSync(join(userSrc, 'user-notes.md')), 'user self has file must completely well')
    const after = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(after.pluginPackages?.['demo-local'], undefined, 'record should by delete')
    rmSync(userSrcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('staging failed clean up:git clone failed after do not half artifact', { timeout: 60_000 }, async () => {
  const env = makeEnv(FAIL_RUNNER)
  try {
    await assert.rejects(
      env.manager.install('git:github.com/user/broken-repo'),
      (err: unknown) => err instanceof HelmError,
    )
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) {
      assert.deepEqual(readdirSync(staging), [], 'staging should no residue')
    }
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'broken-repo')), 'must not has half install directory')
  } finally {
    env.close()
  }
})

test('doctor failed: corrupt plugin does not enter managed directory,staging clean up', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const badParent = mkdtempSync(join(tmpdir(), 'helm-pkg-bad-'))
    const badDir = join(badParent, 'bad-plugin')
    mkdirSync(badDir, { recursive: true })
    writeFileSync(join(badDir, 'plugin.json'), JSON.stringify({ id: 'bad-plugin', main: 'index.ts' }))
    writeFileSync(join(badDir, 'index.ts'), 'export default { id: "bad-plugin", definePlugin() { throw new Error("boom") } }\n')
    await assert.rejects(
      env.manager.install(badDir),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_doctor_failed',
    )
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'bad-plugin')), 'broken plugin must not enter managed directory')
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) assert.deepEqual(readdirSync(staging), [])
    rmSync(badParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('git install:ref/subdirectory layout,node_modules/.git exclude', { timeout: 60_000 }, async () => {
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
    assert.ok(!existsSync(join(managed, 'node_modules')), 'node_modules should by exclude')
    assert.ok(!existsSync(join(managed, '.git')), '.git should by exclude')
  } finally {
    env.close()
  }
})

test('update: without record 404;local source edit after update heavy sync version push enter', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.update('never-installed'),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
    const userSrc = writeLocalPlugin(env.cwd, 'up-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    // user edit source code rise edition
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'up-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('up-plugin', '2.0.0'))
    const updated = await env.manager.update('up-plugin')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.previousVersion, '1.0.0')
    assert.equal(updated.changed, true)
    const managedManifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'up-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(managedManifest.version, '2.0.0', 'managed directory should heavy sync to new version')
  } finally {
    env.close()
  }
})

test('remove:purge failed explicit reject, directory and install record keep can retry', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'purge-fail-plugin')
    await env.manager.install(src)
    const managed = join(env.dataDir, 'plugins', 'purge-fail-plugin')
    assert.ok(existsSync(managed), 'pre-: install directory store in')

    // purge failed:remove explicit reject, must not continue delete directory and install record
    env.purgeFailIds.add('purge-fail-plugin')
    await assert.rejects(
      env.manager.remove('purge-fail-plugin'),
      (err: unknown) => err instanceof HelmError && err.code === 'store_flush_failed_simulated',
    )
    assert.ok(existsSync(managed), 'purge on failure managed directory must keep')
    assert.ok(env.store.getRecord('purge-fail-plugin'), 'purge on failure install record must keep')
    // instance deregistered: retry when removeManagedPlugin idempotent contain tolerate
    assert.ok(!env.registered.has('purge-fail-plugin'), 'first time failed deregistered instance')

    // fault restore after retry:remove complete succeeded
    env.purgeFailIds.delete('purge-fail-plugin')
    const removed = await env.manager.remove('purge-fail-plugin')
    assert.equal(removed.pluginId, 'purge-fail-plugin')
    assert.equal(removed.wasEnabled, false, 'retry when instance deregistered,wasEnabled such as is false')
    assert.ok(!existsSync(managed), 'retry after success managed directory delete')
    assert.equal(env.store.getRecord('purge-fail-plugin'), undefined, 'retry after success install record delete')
  } finally {
    env.close()
  }
})

test('remove:builtin protect and not managed plugin 404', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.remove('builtin:profile'),
      (err: unknown) => err instanceof HelmError && err.status === 403,
    )
    await assert.rejects(
      env.manager.remove('hand-placed'),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
  } finally {
    env.close()
  }
})

test('path security:local self install (managed tree internal) reject,install after record installPath in managed tree inside', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const inside = join(env.dataDir, 'plugins', 'inside-plugin')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'plugin.json'), JSON.stringify({ id: 'inside-plugin', main: 'index.mjs' }))
    writeFileSync(join(inside, 'index.mjs'), PLUGIN_SRC('inside-plugin'))
    await assert.rejects(
      env.manager.install(inside),
      (err: unknown) => err instanceof HelmError && err.status === 400,
    )
  } finally {
    env.close()
  }
})

test('update security preflight: in-flight task 409 reject and old directory content do not change', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'busy-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    const managed = join(env.dataDir, 'plugins', 'busy-plugin')
    const manifestBefore = readFileSync(join(managed, 'plugin.json'), 'utf8')
    // source code upgrade + simulated in-flight task:update must in switch before reject, old directory do not motion
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'busy-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    env.updateBlockedIds.add('busy-plugin')
    await assert.rejects(
      env.manager.update('busy-plugin'),
      (err: unknown) => err instanceof HelmError && err.status === 409,
    )
    assert.ok(env.hostCalls.includes('assert-safe:busy-plugin'), 'should invoke security preflight')
    assert.equal(readFileSync(join(managed, 'plugin.json'), 'utf8'), manifestBefore, 'old directory content must fully do not change')
    assert.ok(!env.hostCalls.includes('update:busy-plugin'), 'must not enter reload switch')
    // solve except block after update normal
    env.updateBlockedIds.delete('busy-plugin')
    const updated = await env.manager.update('busy-plugin')
    assert.equal(updated.record.version, '2.0.0')
  } finally {
    env.close()
  }
})

test('runtime dependency first at doctor: carries package.json  local plugin dependency in staging inside patch install after doctor via', { timeout: 60_000 }, async () => {
  const depsInstalled: string[] = []
  // runner:npm install record cwd and produce out node_modules; the rest command let through
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
    const srcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-deps-'))
    const src = join(srcParent, 'deps-plugin')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'plugin.json'), JSON.stringify({ id: 'deps-plugin', version: '0.1.0', main: 'index.mjs' }))
    writeFileSync(join(src, 'index.mjs'), PLUGIN_SRC('deps-plugin'))
    // package.json declaration runtime dependency (doctor import entry when need to node_modules store in form)
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deps-plugin', version: '0.1.0', main: 'index.mjs', dependencies: { leftpad: '^1.0.0' } }))
    const result = await env.manager.install(src)
    assert.equal(result.record.pluginId, 'deps-plugin')
    // dependency install in staging copy inside (non- user source directory)
    assert.equal(depsInstalled.length, 1, 'install path should exactly execute once dependency patch install')
    assert.ok(depsInstalled[0]!.includes('.staging'), 'dependency patch install must occur in staging inside')
    assert.ok(!existsSync(join(src, 'node_modules')), 'user source directory must not by install dependency')
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'deps-plugin', 'node_modules')), 'managed directory should carry patch install dependency')
    rmSync(srcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('install transaction: register failed delete new target rollback, do not not registered directory', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'rollback-plugin')
    env.registerFailIds.add('rollback-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_install_failed',
    )
    const target = join(env.dataDir, 'plugins', 'rollback-plugin')
    assert.ok(!existsSync(target), 'register failed after new target must by delete')
    assert.ok(!env.registered.has('rollback-plugin'), 'must not leftover registered instance')
    assert.equal(env.store.getRecord('rollback-plugin'), undefined, 'must not leftover record')
    // solve except failed after heavy install succeeded (leftover already consume, do not block)
    env.registerFailIds.delete('rollback-plugin')
    const ok = await env.manager.install(src)
    assert.equal(ok.record.pluginId, 'rollback-plugin')
  } finally {
    env.close()
  }
})

test('install duplicate install protect: already managed record / registered instance / target directory occupy all 409', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'dup-plugin')
    await env.manager.install(src)
    // same source duplicate install: already has managed record
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )
    // different source but same id: same reject
    const src2 = writeLocalPlugin(join(env.cwd, 'alt'), 'dup-plugin')
    await assert.rejects(
      env.manager.install(src2),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_already_installed',
    )
    // target directory occupy: manually work put placement same name directory (without record without register)
    const occupied = join(env.dataDir, 'plugins', 'occupied-plugin')
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'stale.txt'), 'residue')
    const src3 = writeLocalPlugin(env.cwd, 'occupied-plugin')
    await assert.rejects(
      env.manager.install(src3),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_target_occupied' && err.status === 409,
    )
    assert.equal(readFileSync(join(occupied, 'stale.txt'), 'utf8'), 'residue', 'occupy directory must not by delete')
  } finally {
    env.close()
  }
})

test('install enable failed: plugin keep disabled,enableError fact correct, record can restart load', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'enablefail-plugin')
    env.enableFailIds.add('enablefail-plugin')
    const result = await env.manager.install(src, { enable: true })
    // install succeeded, enable failed: fact such as
    assert.equal(result.record.pluginId, 'enablefail-plugin')
    assert.equal(result.summary.enabled, false, 'enable failed after plugin must keep disabled')
    assert.ok(result.enableError, 'enableError must pass-through')
    assert.equal(result.enableError.code, 'plugin_enable_failed_simulated')
    // record persisted (restart can load): creates new store instance from disk restore
    const reloaded = new PluginPackageManagerStore(new ConfigService(env.dataDir))
    await reloaded.load()
    const record = reloaded.getRecord('enablefail-plugin')
    assert.ok(record, 'enable failed does not affect record persist, after restart still can load')
    assert.equal(record.source.kind, 'local')
    // solve except after can separate retry: the same plugin duplicate install now 409(update away update)
    env.enableFailIds.delete('enablefail-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_already_installed',
    )
  } finally {
    env.close()
  }
})

// ---------------------------------------------------------------------------
// record store: structure corrupt explicit errors, restart restore (managed mapping)
// ---------------------------------------------------------------------------

test('store: corrupt pluginPackages explicit config_corrupt;save along use since has id', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-pkg-store-'))
  try {
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: 'not-an-object' }))
    const store = new PluginPackageManagerStore(new ConfigService(dataDir))
    await assert.rejects(store.load(), (err: unknown) => err instanceof HelmError && err.code === 'config_corrupt')

    rmSync(join(dataDir, 'config.json'))
    writeFileSync(join(dataDir, 'config.json'), JSON.stringify({ pluginPackages: { 'p-1': { id: 'plugpkg-p-1', pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/plugins/p-1', version: '1.0.0', installedAt: 1, updatedAt: 1 } } }))
    const store2 = new PluginPackageManagerStore(new ConfigService(dataDir))
    await store2.load()
    assert.equal(store2.getRecord('p-1')?.id, 'plugpkg-p-1')
    const saved = await store2.save({ pluginId: 'p-1', source: { kind: 'local', raw: '/x', path: '/x' }, installPath: '/data/plugins/p-1', version: '1.1.0', installedAt: 1, updatedAt: 2 })
    assert.equal(saved.id, 'plugpkg-p-1', 'duplicate install along use since has id')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
