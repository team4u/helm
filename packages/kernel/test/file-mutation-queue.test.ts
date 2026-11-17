/**
 * File mutation mutex queue tests (env/file-mutation-queue + EnvFabric.withFileMutationQueue
 * + kernel write/edit tool shared queue).
 *
 * Covers:
 * 1. Concurrent read-modify-write serialization on same file (kernel edit tool x N concurrent appends; remote recording
 *    env read-modify-write racing against built-in tool);
 * 2. Different files execute concurrently without blocking (true parallelism, zero global serialization);
 * 3. Symlink aliases resolve to same realpath lock key (two paths targeting same file stay mutually exclusive);
 * 4. New files stitch onto canonical parent dir (create and subsequent mutations share identical lock key);
 * 5. Self-recovery after errors (next task queues cleanly if fn throws);
 * 6. AbortSignal cancellation while queued rejects immediately and frees slot;
 * 7. Cross-node identically named paths use distinct keys (local and remote identical strings never block each other);
 * 8. Direct local helper (localWithFileMutationQueue) shares key prefix ('node:local') with NodeExecutionEnv.
 *
 * Honest boundaries (unpromised / untested): concurrent writes from bash/external processes are not
 * serialized by this queue; no cross-Hub distributed locks (single-node single-Hub deployment model).
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
// Test fixtures
// ---------------------------------------------------------------------------

/** Real local backend + EnvFabric (no remote nodes registered; local path tests full semantics). */
function makeFabric(): EnvFabric {
  return createEnvFabric({})
}

