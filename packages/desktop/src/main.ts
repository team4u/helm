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
import { TRAY_ICON_DATA_URL } from './tray-icon.js';
import { restoreShellPath } from './shell-env.js';

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
  if (bundled !== undefined && typeof bundled.name !== 'string') throw new Error('安装包缺少有效的更新包名称');
  const config = resolveDesktopConfig(process.env, resources === undefined ? {} : {
    payloadPackage: process.env.HELM_PAYLOAD_PACKAGE ?? bundled?.name as string,
    hubEntry: process.env.HELM_DESKTOP_HUB_ENTRY ?? join(resources, 'hub', 'kernel', 'dist', 'main.js'),
    cliEntry: process.env.HELM_CLI_ENTRY ?? join(resources, 'hub', 'cli', 'dist', 'index.js'),
    webDistDir: process.env.HELM_DESKTOP_WEB_DIST ?? join(resources, 'hub', 'web', 'dist'),
  });
  const npmCli = resources === undefined
    ? fileURLToPath(new URL('../node_modules/npm/bin/npm-cli.js', import.meta.url))
    : join(resources, 'hub', 'tools', 'npm', 'bin', 'npm-cli.js');
  if (npmCli !== undefined && !existsSync(npmCli)) throw new Error(`安装包缺少 npm 运行时：${npmCli}`);
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
        stateChange: (next, prev) => log(`Hub：${prev} -> ${next}`),
        runnerSelected: (info) => log(`运行器：${info.kind} ${info.nodeVersion ?? ''}`),
        restartScheduled: (attempt, ms, reason) => log(`第 ${attempt} 次重启，等待 ${ms}ms：${reason}`),
        problem: (error) => log(describe(error)),
      },
    },
  });
}

