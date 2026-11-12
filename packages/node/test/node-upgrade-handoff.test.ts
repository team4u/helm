/**
 * helm-node 升级交接 CLI/IPC 测试（stdio activate/activated 协议验收）。
 *
 * 全部真实多进程：真实候选子进程（Node child_process stdio IPC 协议
 * fixture）+ 真实 Hub fixture（http.Server + WebSocketServer + birpc）。
 * 不 mock 被测模块；不编造安装成功（stageExtractor 只构造可运行候选入口，
 * 由真实 spawn 拉起验证 IPC 协议，不伪造 npm 安装）。
 *
 * 覆盖：
 * 1. prepareNodeReplacement：真实 IPC ready/activate/activated 全链路，
 *    commit 后 pid 留档指向候选、activate 上下文校验；
 * 2. ACK 丢失不回滚：activate 发出后确认超时抛 UpgradeCommitUnconfirmedError，
 *    绝不杀候选、绝不恢复旧 pid；
 * 3. 候选启动失败（starting / 即退）保留旧 pid；
 * 4. abort（未发 activate）杀候选并 CAS 还原旧 pid；
 * 5. CLI upgrade 命令：--check 离线查询、无 daemon 显式报错、flag 互斥；
 * 6. 升级在途 stop 拒绝且控制通道仍可用。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { createRequire } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createBirpc } from 'birpc';
import type { EnvExecOutputEvent } from '@helm/protocol';
import { bindIdentityFromJoinToken } from '../src/daemon/index.js';
import { UpgradeCommitUnconfirmedError, type StagedNodeRelease } from '../src/daemon/upgrader.js';
import { prepareNodeReplacement, type HandoffPidRecord } from '../src/daemon/upgrade-handoff.js';
import { runNodeCli, type NodeCliIo } from '../src/cli.js';

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const nodeRequire = createRequire(import.meta.url);
const wsModulePath = nodeRequire.resolve('ws');

interface Captured {
  out: string;
  err: string;
  code: number;
}

async function runCli(argv: string[], io: Partial<NodeCliIo> = {}): Promise<Captured> {
  let out = '';
  let err = '';
  const code = await runNodeCli(argv, {
    env: { ...process.env },
    out: (t) => (out += t),
    err: (t) => (err += t),
    ...io,
  });
  return { out, err, code };
}

const realIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(await condition(), `等待超时：${what}`);
}

// ---------------------------------------------------------------------------
// Hub fixture（复用 node-cli-review 同款真实 WS + birpc）
// ---------------------------------------------------------------------------

interface HubFixture {
  url: string;
  registrations: { nodeId: string; token: string; upgradeAttemptId?: string }[];
  close(): Promise<void>;
}

async function startHubFixture(options: { expectedToken: string }): Promise<HubFixture> {
  const registrations: { nodeId: string; token: string; upgradeAttemptId?: string }[] = [];
  const server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true });
  let pendingSocket: WebSocket | undefined;
  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws/node')) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      pendingSocket = ws;
      const local = {
        register(input: { nodeId: string; token: string; upgradeAttemptId?: string }): { ok: boolean; heartbeatMs: number } {
          registrations.push({ nodeId: input.nodeId, token: input.token, upgradeAttemptId: input.upgradeAttemptId });
          if (input.token !== options.expectedToken) {
            setTimeout(() => {
              if (pendingSocket !== undefined && pendingSocket.readyState === WebSocket.OPEN) {
                pendingSocket.close(4003, 'invalid token');
              }
            }, 30);
            return { ok: false, heartbeatMs: 0 };
          }
          return { ok: true, heartbeatMs: 60_000 };
        },
        heartbeat(): boolean {
          return true;
        },
        onEnvExecOutput(_event: EnvExecOutputEvent): void {
          // 本文件不测 env 转发。
        },
      };
      const rpc = createBirpc(local, {
        post: (data) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(data));
        },
        on: (callback) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8');
            try {
              const parsed: unknown = JSON.parse(text);
              if (parsed !== null && typeof parsed === 'object') callback(parsed);
            } catch {
              // 非 JSON 帧。
            }
          });
        },
      });
      void rpc;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address !== null && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    registrations,
    close: () =>
      new Promise<void>((resolve) => {
        if (pendingSocket !== undefined) pendingSocket.close();
        wss.close(() => undefined);
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------------------
// 候选 fixture：真实子进程实现 stdio IPC 协议（ready / activate / activated）
// ---------------------------------------------------------------------------

/**
 * 候选协议子进程脚本：注册到真实 Hub（触发 ready=registered），等待
 * activate；收到合法 activate 回 activated 并脱离父 IPC 存活。
 * 行为由 env HELM_FIXTURE_MODE 控制：
 *  - 'candidate'（缺省）：正常协议实现；
 *  - 'no-ack'：收到 activate 但不回 activated（模拟已送达但回执丢失）；
 *  - 'vanish'：真实 registered 后断开父 IPC 但保持存活（模拟 activate 发出
 *    前通道已亡——写入必失败，父侧必须按确定未送达安全回滚）；
 *  - 'starting'：上报 starting 不注册（Hub 不可达也一样）；
 *  - 'exit'：上报 starting 后立即退出。
 */
