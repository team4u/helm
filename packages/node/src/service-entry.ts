/**
 * CLI itself entry path parse: background spawn and upgrade choose fixed launcherentry locate,
 * and service install must use compile artifact (dist/cli.js) entry parse.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { UsageError } from './cli-context.js';

/**
 * CLI itself entry (source code pattern is src/cli.ts; compile after by package structure fall back dist/cli.js).
 * note: cannot reference this module import.meta.url(that is service-entry.ts itself) - -
 * directly by this module at src/ under, and cli.ts same directory package structure locate.
 */
export function cliSelfEntry(): string {
  const self = path.resolve(fileURLToPath(import.meta.url));
  const cli = path.resolve(path.dirname(self), 'cli.ts');
  if (fs.existsSync(cli)) return cli;
  return path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
}

/**
 * service install entry: open machine service without tsx loader, must use compile artifact dist/cli.js.
 * - with compile artifact run: return itself;
 * - with source code entry run: return same package dist/cli.js(must already exists);
 * - source code run and without compile artifact: explicit errors (do not generate cannot start service).
 */
export function resolveServiceEntry(selfPath: string = fileURLToPath(import.meta.url)): string {
  const self = path.resolve(selfPath);
  if (self.endsWith(path.join('dist', 'cli.js'))) return self;
  const distEntry = path.resolve(path.dirname(self), '..', 'dist', 'cli.js');
  try {
    return realpathSync(distEntry);
  } catch {
    throw new UsageError(
      `service entry must use compile artifact (expectation ${distEntry}): when before with source code entry run and not found compile artifact; please first in repository execute pnpm build again install service`,
      'missing_build',
    );
  }
}
