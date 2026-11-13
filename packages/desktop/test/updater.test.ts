/** payload updater 骨架：如实声明未配置，安装路径显式拒绝。 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createPayloadUpdater, StubPayloadUpdater } from '../src/updater.js';
import { resolveDesktopConfig } from '../src/config.js';
import { DesktopError } from '../src/errors.js';

const BASE_ENV: NodeJS.ProcessEnv = { PATH: process.env['PATH'] };

test('check()：updateAvailable=false 且 reason=updater_not_configured', { timeout: 60_000 }, async () => {
  const updater = createPayloadUpdater(resolveDesktopConfig(BASE_ENV));
  const status = await updater.check();
  assert.equal(status.updateAvailable, false);
  assert.equal(status.reason, 'updater_not_configured');
});

test('downloadAndInstall()：显式 updater_not_implemented，不伪装成功', { timeout: 60_000 }, async () => {
  const updater = new StubPayloadUpdater();
  await assert.rejects(
    updater.downloadAndInstall({ name: 'helm-payload', version: '0.0.1', entryPath: '/p/main.js' }),
    (error: unknown) => error instanceof DesktopError && error.code === 'updater_not_implemented',
  );
});