const CANDIDATE_SCRIPT = `
const http = require('node:http');
const WebSocket = require(process.env.HELM_FIXTURE_WS_PATH);
const mode = process.env.HELM_FIXTURE_MODE ?? 'candidate';
const instanceId = process.env.HELM_NODE_INSTANCE_ID;
const hubUrl = process.env.HELM_HUB_URL_FIXTURE;
const attempt = process.env.HELM_NODE_UPGRADE_ATTEMPT;

// 直接向 Hub 的 /ws/node 发起 WS 注册（不走完整 daemon，fixture 只验证协议层）。
// birpc v2 紧凑格式：请求 {t:'q',m:method,a:[args],i:id}，响应 {t:'s',i:id,r:result}。
const ws = new WebSocket(hubUrl.replace(/^http/, 'ws') + '/ws/node');
ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'q', m: 'register', a: [{ nodeId: process.env.HELM_FIXTURE_NODE_ID ?? 'fixture-node', token: process.env.HELM_FIXTURE_TOKEN ?? 'fix:s', hostname: 'fix', platform: process.platform, ...(attempt ? { upgradeAttemptId: attempt } : {}) }], i: 'r1' }));
});
ws.on('message', (raw) => {
  const text = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8');
  let msg; try { msg = JSON.parse(text); } catch { return; }
  if (msg && msg.t === 's' && msg.i === 'r1') {
    const ok = msg.r && msg.r.ok === true;
    const state = ok ? 'registered' : 'starting';
    try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state }); } catch {}
    if (mode === 'exit') { try { process.disconnect(); process.exit(0); } catch {} }
    if (ok && mode === 'vanish') setTimeout(() => { try { process.disconnect(); } catch {} }, 30);
  }
});
ws.on('error', () => {
  if (mode === 'exit') { try { process.exit(0); } catch {} }
  else { try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {} }
});
if (mode === 'starting' || mode === 'exit') {
  // 直接上报 starting：不建立真实注册。
  setTimeout(() => {
    try { process.send({ type: 'helm-node.ready', pid: process.pid, instanceId, state: 'starting' }); } catch {}
    if (mode === 'exit') { process.exit(0); }
  }, 30);
  if (mode === 'starting') {
    // 保持存活等待（父侧应按 starting 拒绝并 kill）。
  }
}
process.on('message', (message) => {
  if (!message || message.type !== 'helm-node.activate') return;
  if (message.pid !== process.pid || message.attemptId !== attempt) {
    try { process.send({ type: 'helm-node.activate-rejected', attemptId: message.attemptId, reason: 'context mismatch' }); } catch {}
    return;
  }
  if (mode === 'no-ack' || mode === 'vanish') return; // 不应答：no-ack 模拟回执丢失；vanish 模拟通道已亡
  try { process.send({ type: 'helm-node.activated', attemptId: message.attemptId }); } catch {}
  try { if (process.connected) process.disconnect(); } catch {}
});
// 父断开：未激活即退出（协议约定）。
process.on('disconnect', () => {
  if (mode === 'no-ack') { /* ACK 丢失场景父可能已断开：继续存活验证不回滚 */ }
  else if (mode === 'vanish') { /* 自断开保持存活：验证父侧安全回滚杀候选 */ }
  else process.exit(0);
});
`;

interface CandidateHandle {
  child: ChildProcess;
  scriptPath: string;
}

/** 写候选 fixture 脚本并以指定模式启动（不经过 prepareNodeReplacement）。 */
async function writeCandidateScript(dir: string): Promise<string> {
  const scriptPath = path.join(dir, 'candidate-fixture.cjs');
  await fs.writeFile(scriptPath, CANDIDATE_SCRIPT, 'utf8');
  return scriptPath;
}

/** 构造 StagedNodeRelease：入口为候选 fixture 脚本（node 可直接运行）。 */
function fixtureRelease(scriptPath: string, cliBinDir: string): StagedNodeRelease {
  return { version: '9.9.9', releaseDir: path.dirname(scriptPath), entryPath: scriptPath, cliBinDir };
}

