/**
 * incremental build before clean up dist/ isolated stale artifact (take proxy whole directory rmSync break tsc incremental cache).
 *
 * Why: enable tsc incremental after if each time build before whole directory delete dist, will lose already has compile produce out and
 * trigger all amount heavy edit (even in keep .tsbuildinfo when leads to tsc mistakenly judge without change while do not re- artifact);
 * but directly do not clean up again will legacy split package migration or delete change file after old artifact (such as kernel/dist/main.js,
 * kernel/dist/builtin-plugins/*), by payload / desktop whole directory bundle silently carries away.
 * this module only precise delete source code in already missing for should file artifact and empty directory; pass --force or settings
 * HELM_CLEAN_DIST=1 when fall back all amount empty and sync remove for should .tsbuildinfo.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** TS compile artifact suffix table (long suffix takes precedence match, ensure .d.ts.map first at .js.map / .d.ts). */
const TS_OUTPUT_SPECS = [
  { ext: '.d.ts.map', sources: ['.ts', '.tsx'] },
  { ext: '.d.mts.map', sources: ['.mts'] },
  { ext: '.d.cts.map', sources: ['.cts'] },
  { ext: '.js.map', sources: ['.ts', '.tsx'] },
  { ext: '.jsx.map', sources: ['.tsx'] },
  { ext: '.mjs.map', sources: ['.mts'] },
  { ext: '.cjs.map', sources: ['.cts'] },
  { ext: '.d.ts', sources: ['.ts', '.tsx'] },
  { ext: '.d.mts', sources: ['.mts'] },
  { ext: '.d.cts', sources: ['.cts'] },
  { ext: '.js', sources: ['.ts', '.tsx'] },
  { ext: '.jsx', sources: ['.tsx'] },
  { ext: '.mjs', sources: ['.mts'] },
  { ext: '.cjs', sources: ['.cts'] },
];

const JS_OUTPUT_SUFFIXES = ['.js', '.mjs', '.cjs'];

function isExistingFile(filePath) {
  try {
    return lstatSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** from package tsconfig.json parse tsBuildInfoFile absolute path (if config speech). */
export function resolveTsBuildInfoFile(pkgRoot) {
  const tsconfigPath = path.join(pkgRoot, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    const rel = parsed?.compilerOptions?.tsBuildInfoFile;
    if (typeof rel !== 'string' || rel.trim() === '') return null;
    return path.resolve(pkgRoot, rel);
  } catch {
    return null;
  }
}

/** decide dist relative path is otherwise match src in still store in source code. */
function hasMatchingSource(srcDir, posixRel, preserveClients) {
  const parts = posixRel.split('/');
  // packages/plugins: dist/<pluginName>/client/** and src/<pluginName>/client/** keep precise mirror.
  if (preserveClients && parts.length >= 3 && parts[1] === 'client') {
    return isExistingFile(path.join(srcDir, ...parts));
  }
  for (const spec of TS_OUTPUT_SPECS) {
    if (!posixRel.endsWith(spec.ext)) continue;
    const stem = posixRel.slice(0, -spec.ext.length);
    if (!stem) return false;
    // preserveClients open start when tsconfig exclude src/*/client, must not client in .ts when into dist JS based on.
    if (preserveClients && parts.length >= 3 && parts[1] === 'client') return false;
    return spec.sources.some((srcExt) => isExistingFile(path.join(srcDir, `${stem}${srcExt}`)));
  }
  return false;
}

/** self bottom to on clean up dist inside empty directory (do not delete dist directory itself, by caller on demand handle). */
function pruneEmptySubdirs(dir, removedDirs) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (ent.isDirectory() && !ent.isSymbolicLink()) {
      const sub = path.join(dir, ent.name);
      pruneEmptySubdirs(sub, removedDirs);
      try {
        if (readdirSync(sub).length === 0) {
          rmdirSync(sub);
          removedDirs.push(sub);
        }
      } catch {
        // ignore concurrency clean up leads to ENOENT
      }
    }
  }
}

/**
 * by source code tree incremental clean up dist/ in stale isolated file and empty directory.
 * @param {{ pkgRoot: string, force?: boolean, preserveClients?: boolean, tsBuildInfoFile?: string | null, env?: NodeJS.ProcessEnv }} options
 * @returns {{ mode: 'wiped' | 'pruned' | 'noop', removedFiles: string[], removedDirs: string[] }}
 */
export function pruneDist(options) {
  const pkgRoot = path.resolve(options.pkgRoot);
  const srcDir = path.join(pkgRoot, 'src');
  const distDir = path.join(pkgRoot, 'dist');
  const preserveClients = options.preserveClients === true;
  const env = options.env ?? process.env;
  const force = options.force === true || env.HELM_CLEAN_DIST === '1';
  const buildInfo =
    options.tsBuildInfoFile !== undefined ? options.tsBuildInfoFile : resolveTsBuildInfoFile(pkgRoot);

  if (force) {
    rmSync(distDir, { recursive: true, force: true });
    if (buildInfo) rmSync(buildInfo, { force: true });
    return { mode: 'wiped', removedFiles: [], removedDirs: [] };
  }

  if (!existsSync(distDir)) {
    // if dist already by external delete empty but .tsbuildinfo still in,tsc incremental pattern will skip re- output artifact; must sync clean cache.
    if (buildInfo) rmSync(buildInfo, { force: true });
    return { mode: 'noop', removedFiles: [], removedDirs: [] };
  }

  const removedFiles = [];
  const removedDirs = [];
  let keptJsCount = 0;

  const visit = (curDir, prefix) => {
    for (const ent of readdirSync(curDir, { withFileTypes: true })) {
      const abs = path.join(curDir, ent.name);
      const posixRel = prefix === '' ? ent.name : `${prefix}/${ent.name}`;
      if (ent.isDirectory() && !ent.isSymbolicLink()) {
        visit(abs, posixRel);
        continue;
      }
      if (ent.isFile() && !ent.isSymbolicLink() && hasMatchingSource(srcDir, posixRel, preserveClients)) {
        if (JS_OUTPUT_SUFFIXES.some((s) => posixRel.endsWith(s))) {
          keptJsCount += 1;
        }
        continue;
      }
      rmSync(abs, { recursive: true, force: true });
      removedFiles.push(posixRel);
    }
  };

  visit(distDir, '');
  pruneEmptySubdirs(distDir, removedDirs);

  // dist inside without any valid JS artifact when treated as cold state, clean .tsbuildinfo guard against tsc skip output.
  if (keptJsCount === 0 && buildInfo) {
    rmSync(buildInfo, { force: true });
  }

  return {
    mode: removedFiles.length > 0 || removedDirs.length > 0 ? 'pruned' : 'noop',
    removedFiles,
    removedDirs,
  };
}

/**
 * each package scripts/clean-dist.mjs shared use CLI entry.
 * @param {string} pkgRoot
 * @param {string[]} argv
 * @param {{ preserveClients?: boolean }} [options]
 */
export function runCleanDistCli(pkgRoot, argv = process.argv.slice(2), options = {}) {
  const force = argv.includes('--force') || argv.includes('-f');
  return pruneDist({
    pkgRoot,
    force,
    preserveClients: options.preserveClients === true,
  });
}
