#!/usr/bin/env node
/**
 * Hub payload zero dependency start entry (follow payload directory dispatch,Node >= 24, without any npm dependency).
 *
 * command:
 *   node start.mjs check   validate manifest/entries/checksums(strictly relative path), and by
 *                          dist  package.json dependencies from hub/kernel/plugins/
 *                          plugin-build/env-io/protocol/cli seven runtime entry one by one dependency do real parse (createRequire
 *                          - - and runtime Node parse semantics consistent;import.meta.resolve 
 *                          parent parameter in when before Node by default by ignore, unavailable at this), then measured
 *                          runtime capability:import node:sqlite, load esbuild and real
 *                          transform one segment JS(override plugin client compile link).check never
 *                          start Hub.
 *   node start.mjs start   dependency verify via after pull start hub entry (hub/dist/main.js), pass-through
 *                          environment variable and signal;web/dist store in and not explicit config when export
 *                          HELM_WEB_DIST_DIR(@helm/kernel via npm install enter
 *                          node_modules after its source code inside by default probe no longer hit payload layout,
 *                          by start explicit declaration, not silently fall back is without static hosting).
 *
 * exit code (never static default fall back):
 *   0  validate via and dependency can parse, runtime capability measured succeeded (or start child process normal exit)
 *   1  use method error or payload layout/validate and/manifest contract corrupt
 *   3  layout legal but dependency missing or runtime capability measured failed (such as esbuild platform two enter system unavailable)
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
  console.error('use method: node start.mjs <check|start>');
  process.exit(EXIT_ERROR);
};

/** single entry path strictly contract: non-empty, each other for,POSIX isolate, without .. out of bounds. */
function assertEntryPath(key, rel) {
  const problems = [];
  if (typeof rel !== 'string' || rel.length === 0) problems.push(`- ${key}: path must be non-empty string`);
  else {
    if (path.isAbsolute(rel) || rel.includes('\\')) problems.push(`- ${key} (${rel}): must be each other for POSIX path`);
    const segments = rel.split('/');
    if (segments.includes('..') || segments.includes('')) problems.push(`- ${key} (${rel}): disallows .. / empty segment`);
    const abs = path.resolve(payloadRoot, rel);
    if (!abs.startsWith(`${payloadRoot}${path.sep}`)) problems.push(`- ${key} (${rel}): parse exceeds out payload `);
  }
  return problems;
}

