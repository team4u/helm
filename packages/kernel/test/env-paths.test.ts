/**
 * Cross-platform path shape tests: read/write/edit normalize paths using pure posix/win32 rules
 * inferred from the target path syntax (POSIX / Windows drive letter / UNC), never using Hub host
 * node:path defaults for remote paths; drive-relative paths (C:relative) are always rejected.
 * Path contract (aligned with pi): conversation cwd serves only as base for relative paths;
 * absolute paths and ../ parent traversals are permitted (matching bash permissions; no cwd sandbox).
 *
 * Honesty invariant: remote targets use a recording ExecutionEnv capturing exact received paths (never
 * fabricating results); local targets verify real file reads/writes under POSIX directory semantics.
 */

import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import {
  buildManagedEnv,
  buildToolEnv,
  createEditTool,
  createReadTool,
  createWriteTool,
  isAbsoluteTargetPath,
  resolveTargetPath,
  targetPathShape,
} from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'
import { composeExecutionEnv } from '../src/env/scoped-env.js'
import { createLocalExecutionEnv } from '../src/env/local-host-env.js'
import type { ShellProbeIo } from '@helm/env-io'

/** Recording ExecutionEnv: captures exact paths and Context passed in, never faking results. */
interface RecordedCall {
  method: string
  path: string
  context: Context
}

