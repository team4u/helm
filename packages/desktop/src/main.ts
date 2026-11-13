/**
 * Electron 主进程入口：单实例锁 → Hub attach-or-spawn → BrowserWindow 加载 Hub →
 * 托盘常驻（关闭即隐藏）。
 *
 * 运行形态：
 * - GUI（electron .）：BrowserWindow + 托盘；electron 未安装时显式报错退出（指引见 README）；
 * - HELM_DESKTOP_HEADLESS=1：纯监督器模式（无窗口），CI / 无显示环境可完整验证
 *   attach-or-spawn / 崩溃重启 / 优雅停止。
 */
import { DesktopError } from './errors.js';
import { resolveDesktopConfig } from './config.js';
import { HubSupervisor, type StartResult } from './supervisor.js';
import { getElectron, type BrowserWindowLike, type ElectronApi, type TrayLike } from './electron-api.js';
import { TRAY_ICON_DATA_URL } from './tray-icon.js';

function log(line: string): void {
  process.stdout.write(`[helm-desktop] ${line}\n`);
}

function fail(error: unknown): never {
  if (error instanceof DesktopError) {
    process.stderr.write(`[helm-desktop] 错误 ${error.code}: ${error.message}\n${JSON.stringify(error.details ?? {}, null, 2)}\n`);
  } else {
    process.stderr.write(`[helm-desktop] 未分类错误: ${error instanceof Error ? error.stack : String(error)}\n`);
  }
  process.exit(1);
}

function makeSupervisor(): HubSupervisor {
  const config = resolveDesktopConfig(process.env);
  return new HubSupervisor({
    config,
    isElectron: process.versions.electron !== undefined,
    events: {
      stateChange: (next, prev) => log(`Hub 状态: ${prev} -> ${next}`),
      runnerSelected: (info) => log(`运行器: ${info.kind} ${info.command.join(' ')}${info.detail ? `（${info.detail}）` : ''}`),
      restartScheduled: (attempt, delayMs, reason) => log(`第 ${attempt} 次重启（${delayMs}ms 后）: ${reason}`),
      problem: (error) => log(`诊断: ${error instanceof Error ? error.message : String(error)}`),
    },
  });
}

// ---- headless 模式：无 GUI 验证通道 ----

async function runHeadless(): Promise<void> {
  const supervisor = makeSupervisor();
  const result: StartResult = await supervisor.start();
  log(`就绪: mode=${result.mode} hub=${result.hubUrl}${result.runner ? ` runner=${result.runner.kind}` : ''}`);
  let quitting = false;
  const stop = async () => {
    if (quitting) return;
    quitting = true;
    await supervisor.stop();
    log('已停止，退出');
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

// ---- GUI 模式 ----

async function runElectron(electron: ElectronApi): Promise<void> {
  const { app } = electron;
  if (!app.requestSingleInstanceLock()) {
    log('已有桌面壳实例运行，本实例退出');
    app.quit();
    return;
  }

  const supervisor = makeSupervisor();
  let quitting = false;
  let win: BrowserWindowLike | null = null;
  let tray: TrayLike | null = null;
  let reloadTimer: NodeJS.Timeout | null = null;
  let reloadAttempts = 0;
  const MAX_RELOAD_ATTEMPTS = 5;

  const showWindow = (): void => {
    if (win !== null && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  };

  const quitFromUi = (): void => {
    if (quitting) return;
    quitting = true;
    void supervisor
      .stop()
      .catch((error) => log(`停止 Hub 异常: ${error instanceof Error ? error.message : String(error)}`))
      .then(() => {
        tray?.destroy();
        app.quit();
      });
  };

  app.on('second-instance', () => showWindow());
  app.on('activate', () => showWindow());
  // 托盘常驻：窗口全关不退出（退出走托盘菜单 / before-quit 链）。
  app.on('window-all-closed', () => {});
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitFromUi();
  });

  await app.whenReady();

  const result = await supervisor.start();
  log(`Hub 就绪: mode=${result.mode} url=${result.hubUrl}`);

  const { BrowserWindow, Tray, Menu, nativeImage, shell } = electron;
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'Helm',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.on('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    if (quitting) return;
    // 关闭即隐藏（托盘常驻）；真正退出走托盘菜单或 before-quit。
    event.preventDefault();
    win?.hide();
  });
  win.webContents.on('did-finish-load', () => {
    reloadAttempts = 0;
  });
  win.webContents.on('did-fail-load', (_errorCode, errorDescription, validatedURL) => {
    if (quitting || reloadAttempts >= MAX_RELOAD_ATTEMPTS) {
      log(`加载失败且重试耗尽: ${validatedURL} ${errorDescription}`);
      return;
    }
    reloadAttempts += 1;
    log(`加载失败（${errorDescription}），2s 后第 ${reloadAttempts}/${MAX_RELOAD_ATTEMPTS} 次重试`);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (!quitting && win !== null && !win.isDestroyed()) void win.loadURL(result.hubUrl).catch(() => {});
    }, 2_000);
  });
  // 目标态只加载 Hub 本体；新开窗口一律转交系统浏览器。
  // 注：骨架 BrowserWindowLike 未暴露 setWindowOpenHandler，扩展时在此接入 shell.openExternal。

  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL));
  tray.setToolTip('Helm 桌面壳');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示 Helm', click: () => showWindow() },
      { type: 'separator' },
      { label: '退出', click: () => quitFromUi() },
    ]),
  );
  tray.on('click', () => showWindow());

  process.once('SIGINT', () => quitFromUi());
  process.once('SIGTERM', () => quitFromUi());
  await win.loadURL(result.hubUrl);
  // shell 供外部链接策略使用（见上注）；显式引用防 tree-shake 语义漂移。
  void shell;
}

async function main(): Promise<void> {
  if (process.env['HELM_DESKTOP_HEADLESS'] === '1') {
    await runHeadless();
    return;
  }
  const electron = getElectron();
  if (electron === null) {
    process.stderr.write(
      '[helm-desktop] 未运行在 Electron 内。GUI 启动: 安装 electron 后执行 `npx electron packages/desktop`（详见 packages/desktop/README.md）；' +
        '无显示环境验证: HELM_DESKTOP_HEADLESS=1 tsx packages/desktop/src/main.ts\n',
    );
    process.exit(1);
  }
  await runElectron(electron);
}

void main().catch(fail);
