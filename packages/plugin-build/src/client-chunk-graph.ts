/**
 * client.tsx 编译产物的 chunk 图规划（纯函数，无 IO / 无 esbuild 依赖）。
 *
 * 输入是 Pass 1 metafile 的「basename -> 输出元数据」映射（只消费 imports 边），
 * 输出代码分割所需的模块集合划分与前置依赖拓扑序。从 client-compiler.ts 的
 * 嵌套闭包提取为顶层纯函数，便于对划分 / 引用计数 / 拓扑排序做单元测试；
 * 遍历顺序与原实现逐语句一致（Set 迭代顺序参与产物注册顺序与 chunks 键序，
 * 不得重排）。
 */
import { basename } from 'node:path';

/** metafile 输出间依赖边（esbuild outputs[].imports 的结构子集）。 */
export interface ChunkImportEdge {
  path: string;
  kind: string;
  external?: boolean;
}

/** chunk 图节点：本模块只消费静态/动态 import 边。 */
export interface ChunkGraphNode {
  imports?: ReadonlyArray<ChunkImportEdge>;
}

/** chunk 图：产物 basename -> 节点元数据（esbuild metafile outputs 的结构子集）。 */
export type ChunkGraph = ReadonlyMap<string, ChunkGraphNode>;

/**
 * 入口静态 import 闭包（含入口自身）：按 imports 声明顺序深度优先展开，
 * 仅纳入图中存在的 basename（虚拟产物之外的输入不参与划分）。
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
 * 可达动态 import 目标集合：先扫 baseClosure 各成员的动态导入，再对每个动态
 * 目标广度遍历其静态闭包继续发现动态导入（动态链路上的静态依赖不再进 baseClosure，
 * 由各自异步单元承接）。
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

/** 分包规划结果：共享异步 chunk 集合与每个异步单元的前置共享依赖拓扑序。 */
export interface AsyncChunkPlan {
  /** 被 ≥2 个异步单元引用（含传递依赖）的模块：提为共享 chunk，经命名空间桥注册。 */
  sharedAsyncChunks: Set<string>;
  /** 异步单元 -> 加载该单元前必须先求值的共享 chunk 列表（依赖在前）。 */
  chunkDeps: Record<string, string[]>;
}

/**
 * 异步单元划分与前置依赖拓扑排序：
 * 1. 求每个动态目标的独占静态闭包（排除 baseClosure 成员）；
 * 2. 对闭包成员做引用计数，被 ≥2 个单元引用者提为共享 chunk，并沿其静态依赖
 *    传递纳入其他共享 chunk；
 * 3. 每个单元收集其需要的共享 chunk（含传递），按静态依赖后序 DFS 拓扑排序
 *    （依赖先于使用者求值）。
 */
export function computeAsyncChunkPlan(
  graph: ChunkGraph,
  baseClosure: ReadonlySet<string>,
  dynamicTargets: ReadonlySet<string>,
): AsyncChunkPlan {
  // 每个异步单元的独占静态闭包（不含单元自身）
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

  // 引用计数：被多个异步单元独占闭包引用的模块提为共享 chunk
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

  // 每个异步单元的前置共享依赖表（共享 chunk 间按拓扑顺序排列，依赖在前）
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
