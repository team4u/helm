import { createHelm } from './app.js';
import { startHub } from './http/index.js';

const port = Number(process.env.HELM_PORT ?? '3202');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HELM_PORT 必须是 1 到 65535 的整数');
const app = await createHelm({
  dataDir: process.env.HELM_DATA_DIR,
  cwd: process.env.HELM_CWD ?? process.cwd(),
  model: process.env.HELM_MODEL,
});
try {
  const hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port });
  process.stdout.write(`Helm Hub: ${hub.url}\n数据目录: ${app.kernel.dataDir}\n`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await hub.close();
      await app.close();
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
