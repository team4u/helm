/**
 * Build-time helper for pnpm installed dependency closure (shared by the payload, CLI, and node
 * artifact assemblers; used only by build scripts and never included in runtime artifacts).
 *
 * Mechanism: pnpm attaches each package's resolved dependencies (including peer matches) as symlinks
 * under the real package directory's node_modules — walking dependency realpaths from any package
 * directory reconstructs the actual dependency graph without recomputing version resolution.
 * All functions are read-only and never write to the repository.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a dependency's real directory and package.json under a package directory
 * (returns null when optional and missing; returns an error object when required and missing).
 *
 * Resolution matches Node: walk upward through node_modules from the package's real directory —
 * workspace package dependencies live under their own node_modules, while dependencies of packages
 * inside the .pnpm virtual store are sibling symlinks (.pnpm/<n>@<v>/node_modules/<sibling>,
 * outside <n>'s own directory).
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
      } catch { /* dependency not at this level; continue walking upward */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    throw new Error('not found in any node_modules resolution level');
  } catch {
    if (optional) return null;
    return { error: `dependency ${name} is not installed at ${fromPkgDir} (run pnpm install first)` };
  }
}

/**
 * Build production dependency entries: dependencies (required) + optionalDependencies (platform-optional) +
 * peerDependencies (marked optional by peerDependenciesMeta.optional and skipped if uninstalled;
 * remaining peers are required at runtime and fail explicitly if missing).
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

/** Minimal semver satisfies check supporting exact / ^ / ~ / >= / <= / * (for build-time override decisions only; safe false-negatives). */
export function looseSatisfies(version, range) {
  if (range === '*' || range === '' || range === 'latest') return true;
  const clean = (v) => v.replace(/^[=v\s]+/, '');
  if (range.includes(' ')) {
    // Compound range (e.g. ">=1 <2"): all conditions must hold (rare || forms fall back to false).
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
 * Scan the closure for peer declarations that conflict with root dependencies: npm enforces strict
 * peer resolution (ERESOLVE) by default, whereas pnpm permits wider peer ranges (e.g. chord pins
 * peerOptional ws@8.21.0 while the repo locks 8.22.1).
 * Returns Map<peerName, rootVersion> for dist root package.json overrides
 * (always equal to the exact version pinned in root dependencies, per npm's rule that direct-dep overrides must match their spec).
 */
export function scanPeerOverrides(rootEntries) {
  // rootEntries: [{ name, version, fromPkgDir }] (root dependencies + resolution starting points).
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
      // Only emit overrides for root-pinned packages (unifies the whole npm tree to the exact
      // version already verified to satisfy these peers in the pnpm closure).
      if (root !== undefined && !looseSatisfies(root, spec)) overrides.set(peerName, root);
    }
    for (const { name: depName, optional } of prodDepEntries(pkgJson)) {
      const resolved = resolveDepRealDir(realDir, depName, optional);
      if (resolved && !resolved.error) queue.push(resolved);
    }
  }
  return overrides;
}

export { existsSync };
