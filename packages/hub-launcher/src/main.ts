#!/usr/bin/env node
/**
 * `helm-hub-launcher` binary entrypoint. The launcher is a stable external install: it manages the
 * payload releases under the install root but is itself never overwritten by them. Direct
 * execution runs only when `argv[1]` resolves to this module (supporting pnpm `.bin` symlinks).
 */
import path from 'node:path';
import process from 'node:process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runLauncherCli } from './cli.js';
import { defaultLauncherIo } from './io.js';

export function isDirectRun(entryArgv = process.argv[1]): boolean {
  if (entryArgv === undefined) return false;
  try {
    const self = realpathSync(fileURLToPath(import.meta.url));
    const entry = realpathSync(path.resolve(entryArgv));
    return self === entry;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  runLauncherCli(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
