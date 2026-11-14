/**
 * scripts/check-changed.mjs 与 scripts/check-test-hygiene.mjs（含 scripts/lib/* 库）的单元测试。
 *
 * 覆盖：变更集收集（多 commit + 工作区脏 + 未跟踪 + 删除 + rename + 空格路径 + 基线解析
 * 优先级与无基线拒绝）、受影响包反向闭包与根级全档触发、hygiene AST 分析（默认/具名/
 * 别名/命名空间导入、多行 options、共享 const 选项、describe timeout 继承、skip 理由、
 * todo 豁免、HELM_TEST_SUITE_TIMEOUT_MS 赋值）、CLI 退出码透传（含执行失败不吞码）、
 * 子进程树信号转发不留孤儿，以及 PACKAGE_TIERS 与 test-suites.mjs SUITES 的镜像锁定。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as ts from 'typescript'
import {
  GitChangeError,
  collectChangedFiles,
  parseNameStatusZ,
  resolveBaseline,
} from '../../../scripts/lib/git-changes.mjs'
import {
  PACKAGE_TIERS,
  classifyChange,
  computeAffectedPackages,
  loadWorkspacePackages,
  planCheckCommands,
  testFilesOfPackage,
} from '../../../scripts/lib/workspace-meta.mjs'
import { analyzeTestSource } from '../../../scripts/lib/test-hygiene.mjs'
import { resolvePackageManagerInvoke, runManagedCommand } from '../../../scripts/lib/spawn-checked.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const scriptsDir = path.join(repoRoot, 'scripts')

// ---------------------------------------------------------------- git 夹具

function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `git ${args.join(' ')} 失败: ${res.stderr}`)
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

/** 多 commit + 工作区脏（暂存/未暂存）+ 未跟踪 + 删除 + rename + 空格路径的完整夹具。 */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'helm-check-changed-'))
  git(dir, 'init', '-b', 'main')
  write(dir, 'base.txt', 'v1')
  write(dir, 'space dir/f.txt', 'v1')
  write(dir, 'src/one.ts', 'export const one = 1')
  write(dir, 'old.txt', 'bye')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c0')
  write(dir, 'base.txt', 'v2')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'c1')
  git(dir, 'mv', 'src/one.ts', 'src/two renamed.ts')
  git(dir, 'rm', '-q', 'old.txt')
  git(dir, 'commit', '-m', 'c2: rename + delete')
  // 工作区：未暂存修改 + 暂存新增 + 未跟踪，全部含空格路径。
  write(dir, 'space dir/f.txt', 'v2')
  write(dir, 'staged file.ts', 's')
  git(dir, 'add', 'staged file.ts')
  write(dir, 'untracked file.ts', 'u')
  return dir
}

// ---------------------------------------------------------------- 变更集收集

