#!/usr/bin/env node
/**
 * 打包桌面 App 冒烟 wrapper（跨平台、纯 Node 内置模块、无第三方依赖）。
 *
 * 职责边界：本脚本只负责「定位解包可执行文件 → 隔离环境拉起 → 超时杀树 → 依据
 * smoke.json 产物判定」，Electron 内部自检（renderer 加载 DOM、截图、写出
 * smoke.json）由 App 自身对 --smoke-test / --smoke-output 参数的实现承担。
 *
 * 判定诚实性：不轻信退出码也不轻信 json 单独存在——要求 App 退出码为 0 且
 * smoke.json 中 ok === true 才算通过；超时或异常退出保留 stdout/stderr 日志与
 * 已产出的报告文件供上传诊断。
 *
 * 用法：
 *   node scripts/desktop-smoke.mjs --packaged [--port <n>] [--release-dir <dir>] [--out <dir>] [--timeout <ms>]
 *     --packaged      对 electron-builder 解包产物冒烟（dist:dir / dist 均会生成 *-unpacked）。
 *     --port          Hub 端口，缺省 3202；仅测试隔离用（如本机 3202 有真实用户 Hub 时
 *                     显式传 --port=32020）。不做任何静默换端口：preflight 探测到端口
 *                     已被占用立即拒绝（绝不 attach 到既有服务——那会误伤真实 Hub），
 *                     换端口只能由人显式传参。
 *     --release-dir   解包产物根目录，缺省 packages/desktop/release（electron-builder.yml output）。
 *     --out           报告目录（smoke.json / 截图 / stdout.log / stderr.log / data/），缺省 <release-dir>/smoke；
 *                     每次运行先清空重建，CI 直接整目录上传。
 *     --timeout       毫秒，缺省 60_000；超时杀整棵进程树后判定失败。
 *
 * 环境约束（与仓库端口铁律一致）：
 *   - HELM_DATA_DIR 固定指向 <out>/data 临时目录，绝不触碰 ~/.helm；
 *   - HELM_PORT 显式固定为 --port 值（缺省 3202，本仓端口），绝不动态挑端口、
 *     绝不触碰 3000/3001/3002/3101/3102；spawn 前 preflight 确认端口空闲，占用即失败；
 *   - Linux 以 root 运行且非 CI 环境时附加 --no-sandbox（本机 root 起 Electron 的唯一合法路径）；
 *     CI runner 非 root，不传该参数，保持与真实用户环境一致。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PORT = 3202;
const DEFAULT_TIMEOUT_MS = 60_000;
const LOG_TAIL_LINES = 40;

function usage(code) {
  const text = [
    '用法: node scripts/desktop-smoke.mjs --packaged [--port <n>] [--release-dir <dir>] [--out <dir>] [--timeout <ms>]',
    '  --packaged     对 electron-builder 解包 App 冒烟（linux-unpacked / mac/*.app / win-unpacked）',
    '  --port         Hub 端口（缺省 3202；本机 3202 被占时显式传测试端口如 --port=32020，绝不静默换端口）',
    '  --release-dir  解包产物根目录（缺省 packages/desktop/release）',
    '  --out          报告输出目录（缺省 <release-dir>/smoke，运行前清空重建）',
    '  --timeout      超时毫秒数（缺省 60000），超时杀进程树并判定失败',
  ].join('\n');
  (code === 0 ? console.log : console.error)(text);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = { packaged: false, port: DEFAULT_PORT, releaseDir: undefined, out: undefined, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--packaged') opts.packaged = true;
    else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length));
    else if (arg === '--port') opts.port = Number(argv[++i]);
    else if (arg === '--release-dir') opts.releaseDir = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else if (arg === '--timeout') opts.timeoutMs = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') usage(0);
    else {
      console.error(`[desktop-smoke] 未知参数: ${arg}`);
      usage(2);
    }
  }
  if (!opts.packaged) {
    console.error('[desktop-smoke] 缺少 --packaged：当前仅支持对打包解包产物冒烟（dev 模式用 pnpm --filter @helm/desktop run smoke）。');
    usage(2);
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535 || [3000, 3001, 3002, 3101, 3102].includes(opts.port)) {
    console.error(`[desktop-smoke] 非法 --port 值: ${opts.port}`);
    usage(2);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    console.error(`[desktop-smoke] 非法 --timeout 值: ${argv.join(' ')}`);
    usage(2);
  }
  return opts;
}

/** 按平台返回解包可执行文件的候选相对路径（electron-builder productName: Helm）。 */
function executableCandidates() {
  switch (process.platform) {
    case 'linux':
      // productName 首选，兜底包名小写形态，二者都探测避免对 electron-builder 命名细节撒谎。
      return ['linux-unpacked/helm-desktop', 'linux-unpacked/Helm', 'linux-unpacked/helm'];
    case 'darwin':
      // 常规单架构构建输出 mac/；同时兼容多架构并行的历史目录形态。
      return [
        'mac/Helm.app/Contents/MacOS/Helm',
        'mac-arm64/Helm.app/Contents/MacOS/Helm',
        'mac_arm64/Helm.app/Contents/MacOS/Helm',
        'mac-universal/Helm.app/Contents/MacOS/Helm',
      ];
    case 'win32':
      return ['win-unpacked/Helm.exe'];
    default:
      return [];
  }
}

