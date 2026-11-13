#!/usr/bin/env node
/**
 * 桌面安装包 Hub 生产 baseline 组装：复用 @helm/payload dist，物化完整生产依赖闭包，
 * 复制 npm CLI，并在仓库外隔离目录真实启动验收。
 *
 * 产物布局（packages/desktop/hub/，electron-builder extraResources → <resources>/hub）：
 *   hub/{package.json, manifest.json, start.mjs}   复用 payload dist（同源契约）
 *   hub/kernel/ hub/protocol/ hub/cli/ hub/web/    kernel/protocol/cli/web 产物
 *   hub/node_modules/...                            生产依赖闭包（见下）
 *   hub/tools/npm/                                  npm CLI 完整文件闭包（bin/npm-cli.js，
 *                                                   供主代理 Electron run-as-node 运行）
 *
 * 依赖物化机制（诚实边界：只物化本 runner 架构——发布业务 payload 由客户端按平台
 * npm install，baseline 安装包按当前打包架构内嵌）：
 * - 源：仓库已安装的 pnpm 解析结果。每个包从其真实目录（.pnpm 虚拟店或 workspace
 *   包目录）复制文件本体；包内 node_modules 的符号链接条目一律排除（禁止仓库外/
 *   dangling symlink），真实目录条目（如 npm 自带的 bundled 依赖）原样保留；
 * - 重建：按真实 dependency graph（dependencies + peerDependencies + 已安装的
 *   optionalDependencies）以 npm 嵌套布局重放——优先提升到 hub/node_modules 根，
 *   版本冲突时嵌套到依赖方的 node_modules（绝不只单层复制，绝不共用错误版本）；
 * - 验收：默认在仓库外隔离目录真实启动 Hub（HTTP 探活 /api/auth/status）——不在
 *   仓库内验收，避免 node 解析偷渡到仓库 node_modules 造成假阳性。--no-verify 跳过。
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageCopyFilter, prodDepEntries, resolveDepRealDir } from '../../payload/src/dep-closure.mjs';

const pkgRoot = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(pkgRoot, '..');
const repoRoot = path.resolve(desktopRoot, '../..');
const hubDir = path.join(desktopRoot, 'hub');
const payloadDist = path.join(repoRoot, 'packages/payload/dist');
const runArg = process.argv.slice(2);
const verify = !runArg.includes('--no-verify');

const fail = (msg) => {
  console.error(`[assemble-hub] ${msg}`);
  process.exit(1);
};

// --- 前置：payload dist 必须就绪（缺失时自动补组装一次） ------------------------------
if (!existsSync(path.join(payloadDist, 'manifest.json'))) {
  console.log('[assemble-hub] payload dist 缺失，先执行 @helm/payload build ...');
  const res = spawnSync('pnpm', ['--filter', '@helm/payload', 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  if (res.status !== 0) fail('payload dist 组装失败（上方位输出）');
}
if (!existsSync(path.join(payloadDist, 'kernel/dist/main.js'))) fail(`payload dist 布局异常: ${payloadDist}`);

// --- 复用 payload dist（同源契约，不重复实现） ---------------------------------------
rmSync(hubDir, { recursive: true, force: true });
mkdirSync(hubDir, { recursive: true });
for (const ent of readdirSync(payloadDist)) {
  cpSync(path.join(payloadDist, ent), path.join(hubDir, ent), { recursive: true, dereference: true });
}
const hubPkg = JSON.parse(readFileSync(path.join(hubDir, 'package.json'), 'utf-8'));

// --- 生产依赖闭包物化 ---------------------------------------------------------------
/** 复制一个包目录：排除其 node_modules 内的符号链接条目（pnpm 注入），保留真实目录（如 npm 自带 bundled 依赖）。 */
function copyPackageRealDir(srcDir, destDir) {
  cpSync(srcDir, destDir, { recursive: true, dereference: true, filter: packageCopyFilter(srcDir) });
}

const rootDeps = hubPkg.dependencies ?? {};
/** hub 内某消费者目录向上的解析链（跳过 node_modules 容器与 @scope 容器目录）。 */
function resolutionChain(consumerDir) {
  const chain = [];
  let cur = consumerDir;
  while (true) {
    const base = path.basename(cur);
    const parent = path.dirname(cur);
    const isScopeContainer = base.startsWith('@') && path.basename(parent) === 'node_modules';
    if (base !== 'node_modules' && !isScopeContainer) chain.push(cur);
    if (cur === hubDir) break;
    const next = parent;
    if (next === cur || cur.length < hubDir.length) break;
    cur = next;
  }
  // chain[0] = 消费者自身（最近）→ 末尾 = hub 根：与 Node 就近优先解析语义一致。
  return chain;
}

