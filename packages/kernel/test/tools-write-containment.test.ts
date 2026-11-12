/**
 * write/edit 互斥临界区写前复核与 read fd 读取的并发回归测试。
 *
 * 场景（TOCTOU）：resolveWritableTarget 的 containment 在入队前完成；
 * 排队等待窗口内目标被并发替换为指向 cwd 外的软链（模拟 bash/外部进程，
 * 互斥队列不锁它们）——写前复核必须在临界区内拒绝，cwd 外文件绝不能被写。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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
  rootDir = mkdtempSync(join(tmpdir(), 'helm-write-containment-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

describe('write/edit 互斥临界区写前复核', { timeout: 60_000 }, () => {
  it('排队等待窗口内目标被替换为越界软链：write 在临界区内拒绝，cwd 外文件未被写入', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'w1-outer')
    mkdirSync(outer, { recursive: true })
    const victim = join(dir, 'victim.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    // 先占住同文件互斥队列（模拟前序任务持锁），write 解析完目标后在队列上等待
    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const hold = localWithFileMutationQueue(victim, () => holdGate)
    const writePromise = tool.execute({ path: 'victim.txt', content: 'ESCAPED' }, makeApi(dir), BACKGROUND_CONTEXT)
    // 等待 write 完成目标解析并入队（真实 fs 异步往返）
    await new Promise((resolve) => setTimeout(resolve, 50))
    // 等待窗口内：目标被并发替换为指向 cwd 外的软链（队列不锁外部进程）
    rmSync(victim)
    symlinkSync(join(outer, 'stolen.txt'), victim)
    releaseHold()
    await hold

    const result = await writePromise
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ type: 'text'; text: string }>)[0]!.text
    assert.ok(text.includes('path_escape_denied'), `应拒绝写入：${text}`)
    assert.ok(text.includes('写入前复核'), `必须命中互斥临界区内的复核路径：${text}`)
    assert.equal(existsSync(join(outer, 'stolen.txt')), false, 'cwd 外文件绝不能被创建/写入')
  })

  it('同构场景 edit：读改写持锁后复核拒绝，cwd 外文件未被写入', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'e1')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'e1-outer')
    mkdirSync(outer, { recursive: true })
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
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ type: 'text'; text: string }>)[0]!.text
    assert.ok(text.includes('path_escape_denied'), `应拒绝编辑：${text}`)
    assert.ok(text.includes('写入前复核'), `必须命中互斥临界区内的复核路径：${text}`)
    assert.equal(existsSync(join(outer, 'stolen-edit.txt')), false, 'cwd 外文件绝不能被写入')
  })

  it('已存在目标被替换为悬空软链（指向 cwd 外不存在路径）：复核保守拒绝', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'w2')
    mkdirSync(dir, { recursive: true })
    const outer = join(rootDir, 'w2-outer')
    mkdirSync(outer, { recursive: true })
    const victim = join(dir, 'dangling-target.txt')
    writeFileSync(victim, 'orig')
    const deps = await makeRealDeps(dir)
    const tool = createWriteTool(deps)

    let releaseHold!: () => void
    const holdGate = new Promise<void>((resolve) => { releaseHold = resolve })
    const hold = localWithFileMutationQueue(victim, () => holdGate)
    const writePromise = tool.execute({ path: 'dangling-target.txt', content: 'ESCAPED' }, makeApi(dir), BACKGROUND_CONTEXT)
    await new Promise((resolve) => setTimeout(resolve, 50))
    rmSync(victim)
    // 悬空软链：realpath 无法解析，writeFile 会跟随软链在 cwd 外创建目标文件
    symlinkSync(join(outer, 'not-yet-created.txt'), victim)
    releaseHold()
    await hold

    const result = await writePromise
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ type: 'text'; text: string }>)[0]!.text
    assert.ok(text.includes('path_escape_denied'), `悬空软链必须保守拒绝：${text}`)
    assert.equal(existsSync(join(outer, 'not-yet-created.txt')), false, '悬空软链不得被跟随写入')
  })

  it('cwd 内软链目录下写入新文件仍可用（复核不误伤合法内指软链）', { timeout: 60_000 }, async () => {
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

  it('常规写/edit 不受复核影响（存在文件覆盖与唯一匹配替换）', { timeout: 60_000 }, async () => {
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

after(async () => {
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})
})
