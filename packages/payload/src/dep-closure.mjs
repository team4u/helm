/**
 * pnpm installed dependency closure build-time helper (used only by payload build scripts,
 * never shipped as a runtime artifact).
 *
 * mechanism:pnpm each package parse result (contains peer match for) with symlink hang in package real directory
 * node_modules under - - from any package directory one by one dependency realpath i.e. can restore real dependency graph, no need to heavy compute
 * version choose. all function only read, never write repository.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';

/**
 * parse a certain package directory under a dependency real directory and package.json(optional missing return null, must choose missing return error).
 *
 * parse rule and Node consistent: from package real directory one by one layer on trace node_modules- -workspace package dependency in
 * itself node_modules under;.pnpm virtual clap shop inside package dependency is same layer brother symlink
 * (.pnpm/<n>@<v>/node_modules/<sibling>, do not in <n> itself directory in).
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
      } catch { /* this layer without this dependency, continue on trace */ }
      const parent = path.dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
    throw new Error('do not in any node_modules parse tier inside');
  } catch {
    if (optional) return null;
    return { error: `dependency ${name} not installed at ${fromPkgDir}(first pnpm install)` };
  }
}

/**
 * produce dependency manifest:dependencies(must must)+ optionalDependencies(platform optional)+
 * peerDependencies(peerDependenciesMeta.optional mark record treated as optional, not installed then skip;
 * the rest peer is runtime must must, missing explicit errors).
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

/** extreme simple semver satisfies: support precise / ^ / ~ / >= / *(only build phase override decide use, mistakenly judge direction security). */
export function looseSatisfies(version, range) {
  if (range === '*' || range === '' || range === 'latest') return true;
  const clean = (v) => v.replace(/^[=v\s]+/, '');
  if (range.includes(' ')) {
    // re- together scope (such as ">=1 <2"): all condition also satisfy (ignore || of outside rare form, such as fall back false).
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
 * scan closed package inside and dependency conflict peer declaration:npm by default strictly peer parse (ERESOLVE),
 * pnpm install yet allows (such as chord peerOptional pin ws@8.21.0 while repository lock 8.22.1).
 * return Map<peerName, rootVersion> - - as dist  package.json  overrides
 * (value constant equals directly dependency precise version, conforms to npmdirectly dependency override must same specrule).
 */
export function scanPeerOverrides(rootEntries) {
  // rootEntries: [{ name, version, fromPkgDir }](dependency + parse start point).
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
      // only handle hold has name: version i.e. eventually override value (npm side all tree unify to version,
      // and pnpm closed package actual match for consistent - -pnpm correct is use version satisfy these peer).
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
