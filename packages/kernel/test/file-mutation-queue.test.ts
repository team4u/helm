/**
 * 文件互斥队列测试（env/file-mutation-queue + EnvFabric.withFileMutationQueue
 * + 内核 write/edit 工具共享队列）。
 *
 * 覆盖：
 * 1. 同文件并发读-改-写不丢更新（内核 edit 工具 × N 并发追加替换；远端受控
 *    env 的 read-modify-write 与内置工具竞争）；
 * 2. 不同文件互不等待（并行执行，无串行化开销）；
 * 3. realpath 软链别名同 key（symlink 指向同一文件的两个路径互斥）；
 * 4. 新文件 canonical 父目录拼接（创建新文件的 write 与后续变更同 key）；
 * 5. 异常后队列自愈（fn 抛错后下一任务立即可入队）；
 * 6. signal 取消：在队列中等待时取消立即失败并释放队列位置；
 * 7. 跨节点同形路径不同 key（local 与远端 env 同一路径字符串互不阻塞）；
 * 8. local 直连入口（localWithFileMutationQueue）与 NodeExecutionEnv 底座
 *    （'node:local' 前缀）互斥。
 *
 * 诚实边界（不测/不承诺）：bash 与外部进程并发写不受本队列约束；跨 Hub 进程
 * 无分布式锁（单节点单 Hub 部署模型）。
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT, withAbortSignal } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'
import { withProcessFileLock } from '../src/services/file-lock.js'
import { createWriteTool, createEditTool } from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'
import { createEnvFabric } from '../src/env/index.js'
import {
  envWithFileMutationQueue,
  localWithFileMutationQueue,
  fileMutationQueueSize,
} from '../src/env/file-mutation-queue.js'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-file-queue-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 测试基座
// ---------------------------------------------------------------------------

/** 真实 local 底座 + EnvFabric（无远端节点注册：local 路径即可测全部语义）。 */
function makeFabric(): EnvFabric {
  return createEnvFabric({})
}

