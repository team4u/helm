/**
 * helm CLI shim wrapper tests (ensureCliBinDir + cli-shim pure helpers):
 * 1. POSIX host: generates native exec shim (byte-identical to historical format) + 0o755;
 * 2. Simulated win32 host (injected platform/execPath): `helm` is a runtime-resolving shim
 *    (converts node.exe only, keeps host path for entry; prefers wslpath with cygpath fallback;
 *    fails with diagnostic + exit 127 instead of falling back to Linux node), and `helm.cmd`
 *    matches historical output byte-for-byte (including doubled `%` escaping);
 * 3. Stale scripts (including old buggy Windows direct-exec script) are unconditionally overwritten; idempotent;
 * 4. shQuote round-trips verbatim through /bin/sh (spaces / single quotes / double quotes / backslashes / `$` etc.);
 * 5. Generated win32 `helm` shim executes live on Linux runner (fake wslpath/cygpath/node without external tools):
 *    wslpath succeeds, cygpath fallback works, missing tools / empty stdout / non-executable target exit 127 cleanly.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeManager, buildPosixHostShim, buildWindowsCmdWrapper, buildWindowsPosixShim, shQuote, type CliShimPlan } from '../src/runtime/index.js'

const run = promisify(execFile)

let rootDir: string

test('setup: create temporary directory', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-cli-shim-'))
})

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

/** NodeManager fixture for tests (ensureCliBinDir only touches dataDir/events; other deps stubbed). */
function makeManager(dataDir: string): NodeManager {
  return new NodeManager({
    dataDir,
    envFabric: {} as never,
    configSvc: {} as never,
    stash: {} as never,
    toolDeps: {} as never,
    events: { publish: () => undefined } as never,
    nodeUpgradeTimeoutMs: 1_000,
    convOf: () => ({ cwd: dataDir }),
  })
}

/**
 * In-repo shim plan matching ensureCliBinDir's resolution: kernel tests run via tsx from src,
 * so useCompiled is always false -> tsx entrypoint (node-manager swaps to compiled entry in dist at runtime;
 * this test locks the src layout).
 */
function currentRepoPlan(override: Partial<CliShimPlan> = {}): CliShimPlan {
  const kernelDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src/runtime')
  const repoRoot = dirname(dirname(dirname(dirname(kernelDir))))
  return {
    execPath: override.execPath ?? process.execPath,
    entryArgs: override.entryArgs ?? [
      join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      join(repoRoot, 'packages', 'cli', 'src', 'index.ts'),
    ],
  }
}

