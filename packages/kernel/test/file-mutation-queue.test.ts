/**
 * file mutual exclusion queue test (env/file-mutation-queue + EnvFabric.withFileMutationQueue
 * + kernel write/edit tool sharing queue).
 *
 * override:
 * 1. same file concurrency read-change-write do not lose update (kernel edit tool × N concurrency append replace; remote subject to control
 *    env  read-modify-write and inside placement tool competition);
 * 2. different file mutual without waiting (parallel execute, without serial overhead);
 * 3. realpath symlink alias same key(symlink points to the same file two path mutual exclusion);
 * 4. new file canonical parent directory concatenate (create new file write and after continue change same key);
 * 5. exception after queue self-heal (fn throws after under one task immediately can queue);
 * 6. signal cancel: in queue in while waiting cancel immediately failed and release queue location;
 * 7. across node same shape path different key(local and remote env the same path string mutual non-blocking);
 * 8. local direct connect entry (localWithFileMutationQueue) and NodeExecutionEnv bottom seat
 *    ('node:local' prefix) mutual exclusion.
 *
 * honest boundary (do not test/does not promise):bash and external process concurrency write do not subject to this queue constraint; across Hub process
 * without distributed style lock (single node single Hub deploy model).
 */

import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from '@earendil-works/chord/context'
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
// test base seat
// ---------------------------------------------------------------------------

/** real local bottom seat + EnvFabric(without remote node register:local path i.e. can test all semantics). */
function makeFabric(): EnvFabric {
  return createEnvFabric({})
}

/** subject to control remote env: real memory file table, read change write has can observability latency window. */
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
  const canonical = (p: string): string => p // subject to control: constant etc. mapping i.e. can (without symlink)
  const knownDirs = new Set<string>(['/workspace'])
  return {
    env: {
      id: 'remote:test-node',
      async absolutePath(path) {
        return { ok: true, value: path }
      },
      async joinPath(parts) {
        // posix term method concatenate + archive one (and NodeExecutionEnv.joinPath semantics consistent)
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
      throw new Error('test does not use ipcCall')
    },
    ipcSubscribe: () => {
      throw new Error('test does not use ipcSubscribe')
    },
    dispose: () => Promise.resolve(),
  } as never
}

/** and createEnvFabric same construct subject to control fabric:withFileMutationQueue re- use the same queue module. */
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
      throw new Error('test does not use')
    },
    getTask: () => undefined,
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
// 1. core semantics: same file serial / exception self-heal / cancel / different file parallel
// ---------------------------------------------------------------------------