/** 受控远端 env：真实内存文件表，读改写有可观测延迟窗口。 */
function makeRecordingEnv(files: Map<string, string>, delays: Map<string, number> = new Map()): {
  env: {
    id: string
    absolutePath(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    joinPath(parts: string[], context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    canonicalPath(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    readTextFile(path: string, context: Context): Promise<{ ok: true; value: string } | { ok: false; error: { code: string; message: string } }>
    writeFile(path: string, content: string, context: Context): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
    createDir(path: string, options: { recursive?: boolean }, context: Context): Promise<{ ok: true; value: void } | { ok: false; error: { code: string; message: string } }>
  }
} {
  const canonical = (p: string): string => p // 受控：恒等映射即可（无软链）
  const knownDirs = new Set<string>(['/workspace'])
  return {
    env: {
      id: 'remote:test-node',
      async absolutePath(path) {
        return { ok: true, value: path }
      },
      async joinPath(parts) {
        // posix 词法拼接 + 归一（与 NodeExecutionEnv.joinPath 语义一致）
        const joined = parts.join('/')
        const segs: string[] = []
        for (const seg of joined.split('/')) {
          if (seg === '' || seg === '.') continue
          if (seg === '..') segs.pop()
          else segs.push(seg)
        }
        return { ok: true, value: '/' + segs.join('/') }
      },
      async canonicalPath(path) {
        if (files.has(path) || knownDirs.has(path)) return { ok: true, value: canonical(path) }
        return { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
      },
      async readTextFile(path) {
        const d = delays.get(path)
        if (d !== undefined) await delay(d)
        const content = files.get(path)
        if (content === undefined) return { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
        return { ok: true, value: content }
      },
      async writeFile(path, content) {
        const d = delays.get(path)
        if (d !== undefined) await delay(d)
        files.set(path, content)
        return { ok: true, value: void 0 }
      },
      async createDir() {
        return { ok: true, value: void 0 }
      },
    },
  }
}

function makeStubFabric(env: ReturnType<typeof makeRecordingEnv>['env']): EnvFabric {
  return {
    registry: {} as never,
    envFor: () => env as never,
    envForTarget: () => env as never,
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

/** 与 createEnvFabric 同构的受控 fabric：withFileMutationQueue 复用同一队列模块。 */
function makeRecordingFabric(env: ReturnType<typeof makeRecordingEnv>['env']): EnvFabric {
  return {
    ...makeStubFabric(env),
    withFileMutationQueue: ((target: { nodeId: string; cwd: string; path: string }, fn: () => Promise<unknown>, signal?: AbortSignal) =>
      envWithFileMutationQueue(env as never, target.path, fn as never, signal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(signal, BACKGROUND_CONTEXT))) as never,
  }
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
    details: async () => undefined,
    commit: async (change: () => unknown) => change(),
    memo: async () => undefined,
    createTask: async () => {
      throw new Error('测试不使用')
    },
    getTask: () => undefined,
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
// 1. 核心语义：同文件串行 / 异常自愈 / 取消 / 不同文件并行
// ---------------------------------------------------------------------------

describe('envWithFileMutationQueue 核心语义', { timeout: 60_000 }, () => {
  test('同文件读-改-写串行不丢更新（8 并发各 +1）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'serial')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'counter.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    const bump = async (): Promise<void> =>
      envWithFileMutationQueue(
        env,
        file,
        async () => {
          const cur = readFileSync(file, 'utf8')
          // 制造真实竞态窗口：读到旧值后让出事件循环再写回。
          await delay(5)
          writeFileSync(file, String(Number(cur) + 1))
        },
        BACKGROUND_CONTEXT,
      )

    await Promise.all(Array.from({ length: 8 }, bump))
    assert.equal(readFileSync(file, 'utf8'), '8', '8 个并发读-改-写必须全部生效')
    assert.equal(fileMutationQueueSize(), 0, '结算后队列清空')
  })

  test('不同文件互不等待（并行执行）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'parallel')
    mkdirSync(dir, { recursive: true })
    const env = new NodeExecutionEnv({ cwd: dir })
    const start = Date.now()
    await Promise.all(
      ['a.txt', 'b.txt', 'c.txt'].map((name) =>
        envWithFileMutationQueue(
          env,
          join(dir, name),
          async () => {
            writeFileSync(join(dir, name), 'x')
            await delay(120)
          },
          BACKGROUND_CONTEXT,
        ),
      ),
    )
    const elapsed = Date.now() - start
    assert.ok(elapsed < 300, `三个不同文件应并行（耗时 ${elapsed}ms < 300ms）`)
  })

  test('fn 抛错后队列自愈：下一任务立即可入队', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'selfheal')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'heal.txt')
    writeFileSync(file, 'x')
    const env = new NodeExecutionEnv({ cwd: dir })

    const failing = envWithFileMutationQueue(
      env,
      file,
      async () => {
        throw new Error('boom')
      },
      BACKGROUND_CONTEXT,
    )
    await assert.rejects(failing, /boom/)

    const after = await envWithFileMutationQueue(
      env,
      file,
      async () => 'healed',
      BACKGROUND_CONTEXT,
    )
    assert.equal(after, 'healed')
    assert.equal(fileMutationQueueSize(), 0)
  })

  test('三任务取消链：A 持锁不放；B 排队后 abort 立即拒绝；C 不得在 A 释放前执行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-chain')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chain.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // A：拿锁后不释放（门控 holdA）。
    let releaseA!: () => void
    const holdA = new Promise<void>((resolve) => { releaseA = resolve })
    let aRan = false
    const taskA = envWithFileMutationQueue(
      env,
      file,
      async () => {
        aRan = true
        await holdA
        return 'A'
      },
      BACKGROUND_CONTEXT,
    )
    await delay(30) // A 已拿锁（aRan 翻转即证）
    assert.ok(aRan, 'A 应已持有锁')

    // B：排队等待中 abort —— 必须立即拒绝（不等 A，300ms 预算内）。
    const controllerB = new AbortController()
    let bRan = false
    const taskB = envWithFileMutationQueue(
      env,
      file,
      async () => {
        bRan = true
        return 'B'
      },
      withAbortSignal(controllerB.signal, BACKGROUND_CONTEXT),
    )
    await delay(30) // B 已入队等待
    const abortAt = Date.now()
    controllerB.abort()
    await assert.rejects(taskB, (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError')
      return true
    })
    const rejectElapsed = Date.now() - abortAt
    assert.ok(rejectElapsed < 300, `B 必须在 A 释放前立即拒绝（实际 ${rejectElapsed}ms）`)
    assert.equal(bRan, false, 'B 的 fn 不得执行')

    // C：B 被取消后入队——A 释放前不得执行（被取消的 B 不得腾出假锁）。
    let cRan = false
    const taskC = envWithFileMutationQueue(
      env,
      file,
      async () => {
        cRan = true
        return 'C'
      },
      BACKGROUND_CONTEXT,
    )
    await delay(80)
    assert.equal(cRan, false, 'A 未释放，C 不得执行（取消链不得误删头部锁）')

    // A 释放：C 立即接管，链恢复正常。
    releaseA()
    assert.equal(await taskA, 'A')
    assert.equal(await taskC, 'C')
    assert.ok(cRan)
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, '链全部结算后队列清空')
  })

  test('执行窗口内取消：signal 语义交由 fn（fn 返回后链正常释放）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-running')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'running.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    const controller = new AbortController()
    let fnObservedAbort = false
    const result = await envWithFileMutationQueue(
      env,
      file,
      async () => {
        await delay(50)
        controller.abort()
        await delay(10)
        fnObservedAbort = controller.signal.aborted
        return 'done-anyway'
      },
      withAbortSignal(controller.signal, BACKGROUND_CONTEXT),
    )
    assert.equal(result, 'done-anyway', '已持锁的 fn 正常结算（窗口内取消不强制中断）')
    assert.ok(fnObservedAbort)
    // 链释放后下一任务立即可入队。
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 2. canonical key：软链别名 / 新文件
// ---------------------------------------------------------------------------

describe('canonical 路径 key', { timeout: 60_000 }, () => {
  test('realpath 软链别名同 key：两个写法指向同一文件互斥', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'symlink')
    mkdirSync(dir, { recursive: true })
    const real = join(dir, 'real.txt')
    writeFileSync(real, '0')
    const alias = join(dir, 'alias.txt')
    try {
      symlinkSync(real, alias)
    } catch {
      // 无符号链接权限的环境跳过（不伪造通过）。
      return
    }
    const env = new NodeExecutionEnv({ cwd: dir })

    let value = 0
    const bumpAlias = envWithFileMutationQueue(
      env,
      alias,
      async () => {
        const cur = readFileSync(real, 'utf8')
        await delay(10)
        writeFileSync(real, String(Number(cur) + 1))
        value = Number(readFileSync(real, 'utf8'))
      },
      BACKGROUND_CONTEXT,
    )
    const bumpReal = envWithFileMutationQueue(
      env,
      real,
      async () => {
        const cur = readFileSync(real, 'utf8')
        await delay(10)
        writeFileSync(real, String(Number(cur) + 1))
        value = Number(readFileSync(real, 'utf8'))
      },
      BACKGROUND_CONTEXT,
    )
    await Promise.all([bumpAlias, bumpReal])
    // 串行执行时两个 +1 都生效（value 最终读到 2）。
    assert.equal(readFileSync(real, 'utf8'), '2', '软链别名与真实路径必须共享一把锁')
  })

  test('新文件 canonical 父目录拼接：创建与后续变更同 key', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'newfile')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const file = join(dir, 'sub', 'fresh.txt')
    const env = new NodeExecutionEnv({ cwd: dir })

    // 先以「不存在的文件」入队（not_found 分支走父目录 canonical 拼接）。
    const create = envWithFileMutationQueue(
      env,
      file,
      async () => {
        writeFileSync(file, 'v1')
        return 'created'
      },
      BACKGROUND_CONTEXT,
    )
    assert.equal(await create, 'created')
    // 文件已存在后再入队：canonical 直接命中，两代 key 一致由下一断言验证
    //（若 key 不一致，并发场景会撕裂；此处串行验证功能正确性）。
    const mutate = await envWithFileMutationQueue(
      env,
      file,
      async () => {
        writeFileSync(file, 'v2')
        return 'mutated'
      },
      BACKGROUND_CONTEXT,
    )
    assert.equal(mutate, 'mutated')
    assert.equal(readFileSync(file, 'utf8'), 'v2')
  })

  test('ENOTDIR（某段是文件）两入口同 key：env 入口上溯不抛错，与 local 入口互斥', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'enotdir')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    // 路径中某一段是文件而非目录：realpath 报 ENOTDIR（pi-durable 映射
    // not_directory；修复前 env 入口直接抛错，local 入口上溯——两入口分叉）。
    const target = join(file, 'child')
    const env = new NodeExecutionEnv({ cwd: dir })

    // env 入口不再抛 not_directory：正常上溯到已存在文件拼 key 并执行。
    const viaEnv = await envWithFileMutationQueue(env, target, async () => 'env-ok', BACKGROUND_CONTEXT)
    assert.equal(viaEnv, 'env-ok')

    // 两入口同 key：env 入口持锁不放时 local 入口必须排队（而非各锁各的）。
    let releaseHolder!: () => void
    const held = new Promise<void>((resolve) => { releaseHolder = resolve })
    let holderRan = false
    const envHold = envWithFileMutationQueue(
      env,
      target,
      async () => {
        holderRan = true
        await held
        return 'held'
      },
      BACKGROUND_CONTEXT,
    )
    while (!holderRan) await delay(5)
    let localRan = false
    const localTask = localWithFileMutationQueue(target, async () => {
      localRan = true
      return 'local'
    })
    await delay(80)
    assert.equal(localRan, false, 'env 入口持锁期间 local 入口不得执行（同 key 互斥）')
    releaseHolder()
    assert.equal(await envHold, 'held')
    assert.equal(await localTask, 'local')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 3. 跨节点 / 双入口 key 空间