async function runHeadless(): Promise<void> {
  const boot = createBoot();
  await boot.start();
  await boot.confirmReady();
  log(`就绪：${boot.supervisor.hubUrl}`);
  let quitting = false;
  const stop = async () => {
    if (quitting) return;
    quitting = true;
    await boot.supervisor.stop();
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

const splash = 'data:text/html;charset=utf-8,' + encodeURIComponent(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Helm</title><style>html{color-scheme:dark light;font:14px system-ui}body{margin:0;min-height:100vh;display:grid;place-content:center;text-align:center}h1{font-size:24px;font-weight:600}p{opacity:.65}</style><h1>Helm</h1><p>正在启动…</p></html>`);

async function waitForReact(win: BrowserWindowLike): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const ready: unknown = await win.webContents.executeJavaScript('Boolean(document.querySelector("#root")?.children.length)');
    if (ready === true) return;
    await delay(100);
  }
  throw new Error('页面已加载，但界面在 20 秒内未完成渲染');
}

async function runElectron(electron: ElectronApi): Promise<void> {
  const { app, BrowserWindow, Tray, Menu, nativeImage, shell, dialog } = electron;
  const browserData = join(process.env.HELM_DESKTOP_DATA_DIR ?? process.env.HELM_DATA_DIR ?? join(homedir(), '.helm'), 'desktop');
  mkdirSync(browserData, { recursive: true });
  app.setPath('userData', browserData);
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  if (!smoke) {
    try { await restoreShellPath(); } catch (error) { log(`登录 shell PATH 恢复失败，继续使用当前环境：${describe(error)}`); }
  }
  if (smoke && process.env.HELM_DATA_DIR === undefined && process.env.HELM_DESKTOP_DATA_DIR === undefined) throw new Error('冒烟测试必须显式指定隔离的数据目录');
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
      if (!response.ok) throw new Error(`冒烟测试鉴权初始化失败：${response.status}，请使用新的数据目录`);
      const body: unknown = await response.json();
      if (body === null || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') throw new Error('鉴权响应缺少 token');
      smokeToken = body.token;
    }
    for (const pluginId of ['builtin:workflow', 'builtin:mermaid']) {
      const response = await fetch(`${hubUrl}/api/plugins/${encodeURIComponent(pluginId)}/client.mjs?module=index.tsx`, {
        headers: { authorization: `Bearer ${smokeToken}` }, signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`${pluginId} 客户端编译失败：${response.status} ${await response.text()}`);
      if ((await response.text()).length === 0) throw new Error(`${pluginId} 客户端编译结果为空`);
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
    } catch { log(`无法打开链接：${url}`); }
  };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== boot.supervisor.hubUrl) { event.preventDefault(); external(url); }
  });
  const checkUpdates = () => {
    if (updateTask !== null) return;
    updateTask = boot.checkForUpdate().then((status) => {
      const label = status.updateAvailable ? `更新 ${status.latest?.version} 已就绪，下次启动安装`
        : status.reason === 'updater_not_configured' ? '尚未配置更新源'
        : status.reason === 'latest_blocked' ? '最新更新不可用，已保留当前版本' : '当前已是最新版本';
      log(label); updateMenu(label);
    }).catch((error) => {
      log(`检查更新失败：${describe(error)}`);
      updateMenu('检查更新失败，点击重试');
    }).finally(() => { updateTask = null; });
  };
  const updateMenu = (label = '检查更新') => {
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: '打开 Helm', click: show },
      { label, click: checkUpdates, enabled: boot.supervisor.owned },
      { label: '下载桌面新版', click: () => external('https://github.com/team4u/helm/releases/latest') },
      { type: 'separator' },
      { label: '退出', click: () => void quit() },
    ]));
  };
  try {
    await win.loadURL(splash);
    let result = await boot.start();
    if (smoke && result.mode !== 'owned') throw new Error('冒烟测试拒绝附着外部 Hub，请释放测试端口');
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
      log(`系统托盘不可用，关闭窗口将退出：${describe(error)}`);
    }
    if (smoke) {
      if (smokeDir === undefined) throw new Error('--smoke-test 需要 --smoke-output=<目录>');
      mkdirSync(smokeDir, { recursive: true });
      const isolated: unknown = await win.webContents.executeJavaScript('typeof window.require === "undefined" && typeof window.process === "undefined"');
      if (isolated !== true) throw new Error('渲染进程隔离校验失败');
      // DOM 就绪不等于合成帧已提交；截图必须等真实绘制，尤其是 Xvfb 软件合成。
      await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
      const image = await win.webContents.capturePage();
      writeFileSync(join(smokeDir, 'window.png'), image.toPNG());
      const hubPid = boot.supervisor.childPid;
      await boot.supervisor.stop();
      let portReleased = false;
      try { await fetch(`${result.hubUrl}/api/auth/status`, { signal: AbortSignal.timeout(1000) }); }
      catch { portReleased = true; }
      if (!portReleased) throw new Error('关闭后 Hub 端口仍在监听');
      writeFileSync(join(smokeDir, 'smoke.json'), JSON.stringify({ ok: true, mode: result.mode, hubPid, rendererIsolated: true, nativeCompiler: true, portReleased, electron: process.versions.electron, node: process.versions.node }));
      log('SMOKE_TEST_OK');
      await quit();
    } else {
      log(`就绪：${result.mode} ${result.hubUrl}`);
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
    if (!smoke) dialog.showErrorBox('Helm 启动失败', message);
    await quit(1);
  }
}

async function main(): Promise<void> {
  if (process.env.HELM_DESKTOP_HEADLESS === '1') { await runHeadless(); return; }
  const electron = getElectron();
  if (electron === null) throw new Error('请使用 pnpm --filter @helm/desktop exec electron . 启动，或设置 HELM_DESKTOP_HEADLESS=1');
  await runElectron(electron);
}
void main().catch((error) => {
  process.stderr.write(`${describe(error)}\n`);
  const electron = getElectron();
  if (electron !== null) {
    if (!smoke) electron.dialog.showErrorBox('Helm 启动失败', describe(error));
    electron.app.exit(1);
  } else process.exitCode = 1;
});