test('变更集：多 commit ∪ 工作区 ∪ 未跟踪，rename 双侧 + 删除 + 空格路径全纳入', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    const { baseline, files } = collectChangedFiles({ base: 'HEAD~2', cwd: dir })
    assert.equal(baseline.kind, 'explicit')
    assert.equal(baseline.ref, 'HEAD~2')
    const byPath = new Map(files.map((f) => [f.path, f]))
    // committed（两个 commit 累计）：修改、rename 新旧两侧、删除。
    assert.equal(byPath.get('base.txt')?.origin, 'committed')
    assert.ok(byPath.has('src/one.ts'), 'rename 的旧路径必须纳入')
    assert.ok(byPath.has('src/two renamed.ts'), 'rename 的新路径（含空格）必须纳入')
    assert.ok(byPath.get('src/two renamed.ts')?.status.startsWith('R'), 'rename 状态以 R 开头')
    assert.equal(byPath.get('old.txt')?.origin, 'committed')
    assert.equal(byPath.get('old.txt')?.status, 'D')
    // 工作区：暂存与未暂存同源 worktree。
    assert.equal(byPath.get('space dir/f.txt')?.origin, 'worktree')
    assert.equal(byPath.get('staged file.ts')?.origin, 'worktree')
    // 未跟踪。
    assert.equal(byPath.get('untracked file.ts')?.origin, 'untracked')
    assert.equal(files.filter((f) => f.origin === 'committed').length, 4)
    assert.equal(files.filter((f) => f.origin === 'untracked').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('基线解析：upstream 优先于 origin/HEAD；都无时显式报错而非静默 HEAD~1', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    // 初始无 remote：默认基线不可得 → resolveBaseline 如实返回 none，collect 显式报错并指引用 --base。
    assert.deepEqual(resolveBaseline({ cwd: dir }), { kind: 'none', ref: null, mergeBase: null })
    assert.throws(() => collectChangedFiles({ cwd: dir }), (e: unknown) => {
      assert.ok(e instanceof GitChangeError)
      assert.ok(e.message.includes('--base'), '错误信息必须指引用 --base')
      return true
    })

    // 配置 upstream（指向 c1）后：merge-base = c1，c1..HEAD 的 c2 变更纳入，c1 自身不算。
    const c1 = spawnSync('git', ['rev-parse', 'HEAD~1'], { cwd: dir, encoding: 'utf8' })
    git(dir, 'update-ref', 'refs/remotes/origin/main', (c1.stdout ?? '').trim())
    git(dir, 'config', 'remote.origin.url', 'https://example.com/probe.git')
    git(dir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
    git(dir, 'config', 'branch.main.remote', 'origin')
    git(dir, 'config', 'branch.main.merge', 'refs/heads/main')
    const { baseline, files } = collectChangedFiles({ cwd: dir })
    assert.equal(baseline.kind, 'upstream')
    assert.equal(baseline.ref, 'refs/remotes/origin/main')
    assert.equal(baseline.mergeBase, (c1.stdout ?? '').trim())
    const paths = files.map((f) => f.path)
    assert.ok(!paths.includes('base.txt'), 'merge-base 之前的提交变更不纳入')
    assert.ok(paths.includes('old.txt'), 'merge-base 之后的删除纳入')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseNameStatusZ：-z 流按 NUL 切分，rename/copy 展开新旧双侧', { timeout: 60_000 }, () => {
  const raw = ['M\0a.txt\0', 'R100\0new dir/two.ts\0old dir/one.ts\0', 'D\0gone.ts\0'].join('')
  assert.deepEqual(parseNameStatusZ(raw), [
    { path: 'a.txt', status: 'M' },
    { path: 'new dir/two.ts', status: 'R100' },
    { path: 'old dir/one.ts', status: 'R100' },
    { path: 'gone.ts', status: 'D' },
  ])
})

// ---------------------------------------------------------------- 受影响包选集

/** 与仓库真实 workspace 图同构的合成包图（含传递依赖链）。 */
const SYNTH_PKGS = [
  { name: '@helm/protocol', dir: 'protocol', workspaceDeps: [] },
  { name: '@helm/kernel', dir: 'kernel', workspaceDeps: ['@helm/protocol', '@helm/node'] },
  { name: '@helm/node', dir: 'node', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/cli', dir: 'cli', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/web', dir: 'web', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/payload', dir: 'payload', workspaceDeps: ['@helm/cli', '@helm/kernel', '@helm/web'] },
  { name: '@helm/desktop', dir: 'desktop', workspaceDeps: [] },
]

test('依赖闭包：protocol 改动扩散到全部消费方；node 改动经 kernel 传递到 payload', { timeout: 60_000 }, () => {
  const r1 = computeAffectedPackages(['packages/protocol/src/index.ts'], SYNTH_PKGS)
  assert.deepEqual([...r1.affected].sort(), ['cli', 'kernel', 'node', 'payload', 'protocol', 'web'])

  const r2 = computeAffectedPackages(['packages/node/src/cli.ts'], SYNTH_PKGS)
  assert.deepEqual([...r2.affected].sort(), ['kernel', 'node', 'payload'])

  const r3 = computeAffectedPackages(['packages/desktop/src/main.ts'], SYNTH_PKGS)
  assert.deepEqual([...r3.affected], ['desktop'])
})

test('纯测试文件改动只选本包；包内非测试文件（含 test 助手）走闭包；根级触发全档', { timeout: 60_000 }, () => {
  const t1 = computeAffectedPackages(['packages/kernel/test/foo.test.ts'], SYNTH_PKGS)
  assert.deepEqual([...t1.affected], ['kernel'])
  assert.equal(t1.fullTier, false)

  // test/ 下非 *.test.ts 的助手文件按 source 处理（保守闭包）。
  const t2 = computeAffectedPackages(['packages/kernel/test/helpers.ts'], SYNTH_PKGS)
  assert.deepEqual([...t2.affected].sort(), ['kernel', 'payload'])

  const t3 = computeAffectedPackages(['pnpm-lock.yaml'], SYNTH_PKGS)
  assert.equal(t3.fullTier, true)
  assert.equal(t3.affected.size, 7)

  // 单改快速门自身实现（scripts 源码）也触发全档，不允许「无检查通过」。
  const t5 = computeAffectedPackages(['scripts/lib/spawn-checked.mjs'], SYNTH_PKGS)
  assert.equal(t5.fullTier, true)
  assert.equal(t5.affected.size, 7)

  const t4 = computeAffectedPackages(['docs/foo.md', 'AGENTS.md'], SYNTH_PKGS)
  assert.equal(t4.affected.size, 0)
  assert.deepEqual(t4.outside, ['AGENTS.md', 'docs/foo.md'])
})

test('classifyChange：文件分类与边界（scripts 源码全档，纯文档不触发）', { timeout: 60_000 }, () => {
  assert.deepEqual(classifyChange('packages/kernel/src/a.ts'), { pkg: 'kernel', kind: 'source' })
  assert.deepEqual(classifyChange('packages/kernel/test/a.test.ts'), { pkg: 'kernel', kind: 'test' })
  assert.deepEqual(classifyChange('packages/web/test/a.test.tsx'), { pkg: 'web', kind: 'test' })
  assert.deepEqual(classifyChange('packages/kernel/tsconfig.json'), { pkg: 'kernel', kind: 'source' })
  assert.deepEqual(classifyChange('docs/x.md'), { pkg: null, kind: 'outside' })
  assert.deepEqual(classifyChange('scripts/run-tests.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/check-changed.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/lib/git-changes.mjs'), { pkg: null, kind: 'root-trigger' })
  assert.deepEqual(classifyChange('scripts/README-herdr-smoke.md'), { pkg: null, kind: 'outside' })
  assert.deepEqual(classifyChange('tsconfig.check.json'), { pkg: null, kind: 'root-trigger' })
})

test('PACKAGE_TIERS 与 test-suites.mjs SUITES 镜像锁定；全仓包都有档位', { timeout: 60_000 }, () => {
  const src = readFileSync(path.join(scriptsDir, 'test-suites.mjs'), 'utf8')
  const unitMatch = /unit:\s*\[([^\]]*)\]/.exec(src)
  const integrationMatch = /integration:\s*\[([^\]]*)\]/.exec(src)
  assert.ok(unitMatch && integrationMatch, 'test-suites.mjs SUITES 结构变化，请同步解析逻辑')
  const names = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  const expected: Record<string, string> = {}
  for (const n of names(unitMatch?.[1] ?? '')) expected[n] = 'unit'
  for (const n of names(integrationMatch?.[1] ?? '')) expected[n] = 'integration'
  assert.deepEqual(PACKAGE_TIERS, expected, '改 test-suites.mjs 分档必须同步 workspace-meta.mjs 的 PACKAGE_TIERS')

  for (const p of loadWorkspacePackages(repoRoot)) {
    assert.ok(PACKAGE_TIERS[p.dir], `新包 ${p.dir} 未登记档位，请同步 PACKAGE_TIERS 与 SUITES`)
  }
  assert.ok(testFilesOfPackage(repoRoot, 'cli').some((f) => f.endsWith('.test.ts')))
})

test('planCheckCommands：desktop 选中时插入 dist build 前置；顺序固定；空选集无命令', { timeout: 60_000 }, () => {
  const pm = { cmd: 'node', args: ['/pnpm/bin/pnpm.cjs'] }
  const withDesktop = planCheckCommands({
    affectedDirs: ['desktop', 'kernel'],
    testFiles: ['packages/desktop/test/bootstrap.test.ts', 'packages/kernel/test/http.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withDesktop.length, 3)
  assert.deepEqual(withDesktop[0]?.args, ['/pnpm/bin/pnpm.cjs', 'typecheck'])
  assert.deepEqual(withDesktop[1]?.args, ['/pnpm/bin/pnpm.cjs', '--filter', '@helm/desktop', 'run', 'build'])
  assert.match(withDesktop[1]?.label ?? '', /desktop/)
  assert.equal(withDesktop[2]?.args[0], '/repo/scripts/run-tests.mjs')
  assert.equal(withDesktop[2]?.args.length, 3)

  const withoutDesktop = planCheckCommands({
    affectedDirs: ['cli'],
    testFiles: ['packages/cli/test/cli.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withoutDesktop.length, 2)
  assert.ok(withoutDesktop.every((c) => !c.args.includes('@helm/desktop')))

  const none = planCheckCommands({ affectedDirs: [], testFiles: [], pm, execPath: '/node', repoRoot: '/repo' })
  assert.equal(none.length, 0)
})

// ---------------------------------------------------------------- hygiene AST

function rulesOf(source: string): string[] {
  return analyzeTestSource(ts, 'sample.test.ts', source).violations.map((v) => v.rule)
}

test('hygiene：具名/默认/别名/命名空间导入的 timeout 判定（含多行 options）', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('a', { timeout: 60_000 }, () => {})
test('b', () => {})`), ['timeout-missing'])

  assert.deepEqual(rulesOf(`import { it } from 'node:test'
it('a', () => {})`), ['timeout-missing'])

  // as 别名：源名是 test/it 才算受管调用。
  assert.deepEqual(rulesOf(`import { test as it, describe as d } from 'node:test'
it('ok', { timeout: 60_000 }, () => {})
it('bad', () => {})`), ['timeout-missing'])

  // 命名空间导入。
  assert.deepEqual(rulesOf(`import * as nt from 'node:test'
nt.test('ok', { timeout: 60_000 }, () => {})
nt.it('bad', () => {})`), ['timeout-missing'])

  // 多行 options：靠 AST 而非行内正则。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('multi', {
  timeout: 60_000,
}, async () => {})`), [])

  // 共享 const 选项对象（含 as const 解包）。
  assert.deepEqual(rulesOf(`import test from 'node:test'
const opts = { timeout: 60_000 } as const
test('shared', opts, () => {})`), [])
})

test('hygiene：describe timeout 按 node:test 语义被子测试继承', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', { timeout: 60_000 }, () => {
  it('inherits', () => {})
})`), [])
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', () => {
  it('no-timeout', () => {})
})`), ['timeout-missing'])
})

