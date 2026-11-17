import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopBoot } from './bootstrap.js';
import { DesktopError } from './errors.js';
import { resolveDesktopConfig } from './config.js';
import { createPayloadUpdater } from './updater.js';
import { HostNpmInstaller } from './npm-installer.js';
import { getElectron, type BrowserWindowLike, type ElectronApi, type TrayLike } from './electron-api.js';
import type { MenuItemConstructorOptions } from 'electron';
import type { PayloadUpdateStatus } from './updater.js';
import { TRAY_ICON_DATA_URL } from './tray-icon.js';
import { restoreShellPath } from './shell-env.js';
import { installLinuxExitChildSweep } from './linux-exit-children.js';
import { applyLinuxDesktopName } from './pre-ready.js';

const log = (message: string): void => { process.stdout.write(`[helm-desktop] ${message}\n`); };
const smoke = process.argv.includes('--smoke-test');
const smokeDirArg = process.argv.find((arg) => arg.startsWith('--smoke-output='));
const smokeDir = smokeDirArg === undefined ? undefined : resolve(smokeDirArg.slice('--smoke-output='.length));

function describe(error: unknown): string {
  return error instanceof DesktopError
    ? `${error.code}: ${error.message}\n${JSON.stringify(error.details ?? {})}`
    : error instanceof Error ? error.stack ?? error.message : String(error);
}

function createBoot(electron?: ElectronApi): DesktopBoot {
  const resources = electron?.app.isPackaged ? process.resourcesPath : undefined;
  const bundled = resources === undefined ? undefined : JSON.parse(readFileSync(join(resources, 'hub', 'package.json'), 'utf8')) as { name?: unknown; version?: unknown };
  if (bundled !== undefined && typeof bundled.name !== 'string') throw new Error('install package missing valid update package name');
  const config = resolveDesktopConfig(process.env, resources === undefined ? {} : {
    payloadPackage: process.env.HELM_PAYLOAD_PACKAGE ?? bundled?.name as string,
    // bundle form hub entry:payload manifest entries.hub = "hub/dist/main.js", in
    // <resources>/hub(extraResources) under i.e. hub/hub/dist/main.js(@helm/hub package dist;
    // topology split after no longer at kernel package).
    hubEntry: process.env.HELM_DESKTOP_HUB_ENTRY ?? join(resources, 'hub', 'hub', 'dist', 'main.js'),
    cliEntry: process.env.HELM_CLI_ENTRY ?? join(resources, 'hub', 'cli', 'dist', 'index.js'),
    webDistDir: process.env.HELM_DESKTOP_WEB_DIST ?? join(resources, 'hub', 'web', 'dist'),
  });
  const npmCli = resources === undefined
    ? fileURLToPath(new URL('../node_modules/npm/bin/npm-cli.js', import.meta.url))
    : join(resources, 'hub', 'tools', 'npm', 'bin', 'npm-cli.js');
  if (npmCli !== undefined && !existsSync(npmCli)) throw new Error(`install package missing npm runtime:${npmCli}`);
  const updater = createPayloadUpdater(config, {
    npmInstaller: new HostNpmInstaller({
      command: [process.execPath, npmCli],
      env: {
        ...process.env,
        npm_config_cache: join(config.dataDir ?? join(homedir(), '.helm'), 'npm-cache'),
        ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
      },
      extraArgs: config.payloadRegistry === undefined ? [] : ['--registry', config.payloadRegistry],
    }),
  });
  return new DesktopBoot({
    config, updater, log,
    baselineVersion: typeof bundled?.version === 'string' ? bundled.version : undefined,
    supervisorOptions: {
      childWrapper: resources === undefined ? undefined : join(resources, 'hub-child.mjs'),
      isElectron: process.versions.electron !== undefined,
      events: {
        stateChange: (next, prev) => log(`Hub:${prev} -> ${next}`),
        runnerSelected: (info) => log(`run:${info.kind} ${info.nodeVersion ?? ''}`),
        restartScheduled: (attempt, ms, reason) => log(` ${attempt} time restart, wait for ${ms}ms:${reason}`),
        problem: (error) => log(describe(error)),
      },
    },
  });
}

