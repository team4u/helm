import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (entry === undefined) throw new Error('缺少 Hub 子进程入口');
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
// Windows 没有可供 Node 处理的 SIGTERM；IPC 让各平台走同一关闭入口。
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'shutdown') return;
  process.disconnect?.();
  if (process.listenerCount('SIGTERM') === 0) process.exit(0);
  process.emit('SIGTERM');
});
await import(pathToFileURL(entry).href);
