#!/usr/bin/env node
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHelm } from './app.js';
import { hubActivityFilePath, startActivityHeartbeat, startHub } from '@helm/kernel';
import { resolveWebDistOption } from './web-dist.js';

const launchId = process.env.HELM_HUB_ACTIVITY_LAUNCH_ID;
delete process.env.HELM_HUB_ACTIVITY_LAUNCH_ID;

const port = Number(process.env.HELM_PORT ?? '3202');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HELM_PORT must be an integer between 1 and 65535');
// Listen address: loopback only by default (remote helm-node requires explicit HELM_HOST=0.0.0.0 or a reverse proxy).
const hostname = process.env.HELM_HOST ?? '127.0.0.1';
// Static web hosting directory (product policy): explicit HELM_WEB_DIST_DIR takes precedence; 'false'/'0'/'' disables it.
// By default, probe ../../web/dist relative to this hub entrypoint (see web-dist.ts); the kernel performs no default probing
// and does not guess paths from where @helm/kernel is installed inside node_modules.
const { webDistDir } = resolveWebDistOption(process.env.HELM_WEB_DIST_DIR, dirname(fileURLToPath(import.meta.url)));
const app = await createHelm({
  dataDir: process.env.HELM_DATA_DIR,
  cwd: process.env.HELM_CWD ?? process.cwd(),
  model: process.env.HELM_MODEL,
});
try {
  const hub = await startHub({ kernel: app.kernel, port, hostname, ...(webDistDir !== undefined ? { webDistDir } : {}) });
  // Activity heartbeat (process-private update busy-gate signal; see activity-heartbeat.ts). Started
  // only after the server is listening so the recorded port is the real bound one; stopped first on
  // shutdown so no stale record outlives this instance.
  const heartbeat = startActivityHeartbeat({
    file: hubActivityFilePath(app.kernel.dataDir),
    port,
    ...(launchId !== undefined ? { launchId } : {}),
    snapshot: () => app.kernel.activitySnapshot(),
    subscribeBusyEntered: (listener) => app.kernel.onActivityBusyEntered(listener),
    onWriteError: (error) => {
      process.stderr.write(`[hub] activity heartbeat write failed: ${error instanceof Error ? error.message : String(error)}\n`);
    },
  });
  process.stdout.write(`Helm Hub: ${hub.url}\nData directory: ${app.kernel.dataDir}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      try {
        await heartbeat.stop();
      } finally {
        try {
          await hub.close();
        } finally {
          await app.close();
        }
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
