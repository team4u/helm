#!/usr/bin/env node
/**
 * Hub payload 零依赖启动入口（随 payload 目录分发，Node >= 24，无任何 npm 依赖）。
 *
 * 命令：
 *   node start.mjs check   校验 manifest/entries/checksums，并报告 kernel 运行时依赖解析状态
 *   node start.mjs start   依赖可解析时拉起 kernel 入口（dist/main.js），透传环境变量与信号
 *
 * 退出码（绝不静默降级）：
 *   0  校验通过且依赖可解析（或 start 的子进程正常退出）
 *   1  用法错误或 payload 布局/校验和损坏
 *   3  布局合法但 kernel 运行时依赖缺失（本 payload 未携带 node_modules，见报告）
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

const payloadRoot = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ERROR = 1;
const EXIT_DEPS_MISSING = 3;

const usage = () => {
  console.error('用法: node start.mjs <check|start>');
  process.exit(EXIT_ERROR);
};

/** 读取并做最小契约校验（不假设多余字段；异常显式报错退出 1）。 */
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

/** 按 kernel/package.json dependencies 逐说明符做 ESM 解析（不执行模块）。 */
function resolveKernelDeps(entries) {
  const kernelPkgPath = path.resolve(payloadRoot, entries.kernelPackageJson ?? 'kernel/package.json');
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(kernelPkgPath, 'utf-8')).dependencies ?? {};
  } catch (err) {
    console.error(`[payload] kernel package.json 缺失或非法: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  const parent = pathToFileURL(path.resolve(payloadRoot, entries.kernel)).href;
  const missing = [];
  for (const spec of Object.keys(deps)) {
    try {
      import.meta.resolve(spec, parent);
    } catch {
      missing.push(spec);
    }
  }
  return { total: Object.keys(deps).length, missing };
}

function reportDeps(result) {
  if (result.missing.length === 0) {
    console.log(`[payload] kernel 运行时依赖全部可解析 (${result.total}/${result.total})`);
    return;
  }
  console.error(`[payload] kernel 运行时依赖缺失 (${result.missing.length}/${result.total}): ${result.missing.join(', ')}`);
  console.error('[payload] 本 payload 未携带 node_modules（npm pack 不打包 node_modules；esbuild 含平台原生二进制）。');
  console.error('[payload] 需在 payload 根目录放置可解析的 node_modules（如 npm install --omit=dev，或后续版本的 vendoring/单文件 bundle）后重试。');
}

const command = process.argv[2];
if (command === 'check') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveKernelDeps(entries);
  reportDeps(result);
  process.exit(result.missing.length > 0 ? EXIT_DEPS_MISSING : 0);
} else if (command === 'start') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveKernelDeps(entries);
  if (result.missing.length > 0) {
    reportDeps(result);
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
