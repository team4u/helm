#!/usr/bin/env node
/**
 * Dev-time bin mounting: places thin wrapper scripts in a system PATH directory that run
 * the repo sources directly via tsx.
 *
 * Unlike npm link (which points at dist/ and needs a rebuild after source changes), this
 * wraps the src/ entries so edits take effect immediately. Unix only (Linux/macOS);
 * exits with an explicit error on Windows.
 *
 * Usage:
 *   pnpm link:bins             # install helmx / helmx-node / helmx-hub wrapper scripts
 *   pnpm unlink:bins           # remove them
 *
 * Environment:
 *   HELMX_BIN_DIR  override the install directory (default /usr/local/bin)
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MARKER = 'generated-by:helmx/scripts/link-bins.mjs'

/** bin name -> source entry (repo-relative); helmx-hub goes through scripts/run-hub.mjs for dev path resolution */
const BINS = {
  helmx: 'packages/cli/src/index.ts',
  'helmx-node': 'packages/node/src/cli.ts',
  'helmx-hub': 'scripts/run-hub.mjs',
}

const removeMode = process.argv.includes('--remove')
if (process.platform === 'win32') {
  console.error('link-bins does not support Windows yet: use npm link instead (bins point at dist/, so run pnpm build after code changes).')
  process.exit(1)
}

const binDir = process.env.HELMX_BIN_DIR || '/usr/local/bin'
const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx')

if (!removeMode && !fs.existsSync(tsx)) {
  console.error(`tsx not found: ${tsx}; run pnpm install at the repo root first.`)
  process.exit(1)
}
if (!fs.existsSync(binDir)) {
  console.error(`Target directory does not exist: ${binDir} (override with HELMX_BIN_DIR).`)
  process.exit(1)
}

function wrapper(entry) {
  return [
    '#!/bin/sh',
    `# ${MARKER} — do not edit by hand; run pnpm unlink:bins to undo`,
    `exec "${tsx}" "${path.join(ROOT, entry)}" "$@"`,
    '',
  ].join('\n')
}

function npmLinkRemnant(p) {
  // npm link leftovers: bin symlinks or package symlinks inside global node_modules
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null
  } catch {
    return null
  }
}

function unlinkSyncSafe(p) {
  // Always unlink symlinks: fs.rmSync misreports ERR_FS_EISDIR on symlinks pointing at directories
  try {
    fs.unlinkSync(p)
  } catch {}
}

function cleanNpmLinkLibRemnants() {
  // npm link also leaves package symlinks at <prefix>/lib/node_modules/@helmx/<pkg>; clean those too (best effort)
  const nm = path.resolve(binDir, '..', 'lib', 'node_modules')
  for (const pkg of ['cli', 'node', 'kernel']) {
    const p = path.join(nm, '@helmx', pkg)
    if (npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  cleaning npm link leftover symlink ${p}`)
      const scopeDir = path.join(nm, '@helmx')
      try {
        if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir)
      } catch {}
    }
  }
}

if (removeMode) {
  console.log(`Removing ${Object.keys(BINS).join(' / ')} (${binDir})`)
  for (const name of Object.keys(BINS)) {
    const p = path.join(binDir, name)
    let content = ''
    try {
      content = fs.readFileSync(p, 'utf8')
    } catch {}
    if (content.includes(MARKER) || npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  removed ${p}`)
    } else if (fs.existsSync(p)) {
      console.warn(`  skipped ${p}: not produced by this script, left untouched`)
    }
  }
  cleanNpmLinkLibRemnants()
  console.log('Done.')
  process.exit(0)
}

console.log(`Installing dev wrapper scripts to ${binDir} (tsx runs the sources; edits apply immediately):`)
for (const [name, entry] of Object.entries(BINS)) {
  const p = path.join(binDir, name)
  let st = null
  try {
    st = fs.lstatSync(p)
  } catch {}
  if (st && !st.isSymbolicLink()) {
    // Existing regular file: overwrite only if it is this script's own output, otherwise
    // refuse explicitly (it might be some other tool's binary)
    if (!fs.readFileSync(p, 'utf8').includes(MARKER)) {
      console.error(`  refusing to overwrite ${p}: an existing file not produced by this script is in the way; verify it manually first.`)
      process.exit(1)
    }
  } else if (st) {
    // Symlink (dangling included): npm link leftovers or an old install; remove and rewrite
    unlinkSyncSafe(p)
  }
  fs.writeFileSync(p, wrapper(entry), { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  console.log(`  ${name} -> ${entry}`)
}
cleanNpmLinkLibRemnants()

// Self-check: tsx exists and the command starts (--help quick smoke; same for helmx-node;
// helmx-hub would really start the kernel, so only its syntax gets checked)
for (const name of ['helmx', 'helmx-node']) {
  try {
    execFileSync(path.join(binDir, name), ['--help'], { stdio: 'pipe', timeout: 60_000 })
    console.log(`  self-check passed: ${name} --help`)
  } catch (err) {
    console.error(`  self-check failed: ${name} --help\n${err.stderr || err.message}`)
    process.exit(1)
  }
}
console.log('Done. Run pnpm unlink:bins to undo.')
