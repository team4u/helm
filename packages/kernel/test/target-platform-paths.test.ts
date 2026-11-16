/**
 * target node platform aware cwd/path specification test (kernel execute chain).
 *
 * override (align task verify side):
 * 1. platform choose:local constant process.platform; remote only take NodeRegistry register register
 *    platform (EnvFabric.nodePlatformOf most small only read port, real WS register chain verify);
 *    offline / not on report platform → platform unknown, never guess, never fallback Hub host.
 * 2. win32 target view convert:/mnt/<symbol>(WSL mount) and /<symbol>(Git Bash)
 *    rotate specification Windows path;/home etc. bare POSIX explicit invalid_path(keep original
 *    path, never guess).
 * 3. read and bash consistent: the same conversation target under file tool and runShell use the same platform source
 *    and the same protocol original language specification (receives identical base allow derive path).
 * 4. remote POSIX node never by mistakenly judge into Windows:/mnt/d in POSIX target on is real
 *    path, original pass-through (only term method archive one).
 * 5. POST /api/env/exec target parse (NodeManager.resolveExecTarget):win32
 *    target specification, bare POSIX  validation_error(contains original cwd), offline 409,
 *    platform unknown original pass-through.
 */

import { before, after, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { createBirpc } from 'birpc'
import { BACKGROUND_CONTEXT, type Context } from '@earendil-works/chord/context'
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
// subject to control replace body
// ---------------------------------------------------------------------------

/** runShell use subject to control shell env: only implement exec, record real receives cwd. */
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

/** read/write/edit use subject to control file env(contains mutual exclusion queue which must most small side). */
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

/** platform can control EnvFabric replace body:nodePlatformOf / isOnline / env* by parameter return. */
function makePlatformFabric(options: {
  platform?: string
  hubPlatform?: string
  online?: boolean
  env?: unknown
}): EnvFabric {
  const online = options.online ?? true
  return {
    registry: {} as never,
    hubPlatform: () => options.hubPlatform,
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
      throw new Error('test does not use')
    },
    ipcSubscribe: () => {
      throw new Error('test does not use')
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
      throw new Error('test does not use')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('test does not use')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('test does not use')
    },
  } as never
}

// ---------------------------------------------------------------------------
// 1. platform choose original language
// ---------------------------------------------------------------------------
describe('targetPlatformForNode: platform choose (local host / remote register value / unknown do not guess)', { timeout: 60_000 }, () => {
  it('local constant process.platform(no need to any port)', { timeout: 60_000 }, () => {
    const info = targetPlatformForNode(undefined, 'local')
    assert.ok(info.known, 'local platform constant known')
    assert.equal(info.platform, process.platform === 'win32' ? 'win32' : 'posix')
    assert.equal(info.reported, process.platform)
  })

  it('local: can inject Hub platform fact; default still fall back host platform', { timeout: 60_000 }, () => {
    const injected = targetPlatformForNode({ hubPlatform: () => 'linux' }, 'local')
    assert.equal(injected.known, true)
    if (injected.known) {
      assert.equal(injected.platform, 'posix')
      assert.equal(injected.reported, 'linux')
    }
    const fallback = targetPlatformForNode(undefined, 'local')
    assert.equal(fallback.known, true)
    if (fallback.known) assert.equal(fallback.reported, process.platform)
  })

  it('remote: only take register register platform;win32 → win32,linux/darwin → posix', { timeout: 60_000 }, () => {
    const win = targetPlatformForNode({ nodePlatformOf: () => 'win32' }, 'n1')
    assert.ok(win.known && win.platform === 'win32')
    const linux = targetPlatformForNode({ nodePlatformOf: () => 'linux' }, 'n1')
    assert.ok(linux.known && linux.platform === 'posix')
    const darwin = targetPlatformForNode({ nodePlatformOf: () => 'darwin' }, 'n1')
    assert.ok(darwin.known && darwin.platform === 'posix')
  })

  it('remote platform unknown (not on report / offline / port missing): explicit unknown, never fallback local', { timeout: 60_000 }, () => {
    // in win32 host simulated on also must not Hub platform set to remote: use inject reported verify.
    for (const source of [undefined, { nodePlatformOf: () => undefined }, { nodePlatformOf: () => '' }, {}]) {
      const info = targetPlatformForNode(source as never, 'n1')
      assert.ok(!info.known, `platform unknown must explicit unknown:${JSON.stringify(source)}`)
      assert.match(info.reason, /do not guess platform/)
    }
  })

  it('normalizePathForTarget: platform unknown when path original return (do not guess platform)', { timeout: 60_000 }, () => {
    const n = normalizePathForTarget('/mnt/d/proj', { known: false, reason: 'unknown' })
    assert.ok(n.ok && n.path === '/mnt/d/proj')
  })
})

