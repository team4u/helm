/**
 * Hub produce product layer Web static directory parse policy.
 *
 * Why independent module: kernel createHubHandler/startHub only accept explicit webDistDir(default pure
 * API, do not hard encode Web package location); by default directory in which is hub produce product policy, follow hub entry
 * itself location while set, concentrate in this can test.
 *
 * layout convention (src and dist under same construct, all on trace two level to payload/repository package and column layer):
 * - repository development:packages/hub/{src,dist}/main.ts → packages/web/dist;
 * - npm payload:<payload>/hub/dist/main.js → <payload>/web/dist(web and hub same level).
 * directory inside must has index.html only then treated as valid (unbuilt does not pretend to be static site).
 */
import { statSync } from 'node:fs';
import { join } from 'node:path';

/** probe <entryDir>/../../web/dist; store in index.html when return the directory, otherwise undefined(pure API form). */
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

/** parse HELM_WEB_DIST_DIR: explicit directory takes precedence;'false'/'0'/'' explicit disable; not settings away resolveHubWebDistDir. */
export function resolveWebDistOption(
  env: string | undefined,
  entryDir: string,
): { webDistDir: string | false | undefined } {
  if (env === undefined) return { webDistDir: resolveHubWebDistDir(entryDir) };
  if (env === 'false' || env === '0' || env === '') return { webDistDir: false };
  return { webDistDir: env };
}
