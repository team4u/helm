/**
 * pre-ready desktop identity (Linux dedicated belong, pure module).
 *
 * app.setDesktopName is Electron 45  Linux dedicated belong API, must early at ready event invoke,
 * a invoke also decide Wayland app_id and X11 WM_CLASS; take value must and electron-builder by
 * linux.executableName generate helm-desktop.desktop base name consistent (xdg-desktop-portal
 * 1.21+ strong validate app_id can parse to .desktop file). complete background see packages/desktop/README.md.
 */
export const LINUX_DESKTOP_NAME = 'helm-desktop';

export interface DesktopNameApp {
  setDesktopName(name: string): void;
}

/** only Linux takes effect, return is otherwise already settings. */
export function applyLinuxDesktopName(app: DesktopNameApp, platform: NodeJS.Platform): boolean {
  if (platform !== 'linux') return false;
  app.setDesktopName(LINUX_DESKTOP_NAME);
  return true;
}
