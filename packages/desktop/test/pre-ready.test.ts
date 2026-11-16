/**
 * pre-ready desktop identity:Linux setDesktopName take value and invoke when machine (must early at whenReady),
 * non- Linux platform zero behavior, and electron-builder artifact
 * .desktop file base name across file lock consistent.
 */
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { applyLinuxDesktopName, LINUX_DESKTOP_NAME, type DesktopNameApp } from '../src/pre-ready.js';

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

test('Linux: settings desktopName, and main.ts invoke when machine must in whenReady before (source order lock)', { timeout: 60_000 }, () => {
  const calls: string[] = [];
  const app: DesktopNameApp = { setDesktopName: (name) => { calls.push(`setDesktopName:${name}`); } };
  assert.equal(applyLinuxDesktopName(app, 'linux'), true);
  assert.deepEqual(calls, [`setDesktopName:${LINUX_DESKTOP_NAME}`]);

  const main = readFileSync(join(srcDir, 'main.ts'), 'utf8');
  const sweep = main.indexOf('installLinuxExitChildSweep({');
  const identity = main.indexOf('applyLinuxDesktopName(app');
  const ready = main.indexOf('await app.whenReady()');
  assert.ok(sweep > 0 && identity > 0 && ready > 0, 'main.ts should also contains fall back install, identity settings and whenReady');
  assert.ok(sweep < identity && identity < ready, 'exit fall back and desktop identity all must occur in whenReady before');
});

test('win32 / darwin: do not settings desktopName, keep since has behavior', { timeout: 60_000 }, () => {
  const calls: string[] = [];
  const app: DesktopNameApp = { setDesktopName: (name) => { calls.push(name); } };
  assert.equal(applyLinuxDesktopName(app, 'win32'), false);
  assert.equal(applyLinuxDesktopName(app, 'darwin'), false);
  assert.deepEqual(calls, []);
});

test('identifier and electron-builder artifact consistent:desktopName = executableName base name, existing identifier do not motion', { timeout: 60_000 }, () => {
  const yml = readFileSync(join(srcDir, '..', 'electron-builder.yml'), 'utf8');
  assert.equal(LINUX_DESKTOP_NAME, 'helm-desktop');
  assert.match(yml, /executableName:\s*helm-desktop\b/, '.desktop file base name from executableName');
  assert.match(yml, /appId:\s*dev\.helm\.desktop\b/, 'appId existing identifier keep do not change');
});
