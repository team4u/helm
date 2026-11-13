/**
 * 目标节点平台感知的 cwd/path 规范化测试（kernel 执行链）。
 *
 * 覆盖（对齐任务验收面）：
 * 1. 平台选择：local 恒 process.platform；远端仅取 NodeRegistry 注册登记
 *    平台（EnvFabric.nodePlatformOf 最小只读端口，真实 WS 注册链验证）；
 *    离线 / 未上报平台 → 平台未知，绝不猜、绝不 fallback Hub 宿主。
 * 2. win32 目标视图转换：/mnt/<盘符>（WSL 挂载）与 /<盘符>（Git Bash）
 *    转规范 Windows 路径；/home 等裸 POSIX 根显式 invalid_path（保留原始
 *    路径，绝不猜测）。
 * 3. read 与 bash 一致：同一会话靶点下文件工具与 runShell 用同一平台来源
 *    与同一 protocol 原语规范化（收到相同基准派生的路径）。
 * 4. 远端 POSIX 节点绝不被误判成 Windows：/mnt/d 在 POSIX 目标上是真实
 *    路径，原样透传（仅词法归一）。
 * 5. POST /api/env/exec 靶点解析（NodeManager.resolveExecTarget）：win32
 *    目标规范化、裸 POSIX 根 validation_error（含原始 cwd）、离线 409、
 *    平台未知原样透传。
 */

import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import type { NodeRegisterInput, NodeRegisterResult } from '@helm/protocol'
import type { HubConnectionLocal } from '../src/env/registry.js'
import { attachNodeWsGateway, createEnvFabric, type EnvFabric } from '../src/env/index.js'
import {
  createReadTool,
  createEditTool,
  createWriteTool,
  resolveTargetPath,
  runShell,
} from '../src/runtime/tools.js'
import {
  normalizePathForTarget,
  targetPlatformForNode,
} from '../src/runtime/target-platform.js'
import { NodeManager } from '../src/runtime/node-manager.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import { ArtifactService, InMemoryArtifactRepository, SecretStash, ensureDataDir } from '../src/services/index.js'
import { HelmError } from '@helm/protocol'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-target-platform-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 受控替身
// ---------------------------------------------------------------------------

/** runShell 用受控 shell env：只实现 exec，记录真实收到的 cwd。 */
function makeRecordingShellEnv(): {
  env: {
    id: string
    exec(
      command: string | readonly string[],
      options: { cwd?: string; env?: Record<string, string>; inheritEnv?: boolean } | undefined,
      context: Context,
    ): Promise<{ ok: true; value: { exitCode: number } }>
  }
  execCalls: Array<{ command: string | readonly string[]; cwd?: string }>
} {
  const execCalls: Array<{ command: string | readonly string[]; cwd?: string }> = []
  return {
    execCalls,
    env: {
      id: 'remote:rec-node',
      async exec(command, options) {
        execCalls.push({ command, cwd: options?.cwd })
        return { ok: true, value: { exitCode: 0 } }
      },
    },
  }
}

