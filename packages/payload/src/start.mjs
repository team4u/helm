#!/usr/bin/env node
/**
 * Zero-dependency Hub payload launcher (ships inside the payload directory; Node >= 24, no npm deps).
 *
 * Commands:
 *   node start.mjs check   Validate manifest/entries/checksums (strictly relative paths), resolve
 *                          all dependencies from dist/package.json across the 7 runtime entry points
 *                          (hub/kernel/plugins/plugin-build/env-io/protocol/cli) via
 *                          createRequire — matching Hub runtime Node resolution (import.meta.resolve's
 *                          parent parameter is ignored by default in current Node, so it cannot be
 *                          used here) — then exercise runtime capabilities: import node:sqlite and
 *                          load esbuild to transform a JS snippet (covering plugin client compilation).
 *                          check never starts the Hub.
 *   node start.mjs start   Verify dependencies, then spawn the hub entry (hub/dist/main.js), passing
 *                          through environment variables and signals; sets HELM_WEB_DIST_DIR when
 *                          web/dist exists and is not explicitly configured (once @helm/kernel is
 *                          installed under node_modules, its default probe no longer hits the payload
 *                          layout; start declares it explicitly rather than silently disabling static
 *                          hosting).
 *
 * Exit codes (never falls back silently):
 *   0  Validation, dependency resolution, and runtime capability checks passed (or child exited 0)
 *   1  Invalid usage or corrupt payload layout / checksums / manifest contract
 *   3  Valid layout, but missing dependencies or failed runtime capability check (e.g. missing esbuild native binary)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';

const payloadRoot = path.dirname(fileURLToPath(import.meta.url));
const EXIT_ERROR = 1;
const EXIT_DEPS_MISSING = 3;

const usage = () => {
  console.error('Usage: node start.mjs <check|start>');
  process.exit(EXIT_ERROR);
};

/** Strict contract for a single entry path: non-empty, relative POSIX path with no .. traversal. */
function assertEntryPath(key, rel) {
  const problems = [];
  if (typeof rel !== 'string' || rel.length === 0) problems.push(`- ${key}: path must be a non-empty string`);
  else {
    if (path.isAbsolute(rel) || rel.includes('\\')) problems.push(`- ${key} (${rel}): must be a relative POSIX path`);
    const segments = rel.split('/');
    if (segments.includes('..') || segments.includes('')) problems.push(`- ${key} (${rel}): '..' and empty segments are forbidden`);
    const abs = path.resolve(payloadRoot, rel);
    if (!abs.startsWith(`${payloadRoot}${path.sep}`)) problems.push(`- ${key} (${rel}): resolves outside payload root`);
  }
  return problems;
}