const placed = new Map(); // dest package dir -> { name, version }
const copyQueue = [];
const problems = [];

/**
 * 放置一个依赖：若从 consumerDir 已可解析到同版本则跳过；否则提升到 hub/node_modules
 * 根（无冲突时）或嵌套到 consumerDir/node_modules（版本冲突时）。
 */
function placeDep(name, realDir, pkgJson, consumerDir) {
  for (const level of resolutionChain(consumerDir)) {
    const existing = placed.get(path.join(level, 'node_modules', name));
    if (existing) {
      if (existing.version === pkgJson.version) return; // 已可正确解析
      break; // 冲突：落到下方嵌套放置
    }
  }
  const hoisted = path.join(hubDir, 'node_modules', name);
  const hoistedExisting = placed.get(hoisted);
  const dest = !hoistedExisting ? hoisted : path.join(consumerDir, 'node_modules', name);
  if (placed.has(dest)) {
    problems.push(`${name}@${pkgJson.version}: 嵌套位置 ${dest} 已被 ${placed.get(dest).version} 占用（需更深嵌套，当前 baseline 未覆盖该形态）`);
    return;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  copyQueue.push([realDir, dest]);
  placed.set(dest, { name, version: pkgJson.version });
  // 递归物化该包的生产依赖（真实目录侧解析——.pnpm 内其依赖已按 peer 闭包就位）。
  for (const { name: depName, optional } of prodDepEntries(pkgJson)) {
    const resolved = resolveDepRealDir(realDir, depName, optional);
    if (resolved === null) continue; // 平台/能力不匹配的 optional 依赖：如实跳过
    if (resolved.error) {
      problems.push(`${name} → ${resolved.error}`);
      continue;
    }
    placeDep(depName, resolved.realDir, resolved.pkgJson, dest);
  }
}

// 根依赖：外部依赖自 kernel 包目录解析；@helm/protocol 以 payload 携带的 protocol/
// 目录为本体（其依赖自仓库 protocol 包目录解析，保证与发布 file: 语义一致的闭包）。
for (const [name, spec] of Object.entries(rootDeps)) {
  if (name === '@helm/protocol') {
    const protoDir = path.join(hubDir, 'protocol');
    const protoPkg = JSON.parse(readFileSync(path.join(protoDir, 'package.json'), 'utf-8'));
    placed.set(path.join(hubDir, 'node_modules', name), { name, version: protoPkg.version });
    mkdirSync(path.join(hubDir, 'node_modules', '@helm'), { recursive: true });
    copyQueue.push([protoDir, path.join(hubDir, 'node_modules', '@helm', 'protocol')]);
    for (const depName of Object.keys(protoPkg.dependencies ?? {})) {
      const resolved = resolveDepRealDir(path.join(repoRoot, 'packages/protocol'), depName, false);
      if (resolved.error) problems.push(resolved.error);
      else placeDep(depName, resolved.realDir, resolved.pkgJson, protoDir);
    }
    continue;
  }
  const resolved = resolveDepRealDir(path.join(repoRoot, 'packages/kernel'), name, false);
  if (resolved.error) {
    problems.push(resolved.error);
    continue;
  }
  if (!spec.includes(resolved.pkgJson.version)) {
    problems.push(`${name}: payload 契约版本 ${spec} 与仓库安装 ${resolved.pkgJson.version} 不一致`);
  }
  placeDep(name, resolved.realDir, resolved.pkgJson, hubDir);
}
if (problems.length > 0) fail(`依赖闭包解析失败：\n${problems.map((p) => `- ${p}`).join('\n')}`);
for (const [src, dest] of copyQueue) copyPackageRealDir(src, dest);

// --- npm CLI 完整文件闭包（asar 外，主代理经 Electron run-as-node 运行） -------------
const npmRealDir = resolveDepRealDir(desktopRoot, 'npm', false).realDir;
const npmPkg = JSON.parse(readFileSync(path.join(npmRealDir, 'package.json'), 'utf-8'));
if (!existsSync(path.join(npmRealDir, 'bin', 'npm-cli.js'))) fail(`npm CLI 入口缺失: ${npmRealDir}/bin/npm-cli.js`);
copyPackageRealDir(npmRealDir, path.join(hubDir, 'tools', 'npm'));

// --- 诚实性检查：hub 内不得残留指向仓库内/外的符号链接（必须全部真实文件） -----------
function findSymlinks(dir) {
  const out = [];
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      if (ent.name === '.pnpm') continue;
      const p = path.join(cur, ent.name);
      if (ent.isSymbolicLink()) out.push(p);
      else if (ent.isDirectory()) visit(p);
    }
  };
  visit(dir);
  return out;
}
const symlinks = findSymlinks(hubDir);
if (symlinks.length > 0) fail(`hub 内残留符号链接（物化必须为真实文件）:\n${symlinks.slice(0, 10).join('\n')}`);

