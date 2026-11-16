#!/usr/bin/env node
/**
 * development phase bin command mount: in system PATH directory put placement thin wrap script, via tsx direct run repository source code.
 *
 * and npm link(points to dist/, change source code must re- build) different, this script wrap src/ entry,
 * change i.e. when takes effect. only support Unix(Linux/macOS);Windows under explicit errors exit.
 *
 * use method:
 *   pnpm link:bins             # install helm / helm-node / helm-hub wrap script
 *   pnpm unlink:bins           # remove
 *
 * environment variable:
 *   HELM_BIN_DIR  override install directory (by default /usr/local/bin)
 */
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const MARKER = 'generated-by:helm/scripts/link-bins.mjs'

/** bin name → source code entry (each other for repository);helm-hub via scripts/run-hub.mjs inject dev path parse */
const BINS = {
  helm: 'packages/cli/src/index.ts',
  'helm-node': 'packages/node/src/cli.ts',
  'helm-hub': 'scripts/run-hub.mjs',
}

const removeMode = process.argv.includes('--remove')
if (process.platform === 'win32') {
  console.error('link-bins temporary unsupported Windows: use... instead npm link(bin points to dist/, change code after must pnpm build).')
  process.exit(1)
}

const binDir = process.env.HELM_BIN_DIR || '/usr/local/bin'
const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx')

if (!removeMode && !fs.existsSync(tsx)) {
  console.error(`not found tsx:${tsx}, please first in repository execute pnpm install.`)
  process.exit(1)
}
if (!fs.existsSync(binDir)) {
  console.error(`target directory missing:${binDir}(available HELM_BIN_DIR override).`)
  process.exit(1)
}

function wrapper(entry) {
  return [
    '#!/bin/sh',
    `# ${MARKER} - do not manually change; undo execute pnpm unlink:bins`,
    `exec "${tsx}" "${path.join(ROOT, entry)}" "$@"`,
    '',
  ].join('\n')
}

function npmLinkRemnant(p) {
  // npm link legacy:bin symlink or global node_modules in package symlink
  try {
    return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null
  } catch {
    return null
  }
}

function unlinkSyncSafe(p) {
  // delete symlink unify use unlink:fs.rmSync encounters points to directory symlink will mistakenly report ERR_FS_EISDIR
  try {
    fs.unlinkSync(p)
  } catch {}
}

function cleanNpmLinkLibRemnants() {
  // npm link will in <prefix>/lib/node_modules/@helm/<pkg> package symlink, one and clean (exhaust force while is)
  const nm = path.resolve(binDir, '..', 'lib', 'node_modules')
  for (const pkg of ['cli', 'node', 'kernel']) {
    const p = path.join(nm, '@helm', pkg)
    if (npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  clean up npm link legacy symlink ${p}`)
      const scopeDir = path.join(nm, '@helm')
      try {
        if (fs.readdirSync(scopeDir).length === 0) fs.rmdirSync(scopeDir)
      } catch {}
    }
  }
}

if (removeMode) {
  console.log(`remove ${Object.keys(BINS).join(' / ')}(${binDir})`)
  for (const name of Object.keys(BINS)) {
    const p = path.join(binDir, name)
    let content = ''
    try {
      content = fs.readFileSync(p, 'utf8')
    } catch {}
    if (content.includes(MARKER) || npmLinkRemnant(p)) {
      unlinkSyncSafe(p)
      console.log(`  already remove ${p}`)
    } else if (fs.existsSync(p)) {
      console.warn(`  skip ${p}: non- this script artifact, not motion`)
    }
  }
  cleanNpmLinkLibRemnants()
  console.log('complete.')
  process.exit(0)
}

console.log(`install development wrap script to ${binDir}(tsx direct run source code, change i.e. when takes effect):`)
for (const [name, entry] of Object.entries(BINS)) {
  const p = path.join(binDir, name)
  let st = null
  try {
    st = fs.lstatSync(p)
  } catch {}
  if (st && !st.isSymbolicLink()) {
    // already has ordinary file: only when is this script old artifact when override, otherwise explicit reject (may is other tool two enter system)
    if (!fs.readFileSync(p, 'utf8').includes(MARKER)) {
      console.error(`  reject override ${p}: already exists non- this script artifact file, please first human confirm.`)
      process.exit(1)
    }
  } else if (st) {
    // symlink (contains dangling):npm link legacy or old install, remove after heavy write
    unlinkSyncSafe(p)
  }
  fs.writeFileSync(p, wrapper(entry), { mode: 0o755 })
  fs.chmodSync(p, 0o755)
  console.log(`  ${name} -> ${entry}`)
}
cleanNpmLinkLibRemnants()

// self inspect:tsx store in and can start (--help fast smoke,helm-node same;helm-hub will true start kernel, only validate language method)
for (const name of ['helm', 'helm-node']) {
  try {
    execFileSync(path.join(binDir, name), ['--help'], { stdio: 'pipe', timeout: 60_000 })
    console.log(`  self inspect via:${name} --help`)
  } catch (err) {
    console.error(`  self inspect failed:${name} --help\n${err.stderr || err.message}`)
    process.exit(1)
  }
}
console.log('complete. undo execute pnpm unlink:bins.')
