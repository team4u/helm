/**
 * 独立的真实 Herdr 总览验收，不调用模型，不纳入默认单测。
 * 运行：pnpm build && timeout 50s node scripts/herdr-overview-smoke.mjs
 * 仅在 Herdr 环境运行，自建临时命名会话；所有控制命令使用该会话的 socket。
 * HELM_OVERVIEW_APP 可指定其他 checkout 的编译入口。日志保留在临时目录。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as backoff } from 'node:timers/promises';

assert.equal(process.env.HERDR_ENV, '1', 'Live acceptance must run inside Herdr');
const appPath = process.env.HELM_OVERVIEW_APP ?? resolve(dirname(fileURLToPath(import.meta.url)), '../packages/kernel/dist/app.js');
const kernelDist = dirname(appPath);
const repository = resolve(kernelDist, '../../..');
const root = await mkdtemp(join(tmpdir(), 'helm-overview-live-'));
const xdg = join(root, 'xdg');
const session = `helm-overview-${process.pid}`;
const socketPath = join(xdg, 'herdr/sessions', session, 'herdr.sock');
const firstCwd = join(root, 'first');
const secondCwd = join(root, 'second');
await Promise.all([mkdir(xdg, { recursive: true }), mkdir(firstCwd), mkdir(secondCwd)]);
const isolatedEnv = { ...process.env, XDG_CONFIG_HOME: xdg };
for (const key of Object.keys(isolatedEnv)) if (key.startsWith('HERDR_')) delete isolatedEnv[key];
isolatedEnv.HERDR_SOCKET_PATH = socketPath;
for (const key of Object.keys(process.env)) if (key.startsWith('HERDR_')) delete process.env[key];
process.env.XDG_CONFIG_HOME = xdg;
process.env.HERDR_SOCKET_PATH = socketPath;
const log = await open(join(root, 'herdr-server.log'), 'a');
const server = spawn('herdr', ['--session', session, 'server'], {
  cwd: root, env: isolatedEnv, stdio: ['ignore', log.fd, log.fd],
});
let spawnError;
server.on('error', error => { spawnError = error; });
await log.close();
let app, hub, token, base;
const calls = [];
const observedEvents = [];
const subscriptions = [];
const streamErrors = [];
let diagnostics;
const checks = [];
let failure;
const target = { socketPath };
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
async function command(executable, args, env = isolatedEnv, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: repository, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${executable} timed out`)); }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${executable} exited ${code}: ${stderr}`));
    });
  });
}
function nextOverview(predicate) {
  let unsubscribe;
  let timer;
  const promise = new Promise((resolve, reject) => {
    timer = setTimeout(() => { unsubscribe?.(); reject(new Error('No matching overview event within 8s')); }, 8_000);
    unsubscribe = app.kernel.events.subscribe(frame => {
      const event = frame.event;
      if (event.type === 'plugin.doc.updated' && event.doc.pluginId === 'builtin:herdr' && event.doc.name === 'overview' && predicate(event.doc.value)) {
        clearTimeout(timer); unsubscribe(); resolve(event.doc.value);
      }
    });
  });
  promise.catch(() => {});
  return promise;
}
const overview = () => app.kernel.plugins.getPublicDoc('builtin:herdr', 'overview').value;
let cleanupPromise;
const deadline = setTimeout(() => stopForSignal('acceptance deadline'), 35_000);
function stopForSignal(reason) {
  failure ??= new Error(`Interrupted: ${reason}`);
  void cleanup().finally(() => process.exit(1));
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stopForSignal(signal));
async function bounded(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} cleanup timed out`)), ms); })]);
  } finally { clearTimeout(timer); }
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    clearTimeout(deadline);
    const cleanupErrors = [];
    for (const [label, close, ms] of [
      ['token', async () => { token?.dispose(); }, 1_000],
      ['Hub', async () => { await hub?.close(); }, 2_000],
      ['Helm', async () => { await app?.close(); }, 3_000],
    ]) {
      try { await bounded(close(), ms, label); } catch (error) { cleanupErrors.push(String(error)); }
    }
    if (base && server.exitCode === null) {
      try { await command('herdr', ['--session', session, 'server', 'stop'], isolatedEnv, 4_000); }
      catch (error) { cleanupErrors.push(String(error)); }
    }
    if (server.exitCode === null) {
      await Promise.race([new Promise(resolve => server.once('close', resolve)), backoff(1_000)]);
    }
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await Promise.race([new Promise(resolve => server.once('close', resolve)), backoff(1_000)]);
    }
    if (server.exitCode === null) { server.kill('SIGKILL'); cleanupErrors.push('Isolated server required SIGKILL'); }
    console.log(JSON.stringify({ root, session, checks, passed: !failure && cleanupErrors.length === 0, failure: failure?.message, cleanupErrors, diagnostics }, null, 2));
    if (failure) console.error(failure);
    if (failure || cleanupErrors.length) process.exitCode = 1;
  })();
  return cleanupPromise;
}
try {
  const { createHerdrTransport } = await import(pathToFileURL(join(kernelDist, 'builtin-plugins/herdr/transport.js')));
  base = createHerdrTransport();
  const readyUntil = Date.now() + 10_000;
  let ready = false;
  while (Date.now() < readyUntil) {
    if (spawnError) throw spawnError;
    if (server.exitCode !== null) throw new Error(`Isolated Herdr exited ${server.exitCode}`);
    try { await base.call(target, 'session.snapshot', {}, { timeoutMs: 500 }); ready = true; break; }
    catch { await backoff(100); }
  }
  check('isolated Herdr server ready', ready);
  const created = await base.call(target, 'workspace.create', { cwd: firstCwd, label: 'overview-existing-shell', focus: false }, { timeoutMs: 5_000 });
  const initial = await base.call(target, 'session.snapshot', {}, { timeoutMs: 5_000 });
  const firstPane = initial.snapshot.panes.find(pane => pane.pane_id === created.root_pane.pane_id);
  check('real snapshot contains a plain shell and no Agent', firstPane && initial.snapshot.agents.length === 0);
  const transport = {
    call(...args) { calls.push(args[1]); return base.call(...args); },
    subscribe: async (destination, onEvent, onError, options) => {
      const record = { paneIds: options?.paneIds, aborted: options?.signal?.aborted ?? false, released: false };
      subscriptions.push(record);
      options?.signal?.addEventListener('abort', () => { record.aborted = true; }, { once: true });
      const stop = await base.subscribe(destination, event => {
        observedEvents.push(event);
        onEvent(event);
      }, error => {
        streamErrors.push(error.message);
        onError(error);
      }, options);
      return () => { record.released = true; stop(); };
    },
    readOutput: (...args) => base.readOutput(...args),
    removeOutput: (...args) => base.removeOutput(...args),
    runGate: (...args) => base.runGate(...args),
  };
  const { createHelm } = await import(pathToFileURL(appPath));
  app = await createHelm({ dataDir: join(root, 'helm-data'), cwd: firstCwd, herdrTransport: transport, watchdogIntervalMs: 0 });
  await app.kernel.plugins.setConfig('builtin:herdr', { socketPath, startupTimeoutMs: 30_000 });
  await app.kernel.plugins.enable('builtin:herdr');
  const row = overview().panes.find(pane => pane.paneId === firstPane.pane_id);
  check('overview includes a pre-existing unmanaged shell', row);
  check('overview preserves real unknown state', row.agentStatus === firstPane.agent_status && row.agentStatus === 'unknown');
  check('unmanaged shell remains human owned', row.ownedBy === 'human');
  check('shell has no fabricated stateChangeSeq', !Object.hasOwn(row, 'stateChangeSeq'));
  check('overview preserves the actual directory', row.effectiveCwd === firstCwd || row.cwd === firstCwd || row.foregroundCwd === firstCwd);
  const { startHub } = await import(pathToFileURL(join(kernelDist, 'http/index.js')));
  hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 });
  token = app.kernel.auth.createProcessToken();
  const response = await fetch(`${hub.url}/api/plugins/builtin%3Aherdr/docs/overview`, { headers: { authorization: `Bearer ${token.token}` } });
  assert.equal(response.status, 200);
  const httpDoc = await response.json();
  check('authenticated HTTP exposes the real shell overview', httpDoc.value.panes.some(pane => pane.paneId === firstPane.pane_id && pane.agentStatus === 'unknown'));
  const cliDoc = JSON.parse(await command(process.execPath, [join(repository, 'packages/node/dist/cli/index.js'), 'plugins', 'doc', 'builtin:herdr', 'overview', '--json'], {
    ...isolatedEnv, HELM_DATA_DIR: join(root, 'cli'), HELM_HUB_URL: hub.url, HELM_TOKEN: token.token,
  }));
  check('compiled CLI exposes the same public overview', cliDoc.value.panes.some(pane => pane.paneId === firstPane.pane_id && pane.agentStatus === 'unknown' && pane.ownedBy === 'human'));
  const createdEvent = nextOverview(doc => doc.panes.some(pane => pane.effectiveCwd === secondCwd || pane.cwd === secondCwd || pane.foregroundCwd === secondCwd));
  const tab = await base.call(target, 'tab.create', { workspace_id: firstPane.workspace_id, cwd: secondCwd, label: 'overview-later-shell', focus: false }, { timeoutMs: 5_000 });
  const afterCreate = await createdEvent;
  check('pane.created updates overview through real socket events', afterCreate.panes.some(pane => pane.paneId === tab.root_pane.pane_id));
  const oldPaneId = tab.root_pane.pane_id;
  const movedEvent = nextOverview(doc => !doc.panes.some(pane => pane.paneId === oldPaneId) && doc.panes.some(pane => pane.paneId !== oldPaneId && (pane.effectiveCwd === secondCwd || pane.cwd === secondCwd || pane.foregroundCwd === secondCwd)));
  const moved = await base.call(target, 'pane.move', { pane_id: oldPaneId, destination: { type: 'new_workspace', label: 'overview-moved-shell', tab_label: 'main' }, focus: false }, { timeoutMs: 5_000 });
  const movedPane = moved.move_result.pane;
  assert.notEqual(movedPane.pane_id, oldPaneId);
  const afterMove = await movedEvent;
  check('pane.moved replaces old public ID with the real new ID', afterMove.panes.some(pane => pane.paneId === movedPane.pane_id) && !afterMove.panes.some(pane => pane.paneId === oldPaneId));
  const closedEvent = nextOverview(doc => !doc.panes.some(pane => pane.paneId === movedPane.pane_id));
  await base.call(target, 'tab.close', { tab_id: movedPane.tab_id }, { timeoutMs: 5_000 });
  await closedEvent;
  check('tab closure removes its panes from overview', !overview().panes.some(pane => pane.paneId === movedPane.pane_id));
  await app.kernel.plugins.disable('builtin:herdr');
  await app.kernel.plugins.enable('builtin:herdr');
  check('disable and re-enable rebuild the overview', overview().panes.some(pane => pane.paneId === firstPane.pane_id));
  await hub.close(); hub = undefined;
  token.dispose(); token = undefined;
  await app.close(); app = undefined;
  const afterClose = await base.call(target, 'session.snapshot', {}, { timeoutMs: 5_000 });
  check('plugin shutdown preserves the unmanaged shell', afterClose.snapshot.panes.some(pane => pane.pane_id === firstPane.pane_id));
  check('plugin never sends input or closes human resources', !calls.some(method => ['agent.start', 'agent.prompt', 'agent.send_keys', 'pane.send_keys', 'pane.send_text', 'pane.send_input', 'pane.report_metadata', 'pane.close', 'tab.close', 'workspace.close'].includes(method)));
} catch (error) {
  failure ??= error;
  if (app && base) {
    try {
      const raw = await base.call(target, 'session.snapshot', {}, { timeoutMs: 1_000 });
      diagnostics = { events: [...observedEvents], subscriptions: structuredClone(subscriptions), streamErrors: [...streamErrors], overview: overview(), panes: raw.snapshot.panes, calls: [...calls] };
    } catch (diagnosticError) { diagnostics = { events: observedEvents, streamErrors, error: diagnosticError.message, calls }; }
  }
} finally {
  await cleanup();
}
