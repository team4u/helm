/**
 * test fixture mini-hub: most small Hub identity simulated (pure Node, without kernel dependency).
 *
 * environment variable:
 * - HELM_PORT: listen port (and kernel convention same key, follow HubSupervisor child process environment inject);
 * - MINI_HUB_MODE:
 *   - stable(default): normal service,SIGTERM graceful exit (exit 0);
 *   - crash-once:MINI_HUB_MARKER mark record file missing when, ready after about 150ms exit(1)(crash self-heal use);
 *   - crash-loop: each time ready after about 150ms exit(1)(restart pre- compute exhausted use);
 *   - ignore-sigterm: ignore SIGTERM(strong kill path use);
 *   - no-listen: common resident but do not listen (ready timeout use).
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
    res.end(JSON.stringify({ error: { code: 'not_found', message: 'routing missing' } }));
  });
  server.on('error', (error) => {
    // explicit write stderr:HubSupervisor per this classify port conflict.
    process.stderr.write(`mini-hub listen failed: ${error.stack ?? String(error)}\n`);
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
    // swallow SIGTERM, simulated without response process (verify SIGKILL fall back).
    process.on('SIGTERM', () => process.stderr.write('mini-hub: SIGTERM already ignore\n'));
  } else {
    process.on('SIGTERM', () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref?.();
    });
  }
}
