#!/usr/bin/env node
/**
 * development phase Hub start:tsx direct run packages/hub/src/main.ts source code.
 *
 * Why store in:hub source code with package name import @helm/kernel / @helm/plugins;tsx run phase must via
 * tsconfig.dev.json  paths two parse to source code, and repositorydev/test one rule run source code
 * single module identity convention consistent (dist and source double identity will let instanceof error mapping into 500 etc.
 * static default wrong chaotic).npm scripts inline environment variable do not across platform, reason by this script unify inject and spawn.
 * build artifact (hub dist) do not subject to affect:tsc must not use dev paths, package name import per common dist.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const require = createRequire(path.join(repoRoot, 'package.json'));
const pkgPath = require.resolve('tsx/package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.tsx;
const tsxCli = path.resolve(path.dirname(pkgPath), bin ?? 'dist/cli.mjs');
if (!existsSync(tsxCli)) {
  console.error(`[run-hub] not found local tsx CLI: ${tsxCli}(please first pnpm install)`);
  process.exit(1);
}

const childEnv = { ...process.env };
if (childEnv.TSX_TSCONFIG_PATH === undefined) {
  childEnv.TSX_TSCONFIG_PATH = path.join(repoRoot, 'tsconfig.dev.json');
}

const child = spawn(process.execPath, [tsxCli, path.join(repoRoot, 'packages/hub/src/main.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: childEnv,
  cwd: process.cwd(),
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  });
}
child.on('error', (err) => {
  console.error(`[run-hub] failed to start: ${err.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 1);
});
