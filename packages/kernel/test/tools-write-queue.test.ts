/**
 * write/edit tool and file mutual exclusion queue in new path contract under behavior test.
 *
 * path contract (align pi): conversation cwd only act relative path base allow, absolute path and ../ across directory access
 * one rule allows (and bash same right, do not set cwd sandbox);write/edit still via env/file-mutation-queue
 * by canonical path serial same file read-change-write. queue up wait for window inside target by external process (such as bash)
 * replace is symlink when, write with follow symlink to its real target - - this is and bash same right since set semantics,
 * queue only guarantee mutual exclusion, does not path re-check.
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
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'

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

async function makeRealDeps(dir: string): Promise<HelmToolDeps> {
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
  rootDir = mkdtempSync(join(tmpdir(), 'helm-write-queue-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
})

/**
 * determinism queue up gate control: first etc. hold enter execute window, again start queuedTask and wait for its truly complete
 * canonical parse and hang queues block in previous on, then execute window action and release hold.
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

describe('write/edit mutual exclusion queue and symlink semantics (new path contract)', { timeout: 60_000 }, () => {
  it('queue up wait for: same file write in before order hold lock task release after execute succeeded (queue only mutual exclusion, do not refuse path)', { timeout: 60_000 }, async () => {
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

  it('queue up wait for window inside target by replace is points to cwd outside symlink: write with follow symlink to real target (and bash same right)', { timeout: 60_000 }, async () => {
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
        // wait for window inside: target by concurrency replace is points to cwd outside symlink (queue do not lock external process).
        // new contract: write with follow symlink, to symlink points to real target.
        rmSync(victim)
        symlinkSync(join(outer, 'stolen.txt'), victim)
      },
    )
    assert.equal(!!result.isError, false, 'new contract under symlink target write should succeeded')
    assert.equal(existsSync(join(outer, 'stolen.txt')), true, 'write should with follow symlink to real target')
    assert.equal(readFileSync(join(outer, 'stolen.txt'), 'utf8'), 'ESCAPED')
  })

  it('same construct scenario edit: wait for window inside by replace is symlink after, read change write via symlink effect at real target', { timeout: 60_000 }, async () => {
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
    assert.equal(!!result.isError, false, 'new contract under edit via symlink read change write should succeeded')
    assert.equal(readFileSync(join(outer, 'stolen-edit.txt'), 'utf8'), 'hello ESCAPED world')
  })

  it('dangling symlink:write with follow symlink in target where create file (and bash heavy set to same semantics)', { timeout: 60_000 }, async () => {
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
    assert.equal(!!result.isError, false, 'dangling symlink write should with follow create target file')
    assert.equal(readFileSync(join(outer, 'not-yet-created.txt'), 'utf8'), 'CREATED')
  })

  it('cwd inside symlink directory under write new file still available (symlink directory normal penetrate)', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w3')
    mkdirSync(join(dir, 'real-sub'), { recursive: true })
    symlinkSync(join(dir, 'real-sub'), join(dir, 'link-sub'))
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)
    const result = await tool.execute(
      { path: 'link-sub/inside.txt', content: 'inside refer symlink directory under new file' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    assert.equal(existsSync(join(dir, 'real-sub', 'inside.txt')), true, 'should via inside refer symlink directory write real directory inside')
    const readBack = await createReadTool(deps).execute({ path: 'real-sub/inside.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!readBack.isError, false)
  })

  it('common rule write/edit do not subject to affect (store in file override and unique match replace)', { timeout: 60_000 }, async () => {
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
  it('fd read content consistent; directory and large file reject path still such as', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'r1')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# title\nbody text row')
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
