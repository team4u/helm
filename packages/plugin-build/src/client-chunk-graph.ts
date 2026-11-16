/**
 * client.tsx compile artifact chunk diagram rule plan (pure function, without IO / without esbuild dependency).
 *
 * input is Pass 1 metafile basename -> output metadata mapping (only consume imports edge),
 * output code split which must module set divide and pre- dependency topology order. from client-compiler.ts 
 * embed set closed package extract is top-level pure function, convenient at for divide / reference counter / topology sort do unit test;
 * iterate order and original implement one by one statement consistent (Set iterate order reference and artifact register order and chunks key order,
 * must not heavy arrange).
 */
import { basename } from 'node:path';

/** metafile output between dependency edge (esbuild outputs[].imports structure sub- collection). */
export interface ChunkImportEdge {
  path: string;
  kind: string;
  external?: boolean;
}

/** chunk diagram node: this module only consume static/motion state import edge. */
export interface ChunkGraphNode {
  imports?: ReadonlyArray<ChunkImportEdge>;
}

/** chunk diagram: artifact basename -> node metadata (esbuild metafile outputs structure sub- collection). */
export type ChunkGraph = ReadonlyMap<string, ChunkGraphNode>;

/**
 * entry static import closed package (contains entry itself): by imports declaration order deep takes precedence expand,
 * only accept diagram in store in basename(virtual artifact of outside input does not participate divide).
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
 * can reach motion state import target set: first scan baseClosure each member motion state import, again for each motion state
 * target broad iterate its static closed package continue discover motion state import (motion state link on static dependency no longer enter baseClosure,
 * by each async unit bear connect).
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

/** package rule plan result: sharing async chunk set and each async unit pre- sharing dependency topology order. */
export interface AsyncChunkPlan {
  /** by ≥2 async unit reference (contains pass dependency) module: mention is sharing chunk, via naming empty between bridge register. */
  sharedAsyncChunks: Set<string>;
  /** async unit -> load the unit before must first seek value sharing chunk list (dependency in before). */
  chunkDeps: Record<string, string[]>;
}

/**
 * async unit divide and pre- dependency topology sort:
 * 1. seek each motion state target exclusive static closed package (exclude baseClosure member);
 * 2. for closed package member do reference counter, by ≥2 unit reference mention is sharing chunk, and along its static dependency
 *    pass accept other sharing chunk;
 * 3. each unit collect its need to sharing chunk(contains pass), by static dependency after order DFS topology sort
 *    (dependency first at use seek value).
 */
export function computeAsyncChunkPlan(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
  dynamicTargets: ReadonlySet<string>,
): AsyncChunkPlan {
  // each async unit exclusive static closed package (excludes unit itself)
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

  // reference counter: by multiple async unit exclusive closed package reference module mention is sharing chunk
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

  // each async unit pre- sharing dependency table (sharing chunk between by topology order arrange column, dependency in before)
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