/** read and do strictly contract validate (do not assume redundant field; exception explicit errors exit 1). */
function loadManifest() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(payloadRoot, 'manifest.json'), 'utf-8'));
  } catch (err) {
    console.error(`[payload] manifest.json missing or illegal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(EXIT_ERROR);
  }
  if (manifest.formatVersion !== 1) {
    console.error(`[payload] manifest.formatVersion unsupported: ${String(manifest.formatVersion)}(expectation 1)`);
    process.exit(EXIT_ERROR);
  }
  const entries = manifest.entries ?? {};
  const checksums = manifest.entryChecksums ?? {};
  const entryKeys = Object.keys(entries).sort();
  const checksumKeys = Object.keys(checksums).sort();
  if (entryKeys.length === 0 || JSON.stringify(entryKeys) !== JSON.stringify(checksumKeys)) {
    console.error(`[payload] manifest.entries and entryChecksums key inconsistent or is empty: ${entryKeys} vs ${checksumKeys}`);
    process.exit(EXIT_ERROR);
  }
  // path strictly validate: all issue once column all after again exit (never carries can doubt path continue do IO).
  const pathProblems = Object.entries(entries).flatMap(([key, rel]) => assertEntryPath(key, rel));
  if (pathProblems.length > 0) {
    console.error(`[payload] manifest.entries path contract failed:\n${pathProblems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  return { manifest, entries, checksums };
}

/** one by one entry validate store in and sha256; failed column all after once exit 1. */
function checkLayout(entries, checksums, version) {
  const problems = [];
  for (const [key, rel] of Object.entries(entries)) {
    const abs = path.resolve(payloadRoot, rel);
    let actual = null;
    try {
      actual = createHash('sha256').update(readFileSync(abs)).digest('hex');
    } catch {
      problems.push(`- ${key} (${rel}): file missing or cannot read`);
      continue;
    }
    if (actual !== checksums[key]) problems.push(`- ${key} (${rel}): checksum inconsistent (expectation ${checksums[key]}, actual ${actual})`);
  }
  if (problems.length > 0) {
    console.error(`[payload] layout validation failed:\n${problems.join('\n')}`);
    process.exit(EXIT_ERROR);
  }
  console.log(`[payload] layout validate via: ${Object.keys(entries).length} items entry checksum consistent (version ${String(version)})`);
}

/**
 * dependency parse: with dist  package.json dependencies is contract manifest, from hub / kernel /
 * plugins / plugin-build / env-io / protocol / cli seven runtime entry file starting from use createRequire(entry).resolve
 * do real parse - - and Hub runtime Node parse semantics same source (import.meta.resolve second parameter
 * in Node by default by ignore, before implement will in any host directory under mistakenly judge).
 */
function resolveProdDeps(entries) {
  let deps = {};
  try {
    deps = JSON.parse(readFileSync(path.join(payloadRoot, 'package.json'), 'utf-8')).dependencies ?? {};
  } catch (err) {
    console.error(`[payload]  package.json missing or illegal: ${err instanceof Error ? err.message : String(err)}`);
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
   * single point parse:require.resolve → <name>/package.json sub- path → node_modules one by one layer on trace.
   * after two level fall back is not proper coordinate:@earendil-works/* is ESM-only(exports only import item),
   * require.resolve will report ERR_PACKAGE_PATH_NOT_EXPORTED, but runtime ESM import fully available;
   * one by one layer on trace re- moment Node parse algorithm store in decide, only verify package installed at can parse location.
   */
  const resolvable = (req, entry, name) => {
    try {
      req.resolve(name);
      return true;
    } catch { /* continue fall back */ }
    try {
      req.resolve(`${name}/package.json`);
      return true;
    } catch { /* continue fall back */ }
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
      if (!resolvable(req, bases[base], name)) missing.push(`${name}(self ${base} entry)`);
    }
  }
  return { total: names.length, missing };
}

/**
 * runtime capability measured (only test dependency capability, do not execute Hub):
 * - node:sqlite:kernel durable layer Node inside placement module (Node >= 22.5 and --experimental rotate correct after available);
 * - esbuild: real load + transform one segment JS- - override plugin client compile link, also measured
 *   when before platform esbuild original generate two enter system (--ignore-scripts install under two enter system by optionalDependencies
 *   platform package provide,postinstall validate script unavailable, must measured while non- only see can parse).
 */
async function probeRuntimeCapabilities(entries) {
  const failures = [];
  try {
    await import('node:sqlite');
  } catch (err) {
    failures.push(`node:sqlite unavailable (Node version low or build missing inside placement module): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    const hubEntry = path.resolve(payloadRoot, entries.hub ?? 'hub/dist/main.js');
    const esbuild = createRequire(hubEntry)('esbuild');
    const out = await esbuild.transform('const answer = 42\n', { loader: 'js' });
    if (typeof out?.code !== 'string' || !out.code.includes('answer')) throw new Error('transform output exception');
  } catch (err) {
    failures.push(`esbuild measured failed (platform two enter system missing or unavailable): ${err instanceof Error ? err.message : String(err)}`);
  }
  return failures;
}

function reportDeps(result) {
  if (result.missing.length === 0) {
    console.log(`[payload] produce dependency all can parse (${result.total}/${result.total},hub/kernel/plugins/plugin-build/env-io/protocol/cli seven entry)`);
    return;
  }
  console.error(`[payload] runtime dependency missing (${result.missing.length} items): ${result.missing.join(', ')}`);
  console.error('[payload] this directory not carry node_modules; please in payload directory execute npm install --omit=dev --ignore-scripts after retry.');
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
    console.error(`[payload] runtime capability measured failed:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  console.log('[payload] runtime capability measured via (node:sqlite + esbuild transform)');
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
    console.error(`[payload] runtime capability measured failed:\n${failures.map((f) => `- ${f}`).join('\n')}`);
    process.exit(EXIT_DEPS_MISSING);
  }
  const hubEntry = path.resolve(payloadRoot, entries.hub);
  // web/dist store in and not explicit config when export static hosting directory (see file head note release; never static default fall back).
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