/** Load and strictly validate manifest.json (assumes no extra fields; exits 1 with explicit errors). */
function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf-8'));
  } catch (err) {
    console.error(`[payload] manifest.json missing or invalid: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  if (manifest.formatVersion !== 1) {
    console.error(`[payload] unsupported manifest.formatVersion: ${String(manifest.formatVersion)} (expected 1)`);
    process.exit(EXIT_ERROR);
  }
  const entries = manifest.entries ?? {};
  const checksums = manifest.entryChecksums ?? {};
  const entryKeys = Object.keys(entries).sort();
  const checksumKeys = Object.keys(checksums).sort();
  if (entryKeys.length === 0 || JSON.stringify(entryKeys) !== JSON.stringify(checksumKeys)) {
    console.error(`[payload] manifest.entries and entryChecksums keys mismatch or are empty: ${entryKeys} vs ${checksumKeys}`);
    process.exit(EXIT_ERROR);
  }
  // Strict path validation: report all problems before exiting (never touch suspect paths).
  const pathProblems = Object.entries(entries).flatMap(([key, rel]) => assertEntryPath(key, rel));
  if (pathProblems.length > 0) {
    console.error(`[payload] manifest.entries path check failed:\n${pathProblems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  return { manifest, entries, checksums };
}

/** Verify each entry exists and matches its sha256 checksum; list all failures before exiting 1. */
function checkLayout(entries, checksums, version) {
  const problems = [];
  for (const [key, rel] of Object.entries(entries)) {
    const abs = path.resolve(payloadRoot, rel);
    let actual = null;
    try {
      actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    } catch {
      problems.push(`- ${key} (${rel}): file missing or unreadable`);
      continue;
    }
    if (actual !== checksums[key]) problems.push(`- ${key} (${rel}): checksum mismatch (expected ${checksums[key]}, actual ${actual})`);
  }
  if (problems.length > 0) {
    console.error(`[payload] layout validation failed:\n${problems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  console.log(`[payload] layout validated: ${Object.keys(entries).length} entry checksums match (version ${String(version)})`);
}

/**
 * Dependency resolution: resolve every dependency in dist/package.json from all 7 runtime entry
 * points (hub / kernel / plugins / plugin-build / env-io / protocol / cli) using
 * createRequire(entry).resolve, matching Hub runtime Node resolution (import.meta.resolve ignores
 * its second parent argument in current Node, which previously caused false positives).
 */
function resolveProdDeps(entries) {
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(path.join(payloadRoot, 'package.json'), 'utf-8')).dependencies ?? {};
  } catch (err) {
    console.error(`[payload] root package.json missing or invalid: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  const bases = {
    hub: path.resolve(payloadRoot, entries.hub ?? 'hub/dist/main.js'),
    kernel: path.resolve(payloadRoot, entries.kernel ?? 'kernel/dist/index.js'),
    plugins: path.resolve(payloadRoot, entries.plugins ?? 'plugins/dist/index.js'),
    pluginBuild: path.resolve(payloadRoot, entries.pluginBuild ?? 'plugin-build/dist/index.js'),
    envIo: path.resolve(payloadRoot, entries.envIo ?? 'env-io/dist/index.js'),
    protocol: path.resolve(payloadRoot, entries.protocol ?? 'protocol/dist/index.js'),
    cli: path.resolve(payloadRoot, entries.cli ?? 'cli/dist/index.js'),
  };
  const requires = Object.fromEntries(
    Object.entries(bases).map(([name, entry]) => [name, createRequire(entry)]),
  );
  /**
   * Single-point resolution: require.resolve -> <name>/package.json subpath -> upward node_modules walk.
   * The latter two fallbacks are not compromises: @earendil-works/* packages are ESM-only (exports
   * define only import), so require.resolve throws ERR_PACKAGE_PATH_NOT_EXPORTED even though runtime
   * ESM import works; walking parent node_modules mirrors Node's lookup to verify installation.
   */
  const resolvable = (req, entry, name) => {
    try {
      req.resolve(name);
      return true;
    } catch { /* try next fallback */ }
    try {
      req.resolve(`${name}/package.json`);
      return true;
    } catch { /* try next fallback */ }
    let cur = path.dirname(entry);
    for (;;) {
      if (existsSync(path.join(cur, 'node_modules', name, 'package.json'))) return true;
      const parent = path.dirname(cur);
      if (parent === cur) return false;
      cur = parent;
    }
  };
  const missing = [];
  const names = Object.keys(deps).sort();
  for (const name of names) {
    for (const [base, req] of Object.entries(requires)) {
      if (!resolvable(req, bases[base], name)) missing.push(`${name} (from ${base} entry)`);
    }
  }
  return { total: names.length, missing };
}

/**
 * Exercise runtime capabilities (dependency capabilities only; never starts the Hub):
 * - node:sqlite: built-in Node module required by kernel durability (Node >= 22.5);
 * - esbuild: actually load and transform a JS snippet — exercises the plugin client build chain and
 *   verifies the native esbuild binary for the current platform (--ignore-scripts installs binaries
 *   via optionalDependencies, without postinstall checks, so resolving alone is insufficient).
 */
async function probeRuntimeCapabilities(entries) {
  const failures = [];
  try {
    await import('node:sqlite');
  } catch (err) {
    failures.push(`node:sqlite unavailable (Node version too old or built without sqlite): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const hubEntry = path.resolve(payloadRoot, entries.hub ?? 'hub/dist/main.js');
    const esbuild = createRequire(hubEntry)('esbuild');
    const out = await esbuild.transform('const answer = 42\n', { loader: 'js' });
    if (typeof out?.code !== 'string' || !out.code.includes('answer')) throw new Error('unexpected transform output');
  } catch (err) {
    failures.push(`esbuild check failed (platform native binary missing or unusable): ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

function reportDeps(result) {
  if (result.missing.length === 0) {
    console.log(`[payload] all production dependencies resolved (${result.total}/${result.total} across 7 entry points: hub/kernel/plugins/plugin-build/env-io/protocol/cli)`);
    return;
  }
  console.error(`[payload] missing runtime dependencies (${result.missing.length}): ${result.missing.join(', ')}`);
  console.error('[payload] this directory does not bundle node_modules; run `npm install --omit=dev --ignore-scripts` in the payload root and retry.');
}

const command = process.argv[2];
if (command === 'check') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveProdDeps(entries);
  if (result.missing.length > 0) {
    reportDeps(result);
    process.exit(EXIT_DEPS_MISSING);
  }
  reportDeps(result);
  const failures = await probeRuntimeCapabilities(entries);
  if (failures.length > 0) {
    console.error(`[payload] runtime capability check failed:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  console.log('[payload] runtime capability check passed (node:sqlite + esbuild transform)');
  process.exit(0);
} else if (command === 'start') {
  const { manifest, entries, checksums } = loadManifest();
  checkLayout(entries, checksums, manifest.version);
  const result = resolveProdDeps(entries);
  if (result.missing.length > 0) {
    reportDeps(result);
    process.exit(EXIT_DEPS_MISSING);
  }
  const failures = await probeRuntimeCapabilities(entries);
  if (failures.length > 0) {
    console.error(`[payload] runtime capability check failed:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  const hubEntry = path.resolve(payloadRoot, entries.hub);
  // Export static hosting dir when web/dist exists and HELM_WEB_DIST_DIR is unset (see header; never silently fall back).
  const childEnv = { ...process.env };
  if (childEnv.HELM_WEB_DIST_DIR === undefined && existsSync(path.join(payloadRoot, 'web/dist'))) {
    childEnv.HELM_WEB_DIST_DIR = path.resolve(payloadRoot, 'web/dist');
  }
  const child = spawn(process.execPath, [hubEntry], { stdio: 'inherit', env: childEnv });
  const forward = (signal) => () => child.kill(signal);
  process.on('SIGINT', forward('SIGINT'));
  process.on('SIGTERM', forward('SIGTERM'));
  child.on('exit', (code, signal) => {
    process.exit(code ?? (signal ? 128 : EXIT_ERROR));
  });
} else {
  usage();
}
