/**
 * helm CLI wrap script (ensureCliBinDir + cli-shim pure function) test:
 * 1. POSIX host: generate original generate exec shim(and history output one by one byte consistent)+ 0o755;
 * 2. simulated win32 host(inject platform/execPath):helm is runtime parse shim
 *    (only convert node.exe, entry keep host path;wslpath takes precedence,cygpath fall back;
 *    failed explicit diagnose 127 exit, never fall back Linux node),helm.cmd and history output
 *    one by one byte consistent (contains % add multiple escaping);
 * 3. old script (contains history bug edition Windows direct exec script) by without condition heavy write; idempotent;
 * 4. shQuote embed sh after literal to return (space/single quotes/double quotes/backslash/$ etc.);
 * 5. generate win32 helm shim in Linux runner real execute (false wslpath/cygpath/
 *    false node, independent of real tool):wslpath succeeded,cygpath fall back, tool missing/
 *    output null value/result cannot execute when 127 + can read diagnose.
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
// test base seat
// ---------------------------------------------------------------------------

/** test use NodeManager(ensureCliBinDir only trigger reach dataDir/events, the rest dependency placement empty replace body). */
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
 * and ensureCliBinDir same source push lead when before repository shim plan:kernel test via tsx from
 * src run → useCompiled constant false → tsx entry (node-manager push lead in dist
 * runtime cut compiled entry, this where lock src form).
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