test('hygiene：skip 必附理由；恒定 skip 豁免 timeout；条件 skip 仍需 timeout', { timeout: 60_000 }, () => {
  // { skip: true }：无理由违规；恒定 skip 不再叠 timeout 违规。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s', { timeout: 60_000, skip: true }, () => {})`), ['skip-without-reason'])
  // 条件 skip（理由 : false）：会执行 → 缺 timeout 违规。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c', { skip: process.platform === 'win32' ? 'Windows 不适用' : false }, () => {})`), [
    'timeout-missing',
  ])
  // 条件 skip 且带 timeout：干净。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c2', { timeout: 60_000, skip: process.env.X !== '1' ? '需 X=1' : false }, () => {})`), [])
  // 恒定 skip 带理由：不执行，无需 timeout。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s2', { skip: '环境不具备' }, () => {})`), [])
  // test.skip 简写未附理由。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s3', () => {})`), ['skip-without-reason'])
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s4', { skip: '理由' }, () => {})`), [])
  // 无法静态确认的 skip 值如实报违规。
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s5', { timeout: 60_000, skip: someFlag }, () => {})`), ['skip-without-reason'])
})

test('hygiene：todo 豁免；t.test 子测试仅计数；env 赋值违规', { timeout: 60_000 }, () => {
  const report = analyzeTestSource(
    ts,
    'sample.test.ts',
    `import test from 'node:test'
test.todo('t')
test('outer', { timeout: 60_000 }, async (t) => {
  await t.test('sub', () => {})
})
process.env.HELM_TEST_SUITE_TIMEOUT_MS = '999'`,
  )
  assert.deepEqual(report.violations.map((v) => v.rule), ['suite-timeout-env'])
  assert.equal(report.stats.todoCalls, 1)
  assert.equal(report.stats.subtestCalls, 1)
  assert.equal(report.stats.testCalls, 1)
})

