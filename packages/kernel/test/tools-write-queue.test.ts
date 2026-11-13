/**
 * write/edit 工具与文件互斥队列在新路径契约下的行为测试。
 *
 * 路径契约（对齐 pi）：会话 cwd 仅作相对路径基准，绝对路径与 ../ 跨目录访问
 * 一律允许（与 bash 同权，不设 cwd 沙箱）；write/edit 仍经 env/file-mutation-queue
 * 按 canonical 路径串行同文件读-改-写。排队等待窗口内目标被外部进程（如 bash）
 * 替换为软链时，写入跟随软链落到其真实目标——这是与 bash 同权的既定语义，
 * 队列只保证互斥、不做路径复核。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEditTool, createReadTool, createWriteTool } from '../src/runtime/tools.js'
import { localWithFileMutationQueue } from '../src/env/file-mutation-queue.js'
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

describe('write/edit 互斥队列与软链语义（新路径契约）', { timeout: 60_000 }, () => {
  it('排队等待：同文件写在前序持锁任务释放后执行成功（队列只互斥、不拒路径）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'q1')
    mkdirSync(dir, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const hold = localWithFileMutationQueue(victim, () => holdGate)
    const writePromise = tool.execute({ path: 'victim.txt', content: 'QUEUED' }, makeApi(dir), BACKGROUND_CONTEXT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    releaseHold()
    await hold

    const result = await writePromise
    assert.equal(!!result.isError, false)
    assert.equal(readFileSync(victim, 'utf8'), 'QUEUED')
  })

  it('排队等待窗口内目标被替换为指向 cwd 外的软链：写入跟随软链落到真实目标（与 bash 同权）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'w1-outer')
    mkdirSync(outer, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const hold = localWithFileMutationQueue(victim, () => holdGate)
    const writePromise = tool.execute({ path: 'victim.txt', content: 'ESCAPED' }, makeApi(dir), BACKGROUND_CONTEXT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 等待窗口内：目标被并发替换为指向 cwd 外的软链（队列不锁外部进程）。
    // 新契约：写入跟随软链，落到软链指向的真实目标。
    rmSync(victim)
    symlinkSync(join(outer, 'stolen.txt'), victim)
    releaseHold()
    await hold

    const result = await writePromise
    assert.equal(!!result.isError, false, '新契约下软链目标写入应成功')
    assert.equal(existsSync(join(outer, 'stolen.txt')), true, '写入应跟随软链落到真实目标')
    assert.equal(readFileSync(join(outer, 'stolen.txt'), 'utf8'), 'ESCAPED')
  })

  it('同构场景 edit：等待窗口内被替换为软链后，读改写经软链作用于真实目标', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'e1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'e1-outer')
    mkdirSync(outer, { recursive: true })
    writeFileSync(join(outer, 'stolen-edit.txt'), 'hello old world')
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'hello old world')
    const deps = await makeRealDeps(dir)
    const tool = createEditTool(deps)

    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const hold = localWithFileMutationQueue(victim, () => holdGate)
    const editPromise = tool.execute(
      { path: 'victim.txt', oldText: 'old', newText: 'ESCAPED' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(victim)
    symlinkSync(join(outer, 'stolen-edit.txt'), victim)
    releaseHold()
    await hold

    const result = await editPromise
    assert.equal(!!result.isError, false, '新契约下 edit 经软链读改写应成功')
    assert.equal(readFileSync(join(outer, 'stolen-edit.txt'), 'utf8'), 'hello ESCAPED world')
  })

  it('悬空软链：write 跟随软链在目标处创建文件（与 bash 重定向同语义）', { timeout: 60_000 }, async () => {
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
    assert.equal(!!result.isError, false, '悬空软链写入应跟随创建目标文件')
    assert.equal(readFileSync(join(outer, 'not-yet-created.txt'), 'utf8'), 'CREATED')
  })

  it('cwd 内软链目录下写入新文件仍可用（软链目录正常穿透）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w3')
    mkdirSync(join(dir, 'real-sub'), { recursive: true })
    symlinkSync(join(dir, 'real-sub'), join(dir, 'link-sub'))
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)
    const result = await tool.execute(
      { path: 'link-sub/inside.txt', content: '内指软链目录下的新文件' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    assert.equal(existsSync(join(dir, 'real-sub', 'inside.txt')), true, '应经内指软链目录写入真实目录内')
    const readBack = await createReadTool(deps).execute({ path: 'real-sub/inside.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!readBack.isError, false)
  })

  it('常规写/edit 不受影响（存在文件覆盖与唯一匹配替换）', { timeout: 60_000 }, async () => {
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

describe('read 工具 fd 读取路径', { timeout: 60_000 }, () => {
  it('fd 读取内容一致；目录与大文件拒绝路径仍如实', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'r1')
    mkdirSync(dir, { recursive: true })
    const deps = await makeRealDeps(dir)
    writeFileSync(join(dir, 'note.md'), '# 标题\n正文行')
    const tool = createReadTool(deps)
    const ok = await tool.execute({ path: 'note.md' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!ok.isError, false)
    const structured = ok.structuredOutput as { content: string }
    assert.ok(structured.content.includes('# 标题'))

    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)

    writeFileSync(join(dir, 'big.txt'), Buffer.alloc(129 * 1024, 0x61))
    const big = await tool.execute({ path: 'big.txt' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(big.isError, true)
    const text = (big.output as Array<{ type: 'text'; text: string }>)[0]!.text
    assert.ok(text.includes('file_too_large'))
  })
})
