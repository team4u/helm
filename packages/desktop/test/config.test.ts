/** 配置解析：缺省值、env 覆盖、显式覆盖、端口铁律、子进程环境构建。 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
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
  assert.ok(config.hubEntry.endsWith('packages/kernel/dist/main.js'));
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

test('resolveHubEntry 优先级：hubCommand > payload > hubEntry', () => {
  const withCommand = resolveDesktopConfig(BASE_ENV, { hubCommand: ['node', 'x.js'] });
  assert.equal(resolveHubEntry(withCommand), null);
  const withPayload = resolveDesktopConfig(BASE_ENV, { payloadEntry: '/p/main.js' });
  assert.deepEqual(resolveHubEntry(withPayload), { entry: '/p/main.js', source: 'payload' });
  const plain = resolveDesktopConfig(BASE_ENV);
  assert.equal(resolveHubEntry(plain)?.source, 'hub-entry');
});

test('buildHubChildEnv：注入 kernel 约定变量并剥离 HELM_DESKTOP_*', () => {
  const config = resolveDesktopConfig(BASE_ENV, {
    port: 3210,
    dataDir: '/tmp/helm-d',
    webDistDir: '/tmp/web-dist',
  });
  const env = buildHubChildEnv(config, {
    PATH: '/bin',
    HELM_DESKTOP_PORT: '9999',
    HELM_DESKTOP_SECRET: 'x',
    HELM_TOKEN: 't',
  });
  assert.equal(env['HELM_PORT'], '3210');
  assert.equal(env['HELM_HOST'], '127.0.0.1');
  assert.equal(env['HELM_DATA_DIR'], '/tmp/helm-d');
  assert.equal(env['HELM_WEB_DIST_DIR'], '/tmp/web-dist');
  assert.equal(env['HELM_DESKTOP_PORT'], undefined);
  assert.equal(env['HELM_DESKTOP_SECRET'], undefined);
  assert.equal(env['HELM_TOKEN'], 't');
});

test('buildHubChildEnv：未配置 dataDir/webDist 时不注入对应键', () => {
  const env = buildHubChildEnv(resolveDesktopConfig(BASE_ENV), BASE_ENV);
  assert.equal(env['HELM_DATA_DIR'], undefined);
  assert.equal(env['HELM_WEB_DIST_DIR'], undefined);
});
