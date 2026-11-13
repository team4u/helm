/**
 * Electron API 安全访问层：结构化最小类型 + 运行时惰性 require。
 *
 * Why 不直接 `import 'electron'`：
 * - 结构化类型只声明用到的 API 面，typecheck 不依赖 electron 包类型（仓库
 *   CI 零 GUI 依赖可跑）；electron 已列为 devDependency，仅打包/本地 GUI 用；
 * - 运行时经 createRequire 取模块（Electron 主进程内建解析），无占位伪造。
 */
import { createRequire } from 'node:module';

export interface ElectronEvent {
  preventDefault(): void;
}

export interface ElectronApp {
  /** 安装包形态（electron-builder 产物）判定，用于 Hub payload 默认路径。 */
  readonly isPackaged: boolean;
  requestSingleInstanceLock(): boolean;
  whenReady(): Promise<void>;
  quit(): void;
  exit(code?: number): void;
  on(event: 'second-instance', listener: (argv: string[], workingDirectory: string) => void): void;
  on(event: 'window-all-closed', listener: () => void): void;
  on(event: 'before-quit', listener: (event: ElectronEvent) => void): void;
  on(event: 'activate', listener: () => void): void;
}

export interface WebContentsLike {
  on(event: 'did-fail-load', listener: (errorCode: number, errorDescription: string, validatedURL: string) => void): void;
  on(event: 'did-finish-load', listener: () => void): void;
}

export interface BrowserWindowLike {
  readonly webContents: WebContentsLike;
  loadURL(url: string): Promise<void>;
  on(event: 'ready-to-show', listener: () => void): void;
  on(event: 'close', listener: (event: ElectronEvent) => void): void;
  show(): void;
  focus(): void;
  hide(): void;
  isVisible(): boolean;
  isDestroyed(): boolean;
}

export interface BrowserWindowCtor {
  new (options: {
    width: number;
    height: number;
    minWidth?: number;
    minHeight?: number;
    show?: boolean;
    title?: string;
    autoHideMenuBar?: boolean;
    webPreferences?: { contextIsolation?: boolean; nodeIntegration?: boolean; sandbox?: boolean };
  }): BrowserWindowLike;
  getAllWindows(): BrowserWindowLike[];
}

export interface NativeImageLike {
  /* 标记类型：Tray 构造入参。 */
  readonly __nativeImage: unique symbol;
}

export interface TrayLike {
  setToolTip(toolTip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: 'click', listener: () => void): void;
  destroy(): void;
}

export interface TrayCtor {
  new (image: NativeImageLike): TrayLike;
}

export interface MenuApi {
  buildFromTemplate(template: Array<unknown>): unknown;
}

export interface NativeImageApi {
  createFromDataURL(dataUrl: string): NativeImageLike;
}

export interface ShellApi {
  openExternal(url: string): Promise<void>;
}

export interface ElectronApi {
  app: ElectronApp;
  BrowserWindow: BrowserWindowCtor;
  Tray: TrayCtor;
  Menu: MenuApi;
  nativeImage: NativeImageApi;
  shell: ShellApi;
}

/** 非 Electron 环境返回 null（调用方决定 headless 降级或显式报错）。 */
export function getElectron(): ElectronApi | null {
  if (process.versions.electron === undefined) return null;
  try {
    const require = createRequire(import.meta.url);
    return require('electron') as ElectronApi;
  } catch {
    return null;
  }
}
