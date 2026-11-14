#!/usr/bin/env node
/**
 * 跨平台测试入口（Windows 为主目标环境）。
 *
 * 为什么存在：真实运行环境是 Windows，Unix `timeout 180s` 在 Windows 上不可用也不可靠；
 * 本脚本用纯 Node spawn 在用户态提供同等保护：
 * - 直接 spawn 本仓库本地安装的 tsx CLI（node <tsx/cli.mjs>），不依赖 shell alias / npx / PATH 碰运气；
 * - 单测超时沿用 Node 原生 `--test-timeout=20000`，由各测试文件自身声明 `{ timeout: 60_000 }` 覆盖；
 * - 整个套件设置总超时（默认 10 分钟，覆盖 Windows 实测约 217s 的全量耗时），超时后杀完整进程树：
 *   Windows 用 `taskkill /PID <pid> /T /F`，POSIX 用独立进程组 + SIGTERM，宽限后 SIGKILL；
 * - 正常退出原样透传退出码；子进程被信号终止时按 128+signal 退出；总超时以 124 退出（GNU timeout 惯例）；
 * - 主动终止（forced 路径）时 leader 退出不立即结算：tsx 独立进程组内可能仍有忽略 SIGTERM
 *   的孙进程，保留 KILL_GRACE_MS 的 SIGKILL 升级与 LAST_RESORT 封顶，轮询 owned 进程组
 *   排空后才退（Windows 无组信号，taskkill /T /F 已杀树，维持即退），不留孤儿也不挂无限 timer。
 *
 * 环境变量：HELM_TEST_SUITE_TIMEOUT_MS 覆盖总超时（毫秒，正整数）。
 * 参数透传：本脚本收到的所有 CLI 参数原样追加给 tsx / node test runner（含 glob）。
 *
 * 注意：pnpm test:force-exit 在此基础上追加 `--test-force-exit`，仅用于诊断挂起测试；
 * 已知副作用是会取消 packages/web/test/composer-slash-skills.test.ts 中 5 个合法 act() 测试，
 * 因此绝不作为默认 test 方案。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_SUITE_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 5000;
// 决定杀树后仍未收到 exit 事件的最后兜底，保证本包装进程一定以非 0 退出而不是挂住或退 0。
const LAST_RESORT_MS = 15000;

// 本脚本位于 <仓库根>/scripts/，锚定仓库根保证从任意 cwd 调用都能解析到本仓库的依赖。
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function resolveTsxCLI() {
  // 锚定仓库根（脚本位于 <root>/scripts/），保证从任意 cwd 调用（如 IDE）都能解析到本仓库的 tsx。
  const require = createRequire(path.join(repoRoot, 'package.json'));
  const pkgPath = require.resolve('tsx/package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
  const cli = path.resolve(path.dirname(pkgPath), bin ?? 'dist/cli.mjs');
  if (!existsSync(cli)) {
    console.error(`[run-tests] 未找到本地 tsx CLI: ${cli}（请先 pnpm install）`);
    process.exit(1);
  }
  return cli;
}

// pnpm 的 .bin shim 会把 node_modules/.pnpm/node_modules 塞进 NODE_PATH，
// 测试中从 tmpdir 动态加载的外部插件依赖它解析 @helm/protocol；
// 绕过 shim 直接调 cli.mjs 时重建等价环境即可，免去枚举全部 .pnpm 条目。
function pnpmFallbackNodePath() {
  const pnpmDir = path.join(repoRoot, 'node_modules', '.pnpm');
  const fallback = path.join(pnpmDir, 'node_modules');
  return existsSync(fallback) ? fallback : '';
}

function suiteTimeoutMs() {
  const raw = process.env.HELM_TEST_SUITE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_SUITE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || Math.floor(n) !== n) {
    console.error(`[run-tests] 无效的 HELM_TEST_SUITE_TIMEOUT_MS（需正整数毫秒）: ${raw}`);
    process.exit(2);
  }
  return n;
}

const startMs = Date.now();
const tsxCli = resolveTsxCLI();
const timeoutMs = suiteTimeoutMs();
const forwardArgs = process.argv.slice(2);

const childEnv = { ...process.env };
const fallback = pnpmFallbackNodePath();
if (fallback) {
  childEnv.NODE_PATH = process.env.NODE_PATH
    ? fallback + path.delimiter + process.env.NODE_PATH
    : fallback;
}

// 无 shell 参与：参数逐个透传，天然免疫字符串拼接注入；glob 交给 tsx / node test runner 展开。
const child = spawn(process.execPath, [tsxCli, '--test', '--test-timeout=20000', ...forwardArgs], {
  stdio: 'inherit',
  env: childEnv,
  cwd: repoRoot,
  detached: process.platform !== 'win32', // POSIX 独立进程组，才能用 kill(-pid) 杀整棵树
});

let suiteTimer = null;
let graceTimer = null;
let lastResortTimer = null;
let groupWatchTimer = null;
// 由本脚本主动终止（总超时 / 转发信号）时锁定退出码，防止后续 exit 事件覆盖。
let forcedExitCode = null;

const GROUP_POLL_MS = 100;

// owned 测试进程组（tsx 独立 PGID）是否仍有成员：leader 退出不代表整组停止，
// 孙进程可能忽略 SIGTERM；仅 ESRCH 视为排空（EPERM 等保守按存活）。
function groupAlive() {
  if (process.platform === 'win32') return false; // Windows 无组信号，树杀由 taskkill /T /F 负责
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (err) {
    return err?.code !== 'ESRCH';
  }
}

function clearTimers() {
  for (const t of [suiteTimer, graceTimer, lastResortTimer]) {
    if (t) clearTimeout(t);
  }
  suiteTimer = graceTimer = lastResortTimer = null;
}

function killTree(signal) {
  if (child.pid == null) return;
  if (process.platform === 'win32') {
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    tk.on('error', (err) => console.error('[run-tests] taskkill 启动失败:', err.message));
    // taskkill 失败也无妨：LAST_RESORT 兜底保证本进程按非 0 退出。
  } else {
    try {
      process.kill(-child.pid, signal);
    } catch {
      // 进程组已消失则无事可做。
    }
    graceTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // 同上。
      }
    }, KILL_GRACE_MS);
  }
}

function terminate(reason, exitCode, signal = 'SIGTERM') {
  if (forcedExitCode !== null) return;
  forcedExitCode = exitCode;
  if (suiteTimer) clearTimeout(suiteTimer);
  console.error(`[run-tests] ${reason}，终止测试进程树（pid ${child.pid}）`);
  killTree(signal);
  lastResortTimer = setTimeout(() => {
    console.error('[run-tests] 终止后迟迟未收到退出事件，强制退出。');
    process.exit(forcedExitCode);
  }, LAST_RESORT_MS);
}

child.on('error', (err) => {
  clearTimers();
  console.error('[run-tests] 启动测试进程失败:', err);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  if (forcedExitCode !== null) {
    // 强制终止路径：leader（tsx）退出不代表 owned 组排空——孙进程可能忽略 SIGTERM。
    // 不 clearTimers：保留 KILL_GRACE_MS 的 SIGKILL 升级与 LAST_RESORT 封顶，
    // 轮询组排空后才退。Windows 无组信号，taskkill /T /F 已杀树，维持即退。
    if (process.platform === 'win32') {
      console.error(`[run-tests] 已强制终止，耗时 ${elapsed}s，退出 ${forcedExitCode}`);
      process.exit(forcedExitCode);
    }
    if (groupWatchTimer !== null) return;
    groupWatchTimer = setInterval(() => {
      if (!groupAlive()) {
        console.error(
          `[run-tests] 已强制终止，耗时 ${((Date.now() - startMs) / 1000).toFixed(1)}s，` +
            `owned 测试进程组已排空，退出 ${forcedExitCode}`,
        );
        process.exit(forcedExitCode);
      }
    }, GROUP_POLL_MS);
    return;
  }
  clearTimers();
  if (code !== null) {
    console.error(`[run-tests] 套件 ${elapsed}s 结束，退出码 ${code}`);
    process.exit(code);
  }
  const signalExit = { SIGHUP: 129, SIGINT: 130, SIGQUIT: 131, SIGTERM: 143 }[signal] ?? 1;
  console.error(`[run-tests] 套件 ${elapsed}s 被信号 ${signal} 终止，退出 ${signalExit}`);
  process.exit(signalExit);
});

// POSIX 下子进程在独立进程组，Ctrl+C 不会自动送达，必须显式转发；Windows 控制台会广播 Ctrl+C，转发是幂等兜底。
process.on('SIGINT', () => terminate('收到 SIGINT', 130, 'SIGINT'));
process.on('SIGTERM', () => terminate('收到 SIGTERM', 143, 'SIGTERM'));

suiteTimer = setTimeout(() => {
  terminate(`套件总超时（${timeoutMs}ms，可用 HELM_TEST_SUITE_TIMEOUT_MS 调整）`, 124);
}, timeoutMs);
