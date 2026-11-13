/**
 * 跨平台路径形状测试：read/write/edit 的词法解析按目标路径自身形状
 * （POSIX / Windows 盘符 / UNC）选用纯 posix/win32 规则，绝不用 Hub 宿主
 * node:path 默认规则解析远端路径；盘符相对路径（C:relative）一律拒绝。
 * 路径契约（对齐 pi）：会话 cwd 仅作相对路径基准，绝对路径与 ../ 跨目录
 * 访问一律允许（与 bash 同权，不设 cwd 沙箱）。
 *
 * 诚实性原则：远端用受控 ExecutionEnv 记录真实收到的路径（绝不伪造完成
 * 结果）；local 用 POSIX 根目录语义下的真实文件读写验证。
 */

import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
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

/** 受控 ExecutionEnv：记录真实收到的路径与 Context，绝不伪造完成结果。 */
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
      // 互斥队列 key 所需的最小面（见 env/file-mutation-queue.ts）：恒等
      // absolutePath/joinPath + 受控 canonical；路径形状由测试自行控制。
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

/** 最小 EnvFabric 桩：envFor 返回受控 env；isOnline 恒真。 */
function makeStubFabric(env: ReturnType<typeof makeRecordingEnv>['env']): EnvFabric {
  return {
    registry: {} as never,
    envFor: () => env as never,
    envForTarget: () => {
      throw new Error('测试不使用 envForTarget')
    },
    isOnline: () => true,
    waitForOnline: () => Promise.resolve(true),
    getNodeHubUrl: () => 'http://10.0.0.5:3202',
    evictConversation: () => undefined,
    debugBaseCount: () => 0,
    debugBases: () => [],
    ipcCall: () => {
      throw new Error('测试不使用 ipcCall')
    },
    ipcSubscribe: () => {
      throw new Error('测试不使用 ipcSubscribe')
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

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-env-paths-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 纯路径形状 helper
// ---------------------------------------------------------------------------
describe('targetPathShape / isAbsoluteTargetPath / resolveTargetPath', { timeout: 60_000 }, () => {
  it('形状判定：POSIX 绝对、盘符绝对、UNC、盘符相对与相对路径', { timeout: 60_000 }, () => {
    assert.equal(targetPathShape('/workspace/file.txt'), 'posix')
    assert.equal(targetPathShape('C:\\workspace\\file.txt'), 'win32')
    assert.equal(targetPathShape('c:/workspace/file.txt'), 'win32')
    assert.equal(targetPathShape('\\\\server\\share\\file.txt'), 'win32')
    assert.equal(targetPathShape('C:relative\\file.txt'), undefined, '盘符相对不算绝对形状')
    assert.equal(targetPathShape('relative/file.txt'), undefined)
    assert.equal(isAbsoluteTargetPath('/workspace'), true)
    assert.equal(isAbsoluteTargetPath('C:\\workspace'), true)
    assert.equal(isAbsoluteTargetPath('\\\\server\\share'), true)
    assert.equal(isAbsoluteTargetPath('C:relative'), false, '盘符相对不是绝对路径')
    assert.equal(isAbsoluteTargetPath('relative'), false)
  })

  it('resolveTargetPath：Linux Hub 上按 win32 规则解析 Windows 靶点（不用宿主 resolve）；cwd 仅作相对基准', { timeout: 60_000 }, () => {
    // Linux Hub 的 path.resolve('C:\\workspace', 'file.txt') 会产出
    // '<cwd>/C:\\workspace/file.txt'——本 helper 必须按 win32 规则得到真实形状。
    const r = resolveTargetPath('file.txt', 'C:\\workspace')
    assert.ok(r.ok)
    assert.equal(r.abs, 'C:\\workspace\\file.txt')
    const abs = resolveTargetPath('C:\\workspace\\inner\\file.txt', 'C:\\workspace')
    assert.ok(abs.ok)
    assert.equal(abs.abs, 'C:\\workspace\\inner\\file.txt')
    // 新契约：绝对路径（其他盘）与 ../ 跨目录均合法解析，不设 cwd 沙箱。
    const otherDrive = resolveTargetPath('D:\\elsewhere\\file.txt', 'C:\\workspace')
    assert.ok(otherDrive.ok)
    assert.equal(otherDrive.abs, 'D:\\elsewhere\\file.txt')
    const escape = resolveTargetPath('..\\secret.txt', 'C:\\workspace')
    assert.ok(escape.ok)
    assert.equal(escape.abs, 'C:\\secret.txt')
    // 盘符相对拒绝（语义依赖进程当前目录，与新契约无关的确定性拒绝）
    const denied = resolveTargetPath('C:relative\\file.txt', 'C:\\workspace')
    assert.ok(!denied.ok)
  })
})

// ---------------------------------------------------------------------------
// 2. 远端 read/write/edit：受控 ExecutionEnv 记录真实收到的 Windows 路径
// ---------------------------------------------------------------------------
describe('远端文件工具的跨平台路径语义（受控 ExecutionEnv）', { timeout: 60_000 }, () => {
  it('read：Windows 绝对靶点路径原样到达远端 env（不被 Hub resolve 污染）', { timeout: 60_000 }, async () => {
    const files = new Map<string, string>([['C:\\workspace\\note.md', '# 远端内容']])
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
      `远端收到的路径必须是 win32 形状（不被 Hub resolve 污染）：${JSON.stringify(paths)}`,
    )
    assert.ok(paths.includes('C:\\workspace\\note.md'), `readTextFile 应收到 win32 解析后的绝对路径：${JSON.stringify(paths)}`)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# 远端内容'))
  })

  it('read：Windows 靶点下 ../ 跨目录与 D: 绝对路径允许（与 bash 同权）；盘符相对拒绝', { timeout: 60_000 }, () => {
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
      // 新契约：../ 与跨盘绝对路径均到达远端并成功读取（win32 规则解析）。
      const dotdot = await tool.execute({ path: '..\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!dotdot.isError, false, '.. 跨目录应允许')
      assert.ok(((dotdot.structuredOutput as { content: string }).content).includes('escaped-via-dotdot'))
      const abs = await tool.execute({ path: 'D:\\elsewhere\\secret.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(!!abs.isError, false, '跨盘绝对路径应允许')
      assert.ok(((abs.structuredOutput as { content: string }).content).includes('absolute-other-drive'))
      const seenPaths = recorder.calls.map((c) => c.path)
      assert.ok(seenPaths.includes('C:\\secret.txt'), `应收到 win32 解析后的 ../ 目标：${JSON.stringify(seenPaths)}`)
      assert.ok(seenPaths.includes('D:\\elsewhere\\secret.txt'), `绝对路径应原样到达远端：${JSON.stringify(seenPaths)}`)
      // 盘符相对路径仍拒绝（语义依赖进程当前目录），且绝不触达远端 env。
      const before = recorder.calls.length
      const denied = await tool.execute({ path: 'C:relative.txt' }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
      assert.equal(denied.isError, true, '盘符相对路径应被拒绝')
      assert.ok(
        ((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'),
        `应报 invalid_path：${(denied.output as Array<{ text: string }>)[0]!.text}`,
      )
      assert.equal(recorder.calls.length, before, '盘符相对路径不得发起任何远端调用')
    })()
  })

  it('write：Windows 靶点新文件写入真实到达远端；软链解析到真实路径后写入', { timeout: 60_000 }, async () => {
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
    assert.ok(recorder.calls.some((c) => c.path === 'C:\\workspace\\src'), 'createDir 应收到 win32 dirname 结果')
    // ../ 跨目录写入允许：词法解析后直接写入目标。
    const escaped = await tool.execute(
      { path: '..\\escape.txt', content: 'x' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!escaped.isError, false, '../ 跨目录写入应允许')
    assert.equal(files.get('C:\\escape.txt'), 'x')
    // 软链：canonicalPath 返回 cwd 外真实路径时，写入落到真实路径（与队列 key 对齐）。
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
    assert.equal(!!evil.isError, false, '软链解析到真实路径后写入应成功（与 bash 同权）')
    assert.ok(
      evilRecorder.calls.some((c) => c.method === 'writeFile' && c.path === 'D:\\outside\\real.txt'),
      'writeFile 应落到 canonical 解析后的真实路径',
    )
  })

  it('edit：Windows 靶点唯一匹配替换真实写回远端', { timeout: 60_000 }, async () => {
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

  it('cancel 传播：abort signal 到达远端文件操作的 Context（不只 BACKGROUND_CONTEXT）', { timeout: 60_000 }, async () => {
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
    assert.ok(seen, '远端 readTextFile 应被调用')
    assert.equal(seen!.context.abortSignal, controller.signal, '工具 Context 的 abortSignal 必须原样传入远端 env 调用')
  })

  it('envFabric 缺失：remote node 显式 env_fabric_missing，绝不 fallthrough local', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'm1'), { nodeIdOf: () => 'remote-x' })
    // deps.envFabric 未注入：远端操作必须显式失败，绝不读写 Hub 本机磁盘。
    const localSentinel = join(rootDir, 'm1', 'sentinel.txt')
    const write = await createWriteTool(deps).execute(
      { path: 'sentinel.txt', content: 'must-not-exist' },
      makeApi(join(rootDir, 'm1')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(write.isError, true)
    assert.ok(
      ((write.output as Array<{ text: string }>)[0]!.text).includes('env_fabric_missing'),
      'envFabric 缺失应显式报错',
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
      'envFabric 缺失时绝不回退本机写文件',
    )
  })
})

// ---------------------------------------------------------------------------
// 3. POSIX 根目录基准：真实文件读写与路径逃逸
// ---------------------------------------------------------------------------
describe('POSIX 靶点真实文件行为（根目录与普通目录）', { timeout: 60_000 }, () => {
  it('local read/write/edit 在真实 tmp 目录读写成功（含子目录创建）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local1')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    writeFileSync(join(dir, 'note.md'), '# hello')
    const deps = await makeDeps(dir)
    const read = await createReadTool(deps).execute({ path: 'note.md' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!read.isError, false)
    assert.ok(((read.structuredOutput as { content: string }).content).includes('# hello'))
    const write = await createWriteTool(deps).execute(
      { path: 'sub/deep/file.txt', content: '内容' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!write.isError, false)
    assert.equal(readFileSync(join(dir, 'sub', 'deep', 'file.txt'), 'utf8'), '内容')
    const edit = await createEditTool(deps).execute(
      { path: 'note.md', oldText: 'hello', newText: 'world' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!edit.isError, false)
    assert.equal(readFileSync(join(dir, 'note.md'), 'utf8'), '# world')
  })

  it('POSIX 新契约：../ 跨目录与 cwd 外绝对路径真实读取成功；盘符相对拒绝', { timeout: 60_000 }, async () => {
    const outer = join(rootDir, 'local2-outer')
    const inner = join(outer, 'work')
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    const deps = await makeDeps(inner)
    const read = await createReadTool(deps)
    // 新契约：cwd 仅作相对基准，../ 与绝对路径均与 bash 同权。
    for (const p of ['../secret.txt', join(outer, 'secret.txt')]) {
      const result = await read.execute({ path: p }, makeApi(inner), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `路径 ${p} 应允许读取`)
      assert.ok(
        ((result.structuredOutput as { content: string }).content).includes('outside'),
        `${p} 应读到 cwd 外内容`,
      )
    }
    // 盘符相对路径仍拒绝（语义依赖进程当前目录）。
    const denied = await read.execute({ path: 'C:relative.txt' }, makeApi(inner), BACKGROUND_CONTEXT)
    assert.equal(denied.isError, true)
    assert.ok(((denied.output as Array<{ text: string }>)[0]!.text).includes('invalid_path'))
    // 根目录基准：/etc/hostname 正常读取。
    const rootRead = await read.execute({ path: '/etc/hostname' }, makeApi('/'), BACKGROUND_CONTEXT)
    assert.equal(!!rootRead.isError, false, '根目录基准下绝对路径应正常读取')
  })

  it('根目录基准 write：/ 下新文件写入成功（cwd 仅作相对基准）', { timeout: 60_000 }, async () => {
    // 用受控 env 验证（真实 / 不可写，权限错误属于操作系统边界，不是词法拒绝）。
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
    assert.equal(!!result.isError, false, '根目录基准下的相对路径不得被误拒')
    assert.ok(recorder.calls.some((c) => c.path === '/etc/new.conf'))
  })
})

// ---------------------------------------------------------------------------
// 4. env 组装：远端不合成默认 PATH、hubUrl 守恒、delimiter
// ---------------------------------------------------------------------------
describe('buildToolEnv / buildManagedEnv 远端语义', { timeout: 60_000 }, () => {
  it('远端：不合成默认 PATH（extraEnv 未提供 PATH 时不注入）；HELM_HUB_URL 用节点上报值', { timeout: 60_000 }, () => {
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
    assert.equal(remoteEnv['PATH'], undefined, '远端绝不合成默认 PATH（节点 daemon 已前置真实工具链）')
    assert.equal(remoteEnv['HELM_HUB_URL'], 'http://10.0.0.5:3202', '用节点注册上报的真实 hubUrl')
    assert.equal(remoteEnv['HELM_CWD'], 'C:\\workspace')
    assert.equal(remoteEnv['HELM_NODE_ID'], 'win-node')
    assert.equal('HELM_DATA_DIR' in remoteEnv, false, 'HELM_DATA_DIR 是 Hub 本机路径，不注入远端')
  })

  it('远端 hubUrl 未上报：省略 HELM_HUB_URL（绝不 fallback deps.hubUrl 的 127.0.0.1）', { timeout: 60_000 }, () => {
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
    assert.equal('HELM_HUB_URL' in managed, false, '未上报 hubUrl 时省略该键，daemon 保持其真实值')
  })
})