/** read/write/edit 用受控文件 env（含互斥队列所需最小面）。 */
function makeRecordingFileEnv(files: Map<string, string>): {
  env: Record<string, unknown>
  calls: Array<{ method: string; path: string }>
} {
  const calls: Array<{ method: string; path: string }> = []
  const record = (method: string, path: string): void => {
    calls.push({ method, path })
  }
  return {
    calls,
    env: {
      id: 'remote:rec-file-node',
      async absolutePath(path: string) {
        return { ok: true, value: path }
      },
      async joinPath(parts: string[]) {
        return { ok: true, value: parts.join('/') }
      },
      async canonicalPath(path: string, _context: Context) {
        record('canonicalPath', path)
        return { ok: true, value: path }
      },
      async fileInfo(path: string, _context: Context) {
        record('fileInfo', path)
        if (!files.has(path)) {
          return { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
        }
        return { ok: true, value: { kind: 'file', size: 16 } }
      },
      async readTextFile(path: string, _context: Context) {
        record('readTextFile', path)
        const content = files.get(path)
        if (content === undefined) {
          return { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
        }
        return { ok: true, value: content }
      },
      async writeFile(path: string, content: string, _context: Context) {
        record('writeFile', path)
        files.set(path, content)
        return { ok: true, value: void 0 }
      },
      async createDir(path: string, _options: { recursive?: boolean }, _context: Context) {
        record('createDir', path)
        return { ok: true, value: void 0 }
      },
    },
  }
}

/** 平台可控的 EnvFabric 替身：nodePlatformOf / isOnline / env* 按参数返回。 */
function makePlatformFabric(options: {
  platform?: string
  online?: boolean
  env?: unknown
}): EnvFabric {
  const online = options.online ?? true
  return {
    registry: {} as never,
    envFor: () => options.env as never,
    envForTarget: () => options.env as never,
    isOnline: () => online,
    waitForOnline: () => Promise.resolve(online),
    getNodeHubUrl: () => undefined,
    nodePlatformOf: (nodeId: string) => (nodeId === 'local' ? process.platform : options.platform),
    evictConversation: () => undefined,
    debugBaseCount: () => 0,
    debugBases: () => [],
    ipcCall: () => {
      throw new Error('测试不使用')
    },
    ipcSubscribe: () => {
      throw new Error('测试不使用')
    },
    dispose: () => Promise.resolve(),
  } as never
}

async function makeDeps(dir: string, envFabric?: EnvFabric, nodeIdOf?: (id: number) => string): Promise<HelmToolDeps> {
  await ensureDataDir(dir)
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: () => ({}),
    redact: (t) => stash.redact(t),
    artifacts,
    ...(envFabric !== undefined ? { envFabric } : {}),
    ...(nodeIdOf !== undefined ? { nodeIdOf } : {}),
  }
}

function makeApi(cwd: string, conversationId = 1) {
  return {
    taskId: 'test-task',
    conversationId,
    callId: 'call-test-1',
    registry: { tools: [] },
    agent: async () => ({ cwd }),
    models: {},
    env: undefined,
    now: () => Date.now(),
    output: () => {},
    outputWindow: undefined,
    retainedOutput: () => ({ text: '', truncated: false }),
    diagnostic: () => {},
    details: async () => undefined,
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('测试不使用')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('测试不使用')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('测试不使用')
    },
  } as never
}

// ---------------------------------------------------------------------------
// 1. 平台选择原语
// ---------------------------------------------------------------------------
describe('targetPlatformForNode：平台选择（local 宿主 / 远端注册值 / 未知不猜）', { timeout: 60_000 }, () => {
  it('local 恒 process.platform（无需任何端口）', { timeout: 60_000 }, () => {
    const info = targetPlatformForNode(undefined, 'local')
    assert.ok(info.known, 'local 平台恒已知')
    assert.equal(info.platform, process.platform === 'win32' ? 'win32' : 'posix')
    assert.equal(info.reported, process.platform)
  })

  it('远端：仅取注册登记平台；win32 → win32，linux/darwin → posix', { timeout: 60_000 }, () => {
    const win = targetPlatformForNode({ nodePlatformOf: () => 'win32' }, 'n1')
    assert.ok(win.known && win.platform === 'win32')
    const linux = targetPlatformForNode({ nodePlatformOf: () => 'linux' }, 'n1')
    assert.ok(linux.known && linux.platform === 'posix')
    const darwin = targetPlatformForNode({ nodePlatformOf: () => 'darwin' }, 'n1')
    assert.ok(darwin.known && darwin.platform === 'posix')
  })

  it('远端平台未知（未上报 / 离线 / 端口缺位）：显式 unknown，绝不 fallback local', { timeout: 60_000 }, () => {
    // 在 win32 宿主模拟上也不得把 Hub 平台套给远端：用注入 reported 验证。
    for (const source of [undefined, { nodePlatformOf: () => undefined }, { nodePlatformOf: () => '' }, {}]) {
      const info = targetPlatformForNode(source as never, 'n1')
      assert.ok(!info.known, `平台未知必须显式 unknown：${JSON.stringify(source)}`)
      assert.match(info.reason, /不猜测平台/)
    }
  })

  it('normalizePathForTarget：平台未知时路径原样返回（不猜平台）', { timeout: 60_000 }, () => {
    const n = normalizePathForTarget('/mnt/d/proj', { known: false, reason: '未知' })
    assert.ok(n.ok && n.path === '/mnt/d/proj')
  })
})

