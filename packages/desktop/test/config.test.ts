/** 配置解析：缺省值、env 覆盖、显式覆盖、端口铁律、子进程环境构建。 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { join } from 'node:path';
import {
  buildHubChildEnv,
  defaultHubEntryPath,
  resolveDesktopConfig,
  resolveHubEntry,
  FORBIDDEN_PORTS,
} from '../src/config.js';
import { DesktopError } from '../src/errors.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };

test('缺省配置：端口 3202、hubUrl、kernel dist 入口', () => {
  const config = resolveDesktopConfig(BASE_ENV);
  assert.equal(config.port, 3202);
  assert.equal(config.hostname, '127.0.0.1');
  assert.equal(config.hubUrl, 'http://127.0.0.1:3202');
  assert.equal(config.hubEntry, defaultHubEntryPath());
  assert.ok(config.hubEntry.endsWith(join('packages', 'kernel', 'dist', 'main.js')));
  assert.equal(config.restartMaxRetries, 3);
  assert.equal(config.stopGraceMs, 5_000);
});

test('env 覆盖：端口 / dataDir / webDist / payload / hubCommand / hubNode', () => {
  const config = resolveDesktopConfig({
    ...BASE_ENV,
    HELM_DESKTOP_PORT: '3210',
    HELM_DESKTOP_DATA_DIR: '/tmp/helm-d',
    HELM_DESKTOP_WEB_DIST: '/tmp/web-dist',
    HELM_DESKTOP_PAYLOAD_ENTRY: '/tmp/payload/main.js',
    HELM_DESKTOP_HUB_CMD: 'node /custom/hub.js --flag',
    HELM_DESKTOP_HUB_NODE: '/usr/local/bin/node',
  });
  assert.equal(config.port, 3210);
  assert.equal(config.hubUrl, 'http://127.0.0.1:3210');
  assert.equal(config.dataDir, '/tmp/helm-d');
  assert.equal(config.webDistDir, '/tmp/web-dist');
  assert.equal(config.payloadEntry, '/tmp/payload/main.js');
  assert.deepEqual(config.hubCommand, ['node', '/custom/hub.js', '--flag']);
  assert.equal(config.hubNode, '/usr/local/bin/node');
});

test('显式 overrides 优先于 env', () => {
  const config = resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: '3210' }, { port: 3299 });
  assert.equal(config.port, 3299);
});

test('非法端口显式拒绝：非整数 / 越界 / 端口铁律保留端口；空串视为未配置', () => {
  for (const bad of ['abc', '0', '70000']) {
    assert.throws(() => resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: bad }), (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.code, 'config_invalid');
      return true;
    });
  }
  for (const forbidden of FORBIDDEN_PORTS) {
    assert.throws(
      () => resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: String(forbidden) }),
      (error: unknown) => error instanceof DesktopError && error.code === 'config_invalid',
    );
  }
  assert.equal(resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: '' }).port, 3202, '空串=未配置');
});

test('resolveHubEntry 优先级：hubCommand > payload > hubEntry；payload source 携带 args', () => {
  const withCommand = resolveDesktopConfig(BASE_ENV, { hubCommand: ['node', 'x.js'] });
  assert.equal(resolveHubEntry(withCommand), null);
  const withPayload = resolveDesktopConfig(BASE_ENV, { payloadEntry: '/p/main.js' });
  assert.deepEqual(resolveHubEntry(withPayload), { entry: '/p/main.js', source: 'payload', args: [] });
  const withPayloadArgs = resolveDesktopConfig(BASE_ENV, { payloadEntry: '/p/start.mjs', payloadEntryArgs: ['start'] });
  assert.deepEqual(resolveHubEntry(withPayloadArgs), { entry: '/p/start.mjs', source: 'payload', args: ['start'] });
  const plain = resolveDesktopConfig(BASE_ENV);
  assert.deepEqual(resolveHubEntry(plain), { entry: defaultHubEntryPath(), source: 'hub-entry', args: [] });
});

test('payload 更新器配置：HELM_PAYLOAD_PACKAGE / REGISTRY / VERSION 与 ENTRY_ARGS 解析', () => {
  const config = resolveDesktopConfig({
    ...BASE_ENV,
    HELM_PAYLOAD_PACKAGE: ' my-payload ',
    HELM_PAYLOAD_REGISTRY: 'https://registry.example.com/',
    HELM_PAYLOAD_VERSION: '1.2.3',
    HELM_DESKTOP_PAYLOAD_ENTRY: '/p/start.mjs',
    HELM_DESKTOP_PAYLOAD_ENTRY_ARGS: 'start --verbose',
  });
  assert.equal(config.payloadPackage, ' my-payload '.trim());
  assert.equal(config.payloadRegistry, 'https://registry.example.com/');
  assert.equal(config.payloadVersion, '1.2.3');
  assert.deepEqual(config.payloadEntryArgs, ['start', '--verbose']);
  assert.equal(resolveDesktopConfig({ ...BASE_ENV, HELM_PAYLOAD_VERSION: 'latest' }).payloadVersion, 'latest');
});

test('payload 配置非法值显式拒绝：空白包名 / 非法 registry / 非法版本 / args 无入口', () => {
  const expectInvalid = (env: NodeJS.ProcessEnv): void => {
    assert.throws(() => resolveDesktopConfig(env), (error: unknown) => {
      assert.ok(error instanceof DesktopError);
      assert.equal(error.code, 'config_invalid');
      return true;
    });
  };
  expectInvalid({ ...BASE_ENV, HELM_PAYLOAD_PACKAGE: '   ' });
  expectInvalid({ ...BASE_ENV, HELM_PAYLOAD_REGISTRY: 'ftp://bad' });
  expectInvalid({ ...BASE_ENV, HELM_PAYLOAD_REGISTRY: 'not-a-url' });
  expectInvalid({ ...BASE_ENV, HELM_PAYLOAD_VERSION: '../evil' });
  expectInvalid({ ...BASE_ENV, HELM_DESKTOP_PAYLOAD_ENTRY_ARGS: 'start' });
  // 空白参数串 = 未配置（不报错）。
  assert.equal(resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PAYLOAD_ENTRY_ARGS: '' }).payloadEntryArgs, undefined);
});

test('buildHubChildEnv：注入 kernel 约定变量并剥离 HELM_DESKTOP_* 与 HELM_PAYLOAD_*', () => {
  const config = resolveDesktopConfig(BASE_ENV, {
    port: 3210,
    dataDir: '/tmp/helm-d',
    webDistDir: '/tmp/web-dist',
  });
  const env = buildHubChildEnv(config, {
    PATH: '/bin',
    HELM_DESKTOP_PORT: '9999',
    HELM_DESKTOP_SECRET: 'x',
    HELM_PAYLOAD_PACKAGE: 'my-payload',
    HELM_TOKEN: 't',
  });
  assert.equal(env['HELM_PORT'], '3210');
  assert.equal(env['HELM_HOST'], '127.0.0.1');
  assert.equal(env['HELM_DATA_DIR'], '/tmp/helm-d');
  assert.equal(env['HELM_WEB_DIST_DIR'], '/tmp/web-dist');
  assert.equal(env['HELM_DESKTOP_PORT'], undefined);
  assert.equal(env['HELM_DESKTOP_SECRET'], undefined);
  assert.equal(env['HELM_PAYLOAD_PACKAGE'], undefined, 'HELM_PAYLOAD_* 属桌面壳语义，不得泄漏到 Hub 子进程');
  assert.equal(env['HELM_TOKEN'], 't');
});

test('buildHubChildEnv：未配置 dataDir/webDist 时不注入对应键', { timeout: 60_000 }, () => {
  const env = buildHubChildEnv(resolveDesktopConfig(BASE_ENV), BASE_ENV);
  assert.equal(env['HELM_DATA_DIR'], undefined);
  assert.equal(env['HELM_WEB_DIST_DIR'], undefined);
});

test('桌面端遵守 HELM_DATA_DIR 覆盖并给子进程绑定同版 CLI', { timeout: 60_000 }, () => {
  const config = resolveDesktopConfig({ HELM_DATA_DIR: '/data/isolated' }, { cliEntry: '/payload/cli/dist/index.js' });
  assert.equal(config.dataDir, '/data/isolated');
  const child = buildHubChildEnv(config, { HELM_CWD: '/projects/demo' });
  assert.equal(child.HELM_DATA_DIR, '/data/isolated');
  assert.equal(child.HELM_CLI_ENTRY, '/payload/cli/dist/index.js');
  assert.equal(child.HELM_CWD, '/projects/demo');
});