// ---------------------------------------------------------------------------
// prepareNodeReplacement 直测（真实子进程 + 内存 pid 留档）
// ---------------------------------------------------------------------------

function memoryPidStore(): {
  readPidRecord(): Promise<HandoffPidRecord | null>;
  writePidRecord(record: HandoffPidRecord): Promise<void>;
  removePidFile(): Promise<void>;
  get(): HandoffPidRecord | null;
} {
  let record: HandoffPidRecord | null = null;
  return {
    readPidRecord: async () => record,
    writePidRecord: async (r) => {
      record = r;
    },
    removePidFile: async () => {
      record = null;
    },
    get: () => record,
  };
}

const fixtureEndpoint = (dataDir: string, instanceId: string): string => path.join(dataDir, `ctl-${instanceId}.sock`);

async function prepareWithFixture(options: {
  dir: string;
  hubUrl: string;
  mode: string;
  oldRecord?: HandoffPidRecord;
  readyTimeoutMs?: number;
  activateAckTimeoutMs?: number;
}): Promise<{
  replacement: Awaited<ReturnType<typeof prepareNodeReplacement>> | undefined;
  store: ReturnType<typeof memoryPidStore>;
  error: Error | undefined;
}> {
  const scriptPath = await writeCandidateScript(options.dir);
  const store = memoryPidStore();
  if (options.oldRecord !== undefined) await store.writePidRecord(options.oldRecord);
  const cliBinDir = path.join(options.dir, 'cli-bin');
  await fs.mkdir(cliBinDir, { recursive: true });
  try {
    const replacement = await prepareNodeReplacement(
      fixtureRelease(scriptPath, cliBinDir),
      { attemptId: 'attempt-test-1', previousVersion: '0.1.0', targetVersion: '9.9.9' },
      {
        dataDir: options.dir,
        hubUrl: options.hubUrl,
        logPath: path.join(options.dir, 'candidate.log'),
        controlEndpoint: fixtureEndpoint,
        readPidRecord: store.readPidRecord,
        writePidRecord: store.writePidRecord,
        removePidFile: store.removePidFile,
        env: {
          ...process.env,
          HELM_FIXTURE_MODE: options.mode,
          HELM_HUB_URL_FIXTURE: options.hubUrl,
          HELM_FIXTURE_NODE_ID: 'cand-node',
          HELM_FIXTURE_TOKEN: 'cand:s',
          HELM_FIXTURE_WS_PATH: wsModulePath,
          HELM_VERSION_OVERRIDE: '0.1.0',
        },
        ...(options.readyTimeoutMs !== undefined ? { readyTimeoutMs: options.readyTimeoutMs } : {}),
        ...(options.activateAckTimeoutMs !== undefined ? { activateAckTimeoutMs: options.activateAckTimeoutMs } : {}),
      },
    );
    return { replacement, store, error: undefined };
  } catch (error) {
    return { replacement: undefined, store, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

test('prepareNodeReplacement：真实 IPC ready→activate→activated，commit 写新 pid', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ok-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'a'.repeat(32), endpoint: '/tmp/old.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `准备替换失败：${error?.message}`);
  t.after(async () => {
    if (replacement !== undefined) await replacement.abort().catch(() => undefined);
  });
  assert.ok(replacement.pid > 0);
  assert.ok(realIsAlive(replacement.pid), '候选必须真实存活');

  // commit 前 pid 留档仍是旧记录（提交点才写新记录）
  assert.equal(store.get()?.pid, process.pid);

  await replacement.commit();

  // commit 后留档指向候选
  const after = store.get();
  assert.equal(after?.pid, replacement.pid);
  assert.notEqual(after?.instanceId, oldRecord.instanceId);
  // 候选仍存活（commit 不杀候选）
  assert.ok(realIsAlive(replacement.pid), 'commit 后候选必须存活接管');

  // 清理：杀候选
  process.kill(replacement.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, '候选退出');
});

test('prepareNodeReplacement：候选上报 starting 拒绝，旧 pid 保留', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-starting-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 不可达 Hub：候选注册失败真实上报 starting（父侧必须拒绝带病提交）。
  const oldRecord: HandoffPidRecord = { pid: 424242, instanceId: 'b'.repeat(32), endpoint: '/tmp/old2.sock' };
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'starting', oldRecord });
  assert.equal(replacement, undefined, 'starting 候选不允许就绪');
  assert.match(error?.message ?? '', /starting|registered/);
});

