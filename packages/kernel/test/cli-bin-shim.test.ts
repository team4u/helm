/**
 * helm CLI 包装脚本（ensureCliBinDir + cli-shim 纯函数）测试：
 * 1. POSIX host：生成原生 exec shim（与历史输出逐字节一致）+ 0o755；
 * 2. 模拟 win32 host（注入 platform/execPath）：helm 为运行时解析 shim
 *    （仅转换 node.exe，入口保持宿主路径；wslpath 优先、cygpath 兜底；
 *    失败显式诊断 127 退出，绝不回退 Linux node），helm.cmd 与历史输出
 *    逐字节一致（含 % 加倍转义）；
 * 3. 旧脚本（含历史 bug 版 Windows 直 exec 脚本）被无条件重写；幂等；
 * 4. shQuote 嵌入 sh 后字面往返（空格/单引号/双引号/反斜杠/$ 等）；
 * 5. 生成的 win32 helm shim 在 Linux runner 真实执行（假 wslpath/cygpath/
 *    假 node，不依赖真实工具）：wslpath 成功、cygpath 兜底、工具缺失/
 *    输出空值/结果不可执行时 127 + 可读诊断。
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

test('setup: 创建临时根目录', { timeout: 60_000 }, () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-cli-shim-'))
})

// ---------------------------------------------------------------------------
// 测试基座
// ---------------------------------------------------------------------------

/** 测试用 NodeManager（ensureCliBinDir 仅触达 dataDir/events，其余依赖置空替身）。 */
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
 * 与 ensureCliBinDir 同源推导当前仓库的 shim 计划：kernel 测试经 tsx 从
 * src 运行 → useCompiled 恒 false → tsx 入口（node-manager 的推导在 dist
 * 运行时切 compiled 入口，此处锁定 src 形态）。
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

