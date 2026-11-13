/** 桌面壳测试共享工具：临时端口、mini-hub 外部启动、轮询断言。 */
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer as netCreateServer, type Server } from 'node:net';
import { createServer as httpCreateServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

export const MINI_HUB_FIXTURE = fileURLToPath(new URL('fixtures/mini-hub.mjs', import.meta.url));

export async function pickFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server: Server = netCreateServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error('无法分配临时端口'))));
    });
    server.once('error', reject);
  });
}

/** 外部启动 mini-hub（attach 模式 / 端口占用场景）。 */
export async function startMiniHubExternal(
  port: number,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ child: ChildProcess; stop: () => Promise<void> }> {
  const child = spawn(process.execPath, [MINI_HUB_FIXTURE], {
    env: { PATH: process.env['PATH'], HELM_PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitFor('mini-hub 外部就绪', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, { signal: AbortSignal.timeout(500) });
      return response.ok;
    } catch {
      return false;
    }
  }, 10_000);
  return {
    child,
    stop: async () => {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await waitFor('mini-hub 外部退出', async () => child.exitCode !== null, 5_000);
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}

export async function waitFor(what: string, check: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(100);
  }
  process.stderr.write(`[desktop-test] 等待超时: ${what}\n`);
  return false;
}

/** 非 Hub 身份的占位 HTTP 服务（端口冲突场景）。 */
export async function startPlainServer(port: number): Promise<Server> {
  const server = httpCreateServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('plain service');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return server;
}
