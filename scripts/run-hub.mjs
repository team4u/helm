#!/usr/bin/env node
/**
 * Dev-time Hub launcher: runs the packages/hub/src/main.ts sources directly via tsx.
 *
 * Why it exists: hub sources import @helm/kernel / @helm/plugins by package name; at
 * tsx runtime the tsconfig.dev.json paths must resolve both to sources, matching the
 * repo's single-module-identity convention of running sources for dev/test (a dual
 * dist/source identity silently corrupts things like instanceof errors mapping to 500s).
 * Inline env vars in npm scripts are not cross-platform, so this script injects them
 * uniformly and spawns. Build artifacts (hub dist) are unaffected: tsc does not apply
 * dev paths, package-name imports still land in dist.
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
  console.error(`[run-hub] local tsx CLI not found: ${tsxCli} (run pnpm install first)`);
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
