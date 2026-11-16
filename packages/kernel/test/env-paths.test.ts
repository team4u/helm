/**
 * across platform path shape test:read/write/edit term method parse by target path itself shape
 * (POSIX / Windows symbol / UNC) choose use pure posix/win32 rule, never use Hub host
 * node:path by default rule parse remote path; symbol relative path (C:relative) one rule reject.
 * path contract (align pi): conversation cwd only act relative path base allow, absolute path and ../ across directory
 * access one rule allows (and bash same right, do not set cwd sandbox).
 *
 * honest principle: remote use subject to control ExecutionEnv record real receives path (never fabricate complete
 * result);local use POSIX directory semantics under real file read write verify.
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

/** subject to control ExecutionEnv: record real receives path and Context, never fabricate complete result. */
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
      // mutual exclusion queue key which must most small side (see env/file-mutation-queue.ts): constant etc.
      // absolutePath/joinPath + subject to control canonical; path shape by test self row control.
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

/** most small EnvFabric stub:envFor return subject to control env;isOnline constant true. */
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
// 1. pure path shape helper
// ---------------------------------------------------------------------------
describe('targetPathShape / isAbsoluteTargetPath / resolveTargetPath', { timeout: 60_000 }, () => {
  it('shape decide:POSIX absolute, symbol absolute,UNC, symbol each other for and relative path', { timeout: 60_000 }, () => {
    assert.equal(targetPathShape('/workspace/file.txt'), 'posix')
    assert.equal(targetPathShape('C:\\workspace\\file.txt'), 'win32')
    assert.equal(targetPathShape('c:/workspace/file.txt'), 'win32')
    assert.equal(targetPathShape('\\\\server\\share\\file.txt'), 'win32')
    assert.equal(targetPathShape('C:relative\\file.txt'), undefined, 'symbol each other for do not compute absolute shape')
    assert.equal(targetPathShape('relative/file.txt'), undefined)
    assert.equal(isAbsoluteTargetPath('/workspace'), true)
    assert.equal(isAbsoluteTargetPath('C:\\workspace'), true)
    assert.equal(isAbsoluteTargetPath('\\\\server\\share'), true)
    assert.equal(isAbsoluteTargetPath('C:relative'), false, 'symbol each other for is not absolute path')
    assert.equal(isAbsoluteTargetPath('relative'), false)
  })

  it('resolveTargetPath:Linux Hub on by win32 rule parse Windows target (do not use host resolve);cwd only act each other for base allow', { timeout: 60_000 }, () => {
    // Linux Hub  path.resolve('C:\\workspace', 'file.txt') will produce out
    // '<cwd>/C:\\workspace/file.txt'- - this helper must by win32 rule obtain to real shape.
    const r = resolveTargetPath('file.txt', 'C:\\workspace')
    assert.ok(r.ok)
    assert.equal(r.abs, 'C:\\workspace\\file.txt')
    const abs = resolveTargetPath('C:\\workspace\\inner\\file.txt', 'C:\\workspace')
    assert.ok(abs.ok)
    assert.equal(abs.abs, 'C:\\workspace\\inner\\file.txt')
    // new contract: absolute path (other) and ../ across directory all legal parse, do not set cwd sandbox.
    const otherDrive = resolveTargetPath('D:\\elsewhere\\file.txt', 'C:\\workspace')
    assert.ok(otherDrive.ok)
    assert.equal(otherDrive.abs, 'D:\\elsewhere\\file.txt')
    const escape = resolveTargetPath('..\\secret.txt', 'C:\\workspace')
    assert.ok(escape.ok)
    assert.equal(escape.abs, 'C:\\secret.txt')
    // symbol each other for reject (semantics dependency process when before directory, and new contract without closure determinism reject)
    const denied = resolveTargetPath('C:relative\\file.txt', 'C:\\workspace')
    assert.ok(!denied.ok)
  })
})