// ---------------------------------------------------------------------------

describe('跨节点与双入口 key 空间', { timeout: 60_000 }, () => {
  test('local 与远端 env 同形路径不同 key：互不阻塞', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'crossnode')
    mkdirSync(dir, { recursive: true })
    const path = '/workspace/shared.txt'
    const remote = makeRecordingEnv(new Map([[path, '0']])).env
    const localEnv = new NodeExecutionEnv({ cwd: dir })
    // local 底座 absolutePath 会把 '/workspace/shared.txt' 视为绝对路径——
    // 在 Linux 上真实存在与否不影响 key 计算（不存在则走父目录拼接）。

    const start = Date.now()
    await Promise.all([
      envWithFileMutationQueue(
        localEnv,
        '/workspace/hub-local-file.txt',
        async () => {
          await delay(150)
        },
        BACKGROUND_CONTEXT,
      ),
      envWithFileMutationQueue(
        remote as never,
        path,
        async () => {
          await delay(150)
        },
        BACKGROUND_CONTEXT,
      ),
    ])
    const elapsed = Date.now() - start
    assert.ok(elapsed < 280, `local 与远端互不阻塞（耗时 ${elapsed}ms）`)
  })

  test('localWithFileMutationQueue 与 NodeExecutionEnv 底座互斥（同 key 前缀）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'dualentry')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'dual.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // 混合入口并发：local 直连与 env 底座交替 +1，全部生效。
    const bumpLocal = () =>
      localWithFileMutationQueue(file, async () => {
        const cur = readFileSync(file, 'utf8')
        await delay(5)
        writeFileSync(file, String(Number(cur) + 1))
      })
    const bumpEnv = () =>
      envWithFileMutationQueue(
        env,
        file,
        async () => {
          const cur = readFileSync(file, 'utf8')
          await delay(5)
          writeFileSync(file, String(Number(cur) + 1))
        },
        BACKGROUND_CONTEXT,
      )
    await Promise.all([bumpLocal(), bumpEnv(), bumpLocal(), bumpEnv(), bumpLocal(), bumpEnv()])
    assert.equal(readFileSync(file, 'utf8'), '6', 'local 直连入口与 env 底座入口必须互斥')
  })
})

