/**
 * Behavior tests for `write`/`edit` tools and the file mutation queue under the path contract:
 *
 * Path contract (aligned with pi): conversation cwd serves only as the base for relative paths;
 * absolute paths and `../` parent traversals are permitted (matching bash privileges, no cwd
 * sandbox). `write`/`edit` still serialize per-file read-modify-write via `env/file-mutation-queue`
 * keyed by canonical path. If an external process (such as bash) replaces the target with a
 * symlink during the queue wait window, writes follow the symlink to its real target — matching
 * bash semantics by design, since the queue enforces mutual exclusion rather than path policing.
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditTool, createReadTool, createWriteTool } from '../src/runtime/tools.js'
import { localWithFileMutationQueue, onFileMutationEnqueue } from '../src/env/file-mutation-queue.js'
import { ArtifactService, InMemoryArtifactRepository, SecretStash, ensureDataDir } from '../src/services/index.js'
import type { HelmxToolDeps } from '../src/runtime/tool-deps.js'

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
      throw new Error('unused in test')
    },
    getTask: async () => undefined,
    waitForTask: async () => {
      throw new Error('unused in test')
    },
    conversation: async () => undefined,
    executeTool: async () => {
      throw new Error('unused in test')
    },
  } as never
}

async function makeRealDeps(dir: string): Promise<HelmxToolDeps> {
  await ensureDataDir(dir)
  const stash = new SecretStash()
  const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
  return {
    dataDir: dir,
    defaultCwd: dir,
    hubUrl: 'http://127.0.0.1:3202',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts,
  }
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helmx-write-queue-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
})

/**
 * Deterministic queue gate: waits until `hold` enters execution, starts `queuedTask` and waits for
 * it to finish canonical path resolution and block in the queue behind `hold`, executes the window
 * callback, then releases `hold`.
 */
async function runQueuedBehindHold<T>(
  victimPath: string,
  startQueued: () => Promise<T>,
  onQueuedDuringWindow?: () => void,
): Promise<T> {
  let enteredHold!: () => void
  const holdEntered = new Promise<void>((resolve) => { enteredHold = resolve })
  let releaseHold!: () => void
  const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
  const hold = localWithFileMutationQueue(victimPath, async () => {
    enteredHold()
    await holdGate
  })
  await holdEntered

  const expectedKey = `node:local\u0000${realpathSync(victimPath)}`
  let off: (() => void) | undefined
  const queued = new Promise<void>((resolve) => {
    off = onFileMutationEnqueue((event) => {
      if (event.waiting && event.key === expectedKey) {
        off?.()
        resolve()
      }
    })
  })
  const queuedTask = startQueued()
  try {
    await Promise.race([
      queued,
      queuedTask.then(
        () => { throw new Error('queuedTask unexpectedly settled before queuing') },
        (error) => { throw error },
      ),
    ])
  } finally {
    off?.()
  }
  onQueuedDuringWindow?.()
  releaseHold()
  await hold
  return await queuedTask
}

