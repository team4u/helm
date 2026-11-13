/**
 * 测试夹具 mini-hub：最小 Hub 身份模拟（纯 Node，无 kernel 依赖）。
 *
 * 环境变量：
 * - HELM_PORT：监听端口（与 kernel 约定同键，随 HubSupervisor 子进程环境注入）；
 * - MINI_HUB_MODE：
 *   - stable（缺省）：正常服务，SIGTERM 优雅退出（exit 0）；
 *   - crash-once：MINI_HUB_MARKER 标记文件不存在时，就绪后约 150ms exit(1)（崩溃自愈用）；
 *   - crash-loop：每次就绪后约 150ms exit(1)（重启预算耗尽用）；
 *   - ignore-sigterm：忽略 SIGTERM（强杀路径用）；
 *   - no-listen：常驻但不监听（就绪超时用）。
 */
import { createServer } from 'node:http';
import { existsSync, writeFileSync } from 'node:fs';

const port = Number(process.env.HELM_PORT ?? '0');
const mode = process.env.MINI_HUB_MODE ?? 'stable';
const marker = process.env.MINI_HUB_MARKER;

if (mode === 'no-listen') {
  const timer = setInterval(() => {}, 1 << 30);
  process.on('SIGTERM', () => {
    clearInterval(timer);
    process.exit(0);
  });
} else {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    if (req.method === 'GET' && url.pathname === '/api/auth/status') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ configured: false, authenticated: false }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: { code: 'not_found', message: '路由不存在' } }));
  });
  server.on('error', (error) => {
    // 显式写 stderr：HubSupervisor 依此分类端口冲突。
    process.stderr.write(`mini-hub 监听失败: ${error.stack ?? String(error)}\n`);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    process.stdout.write(`mini-hub ready on ${port} mode=${mode}\n`);
    const shouldCrash =
      mode === 'crash-loop' || (mode === 'crash-once' && marker !== undefined && !existsSync(marker));
    if (mode === 'crash-once' && marker !== undefined && !existsSync(marker)) {
      writeFileSync(marker, String(process.pid));
    }
    if (shouldCrash) {
      setTimeout(() => process.exit(1), 150);
    }
  });
  if (mode === 'ignore-sigterm') {
    // 吞掉 SIGTERM，模拟无响应进程（验证 SIGKILL 兜底）。
    process.on('SIGTERM', () => process.stderr.write('mini-hub: SIGTERM 已忽略\n'));
  } else {
    process.on('SIGTERM', () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref?.();
    });
  }
}
