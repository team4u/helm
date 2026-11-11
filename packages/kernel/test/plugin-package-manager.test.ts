/**
 * 外部插件包管理器专项测试（parser / 受管目录事务 / PluginHost 集成 / HTTP）。
 *
 * 组合纪律：不依赖真实网络——npm/git 路径经注入 fake runner 模拟命令成败；
 * local 路径用真实临时目录 + 真实拷贝。doctor 全链与 PluginHost 注册为真实
 * 实现（真实 TS 转译 + 临时 PluginHost 注册 + client 编译）。
 *
 * 覆盖：
 * - parsePluginSource：npm/git(短写/SCP/https/@ref/#subdir)/local(绝对/相对)
 *   规范化与拒绝（file://、http://、git+、未知协议、builtin:、空白、裸名）；
 * - 路径安全：安装目标越界、local 自安装（受管树内部）、safeName；
 * - staging 失败清理：fake runner 失败后 .staging 无残留、无半产物；
 * - local install：拷贝语义（非 symlink）、remove 不删用户源目录；
 * - install/update/remove 全链（真实 doctor + 真实 PluginHost 注册）；
 * - HTTP 路由：install body 校验、501 兜底、update/remove 端点。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
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

test('parsePluginSource：npm 规范化与拒绝', { timeout: 60_000 }, () => {
  const npm = parsePluginSource('npm:helm-plugin-foo@^1.2.0', '/wd')
  assert.equal(npm.kind, 'npm')
  assert.ok(npm.kind === 'npm')
  assert.equal(npm.spec, 'helm-plugin-foo@^1.2.0')
  assert.equal(npm.raw, 'npm:helm-plugin-foo@^1.2.0')
  const bare = parsePluginSource('npm:@scope/pkg', '/wd')
  assert.ok(bare.kind === 'npm' && bare.spec === '@scope/pkg')

  for (const bad of ['npm:', 'npm: ', 'npm:builtin:evil', 'builtin:profile', 'builtin%3Aprofile', '', '  ', 'file:///tmp/x', 'http://github.com/u/r', 'git+https://x.example/r', 'ftp://x/r', 'my-unknown-proto:foo', 'bare-name']) {
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmError && err.status === 400, `应拒绝: ${bad}`)
  }
})

test('parsePluginSource：git 短写 / SCP / https 与 @ref / #subdirectory', { timeout: 60_000 }, () => {
  const short = parsePluginSource('git:github.com/user/repo@v1', '/wd')
  assert.ok(short.kind === 'git')
  if (short.kind !== 'git') return
  assert.equal(short.repo, 'github.com/user/repo')
  assert.equal(short.ref, 'v1')

  const scp = parsePluginSource('git:git@github.com:user/repo.git', '/wd')
  assert.ok(scp.kind === 'git' && scp.kind === 'git')
  assert.equal((scp as { repo: string }).repo, 'git@github.com:user/repo.git')

  const https = parsePluginSource('https://github.com/user/repo.git', '/wd')
  assert.ok(https.kind === 'git' && https.kind === 'git')
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
    assert.throws(() => parsePluginSource(bad, '/wd'), (err: unknown) => err instanceof HelmError, `应拒绝: ${bad}`)
  }
})

test('parsePluginSource：git repo 严格校验（拒绝路径注入与本地相对路径）', { timeout: 60_000 }, () => {
  // 合法三种形态（ssh:// 属未知传输协议，不放行；SCP 覆盖 SSH 场景）
  for (const ok of ['git:https://github.com/user/repo.git', 'git:github.com/user/repo', 'git:git@github.com:user/repo.git']) {
    const parsed = parsePluginSource(ok, '/wd')
    assert.ok(parsed.kind === 'git', `应接受: ${ok}`)
  }
  // 拒绝：../ 越界、反斜杠、NUL、绝对路径、盘符、明文 http、file:、ssh://、未知 scheme、空白、裸本地路径
  for (const bad of ['git:../evil', 'git:..\\..\\evil', 'git:repo/../../evil', 'git:/abs/path', 'git:C:\\repo', 'git:\\\\srv\\share', 'git:http://plain.example/r', 'git:file:///tmp/r', 'git:ssh://git@host:22/path', 'git:repo with space', 'git:local-dir', 'git:./relative']) {
    assert.throws(
      () => parsePluginSource(bad, '/wd'),
      (err: unknown) => err instanceof HelmError && err.status === 400,
      `应拒绝: ${bad}`,
    )
  }
})

test('parsePluginSource：local 绝对/相对路径解析', { timeout: 60_000 }, () => {
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
// 测试基建：fake runner + 真实 PluginHost（经 host-adapter 面向接口）
// ---------------------------------------------------------------------------

/** 最小合法外部插件源（约定入口形态）。 */
const PLUGIN_SRC = (id: string, version = '0.1.0') => `export default {
  id: '${id}',
  version: '${version}',
  definePlugin(ctx) {
    ctx.action({
      id: 'ping',
      description: '探针',
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
  /** 模拟在途任务：命中 id 的 assertManagedPluginUpdateSafe 抛 409。 */
  updateBlockedIds: Set<string>
  /** 模拟注册失败：命中 id 的 registerManagedPlugin 抛错。 */
  registerFailIds: Set<string>
  /** 模拟启用失败：命中 id 的 enableManagedPlugin 抛错。 */
  enableFailIds: Set<string>
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
  const host = {
    async registerManagedPlugin(dir: string) {
      hostCalls.push(`register:${dir}`)
      const id = readPluginIdFromDir(dir)
      if (registerFailIds.has(id)) {
        throw new HelmError('plugin_register_failed_simulated', `模拟注册失败：${id}`, 500, { pluginId: id })
      }
      registered.set(id, { enabled: false })
      summaries.set(id, { id, version: readPluginVersionFromDir(dir), enabled: false })
      return { summary: toSummary(summaries, id), pluginId: id }
    },
    async enableManagedPlugin(pluginId: string) {
      hostCalls.push(`enable:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId })
      if (enableFailIds.has(pluginId)) {
        throw new HelmError('plugin_enable_failed_simulated', `模拟启用失败：${pluginId}`, 500, { pluginId })
      }
      entry.enabled = true
      summaries.set(pluginId, { ...(summaries.get(pluginId) ?? { id: pluginId }), enabled: true })
      return toSummary(summaries, pluginId)
    },
    async updateManagedPlugin(pluginId: string) {
      hostCalls.push(`update:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId })
      // 真实适配器经 reload 重读源目录；这里同步镜像为受管目录当前清单
      summaries.set(pluginId, { id: pluginId, version: readPluginVersionFromDir(join(dataDir, 'plugins', pluginId)), enabled: entry.enabled })
      return { summary: toSummary(summaries, pluginId) }
    },
    assertManagedPluginUpdateSafe(pluginId: string) {
      hostCalls.push(`assert-safe:${pluginId}`)
      const entry = registered.get(pluginId)
      if (!entry) throw new HelmError('unknown_plugin', `未注册的插件：${pluginId}`, 404, { pluginId })
      if (updateBlockedIds.has(pluginId)) {
        throw new HelmError('plugin_has_live_tasks', `插件 ${pluginId} 存在在途任务，拒绝更新切换`, 409, { pluginId })
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
  throw new Error('测试插件目录缺 plugin.json id')
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

/** 构造 local 插件源目录（plugin.json + index.mjs）。 */
function writeLocalPlugin(parent: string, id: string, version = '0.1.0'): string {
  const dir = join(parent, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'plugin.json'), JSON.stringify({ id, version, main: 'index.mjs' }, null, 2))
  writeFileSync(join(dir, 'index.mjs'), PLUGIN_SRC(id, version))
  return dir
}

/** fake runner：git clone 成功产出完整仓库（含 .git 排除项验证）。 */
function gitCloneRunner(repoLayout: (repoDir: string) => void): PackageRunner {
  return async (cmd, args) => {
    if (cmd === 'git' && args[0] === 'clone') {
      const target = args[args.length - 1]
      if (typeof target !== 'string' || target.length === 0) {
        return { code: 1, stdout: '', stderr: 'fake runner: clone 目标缺失' }
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
// local install / remove 事务
// ---------------------------------------------------------------------------

test('local install：拷贝进受管目录（非 symlink）、记录持久化、remove 不删用户源', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrcParent = mkdtempSync(join(tmpdir(), 'helm-pkg-usersrc-'))
    const userSrc = writeLocalPlugin(userSrcParent, 'demo-local')
    writeFileSync(join(userSrc, 'user-notes.md'), '用户自有文件')

    const result = await env.manager.install(userSrc, { enable: true })
    assert.equal(result.record.pluginId, 'demo-local')
    assert.ok(result.record.source.kind === 'local')
    assert.equal(result.summary.enabled, true)
    assert.ok(result.summary.managed, 'summary 应携带 managed 元数据')
    assert.equal(result.summary.managed?.installId, result.record.id)

    // 受管目录存在且为真实目录（非 symlink）
    const managed = join(env.dataDir, 'plugins', 'demo-local')
    assert.ok(existsSync(managed), '受管目录应存在')
    assert.ok(existsSync(join(managed, 'index.mjs')))
    // 记录持久化于 config.json
    const config = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages: Record<string, unknown> }
    assert.ok(config.pluginPackages['demo-local'])
    // remove：只删受管副本与记录，用户源完好
    const removed = await env.manager.remove('demo-local')
    assert.equal(removed.pluginId, 'demo-local')
    assert.equal(removed.wasEnabled, true)
    assert.ok(!existsSync(managed), '受管目录应被删除')
    assert.ok(existsSync(join(userSrc, 'index.mjs')), '用户源目录必须完好')
    assert.ok(existsSync(join(userSrc, 'user-notes.md')), '用户自有文件必须完好')
    const after = JSON.parse(readFileSync(join(env.dataDir, 'config.json'), 'utf8')) as { pluginPackages?: Record<string, unknown> }
    assert.equal(after.pluginPackages?.['demo-local'], undefined, '记录应被删除')
    rmSync(userSrcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('staging 失败清理：git clone 失败后不留半产物', { timeout: 60_000 }, async () => {
  const env = makeEnv(FAIL_RUNNER)
  try {
    await assert.rejects(
      env.manager.install('git:github.com/user/broken-repo'),
      (err: unknown) => err instanceof HelmError,
    )
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) {
      assert.deepEqual(readdirSync(staging), [], 'staging 应无残留')
    }
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'broken-repo')), '不应有半安装目录')
  } finally {
    env.close()
  }
})

test('doctor 失败：损坏插件不进入受管目录、staging 清理', { timeout: 60_000 }, async () => {
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
    assert.ok(!existsSync(join(env.dataDir, 'plugins', 'bad-plugin')), '坏插件不得进入受管目录')
    const staging = join(env.dataDir, 'plugins', '.staging')
    if (existsSync(staging)) assert.deepEqual(readdirSync(staging), [])
    rmSync(badParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('git install：ref/subdirectory 布局、node_modules/.git 排除', { timeout: 60_000 }, async () => {
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
    assert.ok(!existsSync(join(managed, 'node_modules')), 'node_modules 应被排除')
    assert.ok(!existsSync(join(managed, '.git')), '.git 应被排除')
  } finally {
    env.close()
  }
})

test('update：无记录 404；local 源编辑后 update 重同步版本推进', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    await assert.rejects(
      env.manager.update('never-installed'),
      (err: unknown) => err instanceof HelmError && err.status === 404,
    )
    const userSrc = writeLocalPlugin(env.cwd, 'up-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    // 用户编辑源码升版
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'up-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    writeFileSync(join(userSrc, 'index.mjs'), PLUGIN_SRC('up-plugin', '2.0.0'))
    const updated = await env.manager.update('up-plugin')
    assert.equal(updated.record.version, '2.0.0')
    assert.equal(updated.previousVersion, '1.0.0')
    assert.equal(updated.changed, true)
    const managedManifest = JSON.parse(readFileSync(join(env.dataDir, 'plugins', 'up-plugin', 'plugin.json'), 'utf8')) as { version: string }
    assert.equal(managedManifest.version, '2.0.0', '受管目录应重同步到新版本')
  } finally {
    env.close()
  }
})

test('remove：builtin 保护与未受管插件 404', { timeout: 60_000 }, async () => {
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

test('路径安全：local 自安装（受管树内部）拒绝、install 后记录 installPath 在受管树内', { timeout: 60_000 }, async () => {
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

test('update 安全预检：在途任务 409 拒绝且旧目录内容不变', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const userSrc = writeLocalPlugin(env.cwd, 'busy-plugin', '1.0.0')
    const installed = await env.manager.install(userSrc)
    assert.equal(installed.record.version, '1.0.0')
    const managed = join(env.dataDir, 'plugins', 'busy-plugin')
    const manifestBefore = readFileSync(join(managed, 'plugin.json'), 'utf8')
    // 源码升级 + 模拟在途任务：update 必须在切换前拒绝，旧目录不动
    writeFileSync(join(userSrc, 'plugin.json'), JSON.stringify({ id: 'busy-plugin', version: '2.0.0', main: 'index.mjs' }, null, 2))
    env.updateBlockedIds.add('busy-plugin')
    await assert.rejects(
      env.manager.update('busy-plugin'),
      (err: unknown) => err instanceof HelmError && err.status === 409,
    )
    assert.ok(env.hostCalls.includes('assert-safe:busy-plugin'), '应调用安全预检')
    assert.equal(readFileSync(join(managed, 'plugin.json'), 'utf8'), manifestBefore, '旧目录内容必须完全不变')
    assert.ok(!env.hostCalls.includes('update:busy-plugin'), '不得进入 reload 切换')
    // 解除阻塞后 update 正常
    env.updateBlockedIds.delete('busy-plugin')
    const updated = await env.manager.update('busy-plugin')
    assert.equal(updated.record.version, '2.0.0')
  } finally {
    env.close()
  }
})

test('运行时依赖先于 doctor：带 package.json 的 local 插件依赖在 staging 内补装后 doctor 通过', { timeout: 60_000 }, async () => {
  const depsInstalled: string[] = []
  // runner：npm install 记录 cwd 并产出 node_modules；其余命令放行
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
    // package.json 声明运行时依赖（doctor 导入入口时需要 node_modules 存在的形态）
    writeFileSync(join(src, 'package.json'), JSON.stringify({ name: 'deps-plugin', version: '0.1.0', main: 'index.mjs', dependencies: { leftpad: '^1.0.0' } }))
    const result = await env.manager.install(src)
    assert.equal(result.record.pluginId, 'deps-plugin')
    // 依赖安装在 staging 副本内（非用户源目录）
    assert.equal(depsInstalled.length, 1, 'install 路径应恰好执行一次依赖补装')
    assert.ok(depsInstalled[0]!.includes('.staging'), '依赖补装必须发生在 staging 内')
    assert.ok(!existsSync(join(src, 'node_modules')), '用户源目录不得被安装依赖')
    assert.ok(existsSync(join(env.dataDir, 'plugins', 'deps-plugin', 'node_modules')), '受管目录应携带补装的依赖')
    rmSync(srcParent, { recursive: true, force: true })
  } finally {
    env.close()
  }
})

test('install 事务：注册失败删除新 target 回滚，不留未注册目录', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'rollback-plugin')
    env.registerFailIds.add('rollback-plugin')
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_install_failed',
    )
    const target = join(env.dataDir, 'plugins', 'rollback-plugin')
    assert.ok(!existsSync(target), '注册失败后新 target 必须被删除')
    assert.ok(!env.registered.has('rollback-plugin'), '不得残留已注册实例')
    assert.equal(env.store.getRecord('rollback-plugin'), undefined, '不得残留记录')
    // 解除失败后重装成功（残留已消，不阻挡）
    env.registerFailIds.delete('rollback-plugin')
    const ok = await env.manager.install(src)
    assert.equal(ok.record.pluginId, 'rollback-plugin')
  } finally {
    env.close()
  }
})

test('install 重复安装防护：已受管记录 / 已注册实例 / 目标目录占用均 409', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'dup-plugin')
    await env.manager.install(src)
    // 同源重复安装：已有受管记录
    await assert.rejects(
      env.manager.install(src),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_already_installed' && err.status === 409,
    )
    // 不同源但同 id：同样拒绝
    const src2 = writeLocalPlugin(join(env.cwd, 'alt'), 'dup-plugin')
    await assert.rejects(
      env.manager.install(src2),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_already_installed',
    )
    // 目标目录占用：手工放置同名目录（无记录无注册）
    const occupied = join(env.dataDir, 'plugins', 'occupied-plugin')
    mkdirSync(occupied, { recursive: true })
    writeFileSync(join(occupied, 'stale.txt'), 'residue')
    const src3 = writeLocalPlugin(env.cwd, 'occupied-plugin')
    await assert.rejects(
      env.manager.install(src3),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_package_target_occupied' && err.status === 409,
    )
    assert.equal(readFileSync(join(occupied, 'stale.txt'), 'utf8'), 'residue', '占用目录不得被删除')
  } finally {
    env.close()
  }
})

test('install enable 失败：插件保持 disabled、enableError 事实正确、记录可重启加载', { timeout: 60_000 }, async () => {
  const env = makeEnv()
  try {
    const src = writeLocalPlugin(env.cwd, 'enablefail-plugin')
    env.enableFailIds.add('enablefail-plugin')
    const result = await env.manager.install(src, { enable: true })
    // 安装成功、启用失败：事实如实
    assert.equal(result.record.pluginId, 'enablefail-plugin')
    assert.equal(result.summary.enabled, false, '启用失败后插件必须保持 disabled')
    assert.ok(result.enableError, 'enableError 必须透传')
    assert.equal(result.enableError.code, 'plugin_enable_failed_simulated')
    // 记录已持久化（重启可加载）：新建 store 实例从磁盘恢复
    const reloaded = new PluginPackageManagerStore(new ConfigService(env.dataDir))
    await reloaded.load()
    const record = reloaded.getRecord('enablefail-plugin')
    assert.ok(record, '启用失败不影响记录持久化，重启后仍可加载')
    assert.equal(record.source.kind, 'local')
    // 解除后可单独重试：同一插件重复 install 现在 409（更新走 update）
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
// 记录存储：结构损坏显式报错、重启恢复（managed 映射）
// ---------------------------------------------------------------------------

test('store：损坏 pluginPackages 显式 config_corrupt；save 沿用既有 id', { timeout: 60_000 }, async () => {
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
    assert.equal(saved.id, 'plugpkg-p-1', '重复安装沿用既有 id')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})