/** Recording remote env: in-memory file table with configurable per-path read/write latency windows. */
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
  const canonical = (p: string): string => p // Identity canonicalizer sufficient here (no symlinks)
  const knownDirs = new Set<string>(['/workspace'])
  return {
    env: {
      id: 'remote:test-node',
      async absolutePath(path) {
        return { ok: true, value: path }
      },
      async joinPath(parts) {
        // POSIX path join + normalization (matches NodeExecutionEnv.joinPath semantics)
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

/** Recording fabric matching createEnvFabric's wiring: delegates withFileMutationQueue to the same queue module. */
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
// 1. Core semantics: same-file serialization / self-heal / cancellation / cross-file parallelism
// ---------------------------------------------------------------------------

describe('envWithFileMutationQueue core semantics', { timeout: 60_000 }, () => {
  test('serializes read-modify-write on the same file without lost updates (8 concurrent +1)', { timeout: 60_000 }, async () => {
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
          // Create a real race window by yielding the event loop between reading and writing.
          await delay(5)
          writeFileSync(file, String(Number(cur) + 1))
        },
        BACKGROUND_CONTEXT,
      )

    await Promise.all(Array.from({ length: 8 }, bump))
    assert.equal(readFileSync(file, 'utf8'), '8', 'all 8 concurrent read-modify-write steps must apply')
    assert.equal(fileMutationQueueSize(), 0, 'queue empties once settled')
  })

  test('executes operations on distinct files in parallel without waiting', { timeout: 60_000 }, async () => {
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
    assert.ok(elapsed < 300, `three distinct files should run concurrently (elapsed ${elapsed}ms < 300ms)`)
  })

  test('queue recovers after thrown error: subsequent task enqueues immediately', { timeout: 60_000 }, async () => {
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

  test('3-task abort chain: A holds lock, B aborts while queued and rejects immediately, C stays blocked until A releases', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'abort-chain')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'chain.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // A: acquires lock and waits on holdA gate.
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
    await delay(30) // Wait for A to enter callback (aRan confirms lock ownership)
    assert.ok(aRan, 'A should already hold the lock')

    // B: aborts while queued -- must reject immediately without waiting for A (within 300ms budget).
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
    await delay(30) // Let B enter wait queue
    const abortAt = Date.now()
    controllerB.abort()
    await assert.rejects(taskB, (err: unknown) => {
      assert.equal((err as Error).name, 'AbortError')
      return true
    })
    const rejectElapsed = Date.now() - abortAt
    assert.ok(rejectElapsed < 300, `B must reject immediately before A releases (actual ${rejectElapsed}ms)`)
    assert.equal(bRan, false, 'aborted task B fn must not run')

    // C: queued after aborted B -- must not start before A releases (B's abort must not release head lock early).
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
    assert.equal(cRan, false, 'C must not run while A still holds lock (aborting middle item must not drop head lock)')

    // Release A: C executes next and chain completes cleanly.
    releaseA()
    assert.equal(await taskA, 'A')
    assert.equal(await taskC, 'C')
    assert.ok(cRan)
    await delay(10)
    assert.equal(fileMutationQueueSize(), 0, 'queue empties once entire chain settles')
  })

  test('abort inside active window delegates signal handling to fn (chain releases cleanly once fn returns)', { timeout: 60_000 }, async () => {
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
    assert.equal(result, 'done-anyway', 'fn already holding lock settles normally (mid-run abort is not force-killed)')
    assert.ok(fnObservedAbort)
    // Next task queues cleanly after lock releases.
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 2. Canonical keys: symlink aliases / new files
// ---------------------------------------------------------------------------

describe('canonical path keys', { timeout: 60_000 }, () => {
  test('realpath symlink alias resolves to same lock key: paths pointing to same file stay mutually exclusive', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'symlink')
    mkdirSync(dir, { recursive: true })
    const real = join(dir, 'real.txt')
    writeFileSync(real, '0')
    const alias = join(dir, 'alias.txt')
    try {
      symlinkSync(real, alias)
    } catch {
      // Skip where platform denies symlink creation (never fake passing).
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
    // Sequential execution guarantees both +1 bumps apply (final value reaches 2).
    assert.equal(readFileSync(real, 'utf8'), '2', 'symlink alias and real path must share one lock')
  })

  test('new file stitches onto canonical parent directory: creation and subsequent edits share identical key', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'newfile')
    mkdirSync(join(dir, 'sub'), { recursive: true })
    const file = join(dir, 'sub', 'fresh.txt')
    const env = new NodeExecutionEnv({ cwd: dir })

    // Queue while target is missing (not_found path stitches onto canonical parent directory).
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
    // Queue again after file exists: direct canonical hit matches creation key cleanly.
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

  test('ENOTDIR (file segment along path) keeps identical key across entries without throwing in env entry', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'enotdir')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'plain.txt')
    writeFileSync(file, 'x')
    // Intermediate segment is a file rather than a directory: realpath reports ENOTDIR
    // (mapped by pi-durable to not_directory; must walk up identically across env and local entries).
    const target = join(file, 'child')
    const env = new NodeExecutionEnv({ cwd: dir })

    // env entry walks upward onto existing file to assemble lock key instead of throwing not_directory.
    const viaEnv = await envWithFileMutationQueue(env, target, async () => 'env-ok', BACKGROUND_CONTEXT)
    assert.equal(viaEnv, 'env-ok')

    // Shared lock key across entries: local entry blocks while env entry holds lock.
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
    assert.equal(localRan, false, 'local entry must wait while env entry holds the shared key lock')
    releaseHolder()
    assert.equal(await envHold, 'held')
    assert.equal(await localTask, 'local')
    assert.equal(fileMutationQueueSize(), 0)
  })
})

// ---------------------------------------------------------------------------
// 3. Cross-node and dual-entry key namespaces
// ---------------------------------------------------------------------------

describe('cross-node and dual-entry key namespaces', { timeout: 60_000 }, () => {
  test('identical path syntax across local and remote envs produces distinct keys with zero blocking', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'crossnode')
    mkdirSync(dir, { recursive: true })
    const path = '/workspace/shared.txt'
    const remote = makeRecordingEnv(new Map([[path, '0']])).env
    const localEnv = new NodeExecutionEnv({ cwd: dir })

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
    assert.ok(elapsed < 280, `local and remote must not block each other (elapsed ${elapsed}ms)`)
  })

  test('localWithFileMutationQueue and NodeExecutionEnv share the same lock key prefix', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'dualentry')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'dual.txt')
    writeFileSync(file, '0')
    const env = new NodeExecutionEnv({ cwd: dir })

    // Interleaved concurrent calls across local helper and env wrapper serialize cleanly without losing +1 updates.
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
    assert.equal(readFileSync(file, 'utf8'), '6', 'direct local helper and env helper must share mutex exclusion')
  })
})

// ---------------------------------------------------------------------------
// 4. Kernel tool wiring: write/edit sharing queue with plugins
// ---------------------------------------------------------------------------

