/**
 * Prebuilt client bundle builder (`buildPluginClientBundleDir`):
 * compiles a plugin's client entrypoint modules into a static, self-contained `dist-client/`
 * directory (entry `.mjs` + `.mjs.gz`, split chunks `.js` + `.js.gz`, and `manifest.json`)
 * sharing the exact `__helm_shared_*` and `__helm_import_chunk` ABI of `compilePluginClientModule`.
 */
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import {
  HelmError,
  PREBUILT_CLIENT_MANIFEST_FILE,
  PREBUILT_CLIENT_MANIFEST_VERSION,
  assertModuleRefShape,
  assertPrebuiltClientManifest,
  prebuiltChunkFileName,
  type BuildPluginClientBundleDirOptions,
  type BuildPluginClientBundleDirResult,
  type PrebuiltClientManifest,
  type PrebuiltClientModuleEntry,
} from '@helm/protocol';
import { atomicWriteFileSync } from '@helm/env-io';
import {
  compilePluginClientModule,
  realPathOrThrow,
  safeFileName,
} from './client-compiler.js';

const CLIENT_ENTRY_PATTERN = /\.(ts|tsx)$/;
const DECLARATION_FILE_PATTERN = /\.d\.[cm]?ts$/i;

/** Scans `clientRoot` recursively for non-declaration `.ts`/`.tsx` entry modules (POSIX relative paths). */
function discoverClientModules(clientRootReal: string): string[] {
  const found: string[] = [];
  const visit = (dir: string, relPrefix: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const abs = join(dir, entry.name);
      const rel = relPrefix === '' ? entry.name : `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        visit(abs, rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (CLIENT_ENTRY_PATTERN.test(entry.name) && !DECLARATION_FILE_PATTERN.test(entry.name)) {
          found.push(rel);
        }
      }
    }
  };
  visit(clientRootReal, '');
  return found;
}

/**
 * Compiles one or more client entry modules under `clientRoot` into a standalone prebuilt directory
 * containing `manifest.json`, entry `.mjs` + `.gz`, and all split chunks `.js` + `.gz`.
 */
export async function buildPluginClientBundleDir(
  options: BuildPluginClientBundleDirOptions,
): Promise<BuildPluginClientBundleDirResult> {
  const { pluginId, clientRoot, outDir, npmRoots = [] } = options;
  if (typeof pluginId !== 'string' || pluginId.length === 0) {
    throw new HelmError('invalid_plugin_definition', 'buildPluginClientBundleDir requires a non-empty pluginId', 400);
  }
  const rootReal = realPathOrThrow(clientRoot, `plugin ${pluginId} clientRoot is missing or inaccessible: ${clientRoot}`);
  if (!statSync(rootReal).isDirectory()) {
    throw new HelmError('client_root_invalid', `plugin ${pluginId} clientRoot is not a directory: ${clientRoot}`, 400, {
      pluginId,
      clientRoot,
    });
  }

  let targetModules: string[];
  if (options.modules !== undefined) {
    if (options.modules.length === 0) {
      throw new HelmError('invalid_client_module', `plugin ${pluginId} buildPluginClientBundleDir modules list cannot be empty`, 400, {
        pluginId,
      });
    }
    const seen = new Set<string>();
    targetModules = [];
    for (const m of options.modules) {
      assertModuleRefShape(pluginId, m);
      if (!seen.has(m)) {
        seen.add(m);
        targetModules.push(m);
      }
    }
  } else {
    targetModules = discoverClientModules(rootReal);
    if (targetModules.length === 0) {
      throw new HelmError(
        'client_root_invalid',
        `plugin ${pluginId} has no .ts/.tsx entry modules in clientRoot: ${clientRoot}`,
        400,
        { pluginId, clientRoot },
      );
    }
  }

  const workDir = mkdtempSync(join(tmpdir(), 'helm-prebuilt-build-'));
  const cacheDir = join(workDir, 'cache');
  const stagingOut = join(workDir, 'out');
  mkdirSync(stagingOut, { recursive: true });

  try {
    const manifestModules: Record<string, PrebuiltClientModuleEntry> = {};
    let totalBytes = 0;

    for (const moduleRef of targetModules) {
      const bundle = await compilePluginClientModule(pluginId, rootReal, moduleRef, cacheDir, {
        npmRoots,
      });
      const baseName = safeFileName(moduleRef);
      const entryFile = `${baseName}.${bundle.contentHash}.mjs`;
      const entryGz = bundle.gzipped ?? gzipSync(Buffer.from(bundle.code, 'utf8'));
      atomicWriteFileSync(join(stagingOut, entryFile), bundle.code);
      atomicWriteFileSync(join(stagingOut, `${entryFile}.gz`), entryGz);
      totalBytes += Buffer.byteLength(bundle.code, 'utf8') + entryGz.byteLength;

      const chunkNames = Object.keys(bundle.chunks ?? {}).sort();
      for (const chunkName of chunkNames) {
        const chunkData = bundle.chunks![chunkName]!;
        const chunkFile = prebuiltChunkFileName(entryFile, chunkName, pluginId);
        const chunkGz = chunkData.gzipped ?? gzipSync(Buffer.from(chunkData.code, 'utf8'));
        atomicWriteFileSync(join(stagingOut, chunkFile), chunkData.code);
        atomicWriteFileSync(join(stagingOut, `${chunkFile}.gz`), chunkGz);
        totalBytes += Buffer.byteLength(chunkData.code, 'utf8') + chunkGz.byteLength;
      }

      manifestModules[moduleRef] = {
        entryFile,
        contentHash: bundle.contentHash,
        exports: [...bundle.exports],
        ...(chunkNames.length > 0 ? { chunks: chunkNames } : {}),
      };
    }

    const manifestRaw: PrebuiltClientManifest = {
      version: PREBUILT_CLIENT_MANIFEST_VERSION,
      modules: manifestModules,
    };
    const manifest = assertPrebuiltClientManifest(manifestRaw, stagingOut);
    const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
    atomicWriteFileSync(join(stagingOut, PREBUILT_CLIENT_MANIFEST_FILE), manifestText);
    totalBytes += Buffer.byteLength(manifestText, 'utf8');

    const resolvedOut = resolve(outDir);
    rmSync(resolvedOut, { recursive: true, force: true });
    mkdirSync(dirname(resolvedOut), { recursive: true });
    cpSync(stagingOut, resolvedOut, { recursive: true });

    return {
      pluginId,
      clientRoot: rootReal,
      outDir: resolvedOut,
      manifestPath: join(resolvedOut, PREBUILT_CLIENT_MANIFEST_FILE),
      manifest,
      totalBytes,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