// ---------------------------------------------------------------------------
// 2. runShell：bash / runGate / execEnv 全量收敛点的 cwd 规范化
// ---------------------------------------------------------------------------
describe('runShell：目标平台感知 cwd 规范化', { timeout: 60_000 }, () => {
  it('远端 win32 节点：/mnt/d/proj（WSL 挂载视图）→ exec 收到 D:\\proj', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs1'),
      makePlatformFabric({ platform: 'win32', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(
      shell.execCalls.map((c) => c.cwd),
      ['D:\\proj'],
      'SDK NodeExecutionEnv / Remote 执行只接收已规范化路径',
    )
  })

  it('远端 win32 节点：/d/proj（Git Bash 盘符根视图）→ D:\\proj', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs2'),
      makePlatformFabric({ platform: 'win32', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['D:\\proj'])
  })

  it('win32 目标裸 POSIX 根（/home/x）：显式 invalid_path 并保留原始路径，绝不执行', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs3'),
      makePlatformFabric({ platform: 'win32', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/home/user/x' })
    assert.equal(result.ok, false)
    assert.match(result.output, /invalid_path/)
    assert.match(result.output, /\/home\/user\/x/, '失败信息必须保留原始路径')
    assert.equal(shell.execCalls.length, 0, '路径不可映射绝不发起执行')
  })

  it('远端 POSIX 节点：/mnt/d/proj 是真实路径，绝不被误判成 Windows 做转换', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs4'),
      makePlatformFabric({ platform: 'linux', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'posix-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['/mnt/d/proj'])
  })

  it('远端平台未知（在线但未上报）：cwd 原样透传（不猜、不 fallback Hub 宿主）', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs5'),
      makePlatformFabric({ platform: undefined, env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['/mnt/d/proj'])
  })

  it('远端节点离线：node_offline 显式失败（不猜平台、不回退本机执行）', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs6'),
      makePlatformFabric({ platform: undefined, online: false, env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'off-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, false)
    assert.match(result.output, /node_offline/)
    assert.equal(shell.execCalls.length, 0)
  })

  it('local（POSIX Hub）：cwd 原样（词法归一）到达 exec', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs7'),
      makePlatformFabric({ env: shell.env }),
    )
    const dir = join(rootDir, 'rs7-local')
    const result = await runShell(deps, 'pwd', { cwd: dir })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), [dir])
  })
})

