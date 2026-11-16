import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (entry === undefined) throw new Error('missing Hub child process entry');
process.argv = [process.execPath, entry, ...process.argv.slice(3)];
// Windows no can supply Node handle SIGTERM;IPC let each platform away the same close entry.
process.on('message', (message: unknown) => {
  if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'shutdown') return;
  process.disconnect?.();
  if (process.listenerCount('SIGTERM') === 0) process.exit(0);
  process.emit('SIGTERM');
});
await import(pathToFileURL(entry).href);
