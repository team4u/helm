/**
 * 跨平台路径形状测试：read/write/edit 的词法解析与 containment 按目标路径
 * 自身形状（POSIX / Windows 盘符 / UNC）选用纯 posix/win32 规则，绝不用
 * Hub 宿主 node:path 默认规则解析远端路径；containment 基准为根目录时不
 * 叠加分隔符；盘符相对路径（C:relative）一律拒绝。
 *
 * 诚实性原则：远端用受控 ExecutionEnv 记录真实收到的路径（绝不伪造完成
 * 结果）；local 用 POSIX 根目录语义下的真实文件读写与路径逃逸拒绝验证。
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
  isWithinBase,
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
    composeEnvOptions: () => Promise.resolve({}),
    ipcCall: () => {
      throw new Error('测试不使用 ipcCall')
    },
    ipcSubscribe: () => {
      throw new Error('测试不使用 ipcSubscribe')
    },
    getNodeHubUrl: () => 'http://10.0.0.5:3202',
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
describe('targetPathShape / isAbsoluteTargetPath / resolveTargetPath / isWithinBase', { timeout: 60_000 }, () => {
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
    assert.equal(isWithinBase('c:\\WORKSPACE\\note.md', 'C:\\workspace'), true, 'Windows 路径比较不区分大小写')
    assert.equal(isWithinBase('D:\\workspace\\note.md', 'C:\\workspace'), false, '不同卷不能视作子目录')
    assert.equal(isWithinBase('C:\\workspace-elsewhere\\note.md', 'C:\\workspace'), false, '相似前缀不属于基准目录')
    assert.equal(isWithinBase('C:\\workspace\\note.md', '/'), false, '不同平台形状不得混用')
  })

  it('resolveTargetPath：Linux Hub 上按 win32 规则解析 Windows 靶点（不用宿主 resolve）', { timeout: 60_000 }, () => {
    // Linux Hub 的 path.resolve('C:\\workspace', 'file.txt') 会产出
    // '<cwd>/C:\\workspace/file.txt'——本 helper 必须按 win32 规则得到真实形状。
    const r = resolveTargetPath('file.txt', 'C:\\workspace')
    assert.ok(r.ok)
    assert.equal(r.abs, 'C:\\workspace\\file.txt')
    const abs = resolveTargetPath('C:\\workspace\\inner\\file.txt', 'C:\\workspace')
    assert.ok(abs.ok)
    assert.equal(abs.abs, 'C:\\workspace\\inner\\file.txt')
    // 盘符相对拒绝
    const denied = resolveTargetPath('C:relative\\file.txt', 'C:\\workspace')
    assert.ok(!denied.ok)
  })

  it('isWithinBase：普通目录边界、根目录基准不叠加分隔符、win32 形状', { timeout: 60_000 }, () => {
    assert.equal(isWithinBase('/workspace/file.txt', '/workspace'), true)
    assert.equal(isWithinBase('/workspace', '/workspace'), true)
    assert.equal(isWithinBase('/workspace-evil/file.txt', '/workspace'), false, '前缀相似目录不得误判为包含')
    // 根目录基准：base + sep 会形成 '//' 错误前缀——根下合法文件必须通过。
    assert.equal(isWithinBase('/etc/hostname', '/'), true)
    assert.equal(isWithinBase('C:\\workspace\\file.txt', 'C:\\'), true)
    assert.equal(isWithinBase('C:\\workspace\\file.txt', 'C:\\workspace'), true)
    assert.equal(isWithinBase('D:\\workspace\\file.txt', 'C:\\workspace'), false)
    // UNC 基准
    assert.equal(isWithinBase('\\\\server\\share\\file.txt', '\\\\server\\share'), true)
    assert.equal(isWithinBase('\\\\server\\other\\file.txt', '\\\\server\\share'), false)
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
    assert.ok(paths.includes('C:\\workspace'), `canonicalPath 应收到会话 cwd 原样：${JSON.stringify(paths)}`)
    assert.ok(paths.includes('C:\\workspace\\note.md'), `readTextFile 应收到 win32 解析后的绝对路径：${JSON.stringify(paths)}`)
    const structured = result.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# 远端内容'))
  })

  it('read：Windows 靶点下 ../ 逃逸与 D: 绝对路径拒绝（win32 containment）', { timeout: 60_000 }, () => {
    return (async () => {
      const recorder = makeRecordingEnv({ canonical: (p) => p })
      const deps = await makeDeps(join(rootDir, 'r2'), {
        envFabric: makeStubFabric(recorder.env),
        nodeIdOf: () => 'win-node',
      })
      const tool = createReadTool(deps)
      for (const p of ['..\\secret.txt', 'D:\\elsewhere\\secret.txt', 'C:relative.txt']) {
        const result = await tool.execute({ path: p }, makeApi('C:\\workspace'), BACKGROUND_CONTEXT)
        assert.equal(result.isError, true, `路径 ${p} 应被拒绝`)
        const text = (result.output as Array<{ type: string; text: string }>)[0]!.text
        assert.ok(text.includes('path_escape_denied'), `${p} 应报 path_escape_denied：${text}`)
      }
      // 越界请求绝不触达远端 env（词法预检即拒）。
      assert.equal(recorder.calls.length, 0, '越界路径不得发起任何远端调用')
    })()
  })

  it('write：Windows 靶点新文件写入真实到达远端；越界与软链逃逸拒绝', { timeout: 60_000 }, async () => {
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
    // 越界绝不触达远端。
    const before = recorder.calls.length
    const denied = await tool.execute(
      { path: '..\\escape.txt', content: 'x' },
      makeApi('C:\\workspace'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(denied.isError, true)
    assert.equal(recorder.calls.length, before, '越界写入不得发起任何远端调用')
    // 软链逃逸：canonicalPath 返回 cwd 外真实路径时拒绝。
    const evilRecorder = makeRecordingEnv({
      canonical: (p) => (p === 'C:\\workspace\\link.txt' ? 'D:\\outside\\real.txt' : p),
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
    assert.equal(evil.isError, true)
    assert.ok(
      ((evil.output as Array<{ text: string }>)[0]!.text).includes('path_escape_denied'),
      '软链越界必须拒绝',
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

  it('POSIX 路径逃逸拒绝：../ 与越界绝对路径不触达本机 fs', { timeout: 60_000 }, async () => {
    const outer = join(rootDir, 'local2-outer')
    const inner = join(rootDir, 'local2')
    mkdirSync(outer, { recursive: true })
    mkdirSync(inner, { recursive: true })
    writeFileSync(join(outer, 'secret.txt'), 'outside')
    const deps = await makeDeps(inner)
    const read = await createReadTool(deps)
    for (const p of ['../secret.txt', join(outer, 'secret.txt'), 'C:\\Windows\\win.ini']) {
      const result = await read.execute({ path: p }, makeApi(inner), BACKGROUND_CONTEXT)
      assert.equal(result.isError, true, `路径 ${p} 应被拒绝`)
      assert.ok(
        ((result.output as Array<{ text: string }>)[0]!.text).includes('path_escape_denied'),
        `${p} 应报 path_escape_denied`,
      )
    }
    // 根目录基准（isWithinBase '/' 语义）：/etc/hostname 在词法 containment 内
    // 通过预检（后续 realpath containment 仍生效；此处验证根基准不因 '//' 误拒）。
    const rootRead = await read.execute({ path: '/etc/hostname' }, makeApi('/'), BACKGROUND_CONTEXT)
    const rootText = (rootRead.output as Array<{ text: string }>)[0]!.text
    assert.ok(!rootText.includes('path_escape_denied'), `根目录基准不得因 '//' 前缀误拒：${rootText}`)
  })

  it('根目录基准 write：/ 下合法新文件词法预检通过（不因 base 叠加分隔符误拒）', { timeout: 60_000 }, async () => {
    // 用受控 env 验证词法层（真实 / 不可写，权限错误是另一回事，不属于词法误拒）。
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
    assert.equal(!!result.isError, false, '根目录基准下的 cwd 内相对路径不得被误拒')
    assert.ok(recorder.calls.some((c) => c.path === '/etc/new.conf'))
  })

  it('远端父目录权限错误不得当作不存在放行写入（确定性错误分支）', { timeout: 60_000 }, async () => {
    const base = '/permission-root'
    const recorder = makeRecordingEnv({ canonical: (path) => path })
    recorder.env.canonicalPath = async (path) => {
      if (path === base) return { ok: true, value: base }
      return { ok: false, error: { code: path.endsWith('new.txt') ? 'not_found' : 'permission_denied', message: 'permission denied' } }
    }
    const deps = await makeDeps(join(rootDir, 'permission'), {
      envFabric: makeStubFabric(recorder.env), nodeIdOf: () => 'permission-node',
    })
    const result = await createWriteTool(deps).execute(
      { path: 'locked/new.txt', content: 'x' }, makeApi(base), BACKGROUND_CONTEXT,
    )
    assert.equal(result.isError, true)
    assert.match((result.output as Array<{ text: string }>)[0]!.text, /无权探测|permission denied|EACCES/)
    assert.equal(recorder.calls.some((call) => call.method === 'writeFile'), false, '权限拒绝时不能执行写入')
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
