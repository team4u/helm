/** run choose and capability probe:floor decide, real probe, choose fall back chain, explicit override. */
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

test('probeMeetsFloor: version and sqlite double condition', { timeout: 60_000 }, () => {
  const p = (node: string, sqlite: boolean): RunnerProbe => ({ node, electron: null, sqlite });
  assert.equal(probeMeetsFloor(p('24.11.0', true)), false);
  assert.equal(probeMeetsFloor(p('24.12.0', true)), true);
  assert.equal(probeMeetsFloor(p('26.1.0', true)), true);
  assert.equal(probeMeetsFloor(p('25.0.0', false)), false, 'missing node:sqlite do not reach mark');
});

test('probeMeetsFloor: strictly SemVer opening path (new increase) - - illegal version and floor same number pre- publish do not reach mark', { timeout: 60_000 }, () => {
  const p = (node: string, sqlite: boolean): RunnerProbe => ({ node, electron: null, sqlite });
  // pre- publish < same number formal edition:nightly/beta form 24.12.0 do not satisfy floor(original loosely compare will let through).
  assert.equal(probeMeetsFloor(p('24.12.0-nightly.20250101', true)), false);
  assert.equal(probeMeetsFloor(p('24.12.0-beta.1', true)), false);
  // more high number pre- publish still reach mark (24.13.0-pre > 24.12.0).
  assert.equal(probeMeetsFloor(p('24.13.0-pre.1', true)), true);
  // non- strictly version number (missing segment/prefix/dirty character) no longer by parseInt loosely compare let through.
  assert.equal(probeMeetsFloor(p('24.12', true)), false);
  assert.equal(probeMeetsFloor(p('v25.0.0', true)), false);
  assert.equal(probeMeetsFloor(p('garbage', true)), false);
});

test('compareStrictSemver(desktop local implement, and @helm/protocol/semver same contract): sort and explicit reject (new increase)', { timeout: 60_000 }, () => {
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

test('probeRunner real probe host Node: version reach mark and node:sqlite available', { timeout: 60_000 }, async () => {
  const probe = await probeRunner(process.execPath, { env: BASE_ENV });
  assert.match(probe.node, /^\d+\.\d+\.\d+/);
  assert.equal(probe.sqlite, true);
  assert.equal(probeMeetsFloor(probe), true, `host Node ${probe.node} should satisfy floor ${KERNEL_NODE_FLOOR}`);
});

test('selectRunner:custom command original adopt and does not capability probe', { timeout: 60_000 }, async () => {
  const config = resolveDesktopConfig(BASE_ENV, { port: 3210, hubCommand: ['node', '/x/hub.js'] });
  const info = await selectRunner(config, { isElectron: false, execPath: '/unused', env: BASE_ENV });
  assert.equal(info.kind, 'custom');
  assert.deepEqual(info.command, ['node', '/x/hub.js']);
  assert.equal(info.env['HELM_PORT'], '3210');
  assert.equal(info.env['ELECTRON_RUN_AS_NODE'], undefined);
});

test('selectRunner:Electron inside embed Node reach mark → electron-node + ELECTRON_RUN_AS_NODE', { timeout: 60_000 }, async () => {
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

test('selectRunner: inside embed Node do not reach mark → such as record and fall back host node', { timeout: 60_000 }, async () => {
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

test('selectRunner: explicit hubNode do not reach mark → hub_runner_incapable explicit errors', { timeout: 60_000 }, async () => {
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

test('selectRunner: non- Electron environment → directly adopt host execPath', { timeout: 60_000 }, async () => {
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

test('selectRunner:payload entry additional parameter concatenate command line (start.mjs start contract)', { timeout: 60_000 }, async () => {
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
  // hub-entry source constant without parameter.
  const plain = resolveDesktopConfig(BASE_ENV);
  const plainInfo = await selectRunner(plain, {
    isElectron: false,
    execPath: '/bin/node-host',
    env: BASE_ENV,
    probe: async () => ({ node: '24.12.0', electron: null, sqlite: true }),
  });
  assert.deepEqual(plainInfo.command, ['/bin/node-host', CHILD_WRAPPER, plain.hubEntry!]);
});
