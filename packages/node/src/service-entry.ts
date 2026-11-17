/**
 * Resolves CLI entrypoints: `cliSelfEntry()` for spawning detached daemons from source or dist,
 * and `resolveServiceEntry()` for OS startup services (which require compiled `dist/cli.js`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { UsageError } from './cli-context.js';

/**
 * Resolve this package's own CLI entrypoint (`src/cli.ts` in source mode, `dist/cli.js` when built).
 */
export function cliSelfEntry(): string {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const cli = path.resolve(path.dirname(self), 'cli.ts');
  if (fs.existsSync(cli)) return cli;
  return path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
}

/**
 * Resolve the compiled entrypoint (`dist/cli.js`) required by OS service managers (which lack tsx).
 * Throws `missing_build` if running from source without compiled `dist/cli.js`.
 */
export function resolveServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath);
  if (self.endsWith(path.join('dist', 'cli.js'))) return self;
  const distEntry = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
  try {
    return realpathSync(distEntry);
  } catch {
    throw new UsageError(
      `service entrypoint must be the compiled artifact (${distEntry}), which was not found while running from source; run pnpm build in the repository first`,
      'missing_build',
    );
  }
}