async function runHeadless(): Promise<void> {
  const boot = createBoot();
  await boot.start();
  await boot.confirmReady();
  log(`ready:${boot.supervisor.hubUrl}`);
  let quitting = false;
  const stop = async () => {
    if (quitting) return;
    quitting = true;
    await boot.supervisor.stop();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

export type DesktopLocale = 'en' | 'zh-CN';
export type DesktopLocalizedText = string | Readonly<Partial<Record<DesktopLocale, string>>>;

const DESKTOP_LOCALES: readonly DesktopLocale[] = ['en', 'zh-CN'];

export function normalizeDesktopLocaleTag(tag: string | null | undefined): DesktopLocale {
  if (typeof tag !== 'string') return 'en';
  // Strip POSIX encoding/modifier suffixes (e.g. zh_CN.UTF-8@euro) and normalize '_' to '-'.
  const base = tag.trim().split(/[.@]/, 1)[0] ?? '';
  const normalized = base.replaceAll('_', '-').toLowerCase();
  if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN';
  return 'en';
}

export function resolveDesktopLocale(
  app?: { getLocale?: () => string },
  env: NodeJS.ProcessEnv = process.env,
): DesktopLocale {
  let raw: string | undefined;
  try {
    const appLocale = typeof app?.getLocale === 'function' ? app.getLocale() : undefined;
    if (typeof appLocale === 'string' && appLocale.trim() !== '') raw = appLocale;
  } catch {
    // app.getLocale() may be unavailable before ready or on partial mocks; fall back to env.
  }
  if (raw === undefined) {
    raw = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  }
  return normalizeDesktopLocaleTag(raw);
}

export function resolveDesktopText(text: DesktopLocalizedText, locale: DesktopLocale): string {
  if (typeof text === 'string') return text;
  const direct = text[locale];
  if (typeof direct === 'string') return direct;
  const fallback = text['en'];
  if (typeof fallback === 'string') return fallback;
  for (const candidate of DESKTOP_LOCALES) {
    const value = text[candidate];
    if (typeof value === 'string') return value;
  }
  return '';
}

export const DESKTOP_TRAY_OPEN: DesktopLocalizedText = { en: 'Open Helm', 'zh-CN': '打开 Helm' };
export const DESKTOP_TRAY_CHECK_UPDATE: DesktopLocalizedText = { en: 'Check for updates', 'zh-CN': '检查更新' };
export const DESKTOP_TRAY_DOWNLOAD: DesktopLocalizedText = {
  en: 'Download latest desktop release',
  'zh-CN': '下载桌面端新版',
};
export const DESKTOP_TRAY_QUIT: DesktopLocalizedText = { en: 'Quit', 'zh-CN': '退出' };
export const DESKTOP_TRAY_CHECK_FAILED: DesktopLocalizedText = {
  en: 'Update check failed — click to retry',
  'zh-CN': '检查更新失败，点击重试',
};
export const DESKTOP_START_FAILED_TITLE: DesktopLocalizedText = {
  en: 'Helm failed to start',
  'zh-CN': 'Helm 启动失败',
};

export function resolveUpdateStatusLabel(status: PayloadUpdateStatus, locale: DesktopLocale): string {
  if (status.updateAvailable) {
    const version = status.latest?.version ?? '';
    return resolveDesktopText(
      {
        en: `Update ${version} ready (installs on next launch)`,
        'zh-CN': `新版本 ${version} 已就绪，下次启动安装`,
      },
      locale,
    );
  }
  if (status.reason === 'updater_not_configured') {
    return resolveDesktopText(
      { en: 'Update source not configured', 'zh-CN': '尚未配置更新源' },
      locale,
    );
  }
  if (status.reason === 'latest_blocked') {
    return resolveDesktopText(
      {
        en: 'Latest update unavailable; staying on current version',
        'zh-CN': '最新更新不可用，已保持当前版本',
      },
      locale,
    );
  }
  return resolveDesktopText({ en: 'Up to date', 'zh-CN': '当前已是最新版本' }, locale);
}

export function buildTrayMenuTemplate(options: {
  locale: DesktopLocale;
  updateLabel?: string;
  updateEnabled: boolean;
  onOpen: () => void;
  onCheckUpdates: () => void;
  onDownload: () => void;
  onQuit: () => void;
}): MenuItemConstructorOptions[] {
  const { locale, updateLabel, updateEnabled, onOpen, onCheckUpdates, onDownload, onQuit } = options;
  return [
    { label: resolveDesktopText(DESKTOP_TRAY_OPEN, locale), click: onOpen },
    {
      label: updateLabel ?? resolveDesktopText(DESKTOP_TRAY_CHECK_UPDATE, locale),
      click: onCheckUpdates,
      enabled: updateEnabled,
    },
    { label: resolveDesktopText(DESKTOP_TRAY_DOWNLOAD, locale), click: onDownload },
    { type: 'separator' },
    { label: resolveDesktopText(DESKTOP_TRAY_QUIT, locale), click: onQuit },
  ];
}

export function buildSplashHtml(locale: DesktopLocale): string {
  const starting = resolveDesktopText({ en: 'Starting…', 'zh-CN': '正在启动…' }, locale);
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="${locale}"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Helm</title><style>html{color-scheme:dark light;font:14px system-ui}body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center}h1{font-size:24px;font-weight:600}p{opacity:.65}</style><h1>Helm</h1><p>${starting}</p></html>`);
}

async function waitForReact(win: BrowserWindowLike): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready: unknown = await win.webContents.executeJavaScript('Boolean(document.querySelector("#root")?.children.length)');
    if (ready === true) return;
    await delay(100);
  }
  throw new Error('page already load, but UI in 20 second inside not complete render');
}

async function runElectron(electron: ElectronApi): Promise<void> {
  const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = electron;
  // Linux AppImage exit fall back must first at any may exit path then (the rest platform / form zero overhead).
  installLinuxExitChildSweep({ isPackaged: app.isPackaged });
  const browserData = join(process.env.HELM_DESKTOP_DATA_DIR ?? process.env.HELM_DATA_DIR ?? join(homedir(), '.helm'), 'desktop');
  mkdirSync(browserData, { recursive: true });
  app.setPath('userData', browserData);
  // Linux desktop identity (Wayland app_id / X11 WM_CLASS) must in ready before settings, see pre-ready.ts.
  applyLinuxDesktopName(app, process.platform);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  const locale = resolveDesktopLocale(app);
  if (!smoke) {
    try { await restoreShellPath(); } catch (error) { log(`login shell PATH restore failed, continue use when before environment:${describe(error)}`); }
  }
  if (smoke && process.env.HELM_DATA_DIR === undefined && process.env.HELM_DESKTOP_DATA_DIR === undefined) throw new Error('smoke test must explicit designate isolated data directory');
  const boot = createBoot(electron);
  let smokeToken: string | undefined;
  const verifyNativeCompiler = async (hubUrl: string) => {
    if (!smoke) return;
    if (smokeToken === undefined) {
      const response = await fetch(`${hubUrl}/api/auth/setup`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: randomBytes(24).toString('hex') }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error(`smoke test authentication failed to initialize:${response.status}, use new data directory`);
      const body: unknown = await response.json();
      if (body === null || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') throw new Error('authentication response missing token');
      smokeToken = body.token;
    }
    for (const pluginId of ['builtin:workflow', 'builtin:mermaid']) {
      const response = await fetch(`${hubUrl}/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=index.tsx`, {
        headers: { authorization: `Bearer ${smokeToken}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`${pluginId} client failed to compile:${response.status} ${await response.text()}`);
      if ((await response.text()).length === 0) throw new Error(`${pluginId} client compile result is empty`);
    }
  };
  let quitting = false;
  let tray: TrayLike | null = null;
  let updateTask: Promise<unknown> | null = null;
  let updateTimer: NodeJS.Timeout | undefined;
  const win = new BrowserWindow({
    width: 1280, height: 800, minWidth: 640, minHeight: 480, title: 'Helm', show: true,
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const show = () => { if (!win.isDestroyed()) { win.show(); win.focus(); } };
  const quit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    clearInterval(updateTimer);
    try { await boot.supervisor.stop(); } catch (error) { log(describe(error)); code = 1; }
    tray?.destroy();
    app.exit(code);
  };
  app.on('second-instance', show);
  app.on('activate', show);
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => { event.preventDefault(); void quit(); });
  process.once('SIGINT', () => void quit());
  process.once('SIGTERM', () => void quit());
  win.on('close', (event) => {
    if (quitting) return;
    if (tray === null) { event.preventDefault(); void quit(); return; }
    event.preventDefault(); win.hide();
  });
  const external = (url: string) => {
    try {
      if (['https:', 'http:', 'mailto:'].includes(new URL(url).protocol)) void shell.openExternal(url).catch((error) => log(describe(error)));
    } catch { log(`cannot open link:${url}`); }
  };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== boot.supervisor.hubUrl) { event.preventDefault(); external(url); }
  });
  const checkUpdates = () => {
    if (updateTask !== null) return;
    updateTask = boot.checkForUpdate().then((status) => {
      const label = resolveUpdateStatusLabel(status, locale);
      log(label); updateMenu(label);
    }).catch((error) => {
      log(`check update failed:${describe(error)}`);
      updateMenu(resolveDesktopText(DESKTOP_TRAY_CHECK_FAILED, locale));
    }).finally(() => { updateTask = null; });
  };
  const updateMenu = (label = resolveDesktopText(DESKTOP_TRAY_CHECK_UPDATE, locale)) => {
    tray?.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate({
      locale,
      updateLabel: label,
      updateEnabled: boot.supervisor.owned,
      onOpen: show,
      onCheckUpdates: checkUpdates,
      onDownload: () => external('https://github.com/team4u/helm/releases/latest'),
      onQuit: () => void quit(),
    })));
  };
  try {
    await win.loadURL(buildSplashHtml(locale));
    let result = await boot.start();
    if (smoke && result.mode !== 'owned') throw new Error('smoke test reject attach external Hub, please release test port');
    try {
      await win.loadURL(result.hubUrl);
      await waitForReact(win);
      await verifyNativeCompiler(result.hubUrl);
      await boot.confirmReady();
    } catch (error) {
      result = await boot.restore(error instanceof Error ? error : new Error(String(error)));
      await win.loadURL(result.hubUrl);
      await waitForReact(win);
      await verifyNativeCompiler(result.hubUrl);
      await boot.confirmReady();
    }
    try {
      tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
      tray.setToolTip('Helm'); tray.on('click', show); updateMenu();
    } catch (error) {
      log(`system tray unavailable, close window exit:${describe(error)}`);
    }
    if (smoke) {
      if (smokeDir === undefined) throw new Error('--smoke-test need to --smoke-output=<directory>');
      mkdirSync(smokeDir, { recursive: true });
      const isolated: unknown = await win.webContents.executeJavaScript('typeof window.require === "undefined" && typeof window.process === "undefined"');
      if (isolated !== true) throw new Error('render process isolated validation failed');
      // DOM ready is not equal to together into frame committed; truncate diagram must etc. real draw, especially is Xvfb software together into.
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      const image = await win.webContents.capturePage();
      writeFileSync(join(smokeDir, 'window.png'), image.toPNG());
      const hubPid = boot.supervisor.childPid;
      await boot.supervisor.stop();
      let portReleased = false;
      try { await fetch(`${result.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(1000) }); }
      catch { portReleased = true; }
      if (!portReleased) throw new Error('close after Hub port still in listen');
      writeFileSync(join(smokeDir, 'smoke.json'), JSON.stringify({ ok: true, mode: result.mode, hubPid, rendererIsolated: true, nativeCompiler: true, portReleased, electron: process.versions.electron, node: process.versions.node }));
      log('SMOKE_TEST_OK');
      await quit();
    } else {
      log(`ready:${result.mode} ${result.hubUrl}`);
      if (result.mode === 'owned') {
        checkUpdates();
        updateTimer = setInterval(checkUpdates, 6 * 60 * 60 * 1000);
        updateTimer.unref();
      }
    }
  } catch (error) {
    const message = describe(error);
    process.stderr.write(`${message}\n`);
    if (smokeDir !== undefined) {
      mkdirSync(smokeDir, { recursive: true });
      writeFileSync(join(smokeDir, 'smoke.json'), JSON.stringify({ ok: false, error: message }));
    }
    if (!smoke) dialog.showErrorBox(resolveDesktopText(DESKTOP_START_FAILED_TITLE, locale), message);
    await quit(1);
  }
}

async function main(): Promise<void> {
  if (process.env.HELM_DESKTOP_HEADLESS === '1') { await runHeadless(); return; }
  const electron = getElectron();
  if (electron === null) throw new Error('use pnpm --filter @helm/desktop exec electron . start, or settings HELM_DESKTOP_HEADLESS=1');
  await runElectron(electron);
}
if (process.env.HELM_DESKTOP_NO_AUTOBOOT !== '1') {
  void main().catch((error) => {
    process.stderr.write(`${describe(error)}\n`);
    const electron = getElectron();
    if (electron !== null) {
      if (!smoke) {
        const locale = resolveDesktopLocale(electron.app);
        electron.dialog.showErrorBox(resolveDesktopText(DESKTOP_START_FAILED_TITLE, locale), describe(error));
      }
      electron.app.exit(1);
    } else process.exitCode = 1;
  });
}
