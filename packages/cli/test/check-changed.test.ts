/**
 * scripts/check-changed.mjs and scripts/check-test-hygiene.mjs(contains scripts/lib/* store) unit test.
 *
 * override: changeset collect (many commit + work zone dirty + untracked + delete + rename + space path + baseline parse
 * priority and without baseline reject), subject to affect package reverse closed package and level all Profile trigger,hygiene AST analyze (by default/tool name/
 * alias/naming empty between import, many row options, sharing const option,describe timeout inherit,skip by,
 * todo exemption,HELM_TEST_SUITE_TIMEOUT_MS assignment),CLI exit code pass-through (contains failed to execute do not swallow code),
 * child process tree signal forwarding do not orphan child, and PACKAGE_TIERS and test-suites.mjs SUITES mirror lock.
 *
 * runner: tsx --test; each items explicit timeout: 60_000.
 */
import test, { after, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
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

// ---------------------------------------------------------------- git fixture

function git(dir: string, ...args: string[]): void {
  const res = spawnSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=dev', ...args], {
    cwd: dir,
    encoding: 'utf8',
  })
  assert.equal(res.status, 0, `git ${args.join(' ')} failed: ${res.stderr}`)
}

function write(dir: string, rel: string, content: string): void {
  const abs = path.join(dir, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

let cachedTemplateRepo: string | undefined

function getTemplateRepo(): string {
  if (cachedTemplateRepo) return cachedTemplateRepo
  const dir = mkdtempSync(path.join(tmpdir(), 'helm-check-changed-tpl-'))
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
  // work zone: unstaged modify + staged new increase + untracked, all contains space path.
  write(dir, 'space dir/f.txt', 'v2')
  write(dir, 'staged file.ts', 's')
  git(dir, 'add', 'staged file.ts')
  write(dir, 'untracked file.ts', 'u')
  cachedTemplateRepo = dir
  return dir
}

after(() => {
  if (cachedTemplateRepo) {
    rmSync(cachedTemplateRepo, { recursive: true, force: true })
    cachedTemplateRepo = undefined
  }
})

/** many commit + work zone dirty (staged/unstaged)+ untracked + delete + rename + space path complete fixture (re- use template repository). */
function makeFixtureRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'helm-check-changed-'))
  cpSync(getTemplateRepo(), dir, { recursive: true })
  return dir
}

// ---------------------------------------------------------------- changeset collect

