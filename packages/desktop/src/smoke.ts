/**
 * 桌面壳 smoke 入口（纯 Node，无 GUI 依赖）：真实 kernel dist Hub 的端到端验证。
 *
 * 验证链：配置解析 → 运行器能力探测 → attach-or-spawn（期望 owned）→ Hub 身份探测 →
 * SIGKILL 崩溃 → 监督器自动重启 → 优雅停止 → 端口释放。
 * 前置：仓库根执行过 pnpm build（packages/kernel/dist/main.js 存在）。
 * 数据隔离：dataDir 用临时目录，端口用临时分配端口，绝不触碰 3202 与 ~/.helm。
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { resolveDesktopConfig, defaultHubEntryPath } from './config.js';
import { probeRunner, KERNEL_NODE_FLOOR, probeMeetsFloor } from './runners.js';
import { HubSupervisor } from './supervisor.js';
import { DesktopError } from './errors.js';

function log(line: string): void {
  process.stdout.write(`[desktop-smoke] ${line}\n`);
}

async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配临时端口'))));
    });
    server.once('error', reject);
  });
}

async function waitFor(description: string, check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(200);
  }
  log(`等待超时: ${description}`);
  return false;
}

async function main(): Promise<number> {
  const hubEntry = defaultHubEntryPath();
  const probe = await probeRunner(process.execPath);
  log(`宿主 Node ${probe.node}（sqlite=${probe.sqlite}，floor=${KERNEL_NODE_FLOOR}，达标=${probeMeetsFloor(probe)}）`);
  if (!probeMeetsFloor(probe)) {
    log(`宿主 Node 不满足 kernel 需要（>= ${KERNEL_NODE_FLOOR} 且 node:sqlite），中止`);
    return 1;
  }

  const port = await pickFreePort();
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-desktop-smoke-'));
  const cleanEnv: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'],
    HOME: dataDir, // 隔离任何 HOME 相对回退
    LANG: process.env['LANG'],
  };
  const config = resolveDesktopConfig(cleanEnv, {
    port,
    dataDir,
    readyTimeoutMs: 30_000,
    probeIntervalMs: 150,
    restartBackoffMs: 200,
    restartBackoffMaxMs: 800,
    stableMs: 60_000,
    stopGraceMs: 4_000,
  });
  log(`端口 ${port}，临时数据目录 ${dataDir}`);

  const events: string[] = [];
  const supervisor = new HubSupervisor({
    config,
    env: cleanEnv,
    events: {
      stateChange: (next, prev) => events.push(`${prev}->${next}`),
      runnerSelected: (info) => log(`运行器: ${info.kind} ${info.command.join(' ')}`),
      restartScheduled: (attempt) => log(`崩溃重启 #${attempt}`),
    },
  });

  let failures = 0;
  try {
    try {
      const result = await supervisor.start();
      log(`start: mode=${result.mode} hub=${result.hubUrl}`);
      if (result.mode === 'attached') {
        log('意外 attach 到外部 Hub（临时端口不应有服务），视为失败');
        return 1;
      }
    } catch (error) {
      if (error instanceof DesktopError && (error.code === 'hub_entry_missing' || error.code === 'payload_entry_missing')) {
        log(`Hub 入口缺失: ${hubEntry}；先在仓库根执行 pnpm build`);
        return 2;
      }
      throw error;
    }

    const identity = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(2_000) });
    const body = (await identity.json()) as { configured?: unknown };
    if (identity.status === 200 && typeof body.configured === 'boolean') {
      log(`Hub 身份探测通过: /api/auth/status -> ${JSON.stringify(body)}`);
    } else {
      log(`Hub 身份探测异常: ${identity.status} ${JSON.stringify(body)}`);
      failures += 1;
    }

    // 崩溃自愈：SIGKILL owned 子进程，等待监督器重启并重新就绪。
    const pidBefore = supervisor.childPid;
    if (pidBefore === undefined) {
      log('无子进程 pid，跳过崩溃测试');
      failures += 1;
    } else {
      process.kill(pidBefore, 'SIGKILL');
      const recovered = await waitFor('崩溃后重启就绪', async () => {
        if (supervisor.state !== 'owned') return false;
        if (supervisor.childPid === pidBefore) return false;
        try {
          const response = await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(1_000) });
          return response.ok;
        } catch {
          return false;
        }
      }, 30_000);
      log(recovered ? '崩溃自愈通过: 新子进程已就绪' : '崩溃自愈失败');
      if (!recovered) failures += 1;
    }

    await supervisor.stop();
    const hubGone = await waitFor('停止后端口释放', async () => {
      try {
        await fetch(`${config.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(500) });
        return false;
      } catch {
        return true;
      }
    }, 10_000);
    log(hubGone ? '优雅停止通过: 端口已释放' : '停止失败: 端口仍可访问');
    if (!hubGone) failures += 1;

    log(`状态轨迹: ${events.join(' ')}`);
    log(failures === 0 ? 'SMOKE PASS' : `SMOKE FAIL（${failures} 项未通过）`);
    return failures === 0 ? 0 : 1;
  } finally {
    await supervisor.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

void main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`[desktop-smoke] 失败: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exit(1);
  },
);
