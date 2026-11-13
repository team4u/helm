import { createRequire } from 'node:module';
import type { BrowserWindow, Tray } from 'electron';

export type ElectronApi = typeof import('electron');
export type BrowserWindowLike = BrowserWindow;
export type TrayLike = Tray;

export function getElectron(): ElectronApi | null {
  if (process.versions.electron === undefined || process.env.ELECTRON_RUN_AS_NODE === '1') return null;
  return createRequire(import.meta.url)('electron') as ElectronApi;
}
