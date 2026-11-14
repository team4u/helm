/**
 * pre-ready 桌面身份（Linux 专属；纯模块，零 Electron 运行时依赖）。
 *
 * Electron 45 起 app.setDesktopName(name) 是 Linux 专属 API：必须在 ready 事件之前
 * 调用，一个调用同时决定 Wayland app_id 与 X11 WM_CLASS，无需 --class 等命令行开关。
 * 名称须与安装项 .desktop 文件基名一致：electron-builder 默认按 linux.executableName
 * 生成 helm-desktop.desktop（AppImage 内置条目与 deb 的 /usr/share/applications 同名），
 * 故取 'helm-desktop'。xdg-desktop-portal 1.21+ / GNOME 50 起会拒绝无法解析到
 * .desktop 文件的 app_id。
 *
 * 边界：app.setAppUserModelId 是 Windows 专属 API，本应用未使用，Windows / macOS
 * 行为保持不变；本模块不写任何 .desktop 文件（安装项由 electron-builder 构建期生成）。
 */
export const LINUX_DESKTOP_NAME = 'helm-desktop';

export interface DesktopNameApp {
  setDesktopName(name: string): void;
}

/** 仅 Linux 生效；缺该 API 的旧版 Electron 安全跳过。返回是否已设置。 */
export function applyLinuxDesktopName(app: DesktopNameApp, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  if (typeof app.setDesktopName !== 'function') return false;
  app.setDesktopName(LINUX_DESKTOP_NAME);
  return true;
}