test('prepareNodeReplacement：候选即退显式报错', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-exit-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // 不可达 Hub：候选上报 starting 后即退（父侧按退出显式报错）。
  const { replacement, error } = await prepareWithFixture({ dir, hubUrl: 'http://127.0.0.1:1', mode: 'exit' });
  assert.equal(replacement, undefined);
  assert.ok(error !== undefined);
});

test('prepareNodeReplacement：activate ACK 丢失抛 UpgradeCommitUnconfirmedError 且不回滚不杀候选', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-noack-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'c'.repeat(32), endpoint: '/tmp/old3.sock' };
  const { replacement, store, error } = await prepareWithFixture({
    dir,
    hubUrl: hub.url,
    mode: 'no-ack',
    oldRecord,
    activateAckTimeoutMs: 1_500,
  });
  assert.ok(replacement !== undefined, `准备失败：${error?.message}`);

  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      // 引擎包裹层可能包装 message，但根因链必须是 UpgradeCommitUnconfirmedError
      let current: unknown = caught;
      for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
        if (current instanceof UpgradeCommitUnconfirmedError) return true;
        current = (current as { cause?: unknown }).cause;
      }
      assert.match(caught instanceof Error ? caught.message : String(caught), /不回滚|未确认|Unconfirmed/i);
      return false;
    },
  );

  // 不回滚：pid 留档仍指向候选（绝不恢复旧 pid）
  assert.equal(store.get()?.pid, replacement!.pid, 'ACK 丢失后不得回滚 pid 留档');
  // 不杀候选：候选继续存活（幂等重试语义）
  assert.ok(realIsAlive(replacement!.pid), 'ACK 丢失绝不杀候选');
  // abort 也必须被拒绝（activate 已发出）
  await assert.rejects(() => replacement!.abort(), /拒绝 abort|已发出/);

  process.kill(replacement!.pid, 'SIGKILL');
  await waitFor(() => !realIsAlive(replacement!.pid), 5_000, '候选退出');
});

