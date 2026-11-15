/**
 * client-chunk-graph 纯函数单测：入口静态闭包、可达动态目标、
 * 异步单元划分（引用计数 / 共享 chunk 传递闭包）与前置依赖拓扑序。
 * 用合成 metafile 图固定每一步的期望输出（无 esbuild、无 IO）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectDynamicImportTargets,
  collectStaticImportClosure,
  computeAsyncChunkPlan,
} from '../src/client-chunk-graph.js'

interface NodeSpec {
  /** 静态 import 目标路径（原样进 imports[].path，由函数内 basename 归一）。 */
  static?: string[]
  /** 动态 import 目标路径。 */
  dynamic?: string[]
}

type MutableChunkGraph = Map<string, { imports: Array<{ path: string; kind: string; external?: boolean }> }>

function buildGraph(spec: Record<string, NodeSpec>): MutableChunkGraph {
  const graph: MutableChunkGraph = new Map()
  for (const [name, node] of Object.entries(spec)) {
    graph.set(name, {
      imports: [
        ...(node.static ?? []).map((path) => ({ path, kind: 'import-statement' })),
        ...(node.dynamic ?? []).map((path) => ({ path, kind: 'dynamic-import' })),
      ],
    })
  }
  return graph
}

test('入口静态闭包：深度优先展开静态 import，仅纳入图中产物（外部/未知路径不入闭包）', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./a.js', './b.js'], dynamic: [] },
    'a.js': { static: ['./nested/x.js'] },
    'b.js': { static: [] },
    'x.js': {},
  })
  graph.get('entry.js')!.imports!.push({ path: 'react', kind: 'import-statement' })
  const closure = collectStaticImportClosure(graph, 'entry.js')
  assert.deepEqual([...closure], ['entry.js', 'a.js', 'x.js', 'b.js'])
})

test('可达动态目标：baseClosure 与各动态目标静态闭包内的动态 import 全部纳入；external 动态导入不算', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./b.js'], dynamic: ['./dyn1.js'] },
    'b.js': { dynamic: ['./dyn2.js'] },
    'dyn1.js': { static: ['./only1.js'] },
    'dyn2.js': { static: ['./only2.js'] },
    'only1.js': { dynamic: ['./dyn3.js'] },
    'only2.js': {},
    'dyn3.js': {},
  })
  // external 动态导入（如已标记外部的 URL）不得计入
  graph.get('only2.js')!.imports!.push({ path: 'https://example.com/x.js', kind: 'dynamic-import', external: true })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const targets = collectDynamicImportTargets(graph, baseClosure)
  assert.deepEqual([...targets], ['dyn1.js', 'dyn2.js', 'dyn3.js'])
})

test('无动态导入：目标集合为空（快路径判定输入）', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./a.js'] },
    'a.js': {},
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  assert.equal(collectDynamicImportTargets(graph, baseClosure).size, 0)
})

test('异步单元划分：引用计数 >=2 提为共享 chunk，传递依赖一并共享；单引用模块留在各自单元', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./a.js', './b.js'], dynamic: ['./dyn1.js'] },
    'a.js': { static: ['./x.js'] },
    'b.js': { dynamic: ['./dyn2.js'] },
    'x.js': {},
    'dyn1.js': { static: ['./dir/sharedA.js', './only1.js'] },
    'dyn2.js': { static: ['./dir/sharedA.js', './only2.js'] },
    'sharedA.js': { static: ['./sharedB.js'] },
    'sharedB.js': {},
    'only1.js': { static: ['./lone.js'] },
    'lone.js': {},
    'only2.js': {},
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const dynamicTargets = collectDynamicImportTargets(graph, baseClosure)
  assert.deepEqual([...dynamicTargets], ['dyn1.js', 'dyn2.js'])
  const plan = computeAsyncChunkPlan(graph, baseClosure, dynamicTargets)
  // sharedA 被两个单元引用提为共享；其依赖 sharedB 虽单引用也随传递闭包提为共享
  assert.deepEqual([...plan.sharedAsyncChunks].sort(), ['sharedA.js', 'sharedB.js'])
  // 单引用模块不进共享集合
  assert.equal(plan.sharedAsyncChunks.has('only1.js'), false)
  assert.equal(plan.sharedAsyncChunks.has('lone.js'), false)
  assert.equal(plan.sharedAsyncChunks.has('only2.js'), false)
})

test('chunkDeps 拓扑序：共享 chunk 依赖在前、使用者在后，且含传递需要的共享 chunk', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: [], dynamic: ['./dyn1.js', './dyn2.js'] },
    'dyn1.js': { static: ['./sharedA.js'] },
    'dyn2.js': { static: ['./sharedA.js'] },
    'sharedA.js': { static: ['./sharedB.js'] },
    'sharedB.js': {},
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const dynamicTargets = collectDynamicImportTargets(graph, baseClosure)
  const plan = computeAsyncChunkPlan(graph, baseClosure, dynamicTargets)
  // 两单元都需前置 [sharedB, sharedA]（sharedB 是 sharedA 的依赖，先求值）
  assert.deepEqual(plan.chunkDeps['dyn1.js'], ['sharedB.js', 'sharedA.js'])
  assert.deepEqual(plan.chunkDeps['dyn2.js'], ['sharedB.js', 'sharedA.js'])
})

test('baseClosure 成员不参与异步划分：入口静态依赖即使被动态单元引用也不提为共享', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./base.js'], dynamic: ['./dyn1.js', './dyn2.js'] },
    'base.js': {},
    'dyn1.js': { static: ['./base.js'] },
    'dyn2.js': { static: ['./base.js'] },
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const dynamicTargets = collectDynamicImportTargets(graph, baseClosure)
  const plan = computeAsyncChunkPlan(graph, baseClosure, dynamicTargets)
  assert.equal(plan.sharedAsyncChunks.size, 0, 'baseClosure 成员由主包承载，不提共享')
  assert.deepEqual(plan.chunkDeps['dyn1.js'], [])
  assert.deepEqual(plan.chunkDeps['dyn2.js'], [])
})