function walkStats(dir) {
  let files = 0;
  let bytes = 0;
  const visit = (cur) => {
    for (const ent of readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) visit(p);
      else {
        files += 1;
        bytes += statSync(p).size;
      }
    }
  };
  visit(dir);
  return { files, bytes };
}
const stats = walkStats(hubDir);
console.log(`[assemble-hub] 组装完成: ${hubDir}`);
console.log(`[assemble-hub] 包名 ${hubPkg.name}@${hubPkg.version}，依赖闭包 ${placed.size} 包，npm CLI ${npmPkg.version}（tools/npm/bin/npm-cli.js）`);
console.log(`[assemble-hub] 文件 ${stats.files} 个，共 ${(stats.bytes / 1024 / 1024).toFixed(1)} MiB（本 runner 架构 baseline）`);

// --- 外部隔离目录真实启动验收 -------------------------------------------------------
if (!verify) {
  console.log('[assemble-hub] --no-verify：跳过启动验收（仅调试用，发布前必须验收）');
  process.exit(0);
}

// 仓库之外（且不在任何含 node_modules 的祖先链上），杜绝解析偷渡造成假阳性。
const verifyRoot = mkdtempSync(path.join(path.dirname(repoRoot) === '/root/code' ? '/root' : path.dirname(repoRoot), 'helm-hub-verify-'));
const verifyHub = path.join(verifyRoot, 'hub');
try {
  cpSync(hubDir, verifyHub, { recursive: true, dereference: true });
  const dataDir = mkdtempSync(path.join(verifyRoot, 'data-'));
  const port = 33000 + (process.pid % 2000);
  console.log(`[assemble-hub] 隔离验收（仓库外 ${verifyRoot}）: 启动 Hub @ ${port} ...`);
  const child = spawn(process.execPath, [path.join(verifyHub, 'start.mjs'), 'start'], {
    cwd: verifyHub,
    env: { ...process.env, HELM_PORT: String(port), HELM_HOST: '127.0.0.1', HELM_DATA_DIR: dataDir, HELM_CWD: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const deadline = Date.now() + 60_000;
  let ok = false;
  let lastErr = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    const probe = spawnSync(process.execPath, ['-e', `fetch('http://127.0.0.1:${port}/api/auth/status').then(r=>r.json()).then(j=>{if(typeof j!=='object'||j===null)throw new Error('bad json');process.exit(0)}).catch(e=>{process.stderr.write(String(e.message));process.exit(1)})`], { encoding: 'utf8', timeout: 5_000 });
    if (probe.status === 0) {
      ok = true;
      break;
    }
    lastErr = probe.stderr ?? '';
    await new Promise((r) => setTimeout(r, 500));
  }
  const termRes = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const exitInfo = await Promise.race([termRes, new Promise((r) => setTimeout(() => r({ code: null, signal: null, timeout: true }), 15_000))]);
  if (exitInfo.timeout) child.kill('SIGKILL');
  if (!ok) {
    console.error(`[assemble-hub] 隔离验收失败：Hub 未在 60s 内通过 HTTP 探活（最后探测错误: ${lastErr || 'unknown'}）`);
    console.error(`[assemble-hub] Hub stdout:\n${stdout.slice(-4000)}`);
    console.error(`[assemble-hub] Hub stderr:\n${stderr.slice(-4000)}`);
    process.exit(1);
  }
  if (exitInfo.code !== 0 && !exitInfo.timeout) {
    console.error(`[assemble-hub] 隔离验收失败：Hub 退出码 ${exitInfo.code} ${exitInfo.signal ?? ''}`);
    console.error(`[assemble-hub] Hub stdout:\n${stdout.slice(-4000)}`);
    console.error(`[assemble-hub] Hub stderr:\n${stderr.slice(-4000)}`);
    process.exit(1);
  }
  console.log(`[assemble-hub] 隔离验收通过：HTTP /api/auth/status 探活成功，SIGTERM 干净退出（exit=${exitInfo.code}${exitInfo.signal ? ` signal=${exitInfo.signal}` : ''}）`);
} finally {
  rmSync(verifyRoot, { recursive: true, force: true });
}
