/** config parse: default value,env override, explicit override, port iron rule, child process environment build. */
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

test('default config: port 3202,hubUrl,kernel dist entry', { timeout: 60_000 }, () => {
  const config = resolveDesktopConfig(BASE_ENV);
  assert.equal(config.port, 3202);
  assert.equal(config.hostname, '127.0.0.1');
  assert.equal(config.hubUrl, 'http://127.0.0.1:3202');
  assert.equal(config.hubEntry, defaultHubEntryPath());
  assert.ok(config.hubEntry.endsWith(join('packages', 'hub', 'dist', 'main.js')));
  assert.equal(config.restartMaxRetries, 3);
  assert.equal(config.stopGraceMs, 5_000);
});

test('env override: port / dataDir / webDist / payload / hubCommand / hubNode', { timeout: 60_000 }, () => {
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

test('explicit overrides takes precedence at env', { timeout: 60_000 }, () => {
  const config = resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: '3210' }, { port: 3299 });
  assert.equal(config.port, 3299);
});

test('illegal port explicit reject: non- integer / out of bounds / port iron rule keep port; empty string treated as not config', { timeout: 60_000 }, () => {
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
  assert.equal(resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PORT: '' }).port, 3202, 'empty string=not config');
});

test('resolveHubEntry priority:hubCommand > payload > hubEntry;payload source carry args', { timeout: 60_000 }, () => {
  const withCommand = resolveDesktopConfig(BASE_ENV, { hubCommand: ['node', 'x.js'] });
  assert.equal(resolveHubEntry(withCommand), null);
  const withPayload = resolveDesktopConfig(BASE_ENV, { payloadEntry: '/p/main.js' });
  assert.deepEqual(resolveHubEntry(withPayload), { entry: '/p/main.js', source: 'payload', args: [] });
  const withPayloadArgs = resolveDesktopConfig(BASE_ENV, { payloadEntry: '/p/start.mjs', payloadEntryArgs: ['start'] });
  assert.deepEqual(resolveHubEntry(withPayloadArgs), { entry: '/p/start.mjs', source: 'payload', args: ['start'] });
  const plain = resolveDesktopConfig(BASE_ENV);
  assert.deepEqual(resolveHubEntry(plain), { entry: defaultHubEntryPath(), source: 'hub-entry', args: [] });
});

test('payload update config:HELM_PAYLOAD_PACKAGE / REGISTRY / VERSION and ENTRY_ARGS parse', { timeout: 60_000 }, () => {
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

test('payload config illegal value explicit reject: whitespace package name / illegal registry / illegal version / args without entry', { timeout: 60_000 }, () => {
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
  // whitespace parameter string = not config (do not errors).
  assert.equal(resolveDesktopConfig({ ...BASE_ENV, HELM_DESKTOP_PAYLOAD_ENTRY_ARGS: '' }).payloadEntryArgs, undefined);
});

test('buildHubChildEnv: inject kernel convention variable and strip HELM_DESKTOP_* and HELM_PAYLOAD_*', { timeout: 60_000 }, () => {
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
  assert.equal(env['HELM_PAYLOAD_PACKAGE'], undefined, 'HELM_PAYLOAD_* belong desktop shell semantics, must not leak leak to Hub child process');
  assert.equal(env['HELM_TOKEN'], 't');
});

test('buildHubChildEnv: not config dataDir/webDist when do not inject for should key', { timeout: 60_000 }, () => {
  const env = buildHubChildEnv(resolveDesktopConfig(BASE_ENV), BASE_ENV);
  assert.equal(env['HELM_DATA_DIR'], undefined);
  assert.equal(env['HELM_WEB_DIST_DIR'], undefined);
});

test('desktop end follow guard HELM_DATA_DIR override and to child process bind set same edition CLI', { timeout: 60_000 }, () => {
  const config = resolveDesktopConfig({ HELM_DATA_DIR: '/data/isolated' }, { cliEntry: '/payload/cli/dist/index.js' });
  assert.equal(config.dataDir, '/data/isolated');
  const child = buildHubChildEnv(config, { HELM_CWD: '/projects/demo' });
  assert.equal(child.HELM_DATA_DIR, '/data/isolated');
  assert.equal(child.HELM_CLI_ENTRY, '/payload/cli/dist/index.js');
  assert.equal(child.HELM_CWD, '/projects/demo');
});
