/**
 * Pure-function async chunk graph planner for plugin `client.tsx` compilation (no I/O, no esbuild dependency).
 *
 * Consumes Pass 1 metafile basename -> output metadata mapping (reading `imports` edges only) and computes
 * the module partitioning for code splitting plus prerequisite topological order. Extracted from
 * `client-compiler.ts` as pure functions so partitioning, reference counting, and topological sorting can
 * be unit-tested independently. Iteration order matches the original inline algorithm statement-for-statement
 * (preserving Set iteration order for registration and `chunks` keys).
 */
import { basename } from 'node:path';

/** Dependency edge between metafile outputs (subset of esbuild `outputs[].imports`). */
export interface ChunkImportEdge {
  path: string;
  kind: string;
  external?: boolean;
}

/** Chunk graph node: only static and dynamic import edges are inspected. */
export interface ChunkGraphNode {
  imports?: ReadonlyArray<ChunkImportEdge>;
}

/** Chunk graph: output basename -> node metadata. */
export type ChunkGraph = ReadonlyMap<string, ChunkGraphNode>;

/**
 * Entry static import closure (includes the entry itself): depth-first traversal following static
 * `import-statement` edges, keeping only basenames present in the output graph.
 */
export function collectStaticImportClosure(graph: ChunkGraph, entry: string): Set<string> {
  const closure = new Set<string>([entry]);
  const visit = (file: string): void => {
    const node = graph.get(file);
    if (!node || !node.imports) return;
    for (const imp of node.imports) {
      if (imp.kind === 'import-statement') {
        const b = basename(imp.path);
        if (graph.has(b) && !closure.has(b)) {
          closure.add(b);
          visit(b);
        }
      }
    }
  };
  visit(entry);
  return closure;
}

/**
 * Reachable dynamic import targets: scans dynamic imports inside `baseClosure`, then breadth-first
 * traverses each target's static closure to discover transitive dynamic imports.
 */
export function collectDynamicImportTargets(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
): Set<string> {
  const dynamicTargets = new Set<string>();
  const dynQueue: string[] = [];
  const checkDynImports = (file: string): void => {
    const node = graph.get(file);
    if (!node || !node.imports) return;
    for (const imp of node.imports) {
      if (imp.kind === 'dynamic-import' && !imp.external) {
        const b = basename(imp.path);
        if (graph.has(b) && !dynamicTargets.has(b)) {
          dynamicTargets.add(b);
          dynQueue.push(b);
        }
      }
    }
  };
  for (const f of baseClosure) checkDynImports(f);
  while (dynQueue.length > 0) {
    const d = dynQueue.shift()!;
    const visited = new Set<string>([d]);
    const qStatic = [d];
    while (qStatic.length > 0) {
      const cur = qStatic.shift()!;
      checkDynImports(cur);
      const node = graph.get(cur);
      if (node && node.imports) {
        for (const imp of node.imports) {
          if (imp.kind === 'import-statement') {
            const b = basename(imp.path);
            if (graph.has(b) && !visited.has(b)) {
              visited.add(b);
              qStatic.push(b);
            }
          }
        }
      }
    }
  }
  return dynamicTargets;
}

/** Partitioning plan: shared async chunks plus prerequisite topological order per dynamic unit. */
export interface AsyncChunkPlan {
  /** Modules referenced by >= 2 async units (including transitive dependencies), registered via namespace bridge. */
  sharedAsyncChunks: Set<string>;
  /** Async unit -> ordered list of prerequisite shared chunks (dependencies precede consumers). */
  chunkDeps: Record<string, string[]>;
}

/**
 * Partition async units and topologically sort shared prerequisites:
 * 1. Compute each dynamic target's exclusive static closure (excluding `baseClosure` members);
 * 2. Reference-count across dynamic closures; promote modules referenced by >= 2 units to `sharedAsyncChunks`
 *    and transitively include their static dependencies;
 * 3. For each dynamic unit, topologically sort its required shared chunks via post-order DFS.
 */
export function computeAsyncChunkPlan(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
  dynamicTargets: ReadonlySet<string>,
): AsyncChunkPlan {
  const dynStaticClosures = new Map<string, Set<string>>();
  for (const d of dynamicTargets) {
    const closure = new Set<string>();
    const visitDyn = (f: string): void => {
      const node = graph.get(f);
      if (!node || !node.imports) return;
      for (const imp of node.imports) {
        if (imp.kind === 'import-statement') {
          const b = basename(imp.path);
          if (graph.has(b) && !baseClosure.has(b) && !closure.has(b)) {
            closure.add(b);
            visitDyn(b);
          }
        }
      }
    };
    visitDyn(d);
    dynStaticClosures.set(d, closure);
  }

  const refCount = new Map<string, number>();
  for (const [, closure] of dynStaticClosures) {
    for (const chunk of closure) {
      refCount.set(chunk, (refCount.get(chunk) ?? 0) + 1);
    }
  }
  const sharedAsyncChunks = new Set<string>();
  for (const [chunk, count] of refCount) {
    if (count >= 2) sharedAsyncChunks.add(chunk);
  }
  const addSharedDeps = (chunk: string): void => {
    const node = graph.get(chunk);
    if (!node || !node.imports) return;
    for (const imp of node.imports) {
      if (imp.kind === 'import-statement') {
        const b = basename(imp.path);
        if (graph.has(b) && !baseClosure.has(b) && !sharedAsyncChunks.has(b)) {
          sharedAsyncChunks.add(b);
          addSharedDeps(b);
        }
      }
    }
  };
  for (const chunk of Array.from(sharedAsyncChunks)) addSharedDeps(chunk);

  const chunkDeps: Record<string, string[]> = {};
  for (const d of dynamicTargets) {
    const staticClosure = dynStaticClosures.get(d) ?? new Set<string>();
    const neededShared = new Set<string>();
    for (const c of staticClosure) {
      if (sharedAsyncChunks.has(c)) neededShared.add(c);
    }
    const collectMoreShared = (c: string): void => {
      const node = graph.get(c);
      if (!node || !node.imports) return;
      for (const imp of node.imports) {
        if (imp.kind === 'import-statement') {
          const b = basename(imp.path);
          if (sharedAsyncChunks.has(b) && !neededShared.has(b)) {
            neededShared.add(b);
            collectMoreShared(b);
          }
        }
      }
    };
    for (const c of Array.from(neededShared)) collectMoreShared(c);

    const sorted: string[] = [];
    const visited = new Set<string>();
    const topoVisit = (c: string): void => {
      if (visited.has(c)) return;
      visited.add(c);
      const node = graph.get(c);
      if (node && node.imports) {
        for (const imp of node.imports) {
          if (imp.kind === 'import-statement') {
            const b = basename(imp.path);
            if (neededShared.has(b)) topoVisit(b);
          }
        }
      }
      sorted.push(c);
    };
    for (const c of neededShared) topoVisit(c);
    chunkDeps[d] = sorted;
  }

  return { sharedAsyncChunks, chunkDeps };
}
