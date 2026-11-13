#!/usr/bin/env node
/**
 * Hub payload 零依赖启动入口（随 payload 目录分发，Node >= 24，无任何 npm 依赖）。
 *
 * 命令：
 *   node start.mjs check   校验 manifest/entries/checksums（严格相对路径），并按
 *                          dist 根 package.json dependencies 从 kernel/protocol/cli
 *                          三个运行时入口逐依赖做真实解析（createRequire——与运行时
 *                          Node 解析语义一致；import.meta.resolve 的 parent 参数在
 *                          当前 Node 默认被忽略，不可用于此），随后实测运行时能力：
 *                          import node:sqlite、加载 esbuild 并真实 transform 一段
 *                          JS（覆盖插件 client 编译链路）。check 绝不启动 Hub。
 *   node start.mjs start   依赖验收通过后拉起 kernel 入口（dist/main.js），透传环境
 *                          变量与信号。
 *
 * 退出码（绝不静默降级）：
 *   0  校验通过且依赖可解析、运行时能力实测成功（或 start 的子进程正常退出）
 *   1  用法错误或 payload 布局/校验和/manifest 契约损坏
 *   3  布局合法但依赖缺失或运行时能力实测失败（如 esbuild 平台二进制不可用）
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const payloadRoot = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ERROR = 1;
const EXIT_DEPS_MISSING = 3;

const usage = () => {
  console.error('用法: node start.mjs <check|start>');
  process.exit(EXIT_ERROR);
};

/** 单个 entry 路径的严格契约：非空、相对、POSIX 分隔、无 .. 越界。 */
function assertEntryPath(key, rel) {
  const problems = [];
  if (typeof rel !== 'string' || rel.length === 0) problems.push(`- ${key}: 路径必须是非空字符串`);
  else {
    if (path.isAbsolute(rel) || rel.includes('\\')) problems.push(`- ${key} (${rel}): 必须是相对 POSIX 路径`);
    const segments = rel.split('/');
    if (segments.includes('..') || segments.includes('')) problems.push(`- ${key} (${rel}): 不允许 .. / 空段`);
    const abs = path.resolve(payloadRoot, rel);
    if (!abs.startsWith(`${payloadRoot}${path.sep}`)) problems.push(`- ${key} (${rel}): 解析越出 payload 根`);
  }
  return problems;
}

