#!/usr/bin/env node
/**
 * Build asset completion & frontend precompilation:
 * 1. Copies each src/<name>/client directory to dist/<name>/client;
 * 2. Precompiles every built-in UI plugin's declared client modules into dist/<name>/dist-client/
 *    (manifest.json + hashed entry/chunks + pre-gzipped .gz files) via @helm/plugin-build so
 *    runtime hosts and @helm/payload require zero esbuild or mermaid runtime dependencies.
 * Idempotent — wipes previous dist/<name>/dist-client before invoking plugin factories so plugins
 * like builtin:mermaid resolve build-time npmDependencies from devDependencies during build.
 */
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE, clientNpmRootsOf } from '@helm/protocol';
import { buildPluginClientBundleDir } from '@helm/plugin-build';

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcPlugins = join(pkgRoot, 'src');
const distPlugins = join(pkgRoot, 'dist');

if (!existsSync(distPlugins)) {
  console.error(`[plugins] ${distPlugins} is missing; run the tsc build first`);
  process.exit(1);
}

// Step 1: Copy source client/ dirs to dist/<name>/client and clear stale dist-client/ so plugin
// factories inspect source mode (attaching npmDependencies needed for precompilation).
const clientPluginDirs = [];
let copied = 0;
for (const entry of readdirSync(srcPlugins, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!entry.isDirectory()) continue;
  const clientSrc = join(srcPlugins, entry.name, 'client');
  if (!existsSync(clientSrc)) continue;
  cpSync(clientSrc, join(distPlugins, entry.name, 'client'), { recursive: true });
  rmSync(join(distPlugins, entry.name, PREBUILT_CLIENT_DIR_NAME), { recursive: true, force: true });
  clientPluginDirs.push(entry.name);
  copied += 1;
}

function makeNoopProxy() {
  const fn = () => {};
  const proxy = new Proxy(fn, {
    get(_target, prop) {
      if (prop === 'then') return undefined;
      return proxy;
    },
    apply() {
      return proxy;
    },
  });
  return proxy;
}

function captureClientRefs(def) {
  const refs = [];
  let configState = {};
  const docStub = { get: () => ({}), set: () => {}, update: () => {}, onChange: () => () => {} };
  const uiProxy = new Proxy(
    {},
    {
      get(_t, _surface) {
        return (spec) => {
          if (spec && typeof spec === 'object' && spec.client && typeof spec.client === 'object') {
            refs.push({
              module: String(spec.client.module ?? ''),
              export: String(spec.client.export ?? ''),
            });
          }
        };
      },
    },
  );
  const noop = makeNoopProxy();
  const baseCtx = {
    pluginId: def.id,
    dataDir: pkgRoot,
    ui: uiProxy,
    doc: () => docStub,
    sessionDoc: () => docStub,
    configSchema: (schema) => {
      const next = {};
      if (schema && typeof schema === 'object') {
        for (const [key, field] of Object.entries(schema)) {
          if (field && typeof field === 'object' && 'default' in field) {
            next[key] = field.default;
          }
        }
      }
      configState = next;
    },
    getConfig: () => configState,
    onConfigChanged: () => () => {},
    host: noop,
  };
  const ctx = new Proxy(baseCtx, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return noop;
    },
  });
  def.definePlugin(ctx);
  return refs;
}

// Step 2: Load compiled plugin factories from dist/index.js and precompile declared modules.
const pluginsMod = await import(pathToFileURL(join(distPlugins, 'index.js')).href);
const prebuiltDirs = new Set();
let totalModules = 0;
let totalBytes = 0;

for (const [exportName, factory] of Object.entries(pluginsMod).sort(([a], [b]) => a.localeCompare(b))) {
  if (!exportName.startsWith('create') || !exportName.endsWith('Plugin') || typeof factory !== 'function') continue;
  const def = factory();
  const refs = captureClientRefs(def);
  if (refs.length === 0) continue;
  if (!def.clientRoot) {
    throw new Error(`[plugins] built-in plugin ${def.id} (${exportName}) declared client refs without clientRoot`);
  }
  const pluginDirName = basename(dirname(def.clientRoot));
  const outDir = join(distPlugins, pluginDirName, PREBUILT_CLIENT_DIR_NAME);
  const modules = [...new Set(refs.map((r) => r.module))];
  const built = await buildPluginClientBundleDir({
    pluginId: def.id,
    clientRoot: def.clientRoot,
    outDir,
    modules,
    npmRoots: clientNpmRootsOf(def.npmDependencies),
  });
  for (const ref of refs) {
    const entry = built.manifest.modules[ref.module];
    if (!entry) {
      throw new Error(`[plugins] prebuilt manifest missing ${ref.module} for ${def.id}`);
    }
    if (!entry.exports.includes(ref.export)) {
      throw new Error(
        `[plugins] prebuilt module ${ref.module} for ${def.id} is missing export "${ref.export}" (exports: ${entry.exports.join(', ')})`,
      );
    }
  }
  prebuiltDirs.add(pluginDirName);
  totalModules += modules.length;
  totalBytes += built.totalBytes;
}

const missingPrebuilt = clientPluginDirs.filter(
  (dirName) => !prebuiltDirs.has(dirName) || !existsSync(join(distPlugins, dirName, PREBUILT_CLIENT_DIR_NAME, PREBUILT_CLIENT_MANIFEST_FILE)),
);
if (missingPrebuilt.length > 0) {
  throw new Error(`[plugins] built-in UI plugin directories missing prebuilt dist-client: ${missingPrebuilt.join(', ')}`);
}

console.log(
  `[plugins] copied ${copied} client dirs and prebuilt ${prebuiltDirs.size} dist-client bundles (${totalModules} modules, ${(totalBytes / 1024).toFixed(1)} KiB)`,
);
