/**
 * pre-ready 桌面身份：Linux setDesktopName 的取值与调用时机（必须早于 whenReady）、
 * 非 Linux 平台零行为、与 electron-builder 产物的
 * .desktop 文件基名跨文件锁定一致。
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyLinuxDesktopName, LINUX_DESKTOP_NAME, type DesktopNameApp } from '../src/pre-ready.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('Linux：设置 desktopName，且 main.ts 调用时机须在 whenReady 之前（源序锁定）', { timeout: 60_000 }, () => {
  const calls: string[] = [];
  const app: DesktopNameApp = { setDesktopName: (name) => { calls.push(`setDesktopName:${name}`); } };
  assert.equal(applyLinuxDesktopName(app, 'linux'), true);
  assert.deepEqual(calls, [`setDesktopName:${LINUX_DESKTOP_NAME}`]);

  const main = readFileSync(join(srcDir, 'main.ts'), 'utf8');
  const sweep = main.indexOf('installLinuxExitChildSweep({');
  const identity = main.indexOf('applyLinuxDesktopName(app');
  const ready = main.indexOf('await app.whenReady()');
  assert.ok(sweep > 0 && identity > 0 && ready > 0, 'main.ts 应同时包含兜底安装、身份设置与 whenReady');
  assert.ok(sweep < identity && identity < ready, '退出兜底与桌面身份都必须发生在 whenReady 之前');
});

test('win32 / darwin：不设置 desktopName，保持既有行为', { timeout: 60_000 }, () => {
  const calls: string[] = [];
  const app: DesktopNameApp = { setDesktopName: (name) => { calls.push(name); } };
  assert.equal(applyLinuxDesktopName(app, 'win32'), false);
  assert.equal(applyLinuxDesktopName(app, 'darwin'), false);
  assert.deepEqual(calls, []);
});

test('标识与 electron-builder 产物一致：desktopName = executableName 基名，现有标识不动', { timeout: 60_000 }, () => {
  const yml = readFileSync(join(srcDir, '..', 'electron-builder.yml'), 'utf8');
  assert.equal(LINUX_DESKTOP_NAME, 'helm-desktop');
  assert.match(yml, /executableName:\s*helm-desktop\b/, '.desktop 文件基名来自 executableName');
  assert.match(yml, /appId:\s*dev\.helm\.desktop\b/, 'appId 现有标识保持不变');
});
