#!/usr/bin/env node
import { createHelm } from './app.js';
import { startHub } from './http/index.js';

const port = Number(process.env.HELM_PORT ?? '3202');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HELM_PORT 必须是 1 到 65535 的整数');
// 监听地址：默认仅本机回环（远端 helm-node 需显式 HELM_HOST=0.0.0.0 或反代接入）。
const hostname = process.env.HELM_HOST ?? '127.0.0.1';
// 静态托管目录：HELM_WEB_DIST_DIR 指定目录，'false'/'0'/'' 禁用；缺省探测默认位置。
const rawWebDist = process.env.HELM_WEB_DIST_DIR;
const webDistDir = rawWebDist === undefined ? undefined : (rawWebDist === 'false' || rawWebDist === '0' || rawWebDist === '' ? false : rawWebDist);
const app = await createHelm({
  dataDir: process.env.HELM_DATA_DIR,
  cwd: process.env.HELM_CWD ?? process.cwd(),
  model: process.env.HELM_MODEL,
});
try {
  const hub = await startHub({ kernel: app.kernel, port, hostname, ...(webDistDir !== undefined ? { webDistDir } : {}) });
  process.stdout.write(`Helm Hub: ${hub.url}\n数据目录: ${app.kernel.dataDir}\n`);
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