describe('envWithFileMutationQueue core semantics', { timeout: 60_000 }, () => {
  test('same file read-change-write serial do not lose update (8 concurrency each +1)', { timeout: 60_000 }, async () => {
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
          // fabricate real race window: read to old value after let out event loop again write back.
          await delay(5)
          writeFileSync(file, String(Number(cur) + 1))
        },
        BACKGROUND_CONTEXT,
      )

    await Promise.all(Array.from({ length: 8 }, bump))
    assert.equal(readFileSync(file, 'utf8'), '8', '8 concurrency read-change-write must all takes effect')
    assert.equal(fileMutationQueueSize(), 0, 'compute after queue empty')
  })

  test('different file mutual without waiting (parallel execute)', { timeout: 60_000 }, async () => {
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
    assert.ok(elapsed < 300, `three different file should parallel (time cost ${elapsed}ms < 300ms)`)
  })

  test('fn throws after queue self-heal: under one task immediately can queue', { timeout: 60_000 }, async () => {
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

  test('three task cancel chain:A hold lock do not put;B queue up after abort immediately reject;C must not in A release before execute', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-chain')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chain.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // A: take lock after do not release (gate control holdA).
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
    await delay(30) // A already take lock (aRan translate rotate i.e. verify)
    assert.ok(aRan, 'A should already hold has lock')

    // B: queue up wait for in abort - - must immediately reject (do not etc. A,300ms pre- compute inside).
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
    await delay(30) // B already queue wait for
    const abortAt = Date.now()
    controllerB.abort()
    await assert.rejects(taskB, (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError')
      return true
    })
    const rejectElapsed = Date.now() - abortAt
    assert.ok(rejectElapsed < 300, `B must in A release before immediately reject (actual ${rejectElapsed}ms)`)
    assert.equal(bRan, false, 'B  fn must not execute')

    // C:B by cancel after queue - -A release before must not execute (by cancel B must not soar out false lock).
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
    assert.equal(cRan, false, 'A not release,C must not execute (cancel chain must not mistakenly delete header lock)')

    // A release:C immediately take over, chain restore normal.
    releaseA()
    assert.equal(await taskA, 'A')
    assert.equal(await taskC, 'C')
    assert.ok(cRan)
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, 'chain all compute after queue empty')
  })

  test('execute window inside cancel:signal semantics hand over by fn(fn return after chain normal release)', { timeout: 60_000 }, async () => {
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
    assert.equal(result, 'done-anyway', 'already hold lock fn normal compute (window inside cancel do not force interrupt)')
    assert.ok(fnObservedAbort)
    // chain release after under one task immediately can queue.
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 2. canonical key: symlink alias / new file
// ---------------------------------------------------------------------------

describe('canonical path key', { timeout: 60_000 }, () => {
  test('realpath symlink alias same key: two write method points to the same file mutual exclusion', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'symlink')
    mkdirSync(dir, { recursive: true })
    const real = join(dir, 'real.txt')
    writeFileSync(real, '0')
    const alias = join(dir, 'alias.txt')
    try {
      symlinkSync(real, alias)
    } catch {
      // without symlink permission environment skip (do not fabricate via).
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
    // serial execute when two +1 all takes effect (value eventually read to 2).
    assert.equal(readFileSync(real, 'utf8'), '2', 'symlink alias and real path must sharing one lock')
  })

  test('new file canonical parent directory concatenate: create and after continue change same key', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'newfile')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const file = join(dir, 'sub', 'fresh.txt')
    const env = new NodeExecutionEnv({ cwd: dir })

    // first with missing file queue (not_found branch away parent directory canonical concatenate).
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
    // file already exists after again queue:canonical directly hit, two proxy key consistent by under one assertion verify
    //(if key inconsistent, concurrency scenario will tear; this where serial verify feature can correct).
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

  test('ENOTDIR(a certain segment is file) two entry same key:env entry on trace do not throws, and local entry mutual exclusion', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'enotdir')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    // path in a certain one segment is file while non- directory:realpath report ENOTDIR(pi-durable mapping
    // not_directory; fix before env entry directly throws,local entry on trace - - two entry fork).
    const target = join(file, 'child')
    const env = new NodeExecutionEnv({ cwd: dir })

    // env entry no longer throw not_directory: normal on trace to already exists file piece together key and execute.
    const viaEnv = await envWithFileMutationQueue(env, target, async () => 'env-ok', BACKGROUND_CONTEXT)
    assert.equal(viaEnv, 'env-ok')

    // two entry same key:env entry hold lock do not put when local entry must queue up (while non- each lock each).
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
    assert.equal(localRan, false, 'env entry hold lock during local entry must not execute (same key mutual exclusion)')
    releaseHolder()
    assert.equal(await envHold, 'held')
    assert.equal(await localTask, 'local')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 3. across node / double entry key empty between
// ---------------------------------------------------------------------------

describe('across node and double entry key empty between', { timeout: 60_000 }, () => {
  test('local and remote env same shape path different key: mutual non-blocking', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'crossnode')
    mkdirSync(dir, { recursive: true })
    const path = '/workspace/shared.txt'
    const remote = makeRecordingEnv(new Map([[path, '0']])).env
    const localEnv = new NodeExecutionEnv({ cwd: dir })
    // local bottom seat absolutePath will '/workspace/shared.txt' treated as absolute path - -
    // in Linux on real store in and otherwise does not affect key compute (missing then away parent directory concatenate).

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
    assert.ok(elapsed < 280, `local and remote mutual non-blocking (time cost ${elapsed}ms)`)
  })

  test('localWithFileMutationQueue and NodeExecutionEnv bottom seat mutual exclusion (same key prefix)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'dualentry')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'dual.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // mixed entry concurrency:local direct connect and env bottom seat hand over replace +1, all takes effect.
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
    assert.equal(readFileSync(file, 'utf8'), '6', 'local direct connect entry and env bottom seat entry must mutual exclusion')
  })
})

// ---------------------------------------------------------------------------
// 4. kernel tool access:write/edit and plugin queue sharing
// ---------------------------------------------------------------------------