/** 写一个 0o755 的 POSIX shell 假工具。 */
async function writeTool(dir: string, name: string, body: string): Promise<void> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`, 'utf8')
  await chmod(path, 0o755)
}

/** 假 wslpath/cygpath：记录收到的参数，stdout 输出 emit（缺省不输出任何内容）。 */
function pathToolBody(name: 'wslpath' | 'cygpath', emit?: string): string {
  return [
    `printf 'tool ${name}\\n' >> "$HELM_SHIM_RECORD"`,
    'for a in "$@"; do printf \'recv-tool %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
    ...(emit === undefined ? [] : [`printf '%s\\n' '${emit}'`]),
  ].join('\n')
}

/** 假 node：记录 $0 与全部 argv（验证 shim 究竟 exec 了什么、参数如何透传）。 */
const FAKE_NODE_BODY = [
  'printf \'exec %s\\n\' "$0" >> "$HELM_SHIM_RECORD"',
  'for a in "$@"; do printf \'recv-node %s\\n\' "$a" >> "$HELM_SHIM_RECORD"; done',
].join('\n')

/** 生成模拟 win32 host 的 shim 并返回相关路径。 */
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
// 1. POSIX host 生成
// ---------------------------------------------------------------------------

test('POSIX host：helm 为原生 exec shim（与历史输出逐字节一致，0o755），不生成 helm.cmd', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'posix-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const plan = currentRepoPlan()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // 逐字节锁定：与历史格式（exec + 单引号路径 + "$@" 透传）完全一致。
    const expected = `#!/bin/sh\nexec ${[plan.execPath, ...plan.entryArgs].map(shQuote).join(' ')} "$@"\n`
    assert.equal(content, expected)
    assert.equal(content, buildPosixHostShim(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    assert.equal(manager.cliBinDir, join(dir, 'bin'))
    // POSIX host 不产生 helm.cmd。
    await assert.rejects(readFile(join(dir, 'bin', 'helm.cmd')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 2. 模拟 win32 host 生成
// ---------------------------------------------------------------------------

test('模拟 win32 host：helm 为运行时解析 shim（仅转换 node.exe；入口保持宿主路径），helm.cmd 与历史输出逐字节一致', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\helm space\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'win32-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const plan = currentRepoPlan({ execPath })
    const helm = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    assert.equal(helm, buildWindowsPosixShim(plan))
    assert.ok(helm.startsWith('#!/bin/sh\n'), '须为 POSIX sh 脚本')
    // Windows node 路径单引号安全嵌入（含空格不拆词）。
    assert.ok(helm.includes(`helm_node_win=${shQuote(execPath)}`))
    // wslpath 优先、cygpath 兜底；仅转换 node 路径。
    assert.ok(helm.includes('wslpath -u "$helm_node_win"'))
    assert.ok(helm.includes('cygpath -u "$helm_node_win"'))
    // exec 的是转换结果；入口参数与用户参数原样透传；失败显式 127 退出。
    assert.ok(helm.includes('exec "$helm_node"'))
    assert.ok(helm.includes('"$@"'))
    assert.ok(helm.includes('exit 127'))
    for (const arg of plan.entryArgs) {
      assert.ok(helm.includes(shQuote(arg)), `入口参数须原样嵌入：${arg}`)
    }
    // 不回退 Linux node（不出现裸 node / env node 调用）。
    assert.ok(!helm.includes('\nexec node '))
    assert.ok(!helm.includes('exec /usr/bin/env node'))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)
    // helm.cmd：与历史输出逐字节一致（含空格路径的引号包裹）。
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

test('模拟 win32 host：helm.cmd 的 % 加倍转义不回归', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\tools 100%\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'cmd-escape-'))
  try {
    const manager = makeManager(dir)
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    const cmd = await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8')
    assert.ok(cmd.includes('"C:\\tools 100%%\\node.exe"'), '% 须加倍为 %%')
    assert.equal(cmd, buildWindowsCmdWrapper(currentRepoPlan({ execPath })))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. 旧脚本重写与幂等
// ---------------------------------------------------------------------------

test('旧脚本重写：陈旧 helm（含历史 bug 版 Windows 直 exec 脚本）与陈旧 helm.cmd 被无条件替换；幂等', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const dir = await mkdtemp(join(rootDir, 'rewrite-'))
  try {
    await mkdir(join(dir, 'bin'), { recursive: true })
    // 历史 bug 版：win32 Hub 曾把 Windows 路径直接写进 #!/bin/sh。
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
    assert.equal(helm, buildWindowsPosixShim(plan), '旧 bug 脚本必须被新 shim 完整替换')
    assert.ok(!helm.includes('Old Node'), '不得残留旧内容')
    assert.equal(await readFile(join(dir, 'bin', 'helm.cmd'), 'utf8'), buildWindowsCmdWrapper(plan))
    assert.equal((await stat(join(dir, 'bin', 'helm'))).mode & 0o777, 0o755)

    // 幂等：再次生成内容不变。
    await manager.ensureCliBinDir({ platform: 'win32', execPath })
    assert.equal(await readFile(join(dir, 'bin', 'helm'), 'utf8'), buildWindowsPosixShim(plan))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  // POSIX 分支同样重写陈旧脚本并恢复执行权限。
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
// 4. shQuote 纯函数：嵌入 sh 后字面往返
// ---------------------------------------------------------------------------

test('shQuote：嵌入 sh 后字面往返（空格/单引号/双引号/反斜杠/$/分号/换行/%）', { timeout: 60_000 }, async () => {
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
    assert.equal(stdout, `${value}\n`, `shQuote 输出经 sh 须字面往返：${JSON.stringify(value)}`)
  }
})

// ---------------------------------------------------------------------------
// 5. 生成的 win32 helm shim 真实执行（Linux runner + 假工具）
// ---------------------------------------------------------------------------

test('win32 helm shim 执行：wslpath 解析成功后 exec 转换结果；node 路径参数与入口/用户参数逐个透传', { timeout: 60_000 }, async () => {
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
    // wslpath 收到完整 Windows node 路径（空格保留、未拆词、反斜杠原样）。
    assert.ok(lines.includes('tool wslpath'))
    assert.ok(lines.includes(`recv-tool ${execPath}`), `wslpath 参数须为完整 Windows 路径：${execPath}`)
    // exec 的是转换结果（fake node），入口与用户参数原样透传。
    assert.ok(lines.includes(`exec ${fakeNode}`), '须 exec wslpath 转换结果')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[0]}`), '入口参数 1 原样透传')
    assert.ok(lines.includes(`recv-node ${plan.entryArgs[1]}`), '入口参数 2 原样透传')
    assert.ok(lines.includes('recv-node --version'))
    assert.ok(lines.includes('recv-node arg with space'))
    // wslpath 成功后不再走 cygpath。
    assert.ok(!lines.includes('tool cygpath'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim 执行：wslpath 不可用时 cygpath 兜底成功', { timeout: 60_000 }, async () => {
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
    assert.ok(lines.includes(`exec ${fakeNode}`), '须 exec cygpath 转换结果')
    assert.ok(!lines.includes('tool wslpath'), 'PATH 无 wslpath 时不得调用')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim 执行：wslpath/cygpath 均缺失时 127 退出并输出可读诊断', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  const { dir, helm } = await prepareWin32Shim(execPath)
  try {
    const emptyDir = join(dir, 'empty-path')
    await mkdir(emptyDir, { recursive: true })
    await assert.rejects(
      run(helm, ['--version'], { env: { PATH: emptyDir } }),
      (error: unknown) => {
        const err = error as { code?: number | string; stderr?: string }
        assert.equal(err.code, 127, `退出码须为 127，实得 ${String(err.code)}`)
        assert.ok(err.stderr !== undefined && err.stderr.includes(execPath), '诊断须含 Windows node 路径')
        assert.ok(err.stderr !== undefined && err.stderr.includes('wslpath') && err.stderr.includes('cygpath'), '诊断须说明尝试过的转换工具')
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('win32 helm shim 执行：不信任转换输出——空值与不可执行结果均 127 拒绝', { timeout: 60_000 }, async () => {
  const execPath = 'C:\\Program Files\\nodejs\\node.exe'
  // 情形 A：wslpath 成功退出但输出为空，cygpath 缺失。
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
          assert.equal(err.code, 127, '空输出须拒绝执行')
          assert.ok(err.stderr !== undefined && err.stderr.length > 0, '须输出诊断')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
  // 情形 B：wslpath 输出存在但不可执行的普通文件路径。
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
          assert.equal(err.code, 127, '不可执行结果须拒绝执行')
          assert.ok(err.stderr !== undefined && err.stderr.includes('plain.txt'), '诊断须含解析结果路径')
          return true
        },
      )
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

// ---------------------------------------------------------------------------
// 6. env 注入（Electron 宿主）与 HELM_CLI_ENTRY 显式入口（安装包 payload 布局）
// ---------------------------------------------------------------------------

test('env 注入：三种 wrapper 均以 env/set 注入 ELECTRON_RUN_AS_NODE=1，无 env 时与历史输出一致', { timeout: 60_000 }, () => {
  const base: CliShimPlan = { execPath: '/opt/electron/helm', entryArgs: ['/release/cli/dist/index.js'] }
  const withEnv: CliShimPlan = { ...base, env: { ELECTRON_RUN_AS_NODE: '1' } }

  // POSIX host：exec env 'K=V' —— 经真实 /bin/sh 验证注入生效且参数透传不变。
  const posix = buildPosixHostShim(withEnv)
  assert.equal(
    posix,
    `#!/bin/sh\nexec env 'ELECTRON_RUN_AS_NODE=1' '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`,
  )
  assert.equal(buildPosixHostShim(base), `#!/bin/sh\nexec '/opt/electron/helm' '/release/cli/dist/index.js' "$@"\n`, '无 env 时与历史输出逐字节一致')

  // Windows cmd：setlocal + set "K=V"（不污染人类 cmd 会话）；无 env 时与历史输出一致。
  const cmd = buildWindowsCmdWrapper(withEnv)
  assert.equal(
    cmd,
    `@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`,
  )
  assert.equal(buildWindowsCmdWrapper(base), `@echo off\r\n"/opt/electron/helm" "/release/cli/dist/index.js" %*\r\n`, '无 env 时与历史输出逐字节一致')

  // Windows POSIX shim（WSL/GitBash）：exec env 'K=V' "$helm_node"。
  const winPosix = buildWindowsPosixShim(withEnv)
  assert.ok(winPosix.includes(`exec env 'ELECTRON_RUN_AS_NODE=1' "$helm_node"`), '须以 env 注入')
  assert.ok(!buildWindowsPosixShim(base).includes('exec env '), '无 env 时不得出现 env 前缀')
})

test('env 注入真实执行：POSIX shim 经 /bin/sh 生效（子进程可见 ELECTRON_RUN_AS_NODE=1）', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'env-real-'))
  try {
    // 用 node 本体当“Electron”：shim exec env ELECTRON_RUN_AS_NODE=1 node -e 'print env'
    const plan: CliShimPlan = {
      execPath: process.execPath,
      entryArgs: ['-e', 'process.stdout.write(process.env.ELECTRON_RUN_AS_NODE ?? "<unset>")'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
    const shim = join(dir, 'helm')
    await writeFile(shim, buildPosixHostShim(plan), 'utf8')
    await chmod(shim, 0o755)
    // 从一个故意带污染值的环境启动，验证 shim 内 env 覆盖而非继承。
    const { stdout } = await run(shim, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: 'polluted' } })
    assert.equal(stdout, '1', 'shim 必须把 ELECTRON_RUN_AS_NODE=1 注入 CLI 子进程')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('HELM_CLI_ENTRY：显式入口直接生成 shim，不做仓库上溯推导；未设置时行为不变', { timeout: 60_000 }, async () => {
  const dir = await mkdtemp(join(rootDir, 'explicit-entry-'))
  const entry = '/opt/helm-release/cli/dist/index.js'
  const prev = process.env.HELM_CLI_ENTRY
  try {
    process.env.HELM_CLI_ENTRY = entry
    const manager = makeManager(dir)
    await manager.ensureCliBinDir()
    const content = await readFile(join(dir, 'bin', 'helm'), 'utf8')
    // 入口 = 显式路径单参数；不出现仓库 tsx/源码推导入口。
    assert.ok(content.includes(shQuote(entry)), 'shim 须指向 HELM_CLI_ENTRY')
    assert.ok(!content.includes('tsx'), '显式入口下不得出现仓库 tsx 推导')
    assert.ok(!content.includes('src/index.ts'), '显式入口下不得出现仓库源码 CLI 推导')
    assert.equal(content, buildPosixHostShim({ execPath: process.execPath, entryArgs: [entry] }))
  } finally {
    if (prev === undefined) delete process.env.HELM_CLI_ENTRY
    else process.env.HELM_CLI_ENTRY = prev
    await rm(dir, { recursive: true, force: true })
  }
})

test('teardown: 清理临时根目录', { timeout: 60_000 }, () => {
  rmSync(rootDir, { recursive: true, force: true })
})