// ---------------------------------------------------------------------------
// 3. read / write / edit：与 bash 同一平台来源与同一原语
// ---------------------------------------------------------------------------
describe('read/write/edit：win32 靶点 POSIX 视图规范化（与 bash 一致）', { timeout: 60_000 }, () => {
  it('read：会话 cwd /mnt/d/proj 下相对与绝对路径均转规范 Windows 路径到达远端 env', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([
      ['D:\\proj\\note.md', '# win'],
      ['D:\\other\\abs.md', '# abs'],
    ])
    const recorder = makeRecordingFileEnv(files)
    const deps = await makeDeps(
      join(rootDir, 'rw1'),
      makePlatformFabric({ platform: 'win32', env: recorder.env }),
      () => 'win-node',
    )
    const tool = createReadTool(deps)
    const rel = await tool.execute({ path: 'note.md' }, makeApi('/mnt/d/proj'), BACKGROUND_CONTEXT)
    assert.equal(!!rel.isError, false)
    assert.ok(recorder.calls.some((c) => c.method === 'readTextFile' && c.path === 'D:\\proj\\note.md'))
    // 绝对 POSIX 视图路径（跨盘）：同样确定性转换。
    const abs = await tool.execute({ path: '/mnt/d/other/abs.md' }, makeApi('/mnt/d/proj'), BACKGROUND_CONTEXT)
    assert.equal(!!abs.isError, false)
    assert.ok(recorder.calls.some((c) => c.method === 'readTextFile' && c.path === 'D:\\other\\abs.md'))
  })

  it('read 与 bash 一致：同一会话 cwd 派生同一基准（D:\\proj）', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['D:\\proj\\note.md', '# win']])
    const recorder = makeRecordingFileEnv(files)
    const shell = makeRecordingShellEnv()
    // 同一靶点 env：bash 走 exec，文件工具走 canonicalPath/readTextFile 等。
    const combinedEnv = { ...recorder.env, exec: shell.env.exec }
    const fabric = makePlatformFabric({ platform: 'win32', env: combinedEnv })
    const deps = await makeDeps(join(rootDir, 'rw2'), fabric, () => 'win-node')
    // bash（runShell）与 read 在同一 cwd '/mnt/d/proj' 下执行。
    const bashResult = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/mnt/d/proj', conversationId: 1 })
    assert.equal(bashResult.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['D:\\proj'], 'bash exec 收到规范化 cwd')
    const read = await createReadTool(deps).execute(
      { path: 'note.md' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!read.isError, false)
    const bashBase = shell.execCalls[0]!.cwd
    const readPath = recorder.calls.find((c) => c.method === 'readTextFile')!.path
    assert.ok(
      readPath.startsWith(`${bashBase}\\`),
      `read 必须解析到 bash 同一规范化基准下：bash=${bashBase} read=${readPath}`,
    )
  })

  it('write/edit：新文件与唯一替换均落规范 Windows 路径', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['D:\\proj\\config.ts', 'timeout = 1000']])
    const recorder = makeRecordingFileEnv(files)
    const deps = await makeDeps(
      join(rootDir, 'rw3'),
      makePlatformFabric({ platform: 'win32', env: recorder.env }),
      () => 'win-node',
    )
    const write = await createWriteTool(deps).execute(
      { path: 'src\\new-file.ts', content: 'export {}' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!write.isError, false)
    assert.equal(files.get('D:\\proj\\src\\new-file.ts'), 'export {}')
    assert.ok(recorder.calls.some((c) => c.method === 'createDir' && c.path === 'D:\\proj\\src'))
    const edit = await createEditTool(deps).execute(
      { path: 'config.ts', oldText: '1000', newText: '2000' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!edit.isError, false)
    assert.equal(files.get('D:\\proj\\config.ts'), 'timeout = 2000')
  })

  it('win32 靶点 /home 拒绝：read/write/edit 一致 invalid_path（保留原始路径，零远端调用）', { timeout: 60_000 }, async () => {
    const recorder = makeRecordingFileEnv(new Map())
    const deps = await makeDeps(
      join(rootDir, 'rw4'),
      makePlatformFabric({ platform: 'win32', env: recorder.env }),
      () => 'win-node',
    )
    // 会话 cwd 本身不可映射：拒绝。
    const readBadCwd = await createReadTool(deps).execute(
      { path: 'file.txt' },
      makeApi('/home/user/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(readBadCwd.isError, true)
    assert.match((readBadCwd.output as Array<{ text: string }>)[0]!.text, /invalid_path/)
    assert.match((readBadCwd.output as Array<{ text: string }>)[0]!.text, /\/home\/user\/proj/)
    // 合法 cwd 下绝对裸 POSIX 根同样拒绝。
    const readAbs = await createReadTool(deps).execute(
      { path: '/home/user/secret.txt' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(readAbs.isError, true)
    assert.match((readAbs.output as Array<{ text: string }>)[0]!.text, /invalid_path/)
    const writeAbs = await createWriteTool(deps).execute(
      { path: '/home/user/out.txt', content: 'x' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(writeAbs.isError, true)
    assert.match((writeAbs.output as Array<{ text: string }>)[0]!.text, /invalid_path/)
    const before = recorder.calls.length
    const editAbs = await createEditTool(deps).execute(
      { path: '/home/user/out.txt', oldText: 'a', newText: 'b' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(editAbs.isError, true)
    assert.match((editAbs.output as Array<{ text: string }>)[0]!.text, /invalid_path/)
    assert.equal(recorder.calls.length, before, '不可映射路径绝不触达远端 env')
  })

  it('远端 POSIX 节点：POSIX 语义原样（read 与既有解析一致，绝不做反向转换）', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['/mnt/d/proj/note.md', '# posix']])
    const recorder = makeRecordingFileEnv(files)
    const deps = await makeDeps(
      join(rootDir, 'rw5'),
      makePlatformFabric({ platform: 'linux', env: recorder.env }),
      () => 'posix-node',
    )
    const read = await createReadTool(deps).execute(
      { path: 'note.md' },
      makeApi('/mnt/d/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!read.isError, false)
    assert.ok(recorder.calls.some((c) => c.method === 'readTextFile' && c.path === '/mnt/d/proj/note.md'))
  })

  it('远端平台未知：沿用按形状解析的既有语义（win32 形状路径原样到达）', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['C:\\workspace\\note.md', '# shape']])
    const recorder = makeRecordingFileEnv(files)
    const deps = await makeDeps(
      join(rootDir, 'rw6'),
      makePlatformFabric({ platform: undefined, env: recorder.env }),
      () => 'mystery-node',
    )
    const read = await createReadTool(deps).execute(
      { path: 'note.md' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!read.isError, false)
    assert.ok(recorder.calls.some((c) => c.method === 'readTextFile' && c.path === 'C:\\workspace\\note.md'))
  })
})

// ---------------------------------------------------------------------------
// 4. resolveTargetPath：win32 平台分支词法语义
// ---------------------------------------------------------------------------
describe('resolveTargetPath：platform=win32 分支', { timeout: 60_000 }, () => {
  it('POSIX 视图 base 与相对 raw：先转换后按 win32 规则解析', { timeout: 60_000 }, () => {
    const r = resolveTargetPath('src\\main.ts', '/mnt/d/proj', 'win32')
    assert.ok(r.ok)
    assert.equal(r.abs, 'D:\\proj\\src\\main.ts')
    const dotdot = resolveTargetPath('..\\secret.txt', '/d/proj', 'win32')
    assert.ok(dotdot.ok)
    assert.equal(dotdot.abs, 'D:\\secret.txt')
  })

  it('绝对 POSIX 视图 raw：/mnt/c 与 /e 视图确定性转换', { timeout: 60_000 }, () => {
    const a = resolveTargetPath('/mnt/c/x/y.txt', 'D:\\proj', 'win32')
    assert.ok(a.ok && a.abs === 'C:\\x\\y.txt')
    const b = resolveTargetPath('/e/z.txt', 'D:\\proj', 'win32')
    assert.ok(b.ok && b.abs === 'E:\\z.txt')
  })

  it('裸 POSIX 根拒绝（保留原始路径）；盘符相对拒绝不变', { timeout: 60_000 }, () => {
    const home = resolveTargetPath('/home/u/f.txt', 'D:\\proj', 'win32')
    assert.ok(!home.ok)
    assert.match(home.reason, /\/home\/u\/f\.txt/)
    const mntBad = resolveTargetPath('/mnt/cd/rom', 'D:\\proj', 'win32')
    assert.ok(!mntBad.ok, '/mnt/<非单字母> 不是盘符视图')
    const driveRel = resolveTargetPath('C:relative\\f.txt', 'D:\\proj', 'win32')
    assert.ok(!driveRel.ok)
  })

  it('platform 缺省（远端平台未知）：按形状选规则的既有语义不变', { timeout: 60_000 }, () => {
    const r = resolveTargetPath('note.md', 'C:\\workspace')
    assert.ok(r.ok && r.abs === 'C:\\workspace\\note.md')
    const p = resolveTargetPath('note.md', '/mnt/d/proj')
    assert.ok(p.ok && p.abs === '/mnt/d/proj/note.md', '平台未知时 POSIX 视图不转换')
  })
})

// ---------------------------------------------------------------------------
// 5. NodeManager.resolveExecTarget：POST /api/env/exec 靶点解析
// ---------------------------------------------------------------------------
describe('resolveExecTarget：平台感知 cwd 规范化（HTTP exec 靶点）', { timeout: 60_000 }, () => {
  function makeManager(fabric: EnvFabric, convOf: () => { cwd: string; nodeId?: string } = () => ({ cwd: '/conv/cwd' })): NodeManager {
    return new NodeManager({
      dataDir: join(rootDir, 'nm'),
      envFabric: fabric,
      configSvc: {} as never,
      stash: {} as never,
      toolDeps: { defaultCwd: '/hub/cwd' } as never,
      events: { publish: () => undefined } as never,
      nodeUpgradeTimeoutMs: 5_000,
      convOf,
    })
  }

  it('远端 win32 节点：/mnt/d/proj → D:\\proj（返回值即规范化 cwd）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }))
    const t = manager.resolveExecTarget({ nodeId: 'win-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'win-node', cwd: 'D:\\proj' })
  })

  it('win32 节点裸 POSIX 根：validation_error（含 invalid_path 与原始 cwd）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }))
    assert.throws(
      () => manager.resolveExecTarget({ nodeId: 'win-node', cwd: '/home/user/x' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'validation_error')
        assert.equal(error.status, 400)
        assert.match(error.message, /\/home\/user\/x/, '错误信息保留原始路径')
        const details = error.details as { cwd?: string; pathCode?: string }
        assert.equal(details.cwd, '/home/user/x', 'details 保留原始 cwd')
        assert.equal(details.pathCode, 'invalid_path')
        return true
      },
    )
  })

  it('会话绑定继承：会话 cwd 同样按目标平台规范化', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }), () => ({
      cwd: '/mnt/c/conv',
      nodeId: 'win-node',
    }))
    const t = manager.resolveExecTarget({ conversationId: 7, command: 'pwd' } as never)
    assert.deepEqual(t, { nodeId: 'win-node', cwd: 'C:\\conv' })
  })

  it('远端离线：node_offline 409（平台未知不猜，不回退本机）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: undefined, online: false }))
    assert.throws(
      () => manager.resolveExecTarget({ nodeId: 'off-node', cwd: '/mnt/d/proj' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'node_offline')
        assert.equal(error.status, 409)
        return true
      },
    )
  })

  it('远端平台未知（在线未上报）：cwd 原样透传（不猜、不转换、不报错）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: undefined }))
    const t = manager.resolveExecTarget({ nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
  })

  it('远端 POSIX 节点：/mnt/d 原样（Linux/macOS 与远端 POSIX 语义不变）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'linux' }))
    const t = manager.resolveExecTarget({ nodeId: 'posix-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'posix-node', cwd: '/mnt/d/proj' })
  })

  it('local：缺省 cwd 原样（POSIX Hub 词法归一）', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({}))
    const t = manager.resolveExecTarget({})
    assert.deepEqual(t, { nodeId: 'local', cwd: '/hub/cwd' })
  })
})

