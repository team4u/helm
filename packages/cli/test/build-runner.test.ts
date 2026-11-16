/**
 * scripts/lib/prune-dist.mjs 与 scripts/lib/test-sharding.mjs 单元测试。
 *
 * 覆盖：增量 pruneDist 产物保留/孤立文件裁剪/空目录清理/插件 client 资产镜像与裁剪/
 * --force 与 HELM_CLEAN_DIST=1 全量清理及 tsbuildinfo 联动；以及 test-sharding 的
 * AST 纯度判定（类型导入豁免、parenthesized globalThis、process.env[] 写入、
 * fs 别名导入、相对 test 辅助递归追踪与环路保护）、extraArgs 降级判断和 LPT 分片均衡。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
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

test('pruneDist：保留有效编译产物，精确删除孤立产物、未知陈旧文件与空目录', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helm-prune-dist-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)
    assert.ok(buildInfo?.endsWith(path.join('cache', 'pkg.tsbuildinfo')))
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')

    // 有效源码及完整产物族（含 .tsx / .mts / .cts）
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

    // 已删源码残留 + 拆包旧布局（如 kernel/dist/main.js, app.js, builtin-plugins/*）+ 未知产物
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
      assert.ok(existsSync(path.join(pkgRoot, kept)), `有效产物不得误删: ${kept}`)
    }
    for (const gone of [
      'dist/stale-dummy.js',
      'dist/main.js',
      'dist/app.js',
      'dist/builtin-plugins',
      'dist/random-notes.txt',
    ]) {
      assert.ok(!existsSync(path.join(pkgRoot, gone)), `陈旧产物或空目录必须删除: ${gone}`)
    }
    assert.ok(existsSync(buildInfo!), '非 force 且有效产物仍在时保留 tsbuildinfo 维持增量编译')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('pruneDist(preserveClients)：镜像保留 src/<name>/client/** 资产并删除已移除或误编译的 client 文件', { timeout: 60_000 }, () => {
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

test('pruneDist：--force / HELM_CLEAN_DIST=1 与空 dist 均同步清掉 tsbuildinfo，防 tsc 增量跳过落盘', { timeout: 60_000 }, () => {
  const pkgRoot = mkdtempSync(path.join(tmpdir(), 'helm-prune-force-'))
  try {
    touch(pkgRoot, 'tsconfig.json', JSON.stringify({
      compilerOptions: { outDir: 'dist', tsBuildInfoFile: './cache/pkg.tsbuildinfo' },
    }))
    const buildInfo = resolveTsBuildInfoFile(pkgRoot)!

    // 1. HELM_CLEAN_DIST=1 全量清空
    touch(pkgRoot, 'src/a.ts', 'export const a = 1')
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEnv = pruneDist({ pkgRoot, env: { HELM_CLEAN_DIST: '1' } })
    assert.equal(rEnv.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo), 'force wipe 必须同步删除 tsbuildinfo')

    // 2. --force CLI 标志全量清空
    touch(pkgRoot, 'dist/a.js', 'compiled')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rCli = runCleanDistCli(pkgRoot, ['--force'])
    assert.equal(rCli.mode, 'wiped')
    assert.ok(!existsSync(path.join(pkgRoot, 'dist')))
    assert.ok(!existsSync(buildInfo))

    // 3. dist 目录已为空（仅剩陈旧 dummy 被删后无任何 JS 产物）时自动清理 tsbuildinfo
    touch(pkgRoot, 'dist/stale.js', 'only stale')
    touch(pkgRoot, 'cache/pkg.tsbuildinfo', '{}')
    const rEmpty = pruneDist({ pkgRoot, env: {} })
    assert.equal(rEmpty.mode, 'pruned')
    assert.ok(!existsSync(buildInfo), '裁剪后无有效 JS 产物时必须清除 tsbuildinfo')
  } finally {
    rmSync(pkgRoot, { recursive: true, force: true })
  }
})

test('test-sharding：AST 纯度判定放行纯内存单测，拦截 DOM/env/子进程/文件写入/计时器覆写/不纯助手', { timeout: 60_000 }, () => {
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
  assert.equal(pure.pure, true, `预期纯测试通过，实际原因: ${pure.reasons.join(', ')}`)

  const cases: Array<[string, string]> = [
    ['happy-dom 导入', `import { GlobalRegistrator } from '@happy-dom/global-registrator'\nGlobalRegistrator.register()`],
    ['react-dom/client', `import { createRoot } from 'react-dom/client'\nvoid createRoot`],
    ['括号断言 globalThis', `import * as React from 'react'\n;(globalThis as Record<string, unknown>).React = React`],
    ['document/window 访问', `const el = document.createElement('div')\nwindow.history.back()\nvoid el`],
    ['process.env[] 写入与删除', `process.env['FOO'] = '1'\ndelete process.env['FOO']`],
    ['process.env 赋值', `process.env = {} as NodeJS.ProcessEnv`],
    ['process.stdin/chdir', `process.chdir('/tmp')\nprocess.stdin.resume()`],
    ['spawn / child_process', `import { spawn } from 'node:child_process'\nspawn('echo', ['hi'])`],
    ['fs 别名写入导入', `import { writeFileSync as wf } from 'node:fs'\nwf('a', 'b')`],
    ['http createServer / listen', `import http from 'node:http'\nhttp.createServer().listen(0)`],
    ['KernelRuntime / createHelm / DatabaseSync', `import { DatabaseSync } from 'node:sqlite'\nnew DatabaseSync(':memory:')`],
    ['timer 覆写与 t.mock.timers', `test('x', { timeout: 60_000 }, (t) => { t.mock.timers.enable({ apis: ['setTimeout'] }) })`],
    ['Object.assign 改写导入对象', `import { cfg } from '../src/cfg.js'\nObject.assign(cfg, { a: 1 })`],
  ]

  for (const [label, code] of cases) {
    const r = analyzeTestSourcePurity(ts, 'bad.test.ts', code)
    assert.equal(r.pure, false, `${label} 必须判定为非纯`)
    assert.ok(r.reasons.length > 0, `${label} 必须给出非空原因`)
  }
})

test('test-sharding：磁盘辅助模块递归追踪（含环路安全）、参数退回条件与 LPT 分片均衡', { timeout: 60_000 }, () => {
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

    // partitionFilesForSharding LPT 均衡分配且不重不漏
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
