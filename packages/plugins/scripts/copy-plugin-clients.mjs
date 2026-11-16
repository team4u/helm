#!/usr/bin/env node
/**
 * Build asset completion: copies each src/<name>/client directory to the same location in dist.
 *
 * Why: tsc only compiles TS and excludes the client directories (pure assets: the client.tsx entry plus
 * accompanying files); at runtime every plugin's resolveClientRoot only recognizes <plugin>/client and the
 * in-package src fallback; when dist is deployed standalone (helm-hub bin / payload / the desktop shell
 * subprocess), a missing directory makes createHelm throw <plugin>_client_missing immediately.
 * Idempotent — repeated runs have no side effects.
 */
import { cpSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcPlugins = join(pkgRoot, 'src');
const distPlugins = join(pkgRoot, 'dist');

if (!existsSync(distPlugins)) {
  console.error(`[plugins] ${distPlugins} is missing; run the tsc build first`);
  process.exit(1);
}

let copied = 0;
for (const entry of readdirSync(srcPlugins, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const clientSrc = join(srcPlugins, entry.name, 'client');
  if (!existsSync(clientSrc)) continue;
  cpSync(clientSrc, join(distPlugins, entry.name, 'client'), { recursive: true });
  copied += 1;
}
console.log(`[plugins] copied ${copied} plugin client directories to dist`);