function locateExecutable(releaseDir) {
  const tried = [];
  for (const rel of executableCandidates()) {
    const full = path.join(releaseDir, ...rel.split('/'));
    tried.push(full);
    if (existsSync(full)) return full;
  }
  console.error(`[desktop-smoke] 未找到解包可执行文件（平台 ${process.platform}）。已探测：`);
  for (const p of tried) console.error(`  - ${p}`);
  console.error('请先执行 pnpm --filter @helm/desktop run dist:dir（或 dist）生成解包产物。');
  process.exit(2);
}

/** Linux root 且非 CI 才允许 --no-sandbox；CI runner 非 root，不传以贴近真实环境。 */
function needsNoSandbox() {
  if (process.platform !== 'linux') return false;
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  return !process.env['CI'];
}

/** 杀整棵进程树：POSIX 用会话组信号（spawn detached），Windows 用 taskkill /T。 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    if (child.pid != null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F']);
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

function tail(file, lines = LOG_TAIL_LINES) {
  try {
    const content = readFileSync(file, 'utf8').trimEnd();
    if (content.length === 0) return '（空）';
    return content.split('\n').slice(-lines).join('\n');
  } catch {
    return '（不可读）';
  }
}

function fail(outDir, message) {
  console.error(`[desktop-smoke] 失败: ${message}`);
  console.error(`--- stdout.log 尾部 ${LOG_TAIL_LINES} 行（${path.join(outDir, 'stdout.log')}）---`);
  console.error(tail(path.join(outDir, 'stdout.log')));
  console.error(`--- stderr.log 尾部 ${LOG_TAIL_LINES} 行（${path.join(outDir, 'stderr.log')}）---`);
  console.error(tail(path.join(outDir, 'stderr.log')));
  console.error(`完整报告目录: ${outDir}`);
  process.exit(1);
}

function runChild(child, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      resolve(result);
    };
    let graceTimer;
    let timedOut = false;
    // 超时先杀树；杀后 5 秒仍无 exit 事件则强制收尾（僵尸/不可杀时如实报告而非悬挂）。
    const killTimer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      graceTimer = setTimeout(() => finish({ code: null, signal: null, timedOut: true, killedAfterTimeout: true }), 5_000);
    }, timeoutMs);
    child.once('close', (code, signal) => finish({ code, signal, timedOut }));
    child.once('error', (error) => finish({ error, code: null, signal: null, timedOut: false }));
  });
}

function validateSmokeJson(outDir) {
  const smokePath = path.join(outDir, 'smoke.json');
  if (!existsSync(smokePath)) {
    fail(outDir, `App 未生成 ${smokePath}（--smoke-test 自检未执行或未写出报告）`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(smokePath, 'utf8'));
  } catch (error) {
    fail(outDir, `smoke.json 不是合法 JSON: ${error.message}`);
  }
  // 判定依据全部来自报告产物，不轻信退出码：ok = 自检总判，nativeCompiler =
  // workflow/mermaid 原生编译器真实可用（缺 false 都算未通过，不降级）。
  if (parsed === null || typeof parsed !== 'object' || parsed.ok !== true) {
    fail(outDir, `smoke.json 判定未通过（期望 ok:true）: ${JSON.stringify(parsed)}`);
  }
  for (const field of ['nativeCompiler', 'rendererIsolated', 'portReleased']) {
    if (parsed[field] !== true) fail(outDir, `smoke.json 缺少通过的 ${field} 检查：${JSON.stringify(parsed)}`);
  }
  const screenshot = path.join(outDir, 'window.png');
  if (!existsSync(screenshot) || statSync(screenshot).size === 0) fail(outDir, '未生成窗口截图 window.png');
  return parsed;
}

/** preflight 通过后拉起 App、等待退出、写日志并依 smoke.json 判定。 */
function runSmoke(exe, appArgs, env, outDir, opts) {
  const stdoutLog = createWriteStream(path.join(outDir, 'stdout.log'), { flags: 'a' });
  const stderrLog = createWriteStream(path.join(outDir, 'stderr.log'), { flags: 'a' });
  // detached（POSIX）建新会话组：超时杀树可连带 Hub 子进程一起终止。
  const child = spawn(exe, appArgs, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  child.stdout.on('data', (chunk) => {
    stdoutLog.write(chunk);
    process.stdout.write(`[app] ${chunk}`);
  });
  child.stderr.on('data', (chunk) => {
    stderrLog.write(chunk);
    process.stderr.write(`[app] ${chunk}`);
  });

  runChild(child, opts.timeoutMs).then(async (result) => {
    await Promise.all([
      new Promise((resolve) => stdoutLog.end(resolve)),
      new Promise((resolve) => stderrLog.end(resolve)),
    ]);
    if (result.error) {
      fail(outDir, `无法启动 ${exe}: ${result.error.message}`);
    }
    if (result.timedOut) {
      fail(outDir, `超时（>${opts.timeoutMs}ms），已杀进程树；App 未在期限内完成自检`);
    }
    if (result.code !== 0) {
      fail(outDir, `App 退出码非 0（code=${result.code} signal=${result.signal ?? 'null'}）`);
    }
    const report = validateSmokeJson(outDir);
    const artifacts = readdirSync(outDir).filter((name) => !name.startsWith('data-'));
    console.log(`[desktop-smoke] smoke.json: ${JSON.stringify(report)}`);
    console.log(`[desktop-smoke] 报告文件: ${artifacts.join(', ')}`);
    console.log('[desktop-smoke] SMOKE PASS（打包 App 自检通过）');
    process.exit(0);
  });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const releaseDir = path.resolve(opts.releaseDir ?? path.join(repoRoot, 'packages', 'desktop', 'release'));
  const outDir = path.resolve(opts.out ?? path.join(releaseDir, 'smoke'));

  const exe = locateExecutable(releaseDir);

  // 仅清理本脚本创建的报告文件；数据目录逐次新建，避免删除用户指定目录中的其他文件。
  mkdirSync(outDir, { recursive: true });
  for (const file of ['smoke.json', 'window.png', 'stdout.log', 'stderr.log']) rmSync(path.join(outDir, file), { force: true });
  const dataDir = mkdtempSync(path.join(outDir, 'data-'));

  const appArgs = ['--smoke-test', `--smoke-output=${outDir}`];
  if (needsNoSandbox()) appArgs.unshift('--no-sandbox');

  // 显式固定端口与数据目录：不继承宿主环境里的 HELM_PORT/HELM_DATA_DIR 漂移。
  const port = String(opts.port);
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^HELM_/i.test(key) && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'NODE_PATH'));
  const env = { ...baseEnv, HELM_DATA_DIR: dataDir, HELM_DESKTOP_DATA_DIR: dataDir, HELM_CWD: dataDir, HELM_PORT: port, HELM_DESKTOP_PORT: port };

  console.log(`[desktop-smoke] 可执行文件: ${exe}`);
  console.log(`[desktop-smoke] 参数: ${appArgs.join(' ')}`);
  console.log(`[desktop-smoke] HELM_PORT=${port} HELM_DATA_DIR=${dataDir}`);
  console.log(`[desktop-smoke] 超时: ${opts.timeoutMs}ms，报告目录: ${outDir}`);

  // 端口 preflight：已被占用立即拒绝——App 的 attach-or-spawn 语义遇到占用端口会
  // attach 到既有服务（可能是本机真实用户 Hub），既测不到打包 App 也可能误伤对方；
  // 绝不静默挑别的端口，换端口必须由人显式传 --port。
  preflightPortFree(opts.port).then(
    () => runSmoke(exe, appArgs, env, outDir, opts),
    (error) => {
      fail(outDir, `端口 ${opts.port} 已被占用（${error.message}）：拒绝 attach 既有服务。本机 3202 有真实 Hub 时请显式传 --port=<测试端口>（如 --port=32020）。`);
    },
  );
}

/** 探测端口空闲：能以监听态绑定即视为空闲后立即释放；绑定失败说明被占用。 */
function preflightPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}

main();
