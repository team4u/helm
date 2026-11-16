/**
 * Pure-function unit tests for client-chunk-graph: the entry static closure, reachable dynamic targets,
 * async unit partitioning (reference counting / shared-chunk transitive closure), and the prerequisite
 * dependency topological order. Synthetic metafile graphs pin the expected output of every step
 * (no esbuild, no IO).
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  collectDynamicImportTargets,
  collectStaticImportClosure,
  computeAsyncChunkPlan,
} from '../src/client-chunk-graph.js'

interface NodeSpec {
  /** Static import target paths (fed verbatim into imports[].path, normalized by basename inside the function). */
  static?: string[]
  /** Dynamic import target paths. */
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

test('entry static closure: expands static imports depth-first, including only graph outputs (external/unknown paths stay out of the closure)', { timeout: 60_000 }, () => {
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

test('reachable dynamic targets: dynamic imports inside the baseClosure and inside each dynamic target\'s static closure are all included; external dynamic imports do not count', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./b.js'], dynamic: ['./dyn1.js'] },
    'b.js': { dynamic: ['./dyn2.js'] },
    'dyn1.js': { static: ['./only1.js'] },
    'dyn2.js': { static: ['./only2.js'] },
    'only1.js': { dynamic: ['./dyn3.js'] },
    'only2.js': {},
    'dyn3.js': {},
  })
  // external dynamic imports (e.g. URLs already marked external) must not count
  graph.get('only2.js')!.imports!.push({ path: 'https://example.com/x.js', kind: 'dynamic-import', external: true })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const targets = collectDynamicImportTargets(graph, baseClosure)
  assert.deepEqual([...targets], ['dyn1.js', 'dyn2.js', 'dyn3.js'])
})

test('no dynamic imports: the target set is empty (the fast-path decision input)', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./a.js'] },
    'a.js': {},
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  assert.equal(collectDynamicImportTargets(graph, baseClosure).size, 0)
})

test('async unit partitioning: reference count >=2 promotes to a shared chunk, transitive dependencies are shared along; single-reference modules stay in their own units', { timeout: 60_000 }, () => {
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
  // sharedA is referenced by two units and promoted to shared; its dependency sharedB joins via the
  // transitive closure even though it has a single referencing unit
  assert.deepEqual([...plan.sharedAsyncChunks].sort(), ['sharedA.js', 'sharedB.js'])
  // single-reference modules never join the shared set
  assert.equal(plan.sharedAsyncChunks.has('only1.js'), false)
  assert.equal(plan.sharedAsyncChunks.has('lone.js'), false)
  assert.equal(plan.sharedAsyncChunks.has('only2.js'), false)
})

test('chunkDeps topological order: shared chunks come before their consumers, including transitively required shared chunks', { timeout: 60_000 }, () => {
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
  // both units require the prerequisites [sharedB, sharedA] (sharedB is sharedA's dependency and evaluates first)
  assert.deepEqual(plan.chunkDeps['dyn1.js'], ['sharedB.js', 'sharedA.js'])
  assert.deepEqual(plan.chunkDeps['dyn2.js'], ['sharedB.js', 'sharedA.js'])
})

test('baseClosure members opt out of async partitioning: entry static dependencies are never promoted to shared even when referenced by dynamic units', { timeout: 60_000 }, () => {
  const graph = buildGraph({
    'entry.js': { static: ['./base.js'], dynamic: ['./dyn1.js', './dyn2.js'] },
    'base.js': {},
    'dyn1.js': { static: ['./base.js'] },
    'dyn2.js': { static: ['./base.js'] },
  })
  const baseClosure = collectStaticImportClosure(graph, 'entry.js')
  const dynamicTargets = collectDynamicImportTargets(graph, baseClosure)
  const plan = computeAsyncChunkPlan(graph, baseClosure, dynamicTargets)
  assert.equal(plan.sharedAsyncChunks.size, 0, 'baseClosure members are carried by the main package and never promoted to shared')
  assert.deepEqual(plan.chunkDeps['dyn1.js'], [])
  assert.deepEqual(plan.chunkDeps['dyn2.js'], [])
})