// ---------------------------------------------------------------- CLI 退出码

function runScript(script: string, args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

test('check-test-hygiene CLI：违规文件退出 1，干净文件退出 0，未知参数退出 2', { timeout: 60_000 }, () => {
  // 夹具必须位于仓库内（--files 拒绝仓库外路径）；node_modules 已被 gitignore，不污染工作区。
  const dir = path.join(repoRoot, 'node_modules', '.helm-hygiene-cli-fixtures')
  mkdirSync(dir, { recursive: true })
  try {
    const bad = path.join(dir, 'bad.test.ts')
    writeFileSync(bad, "import test from 'node:test'\ntest('x', () => {})\n")
    const good = path.join(dir, 'good.test.ts')
    writeFileSync(good, "import test from 'node:test'\ntest('x', { timeout: 60_000 }, () => {})\n")

    const r1 = runScript('check-test-hygiene.mjs', ['--files', bad])
    assert.equal(r1.status, 1, `stderr: ${r1.stderr}`)
    assert.ok(r1.stderr.includes('[timeout-missing]'), '违规明细必须打印规则与位置')

    const r2 = runScript('check-test-hygiene.mjs', ['--files', good])
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)

    const r3 = runScript('check-test-hygiene.mjs', ['--wat'])
    assert.equal(r3.status, 2)
    assert.ok(r3.stderr.includes('未知参数'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-changed CLI：--base 引用不存在退出 2；--list 打印选集不执行命令', { timeout: 60_000 }, () => {
  const r1 = runScript('check-changed.mjs', ['--base', 'no-such-ref', '--list'])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('--base'))

  const r2 = runScript('check-changed.mjs', ['--list', '--base', 'HEAD'])
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('基线'), '必须明确报告所选基线')
  assert.ok(r2.stderr.includes('将执行'), '必须打印将执行的命令供复核')
  assert.ok(r2.stderr.includes('未执行任何命令'), '--list 模式绝不执行命令')

  const r3 = runScript('check-changed.mjs', ['--bogus'])
  assert.equal(r3.status, 2)
})

test('check-test-hygiene CLI：仓库外路径与空 --files 均拒绝退出 2，不静默改查其他仓库或全仓', { timeout: 60_000 }, () => {
  const outside = path.join(tmpdir(), 'helm-outside-' + Date.now(), 'x.test.ts')
  const r1 = runScript('check-test-hygiene.mjs', ['--files', outside])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('拒绝仓库外路径'), '必须显式拒绝而非静默检查其他仓库')

  const r2 = runScript('check-test-hygiene.mjs', ['--files'])
  assert.equal(r2.status, 2, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('--files 需要至少一个'), '空 --files 必须报用法错误而非退回全仓')

  // 开头 -- 分隔符（pnpm 透传形态）：与显式仓库内文件等价。
  const r3 = runScript('check-test-hygiene.mjs', ['--', '--files', 'packages/cli/test/cli.test.ts'])
  assert.equal(r3.status, 0, `stderr: ${r3.stderr}`)
})