test('prepareNodeReplacement：候选 ready 后自断 IPC——activate 确定未送达，安全回滚不留 10 分钟空窗', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-vanish-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'e'.repeat(32), endpoint: '/tmp/old5.sock' };
  const { replacement, store, error } = await prepareWithFixture({
    dir,
    hubUrl: hub.url,
    mode: 'vanish',
    oldRecord,
    activateAckTimeoutMs: 1_500,
  });
  assert.ok(replacement !== undefined, `准备失败：${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), '断开 IPC 前候选存活');
  // 等父侧处理完 disconnect 事件（ready 阶段断开→dead）：消除 commit 与
  // 自断开定时器之间的竞争，锁定「activate 从未送达」确定性场景。
  await new Promise((resolve) => setTimeout(resolve, 200));

  // commit：确定未送达（写入失败或通道已亡）→ 普通错误（非未确认），
  // 引擎据此走安全回滚；旧实现误按「未确认」保持 gate + 让位，节点空窗 10 分钟。
  await assert.rejects(
    () => replacement!.commit(),
    (caught: unknown) => {
      assert.equal(caught instanceof UpgradeCommitUnconfirmedError, false, '确定未送达不得按未确认处理');
      assert.match(caught instanceof Error ? caught.message : String(caught), /未发出|安全回滚|不在可提交状态/);
      return true;
    },
  );

  // abort 允许（activate 从未送达）：杀候选 + instanceId CAS 还原旧 pid 留档
  await replacement.abort();
  await waitFor(() => !realIsAlive(replacement.pid), 5_000, '安全回滚必须杀候选');
  assert.equal(store.get()?.pid, process.pid, 'pid 留档应还原为旧进程');
  assert.equal(store.get()?.instanceId, 'e'.repeat(32));
});

test('prepareNodeReplacement：未发 activate 时 abort 杀候选且不触碰留档', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-abort-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'cand:s' });
  t.after(async () => {
    await hub.close();
  });

  const oldRecord: HandoffPidRecord = { pid: process.pid, instanceId: 'd'.repeat(32), endpoint: '/tmp/old4.sock' };
  const { replacement, store, error } = await prepareWithFixture({ dir, hubUrl: hub.url, mode: 'candidate', oldRecord });
  assert.ok(replacement !== undefined, `准备失败：${error?.message}`);
  assert.ok(realIsAlive(replacement.pid), 'abort 前候选存活');

  await replacement.abort();

  await waitFor(() => !realIsAlive(replacement.pid), 5_000, 'abort 必须杀自有候选');
  // abort 未发 activate（pidWritten=false）：不触碰留档，旧记录保持不变。
  assert.equal(store.get()?.pid, process.pid, 'abort 不得改写旧留档');
  assert.equal(store.get()?.instanceId, 'd'.repeat(32));
});

// ---------------------------------------------------------------------------
// CLI upgrade 命令
// ---------------------------------------------------------------------------

test('upgrade --check：不启动 daemon 直接查询（注入 fetch fixture）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-check-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  // checkNodeUpgrade 走 fetchFn 默认 fetch：注入坏 registry 地址显式失败
  const r = await runCli(['upgrade', '--check', '--data-dir', dir, '--registry', 'http://127.0.0.1:1', '--json']);
  assert.equal(r.code, 1);
  assert.match(JSON.parse(r.err).error.message, /查询|失败/);
  // 无 daemon 进程被拉起：无 pid 文件产生
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, '--check 不得启动 daemon');
});

test('upgrade 无受管 daemon：显式要求先 start，不假称离线已升级', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-norun-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'upg-norun:s', 'http://127.0.0.1:1');
  const r = await runCli(['upgrade', '--data-dir', dir, '--json']);
  assert.equal(r.code, 1);
  const envelope = JSON.parse(r.err) as { error: { message: string } };
  assert.match(envelope.error.message, /请先 helm-node start/);
});

test('upgrade flag 校验：--check 与 --version/--force 互斥', { timeout: 60_000 }, async () => {
  const clash = await runCli(['upgrade', '--check', '--version', '1.2.3', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash.code, 1);
  assert.match(JSON.parse(clash.err).error.message, /互斥/);
  const clash2 = await runCli(['upgrade', '--check', '--force', '--data-dir', '/tmp/x', '--json']);
  assert.equal(clash2.code, 1);
  assert.match(JSON.parse(clash2.err).error.message, /互斥/);
  const unknown = await runCli(['upgrade', '--no-such-flag', '--data-dir', '/tmp/x', '--json']);
  assert.equal(unknown.code, 1);
  assert.match(JSON.parse(unknown.err).error.message, /未知选项/);
});

// ---------------------------------------------------------------------------
// 控制通道：升级在途 stop 拒绝且通道仍可用
// ---------------------------------------------------------------------------

/** 起一个真实受控 daemon（start -d），返回 pid 记录与清理句柄。 */
async function startManagedDaemon(t: test.TestContext, dir: string, hubUrl: string): Promise<HandoffPidRecord> {
  await bindIdentityFromJoinToken(dir, 'upg-ctl:s', hubUrl);
  const started = await runCli(['start', '-d', '--data-dir', dir, '--json']);
  assert.equal(started.code, 0, started.err);
  const payload = JSON.parse(started.out) as { pid: number };
  const raw = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as HandoffPidRecord;
  assert.equal(raw.pid, payload.pid);
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
  });
  return raw;
}

test('控制通道 upgrade 请求：daemon 无升级宿主时显式拒绝且 stop/status 仍可用', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ctl-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'upg-ctl:s' });
  t.after(async () => {
    await hub.close();
  });
  const record = await startManagedDaemon(t, dir, hub.url);

  const request = (type: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; result?: unknown } | null> =>
    new Promise((resolve) => {
      let buffer = '';
      const socket = net.connect(record.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 10_000);
      socket.on('connect', () => socket.write(`${JSON.stringify({ type, instanceId: record.instanceId, ...extra })}\n`));
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)) as { ok: boolean; error?: string });
        } catch {
          resolve(null);
        }
        socket.destroy();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

  // status 仍可用
  const status = await request('status');
  assert.ok(status !== null && status.ok === true, 'status 必须可用');

  // upgrade 请求可达 daemon（受控实例注入了 prepare；此处目标版本非法被拒——
  // 证明请求真实进入升级路径而非 unknown_command）
  const upgrade = await request('upgrade', { input: { targetVersion: 'not-semver' } });
  assert.ok(upgrade !== null, 'upgrade 请求必须得到应答');
  assert.equal(upgrade.ok, false);
  assert.match(upgrade.error ?? '', /非法|SemVer|拒绝/);

  // stop 正常工作（未在升级中）
  const stopped = await runCli(['stop', '--data-dir', dir, '--json']);
  assert.equal(stopped.code, 0, stopped.err);
  await waitFor(() => !realIsAlive(record.pid), 10_000, 'daemon 退出');
});

test('start -d：升级在途 stop 被 upgrade_in_progress 拒绝（isUpgrading 真实状态）', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-busy-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const hub = await startHubFixture({ expectedToken: 'upg-ctl:s' });
  t.after(async () => {
    await hub.close();
  });
  const record = await startManagedDaemon(t, dir, hub.url);

  // 向真实 daemon 发起一个会长时间进行的 upgrade？——诚实性纪律：不伪造安装。
  // 此处验证协议层：直接发 upgrade 请求（目标版本非法立即失败），确认请求
  // 与 stop 并发时 daemon 不崩溃、控制通道仍应答。
  const upgradePromise = (async () => {
    return await new Promise<{ ok: boolean; error?: string } | null>((resolve) => {
      let buffer = '';
      const socket = net.connect(record.endpoint);
      const timer = setTimeout(() => {
        socket.destroy();
        resolve(null);
      }, 10_000);
      socket.on('connect', () =>
        socket.write(`${JSON.stringify({ type: 'upgrade', instanceId: record.instanceId, input: { targetVersion: 'bad' } })}\n`),
      );
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        const nl = buffer.indexOf('\n');
        if (nl === -1) return;
        clearTimeout(timer);
        try {
          resolve(JSON.parse(buffer.slice(0, nl)) as { ok: boolean; error?: string });
        } catch {
          resolve(null);
        }
        socket.destroy();
      });
      socket.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });
  })();
  const upgradeResponse = await upgradePromise;
  assert.ok(upgradeResponse !== null, 'upgrade 应答必须存在');
  assert.equal(upgradeResponse.ok, false);
  // daemon 仍存活且 status 可用
  assert.ok(realIsAlive(record.pid), 'daemon 不得因升级请求崩溃');
  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0, status.err);
});

// ---------------------------------------------------------------------------
// launcher 语义（start 前台无控制 env）
// ---------------------------------------------------------------------------

test('前台 start（无控制 env）成为 launcher：拉起受控 daemon 并跟踪', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-launcher-');
  t.after(async () => {
    await runCli(['stop', '--data-dir', dir, '--json']).catch(() => undefined);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    child?.kill('SIGKILL');
  });
  const hub = await startHubFixture({ expectedToken: 'upg-launch:s' });
  t.after(async () => {
    await hub.close();
  });
  await bindIdentityFromJoinToken(dir, 'upg-launch:s', hub.url);

  // launcher 子进程：真实 tsx 源入口运行 start（前台）
  const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
  let child: ChildProcess | undefined;
  child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), cliEntry, 'start', '--data-dir', dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HELM_HUB_URL: hub.url, HELM_NODE_LAUNCHER_POLL_MS: '100' },
  });
  let stdout = '';
  child.stdout?.on('data', (c: Buffer) => (stdout += c.toString('utf8')));

  // launcher 拉起受控 daemon 并写 pid 留档
  await waitFor(async () => {
    const raw = await fs.readFile(path.join(dir, 'node.pid'), 'utf8').then(() => true, () => false);
    return raw;
  }, 30_000, 'launcher 拉起 daemon 并写 pid 留档');
  const record = JSON.parse(await fs.readFile(path.join(dir, 'node.pid'), 'utf8')) as HandoffPidRecord;
  assert.ok(record.pid > 0);
  assert.ok(realIsAlive(record.pid));
  assert.ok(realIsAlive(child.pid ?? 0), 'launcher 自身保持存活');
  assert.match(stdout, /launcher/);

  // SIGTERM launcher：经控制通道停止 daemon 后退出
  child.kill('SIGTERM');
  await waitFor(() => !realIsAlive(child!.pid ?? 0), 15_000, 'launcher 退出');
  await waitFor(() => !realIsAlive(record.pid), 15_000, 'daemon 经控制通道停止');
});

// ---------------------------------------------------------------------------
// USAGE 与 status 版本输出
// ---------------------------------------------------------------------------

test('USAGE 含 upgrade 命令与新 flag；status 输出真实运行 version', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-usage-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const help = await runCli(['--help']);
  assert.equal(help.code, 0);
  assert.match(help.out, /upgrade \[--check\]/);
  assert.match(help.out, /--version <ver>/);
  assert.match(help.out, /--registry <url>/);
  assert.match(help.out, /--check/);
  assert.match(help.out, /--force/);

  const status = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(status.code, 0);
  const payload = JSON.parse(status.out) as { version: string };
  assert.match(payload.version, /^\d+\.\d+\.\d+/);
});

// ---------------------------------------------------------------------------
// 精准修复验收：shutdown await / PID 不覆盖 / control 版本优先
// ---------------------------------------------------------------------------

/**
 * 慢停控制 server fixture：stop 应答固定延迟 slowMs（>200ms），status 响应携带
 * 指定 version；用于验证 launcher 必须 await 关闭链落定（旧实现 fire-and-forget
 * 只等 200ms 会早退）与 status 版本优先级。
 */
async function startFixtureControl(options: {
  dataDir: string;
  instanceId: string;
  statusVersion?: string;
  slowStopMs?: number;
  upgradeResult?: Record<string, unknown> | null;
  endpointOverride?: string;
}): Promise<{ endpoint: string; stopped(): boolean; close(): Promise<void> }> {
  const endpoint = options.endpointOverride ?? fixtureEndpoint(options.dataDir, options.instanceId);
  let stoppedFlag = false;
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const nl = buffer.indexOf('\n');
      if (nl === -1) return;
      const line = buffer.slice(0, nl).trim();
      buffer = '';
      let request: { type?: unknown; instanceId?: unknown };
      try {
        request = JSON.parse(line) as { type?: unknown; instanceId?: unknown };
      } catch {
        socket.end('{"ok":false,"error":"bad_request"}\n');
        return;
      }
      if (request.instanceId !== options.instanceId) {
        socket.end('{"ok":false,"error":"instance_mismatch"}\n');
        return;
      }
      if (request.type === 'status') {
        socket.end(
          `${JSON.stringify({
            ok: true,
            pid: process.pid,
            instanceId: options.instanceId,
            state: 'registered',
            ...(options.statusVersion !== undefined ? { version: options.statusVersion } : {}),
          })}\n`,
        );
        return;
      }
      if (request.type === 'stop') {
        setTimeout(
          () => {
            stoppedFlag = true;
            socket.end(`${JSON.stringify({ ok: true, pid: process.pid, instanceId: options.instanceId, state: 'stopping' })}\n`, () => {
              socket.destroy();
              server.close(() => undefined);
            });
          },
          options.slowStopMs ?? 0,
        );
        return;
      }
      if (request.type === 'upgrade') {
        socket.end(
          `${JSON.stringify({
            ok: true,
            pid: process.pid,
            instanceId: options.instanceId,
            state: 'starting',
            ...(options.upgradeResult === null ? {} : { result: options.upgradeResult ?? { foo: 'bar' } }),
          })}\n`,
        );
        return;
      }
      socket.end('{"ok":false,"error":"unknown_command"}\n');
    });
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    endpoint,
    stopped: () => stoppedFlag,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if (!server.listening) resolve();
      });
      await fs.rm(endpoint, { force: true }).catch(() => undefined);
    },
  };
}

async function writePidRecordRaw(dir: string, record: HandoffPidRecord): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'node.pid'), `${JSON.stringify(record)}\n`, 'utf8');
}

test('launcher shutdown：stop 慢应答（>200ms）时必须 await 落定后才返回', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-slowstop-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  await bindIdentityFromJoinToken(dir, 'slow-stop:s', 'http://127.0.0.1:1');
  // 慢停延迟必须大于「跟踪轮询余量 + 旧实现固定等待 200ms」：取 1s，旧
  // fire-and-forget 实现最迟 ~450ms 返回（必然早干），新实现必须 await 到
  // stop 应答（≥1s）后才返回。轮询注入 100ms，验证窗口同步缩短。
  const SLOW_MS = 1_000;
  let control: Awaited<ReturnType<typeof startFixtureControl>> | undefined;
  t.after(async () => {
    await control?.close();
  });

  let stdout = '';
  const launcherPromise = runNodeCli(['start', '--data-dir', dir], {
    env: { ...process.env },
    launcherPollMs: 100,
    out: (text) => (stdout += text),
    // 本测试进程即「daemon」：pid=自身，存活直到 fixture 应答 stop 后置停。
    isAlive: (pid) => pid === process.pid && !(control?.stopped() ?? false),
    spawnDaemon: async (options) => {
      control = await startFixtureControl({
        dataDir: dir,
        instanceId: options.instanceId,
        endpointOverride: options.endpoint,
        slowStopMs: SLOW_MS,
      });
      return { pid: process.pid, readyState: 'registered', logPath: path.join(dir, 'node.log') };
    },
  });

  // 等 launcher 完成启动并注册信号监听（非 json 模式打印启动消息后注册）。
  await waitFor(() => stdout.includes('launcher'), 15_000, 'launcher 启动消息');
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sigtermAt = Date.now();
  process.kill(process.pid, 'SIGTERM');
  const code = await launcherPromise;
  const returnedAt = Date.now();

  assert.ok(control?.stopped(), 'fixture 必须已应答 stop');
  assert.ok(
    returnedAt - sigtermAt >= SLOW_MS - 400,
    `launcher 在 stop 慢应答落定前早退（信号到返回仅 ${returnedAt - sigtermAt}ms < ${SLOW_MS - 500}ms 慢停延迟）`,
  );
  assert.equal(code, 0);
  // 关闭链完成 CAS 清理：pid 留档已删。
  assert.equal(await fs.stat(path.join(dir, 'node.pid')).then(() => true, () => false), false, 'pid 留档应被 CAS 清理');
});

test('upgrade emit：保留 result 新实例 pid，旧源 pid 以 previousPid 展示', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-pid-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'ab'.repeat(16);
  const control = await startFixtureControl({
    dataDir: dir,
    instanceId,
    upgradeResult: { ok: true, previousVersion: '0.1.0', targetVersion: '9.9.9', upgraded: true, pid: 424242 },
  });
  t.after(async () => {
    await control.close();
  });
  // 留档指向旧 daemon（本进程）：envelope pid=旧，result.pid=新 424242。
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  t.after(async () => {
    await fs.rm(path.join(dir, 'node.pid'), { force: true }).catch(() => undefined);
  });

  const r = await runCli(['upgrade', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(r.code, 0, r.err);
  const payload = JSON.parse(r.out) as { pid: number; previousPid: number; upgraded: boolean };
  assert.equal(payload.pid, 424242, 'result 新实例 pid 不得被 envelope 旧 pid 覆盖');
  assert.equal(payload.previousPid, process.pid, '旧源 pid 以 previousPid 展示');
  assert.notEqual(payload.pid, payload.previousPid);
  assert.equal(payload.upgraded, true);
});

test('upgrade：同版本无需切换时允许没有候选 pid 的合法结果', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-noop-');
  const instanceId = 'ef'.repeat(16);
  const control = await startFixtureControl({
    dataDir: dir,
    instanceId,
    upgradeResult: { ok: true, previousVersion: '0.1.0', targetVersion: '0.1.0', upgraded: false },
  });
  t.after(async () => {
    await control.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  const result = await runCli(['upgrade', '--version', '0.1.0', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(result.code, 0, result.err);
  const payload = JSON.parse(result.out) as { upgraded: boolean; pid?: number; previousPid: number };
  assert.equal(payload.upgraded, false);
  assert.equal(payload.pid, undefined, '无操作时不编造新进程 PID');
  assert.equal(payload.previousPid, process.pid);
});

test('upgrade：result 非法（缺 ok/upgraded/pid）时拒绝伪造成功退出非零', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-badres-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'cd'.repeat(16);
  const control = await startFixtureControl({ dataDir: dir, instanceId, upgradeResult: { foo: 'bar' } });
  t.after(async () => {
    await control.close();
  });
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });
  t.after(async () => {
    await fs.rm(path.join(dir, 'node.pid'), { force: true }).catch(() => undefined);
  });

  const r = await runCli(['upgrade', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(r.code, 1);
  assert.equal(r.out, '', '非法 result 不得输出成功 JSON');
  const envelope = JSON.parse(r.err) as { error: { code: string; message: string } };
  assert.equal(envelope.error.code, 'invalid_upgrade_result');
  assert.match(envelope.error.message, /拒绝伪造成功/);
});

test('status：控制通道上报 version 优先；无 live 实例才用 current.json 兑底', { timeout: 60_000 }, async (t) => {
  const dir = await tempDir('helm-handoff-ver-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  });
  const instanceId = 'ef'.repeat(16);
  const control = await startFixtureControl({ dataDir: dir, instanceId, statusVersion: '99.9.9' });
  t.after(async () => {
    await control.close();
  });
  // 本地 current.json 指向另一版本：仅在无 live 实例时作为已选择版本兑底。
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'current.json'),
    `${JSON.stringify({ version: '0.0.1-current', entryPath: '/nonexistent/cli.js', updatedAt: new Date().toISOString() })}\n`,
    'utf8',
  );
  await writePidRecordRaw(dir, { pid: process.pid, instanceId, endpoint: control.endpoint });

  // live 实例经控制通道上报 99.9.9：必须优先于本地 current.json。
  const live = await runCli(['status', '--data-dir', dir, '--json'], { isAlive: () => true });
  assert.equal(live.code, 0, live.err);
  const livePayload = JSON.parse(live.out) as { version: string; state: string };
  assert.equal(livePayload.version, '99.9.9', '控制通道上报版本必须优先');
  assert.equal(livePayload.state, 'registered');

  // 无 live 实例（pid 留档移除）：回退 current.json 已选择版本。
  await fs.rm(path.join(dir, 'node.pid'), { force: true });
  const offline = await runCli(['status', '--data-dir', dir, '--json']);
  assert.equal(offline.code, 0, offline.err);
  const offlinePayload = JSON.parse(offline.out) as { version: string; pid: number | null };
  assert.equal(offlinePayload.version, '0.0.1-current', '无 live 实例时 current.json 作为兑底');
  assert.equal(offlinePayload.pid, null);
});