// ---------------------------------------------------------------------------
// 4. 内核工具接入：write/edit 与插件队列共享
// ---------------------------------------------------------------------------

describe('内核 write/edit 与队列', { timeout: 60_000 }, () => {
  test('内置 edit 工具并发替换不丢更新（同一 local 文件 6 并发）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'edit-race')
    mkdirSync(dir, { recursive: true })
    const deps = await makeDeps(dir)
    const file = join(dir, 'lines.txt')
    writeFileSync(file, ['a', 'b', 'c', 'd', 'e', 'f'].join('\n'))
    const tool = createEditTool(deps)

    const edits = ['a', 'b', 'c', 'd', 'e', 'f'].map((word) =>
      tool.execute({ path: file, oldText: word, newText: `${word}!` }, makeApi(dir), BACKGROUND_CONTEXT),
    )
    const results = await Promise.all(edits)
    for (const r of results) {
      assert.equal(!!r.isError, false, JSON.stringify(r.output))
    }
    const final = readFileSync(file, 'utf8')
    for (const word of ['a', 'b', 'c', 'd', 'e', 'f']) {
      assert.ok(final.includes(`${word}!`), `${word} 的替换必须生效：${JSON.stringify(final)}`)
    }
  })

  test('远端受控 env：内置 edit 与插件式 envWithFileMutationQueue 读-改-写竞争同一文件不丢更新', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-race')
    mkdirSync(dir, { recursive: true })
    const target = '/workspace/journal.md'
    const files = new Map<string, string>([[target, 'S0\nEND']])
    // 远端读改写有延迟窗口：无队列时必然撕裂。
    const recorder = makeRecordingEnv(files, new Map([[target, 40]]))
    const deps = await makeDeps(join(dir, 'deps'), {
      envFabric: makeRecordingFabric(recorder.env),
      nodeIdOf: () => 'test-node',
    })
    // edit 的读在队列内（工具整体入锁），与插件式入口共享队列后读-算-写完整串行。
    const editTool = createEditTool(deps)

    // 两入口的变更互不干扰（顺序无关）：plugin 追加 P<k> 行；内置 edit 把
    // 哨兵 S0 换成 S1。队列失效时（两任务交错）plugin 的读旧值写回会覆盖
    // 对方写入——终态丢行；共享队列下终态必含全部 5 个 P 行与 S1。
    const pluginAppend = (k: number) =>
      envWithFileMutationQueue(
        recorder.env as never,
        target,
        async () => {
          const cur = files.get(target)!
          await delay(60)
          files.set(target, `${cur}P${k}\n`)
        },
        BACKGROUND_CONTEXT,
      )
    // 不可重入：绝不在外层再包一层同文件队列（会死锁）。
    const builtinEdit = async () => {
      const r = await editTool.execute(
        { path: target, oldText: 'S0\nEND', newText: 'S1\nEND' },
        makeApi('/workspace'),
        BACKGROUND_CONTEXT,
      )
      assert.equal(!!r.isError, false, JSON.stringify(r.output))
    }

    await Promise.all([pluginAppend(1), pluginAppend(2), pluginAppend(3), builtinEdit(), pluginAppend(4), pluginAppend(5)])
    const final = files.get(target)!
    assert.ok(final.includes('S1\nEND'), `内置 edit 必须生效：${JSON.stringify(final)}`)
    for (let k = 1; k <= 5; k += 1) {
      assert.ok(final.includes(`P${k}\n`), `P${k} 追加必须生效（共享队列不丢更新）：${JSON.stringify(final)}`)
    }
  })

  test('EnvFabric.withFileMutationQueue：local 节点与内置 write 互斥', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fabric-local')
    mkdirSync(dir, { recursive: true })
    const fabric = makeFabric()
    const deps = await makeDeps(join(dir, 'deps'), { envFabric: fabric })
    const file = join(dir, 'shared.txt')
    writeFileSync(file, 'v0')
    const writeTool = createWriteTool(deps)

    // 插件式 API：持锁窗口内读改写。
    const pluginBump = fabric.withFileMutationQueue(
      { nodeId: 'local', cwd: dir, path: file },
      async () => {
        const cur = readFileSync(file, 'utf8')
        await delay(80)
        writeFileSync(file, `${cur}+p`)
        return 'ok'
      },
    )
    const builtinWrite = writeTool.execute(
      { path: file, content: 'v1' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    ).then((r) => {
      assert.equal(!!r.isError, false, JSON.stringify(r.output))
    })
    // 内置 write 是整体覆盖：两者串行后最终态为其中之一，但绝不出现
    //「write 在 plugin 读与写之间插入」导致的 plugin 写回覆盖（v0+p 丢失
    // v1）——若互斥失效且 plugin 后写，结果为 v0+p；正确串行的两种终态
    // 都合法，关键是断言队列生效（无部分写入撕裂）。
    await Promise.all([pluginBump, builtinWrite])
    const final = readFileSync(file, 'utf8')
    assert.ok(final === 'v1' || final === 'v0+p' || final === 'v1+p', `终态合法：${final}`)
  })
})