/** 读取并做严格契约校验（不假设多余字段；异常显式报错退出 1）。 */
function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf-8'));
  } catch (err) {
    console.error(`[payload] manifest.json 缺失或非法: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  if (manifest.formatVersion !== 1) {
    console.error(`[payload] manifest.formatVersion 不支持: ${String(manifest.formatVersion)}（期望 1）`);
    process.exit(EXIT_ERROR);
  }
  const entries = manifest.entries ?? {};
  const checksums = manifest.entryChecksums ?? {};
  const entryKeys = Object.keys(entries).sort();
  const checksumKeys = Object.keys(checksums).sort();
  if (entryKeys.length === 0 || JSON.stringify(entryKeys) !== JSON.stringify(checksumKeys)) {
    console.error(`[payload] manifest.entries 与 entryChecksums 键不一致或为空: ${entryKeys} vs ${checksumKeys}`);
    process.exit(EXIT_ERROR);
  }
  // 路径严格校验：所有问题一次性列全后再退出（绝不带着可疑路径继续做 IO）。
  const pathProblems = Object.entries(entries).flatMap(([key, rel]) => assertEntryPath(key, rel));
  if (pathProblems.length > 0) {
    console.error(`[payload] manifest.entries 路径契约失败：\n${pathProblems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  return { manifest, entries, checksums };
}

/** 逐入口校验存在性与 sha256；失败列全后一次性退出 1。 */
function checkLayout(entries, checksums, version) {
  const problems = [];
  for (const [key, rel] of Object.entries(entries)) {
    const abs = path.resolve(payloadRoot, rel);
    let actual = null;
    try {
      actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    } catch {
      problems.push(`- ${key} (${rel}): 文件缺失或不可读`);
      continue;
    }
    if (actual !== checksums[key]) problems.push(`- ${key} (${rel}): checksum 不一致（期望 ${checksums[key]}，实际 ${actual}）`);
  }
  if (problems.length > 0) {
    console.error(`[payload] 布局校验失败：\n${problems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  console.log(`[payload] 布局校验通过: ${Object.keys(entries).length} 项入口 checksum 一致 (version ${String(version)})`);
}

/**
 * 依赖解析：以 dist 根 package.json dependencies 为契约清单，从 kernel / protocol /
 * cli 三个运行时入口文件出发用 createRequire(entry).resolve 做真实解析——与 Hub
 * 运行时 Node 的解析语义同源（import.meta.resolve 的第二参数在 Node 默认被忽略，
 * 之前的实现会在任意宿主目录下误判）。
 */
function resolveProdDeps(entries) {
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(path.join(payloadRoot, 'package.json'), 'utf-8')).dependencies ?? {};
  } catch (err) {
    console.error(`[payload] 根 package.json 缺失或非法: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  const bases = {
    kernel: path.resolve(payloadRoot, entries.kernel ?? 'kernel/dist/main.js'),
    protocol: path.resolve(payloadRoot, entries.protocol ?? 'protocol/dist/index.js'),
    cli: path.resolve(payloadRoot, entries.cli ?? 'cli/dist/index.js'),
  };
  const requires = Object.fromEntries(
    Object.entries(bases).map(([name, entry]) => [name, createRequire(entry)]),
  );
  /**
   * 单点解析：require.resolve → <name>/package.json 子路径 → node_modules 逐层上溯。
   * 后两级回退不是妥协：@earendil-works/* 是 ESM-only（exports 仅 import 条目），
   * require.resolve 会报 ERR_PACKAGE_PATH_NOT_EXPORTED，但运行时 ESM import 完全可用；
   * 逐层上溯复刻 Node 解析算法的存在性判定，仅验证包已安装于可解析位置。
   */
  const resolvable = (req, entry, name) => {
    try {
      req.resolve(name);
      return true;
    } catch { /* 继续回退 */ }
    try {
      req.resolve(`${name}/package.json`);
      return true;
    } catch { /* 继续回退 */ }
    let cur = path.dirname(entry);
    for (;;) {
      if (existsSync(path.join(cur, 'node_modules', name, 'package.json'))) return true;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  };
  const missing = [];
  const names = Object.keys(deps).sort();
  for (const name of names) {
    for (const [base, req] of Object.entries(requires)) {
      if (!resolvable(req, bases[base], name)) missing.push(`${name}（自 ${base} 入口）`);
    }
  }
  return { total: names.length, missing };
}

/**
 * 运行时能力实测（只测依赖能力，不执行 Hub）：
 * - node:sqlite：kernel 持久层的 Node 内置模块（Node >= 22.5 且 --experimental 转正后可用）；
 * - esbuild：真实加载 + transform 一段 JS——覆盖插件 client 编译链路，同时实测
 *   当前平台的 esbuild 原生二进制（--ignore-scripts 安装下二进制由 optionalDependencies
 *   平台包提供，postinstall 校验脚本不可用，必须实测而非只看可解析）。
 */
async function probeRuntimeCapabilities(entries) {
  const failures = [];
  try {
    await import('node:sqlite');
  } catch (err) {
    failures.push(`node:sqlite 不可用（Node 版本过低或构建缺内置模块）: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const kernelEntry = path.resolve(payloadRoot, entries.kernel ?? 'kernel/dist/main.js');
    const esbuild = createRequire(kernelEntry)('esbuild');
    const out = await esbuild.transform('const answer = 42\n', { loader: 'js' });
    if (typeof out?.code !== 'string' || !out.code.includes('answer')) throw new Error('transform 输出异常');
  } catch (err) {
    failures.push(`esbuild 实测失败（平台二进制缺失或不可用）: ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

function reportDeps(result) {
  if (result.missing.length === 0) {
    console.log(`[payload] 生产依赖全部可解析 (${result.total}/${result.total}，kernel/protocol/cli 三入口)` );
    return;
  }
  console.error(`[payload] 运行时依赖缺失 (${result.missing.length} 项): ${result.missing.join(', ')}`);
  console.error('[payload] 本目录未携带 node_modules；请在 payload 根目录执行 npm install --omit=dev --ignore-scripts 后重试。');
}

const command = process.argv[2];
if (command === 'check') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveProdDeps(entries);
  if (result.missing.length > 0) {
    reportDeps(result);
    process.exit(EXIT_DEPS_MISSING);
  }
  reportDeps(result);
  const failures = await probeRuntimeCapabilities(entries);
  if (failures.length > 0) {
    console.error(`[payload] 运行时能力实测失败：\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  console.log('[payload] 运行时能力实测通过（node:sqlite + esbuild transform）');
  process.exit(0);
} else if (command === 'start') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveProdDeps(entries);
  if (result.missing.length > 0) {
    reportDeps(result);
    process.exit(EXIT_DEPS_MISSING);
  }
  const failures = await probeRuntimeCapabilities(entries);
  if (failures.length > 0) {
    console.error(`[payload] 运行时能力实测失败：\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  const kernelEntry = path.resolve(payloadRoot, entries.kernel);
  const child = spawn(process.execPath, [kernelEntry], { stdio: 'inherit', env: process.env });
  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 : EXIT_ERROR));
  });
} else {
  usage();
}