// ---------------------------------------------------------------------------
// 2. runShell:bash / runGate / execEnv all amount converge point cwd specification
// ---------------------------------------------------------------------------
describe('runShell: target platform aware cwd specification', { timeout: 60_000 }, () => {
  it('remote win32 node:/mnt/d/proj(WSL mount view)→ exec receives D:\\proj', { timeout: 60_000 }, async () => {
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
      'SDK NodeExecutionEnv / Remote execute only receive already specification path',
    )
  })

  it('remote win32 node:/d/proj(Git Bash symbol view)→ D:\\proj', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs2'),
      makePlatformFabric({ platform: 'win32', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['D:\\proj'])
  })

  it('win32 target bare POSIX (/home/x): explicit invalid_path and keep original path, never execute', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs3'),
      makePlatformFabric({ platform: 'win32', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/home/user/x' })
    assert.equal(result.ok, false)
    assert.match(result.output, /invalid_path/)
    assert.match(result.output, /\/home\/user\/x/, 'failed information must keep original path')
    assert.equal(shell.execCalls.length, 0, 'path cannot mapping never start execute')
  })

  it('remote POSIX node:/mnt/d/proj is real path, never by mistakenly judge into Windows do convert', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs4'),
      makePlatformFabric({ platform: 'linux', env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'posix-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['/mnt/d/proj'])
  })

  it('remote platform unknown (online but not on report):cwd original pass-through (do not guess, do not fallback Hub host)', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs5'),
      makePlatformFabric({ platform: undefined, env: shell.env }),
    )
    const result = await runShell(deps, 'pwd', { nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['/mnt/d/proj'])
  })

  it('remote node offline:node_offline explicit failed (do not guess platform, does not fall back local machine execute)', { timeout: 60_000 }, async () => {
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

  it('local(POSIX Hub):cwd original (term method archive one) reach exec', { timeout: 60_000 }, async () => {
    const shell = makeRecordingShellEnv()
    const deps = await makeDeps(
      join(rootDir, 'rs7'),
      makePlatformFabric({ hubPlatform: 'linux', env: shell.env }),
    )
    const dir = join(rootDir, 'rs7-local')
    const result = await runShell(deps, 'pwd', { cwd: dir })
    assert.equal(result.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), [dir])
  })
})

// ---------------------------------------------------------------------------
// 3. read / write / edit: and bash the same platform source and the same original language
// ---------------------------------------------------------------------------
describe('read/write/edit:win32 target POSIX view specification (and bash consistent)', { timeout: 60_000 }, () => {
  it('read: conversation cwd /mnt/d/proj under each other for and absolute path all rotate specification Windows path reach remote env', { timeout: 60_000 }, async () => {
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
    // absolute POSIX view path (across): same determinism convert.
    const abs = await tool.execute({ path: '/mnt/d/other/abs.md' }, makeApi('/mnt/d/proj'), BACKGROUND_CONTEXT)
    assert.equal(!!abs.isError, false)
    assert.ok(recorder.calls.some((c) => c.method === 'readTextFile' && c.path === 'D:\\other\\abs.md'))
  })

  it('read and bash consistent: the same conversation cwd derive the same base allow (D:\\proj)', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['D:\\proj\\note.md', '# win']])
    const recorder = makeRecordingFileEnv(files)
    const shell = makeRecordingShellEnv()
    // the same target env:bash away exec, file tool away canonicalPath/readTextFile etc..
    const combinedEnv = { ...recorder.env, exec: shell.env.exec }
    const fabric = makePlatformFabric({ platform: 'win32', env: combinedEnv })
    const deps = await makeDeps(join(rootDir, 'rw2'), fabric, () => 'win-node')
    // bash(runShell) and read in the same cwd '/mnt/d/proj' under execute.
    const bashResult = await runShell(deps, 'pwd', { nodeId: 'win-node', cwd: '/mnt/d/proj', conversationId: 1 })
    assert.equal(bashResult.ok, true)
    assert.deepEqual(shell.execCalls.map((c) => c.cwd), ['D:\\proj'], 'bash exec receives specification cwd')
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
      `read must parse to bash the same specification base allow under:bash=${bashBase} read=${readPath}`,
    )
  })

  it('write/edit: new file and unique replace all specification Windows path', { timeout: 60_000 }, async () => {
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

  it('win32 target /home reject:read/write/edit consistent invalid_path(keep original path, zero remote invoke)', { timeout: 60_000 }, async () => {
    const recorder = makeRecordingFileEnv(new Map())
    const deps = await makeDeps(
      join(rootDir, 'rw4'),
      makePlatformFabric({ platform: 'win32', env: recorder.env }),
      () => 'win-node',
    )
    // conversation cwd itself cannot mapping: reject.
    const readBadCwd = await createReadTool(deps).execute(
      { path: 'file.txt' },
      makeApi('/home/user/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(readBadCwd.isError, true)
    assert.match((readBadCwd.output as Array<{ text: string }>)[0]!.text, /invalid_path/)
    assert.match((readBadCwd.output as Array<{ text: string }>)[0]!.text, /\/home\/user\/proj/)
    // legal cwd under absolute bare POSIX same reject.
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
    assert.equal(recorder.calls.length, before, 'cannot mapping path never trigger reach remote env')
  })

  it('remote POSIX node:POSIX semantics original (read and since has parse consistent, never do reverse convert)', { timeout: 60_000 }, async () => {
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

  it('remote platform unknown: along use by shape parse since has semantics (win32 shape path original reach)', { timeout: 60_000 }, async () => {
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
// 4. resolveTargetPath:win32 platform branch term method semantics
// ---------------------------------------------------------------------------
describe('resolveTargetPath:platform=win32 branch', { timeout: 60_000 }, () => {
  it('POSIX view base and each other for raw: first convert after by win32 rule parse', { timeout: 60_000 }, () => {
    const r = resolveTargetPath('src\\main.ts', '/mnt/d/proj', 'win32')
    assert.ok(r.ok)
    assert.equal(r.abs, 'D:\\proj\\src\\main.ts')
    const dotdot = resolveTargetPath('..\\secret.txt', '/d/proj', 'win32')
    assert.ok(dotdot.ok)
    assert.equal(dotdot.abs, 'D:\\secret.txt')
  })

  it('absolute POSIX view raw:/mnt/c and /e view determinism convert', { timeout: 60_000 }, () => {
    const a = resolveTargetPath('/mnt/c/x/y.txt', 'D:\\proj', 'win32')
    assert.ok(a.ok && a.abs === 'C:\\x\\y.txt')
    const b = resolveTargetPath('/e/z.txt', 'D:\\proj', 'win32')
    assert.ok(b.ok && b.abs === 'E:\\z.txt')
  })

  it('bare POSIX reject (keep original path); symbol each other for reject do not change', { timeout: 60_000 }, () => {
    const home = resolveTargetPath('/home/u/f.txt', 'D:\\proj', 'win32')
    assert.ok(!home.ok)
    assert.match(home.reason, /\/home\/u\/f\.txt/)
    const mntBad = resolveTargetPath('/mnt/cd/rom', 'D:\\proj', 'win32')
    assert.ok(!mntBad.ok, '/mnt/<non- single character parent> is not symbol view')
    const driveRel = resolveTargetPath('C:relative\\f.txt', 'D:\\proj', 'win32')
    assert.ok(!driveRel.ok)
  })

  it('platform default (remote platform unknown): by shape choose rule since has semantics do not change', { timeout: 60_000 }, () => {
    const r = resolveTargetPath('note.md', 'C:\\workspace')
    assert.ok(r.ok && r.abs === 'C:\\workspace\\note.md')
    const p = resolveTargetPath('note.md', '/mnt/d/proj')
    assert.ok(p.ok && p.abs === '/mnt/d/proj/note.md', 'platform unknown when POSIX view do not convert')
  })
})

// ---------------------------------------------------------------------------
// 5. NodeManager.resolveExecTarget:POST /api/env/exec target parse
// ---------------------------------------------------------------------------
describe('resolveExecTarget: platform aware cwd specification (HTTP exec target)', { timeout: 60_000 }, () => {
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

  it('remote win32 node:/mnt/d/proj → D:\\proj(return value i.e. specification cwd)', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }))
    const t = manager.resolveExecTarget({ nodeId: 'win-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'win-node', cwd: 'D:\\proj' })
  })

  it('win32 node bare POSIX :validation_error(contains invalid_path and original cwd)', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }))
    assert.throws(
      () => manager.resolveExecTarget({ nodeId: 'win-node', cwd: '/home/user/x' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'validation_error')
        assert.equal(error.status, 400)
        assert.match(error.message, /\/home\/user\/x/, 'error information keep original path')
        const details = error.details as { cwd?: string; pathCode?: string }
        assert.equal(details.cwd, '/home/user/x', 'details keep original cwd')
        assert.equal(details.pathCode, 'invalid_path')
        return true
      },
    )
  })

  it('conversation bind set inherit: conversation cwd same by target platform specification', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'win32' }), () => ({
      cwd: '/mnt/c/conv',
      nodeId: 'win-node',
    }))
    const t = manager.resolveExecTarget({ conversationId: 7, command: 'pwd' } as never)
    assert.deepEqual(t, { nodeId: 'win-node', cwd: 'C:\\conv' })
  })

  it('remote offline:node_offline 409(platform unknown do not guess, does not fall back local machine)', { timeout: 60_000 }, () => {
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

  it('remote platform unknown (online not on report):cwd original pass-through (do not guess, do not convert, do not errors)', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: undefined }))
    const t = manager.resolveExecTarget({ nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'mystery-node', cwd: '/mnt/d/proj' })
  })

  it('remote POSIX node:/mnt/d original (Linux/macOS and remote POSIX semantics do not change)', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ platform: 'linux' }))
    const t = manager.resolveExecTarget({ nodeId: 'posix-node', cwd: '/mnt/d/proj' })
    assert.deepEqual(t, { nodeId: 'posix-node', cwd: '/mnt/d/proj' })
  })

  it('local: default cwd original (inject POSIX Hub term method archive one)', { timeout: 60_000 }, () => {
    const manager = makeManager(makePlatformFabric({ hubPlatform: 'linux' }))
    const t = manager.resolveExecTarget({})
    assert.deepEqual(t, { nodeId: 'local', cwd: '/hub/cwd' })
  })
})