test('pnpm 真调用：pnpm check:changed -- --base HEAD --list 透传开头 -- 分隔符', { timeout: 60_000 }, () => {
  const pm = resolvePackageManagerInvoke(process.env)
  const res = spawnSync(
    pm.cmd,
    [...pm.args, 'check:changed', '--', '--base', 'HEAD', '--list'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  )
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.ok(res.stderr.includes('基线'), `必须报告基线：${res.stderr.slice(0, 400)}`)
  assert.ok(res.stderr.includes('未执行任何命令'), '--list 绝不执行命令')
})

test('resolvePackageManagerInvoke：npm_execpath 校验后缀后用当前 Node 运行；异常值回退 PATH pnpm', { timeout: 60_000 }, () => {
  // 注：真实 Windows .cmd 行为无法在本 Linux 环境验证；本测试锁定平台无关的 argv 构造逻辑，
  // Windows 下的实际效果由上述 pnpm 真调用 smoke 同路径覆盖（npm_execpath 分支）。
  assert.deepEqual(resolvePackageManagerInvoke({}), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.cjs' }), {
    cmd: process.execPath,
    args: ['/x/pnpm/bin/pnpm.cjs'],
  })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.mjs' }).args, [
    '/x/pnpm/bin/pnpm.mjs',
  ])
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm/bin/pnpm.js' }).args, [
    '/x/pnpm/bin/pnpm.js',
  ])
  // 非脚本后缀（可执行 shim / 恶意值）不盲信，回退。
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/evil.sh' }), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '' }), { cmd: 'pnpm', args: [] })
})

