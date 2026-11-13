/**
 * pnpm 已安装依赖闭包的构建期工具（payload build 与 desktop assemble-hub 共享；
 * 仅构建脚本使用，不进任何运行时产物）。
 *
 * 机制：pnpm 把每个包的解析结果（含 peer 配对）以符号链接挂在包真实目录的
 * node_modules 下——从任意包目录逐依赖 realpath 即可还原真实依赖图，无需重算
 * 版本选择。所有函数只读，绝不写仓库。
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * 解析某包目录下一个依赖的真实目录与 package.json（optional 缺失返回 null，必选缺失返回 error）。
 *
 * 解析规则与 Node 一致：从包真实目录逐层上溯 node_modules——workspace 包的依赖在
 * 自身 node_modules 下；.pnpm 虚拍店内包的依赖是同层兄弟符号链接
 * （.pnpm/<n>@<v>/node_modules/<sibling>，不在 <n> 自己目录里）。
 */
export function resolveDepRealDir(fromPkgDir, name, optional) {
  try {
    const base = realpathSync(fromPkgDir);
    let cur = base;
    for (;;) {
      try {
        const direct = path.join(cur, 'node_modules', name);
        const st = lstatSync(direct);
        if (st.isSymbolicLink() || st.isDirectory()) {
          const realDir = realpathSync(direct);
          return { realDir, pkgJson: JSON.parse(readFileSync(path.join(realDir, 'package.json'), 'utf-8')) };
        }
      } catch { /* 本层无此依赖，继续上溯 */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    throw new Error('不在任何 node_modules 解析层级内');
  } catch {
    if (optional) return null;
    return { error: `依赖 ${name} 未安装于 ${fromPkgDir}（先 pnpm install）` };
  }
}

/**
 * 生产依赖清单：dependencies（必需）+ optionalDependencies（平台可选）+
 * peerDependencies（peerDependenciesMeta.optional 标记者视为可选，未安装则跳过；
 * 其余 peer 为运行时必需，缺失显式报错）。
 */
export function prodDepEntries(pkgJson) {
  const meta = pkgJson.peerDependenciesMeta ?? {};
  const out = [];
  for (const name of Object.keys(pkgJson.dependencies ?? {})) out.push({ name, optional: false });
  for (const name of Object.keys(pkgJson.optionalDependencies ?? {})) out.push({ name, optional: true });
  for (const name of Object.keys(pkgJson.peerDependencies ?? {})) {
    out.push({ name, optional: meta[name]?.optional === true });
  }
  return out;
}

/** 极简 semver satisfies：支持精确 / ^ / ~ / >= / *（仅构建期 override 判定用，误判方向安全）。 */
export function looseSatisfies(version, range) {
  if (range === '*' || range === '' || range === 'latest') return true;
  const clean = (v) => v.replace(/^[=v\s]+/, '');
  if (range.includes(' ')) {
    // 复合范围（如 ">=1 <2"）：全部条件同时满足（忽略 || 之外的罕见形态，如实回退 false）。
    return range.split(/\s+/).every((part) => looseSatisfies(version, part));
  }
  const v = clean(version).split('.').map(Number);
  const m = /^(?:\^|~|>=|<=)?(.*)$/.exec(clean(range));
  if (!m) return false;
  const r = m[1].split('.').map((x) => Number.parseInt(x, 10));
  const op = clean(range).startsWith('^') ? '^' : clean(range).startsWith('~') ? '~' : clean(range).startsWith('>=') ? '>=' : clean(range).startsWith('<=') ? '<=' : '=';
  if (r.some(Number.isNaN) || v.some(Number.isNaN)) return clean(version) === clean(range);
  if (op === '=') return v.join('.') === r.join('.');
  if (op === '^') return v[0] === r[0] && cmp(v, r) >= 0;
  if (op === '~') return v[0] === r[0] && v[1] === r[1] && cmp(v, r) >= 0;
  if (op === '>=') return cmp(v, r) >= 0;
  if (op === '<=') return cmp(v, r) <= 0;
  return false;
}

const cmp = (a, b) => (a[0] - b[0]) || (a[1] - b[1]) || ((a[2] ?? 0) - (b[2] ?? 0));

/**
 * 扫描闭包内与根依赖冲突的 peer 声明：npm 默认严格 peer 解析（ERESOLVE），
 * pnpm 安装却允许（如 chord peerOptional 钉 ws@8.21.0 而仓库锁定 8.22.1）。
 * 返回 Map<peerName, rootVersion> —— 作为 dist 根 package.json 的 overrides
 * （值恒等于根直接依赖的精确版本，符合 npm「直接依赖 override 须同 spec」规则）。
 */
export function scanPeerOverrides(rootEntries) {
  // rootEntries: [{ name, version, fromPkgDir }]（根依赖 + 解析起点）。
  const rootVersion = new Map(rootEntries.map((e) => [e.name, e.version]));
  const overrides = new Map();
  const visited = new Set();
  const queue = rootEntries.map((e) => resolveDepRealDir(e.fromPkgDir, e.name, false)).filter((r) => !r.error);
  while (queue.length > 0) {
    const { realDir, pkgJson } = queue.shift();
    if (visited.has(realDir)) continue;
    visited.add(realDir);
    for (const [peerName, spec] of Object.entries(pkgJson.peerDependencies ?? {})) {
      const root = rootVersion.get(peerName);
      // 只处理根持有的名字：根版本即最终 override 值（npm 侧全树统一到根版本，
      // 与 pnpm 闭包的实际配对一致——pnpm 正是用根版本满足的这些 peer）。
      if (root !== undefined && !looseSatisfies(root, spec)) overrides.set(peerName, root);
    }
    for (const { name: depName, optional } of prodDepEntries(pkgJson)) {
      const resolved = resolveDepRealDir(realDir, depName, optional);
      if (resolved && !resolved.error) queue.push(resolved);
    }
  }
  return overrides;
}

/** 兼容 assemble-hub 既有签名：复制包时排除 node_modules 符号链接条目的过滤器工厂。 */
export function packageCopyFilter(srcDir) {
  return (candidate) => {
    const rel = path.relative(srcDir, candidate);
    if (rel === '') return true;
    const segs = rel.split(path.sep);
    const nmIdx = segs.indexOf('node_modules');
    if (nmIdx === -1) return true;
    if (segs.length === nmIdx + 1) return true; // node_modules 目录本身：继续遍历以保留真实条目
    const topEntry = path.join(srcDir, ...segs.slice(0, nmIdx + 2));
    try {
      return !lstatSync(topEntry).isSymbolicLink();
    } catch {
      return false;
    }
  };
}

export { existsSync };
