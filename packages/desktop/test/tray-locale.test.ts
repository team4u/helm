/**
 * Desktop tray / update / splash / error dialog localization tests.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.HELM_DESKTOP_NO_AUTOBOOT = '1';
const {
  DESKTOP_START_FAILED_TITLE,
  DESKTOP_TRAY_CHECK_FAILED,
  buildSplashHtml,
  buildTrayMenuTemplate,
  normalizeDesktopLocaleTag,
  resolveDesktopLocale,
  resolveDesktopText,
  resolveUpdateStatusLabel,
} = await import('../src/main.js');

test('normalizeDesktopLocaleTag: maps zh / zh-* (and POSIX zh_CN.UTF-8) to zh-CN, others to en', { timeout: 60_000 }, () => {
  assert.equal(normalizeDesktopLocaleTag('zh'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('zh-CN'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('zh-TW'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('zh-Hans'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('zh_CN.UTF-8'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('zh_HK.UTF-8@euro'), 'zh-CN');
  assert.equal(normalizeDesktopLocaleTag('en-US'), 'en');
  assert.equal(normalizeDesktopLocaleTag('en_US.UTF-8'), 'en');
  assert.equal(normalizeDesktopLocaleTag('ja-JP'), 'en');
  assert.equal(normalizeDesktopLocaleTag('C'), 'en');
  assert.equal(normalizeDesktopLocaleTag(undefined), 'en');
  assert.equal(normalizeDesktopLocaleTag(''), 'en');
});

test('resolveDesktopLocale: prefers app.getLocale(), safely falls back to LC_ALL / LANG when missing or throwing', { timeout: 60_000 }, () => {
  assert.equal(resolveDesktopLocale({ getLocale: () => 'zh-CN' }, { LANG: 'en_US.UTF-8' }), 'zh-CN');
  assert.equal(resolveDesktopLocale({ getLocale: () => 'en-GB' }, { LC_ALL: 'zh_CN.UTF-8' }), 'en');
  assert.equal(resolveDesktopLocale({ getLocale: () => '' }, { LC_ALL: 'zh_CN.UTF-8' }), 'zh-CN');
  assert.equal(resolveDesktopLocale({}, { LANG: 'zh_TW.UTF-8' }), 'zh-CN');
  assert.equal(
    resolveDesktopLocale(
      { getLocale: () => { throw new Error('not ready'); } },
      { LC_ALL: 'zh_CN.UTF-8' },
    ),
    'zh-CN',
  );
  assert.equal(resolveDesktopLocale(undefined, {}), 'en');
});

test('buildTrayMenuTemplate & update status labels: clean bilingual en and zh-CN copy', { timeout: 60_000 }, () => {
  const noop = () => {};
  const zhMenu = buildTrayMenuTemplate({
    locale: 'zh-CN',
    updateEnabled: true,
    onOpen: noop,
    onCheckUpdates: noop,
    onDownload: noop,
    onQuit: noop,
  });
  assert.deepEqual(
    zhMenu.map((item) => item.label ?? item.type),
    ['打开 Helm', '检查更新', '下载桌面端新版', 'separator', '退出'],
  );

  const enMenu = buildTrayMenuTemplate({
    locale: 'en',
    updateEnabled: false,
    onOpen: noop,
    onCheckUpdates: noop,
    onDownload: noop,
    onQuit: noop,
  });
  assert.deepEqual(
    enMenu.map((item) => item.label ?? item.type),
    ['Open Helm', 'Check for updates', 'Download latest desktop release', 'separator', 'Quit'],
  );
  assert.equal(enMenu[1]?.enabled, false);

  const availStatus = {
    updateAvailable: true,
    current: null,
    latest: { name: '@helm/payload', version: '1.2.3' },
  };
  assert.equal(
    resolveUpdateStatusLabel(availStatus, 'zh-CN'),
    '新版本 1.2.3 已就绪，下次启动安装',
  );
  assert.equal(
    resolveUpdateStatusLabel(availStatus, 'en'),
    'Update 1.2.3 ready (installs on next launch)',
  );

  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'updater_not_configured' }, 'zh-CN'),
    '尚未配置更新源',
  );
  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'updater_not_configured' }, 'en'),
    'Update source not configured',
  );

  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'latest_blocked' }, 'zh-CN'),
    '最新更新不可用，已保持当前版本',
  );
  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'latest_blocked' }, 'en'),
    'Latest update unavailable; staying on current version',
  );

  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'up_to_date' }, 'zh-CN'),
    '当前已是最新版本',
  );
  assert.equal(
    resolveUpdateStatusLabel({ updateAvailable: false, current: null, latest: null, reason: 'up_to_date' }, 'en'),
    'Up to date',
  );

  assert.equal(resolveDesktopText(DESKTOP_TRAY_CHECK_FAILED, 'zh-CN'), '检查更新失败，点击重试');
  assert.equal(resolveDesktopText(DESKTOP_TRAY_CHECK_FAILED, 'en'), 'Update check failed — click to retry');
  assert.equal(resolveDesktopText(DESKTOP_START_FAILED_TITLE, 'zh-CN'), 'Helm 启动失败');
  assert.equal(resolveDesktopText(DESKTOP_START_FAILED_TITLE, 'en'), 'Helm failed to start');

  const zhSplash = decodeURIComponent(buildSplashHtml('zh-CN'));
  assert.ok(zhSplash.includes('<html lang="zh-CN">'));
  assert.ok(zhSplash.includes('正在启动…'));
  const enSplash = decodeURIComponent(buildSplashHtml('en'));
  assert.ok(enSplash.includes('<html lang="en">'));
  assert.ok(enSplash.includes('Starting…'));
});