function makeRecordingEnv(options: {
  canonical: (path: string) => string
  files?: Map<string, string>
}): {
  env: {
    id: string
    absolutePath(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    joinPath(parts: string[], context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    canonicalPath(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    fileInfo(path: string, context: Context): Promise<{ ok: true; value: { kind: 'file' | 'directory'; size: number } } | { ok: false; error: { code: string; message: string } }>
    readTextFile(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    writeFile(path: string, content: string, context: Context): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
    createDir(path: string, options: { recursive?: boolean }, context: Context): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
  }
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const record = (method: string, path: string, context: Context): void => {
    calls.push({ method, path, context })
  }
  return {
    calls,
    env: {
      // Mutex key uses the minimal subset (see env/file-mutation-queue.ts): constant-like
      // absolutePath/joinPath + controllable canonical; path syntax is controlled by the test itself.
      id: 'remote:stub-node',
      async absolutePath(path, _context) {
        return { ok: true, value: path }
      },
      async joinPath(parts, _context) {
        return { ok: true, value: parts.join('/') }
      },
      async canonicalPath(path, context) {
        record('canonicalPath', path, context)
        return { ok: true, value: options.canonical(path) }
      },
      async fileInfo(path, context) {
        record('fileInfo', path, context)
        return { ok: true, value: { kind: 'file', size: 16 } }
      },
      async readTextFile(path, context) {
        record('readTextFile', path, context)
        const content = options.files?.get(path)
        if (content === undefined) {
          return { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
        }
        return { ok: true, value: content }
      },
      async writeFile(path, content, context) {
        record('writeFile', path, context)
        options.files?.set(path, content)
        return { ok: true, value: void 0 }
      },
      async createDir(path, _options, context) {
        record('createDir', path, context)
        return { ok: true, value: void 0 }
      },
    },
  }
}

/** Minimal EnvFabric stub: envFor returns the recording env; isOnline is always true. */
function makeStubFabric(env: ReturnType<typeof makeRecordingEnv>['env']): EnvFabric {
  return {
    registry: {} as never,
    envFor: () => env as never,
    envForTarget: () => {
      throw new Error('test does not use envForTarget')
    },
    isOnline: () => true,
    waitForOnline: () => Promise.resolve(true),
    getNodeHubUrl: () => 'http://10.0.0.5:3202',
    evictConversation: () => undefined,
    debugBaseCount: () => 0,
    debugBases: () => [],
    ipcCall: () => {
      throw new Error('test does not use ipcCall')
    },
    ipcSubscribe: () => {
      throw new Error('test does not use ipcSubscribe')
    },
    dispose: () => Promise.resolve(),
  } as never
}

async function makeDeps(dir: string, options: { envFabric?: EnvFabric; nodeIdOf?: (id: number) => string } = {}): Promise<HelmToolDeps> {
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
    ...(options.envFabric !== undefined ? { envFabric: options.envFabric } : {}),
    ...(options.nodeIdOf !== undefined ? { nodeIdOf: options.nodeIdOf } : {}),
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
    details: async () => {},
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

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-env-paths-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. Pure path shape helpers
// ---------------------------------------------------------------------------
describe('targetPathShape / isAbsoluteTargetPath / resolveTargetPath', { timeout: 60_000 }, () => {
  it('shape detection: POSIX absolute, drive-letter absolute, UNC, drive-relative, and relative paths', { timeout: 60_000 }, () => {
    assert.equal(targetPathShape('/workspace/file.txt'), 'posix')
    assert.equal(targetPathShape('C:\\workspace\\file.txt'), 'win32')
    assert.equal(targetPathShape('c:/workspace/file.txt'), 'win32')
    assert.equal(targetPathShape('\\\\server\\share\\file.txt'), 'win32')
    assert.equal(targetPathShape('C:relative\\file.txt'), undefined, 'drive-relative paths do not count as absolute')
    assert.equal(targetPathShape('relative/file.txt'), undefined)
    assert.equal(isAbsoluteTargetPath('/workspace'), true)
    assert.equal(isAbsoluteTargetPath('C:\\workspace'), true)
    assert.equal(isAbsoluteTargetPath('\\\\server\\share'), true)
    assert.equal(isAbsoluteTargetPath('C:relative'), false, 'drive-relative is not absolute')
    assert.equal(isAbsoluteTargetPath('relative'), false)
  })

  it('resolveTargetPath: resolves Windows target using win32 rules on Linux Hub; cwd only serves as relative base', { timeout: 60_000 }, () => {
    // On a Linux Hub, path.resolve('C:\\workspace', 'file.txt') would produce
    // '<cwd>/C:\\workspace/file.txt' -- this helper must inspect target syntax and apply win32 rules.
    const r = resolveTargetPath('file.txt', 'C:\\workspace')
    assert.ok(r.ok)
    assert.equal(r.abs, 'C:\\workspace\\file.txt')
    const abs = resolveTargetPath('C:\\workspace\\inner\\file.txt', 'C:\\workspace')
    assert.ok(abs.ok)
    assert.equal(abs.abs, 'C:\\workspace\\inner\\file.txt')
    // Contract: cross-drive absolute paths and ../ parent traversals resolve cleanly with no cwd sandbox.
    const otherDrive = resolveTargetPath('D:\\elsewhere\\file.txt', 'C:\\workspace')
    assert.ok(otherDrive.ok)
    assert.equal(otherDrive.abs, 'D:\\elsewhere\\file.txt')
    const escape = resolveTargetPath('..\\secret.txt', 'C:\\workspace')
    assert.ok(escape.ok)
    assert.equal(escape.abs, 'C:\\secret.txt')
    // Drive-relative paths are rejected deterministically (ambiguous process current dir per drive).
    const denied = resolveTargetPath('C:relative\\file.txt', 'C:\\workspace')
    assert.ok(!denied.ok)
  })
})

// ---------------------------------------------------------------------------
// 2. Remote read/write/edit: recording ExecutionEnv captures exact Windows paths
// ---------------------------------------------------------------------------
describe('remote file tools cross-platform path semantics (recording ExecutionEnv)', { timeout: 60_000 }, () => {
  it('read: Windows absolute target path reaches remote env intact without Hub path.resolve corruption', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['C:\\workspace\\note.md', '# remote content']])
    const recorder = makeRecordingEnv({ canonical: (p) => p, files })
    const deps = await makeDeps(join(rootDir, 'r1'), {
      envFabric: makeStubFabric(recorder.env),
      nodeIdOf: () => 'win-node',
    })
    const tool = createReadTool(deps)
    const result = await tool.execute({ path: 'note.md' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
    assert.equal(!!result.isError, false)
    const paths = recorder.calls.map((c) => c.path)
    assert.ok(
      paths.every((p) => p.startsWith('C:\\')),
      `remote paths must use win32 syntax (never corrupted by Hub resolve): ${JSON.stringify(paths)}`,
    )
    assert.ok(paths.includes('C:\\workspace\\note.md'), `readTextFile must receive win32 resolved absolute path: ${JSON.stringify(paths)}`)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# remote content'))
  })

  it('read: Windows target permits ../ parent traversal and cross-drive D: paths; drive-relative paths reject', { timeout: 60_000 }, () => {
    return (async () => {
      const files = new Map<string, string>([
        ['C:\\secret.txt', 'escaped-via-dotdot'],
        ['D:\\elsewhere\\secret.txt', 'absolute-other-drive'],
      ])
      const recorder = makeRecordingEnv({ canonical: (p) => p, files })
      const deps = await makeDeps(join(rootDir, 'r2'), {
        envFabric: makeStubFabric(recorder.env),
        nodeIdOf: () => 'win-node',
      })
      const tool = createReadTool(deps)
      // Contract: ../ and cross-drive absolute paths resolve under win32 rules and read cleanly from remote.
      const dotdot = await tool.execute({ path: '..\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!dotdot.isError, false, '../ parent traversal should succeed')
      assert.ok(((dotdot.structuredOutput as { content: string }).content).includes('escaped-via-dotdot'))
      const abs = await tool.execute({ path: 'D:\\elsewhere\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!abs.isError, false, 'cross-drive absolute path should succeed')
      assert.ok(((abs.structuredOutput as { content: string }).content).includes('absolute-other-drive'))
      const seenPaths = recorder.calls.map((c) => c.path)
      assert.ok(seenPaths.includes('C:\\secret.txt'), `should receive win32 resolved ../ target: ${JSON.stringify(seenPaths)}`)
      assert.ok(seenPaths.includes('D:\\elsewhere\\secret.txt'), `absolute path should reach remote verbatim: ${JSON.stringify(seenPaths)}`)
      // Drive-relative paths still reject without issuing any remote call.
      const before = recorder.calls.length
      const denied = await tool.execute({ path: 'C:relative.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(denied.isError, true, 'drive-relative path must be rejected')
      assert.ok(
        ((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'),
        `should report invalid_path: ${(denied.output as Array<{ text: string }>)[0]!.text}`,
      )
      assert.equal(recorder.calls.length, before, 'drive-relative path must not invoke remote env')
    })()
  })

  it('write: Windows target creates directories and writes remotely; symlinks resolve to real path before writing', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>()
    const recorder = makeRecordingEnv({ canonical: (p) => p, files })
    const deps = await makeDeps(join(rootDir, 'w1'), {
      envFabric: makeStubFabric(recorder.env),
      nodeIdOf: () => 'win-node',
    })
    const tool = createWriteTool(deps)
    const ok = await tool.execute(
      { path: 'src\\new-file.ts', content: 'export {}' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!ok.isError, false)
    assert.equal(files.get('C:\\workspace\\src\\new-file.ts'), 'export {}')
    assert.ok(recorder.calls.some((c) => c.path === 'C:\\workspace\\src'), 'createDir should receive win32 dirname result')
    // ../ parent write is allowed and resolves directly to target.
    const escaped = await tool.execute(
      { path: '..\\escape.txt', content: 'x' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!escaped.isError, false, '../ parent write should succeed')
    assert.equal(files.get('C:\\escape.txt'), 'x')
    // Symlink: when canonicalPath resolves outside cwd, write targets the canonical real path (aligned with mutex key).
    const evilRecorder = makeRecordingEnv({
      canonical: (p) => (p === 'C:\\workspace\\link.txt' ? 'D:\\outside\\real.txt' : p),
      files: new Map<string, string>(),
    })
    const evilDeps = await makeDeps(join(rootDir, 'w2'), {
      envFabric: makeStubFabric(evilRecorder.env),
      nodeIdOf: () => 'win-node',
    })
    const evil = await createWriteTool(evilDeps).execute(
      { path: 'link.txt', content: 'x' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!evil.isError, false, 'writing through resolved symlink target should succeed (matching bash)')
    assert.ok(
      evilRecorder.calls.some((c) => c.method === 'writeFile' && c.path === 'D:\\outside\\real.txt'),
      'writeFile should target canonical resolved real path',
    )
  })

  it('edit: unique replacement writes back remotely on Windows targets', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['C:\\workspace\\config.ts', 'const timeout = 1000']])
    const recorder = makeRecordingEnv({ canonical: (p) => p, files })
    const deps = await makeDeps(join(rootDir, 'e1'), {
      envFabric: makeStubFabric(recorder.env),
      nodeIdOf: () => 'win-node',
    })
    const tool = createEditTool(deps)
    const result = await tool.execute(
      { path: 'config.ts', oldText: '1000', newText: '2000' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    assert.equal(files.get('C:\\workspace\\config.ts'), 'const timeout = 2000')
  })

  it('cancellation propagation: abort signal reaches remote file operation Context (not BACKGROUND_CONTEXT)', { timeout: 60_000 }, async () => {
    const recorder = makeRecordingEnv({ canonical: (p) => p, files: new Map([['C:\\workspace\\a.txt', 'a']]) })
    const deps = await makeDeps(join(rootDir, 'c1'), {
      envFabric: makeStubFabric(recorder.env),
      nodeIdOf: () => 'win-node',
    })
    const controller = new AbortController()
    const context = withAbortSignal(controller.signal, BACKGROUND_CONTEXT)
    const tool = createReadTool(deps)
    await tool.execute({ path: 'a.txt' }, makeApi('C:\\workspace'), context)
    const seen = recorder.calls.find((c) => c.method === 'readTextFile')
    assert.ok(seen, 'remote readTextFile must be invoked')
    assert.equal(seen!.context.abortSignal, controller.signal, 'tool Context abortSignal must propagate to remote env calls')
  })

  it('missing envFabric: remote node fails explicitly with env_fabric_missing without falling back to local disk', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'm1'), { nodeIdOf: () => 'remote-x' })
    // With deps.envFabric unset, remote operations fail explicitly instead of touching local Hub disk.
    const localSentinel = join(rootDir, 'm1', 'sentinel.txt')
    const write = await createWriteTool(deps).execute(
      { path: 'sentinel.txt', content: 'must-not-exist' },
      makeApi(join(rootDir, 'm1')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(write.isError, true)
    assert.ok(
      ((write.output as Array<{ text: string }>)[0]!.text).includes('env_fabric_missing'),
      'missing envFabric must fail explicitly',
    )
    const read = await createReadTool(deps).execute(
      { path: 'sentinel.txt' },
      makeApi(join(rootDir, 'm1')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(read.isError, true)
    assert.ok(((read.output as Array<{ text: string }>)[0]!.text).includes('env_fabric_missing'))
    assert.equal(
      existsSync(localSentinel),
      false,
      'missing envFabric must never fall back to writing files locally',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. POSIX root base: real local file I/O and parent traversals
// ---------------------------------------------------------------------------
describe('POSIX target real file behavior (root dir and regular dirs)', { timeout: 60_000 }, () => {
  it('local read/write/edit succeed in temp directory (including nested directory creation)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local1')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'note.md'), '# hello')
    const deps = await makeDeps(dir)
    const read = await createReadTool(deps).execute({ path: 'note.md' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!read.isError, false)
    assert.ok(((read.structuredOutput as { content: string }).content).includes('# hello'))
    const write = await createWriteTool(deps).execute(
      { path: 'sub/deep/file.txt', content: 'content' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!write.isError, false)
    assert.equal(readFileSync(join(dir, 'sub', 'deep', 'file.txt'), 'utf8'), 'content')
    const edit = await createEditTool(deps).execute(
      { path: 'note.md', oldText: 'hello', newText: 'world' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!edit.isError, false)
    assert.equal(readFileSync(join(dir, 'note.md'), 'utf8'), '# world')
  })

  it('POSIX contract: ../ parent traversal and external absolute paths read cleanly; drive-relative rejects', { timeout: 60_000 }, async () => {
    const outer = join(rootDir, 'local2-outer')
    const inner = join(outer, 'work')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    const deps = await makeDeps(inner)
    const read = await createReadTool(deps)
    // Contract: cwd serves only as relative base; ../ and absolute paths match bash permissions.
    for (const p of ['../secret.txt', join(outer, 'secret.txt')]) {
      const result = await read.execute({ path: p }, makeApi(inner), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `path ${p} should be readable`)
      assert.ok(
        ((result.structuredOutput as { content: string }).content).includes('outside'),
        `${p} should read content outside cwd`,
      )
    }
    // Drive-relative paths still reject.
    const denied = await read.execute({ path: 'C:relative.txt' }, makeApi(inner), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    assert.ok(((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'))
    // Root directory base: /etc/hostname reads normally.
    const rootRead = await read.execute({ path: '/etc/hostname' }, makeApi('/'), BACKGROUND_CONTEXT)
    assert.equal(!!rootRead.isError, false, 'absolute path under root base should read normally')
  })

  it('root directory write: relative path under / succeeds (cwd serves only as relative base)', { timeout: 60_000 }, async () => {
    // Verify via recording env (real / is read-only/privileged, which is an OS permission boundary rather than path rejection).
    const recorder = makeRecordingEnv({ canonical: (p) => p })
    const deps = await makeDeps(join(rootDir, 'rootw'), {
      envFabric: makeStubFabric(recorder.env),
      nodeIdOf: () => 'root-node',
    })
    const result = await createWriteTool(deps).execute(
      { path: 'etc/new.conf', content: 'k=v' },
      makeApi('/'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false, 'relative path under root base must not be rejected prematurely')
    assert.ok(recorder.calls.some((c) => c.path === '/etc/new.conf'))
  })
})

// ---------------------------------------------------------------------------
// 4. Env composition: remote never merges Hub PATH; hubUrl stays distinct; separators
// ---------------------------------------------------------------------------
describe('buildToolEnv / buildManagedEnv remote semantics', { timeout: 60_000 }, () => {
  it('remote: never merges Hub PATH (unless extraEnv provides PATH); uses node-reported HELM_HUB_URL', { timeout: 60_000 }, () => {
    const deps: HelmToolDeps = {
      dataDir: '/hub-data',
      defaultCwd: '/hub',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t,
      artifacts: null as never,
      envFabric: makeStubFabric(makeRecordingEnv({ canonical: (p) => p }).env),
    }
    const remoteEnv = buildToolEnv(deps, 'C:\\workspace', 9, undefined, 'win-node')
    assert.equal(remoteEnv['PATH'], undefined, 'remote must never inherit Hub PATH (daemon already has node toolchain)')
    assert.equal(remoteEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', 'must use real hubUrl reported by node registration')
    assert.equal(remoteEnv['HELM_CWD'], 'C:\\workspace')
    assert.equal(remoteEnv['HELM_NODE_ID'], 'win-node')
    assert.equal('HELM_DATA_DIR' in remoteEnv, false, 'HELM_DATA_DIR is local Hub path; do not inject remotely')
  })

  it('when remote hubUrl not reported: omit HELM_HUB_URL (never fall back to deps.hubUrl 127.0.0.1)', { timeout: 60_000 }, () => {
    const deps: HelmToolDeps = {
      dataDir: '/hub-data',
      defaultCwd: '/hub',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => t,
      artifacts: null as never,
      envFabric: (() => {
        const fabric = makeStubFabric(makeRecordingEnv({ canonical: (p) => p }).env)
        return { ...fabric, getNodeHubUrl: () => undefined }
      })(),
    }
    const managed = buildManagedEnv(deps, 'C:\\workspace', 3, 'node-no-url')
    assert.equal('HELM_HUB_URL' in managed, false, 'omit HELM_HUB_URL when unreported so daemon preserves its own URL')
  })
})

// ---------------------------------------------------------------------------
// 5. Windows host Path case preservation + LocalHostExecutionEnv rejecting WSL wrappers
// ---------------------------------------------------------------------------
describe('Windows host env case preservation and Shell probe anti-WSL-hijack', { timeout: 60_000 }, () => {
  it('composeExecutionEnv(win32): strips helm_token, preserves host Path casing and prepends cliBinDir under original key', { timeout: 60_000 }, () => {
    const env = composeExecutionEnv(
      'local',
      { HELM_CONVERSATION_ID: '12', HELM_TOKEN: 'managed-tok' },
      {},
      {
        platform: 'win32',
        cliBinDir: 'C:\\Users\\me\\.helm\\bin',
        hostEnv: {
          Path: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
          helm_token: 'stale-host-token',
          HELM_HUB_URL: 'http://stale',
        },
      },
    )
    const pathKeys = Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')
    assert.deepEqual(pathKeys, ['Path'], 'win32 must not introduce conflicting PATH/Path duplicate keys')
    assert.equal(
      env['Path'],
      'C:\\Users\\me\\.helm\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs',
    )
    assert.equal('helm_token' in env, false, 'case-variant helm_token must be stripped')
    assert.equal(env['HELM_TOKEN'], 'managed-tok')
    assert.equal('HELM_HUB_URL' in env, false, 'host-managed variables must be stripped')
  })

  it('createLocalExecutionEnv: yields shell_unavailable when only System32\\bash.exe exists; executes real bash after skipping WSL', { timeout: 60_000 }, async () => {
    const wslOnlyIo: ShellProbeIo = {
      platform: 'win32',
      env: {
        SystemRoot: 'C:\\Windows',
        ProgramFiles: 'C:\\Program Files',
        'ProgramFiles(x86)': 'C:\\Program Files (x86)',
        LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
        USERPROFILE: 'C:\\Users\\me',
      },
      homedir: () => 'C:\\Users\\me',
      pathExists: async (p) => p.toLowerCase() === 'c:\\windows\\system32\\bash.exe',
      realpath: async () => null,
      execProbe: async (_cmd, args) =>
        args[0] === 'bash.exe'
          ? { stdout: 'C:\\Windows\\System32\\bash.exe\r\n', status: 0 }
          : { stdout: '', status: 1 },
    }

    const wslOnlyEnv = createLocalExecutionEnv({ cwd: process.cwd(), shellProbeIo: wslOnlyIo })
    const blocked = await wslOnlyEnv.exec('echo hi', undefined, BACKGROUND_CONTEXT)
    assert.equal(blocked.ok, false)
    if (!blocked.ok) {
      assert.equal(blocked.error.code, 'shell_unavailable')
      assert.match(blocked.error.message, /Skipped WSL launcher\(s\): C:\\Windows\\System32\\bash\.exe/)
    }

    const realShell = existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh'
    const skippedWslIo: ShellProbeIo = {
      ...wslOnlyIo,
      pathExists: async (p) => p === realShell || p.toLowerCase() === 'c:\\windows\\system32\\bash.exe',
      execProbe: async (_cmd, args) =>
        args[0] === 'bash.exe'
          ? { stdout: `C:\\Windows\\System32\\bash.exe\r\n${realShell}\r\n`, status: 0 }
          : { stdout: '', status: 1 },
    }
    const okEnv = createLocalExecutionEnv({ cwd: process.cwd(), shellProbeIo: skippedWslIo })
    let output = ''
    const ran = await okEnv.exec(
      'printf ok',
      { onOutput: (chunk) => { output += chunk } },
      BACKGROUND_CONTEXT,
    )
    assert.equal(ran.ok, true)
    if (ran.ok) assert.equal(ran.value.exitCode, 0)
    assert.equal(output, 'ok')
  })
})