test('changeset: many commit ∪ work zone ∪ untracked,rename double side + delete + space path all accept', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    const { baseline, files } = collectChangedFiles({ base: 'HEAD~2', cwd: dir })
    assert.equal(baseline.kind, 'explicit')
    assert.equal(baseline.ref, 'HEAD~2')
    const byPath = new Map(files.map((f) => [f.path, f]))
    // committed(two commit cumulative): modify,rename new old two side, delete.
    assert.equal(byPath.get('base.txt')?.origin, 'committed')
    assert.ok(byPath.has('src/one.ts'), 'rename old path must accept')
    assert.ok(byPath.has('src/two renamed.ts'), 'rename new path (contains space) must accept')
    assert.ok(byPath.get('src/two renamed.ts')?.status.startsWith('R'), 'rename state with R open head')
    assert.equal(byPath.get('old.txt')?.origin, 'committed')
    assert.equal(byPath.get('old.txt')?.status, 'D')
    // work zone: staged and unstaged same source worktree.
    assert.equal(byPath.get('space dir/f.txt')?.origin, 'worktree')
    assert.equal(byPath.get('staged file.ts')?.origin, 'worktree')
    // untracked.
    assert.equal(byPath.get('untracked file.ts')?.origin, 'untracked')
    assert.equal(files.filter((f) => f.origin === 'committed').length, 4)
    assert.equal(files.filter((f) => f.origin === 'untracked').length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('baseline parse:upstream takes precedence at origin/HEAD; all without when explicit errors while non- static default HEAD~1', { timeout: 60_000 }, () => {
  const dir = makeFixtureRepo()
  try {
    // initial without remote: by default baseline cannot obtain → resolveBaseline such as return none,collect explicit errors and refer reference --base.
    assert.deepEqual(resolveBaseline({ cwd: dir }), { kind: 'none', ref: null, mergeBase: null })
    assert.throws(() => collectChangedFiles({ cwd: dir }), (e: unknown) => {
      assert.ok(e instanceof GitChangeError)
      assert.ok(e.message.includes('--base'), 'error information must refer reference --base')
      return true
    })

    // config upstream(points to c1) after:merge-base = c1,c1..HEAD  c2 change accept,c1 itself do not compute.
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
    assert.ok(!paths.includes('base.txt'), 'merge-base before commit change do not accept')
    assert.ok(paths.includes('old.txt'), 'merge-base after delete accept')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('parseNameStatusZ:-z stream by NUL cut,rename/copy expand new old double side', { timeout: 60_000 }, () => {
  const raw = ['M\0a.txt\0', 'R100\0new dir/two.ts\0old dir/one.ts\0', 'D\0gone.ts\0'].join('')
  assert.deepEqual(parseNameStatusZ(raw), [
    { path: 'a.txt', status: 'M' },
    { path: 'new dir/two.ts', status: 'R100' },
    { path: 'old dir/one.ts', status: 'R100' },
    { path: 'gone.ts', status: 'D' },
  ])
})

// ---------------------------------------------------------------- subject to affect package choose collection

/** and repository real workspace diagram same construct together into package diagram (contains pass dependency chain). */
const SYNTH_PKGS = [
  { name: '@helm/protocol', dir: 'protocol', workspaceDeps: [] },
  { name: '@helm/kernel', dir: 'kernel', workspaceDeps: ['@helm/protocol', '@helm/node'] },
  { name: '@helm/plugins', dir: 'plugins', workspaceDeps: ['@helm/protocol', '@helm/kernel'] },
  { name: '@helm/hub', dir: 'hub', workspaceDeps: ['@helm/protocol', '@helm/kernel', '@helm/plugins'] },
  { name: '@helm/node', dir: 'node', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/cli', dir: 'cli', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/web', dir: 'web', workspaceDeps: ['@helm/protocol'] },
  { name: '@helm/payload', dir: 'payload', workspaceDeps: ['@helm/cli', '@helm/kernel', '@helm/plugins', '@helm/hub', '@helm/web'] },
  { name: '@helm/desktop', dir: 'desktop', workspaceDeps: [] },
]

test('dependency closed package:protocol change expand scatter to all consumer;node change via kernel pass to hub/payload', { timeout: 60_000 }, () => {
  const r1 = computeAffectedPackages(['packages/protocol/src/index.ts'], SYNTH_PKGS)
  assert.deepEqual([...r1.affected].sort(), ['cli', 'hub', 'kernel', 'node', 'payload', 'plugins', 'protocol', 'web'])

  const r2 = computeAffectedPackages(['packages/node/src/cli.ts'], SYNTH_PKGS)
  assert.deepEqual([...r2.affected].sort(), ['hub', 'kernel', 'node', 'payload', 'plugins'])

  const r3 = computeAffectedPackages(['packages/desktop/src/main.ts'], SYNTH_PKGS)
  assert.deepEqual([...r3.affected], ['desktop'])
})

test('pure test file change only choose this package; package inside non- test file (contains test assist manually) away closed package; level trigger all Profile', { timeout: 60_000 }, () => {
  const t1 = computeAffectedPackages(['packages/kernel/test/foo.test.ts'], SYNTH_PKGS)
  assert.deepEqual([...t1.affected], ['kernel'])
  assert.equal(t1.fullTier, false)

  // test/ under non- *.test.ts assist manually file by source handle (keep guard closed package:kernel → hub → payload,hub dependency kernel).
  const t2 = computeAffectedPackages(['packages/kernel/test/helpers.ts'], SYNTH_PKGS)
  assert.deepEqual([...t2.affected].sort(), ['hub', 'kernel', 'payload', 'plugins'])

  const t3 = computeAffectedPackages(['pnpm-lock.yaml'], SYNTH_PKGS)
  assert.equal(t3.fullTier, true)
  assert.equal(t3.affected.size, 9)

  // single change fast gate itself implement (scripts source code) also trigger all Profile, disallows without check via.
  const t5 = computeAffectedPackages(['scripts/lib/spawn-checked.mjs'], SYNTH_PKGS)
  assert.equal(t5.fullTier, true)
  assert.equal(t5.affected.size, 9)

  const t4 = computeAffectedPackages(['docs/foo.md', 'AGENTS.md'], SYNTH_PKGS)
  assert.equal(t4.affected.size, 0)
  assert.deepEqual(t4.outside, ['AGENTS.md', 'docs/foo.md'])
})

test('classifyChange: file classify and boundary (scripts source code all Profile, pure document does not trigger)', { timeout: 60_000 }, () => {
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

test('PACKAGE_TIERS and test-suites.mjs SUITES mirror lock; all warehouse package all has Profile', { timeout: 60_000 }, () => {
  const src = readFileSync(path.join(scriptsDir, 'test-suites.mjs'), 'utf8')
  const unitMatch = /unit:\s*\[([^\]]*)\]/.exec(src)
  const integrationMatch = /integration:\s*\[([^\]]*)\]/.exec(src)
  assert.ok(unitMatch && integrationMatch, 'test-suites.mjs SUITES structure change, please sync parse logic')
  const names = (s: string) => [...s.matchAll(/'([^']+)'/g)].map((m) => m[1] ?? '')
  const expected: Record<string, string> = {}
  for (const n of names(unitMatch?.[1] ?? '')) expected[n] = 'unit'
  for (const n of names(integrationMatch?.[1] ?? '')) expected[n] = 'integration'
  assert.deepEqual(PACKAGE_TIERS, expected, 'change test-suites.mjs Profile must sync workspace-meta.mjs  PACKAGE_TIERS')

  for (const p of loadWorkspacePackages(repoRoot)) {
    assert.ok(PACKAGE_TIERS[p.dir], `new package ${p.dir} not register Profile, please sync PACKAGE_TIERS and SUITES`)
  }
  assert.ok(testFilesOfPackage(repoRoot, 'cli').some((f) => f.endsWith('.test.ts')))
})

test('planCheckCommands: has test file when pre- check-hygiene;desktop choose in when insert dist build pre-; order fixed; empty choose collection without command', { timeout: 60_000 }, () => {
  const pm = { cmd: 'node', args: ['/pnpm/bin/pnpm.cjs'] }
  const withDesktop = planCheckCommands({
    affectedDirs: ['desktop', 'kernel'],
    testFiles: ['packages/desktop/test/bootstrap.test.ts', 'packages/kernel/test/http.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withDesktop.length, 4)
  assert.equal(withDesktop[0]?.cmd, '/node')
  assert.deepEqual(withDesktop[0]?.args, [
    path.join('/repo', 'scripts', 'check-test-hygiene.mjs'),
    '--files',
    'packages/desktop/test/bootstrap.test.ts',
    'packages/kernel/test/http.test.ts',
  ])
  assert.deepEqual(withDesktop[1]?.args, ['/pnpm/bin/pnpm.cjs', 'typecheck'])
  assert.deepEqual(withDesktop[2]?.args, ['/pnpm/bin/pnpm.cjs', '--filter', '@helm/desktop', 'run', 'build'])
  assert.match(withDesktop[2]?.label ?? '', /desktop/)
  assert.equal(withDesktop[3]?.args[0], path.join('/repo', 'scripts', 'run-tests.mjs'))
  assert.equal(withDesktop[3]?.args.length, 3)

  const withoutDesktop = planCheckCommands({
    affectedDirs: ['cli'],
    testFiles: ['packages/cli/test/cli.test.ts'],
    pm,
    execPath: '/node',
    repoRoot: '/repo',
  })
  assert.equal(withoutDesktop.length, 3)
  assert.equal(withoutDesktop[0]?.args[0], path.join('/repo', 'scripts', 'check-test-hygiene.mjs'))
  assert.deepEqual(withoutDesktop[1]?.args, ['/pnpm/bin/pnpm.cjs', 'typecheck'])
  assert.equal(withoutDesktop[2]?.args[0], path.join('/repo', 'scripts', 'run-tests.mjs'))
  assert.ok(withoutDesktop.every((c) => !c.args.includes('@helm/desktop')))

  const none = planCheckCommands({ affectedDirs: [], testFiles: [], pm, execPath: '/node', repoRoot: '/repo' })
  assert.equal(none.length, 0)
})

// ---------------------------------------------------------------- hygiene AST

function rulesOf(source: string): string[] {
  return analyzeTestSource(ts, 'sample.test.ts', source).violations.map((v) => v.rule)
}

test('hygiene: tool name/by default/alias/naming empty between import timeout decide (contains many row options)', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('a', { timeout: 60_000 }, () => {})
test('b', () => {})`), ['timeout-missing'])

  assert.deepEqual(rulesOf(`import { it } from 'node:test'
it('a', () => {})`), ['timeout-missing'])

  // as alias: source name is test/it only then compute managed invoke.
  assert.deepEqual(rulesOf(`import { test as it, describe as d } from 'node:test'
it('ok', { timeout: 60_000 }, () => {})
it('bad', () => {})`), ['timeout-missing'])

  // naming empty between import.
  assert.deepEqual(rulesOf(`import * as nt from 'node:test'
nt.test('ok', { timeout: 60_000 }, () => {})
nt.it('bad', () => {})`), ['timeout-missing'])

  // many row options: rely AST while non- row inside regex.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('multi', {
  timeout: 60_000,
}, async () => {})`), [])

  // sharing const option object (contains as const unwrap).
  assert.deepEqual(rulesOf(`import test from 'node:test'
const opts = { timeout: 60_000 } as const
test('shared', opts, () => {})`), [])
})

test('hygiene:describe timeout by node:test semantics by sub- test inherit', { timeout: 60_000 }, () => {
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', { timeout: 60_000 }, () => {
  it('inherits', () => {})
})`), [])
  assert.deepEqual(rulesOf(`import { describe, it } from 'node:test'
describe('d', () => {
  it('no-timeout', () => {})
})`), ['timeout-missing'])
})

test('hygiene:skip must attach by; constant skip exemption timeout; condition skip still must timeout', { timeout: 60_000 }, () => {
  // { skip: true }: without by violate rule; constant skip no longer stack timeout violate rule.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s', { timeout: 60_000, skip: true }, () => {})`), ['skip-without-reason'])
  // condition skip(by : false): will execute → missing timeout violate rule.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c', { skip: process.platform === 'win32' ? 'Windows do not fit use' : false }, () => {})`), [
    'timeout-missing',
  ])
  // condition skip and carries timeout: clean.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('c2', { timeout: 60_000, skip: process.env.X !== '1' ? 'must X=1' : false }, () => {})`), [])
  // constant skip carries by: do not execute, no need to timeout.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s2', { skip: 'environment do not tool prepare' }, () => {})`), [])
  // test.skip simple write not attach by.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s3', () => {})`), ['skip-without-reason'])
  assert.deepEqual(rulesOf(`import test from 'node:test'
test.skip('s4', { skip: 'by' }, () => {})`), [])
  // cannot static confirm skip value such as report violate rule.
  assert.deepEqual(rulesOf(`import test from 'node:test'
test('s5', { timeout: 60_000, skip: someFlag }, () => {})`), ['skip-without-reason'])
})