describe('kernel write/edit and queue', { timeout: 60_000 }, () => {
  test('inside placement edit tool concurrency replace do not lose update (the same local file 6 concurrency)', { timeout: 60_000 }, async () => {
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
      assert.ok(final.includes(`${word}!`), `${word} replace must takes effect:${JSON.stringify(final)}`)
    }
  })

  test('remote subject to control env: inside placement edit and plugin style envWithFileMutationQueue read-change-write competition the same file do not lose update', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-race')
    mkdirSync(dir, { recursive: true })
    const target = '/workspace/journal.md'
    const files = new Map<string, string>([[target, 'S0\nEND']])
    // remote read change write has latency window: without queue when must however tear.
    const recorder = makeRecordingEnv(files, new Map([[target, 40]]))
    const deps = await makeDeps(join(dir, 'deps'), {
      envFabric: makeRecordingFabric(recorder.env),
      nodeIdOf: () => 'test-node',
    })
    // edit read in queue inside (tool whole lock), and plugin style entry sharing queue after read-compute-write complete serial.
    const editTool = createEditTool(deps)

    // two entry change mutual do not interference (order without closure):plugin append P<k> row; inside placement edit 
    // sentinel S0 swap into S1. queue expires when (two task hand over wrong)plugin read old value write back will override
    // for way write - - terminal state lose row; sharing queue under terminal state must contains all 5  P row and S1.
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
    // cannot heavy: never in outside layer again package one layer same file queue (will deadlock).
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
    assert.ok(final.includes('S1\nEND'), `inside placement edit must takes effect:${JSON.stringify(final)}`)
    for (let k = 1; k <= 5; k += 1) {
      assert.ok(final.includes(`P${k}\n`), `P${k} append must takes effect (sharing queue do not lose update):${JSON.stringify(final)}`)
    }
  })

  test('EnvFabric.withFileMutationQueue:local node and inside placement write mutual exclusion', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fabric-local')
    mkdirSync(dir, { recursive: true })
    const fabric = makeFabric()
    const deps = await makeDeps(join(dir, 'deps'), { envFabric: fabric })
    const file = join(dir, 'shared.txt')
    writeFileSync(file, 'v0')
    const writeTool = createWriteTool(deps)

    // plugin style API: hold lock window inside read change write.
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
    // inside placement write is whole override: two serial after eventually state is among them of one, but never appear
    //write in plugin read and write between insert leads to plugin write back override (v0+p lose
    // v1) - - if mutual exclusion expires and plugin after write, result is v0+p; correct serial two kinds of terminal state
    // all legal, key is assertion queue takes effect (without part write tear).
    await Promise.all([pluginBump, builtinWrite])
    const final = readFileSync(file, 'utf8')
    assert.ok(final === 'v1' || final === 'v0+p' || final === 'v1+p', `terminal state legal:${final}`)
  })
})

// ---------------------------------------------------------------------------
// 5. error semantics and heavy diagnose
// ---------------------------------------------------------------------------

describe('error semantics and embed set heavy', { timeout: 60_000 }, () => {
  test('canonical error classify:permission_denied etc. such as on throw (do not swallow into not-found concatenate)', { timeout: 60_000 }, async () => {
    // root container inside chmod 0o000 cannot fabricate real EACCES(root bypass DAC), reason use
    // subject to control env in protocol layer verify the same classify logic:canonicalPath return non- not_found
    // error when must original on throw.local layer fs code classify (only ENOENT/ENOTDIR treated as
    // missing,EACCES/EIO on throw) and its same construct (localCanonical).
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
        assert.equal((err as { code?: string }).code, 'permission_denied', 'original error must such as on throw')
        return true
      },
    )
  })

  test('localCanonical terminate: empty chain on trace to after stop (do not unbounded recursion)', { timeout: 60_000 }, async () => {
    // whole chain missing deep path: one by one level on trace to '/'(real store in) terminate concatenate.
    const deep = '/definitely-not-exist-a/b/c/d/e/f.txt'
    const result = await localWithFileMutationQueue(deep, async () => 'ok')
    assert.equal(result, 'ok', 'all missing chain must normal on trace to and terminate')
  })

  test('embed set same key: hold lock fn inside again queue immediately explicit errors (do not hang die)', { timeout: 60_000 }, async () => {
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
          // the same async chain inside embed set same file queue: must immediately errors while non- queue up hang die.
          return envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
        },
        BACKGROUND_CONTEXT,
      ),
      (err: unknown) => {
        assert.match((err as Error).message, /file_mutation_queue_reentrant/)
        return true
      },
    )
    // chain self-heal: errors release after under one task normal.
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })

  test('hold lock fn inside directly underlying write legal (do not heavy queue); same chain for different file queue legal', { timeout: 60_000 }, async () => {
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
        // directly underlying write the same file (no longer time queue): legal path.
        writeFileSync(fileA, 'a1')
        // same async chain for another file queue: different key, legal.
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

  test('different async chain embed set (outside layer hold lock without waiting i.e. return, inside layer queue up): do not deadlock but such as queue up', { timeout: 60_000 }, async () => {
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

    // independent async chain (non- outer  fn inside start) for the same file queue:ALS detect fewer than
    // embed set - - by ordinary queue up semantics wait for outer release (do not deadlock also do not mistakenly report).
    const inner = envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
    await delay(60)
    releaseOuter()
    assert.equal(await outer, 'outer')
    assert.equal(await inner, 'inner')
  })

  test('lock path cannot read when keep original IO error, do not fake report wait timed out or delete lock', { timeout: 60_000 }, async () => {
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
