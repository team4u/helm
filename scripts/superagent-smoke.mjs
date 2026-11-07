import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHelm } from '../packages/kernel/dist/app.js';
import { startHub } from '../packages/kernel/dist/http/index.js';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../packages/node/dist/cli/index.js', import.meta.url));

const dataDir = await mkdtemp(join(tmpdir(), 'helm-superagent-built-'));
const pluginId = 'builtin:superagent';
let app;
let hub;
let cliToken;
async function cli(args) {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliEntry, ...args], {
      cwd: repositoryRoot,
      env: { ...process.env, HELM_DATA_DIR: dataDir, HELM_HUB_URL: hub.url, HELM_TOKEN: cliToken ?? '', HELM_CONVERSATION_ID: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 15000);
    child.stdout.on('data', (chunk) => stdout += chunk.toString());
    child.stderr.on('data', (chunk) => stderr += chunk.toString());
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut }); });
  });
}
async function success(args) {
  const result = await cli([...args, '--json']);
  assert.equal(result.timedOut, false, `CLI timed out: ${args.join(' ')}`);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout);
}
async function open() {
  app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 });
  hub = await startHub({ kernel: app.kernel, workflows: app.workflows, port: 0 });
}
async function close() {
  try { await hub?.close(); } finally { hub = undefined; await app?.close(); app = undefined; }
}
try {
  await open();
  let plugins = await app.kernel.plugins.list();
  assert.equal(plugins.find((plugin) => plugin.id === pluginId)?.enabled, false);
  assert.equal(app.kernel.listConversations().length, 1);
  await success(['setup', '--password', 'superagent-built-smoke-password']);
  cliToken = JSON.parse(await readFile(join(dataDir, 'cli-token'), 'utf8')).token;
  await success(['plugins', 'enable', pluginId]);
  const first = (await success(['plugins', 'doc', pluginId, 'index'])).value;
  assert.ok(first.routerConversationId > 1);
  assert.ok(first.watchdogConversationId > 1);
  assert.notEqual(first.routerConversationId, first.watchdogConversationId);
  assert.equal(app.kernel.getConversation(first.routerConversationId).profileId, 'superagent');
  assert.equal(app.kernel.getConversation(first.watchdogConversationId).profileId, 'watchdog');
  assert.equal(app.kernel.getConversation(1).profileId, 'assistant');
  await assert.rejects(app.kernel.deleteConversation(first.routerConversationId), (error) => error.code === 'conversation_managed_by_plugin');
  const denied = await cli(['superagent', 'watchdog_abort', '--conversation-id', '1', '--json']);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /watchdog_target_(human|protected)/);
  await success(['superagent', 'set_router_mode', '--input', '{"enabled":false}']);
  assert.equal(app.kernel.plugins.getConfig(pluginId).routerMode, false);
  await close();
  await open();
  plugins = await app.kernel.plugins.list();
  assert.equal(plugins.find((plugin) => plugin.id === pluginId)?.enabled, true);
  const second = (await success(['plugins', 'doc', pluginId, 'index'])).value;
  assert.equal(second.routerConversationId, first.routerConversationId);
  assert.equal(second.watchdogConversationId, first.watchdogConversationId);
  assert.equal(app.kernel.plugins.getConfig(pluginId).routerMode, false);
  const actions = await success(['actions', 'list']);
  for (const actionId of ['archive_worker', 'set_router_mode', 'watchdog_inspect', 'watchdog_recover', 'watchdog_abort']) {
    assert.ok(actions.some((action) => action.pluginId === pluginId && action.id === actionId), actionId);
  }
  await success(['plugins', 'disable', pluginId]);
  await app.kernel.deleteConversation(second.routerConversationId);
  await app.kernel.deleteConversation(second.watchdogConversationId);
  await close();
  await open();
  assert.equal((await app.kernel.plugins.list()).find((plugin) => plugin.id === pluginId)?.enabled, false);
  assert.equal(app.kernel.listConversations().length, 1);
  console.log('SuperAgent compiled smoke passed: default disabled, CLI enable/actions, root unchanged, dynamic managed conversations, ownership guard, persistent routing mode and IDs, disable and protection release. No model was called.');
} finally {
  try { await close(); } finally { await rm(dataDir, { recursive: true, force: true }); }
}