test('hygiene:todo exemption;t.test sub- test only counter;env assignment violate rule', { timeout: 60_000 }, () => {
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

// ---------------------------------------------------------------- CLI exit code

function runScript(script: string, args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(process.execPath, [path.join(scriptsDir, script), ...args], {
    cwd: opts.cwd ?? repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
  })
}

test('check-test-hygiene CLI: violate rule file exit 1, clean file exit 0, unknown parameter exit 2', { timeout: 60_000 }, () => {
  // fixture must at repository inside (--files reject repository outside path);node_modules already by gitignore, do not pollute work zone.
  const dir = path.join(repoRoot, 'node_modules', '.helm-hygiene-cli-fixtures')
  mkdirSync(dir, { recursive: true })
  try {
    const bad = path.join(dir, 'bad.test.ts')
    writeFileSync(bad, "import test from 'node:test'\ntest('x', () => {})\n")
    const good = path.join(dir, 'good.test.ts')
    writeFileSync(good, "import test from 'node:test'\ntest('x', { timeout: 60_000 }, () => {})\n")

    const r1 = runScript('check-test-hygiene.mjs', ['--files', bad])
    assert.equal(r1.status, 1, `stderr: ${r1.stderr}`)
    assert.ok(r1.stderr.includes('[timeout-missing]'), 'violate rule detail must print rule and location')

    const r2 = runScript('check-test-hygiene.mjs', ['--files', good])
    assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)

    const r3 = runScript('check-test-hygiene.mjs', ['--wat'])
    assert.equal(r3.status, 2)
    assert.ok(r3.stderr.includes('Unknown argument'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('check-changed CLI:--base reference missing exit 2;--list print choose collection do not execute command', { timeout: 60_000 }, () => {
  const r1 = runScript('check-changed.mjs', ['--base', 'no-such-ref', '--list'])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('--base'))

  const r2 = runScript('check-changed.mjs', ['--list', '--base', 'HEAD'])
  assert.equal(r2.status, 0, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('[check-changed] baseline:'), 'must explicitly report the chosen baseline')
  assert.ok(r2.stderr.includes('Commands to run'), 'must print the commands to run for re-checking')
  assert.ok(r2.stderr.includes('[check-changed] --list mode: printed the selection only; no commands executed'), '--list mode must never execute commands')

  const r3 = runScript('check-changed.mjs', ['--bogus'])
  assert.equal(r3.status, 2)
})

test('check-test-hygiene CLI: repository outside path and empty --files all reject exit 2, not silently change inspect other repository or all warehouse', { timeout: 60_000 }, () => {
  const outside = path.join(tmpdir(), 'helm-outside-' + Date.now(), 'x.test.ts')
  const r1 = runScript('check-test-hygiene.mjs', ['--files', outside])
  assert.equal(r1.status, 2, `stderr: ${r1.stderr}`)
  assert.ok(r1.stderr.includes('[check-hygiene] Rejected path outside repository:'), 'must explicitly reject instead of silently inspecting another repository')

  const r2 = runScript('check-test-hygiene.mjs', ['--files'])
  assert.equal(r2.status, 2, `stderr: ${r2.stderr}`)
  assert.ok(r2.stderr.includes('[check-hygiene] --files requires at least one in-repository test path (refusing to scan the whole repository)'), 'empty --files must report a usage error instead of falling back to a whole-repo scan')

  // open head -- isolate symbol (pnpm pass-through form): and explicit repository inside file etc. price.
  const r3 = runScript('check-test-hygiene.mjs', ['--', '--files', 'packages/cli/test/cli.test.ts'])
  assert.equal(r3.status, 0, `stderr: ${r3.stderr}`)
})

test('pnpm true invoke:pnpm check:changed -- --base HEAD --list pass-through open head -- isolate symbol', { timeout: 60_000 }, () => {
  const pm = resolvePackageManagerInvoke(process.env)
  const res = spawnSync(
    pm.cmd,
    [...pm.args, 'check:changed', '--', '--base', 'HEAD', '--list'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 120_000 },
  )
  assert.equal(res.status, 0, `stderr: ${res.stderr}`)
  assert.ok(res.stderr.includes('[check-changed] baseline:'), `must report the baseline:${res.stderr.slice(0, 400)}`)
  assert.ok(res.stderr.includes('[check-changed] --list mode: printed the selection only; no commands executed'), '--list never executes commands')
})

test('resolvePackageManagerInvoke:npm_execpath validate suffix after use when before Node run; exception value fall back PATH pnpm', { timeout: 60_000 }, () => {
  // note: real Windows .cmd behavior cannot in this Linux environment verify; this test lock platform without closure argv construct logic,
  // Windows under actual effect by on state pnpm true invoke smoke same path override (npm_execpath branch).
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
  // pnpm official standalone install (Windows):npm_execpath points to pnpm.exe can execute start.
  // .exe is real can execute file (non- .cmd script), no need to shell, without inject side, directly spawn; otherwise fall back
  // bare 'pnpm' in Windows on parse is pnpm.cmd,spawn EINVAL(produce product bug, non- only test issue).
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: 'C:\\Tools\\pnpm.exe' }), {
    cmd: 'C:\\Tools\\pnpm.exe',
    args: [],
  })
  // non- script suffix (can execute shim / malicious value) do not blind message, fall back;.cmd is script inject side, never directly spawn.
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/pnpm.cmd' }), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '/x/evil.sh' }), { cmd: 'pnpm', args: [] })
  assert.deepEqual(resolvePackageManagerInvoke({ npm_execpath: '' }), { cmd: 'pnpm', args: [] })
})

test('runManagedCommand: failed exit code original pass-through; command missing report 127', { timeout: 60_000 }, async () => {
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

/** process store decide:ESRCH i.e. stop;Linux under zombie (Z state) treated as already terminate, do not compute store orphan child. */
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
 * descendant process install empty SIGTERM/SIGINT handler(what all does not) and write PID marker, verify wrap:
 * leader exit after still continue owned group store polling → wide limit after SIGKILL upgrade → eventually whole group disappear,
 * by signal code exit, duplicate signal idempotent. inject short timings let upgrade in hundred milli second level occur.
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
  assert.ok(existsSync(marker), 'descendant process PID marker not appear')
  const grandchildPid = Number(readFileSync(marker, 'utf8'))
  assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

  wrapper.kill(signal)
  wrapper.kill(signal) // duplicate signal: idempotent, must not duplicate create timer or duplicate log
  const wrapperExit = await new Promise<number | null>((resolve) => {
    wrapper.on('exit', (c, s) => resolve(c ?? (s === signal ? expectedCode : -1)))
  })
  assert.equal(wrapperExit, expectedCode, `by ${signal} terminate must by 128+signal exit;stderr: ${stderr}`)
  const signalLogs = stderr.split(`received ${signal}, terminating the child process tree`).length - 1
  assert.equal(signalLogs, 1, `duplicate signal only allows a terminate log;stderr: ${stderr}`)

  // ignore signal descendant process eventually must by SIGKILL upgrade cut: do not any store orphan child.
  const gone = await new Promise<boolean>((resolve) => {
    const start = Date.now()
    const poll = () => {
      if (!pidAlive(grandchildPid)) resolve(true)
      else if (Date.now() - start > 12_000) resolve(false)
      else setTimeout(poll, 100)
    }
    poll()
  })
  assert.ok(gone, `ignore ${signal} descendant process must by whole group cut, do not orphan child`)
  rmSync(dir, { recursive: true, force: true })
}

describe('process discipline and watchdog concurrency cut', { concurrency: true }, () => {
  test('process discipline: descendant process ignore SIGTERM when whole group still by cut, exit 143, duplicate signal idempotent', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n exit code / kill(-pid));Windows away taskkill path, do not fit use' : false }, async () => {
    await runSignalTreeTest('SIGTERM', 143)
  })

  test('process discipline: descendant process ignore SIGINT when same cut, exit 130', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n exit code / kill(-pid));Windows away taskkill path, do not fit use' : false }, async () => {
    await runSignalTreeTest('SIGINT', 130)
  })

  test('regression:runManagedCommand → this warehouse run-tests.mjs → ignore TERM descendant process real topology without orphan child', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX process group signal semantics (128+n exit code / kill(-pid));Windows away taskkill path, do not fit use' : false }, async () => {
    // complete real link: outside layer managed command = node scripts/run-tests.mjs <holder>;holder is a
    // forever do not end *.test.ts, its inside spawn ignore SIGTERM descendant process (write PID marker).
    // cancel outside layer after:run-tests(G1 leader) receives TERM → forwarding its owned G2 → tsx leader exit but
    // G2 descendant process store → run-tests must not because leader exit i.e. compute, must etc. G2 arrange empty (5s SIGKILL upgrade)
    // after retreat 143 → outside layer G1 arrange empty after same retreat 143. all use produce by default timings, verify actual topology.
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
// strip outside layer node:test inject recursion run context, etc. price real developer shell environment.
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
      assert.ok(existsSync(marker), `descendant process marker not appear;stderr: ${stderr}`)
      const grandchildPid = Number(readFileSync(marker, 'utf8'))
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)

      wrapper.kill('SIGTERM')
      const wrapperExit = await new Promise<number | null>((resolve) => {
        wrapper.on('exit', (c, s) => resolve(c ?? (s === 'SIGTERM' ? 143 : -1)))
      })
      assert.equal(
        wrapperExit,
        143,
        `outside layer should etc. G1(contains run-tests arrange empty G2) after only then by 143 exit;stderr: ${stderr}`,
      )
      assert.ok(stderr.includes('owned test process group drained'), `run-tests must wait for its G2 to drain;stderr: ${stderr}`)

      // ignore TERM descendant process eventually must by run-tests  SIGKILL upgrade cut (Linux Z state treated as already terminate).
      const gone = await new Promise<boolean>((resolve) => {
        const start = Date.now()
        const poll = () => {
          if (!pidAlive(grandchildPid)) resolve(true)
          else if (Date.now() - start > 15_000) resolve(false)
          else setTimeout(poll, 100)
        }
        poll()
      })
      assert.ok(gone, `ignore TERM descendant process must by real topology whole group cut, do not orphan child`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('process discipline:run-tests.mjs by SIGKILL strong kill when parent die watchdog automatically cut detached test process group', { timeout: 60_000, skip: process.platform === 'win32' ? 'POSIX parent die watchdog and process group signal semantics;Windows do not fit use' : false }, async () => {
    const dir = path.join(repoRoot, 'node_modules', '.helm-runtests-sigkill')
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    const marker = path.join(dir, 'grandchild.pid')
    const holder = path.join(dir, 'hold.test.ts')
    const grandchildCode =
      `process.on('SIGTERM', () => {}); process.on('SIGINT', () => {});` +
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));` +
      `setInterval(() => {}, 1000);`
    writeFileSync(
      holder,
      `import test from 'node:test'
import { spawn } from 'node:child_process'
test('hold-sigkill', { timeout: 60_000 }, () => {
  const g = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' })
  if (g.pid == null) throw new Error('grandchild spawn failed')
  return new Promise(() => {})
})
`,
    )

    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const runner = spawn(process.execPath, [path.join(scriptsDir, 'run-tests.mjs'), holder], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    runner.stderr?.on('data', (d) => {
      stderr += String(d)
    })

    try {
      const up = Date.now() + 30_000
      while (!existsSync(marker) && Date.now() < up) {
        await new Promise((r) => setTimeout(r, 100))
      }
      assert.ok(existsSync(marker), `descendant process PID marker not appear;stderr: ${stderr}`)
      const grandchildPid = Number(readFileSync(marker, 'utf8'))
      assert.ok(Number.isInteger(grandchildPid) && grandchildPid > 0)
      assert.ok(pidAlive(grandchildPid), 'strong kill run-tests before descendant process must store')

      runner.kill('SIGKILL')
      const exitSignal = await new Promise<string | null>((resolve) => {
        runner.on('exit', (_c, s) => resolve(s))
      })
      assert.equal(exitSignal, 'SIGKILL')

      // parent process expose kill after,detached watchdog should in 1s SIGKILL upgrade inside cut the whole detached test process group
      const gone = await new Promise<boolean>((resolve) => {
        const start = Date.now()
        const poll = () => {
          if (!pidAlive(grandchildPid)) resolve(true)
          else if (Date.now() - start > 10_000) resolve(false)
          else setTimeout(poll, 100)
        }
        poll()
      })
      assert.ok(gone, 'run-tests.mjs by SIGKILL after parent die watchdog must cut its detached test process group, do not orphan child')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ---------------------------------------------------------------- unsafe-dom-assert / safe-test-assert / SIGKILL watchdog

test('hygiene:unsafe-dom-assert precise hit DOM node assertion and let through text/ordinary body/ok/notEqual null', { timeout: 60_000 }, () => {
  // correct example (violate rule):querySelector / getElementById / local variable / document.activeElement two side / document.body / tool name import
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
import assert from 'node:assert/strict'
import { strictEqual } from 'node:assert'
test('bad dom', { timeout: 60_000 }, () => {
  assert.equal(document.querySelector('.a'), null)
  strictEqual(document.getElementById('x'), null)
  const el = document.querySelector('.b')
  assert.equal(el, null)
  assert.notStrictEqual(document.activeElement, el)
  assert.deepEqual(document.body, null)
})`),
    [
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
      'unsafe-dom-assert',
    ],
  )

  // reverse example (clean):textContent / innerHTML / getAttribute / length / req.body / hit.body / assert.ok / assert.notEqual(el, null)
  assert.deepEqual(
    rulesOf(`import test from 'node:test'
import assert from 'node:assert/strict'
test('clean dom', { timeout: 60_000 }, () => {
  const el = document.querySelector('.a')
  assert.equal(el?.textContent, 'ok')
  assert.equal(el?.innerHTML, '<span>ok</span>')
  assert.equal(el?.getAttribute('role'), 'dialog')
  assert.equal(document.querySelectorAll('.item').length, 2)
  assert.equal(hit.body, 'payload')
  assert.equal(req.body, 'raw')
  assert.equal(draft.body, 'draft')
  assert.ok(el === null)
  assert.notEqual(el, null)
  assert.notStrictEqual(document.activeElement, null)
})`),
    [],
  )
})

