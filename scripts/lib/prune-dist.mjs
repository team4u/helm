/**
 * 增量构建前清理 dist/ 孤立陈旧产物（取代整目录 rmSync 破坏 tsc 增量缓存）。
 *
 * Why：启用 tsc incremental 后若每次 build 前整目录删除 dist，会丢失已有编译产出与
 * 触发全量重编（甚至在保留 .tsbuildinfo 时导致 tsc 误判无变更而不重新落盘产物）；
 * 但直接不清理又会遗留拆包迁移或删改文件后的旧产物（如 kernel/dist/main.js、
 * kernel/dist/builtin-plugins/*），被 payload / desktop 整目录打包悄悄带走。
 * 本模块只精确删除源码中已不存在对应文件的产物与空目录；传入 --force 或设置
 * HELM_CLEAN_DIST=1 时回退全量清空并同步移除对应 .tsbuildinfo。
 */
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from 'node:fs';
import path from 'node:path';

/** TS 编译产物后缀表（长后缀优先匹配，确保 .d.ts.map 先于 .js.map / .d.ts）。 */
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

/** 从包的 tsconfig.json 解析 tsBuildInfoFile 绝对路径（若配置了的话）。 */
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

/** 判断 dist 相对路径是否匹配 src 中仍存在的源码。 */
function hasMatchingSource(srcDir, posixRel, preserveClients) {
  const parts = posixRel.split('/');
  // packages/plugins: dist/<pluginName>/client/** 与 src/<pluginName>/client/** 保持精确镜像。
  if (preserveClients && parts.length >= 3 && parts[1] === 'client') {
    return isExistingFile(path.join(srcDir, ...parts));
  }
  for (const spec of TS_OUTPUT_SPECS) {
    if (!posixRel.endsWith(spec.ext)) continue;
    const stem = posixRel.slice(0, -spec.ext.length);
    if (!stem) return false;
    // preserveClients 开启时 tsconfig 排除了 src/*/client，不得把 client 里的 .ts 当成 dist JS 依据。
    if (preserveClients && parts.length >= 3 && parts[1] === 'client') return false;
    return spec.sources.some((srcExt) => isExistingFile(path.join(srcDir, `${stem}${srcExt}`)));
  }
  return false;
}

/** 自底向上清理 dist 内的空目录（不删除 dist 根目录自身，由调用方按需处理）。 */
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
        // 忽略并发清理导致的 ENOENT
      }
    }
  }
}

/**
 * 按源码树增量清理 dist/ 中陈旧孤立文件与空目录。
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
    // 若 dist 已被外部删空但 .tsbuildinfo 仍在，tsc 增量模式会跳过重新输出产物；必须同步清缓存。
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

  // dist 内无任何有效 JS 产物时视为冷态，清掉 .tsbuildinfo 防 tsc 跳过输出。
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
 * 各包 scripts/clean-dist.mjs 共用 CLI 入口。
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