// ---------------------------------------------------------------------------
// 6. EnvFabric.nodePlatformOf：真实注册链（WS 网关 + NodeRegistry）
// ---------------------------------------------------------------------------
describe('EnvFabric.nodePlatformOf：注册登记平台的最小只读端口（真实 WS 注册链）', { timeout: 60_000 }, () => {
  async function startHub(): Promise<{
    fabric: EnvFabric
    baseUrl: string
    close: () => Promise<void>
  }> {
    const TOKEN = 'fake:secret'
    const fabric = createEnvFabric({
      authenticate: (_nodeId, token) => token === TOKEN,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
    })
    const server = http.createServer((_req, res) => {
      res.writeHead(404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address === 'object')
    const gateway = attachNodeWsGateway(server, { registry: fabric.registry })
    return {
      fabric,
      baseUrl: `http://127.0.0.1:${address.port}`,
      close: async () => {
        await gateway.close()
        await new Promise<void>((resolve) => server.close(() => resolve()))
        await fabric.dispose()
      },
    }
  }

  /** 原始 WS 客户端手动 register（可控 platform 上报；返回 ws 供断开）。 */
  async function registerFakeNode(
    baseUrl: string,
    input: NodeRegisterInput,
  ): Promise<WebSocket> {
    const ws = new WebSocket(`${baseUrl.replace(/^http/, 'ws')}/ws/node?nodeId=${input.nodeId}`)
    await new Promise<void>((resolve) => ws.once('open', () => resolve()))
    const rpc = createBirpc<
      { register(input: NodeRegisterInput): Promise<NodeRegisterResult> },
      HubConnectionLocal
    >(
      { onEnvExecOutput: () => undefined, onIpcEvent: () => undefined, onIpcClosed: () => undefined },
      {
        post: (data) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
        },
        on: (cb) => {
          ws.on('message', (raw) => {
            const text = typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')
            try {
              cb(JSON.parse(text) as never)
            } catch {
              /* 非 JSON 忽略 */
            }
          })
        },
        serialize: (d) => d,
        deserialize: (d) => d as never,
        timeout: 10_000,
      },
    )
    const outcome = await rpc.register(input)
    assert.equal(outcome.ok, true, `注册应成功：${JSON.stringify(outcome)}`)
    return ws
  }

  it('win32 / linux 注册平台如实暴露；断开即 undefined；local 恒宿主平台', { timeout: 60_000 }, async () => {
    const TOKEN = 'fake:secret'
    const hub = await startHub()
    try {
      const winWs = await registerFakeNode(hub.baseUrl, {
        nodeId: 'fake-win',
        token: TOKEN,
        hostname: 'fake-win-host',
        platform: 'win32',
      })
      const posixWs = await registerFakeNode(hub.baseUrl, {
        nodeId: 'fake-posix',
        token: TOKEN,
        hostname: 'fake-posix-host',
        platform: 'linux',
      })
      try {
        assert.equal(hub.fabric.nodePlatformOf('fake-win'), 'win32')
        assert.equal(hub.fabric.nodePlatformOf('fake-posix'), 'linux')
        assert.equal(hub.fabric.nodePlatformOf('local'), process.platform)
        // 未注册节点：undefined（不猜）。
        assert.equal(hub.fabric.nodePlatformOf('never-registered'), undefined)
        // 平台选择原语消费同一端口：win32 → win32，linux → posix。
        const win = targetPlatformForNode(hub.fabric, 'fake-win')
        assert.ok(win.known && win.platform === 'win32')
        const posix = targetPlatformForNode(hub.fabric, 'fake-posix')
        assert.ok(posix.known && posix.platform === 'posix', '远端 POSIX 节点绝不误判成 Windows')
      } finally {
        winWs.close()
        posixWs.close()
      }
      // 断开后（等待注册表 evict）：平台不可知 → unknown，绝不残留旧值。等待网关处理断开。
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(hub.fabric.isOnline('fake-win'), false)
      assert.equal(hub.fabric.nodePlatformOf('fake-win'), undefined)
      const gone = targetPlatformForNode(hub.fabric, 'fake-win')
      assert.ok(!gone.known, '断开后平台未知，不猜')
    } finally {
      await hub.close()
    }
  })
})
