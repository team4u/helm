/**
 * Prune orphaned stale artifacts from dist/ before incremental builds (replacing whole-directory
 * rmSync that destroys the tsc incremental cache).
 *
 * Why: with tsc incremental enabled, deleting the whole dist directory before every build
 * discards prior compiler output and forces a full rebuild (and when .tsbuildinfo is kept,
 * tsc can even misjudge nothing changed and skip re-emitting artifacts); but never cleaning
 * leaves stale outputs behind after package splits or file removals (e.g.
 * kernel/dist/main.js, kernel/dist/builtin-plugins/*), which payload / desktop then sweep
 * up in whole-directory packaging. This module surgically deletes only artifacts whose
 * source files no longer exist, plus empty directories; passing --force or setting
 * HELM_CLEAN_DIST=1 falls back to a full wipe that also removes the matching
 * .tsbuildinfo.
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** TS build artifact suffix table (longest suffix first, so .d.ts.map matches before .js.map / .d.ts). */
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

/** Resolve the absolute tsBuildInfoFile path from a package's tsconfig.json (if configured). */
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

/** Decide whether a dist-relative path still matches a source file present in src. */
function hasMatchingSource(srcDir, posixRel, preserveClients) {
  const parts = posixRel.split('/');
  // packages/plugins: dist/<pluginName>/client/** mirrors src/<pluginName>/client/** exactly.
  if (preserveClients && parts.length >= 3 && parts[1] === 'client') {
    return isExistingFile(path.join(srcDir, ...parts));
  }
  for (const spec of TS_OUTPUT_SPECS) {
    if (!posixRel.endsWith(spec.ext)) continue;
    const stem = posixRel.slice(0, -spec.ext.length);
    if (!stem) return false;
    // With preserveClients on, tsconfig excludes src/*/client; client .ts files must not count as dist JS evidence.
    if (preserveClients && parts.length >= 3 && parts[1] === 'client') return false;
    return spec.sources.some((srcExt) => isExistingFile(path.join(srcDir, `${stem}${srcExt}`)));
  }
  return false;
}

/** Remove empty directories inside dist bottom-up (the dist root itself is left for the caller). */
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
        // Ignore ENOENT from concurrent cleanup
      }
    }
  }
}

/**
 * Incrementally prune stale orphaned files and empty directories from dist/ based on the source tree.
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
    // If dist was emptied externally while .tsbuildinfo remains, tsc incremental mode skips re-emitting; the cache must go too.
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

  // With no valid JS artifacts left in dist, treat it as cold: drop .tsbuildinfo so tsc cannot skip output.
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
 * Shared CLI entry for each package's scripts/clean-dist.mjs.
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