/** write a 0o755  POSIX shell false tool. */
async function writeTool(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

/** false wslpath/cygpath: record receives parameter,stdout output emit(default do not output any content). */
function pathToolBody(name: 'wslpath' | 'cygpath', emit?: string): string {
  return [
    `printf 'tool ${name}\\n' >> "$HELM_SHIM_RECORD"`,
    'for a in "$@"; do printf \'recv-tool %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
    ...(emit === undefined ? [] : [`printf '%s\\n' '${emit}'`]),
  ].join('\n')
}

/** false node: record $0 and all argv(verify shim after all unexpectedly exec what, parameter how pass-through). */
const FAKE_NODE_BODY = [
  'printf \'exec %s\\n\' "$0" >> "$HELM_SHIM_RECORD"',
  'for a in "$@"; do printf \'recv-node %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
].join('\n')

/** generate simulated win32 host  shim and return related path. */
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
// 1. POSIX host generate
// ---------------------------------------------------------------------------

test('POSIX host:helm is original generate exec shim(and history output one by one byte consistent,0o755), do not generate helm.cmd', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'posix-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const plan = currentRepoPlan()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // one by one byte lock: and history format (exec + single quotes path + "$@" pass-through) fully consistent.
    const expected = `#!/bin/sh\nexec ${[plan.execPath, ...plan.entryArgs].map(shQuote).join(' ')} "$@"\n`
    assert.equal(content, expected)
    assert.equal(content, buildPosixHostShim(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    assert.equal(manager.cliBinDir, join(dir, 'bin'))
    // POSIX host produces no helm.cmd.
    await assert.rejects(readFile(join(dir, 'bin', 'helm.cmd')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. simulated win32 host generate
// ---------------------------------------------------------------------------

test('simulated win32 host:helm is runtime parse shim(only convert node.exe; entry keep host path),helm.cmd and history output one by one byte consistent', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\helm space\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'win32-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const plan = currentRepoPlan({ execPath })
    const helm = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    assert.equal(helm, buildWindowsPosixShim(plan))
    assert.ok(helm.startsWith('#!/bin/sh\n'), 'must is POSIX sh script')
    // Windows node path single quotes security embed (contains space do not split term).
    assert.ok(helm.includes(`helm_node_win=${shQuote(execPath)}`))
    // wslpath takes precedence,cygpath fall back; only convert node path.
    assert.ok(helm.includes('wslpath -u "$helm_node_win"'))
    assert.ok(helm.includes('cygpath -u "$helm_node_win"'))
    // exec is convert result; entry parameter and user parameter original pass-through; failed explicit 127 exit.
    assert.ok(helm.includes('exec "$helm_node"'))
    assert.ok(helm.includes('"$@"'))
    assert.ok(helm.includes('exit 127'))
    for (const arg of plan.entryArgs) {
      assert.ok(helm.includes(shQuote(arg)), `entry parameter must original embed:${arg}`)
    }
    // does not fall back Linux node(do not appear bare node / env node invoke).
    assert.ok(!helm.includes('\nexec node '))
    assert.ok(!helm.includes('exec /usr/bin/env node'))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    // helm.cmd: and history output one by one byte consistent (contains space path quotes package wrap).
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

test('simulated win32 host:helm.cmd  % add multiple escaping do not regression', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\tools 100%\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'cmd-escape-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const cmd = await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8')
    assert.ok(cmd.includes('"C:\\tools 100%%\\node.exe"'), '% must add multiple is %%')
    assert.equal(cmd, buildWindowsCmdWrapper(currentRepoPlan({ execPath })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. old script heavy write and idempotent
// ---------------------------------------------------------------------------

test('old script heavy write: stale helm(contains history bug edition Windows direct exec script) and stale helm.cmd by without condition replace; idempotent', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'rewrite-'))
  try {
    await mkdir(join(dir, 'bin'), { recursive: true })
    // history bug edition:win32 Hub once Windows path directly write enter #!/bin/sh.
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
    assert.equal(helm, buildWindowsPosixShim(plan), 'old bug script must by new shim complete replace')
    assert.ok(!helm.includes('Old Node'), 'must not leftover old content')
    assert.equal(await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8'), buildWindowsCmdWrapper(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)

    // idempotent: again generate content do not change.
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    assert.equal(await readFile(join(dir, 'bin', 'helm'), 'utf8'), buildWindowsPosixShim(plan))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // POSIX branch same heavy write stale script and restore execute permission.
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
// 4. shQuote pure function: embed sh after literal to return
// ---------------------------------------------------------------------------

test('shQuote: embed sh after literal to return (space/single quotes/double quotes/backslash/$/number/newline/%)', { timeout: 60_000 }, async () => {
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
    assert.equal(stdout, `${value}\n`, `shQuote output via sh must literal to return:${JSON.stringify(value)}`)
  }
})

// ---------------------------------------------------------------------------
// 5. generate win32 helm shim real execute (Linux runner + false tool)
// ---------------------------------------------------------------------------

test('win32 helm shim execute:wslpath parse after success exec convert result;node path parameter and entry/user parameter one by one pass-through', { timeout: 60_000 }, async () => {
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
    // wslpath receives complete Windows node path (space keep, not split term, backslash original).
    assert.ok(lines.includes('tool wslpath'))
    assert.ok(lines.includes(`recv-tool ${execPath}`), `wslpath parameter must is complete Windows path:${execPath}`)
    // exec is convert result (fake node), entry and user parameter original pass-through.
    assert.ok(lines.includes(`exec ${fakeNode}`), 'must exec wslpath convert result')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[0]}`), 'entry parameter 1 original pass-through')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[1]}`), 'entry parameter 2 original pass-through')
    assert.ok(lines.includes('recv-node --version'))
    assert.ok(lines.includes('recv-node arg with space'))
    // wslpath after success no longer away cygpath.
    assert.ok(!lines.includes('tool cygpath'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execute:wslpath unavailable when cygpath fall back succeeded', { timeout: 60_000 }, async () => {
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
    assert.ok(lines.includes(`exec ${fakeNode}`), 'must exec cygpath convert result')
    assert.ok(!lines.includes('tool wslpath'), 'PATH without wslpath when must not invoke')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execute:wslpath/cygpath all missing when 127 exit and output can read diagnose', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const { dir, helm } = await prepareWin32Shim(execPath)
  try {
    const emptyDir = join(dir, 'empty-path')
    await mkdir(emptyDir, { recursive: true })
    await assert.rejects(
      run(helm, ['--version'], { env: { PATH: emptyDir } }),
      (error: unknown) => {
        const err = error as { code?: number | string; stderr?: string }
        assert.equal(err.code, 127, `exit code must is 127, got ${String(err.code)}`)
        assert.ok(err.stderr !== undefined && err.stderr.includes(execPath), 'diagnose must contains Windows node path')
        assert.ok(err.stderr !== undefined && err.stderr.includes('wslpath') && err.stderr.includes('cygpath'), 'diagnose must note attempt convert tool')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim execute: do not trust convert output - - null value and cannot execute result all 127 reject', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  // case A:wslpath succeeded exit but output is empty,cygpath missing.
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
          assert.equal(err.code, 127, 'empty output must reject execute')
          assert.ok(err.stderr !== undefined && err.stderr.length > 0, 'must output diagnose')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  // case B:wslpath output store in but cannot execute ordinary file path.
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
          assert.equal(err.code, 127, 'cannot execute result must reject execute')
          assert.ok(err.stderr !== undefined && err.stderr.includes('plain.txt'), 'diagnose must contains parse result path')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// 6. env inject (Electron host) and HELM_CLI_ENTRY explicit entry (install package payload layout)
// ---------------------------------------------------------------------------

test('env inject: three wrapper all with env/set inject ELECTRON_RUN_AS_NODE=1, without env when and history output consistent', { timeout: 60_000 }, () => {
  const base: CliShimPlan = { execPath: '/opt/electron/helm', entryArgs: ['/release/cli/dist/index.js'] }
  const withEnv: CliShimPlan = { ...base, env: { ELECTRON_RUN_AS_NODE: '1' } }

  // POSIX host:exec env 'K=V' - - via real /bin/sh verify inject takes effect and parameter pass-through do not change.
  const posix = buildPosixHostShim(withEnv)
  assert.equal(
    posix,
    `#!/bin/sh\nexec env 'ELECTRON_RUN_AS_NODE=1' '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`,
  )
  assert.equal(buildPosixHostShim(base), `#!/bin/sh\nexec '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`, 'without env when and history output one by one byte consistent')

  // Windows cmd:setlocal + set "K=V"(do not pollute person class cmd conversation); without env when and history output consistent.
  const cmd = buildWindowsCmdWrapper(withEnv)
  assert.equal(
    cmd,
    `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`,
  )
  assert.equal(buildWindowsCmdWrapper(base), `@echo off\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`, 'without env when and history output one by one byte consistent')

  // Windows POSIX shim(WSL/GitBash):exec env 'K=V' "$helm_node".
  const winPosix = buildWindowsPosixShim(withEnv)
  assert.ok(winPosix.includes(`exec env 'ELECTRON_RUN_AS_NODE=1' "$helm_node"`), 'must with env inject')
  assert.ok(!buildWindowsPosixShim(base).includes('exec env '), 'without env when must not appear env prefix')
})

test('env inject real execute:POSIX shim via /bin/sh takes effect (child process visible ELECTRON_RUN_AS_NODE=1)', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'env-real-'))
  try {
    // use node this body when "Electron":shim exec env ELECTRON_RUN_AS_NODE=1 node -e 'print env'
    const plan: CliShimPlan = {
      execPath: process.execPath,
      entryArgs: ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "<unset>")'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
    const shim = join(dir, 'helm')
    await writeFile(shim, buildPosixHostShim(plan), 'utf8')
    await chmod(shim, 0o755)
    // from a deliberately carries pollute value environment start, verify shim inside env override while non- inherit.
    const { stdout } = await run(shim, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: 'polluted' } })
    assert.equal(stdout, '1', 'shim must ELECTRON_RUN_AS_NODE=1 inject CLI child process')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HELM_CLI_ENTRY: explicit entry directly generate shim, does not repository on trace push lead; not settings when behavior do not change', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'explicit-entry-'))
  const entry = '/opt/helm-release/cli/dist/index.js'
  const prev = process.env.HELM_CLI_ENTRY
  try {
    process.env.HELM_CLI_ENTRY = entry
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // entry = explicit path single parameter; do not appear repository tsx/source code push import opening.
    assert.ok(content.includes(shQuote(entry)), 'shim must points to HELM_CLI_ENTRY')
    assert.ok(!content.includes('tsx'), 'explicit entry under must not appear repository tsx push lead')
    assert.ok(!content.includes('src/index.ts'), 'explicit entry under must not appear repository source code CLI push lead')
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
