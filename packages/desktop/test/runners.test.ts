/** 运行器选择与能力探测：floor 判定、真实探测、候选回退链、显式覆写。 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  compareStrictSemver,
  isStrictSemver,
  KERNEL_NODE_FLOOR,
  probeMeetsFloor,
  probeRunner,
  selectRunner,
  SemverFormatError,
  type RunnerProbe,
} from '../src/runners.js';
import { resolveDesktopConfig, resolveHubEntry } from '../src/config.js';
import { DesktopError } from '../src/errors.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };
const CHILD_WRAPPER = fileURLToPath(new URL('../dist/hub-child.js', import.meta.url));

test('probeMeetsFloor：版本与 sqlite 双条件', { timeout: 60_000 }, () => {
  const p = (node: string, sqlite: boolean): RunnerProbe => ({ node, electron: null, sqlite });
  assert.equal(probeMeetsFloor(p('24.11.0', true)), false);
  assert.equal(probeMeetsFloor(p('24.12.0', true)), true);
  assert.equal(probeMeetsFloor(p('26.1.0', true)), true);
  assert.equal(probeMeetsFloor(p('25.0.0', false)), false, '缺 node:sqlite 不达标');
});

test('probeMeetsFloor：严格 SemVer 口径（新增）——非法版本与 floor 同号预发布不达标', { timeout: 60_000 }, () => {
  const p = (node: string, sqlite: boolean): RunnerProbe => ({ node, electron: null, sqlite });
  // 预发布 < 同号正式版：nightly/beta 形态的 24.12.0 不满足 floor（原宽松比较会放行）。
  assert.equal(probeMeetsFloor(p('24.12.0-nightly.20250101', true)), false);
  assert.equal(probeMeetsFloor(p('24.12.0-beta.1', true)), false);
  // 更高号的预发布仍达标（24.13.0-pre > 24.12.0）。
  assert.equal(probeMeetsFloor(p('24.13.0-pre.1', true)), true);
  // 非严格版本号（缺段/前缀/脏字符）不再被 parseInt 宽松比较放行。
  assert.equal(probeMeetsFloor(p('24.12', true)), false);
  assert.equal(probeMeetsFloor(p('v25.0.0', true)), false);
  assert.equal(probeMeetsFloor(p('garbage', true)), false);
});

test('compareStrictSemver（desktop 本地实现，与 @helm/protocol/semver 同契约）：排序与显式拒绝（新增）', { timeout: 60_000 }, () => {
  assert.equal(compareStrictSemver('1.0.0', '1.0.0'), 0);
  assert.equal(compareStrictSemver('1.2.0', '1.10.0'), -1);
  assert.equal(compareStrictSemver('1.0.0', '1.0.0-beta.11'), 1);
  assert.equal(compareStrictSemver('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareStrictSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareStrictSemver('1.0.0+build.1', '1.0.0'), 0);
  assert.throws(() => compareStrictSemver('1.2', '1.0.0'), SemverFormatError);
  assert.throws(() => compareStrictSemver('1.0.0', 'v1.0.0'), SemverFormatError);
  assert.equal(isStrictSemver('24.12.0'), true);
  assert.equal(isStrictSemver('24.12'), false);
});

test('probeRunner 真实探测宿主 Node：版本达标且 node:sqlite 可用', { timeout: 60_000 }, async () => {
  const probe = await probeRunner(process.execPath, { env: BASE_ENV });
  assert.match(probe.node, /^\d+\.\d+\.\d+/);
  assert.equal(probe.sqlite, true);
  assert.equal(probeMeetsFloor(probe), true, `宿主 Node ${probe.node} 应满足 floor ${KERNEL_NODE_FLOOR}`);
});

test('selectRunner：custom 命令原样采用且不做能力探测', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV, { port: 3210, hubCommand: ['node', '/x/hub.js'] });
  const info = await selectRunner(config, { isElectron: false, execPath: '/unused', env: BASE_ENV });
  assert.equal(info.kind, 'custom');
  assert.deepEqual(info.command, ['node', '/x/hub.js']);
  assert.equal(info.env['HELM_PORT'], '3210');
  assert.equal(info.env['ELECTRON_RUN_AS_NODE'], undefined);
});

test('selectRunner：Electron 内嵌 Node 达标 → electron-node + ELECTRON_RUN_AS_NODE', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV, { port: 3210, hubCommand: undefined, payloadEntry: undefined });
  const okProbe: RunnerProbe = { node: '24.22.2', electron: '45.3.1', sqlite: true };
  const info = await selectRunner(config, {
    isElectron: true,
    execPath: '/fake/electron',
    env: BASE_ENV,
    probe: async (executable) => {
      assert.equal(executable, '/fake/electron');
      return okProbe;
    },
  });
  assert.equal(info.kind, 'electron-node');
  assert.deepEqual(info.command, ['/fake/electron', CHILD_WRAPPER, config.hubEntry!]);
  assert.equal(info.env['ELECTRON_RUN_AS_NODE'], '1');
  assert.equal(info.env['HELM_PORT'], '3210');
});

test('selectRunner：内嵌 Node 不达标 → 如实记录并回退宿主 node', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV);
  const skipped: string[] = [];
  const info = await selectRunner(config, {
    isElectron: true,
    execPath: '/fake/electron',
    env: BASE_ENV,
    probe: async (executable) =>
      executable === '/fake/electron'
        ? { node: '20.0.0', electron: '28.0.0', sqlite: false }
        : { node: '24.12.0', electron: null, sqlite: true },
    onSkip: (kind, reason) => skipped.push(`${kind}: ${reason}`),
  });
  assert.equal(info.kind, 'host-node');
  assert.equal(info.command[0], 'node');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0]!, /electron-node/);
});

test('selectRunner：显式 hubNode 不达标 → hub_runner_incapable 显式报错', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV, { hubNode: '/bad/node' });
  await assert.rejects(
    selectRunner(config, {
      isElectron: false,
      execPath: '/unused',
      env: BASE_ENV,
      probe: async () => ({ node: '20.0.0', electron: null, sqlite: true }),
    }),
    (error: unknown) => error instanceof DesktopError && error.code === 'hub_runner_incapable',
  );
});

test('selectRunner：非 Electron 环境 → 直接采用宿主 execPath', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV);
  const info = await selectRunner(config, {
    isElectron: false,
    execPath: '/bin/node-host',
    env: BASE_ENV,
    probe: async () => ({ node: '24.12.0', electron: null, sqlite: true }),
  });
  assert.equal(info.kind, 'host-node');
  assert.equal(info.command[0], '/bin/node-host');
  assert.equal(info.env['ELECTRON_RUN_AS_NODE'], undefined);
});

test('selectRunner：payload 入口附加参数拼接入命令行（start.mjs start 契约）', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV, {
    payloadEntry: '/payload/start.mjs',
    payloadEntryArgs: ['start'],
  });
  assert.equal(resolveHubEntry(config)?.args.length, 1);
  const info = await selectRunner(config, {
    isElectron: false,
    execPath: '/bin/node-host',
    env: BASE_ENV,
    probe: async () => ({ node: '24.12.0', electron: null, sqlite: true }),
  });
  assert.deepEqual(info.command, ['/bin/node-host', CHILD_WRAPPER, '/payload/start.mjs', 'start']);
  // hub-entry source 恒无参数。
  const plain = resolveDesktopConfig(BASE_ENV);
  const plainInfo = await selectRunner(plain, {
    isElectron: false,
    execPath: '/bin/node-host',
    env: BASE_ENV,
    probe: async () => ({ node: '24.12.0', electron: null, sqlite: true }),
  });
  assert.deepEqual(plainInfo.command, ['/bin/node-host', CHILD_WRAPPER, plain.hubEntry!]);
});
