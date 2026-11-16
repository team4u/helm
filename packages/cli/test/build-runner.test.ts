/**
 * scripts/lib/prune-dist.mjs and scripts/lib/test-sharding.mjs unit test.
 *
 * override: incremental pruneDist artifact keep/isolated file trim/empty directory clean up/plugin client asset mirror and trim/
 * --force and HELM_CLEAN_DIST=1 all amount clean up and tsbuildinfo join motion; and test-sharding 
 * AST pure decide (type import exemption,parenthesized globalThis,process.env[] write,
 * fs alias import, each other for test auxiliary recursion append trace and ring route protect),extraArgs fall back decide and LPT shard all balance.
 *
 * runner: tsx --test; each items explicit timeout: 60_000.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import * as ts from 'typescript'
import { pruneDist, resolveTsBuildInfoFile, runCleanDistCli } from '../../../scripts/lib/prune-dist.mjs'
import {
  analyzeTestFilePurity,
  analyzeTestSourcePurity,
  partitionFilesForSharding,
  shouldDisableSharding,
} from '../../../scripts/lib/test-sharding.mjs'

function touch(root: string, rel: string, content = ''): string {
  const abs = path.join(root, rel)
  mkdirSync(path.dirname(abs), { recursive: true })
  writeFileSync(abs, content)
  return abs
}

test('pruneDist: keep valid compile artifact, precise delete isolated artifact, unknown stale file and empty directory', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helm-prune-dist-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)
    assert.ok(buildInfo?.endsWith(path.join('cache', 'pkg.tsbuildinfo')))
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')

    // valid source code and complete artifact family (contains .tsx / .mts / .cts)
    touch(pkgRoot, 'src/index.ts', 'export const a = 1')
    touch(pkgRoot, 'src/ui.tsx', 'export const UI = () => null')
    touch(pkgRoot, 'src/mod.mts', 'export const m = 1')
    touch(pkgRoot, 'src/cjs.cts', 'export const c = 1')

    for (const rel of [
      'dist/index.js',
      'dist/index.js.map',
      'dist/index.d.ts',
      'dist/index.d.ts.map',
      'dist/ui.js',
      'dist/ui.d.ts',
      'dist/mod.mjs',
      'dist/mod.d.mts',
      'dist/mod.mjs.map',
      'dist/mod.d.mts.map',
      'dist/cjs.cjs',
      'dist/cjs.d.cts',
    ]) {
      touch(pkgRoot, rel, 'valid')
    }

    // already delete source code leftover + split package old layout (such as kernel/dist/main.js, app.js, builtin-plugins/*)+ unknown artifact
    for (const stale of [
      'dist/stale-dummy.js',
      'dist/main.js',
      'dist/main.d.ts',
      'dist/main.js.map',
      'dist/main.d.ts.map',
      'dist/app.js',
      'dist/builtin-plugins/old.js',
      'dist/builtin-plugins/nested/ghost.d.ts',
      'dist/random-notes.txt',
    ]) {
      touch(pkgRoot, stale, 'stale')
    }

    const res = pruneDist({ pkgRoot, env: {} })
    assert.equal(res.mode, 'pruned')
    assert.equal(res.removedFiles.length, 9)

    for (const kept of [
      'dist/index.js',
      'dist/index.d.ts',
      'dist/index.js.map',
      'dist/index.d.ts.map',
      'dist/ui.js',
      'dist/mod.mjs',
      'dist/mod.d.mts',
      'dist/cjs.cjs',
      'dist/cjs.d.cts',
    ]) {
      assert.ok(existsSync(path.join(pkgRoot, kept)), `valid artifact must not mistakenly delete: ${kept}`)
    }
    for (const gone of [
      'dist/stale-dummy.js',
      'dist/main.js',
      'dist/app.js',
      'dist/builtin-plugins',
      'dist/random-notes.txt',
    ]) {
      assert.ok(!existsSync(path.join(pkgRoot, gone)), `stale artifact or empty directory must delete: ${gone}`)
    }
    assert.ok(existsSync(buildInfo!), 'non- force and valid artifact still in when keep tsbuildinfo dimension hold incremental compile')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('pruneDist(preserveClients): mirror keep src/<name>/client/** asset and delete already remove or mistakenly compile client file', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helm-prune-clients-'))
  try {
    touch(pkgRoot, 'src/index.ts', 'export {}')
    touch(pkgRoot, 'src/apps/client/index.tsx', 'export default function App() {}')
    touch(pkgRoot, 'src/apps/client/styles.css', '.a {}')

    touch(pkgRoot, 'dist/index.js', '')
    touch(pkgRoot, 'dist/apps/client/index.tsx', 'valid')
    touch(pkgRoot, 'dist/apps/client/styles.css', 'valid')
    touch(pkgRoot, 'dist/apps/client/removed.tsx', 'stale client file')
    touch(pkgRoot, 'dist/apps/client/index.js', 'stray compiled file inside client')
    touch(pkgRoot, 'dist/ghost-plugin/client/index.tsx', 'removed plugin client')

    const res = pruneDist({ pkgRoot, preserveClients: true, env: {} })
    assert.equal(res.mode, 'pruned')
    assert.deepEqual(res.removedFiles.sort(), [
      'apps/client/index.js',
      'apps/client/removed.tsx',
      'ghost-plugin/client/index.tsx',
    ])
    assert.ok(existsSync(path.join(pkgRoot, 'dist/apps/client/index.tsx')))
    assert.ok(existsSync(path.join(pkgRoot, 'dist/apps/client/styles.css')))
    assert.ok(!existsSync(path.join(pkgRoot, 'dist/ghost-plugin')))
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('pruneDist:--force / HELM_CLEAN_DIST=1 and empty dist all sync clean tsbuildinfo, guard against tsc incremental skip', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helm-prune-force-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)!

    // 1. HELM_CLEAN_DIST=1 all amount empty
    touch(pkgRoot, 'src/a.ts', 'export const a = 1')
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEnv = pruneDist({ pkgRoot, env: { HELM_CLEAN_DIST: '1' } })
    assert.equal(rEnv.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo), 'force wipe must sync delete tsbuildinfo')

    // 2. --force CLI flag all amount empty
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rCli = runCleanDistCli(pkgRoot, ['--force'])
    assert.equal(rCli.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo))

    // 3. dist directory already is empty (only remain stale dummy by delete after without any JS artifact) when automatically clean up tsbuildinfo
    touch(pkgRoot, 'dist/stale.js', 'only stale')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEmpty = pruneDist({ pkgRoot, env: {} })
    assert.equal(rEmpty.mode, 'pruned')
    assert.ok(!existsSync(buildInfo), 'trim after without valid JS artifact when must clear tsbuildinfo')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('test-sharding:AST pure decide let through in-memory single test, intercept DOM/env/child process/file write/count when override/do not pure assist manually', { timeout: 60_000 }, () => {
  const pure = analyzeTestSourcePurity(
    ts,
    'pure.test.ts',
    `import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Window } from 'happy-dom'
import type { KernelRuntime } from '@helm/kernel'
const PATH_VAL = process.env['PATH']
test('ok', { timeout: 60_000 }, () => {
  const obj = { window: 1, document: 'text' }
  assert.equal(obj.window, 1)
  void readFileSync
  void PATH_VAL
})`,
  )
  assert.equal(pure.pure, true, `pre- phase pure test via, actual reason: ${pure.reasons.join(', ')}`)

  const cases: Array<[string, string]> = [
    ['happy-dom import', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()`],
    ['react-dom/client', `import { createRoot } from 'react-dom/client'\nvoid createRoot`],
    ['parentheses assertion globalThis', `import * as React from 'react'\n;(globalThis as Record<string, unknown>).React = React`],
    ['document/window access', `const el = document.createElement('div')\nwindow.history.back()\nvoid el`],
    ['process.env[] write and delete', `process.env['FOO'] = '1'\ndelete process.env['FOO']`],
    ['process.env assignment', `process.env = {} as NodeJS.ProcessEnv`],
    ['process.stdin/chdir', `process.chdir('/tmp')\nprocess.stdin.resume()`],
    ['spawn / child_process', `import { spawn } from 'node:child_process'\nspawn('echo', ['hi'])`],
    ['fs alias write import', `import { writeFileSync as wf } from 'node:fs'\nwf('a', 'b')`],
    ['http createServer / listen', `import http from 'node:http'\nhttp.createServer().listen(0)`],
    ['KernelRuntime / createHelm / DatabaseSync', `import { DatabaseSync } from 'node:sqlite'\nnew DatabaseSync(':memory:')`],
    ['timer override and t.mock.timers', `test('x', { timeout: 60_000 }, (t) => { t.mock.timers.enable({ apis: ['setTimeout'] }) })`],
    ['Object.assign change write import object', `import { cfg } from '../src/cfg.js'\nObject.assign(cfg, { a: 1 })`],
  ]

  for (const [label, code] of cases) {
    const r = analyzeTestSourcePurity(ts, 'bad.test.ts', code)
    assert.equal(r.pure, false, `${label} must decide is non- pure`)
    assert.ok(r.reasons.length > 0, `${label} must to out non-empty reason`)
  }
})

test('test-sharding: disk auxiliary module recursion append trace (contains ring route security), parameter retreat back condition and LPT shard all balance', { timeout: 60_000 }, () => {
  const root = mkdtempSync(path.join(tmpdir(), 'helm-shard-disk-'))
  try {
    const pureTest = touch(root, 'packages/a/test/pure.test.ts', `import test from 'node:test'\nimport { helper } from './helpers/pure-helper.js'\ntest('p', { timeout: 60_000 }, () => { void helper })`)
    touch(root, 'packages/a/test/helpers/pure-helper.ts', `import { other } from './cycle.js'\nexport const helper = () => other`)
    touch(root, 'packages/a/test/helpers/cycle.ts', `import { helper } from './pure-helper.js'\nexport const other = () => helper`)

    const impureViaHelper = touch(root, 'packages/a/test/via-helper.test.ts', `import test from 'node:test'\nimport { mount } from './helpers/dom-helper.js'\ntest('d', { timeout: 60_000 }, () => { mount() })`)
    touch(root, 'packages/a/test/helpers/dom-helper.ts', `export const mount = () => { (globalThis as Record<string, unknown>).x = 1 }`)

    assert.equal(analyzeTestFilePurity(ts, pureTest).pure, true)
    const impureRes = analyzeTestFilePurity(ts, impureViaHelper)
    assert.equal(impureRes.pure, false)
    assert.ok(impureRes.reasons.some((r) => r.includes('globalThis')))

    // shouldDisableSharding
    assert.equal(shouldDisableSharding([]), false)
    assert.equal(shouldDisableSharding(['--test-only']), true)
    assert.equal(shouldDisableSharding(['--test-isolation=none']), true)
    assert.equal(shouldDisableSharding(['--test-reporter=tap']), true)
    assert.equal(shouldDisableSharding(['--test-name-pattern=foo']), true)
    assert.equal(shouldDisableSharding(['-t', 'foo']), true)

    // partitionFilesForSharding LPT all balance allocate and do not heavy do not leak
    const files = Array.from({ length: 18 }, (_, i) => {
      const rel = `packages/a/test/p${i}.test.ts`
      touch(root, rel, `import test from 'node:test'\ntest('${i}', { timeout: 60_000 }, () => {})`)
      return rel
    })
    files.push(path.relative(root, impureViaHelper))
    const weights = new Map(files.map((f, i) => [f, (i + 1) * 100]))
    const part = partitionFilesForSharding({
      ts,
      repoRoot: root,
      files,
      cpus: 4,
      filesPerShard: 6,
      weightFn: (rel) => weights.get(rel) ?? 0,
    })
    assert.equal(part.pureFiles.length, 18)
    assert.equal(part.isolatedFiles.length, 1)
    assert.equal(part.shards.length, 3)
    const flattened = part.shards.flat()
    assert.equal(flattened.length, 18)
    assert.equal(new Set(flattened).size, 18)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