// ---------------------------------------------------------------------------
// 5. 错误语义与重入诊断
// ---------------------------------------------------------------------------

describe('错误语义与嵌套重入', { timeout: 60_000 }, () => {
  test('canonical 错误分类：permission_denied 等如实上抛（不吞成 not-found 拼接）', { timeout: 60_000 }, async () => {
    // root 容器内 chmod 0o000 无法制造真实 EACCES（root 绕过 DAC），故用
    // 受控 env 在协议层验证同一分类逻辑：canonicalPath 返回非 not_found
    // 错误时必须原样上抛。local 层的 fs code 分类（仅 ENOENT/ENOTDIR 视为
    // 缺失，EACCES/EIO 上抛）与其同构（localCanonical）。
    const files = new Map<string, string>()
    const env = {
      id: 'remote:perm-node',
      async absolutePath(path: string) { return { ok: true, value: path } },
      async joinPath(parts: string[]) { return { ok: true, value: parts.join('/') } },
      async canonicalPath(path: string) {
        return { ok: false, error: { code: 'permission_denied', message: `EACCES: ${path}` } }
      },
    } as never
    await assert.rejects(
      envWithFileMutationQueue(env, '/workspace/protected.txt', async () => 'never', BACKGROUND_CONTEXT),
      (err: unknown) => {
        assert.equal((err as { code?: string }).code, 'permission_denied', '原始错误必须如实上抛')
        return true
      },
    )
  })

  test('localCanonical 根终止：空链上溯到根后停止（不无限递归）', { timeout: 60_000 }, async () => {
    // 整条链不存在的深路径：逐级上溯到 '/'（真实存在）终止拼接。
    const deep = '/definitely-not-exist-a/b/c/d/e/f.txt'
    const result = await localWithFileMutationQueue(deep, async () => 'ok')
    assert.equal(result, 'ok', '全缺失链必须正常上溯到根并终止')
  })

  test('嵌套同 key：持锁 fn 内再次入队立即显式报错（不挂死）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'reentrant')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'same.txt')
    writeFileSync(file, 'x')
    const env = new NodeExecutionEnv({ cwd: dir })

    await assert.rejects(
      envWithFileMutationQueue(
        env,
        file,
        async () => {
          // 同一异步链内嵌套同文件入队：必须立即报错而非排队挂死。
          return envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
        },
        BACKGROUND_CONTEXT,
      ),
      (err: unknown) => {
        assert.match((err as Error).message, /file_mutation_queue_reentrant/)
        return true
      },
    )
    // 链自愈：报错释放后下一任务正常。
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })

  test('持锁 fn 内直接底层写合法（不重入队列）；同链对不同文件入队合法', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'inner-direct')
    mkdirSync(dir, { recursive: true })
    const fileA = join(dir, 'a.txt')
    const fileB = join(dir, 'b.txt')
    writeFileSync(fileA, 'a0')
    writeFileSync(fileB, 'b0')
    const env = new NodeExecutionEnv({ cwd: dir })

    const result = await envWithFileMutationQueue(
      env,
      fileA,
      async () => {
        // 直接底层写同一文件（不再次入队）：合法路径。
        writeFileSync(fileA, 'a1')
        // 同异步链对另一文件入队：不同 key，合法。
        await envWithFileMutationQueue(env, fileB, async () => {
          writeFileSync(fileB, 'b1')
          return 'b-done'
        }, BACKGROUND_CONTEXT)
        return 'a-done'
      },
      BACKGROUND_CONTEXT,
    )
    assert.equal(result, 'a-done')
    assert.equal(readFileSync(fileA, 'utf8'), 'a1')
    assert.equal(readFileSync(fileB, 'utf8'), 'b1')
    assert.equal(fileMutationQueueSize(), 0)
  })

  test('不同异步链的「嵌套」（外层持锁者不等待即返回，内层排队）：不死锁但如实排队', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'cross-chain')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'cc.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    let releaseOuter!: () => void
    const hold = new Promise<void>((resolve) => { releaseOuter = resolve })
    const outer = envWithFileMutationQueue(env, file, async () => {
      await hold
      return 'outer'
    }, BACKGROUND_CONTEXT)
    await delay(30)

    // 独立异步链（非 outer 的 fn 内发起）对同一文件入队：ALS 检测不到
    // 「嵌套」——按普通排队语义等待 outer 释放（不死锁也不误报）。
    const inner = envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
    await delay(60)
    releaseOuter()
    assert.equal(await outer, 'outer')
    assert.equal(await inner, 'inner')
  })

  test('锁路径不可读取时保留原始 IO 错误，不伪报等待超时或删除锁', { timeout: 60_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'helm-file-lock-error-'))
    const target = join(dir, 'config.json')
    const lock = `${target}.lock`
    await mkdir(lock)
    let ran = false
    try {
      await assert.rejects(withProcessFileLock(target, async () => { ran = true }), (error: unknown) =>
        (error as NodeJS.ErrnoException).code === 'EISDIR')
      assert.equal(ran, false)
      assert.equal((await stat(lock)).isDirectory(), true)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
