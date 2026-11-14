/**
 * pre-ready 桌面身份（Linux 专属，纯模块）。
 *
 * app.setDesktopName 是 Electron 45 的 Linux 专属 API，必须早于 ready 事件调用，
 * 一个调用同时决定 Wayland app_id 与 X11 WM_CLASS；取值须与 electron-builder 按
 * linux.executableName 生成的 helm-desktop.desktop 基名一致（xdg-desktop-portal
 * 1.21+ 强校验 app_id 可解析到 .desktop 文件）。完整背景见 packages/desktop/README.md。
 */
export const LINUX_DESKTOP_NAME = 'helm-desktop';

export interface DesktopNameApp {
  setDesktopName(name: string): void;
}

/** 仅 Linux 生效，返回是否已设置。 */
export function applyLinuxDesktopName(app: DesktopNameApp, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  app.setDesktopName(LINUX_DESKTOP_NAME);
  return true;
}