test('runManagedCommand：失败退出码原样透传；命令不存在报 127', { timeout: 60_000 }, async () => {
  const code = await runManagedCommand(
    { cmd: process.execPath, args: ['-e', 'process.exit(3)'], label: 't-exit-3' },
    { cwd: repoRoot },
  )
  assert.equal(code, 3)
  const missing = await runManagedCommand(
    { cmd: 'helm-no-such-cmd-xyz', args: [], label: 't-missing' },
    { cwd: repoRoot },
  )
  assert.equal(missing, 127)
})

/** 进程存活判定：ESRCH 即止；Linux 下僵尸（Z 状态）视为已终止，不算存活孤儿。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      const state = /\) (\w)/.exec(stat)?.[1]
      if (state === 'Z') return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * 孙进程安装空 SIGTERM/SIGINT handler（什么都不做）并写 PID marker，验证包装器：
 * leader 退出后仍继续 owned 组存活性轮询 → 宽限后 SIGKILL 升级 → 最终整组消失、
 * 按信号码退出、重复信号幂等。注入短 timings 让升级在百毫秒级发生。
 */
async function runSignalTreeTest(signal: 'SIGTERM' | 'SIGINT', expectedCode: number): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), 'helm-orphan-'))
  const marker = path.join(dir, 'grandchild.pid')
  const childScript = path.join(dir, 'child.mjs')
  const grandchildCode =
    `process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});` +
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
    `setInterval(() => {}, 1000);`
  writeFileSync(
    childScript,
    `import { spawn } from 'node:child_process'
const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
if (g.pid == null) process.exit(9)
setInterval(() => {}, 1000)
`,
  )
  const wrapperCode = `
const m = await import(${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'spawn-checked.mjs')).href)})
const code = await m.runManagedCommand(
  { cmd: process.execPath, args: [${JSON.stringify(childScript)}], label: 't-tree' },
  { cwd: ${JSON.stringify(dir)}, timings: { pollMs: 50, cleanupGraceMs: 800, lastResortMs: 8000 } },
)
process.exit(code)
`
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperCode], {
    cwd: dir,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  wrapper.stderr?.on('data', (d) => {
    stderr += String(d)
  })

  const deadline = Date.now() + 15_000
  while (!existsSync(marker) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  assert.ok(existsSync(marker), '孙进程 PID marker 未出现')
  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

  wrapper.kill(signal)
  wrapper.kill(signal) // 重复信号：幂等，不得重复建定时器或重复日志
  const wrapperExit = await new Promise<number | null>((resolve) => {
    wrapper.on('exit', (c, s) => resolve(c ?? (s === signal ? expectedCode : -1)))
  })
  assert.equal(wrapperExit, expectedCode, `被 ${signal} 终止必须按 128+signal 退出；stderr: ${stderr}`)
  const signalLogs = stderr.split(`收到 ${signal}`).length - 1
  assert.equal(signalLogs, 1, `重复信号只允许一条终止日志；stderr: ${stderr}`)

  // 忽略信号的孙进程最终必须被 SIGKILL 升级收割：不留任何存活孤儿。
  const gone = await new Promise<boolean>((resolve) => {
    const start = Date.now()
    const poll = () => {
      if (!pidAlive(grandchildPid)) resolve(true)
      else if (Date.now() - start > 12_000) resolve(false)
      else setTimeout(poll, 100)
    }
    poll()
  })
  assert.ok(gone, `忽略 ${signal} 的孙进程必须被整组收割，不留孤儿`)
  rmSync(dir, { recursive: true, force: true })
}

test('进程纪律：孙进程忽略 SIGTERM 时整组仍被收割，退出 143，重复信号幂等', { timeout: 60_000 }, async () => {
  await runSignalTreeTest('SIGTERM', 143)
})

test('进程纪律：孙进程忽略 SIGINT 时同样收割，退出 130', { timeout: 60_000 }, async () => {
  await runSignalTreeTest('SIGINT', 130)
})

test('回归：runManagedCommand → 本仓 run-tests.mjs → 忽略 TERM 孙进程的真实拓扑无孤儿', { timeout: 60_000 }, async () => {
  // 完整真实链路：外层受管命令 = node scripts/run-tests.mjs <holder>；holder 是一个
  // 永不结束的 *.test.ts，其内 spawn 忽略 SIGTERM 的孙进程（写 PID marker）。
  // 取消外层后：run-tests（G1 leader）收到 TERM → 转发其 owned G2 → tsx leader 退出但
  // G2 孙进程存活 → run-tests 不得因 leader 退出即结算，须等 G2 排空（5s SIGKILL 升级）
  // 后退 143 → 外层 G1 排空后同样退 143。全部使用生产默认 timings，验证实际拓扑。
  const dir = path.join(repoRoot, 'node_modules', '.helm-runtests-regression')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const marker = path.join(dir, 'grandchild.pid')
  const holder = path.join(dir, 'hold.test.ts')
  const grandchildCode =
    `process.on('SIGTERM', () => {});` +
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
    `setInterval(() => {}, 1000);`
  writeFileSync(
    holder,
    `import test from 'node:test'
import { spawn } from 'node:child_process'
test('hold', { timeout: 60_000 }, () => {
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
  if (g.pid == null) throw new Error('grandchild spawn failed')
  return new Promise(() => {})
})
`,
  )

  const wrapperCode = `
const m = await import(${JSON.stringify(pathToFileURL(path.join(scriptsDir, 'lib', 'spawn-checked.mjs')).href)})
// 剥离外层 node:test 注入的递归运行上下文，等价真实开发者 shell 环境。
const env = { ...process.env }
delete env.NODE_TEST_CONTEXT
const code = await m.runManagedCommand(
  {
    cmd: process.execPath,
    args: [${JSON.stringify(path.join(scriptsDir, 'run-tests.mjs'))}, ${JSON.stringify(holder)}],
    label: 't-runtests',
  },
  { cwd: ${JSON.stringify(repoRoot)}, env },
)
process.exit(code)
`
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', wrapperCode], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  wrapper.stderr?.on('data', (d) => {
    stderr += String(d)
  })

  try {
    const up = Date.now() + 30_000
    while (!existsSync(marker) && Date.now() < up) {
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.ok(existsSync(marker), `孙进程 marker 未出现；stderr: ${stderr}`)
    const grandchildPid = Number(readFileSync(marker, 'utf8'))
    assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

    wrapper.kill('SIGTERM')
    const wrapperExit = await new Promise<number | null>((resolve) => {
      wrapper.on('exit', (c, s) => resolve(c ?? (s === 'SIGTERM' ? 143 : -1)))
    })
    assert.equal(
      wrapperExit,
      143,
      `外层应等 G1（含 run-tests 排空 G2）后才按 143 退出；stderr: ${stderr}`,
    )
    assert.ok(stderr.includes('owned 测试进程组已排空'), `run-tests 应等待其 G2 排空；stderr: ${stderr}`)

    // 忽略 TERM 的孙进程最终必须被 run-tests 的 SIGKILL 升级收割（Linux Z 状态视为已终止）。
    const gone = await new Promise<boolean>((resolve) => {
      const start = Date.now()
      const poll = () => {
        if (!pidAlive(grandchildPid)) resolve(true)
        else if (Date.now() - start > 15_000) resolve(false)
        else setTimeout(poll, 100)
      }
      poll()
    })
    assert.ok(gone, `忽略 TERM 的孙进程必须被真实拓扑整组收割，不留孤儿`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