test('safe-test-assert: loop __reactFiber$ simulated DOM node assert.equal(el, null) and assert.deepEqual([el], []) in <50ms inside throw summary AssertionError', { timeout: 60_000 }, async () => {
  const preloadUrl = pathToFileURL(path.join(scriptsDir, 'lib', 'safe-test-assert.mjs')).href
  await import(preloadUrl)
  const { equal, deepEqual } = await import('node:assert/strict')

  // construct carries deep loop React Fiber reference simulated DOM element
  const fiber: Record<string, unknown> = { memoizedProps: {}, return: null, stateNode: null }
  fiber.child = fiber
  fiber.return = fiber
  const bigArr = Array.from({ length: 5000 }, (_, i) => ({ i, parent: fiber }))
  fiber.memoizedProps = { items: bigArr }
  const el: Record<string, unknown> = {
    nodeType: 1,
    nodeName: 'DIV',
    id: 'card',
    className: 'box active',
    __reactFiber$xyz: fiber,
    ownerDocument: null,
  }
  fiber.stateNode = el
  el.ownerDocument = { nodeType: 9, nodeName: '#document', body: el }

  const t0 = performance.now()
  assert.throws(
    () => assert.equal(el, null),
    (err: unknown) => {
      assert.ok(err instanceof assert.AssertionError)
      assert.ok(err.message.includes('[DOM <div#card.box.active>]'), `not contains compact summary: ${err.message}`)
      return true
    },
  )
  assert.throws(
    () => equal(el, null),
    (err: unknown) => err instanceof assert.AssertionError && err.message.includes('[DOM <div#card.box.active>]'),
  )
  assert.throws(
    () => assert.deepEqual([el], []),
    (err: unknown) => {
      assert.ok(err instanceof assert.AssertionError)
      assert.deepEqual(err.actual, ['[DOM <div#card.box.active>]'])
      assert.ok(err.message.includes('[DOM <div#card.box.active>]'), `array element not contains compact summary: ${err.message}`)
      return true
    },
  )
  assert.throws(
    () => deepEqual([el], []),
    (err: unknown) =>
      err instanceof assert.AssertionError &&
      err.message.includes('[DOM <div#card.box.active>]'),
  )
  const elapsedMs = performance.now() - t0
  assert.ok(elapsedMs < 50, `danger DOM assertion time cost ${elapsedMs.toFixed(1)}ms exceeds 50ms threshold`)

  // normal object keep original generate diff, do not by error summary
  assert.throws(
    () => assert.deepEqual({ alpha: 1 }, { alpha: 2 }),
    (err: unknown) => err instanceof assert.AssertionError && err.message.includes('alpha'),
  )
})