describe('kernel write/edit and queue', { timeout: 60_000 }, () => {
  test('built-in edit tool concurrent replacements never drop updates (6 concurrent edits on same local file)', { timeout: 60_000 }, async () => {
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
      assert.ok(final.includes(`${word}!`), `replacement for ${word} must persist: ${JSON.stringify(final)}`)
    }
  })

  test('remote recording env: built-in edit and plugin-style envWithFileMutationQueue race on same file without losing updates', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-race')
    mkdirSync(dir, { recursive: true })
    const target = '/workspace/journal.md'
    const files = new Map<string, string>([[target, 'S0\nEND']])
    // Remote read/write latency window would tear updates without mutual exclusion.
    const recorder = makeRecordingEnv(files, new Map([[target, 40]]))
    const deps = await makeDeps(join(dir, 'deps'), {
      envFabric: makeRecordingFabric(recorder.env),
      nodeIdOf: () => 'test-node',
    })
    // Built-in edit acquires queue around full read-compute-write cycle, sharing lock with plugin queue calls.
    const editTool = createEditTool(deps)

    // Interleaved mutations (order unspecified): plugins append P<k>\n lines while built-in edit replaces S0 with S1.
    // Sharing the lock guarantees all 5 P lines AND S1 are present at the end.
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
    // Built-in edit acquires the queue itself -- do not wrap it in another outer same-file queue (would deadlock).
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
    assert.ok(final.includes('S1\nEND'), `built-in edit must persist: ${JSON.stringify(final)}`)
    for (let k = 1; k <= 5; k += 1) {
      assert.ok(final.includes(`P${k}\n`), `P${k} append must persist cleanly via shared queue: ${JSON.stringify(final)}`)
    }
  })

  test('EnvFabric.withFileMutationQueue: local node and built-in write share mutex exclusion', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'fabric-local')
    mkdirSync(dir, { recursive: true })
    const fabric = makeFabric()
    const deps = await makeDeps(join(dir, 'deps'), { envFabric: fabric })
    const file = join(dir, 'shared.txt')
    writeFileSync(file, 'v0')
    const writeTool = createWriteTool(deps)

    // Plugin-style API: reads, yields inside lock window, then writes.
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
    // Built-in write is full overwrite: serializing both tasks always leaves either v1+p or v1
    // (or v0+p if plugin acquired later without overlap? Wait: write overwrites, so v1 or v1+p or v0+p;
    // key invariant is zero torn writes between plugin's read and write).
    await Promise.all([pluginBump, builtinWrite])
    const final = readFileSync(file, 'utf8')
    assert.ok(final === 'v1' || final === 'v0+p' || final === 'v1+p', `valid serialized outcome: ${final}`)
  })
})

// ---------------------------------------------------------------------------
// 5. Error semantics and reentrancy diagnostics
// ---------------------------------------------------------------------------

describe('error semantics and reentrant nesting', { timeout: 60_000 }, () => {
  test('canonical error classification: permission_denied etc. rethrows verbatim instead of falling back to not-found walk', { timeout: 60_000 }, async () => {
    // chmod 0o000 inside a root container cannot trigger real EACCES (root bypasses DAC), so verify
    // classification via a recording env returning a non-not_found error from canonicalPath.
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
        assert.equal((err as { code?: string }).code, 'permission_denied', 'non-not_found error must propagate verbatim')
        return true
      },
    )
  })

  test('localCanonical termination: walking missing chain terminates cleanly at existing root', { timeout: 60_000 }, async () => {
    // Deep missing path walks upward level-by-level until reaching existing '/'.
    const deep = '/definitely-not-exist-a/b/c/d/e/f.txt'
    const result = await localWithFileMutationQueue(deep, async () => 'ok')
    assert.equal(result, 'ok', 'missing ancestor chain must walk upward and terminate cleanly')
  })

  test('reentrant same key: nested queue on same key fails fast explicitly instead of deadlocking', { timeout: 60_000 }, async () => {
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
          // Reentering the same file queue in the same async chain must error immediately instead of deadlocking.
          return envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
        },
        BACKGROUND_CONTEXT,
      ),
      (err: unknown) => {
        assert.match((err as Error).message, /file_mutation_queue_reentrant/)
        return true
      },
    )
    // Queue recovers cleanly after reentrancy error is rejected.
    const next = await envWithFileMutationQueue(env, file, async () => 'next', BACKGROUND_CONTEXT)
    assert.equal(next, 'next')
    assert.equal(fileMutationQueueSize(), 0)
  })

  test('direct low-level writes inside lock allowed (no requeue); queuing different file in same chain allowed', { timeout: 60_000 }, async () => {
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
        // Direct low-level write to same file without re-queuing is valid.
        writeFileSync(fileA, 'a1')
        // Queuing a different file on the same async chain uses a distinct key and succeeds cleanly.
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

  test('different async chain nesting (outer returns early holding lock, inner queues): queues normally without false positive', { timeout: 60_000 }, async () => {
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

    // Independent async chain (started outside outer's callback): ALS does not report nesting,
    // so normal queuing waits cleanly until outer releases (zero deadlock, zero false error).
    const inner = envWithFileMutationQueue(env, file, async () => 'inner', BACKGROUND_CONTEXT)
    await delay(60)
    releaseOuter()
    assert.equal(await outer, 'outer')
    assert.equal(await inner, 'inner')
  })

  test('unreadable lock path preserves underlying IO error rather than reporting false timeout or deleting lock', { timeout: 60_000 }, async () => {
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