describe('write/edit mutual exclusion queue and symlink semantics under path contract', { timeout: 60_000 }, () => {
  it('queuing waits cleanly and writes succeed after prior lock holder releases (queue only serializes without rejecting paths)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'q1')
    mkdirSync(dir, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    const result = await runQueuedBehindHold(
      victim,
      () => tool.execute({ path: 'victim.txt', content: 'QUEUED' }, makeApi(dir), BACKGROUND_CONTEXT),
    )
    assert.equal(!!result.isError, false)
    assert.equal(readFileSync(victim, 'utf8'), 'QUEUED')
  })

  it('target replaced with external symlink during wait window: write follows symlink to real target (matching bash privileges)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'w1-outer')
    mkdirSync(outer, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    const result = await runQueuedBehindHold(
      victim,
      () => tool.execute({ path: 'victim.txt', content: 'ESCAPED' }, makeApi(dir), BACKGROUND_CONTEXT),
      () => {
        // Inside wait window: target is concurrently replaced with a symlink outside cwd (external processes do not take the queue).
        // Under current contract: write follows the symlink to its real target.
        rmSync(victim)
        symlinkSync(join(outer, 'stolen.txt'), victim)
      },
    )
    assert.equal(!!result.isError, false, 'write via symlink target should succeed under path contract')
    assert.equal(existsSync(join(outer, 'stolen.txt')), true, 'write should follow symlink to real target')
    assert.equal(readFileSync(join(outer, 'stolen.txt'), 'utf8'), 'ESCAPED')
  })

  it('same setup for edit: replaced with symlink during wait window reads/modifies/writes real target via symlink', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'e1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'e1-outer')
    mkdirSync(outer, { recursive: true })
    writeFileSync(join(outer, 'stolen-edit.txt'), 'hello old world')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'hello old world')
    const deps = await makeRealDeps(dir)
    const tool = createEditTool(deps)

    const result = await runQueuedBehindHold(
      victim,
      () => tool.execute(
        { path: 'victim.txt', oldText: 'old', newText: 'ESCAPED' },
        makeApi(dir),
        BACKGROUND_CONTEXT,
      ),
      () => {
        rmSync(victim)
        symlinkSync(join(outer, 'stolen-edit.txt'), victim)
      },
    )
    assert.equal(!!result.isError, false, 'edit via symlink should succeed under path contract')
    assert.equal(readFileSync(join(outer, 'stolen-edit.txt'), 'utf8'), 'hello ESCAPED world')
  })

  it('dangling symlink: write follows symlink to create file at target (matching bash redirection semantics)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w2')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'w2-outer')
    mkdirSync(outer, { recursive: true })
    symlinkSync(join(outer, 'not-yet-created.txt'), join(dir, 'dangling.txt'))
    const deps = await makeRealDeps(dir)
    const result = await createWriteTool(deps).execute(
      { path: 'dangling.txt', content: 'CREATED' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false, 'writing a dangling symlink should create the target file')
    assert.equal(readFileSync(join(outer, 'not-yet-created.txt'), 'utf8'), 'CREATED')
  })

  it('writing new file under an in-cwd symlink directory traverses normally', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w3')
    mkdirSync(join(dir, 'real-sub'), { recursive: true })
    symlinkSync(join(dir, 'real-sub'), join(dir, 'link-sub'))
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)
    const result = await tool.execute(
      { path: 'link-sub/inside.txt', content: 'new file inside symlinked directory' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    assert.equal(existsSync(join(dir, 'real-sub', 'inside.txt')), true, 'should write inside the real directory via symlinked directory')
    const readBack = await createReadTool(deps).execute({ path: 'real-sub/inside.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!readBack.isError, false)
  })

  it('regular write and edit are unaffected (file overwrite and unique-match replace work normally)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w4')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'plain.txt'), 'aaa bbb aaa')
    const writeResult = await createWriteTool(deps).execute(
      { path: 'plain.txt', content: 'replaced' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!writeResult.isError, false)
    const editResult = await createEditTool(deps).execute(
      { path: 'plain.txt', oldText: 'replaced', newText: 'edited' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!editResult.isError, false)
    const readResult = await createReadTool(deps).execute({ path: 'plain.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    const structured = readResult.structuredOutput as { content: string }
    assert.ok(structured.content.includes('edited'))
  })
})

describe('read tool fd read path', { timeout: 60_000 }, () => {
  it('fd read returns expected contents and directory / oversized-file rejection paths remain intact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'r1')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# title\nbody line')
    const tool = createReadTool(deps)
    const ok = await tool.execute({ path: 'note.md' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!ok.isError, false)
    const structured = ok.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# title'))

    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)

    writeFileSync(join(dir, 'big.txt'), Buffer.alloc(129 * 1024, 0x61))
    const big = await tool.execute({ path: 'big.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(big.isError, true)
    const text = (big.output as Array<{ type: 'text'; text: string }>)[0]!.text
    assert.ok(text.includes('file_too_large'))
  })
})
