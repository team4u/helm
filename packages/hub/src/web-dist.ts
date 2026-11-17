/**
 * Web static asset directory resolution policy for the Hub product layer.
 *
 * Why a standalone module: `createHubHandler` / `startHub` in the kernel only accept an explicit
 * `webDistDir` (API-only by default, never hardcoding the Web package location). Where the default
 * directory lives is a Hub product policy relative to the Hub entrypoint, isolated here for testability.
 *
 * Layout convention (isomorphic under `src` and `dist`, stepping two levels up to sibling packages):
 * - Repository dev: `packages/hub/{src,dist}/main.ts` -> `packages/web/dist`;
 * - npm payload: `<payload>/hub/dist/main.js` -> `<payload>/web/dist` (`web` alongside `hub`).
 * The directory is treated as valid only if `index.html` exists (unbuilt dirs never pose as static sites).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** Probes `<entryDir>/../../web/dist`; returns the path when `index.html` exists, else `undefined` (API-only). */
export function resolveHubWebDistDir(entryDir: string): string | undefined {
  const distDir = join(entryDir, '..', '..', 'web', 'dist');
  try {
    return statSync(join(distDir, 'index.html')).isFile() ? distDir : undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw error;
  }
}

/** Parses `HELM_WEB_DIST_DIR`: explicit path wins; `'false'` / `'0'` / `''` disables static hosting; unset falls back to `resolveHubWebDistDir`. */
export function resolveWebDistOption(
  env: string | undefined,
  entryDir: string,
): { webDistDir: string | false | undefined } {
  if (env === undefined) return { webDistDir: resolveHubWebDistDir(entryDir) };
  if (env === 'false' || env === '0' || env === '') return { webDistDir: false };
  return { webDistDir: env };
}