/** Writes an executable (0o755) fake POSIX shell tool. */
async function writeTool(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

/** Fake wslpath/cygpath: logs received args and prints emit to stdout (nothing by default). */
function pathToolBody(name: 'wslpath' | 'cygpath', emit?: string): string {
  return [
    `printf 'tool ${name}\\n' >> "$HELM_SHIM_RECORD"`,
    'for a in "$@"; do printf \'recv-tool %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
    ...(emit === undefined ? [] : [`printf '%s\\n' '${emit}'`]),
  ].join('\n')
}

/** Fake node: logs $0 and all argv (verifies exact binary exec'd and argument forwarding). */
const FAKE_NODE_BODY = [
  'printf \'exec %s\\n\' "$0" >> "$HELM_SHIM_RECORD"',
  'for a in "$@"; do printf \'recv-node %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
].join('\n')

/** Generates shims for a simulated win32 host and returns relevant paths. */
async function prepareWin32Shim(execPath: string): Promise<{ dir: string; helm: string; plan: CliShimPlan }> {
  const dir = await mkdtemp(join(rootDir, 'shim-'))
  const manager = makeManager(dir)
  await manager.ensureCliBinDir({ platform: 'win32', execPath })
  return { dir, helm: join(dir, 'bin', 'helm'), plan: currentRepoPlan({ execPath }) }
}

async function readLines(path: string): Promise<string[]> {
  return (await readFile(path, 'utf8')).split('\n')
}

// ---------------------------------------------------------------------------
// 1. POSIX host generation
// ---------------------------------------------------------------------------

test('POSIX host: helm is a direct exec shim (byte-identical to legacy, 0o755) with no helm.cmd', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'posix-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const plan = currentRepoPlan()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // Byte-for-byte lock: matches legacy format (exec + single-quoted paths + "$@" passthrough).
    const expected = `#!/bin/sh\nexec ${[plan.execPath, ...plan.entryArgs].map(shQuote).join(' ')} "$@"\n`
    assert.equal(content, expected)
    assert.equal(content, buildPosixHostShim(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    assert.equal(manager.cliBinDir, join(dir, 'bin'))
    // No helm.cmd emitted on POSIX hosts.
    await assert.rejects(readFile(join(dir, 'bin', 'helm.cmd')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. Simulated win32 host generation
// ---------------------------------------------------------------------------

test('simulated win32 host: helm resolves runtime node.exe (keeps host paths for entry); helm.cmd matches legacy byte-for-byte', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\helm space\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'win32-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const plan = currentRepoPlan({ execPath })
    const helm = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    assert.equal(helm, buildWindowsPosixShim(plan))
    assert.ok(helm.startsWith('#!/bin/sh\n'), 'must be a POSIX sh script')
    // Windows node path single-quoted safely (spaces never split tokens).
    assert.ok(helm.includes(`helm_node_win=${shQuote(execPath)}`))
    // Prefers wslpath with cygpath fallback; converts node path only.
    assert.ok(helm.includes('wslpath -u "$helm_node_win"'))
    assert.ok(helm.includes('cygpath -u "$helm_node_win"'))
    // exec uses converted binary; entry args and user args pass through untouched; failure exits 127.
    assert.ok(helm.includes('exec "$helm_node"'))
    assert.ok(helm.includes('"$@"'))
    assert.ok(helm.includes('exit 127'))
    for (const arg of plan.entryArgs) {
      assert.ok(helm.includes(shQuote(arg)), `entry argument must be embedded verbatim: ${arg}`)
    }
    // Never falls back to Linux node (no bare `node` or `/usr/bin/env node`).
    assert.ok(!helm.includes('\nexec node '))
    assert.ok(!helm.includes('exec /usr/bin/env node'))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    // helm.cmd: byte-identical to legacy format (quoted spaced paths).
    const cmd = await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8')
    const cmdArgs = [execPath, ...plan.entryArgs]
      .map((value) => `"${value.replaceAll('%', '%%')}"`)
      .join(' ')
    assert.equal(cmd, `@echo off\r\n${cmdArgs} %*\r\n`)
    assert.equal(cmd, buildWindowsCmdWrapper(plan))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('simulated win32 host: % doubling escape in helm.cmd never regresses', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\tools 100%\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'cmd-escape-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const cmd = await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8')
    assert.ok(cmd.includes('"C:\\tools 100%%\\node.exe"'), '% must be doubled as %%')
    assert.equal(cmd, buildWindowsCmdWrapper(currentRepoPlan({ execPath })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. Stale script overwrite and idempotence
// ---------------------------------------------------------------------------

test('stale script overwrite: unconditionally replaces stale helm (including legacy buggy Windows exec script) and helm.cmd; idempotent', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'rewrite-'))
  try {
    await mkdir(join(dir, 'bin'), { recursive: true })
    // Legacy buggy version: win32 Hub previously wrote raw Windows path directly into #!/bin/sh.
    await writeFile(
      join(dir, 'bin', 'helm'),
      `#!/bin/sh\nexec 'C:\\\\Old Node\\node.exe' 'C:\\\\Old\\cli\\index.js' "$@"\n`,
      'utf8',
    )
    await writeFile(join(dir, 'bin', 'helm.cmd'), '@echo off\r\nstale\r\n', 'utf8')

    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const plan = currentRepoPlan({ execPath })
    const helm = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    assert.equal(helm, buildWindowsPosixShim(plan), 'stale buggy script must be completely replaced by new shim')
    assert.ok(!helm.includes('Old Node'), 'no legacy content should remain')
    assert.equal(await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8'), buildWindowsCmdWrapper(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)

    // Idempotent: re-generating leaves file identical.
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    assert.equal(await readFile(join(dir, 'bin', 'helm'), 'utf8'), buildWindowsPosixShim(plan))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // POSIX branch also overwrites stale scripts and restores executable bit.
  const posixDir = await mkdtemp(join(rootDir, 'rewrite-posix-'))
  try {
    await mkdir(join(posixDir, 'bin'), { recursive: true })
    await writeFile(join(posixDir, 'bin', 'helm'), '#!/bin/sh\nexec /stale/helm "$@"\n', 'utf8')
    await chmod(join(posixDir, 'bin', 'helm'), 0o644)
    const manager = makeManager(posixDir)
    await manager.ensureCliBinDir()
    assert.equal(await readFile(join(posixDir, 'bin', 'helm'), 'utf8'), buildPosixHostShim(currentRepoPlan()))
    assert.equal((await stat(join(posixDir, 'bin', 'helm'))).mode & 0o777, 0o755)
  } finally {
    await rm(posixDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. shQuote pure helper: round-trips verbatim through sh
// ---------------------------------------------------------------------------

test('shQuote: round-trips verbatim through sh (spaces / single quotes / double quotes / backslashes / $ / symbols / newlines / %)', { timeout: 60_000 }, async () => {
  const samples = [
    'C:\\Program Files\\helm\\node.exe',
    "it's",
    'a"b',
    'back\\slash',
    '$HOME `cmd` $(pwd)',
    'semi;colon|pipe&bg&',
    'line1\nline2',
    '100%',
  ]
  for (const value of samples) {
    const { stdout } = await run('/bin/sh', ['-c', `printf '%s\n' ${shQuote(value)}`])
    assert.equal(stdout, `${value}\n`, `shQuote output must round-trip verbatim through sh: ${JSON.stringify(value)}`)
  }
})

// ---------------------------------------------------------------------------
// 5. Real execution of generated win32 helm shim (Linux runner + fake tools)
// ---------------------------------------------------------------------------

test('win32 helm shim execution: executes wslpath result cleanly; node path and entry/user args pass through verbatim', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\helm space\\node.exe'
  const { dir, helm, plan } = await prepareWin32Shim(execPath)
  try {
    const toolsDir = join(dir, 'tools')
    await mkdir(toolsDir, { recursive: true })
    const fakeNode = join(dir, 'fake-node')
    await writeTool(dir, 'fake-node', FAKE_NODE_BODY)
    await writeTool(toolsDir, 'wslpath', pathToolBody('wslpath', fakeNode))
    const record = join(dir, 'record.log')
    await run(helm, ['--version', 'arg with space'], {
      env: { PATH: toolsDir, HELM_SHIM_RECORD: record },
    })
    const lines = await readLines(record)
    // wslpath receives full Windows node path (spaces preserved without splitting, backslashes verbatim).
    assert.ok(lines.includes('tool wslpath'))
    assert.ok(lines.includes(`recv-tool ${execPath}`), `wslpath argument must be complete Windows path: ${execPath}`)
    // exec uses converted target (fake node); entry args and user args pass through untouched.
    assert.ok(lines.includes(`exec ${fakeNode}`), 'must exec converted wslpath result')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[0]}`), 'entry argument 1 passed verbatim')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[1]}`), 'entry argument 2 passed verbatim')
    assert.ok(lines.includes('recv-node --version'))
    assert.ok(lines.includes('recv-node arg with space'))
    // Skips cygpath once wslpath succeeds.
    assert.ok(!lines.includes('tool cygpath'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execution: falls back to cygpath cleanly when wslpath is unavailable', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const { dir, helm } = await prepareWin32Shim(execPath)
  try {
    const toolsDir = join(dir, 'tools')
    await mkdir(toolsDir, { recursive: true })
    const fakeNode = join(dir, 'fake-node')
    await writeTool(dir, 'fake-node', FAKE_NODE_BODY)
    await writeTool(toolsDir, 'cygpath', pathToolBody('cygpath', fakeNode))
    const record = join(dir, 'record.log')
    await run(helm, ['--version'], { env: { PATH: toolsDir, HELM_SHIM_RECORD: record } })
    const lines = await readLines(record)
    assert.ok(lines.includes('tool cygpath'))
    assert.ok(lines.includes(`exec ${fakeNode}`), 'must exec converted cygpath result')
    assert.ok(!lines.includes('tool wslpath'), 'must not invoke wslpath when absent from PATH')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execution: exits 127 with readable diagnostics when both wslpath and cygpath are missing', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const { dir, helm } = await prepareWin32Shim(execPath)
  try {
    const emptyDir = join(dir, 'empty-path')
    await mkdir(emptyDir, { recursive: true })
    await assert.rejects(
      run(helm, ['--version'], { env: { PATH: emptyDir } }),
      (error: unknown) => {
        const err = error as { code?: number | string; stderr?: string }
        assert.equal(err.code, 127, `exit code must be 127, got ${String(err.code)}`)
        assert.ok(err.stderr !== undefined && err.stderr.includes(execPath), 'diagnostics must include Windows node path')
        assert.ok(err.stderr !== undefined && err.stderr.includes('wslpath') && err.stderr.includes('cygpath'), 'diagnostics must list attempted converters')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execution: rejects untrusted converter outputs (empty stdout or non-executable file) with exit 127', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  // Case A: wslpath exits zero with empty stdout, cygpath missing.
  {
    const { dir, helm } = await prepareWin32Shim(execPath)
    try {
      const toolsDir = join(dir, 'tools')
      await mkdir(toolsDir, { recursive: true })
      await writeTool(toolsDir, 'wslpath', pathToolBody('wslpath'))
      await assert.rejects(
        run(helm, ['--version'], { env: { PATH: toolsDir, HELM_SHIM_RECORD: join(dir, 'record.log') } }),
        (error: unknown) => {
          const err = error as { code?: number | string; stderr?: string }
          assert.equal(err.code, 127, 'empty output must abort execution')
          assert.ok(err.stderr !== undefined && err.stderr.length > 0, 'must print diagnostics')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  // Case B: wslpath returns an existing non-executable plain file path.
  {
    const { dir, helm } = await prepareWin32Shim(execPath)
    try {
      const toolsDir = join(dir, 'tools')
      await mkdir(toolsDir, { recursive: true })
      const plain = join(toolsDir, 'plain.txt')
      await writeFile(plain, 'not executable\n', 'utf8')
      await chmod(plain, 0o644)
      await writeTool(toolsDir, 'wslpath', pathToolBody('wslpath', plain))
      await assert.rejects(
        run(helm, ['--version'], { env: { PATH: toolsDir, HELM_SHIM_RECORD: join(dir, 'record.log') } }),
        (error: unknown) => {
          const err = error as { code?: number | string; stderr?: string }
          assert.equal(err.code, 127, 'non-executable result must abort execution')
          assert.ok(err.stderr !== undefined && err.stderr.includes('plain.txt'), 'diagnostics must include resolved path')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// 6. Env injection (Electron host) and HELM_CLI_ENTRY explicit entrypoint (packaged app layout)
// ---------------------------------------------------------------------------

test('env injection: all three wrappers inject ELECTRON_RUN_AS_NODE=1 via env/set while preserving legacy output when unset', { timeout: 60_000 }, () => {
  const base: CliShimPlan = { execPath: '/opt/electron/helm', entryArgs: ['/release/cli/dist/index.js'] }
  const withEnv: CliShimPlan = { ...base, env: { ELECTRON_RUN_AS_NODE: '1' } }

  // POSIX host: `exec env 'K=V'` -- verified via /bin/sh to inject env without altering argument forwarding.
  const posix = buildPosixHostShim(withEnv)
  assert.equal(
    posix,
    `#!/bin/sh\nexec env 'ELECTRON_RUN_AS_NODE=1' '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`,
  )
  assert.equal(buildPosixHostShim(base), `#!/bin/sh\nexec '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`, 'byte-identical to legacy output when env omitted')

  // Windows cmd: setlocal + set "K=V" (avoids polluting caller cmd session); byte-identical to legacy output when unset.
  const cmd = buildWindowsCmdWrapper(withEnv)
  assert.equal(
    cmd,
    `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`,
  )
  assert.equal(buildWindowsCmdWrapper(base), `@echo off\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`, 'byte-identical to legacy output when env omitted')

  // Windows POSIX shim (WSL/Git Bash): `exec env 'K=V' "$helm_node"`.
  const winPosix = buildWindowsPosixShim(withEnv)
  assert.ok(winPosix.includes(`exec env 'ELECTRON_RUN_AS_NODE=1' "$helm_node"`), 'must inject env')
  assert.ok(!buildWindowsPosixShim(base).includes('exec env '), 'must omit env prefix when no env is configured')
})

test('env injection live execution: POSIX shim takes effect via /bin/sh (child sees ELECTRON_RUN_AS_NODE=1)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'env-real-'))
  try {
    // Use node binary itself as stand-in "Electron": shim runs env ELECTRON_RUN_AS_NODE=1 node -e 'print env'
    const plan: CliShimPlan = {
      execPath: process.execPath,
      entryArgs: ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "<unset>")'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
    const shim = join(dir, 'helm')
    await writeFile(shim, buildPosixHostShim(plan), 'utf8')
    await chmod(shim, 0o755)
    // Launch from a deliberately polluted environment to verify shim overrides rather than inherits it.
    const { stdout } = await run(shim, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: 'polluted' } })
    assert.equal(stdout, '1', 'shim must inject ELECTRON_RUN_AS_NODE=1 into CLI child process')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HELM_CLI_ENTRY: generates shim directly from explicit entrypoint without probing repo tree; preserves default when unset', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'explicit-entry-'))
  const entry = '/opt/helm-release/cli/dist/index.js'
  const prev = process.env.HELM_CLI_ENTRY
  try {
    process.env.HELM_CLI_ENTRY = entry
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // entryArgs contains the explicit path alone, free of repo tsx/source probes.
    assert.ok(content.includes(shQuote(entry)), 'shim must point to HELM_CLI_ENTRY')
    assert.ok(!content.includes('tsx'), 'explicit entrypoint must not probe repo tsx')
    assert.ok(!content.includes('src/index.ts'), 'explicit entrypoint must not probe repo CLI sources')
    assert.equal(content, buildPosixHostShim({ execPath: process.execPath, entryArgs: [entry] }))
  } finally {
    if (prev === undefined) delete process.env.HELM_CLI_ENTRY
    else process.env.HELM_CLI_ENTRY = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('teardown: clean up temporary directory', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