// ---------------------------------------------------------------------------
// 6. EnvFabric.nodePlatformOf: real register chain (WS gateway + NodeRegistry)
// ---------------------------------------------------------------------------
describe('EnvFabric.nodePlatformOf: register register platform most small only read port (real WS register chain)', { timeout: 60_000 }, () => {
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

  /** original WS client manually register(can control platform on report; return ws supply disconnect). */
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
              /* non- JSON ignore */
            }
          })
        },
        serialize: (d) => d,
        deserialize: (d) => d as never,
        timeout: 10_000,
      },
    )
    const outcome = await rpc.register(input)
    assert.equal(outcome.ok, true, `register should succeeded:${JSON.stringify(outcome)}`)
    return ws
  }

  it('win32 / linux register platform such as expose; disconnect i.e. undefined;local constant host platform', { timeout: 60_000 }, async () => {
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
        // not registered node:undefined(do not guess).
        assert.equal(hub.fabric.nodePlatformOf('never-registered'), undefined)
        // platform choose original language consume the same port:win32 → win32,linux → posix.
        const win = targetPlatformForNode(hub.fabric, 'fake-win')
        assert.ok(win.known && win.platform === 'win32')
        const posix = targetPlatformForNode(hub.fabric, 'fake-posix')
        assert.ok(posix.known && posix.platform === 'posix', 'remote POSIX node never mistakenly judge into Windows')
      } finally {
        winWs.close()
        posixWs.close()
      }
      // after disconnect (wait for register table evict): platform cannot know → unknown, never leftover old value. wait for gateway handle disconnect.
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.equal(hub.fabric.isOnline('fake-win'), false)
      assert.equal(hub.fabric.nodePlatformOf('fake-win'), undefined)
      const gone = targetPlatformForNode(hub.fabric, 'fake-win')
      assert.ok(!gone.known, 'after disconnect platform unknown, do not guess')
    } finally {
      await hub.close()
    }
  })
})