// ---------------------------------------------------------------------------
// 2. remote read/write/edit: subject to control ExecutionEnv record real receives Windows path
// ---------------------------------------------------------------------------
describe('remote file tool across platform path semantics (subject to control ExecutionEnv)', { timeout: 60_000 }, () => {
  it('read:Windows absolute target path original reach remote env(do not by Hub resolve pollute)', { timeout: 60_000 }, async () => {
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
      `remote receives path must be win32 shape (do not by Hub resolve pollute):${JSON.stringify(paths)}`,
    )
    assert.ok(paths.includes('C:\\workspace\\note.md'), `readTextFile should receives win32 parse after absolute path:${JSON.stringify(paths)}`)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# remote content'))
  })

  it('read:Windows target under ../ across directory and D: absolute path allows (and bash same right); symbol each other for reject', { timeout: 60_000 }, () => {
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
      // new contract:../ and across absolute path all reach remote and succeeded read (win32 rule parse).
      const dotdot = await tool.execute({ path: '..\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!dotdot.isError, false, '.. across directory should allows')
      assert.ok(((dotdot.structuredOutput as { content: string }).content).includes('escaped-via-dotdot'))
      const abs = await tool.execute({ path: 'D:\\elsewhere\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!abs.isError, false, 'across absolute path should allows')
      assert.ok(((abs.structuredOutput as { content: string }).content).includes('absolute-other-drive'))
      const seenPaths = recorder.calls.map((c) => c.path)
      assert.ok(seenPaths.includes('C:\\secret.txt'), `should receives win32 parse after ../ target:${JSON.stringify(seenPaths)}`)
      assert.ok(seenPaths.includes('D:\\elsewhere\\secret.txt'), `absolute path should original reach remote:${JSON.stringify(seenPaths)}`)
      // symbol relative path still reject (semantics dependency process when before directory), and never trigger reach remote env.
      const before = recorder.calls.length
      const denied = await tool.execute({ path: 'C:relative.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(denied.isError, true, 'symbol relative path should by reject')
      assert.ok(
        ((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'),
        `should report invalid_path:${(denied.output as Array<{ text: string }>)[0]!.text}`,
      )
      assert.equal(recorder.calls.length, before, 'symbol relative path must not start any remote invoke')
    })()
  })

  it('write:Windows target new file write real reach remote; symlink parse to real path after write', { timeout: 60_000 }, async () => {
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
    assert.ok(recorder.calls.some((c) => c.path === 'C:\\workspace\\src'), 'createDir should receives win32 dirname result')
    // ../ across directory write allows: term method parse after directly write target.
    const escaped = await tool.execute(
      { path: '..\\escape.txt', content: 'x' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!escaped.isError, false, '../ across directory write should allows')
    assert.equal(files.get('C:\\escape.txt'), 'x')
    // symlink:canonicalPath return cwd outside real path when, write to real path (and queue key align).
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
    assert.equal(!!evil.isError, false, 'symlink parse to real path after write should succeeded (and bash same right)')
    assert.ok(
      evilRecorder.calls.some((c) => c.method === 'writeFile' && c.path === 'D:\\outside\\real.txt'),
      'writeFile should to canonical parse after real path',
    )
  })

  it('edit:Windows target unique match replace real write back remote', { timeout: 60_000 }, async () => {
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

  it('cancel pass broadcast:abort signal reach remote file operation Context(do not only BACKGROUND_CONTEXT)', { timeout: 60_000 }, async () => {
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
    assert.ok(seen, 'remote readTextFile should by invoke')
    assert.equal(seen!.context.abortSignal, controller.signal, 'tool Context  abortSignal must original pass remote env invoke')
  })

  it('envFabric missing:remote node explicit env_fabric_missing, never fallthrough local', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'm1'), { nodeIdOf: () => 'remote-x' })
    // deps.envFabric not inject: remote operation must explicit failed, never read write Hub local machine disk.
    const localSentinel = join(rootDir, 'm1', 'sentinel.txt')
    const write = await createWriteTool(deps).execute(
      { path: 'sentinel.txt', content: 'must-not-exist' },
      makeApi(join(rootDir, 'm1')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(write.isError, true)
    assert.ok(
      ((write.output as Array<{ text: string }>)[0]!.text).includes('env_fabric_missing'),
      'envFabric missing should explicit errors',
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
      'envFabric missing when never fall back local machine write file',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. POSIX directory base allow: real file read write and path escape
// ---------------------------------------------------------------------------
describe('POSIX target real file behavior (directory and ordinary directory)', { timeout: 60_000 }, () => {
  it('local read/write/edit in real tmp directory read write succeeded (contains subdirectory create)', { timeout: 60_000 }, async () => {
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

  it('POSIX new contract:../ across directory and cwd outside absolute path real read succeeded; symbol each other for reject', { timeout: 60_000 }, async () => {
    const outer = join(rootDir, 'local2-outer')
    const inner = join(outer, 'work')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    const deps = await makeDeps(inner)
    const read = await createReadTool(deps)
    // new contract:cwd only act each other for base allow,../ and absolute path all and bash same right.
    for (const p of ['../secret.txt', join(outer, 'secret.txt')]) {
      const result = await read.execute({ path: p }, makeApi(inner), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `path ${p} should allows read`)
      assert.ok(
        ((result.structuredOutput as { content: string }).content).includes('outside'),
        `${p} should read to cwd outside content`,
      )
    }
    // symbol relative path still reject (semantics dependency process when before directory).
    const denied = await read.execute({ path: 'C:relative.txt' }, makeApi(inner), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    assert.ok(((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'))
    // directory base allow:/etc/hostname normal read.
    const rootRead = await read.execute({ path: '/etc/hostname' }, makeApi('/'), BACKGROUND_CONTEXT)
    assert.equal(!!rootRead.isError, false, 'directory base allow under absolute path should normal read')
  })

  it('directory base allow write:/ under new file write succeeded (cwd only act each other for base allow)', { timeout: 60_000 }, async () => {
    // use subject to control env verify (real / cannot write, permission error belongs to OS boundary, is not term method reject).
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
    assert.equal(!!result.isError, false, 'directory base allow under relative path must not by mistakenly refuse')
    assert.ok(recorder.calls.some((c) => c.path === '/etc/new.conf'))
  })
})

// ---------------------------------------------------------------------------
// 4. env group install: remote do not together into by default PATH,hubUrl guard constant,delimiter
// ---------------------------------------------------------------------------
describe('buildToolEnv / buildManagedEnv remote semantics', { timeout: 60_000 }, () => {
  it('remote: do not together into by default PATH(extraEnv not provide PATH when do not inject);HELM_HUB_URL use node on report value', { timeout: 60_000 }, () => {
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
    assert.equal(remoteEnv['PATH'], undefined, 'remote never together into by default PATH(node daemon already pre- real tool chain)')
    assert.equal(remoteEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', 'use node register on report real hubUrl')
    assert.equal(remoteEnv['HELM_CWD'], 'C:\\workspace')
    assert.equal(remoteEnv['HELM_NODE_ID'], 'win-node')
    assert.equal('HELM_DATA_DIR' in remoteEnv, false, 'HELM_DATA_DIR is Hub local machine path, do not inject remote')
  })

  it('remote hubUrl not on report: omit HELM_HUB_URL(never fallback deps.hubUrl  127.0.0.1)', { timeout: 60_000 }, () => {
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
    assert.equal('HELM_HUB_URL' in managed, false, 'not on report hubUrl when omit the key,daemon keep its real value')
  })
})

// ---------------------------------------------------------------------------
// 5. Windows host Path large small write keep + LocalHostExecutionEnv refuse WSL
// ---------------------------------------------------------------------------
describe('Windows host env large small write keep and Shell probe guard against WSL hijack', { timeout: 60_000 }, () => {
  it('composeExecutionEnv(win32): strip except helm_token, keep host Path and in original key pre- cliBinDir', { timeout: 60_000 }, () => {
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
    assert.deepEqual(pathKeys, ['Path'], 'win32 must not generate conflict PATH/Path double key')
    assert.equal(
      env['Path'],
      'C:\\Users\\me\\.helm\\bin;C:\\Windows\\System32;C:\\Program Files\\nodejs',
    )
    assert.equal('helm_token' in env, false, 'large small write change body helm_token must strip except')
    assert.equal(env['HELM_TOKEN'], 'managed-tok')
    assert.equal('HELM_HUB_URL' in env, false, 'host managed variable must strip except')
  })

  it('createLocalExecutionEnv: only store System32\\bash.exe when explicit shell_unavailable; skip WSL after can execute real bash', { timeout: 60_000 }, async () => {
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
