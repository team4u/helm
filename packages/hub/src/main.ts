#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelm } from './app.js';
import { startHub } from '@helm/kernel';
import { resolveWebDistOption } from './web-dist.js';

const port = Number(process.env.HELM_PORT ?? '3202');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HELM_PORT must be 1 to 65535 integer');
// listen address: by default only local machine loopback (remote helm-node must explicit HELM_HOST=0.0.0.0 or reverse proxy access).
const hostname = process.env.HELM_HOST ?? '127.0.0.1';
// static hosting directory (produce product policy):HELM_WEB_DIST_DIR explicit directory takes precedence,'false'/'0'/'' disable;
// default by hub entry itself location probe ../../web/dist(see web-dist.ts). kernel does not by default probe,
// also independent of @helm/kernel in node_modules inside install location guess path.
const { webDistDir } = resolveWebDistOption(process.env.HELM_WEB_DIST_DIR, dirname(fileURLToPath(import.meta.url)));
const app = await createHelm({
  dataDir: process.env.HELM_DATA_DIR,
  cwd: process.env.HELM_CWD ?? process.cwd(),
  model: process.env.HELM_MODEL,
});
try {
  const hub = await startHub({ kernel: app.kernel, port, hostname, ...(webDistDir !== undefined ? { webDistDir } : {}) });
  process.stdout.write(`Helm Hub: ${hub.url}\ndata directory: ${app.kernel.dataDir}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      try {
        await hub.close();
      } finally {
        await app.close();
      }
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
} catch (error) {
  await app.close();
  throw error;
}
