/**
 * register_artifact 工具与执行上下文可观测性（HELM_EXECUTION_SCOPE / 真实
 * target 回显）回归测试。
 *
 * 覆盖：
 * 1. register_artifact local：非文本二进制字节保真登记、删除源文件后产物仍
 *    可读（真实复制进 Hub 数据目录）、目录/特殊文件拒绝、15 MiB 超限显式
 *    artifact_too_large、空文件与自定义 name/mimeType；
 * 2. register_artifact remote：经 EnvFabric 读取远端真实字节（canonical 路径
 *    回显）、节点离线 / EnvFabric 缺失显式失败且绝不回退本机、读前 fileInfo
 *    超限拒绝（不读字节）、读后字节数超限拒绝；
 * 3. read/write/edit/bash 结构化输出与成功消息回显真实 target 绝对路径、
 *    nodeId、规范化 cwd（win32 /mnt/c 与 /c 视图绝不回显原始入参）；
 * 4. HELM_EXECUTION_SCOPE：稳定短 hash（同会话同靶点恒定）、跨会话/节点/
 *    cwd/Helm 实例隔离、受管固定覆盖（逐调用注入与宿主继承的大小写变体均
 *    不可覆盖）、Herdr 窗格受管键锁定。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import type { Context } from '@earendil-works/chord'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { EnvFabric } from '../src/env/index.js'
import { composeExecutionEnv } from '../src/env/scoped-env.js'
import { buildSpawnPaneEnv } from '../src/builtin-plugins/herdr/spawn-rules.js'
import { mergeGrantedEnvWithManagedLocks } from '../src/builtin-plugins/herdr/executor.js'
import {
  buildManagedEnv,
  createBashTool,
  createEditTool,
  createReadTool,
  createRegisterArtifactTool,
  createWriteTool,
  executionScopeHash,
  runShell,
} from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import {
  ArtifactService,
  InMemoryArtifactRepository,
  SecretStash,
  ensureDataDir,
} from '../src/services/index.js'

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-artifact-scope-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

async function makeDeps(dir: string, extra: Partial<HelmToolDeps> = {}): Promise<HelmToolDeps> {
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
    ...extra,
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

/** 远端文件 env 替身：canonicalPath 解析映射 + fileInfo/readBinaryFile 真实字节。 */
function makeRemoteFileEnv(options: {
  canonical: Record<string, string>
  files: Map<string, { kind: 'file' | 'directory' | 'symlink'; size: number; bytes: Uint8Array }>
}): { env: Record<string, unknown>; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    env: {
      id: 'remote:fake-file-node',
      async canonicalPath(path: string, _context: Context) {
        calls.push(`canonicalPath:${path}`)
        const mapped = options.canonical[path]
        return mapped === undefined
          ? { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
          : { ok: true, value: mapped }
      },
      async fileInfo(path: string, _context: Context) {
        calls.push(`fileInfo:${path}`)
        const info = options.files.get(path)
        return info === undefined
          ? { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
          : { ok: true, value: { kind: info.kind, size: info.size } }
      },
      async readBinaryFile(path: string, _context: Context) {
        calls.push(`readBinaryFile:${path}`)
        const info = options.files.get(path)
        return info === undefined
          ? { ok: false, error: { code: 'not_found', message: `ENOENT: ${path}` } }
          : { ok: true, value: info.bytes }
      },
    },
  }
}

/** 平台可控 EnvFabric 替身（bash 远端 exec / register_artifact 远端读取共用）。 */
function makeFabric(options: {
  platform?: string
  online?: boolean
  env?: unknown
}): EnvFabric {
  return {
    registry: {} as never,
    hubPlatform: () => undefined,
    envFor: () => options.env as never,
    envForTarget: () => options.env as never,
    isOnline: () => options.online ?? true,
    waitForOnline: () => Promise.resolve(true),
    getNodeHubUrl: () => undefined,
    nodePlatformOf: (nodeId: string) => (nodeId === 'local' ? process.platform : options.platform),
    evictConversation: () => undefined,
    debugBaseCount: () => 0,
    debugBases: () => [],
    ipcCall: () => {
      throw new Error('测试不使用')
    },
    ipcSubscribe: () => {
      throw new Error('测试不使用')
    },
    dispose: () => Promise.resolve(),
  } as never
}

/** 二进制样本：含非法 UTF-8 序列与 NUL，任何文本重编码都会破坏字节保真。 */
const BINARY_SAMPLE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x80, 0xbf, 0xc3, 0x28, 0xf0,
  0x9f, 0x98, 0x80, 0x0a,
])

describe('register_artifact：local 真实字节登记', { timeout: 60_000 }, () => {
  it('非文本二进制登记成功；删除源文件后产物仍可读取且字节保真', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-local-1')
    const deps = await makeDeps(dir)
    const source = join(dir, 'chart.bin')
    writeFileSync(source, BINARY_SAMPLE)
    const tool = createRegisterArtifactTool(deps)
    const result = await tool.execute({ path: 'chart.bin' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as {
      artifactId: string
      path: string
      nodeId: string
      name: string
      size: number
      mimeType: string
    }
    assert.equal(structured.path, source, '结构化 path 必须是真实绝对路径（非原始入参）')
    assert.equal(structured.nodeId, 'local')
    assert.equal(structured.name, 'chart.bin')
    assert.equal(structured.size, BINARY_SAMPLE.byteLength)
    assert.equal(structured.mimeType, 'application/octet-stream')
    assert.match(structured.artifactId, /^[0-9a-f-]{36}$/)
    const text = (result.output as Array<{ type: string; text: string }>)[0]!.text
    assert.ok(text.includes(`[Artifact] id=${structured.artifactId}`), '文本必须回显产物 ID')
    assert.ok(text.includes(source), '成功消息必须回显源绝对路径')
    // 删除源文件后产物仍可读取（字节已复制进 Hub 数据目录）。
    rmSync(source)
    assert.ok(!existsSync(source))
    const stored = Buffer.from(await deps.artifacts.readBuffer(structured.artifactId))
    assert.deepEqual(
      [...stored],
      [...BINARY_SAMPLE],
      '二进制产物字节保真（不 UTF-8 重编码、不脱敏改写）',
    )
  })

  it('自定义 name/mimeType 生效；空文件登记成功（size 0）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-local-2')
    const deps = await makeDeps(dir)
    writeFileSync(join(dir, 'empty.dat'), Buffer.alloc(0))
    const tool = createRegisterArtifactTool(deps)
    const result = await tool.execute(
      { path: 'empty.dat', name: '导出结果.csv', mimeType: 'text/csv' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { artifactId: string; name: string; size: number; mimeType: string }
    assert.equal(structured.name, '导出结果.csv')
    assert.equal(structured.size, 0)
    assert.equal(structured.mimeType, 'text/csv')
    assert.equal((await deps.artifacts.readBuffer(structured.artifactId)).byteLength, 0)
  })

  it('目录与特殊文件（FIFO）拒绝；文本类 mime 的产物经 stash 脱敏', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-local-3')
    const stash = new SecretStash()
    const secretValue = '{{SECRET_ra_local_3}}'
    stash.put(1, 'TOK', secretValue)
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmToolDeps = {
      ...(await makeDeps(dir)),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const tool = createRegisterArtifactTool(deps)
    const dirResult = await tool.execute({ path: '.' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(dirResult.isError, true)
    assert.ok((dirResult.output as Array<{ text: string }>)[0]!.text.includes('目录'))
    if (process.platform !== 'win32') {
      const fifo = join(dir, 'pipe.fifo')
      execSync(`mkfifo ${fifo}`)
      const fifoResult = await tool.execute({ path: 'pipe.fifo' }, makeApi(dir), BACKGROUND_CONTEXT)
      assert.equal(fifoResult.isError, true)
      assert.ok((fifoResult.output as Array<{ text: string }>)[0]!.text.includes('不是普通文件'))
      rmSync(fifo)
    }
    // 文本 mime：ArtifactService 统一脱敏（秘密不落盘承诺覆盖本路径）。
    writeFileSync(join(dir, 'note.md'), `token=${secretValue}`)
    const textResult = await tool.execute({ path: 'note.md' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(!!textResult.isError, false)
    const structured = textResult.structuredOutput as { artifactId: string; name: string; size: number; mimeType: string }
    const stored = (await deps.artifacts.readContent(structured.artifactId)) as string
    assert.ok(!stored.includes(secretValue), '文本产物落盘必须脱敏')
    assert.ok(stored.includes('[REDACTED'))
  })

  it('超过 15 MiB 显式 artifact_too_large（fd 预检拒绝，不读超限内容）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-local-4')
    const deps = await makeDeps(dir)
    const big = join(dir, 'big.bin')
    writeFileSync(big, Buffer.alloc(15 * 1024 * 1024 + 1, 0x61))
    const tool = createRegisterArtifactTool(deps)
    const result = await tool.execute({ path: 'big.bin' }, makeApi(dir), BACKGROUND_CONTEXT)
    assert.equal(result.isError, true)
    const text = (result.output as Array<{ text: string }>)[0]!.text
    assert.ok(text.includes('artifact_too_large'), `应显式超限（${text.slice(0, 80)}）`)
    assert.ok(text.includes('15 MiB'))
  })
})

describe('register_artifact：remote 节点真实字节与显式拒绝', { timeout: 60_000 }, () => {
  it('经 EnvFabric 读取远端字节成功；canonical 路径回显（软链解析后）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-remote-1')
    const { env, calls } = makeRemoteFileEnv({
      canonical: { '/proj/link.bin': '/proj/real-data.bin' },
      files: new Map([
        ['/proj/real-data.bin', { kind: 'file', size: BINARY_SAMPLE.byteLength, bytes: BINARY_SAMPLE }],
      ]),
    })
    const fabric = makeFabric({ platform: 'linux', env })
    const deps = await makeDeps(dir, { envFabric: fabric, nodeIdOf: () => 'n1' })
    const tool = createRegisterArtifactTool(deps)
    const result = await tool.execute({ path: 'link.bin' }, makeApi('/proj'), BACKGROUND_CONTEXT)
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as { artifactId: string; path: string; nodeId: string; size: number }
    assert.equal(structured.path, '/proj/real-data.bin', '远端回显 canonical 解析后路径')
    assert.equal(structured.nodeId, 'n1')
    assert.equal(structured.size, BINARY_SAMPLE.byteLength)
    assert.ok(calls.includes('canonicalPath:/proj/link.bin'))
    assert.ok(calls.includes('readBinaryFile:/proj/real-data.bin'))
    const stored = Buffer.from(await deps.artifacts.readBuffer(structured.artifactId))
    assert.deepEqual([...stored], [...BINARY_SAMPLE], '远端字节原样保真')
  })

  it('节点离线显式 node_offline；EnvFabric 缺失显式 env_fabric_missing；均绝不读取本机同路径', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-remote-2')
    // 本机放置同名文件：若工具回退 local 就会误读它（防御性断言）。
    mkdirSync(join(dir, 'proj'), { recursive: true })
    writeFileSync(join(dir, 'proj', 'leak.bin'), Buffer.from('LOCAL-LEAK'))
    const { env, calls } = makeRemoteFileEnv({ canonical: {}, files: new Map() })
    const offlineDeps = await makeDeps(dir, {
      envFabric: makeFabric({ platform: 'linux', online: false, env }),
      nodeIdOf: () => 'n1',
    })
    const tool = createRegisterArtifactTool(offlineDeps)
    const offline = await tool.execute({ path: 'leak.bin' }, makeApi(join(dir, 'proj')), BACKGROUND_CONTEXT)
    assert.equal(offline.isError, true)
    assert.ok((offline.output as Array<{ text: string }>)[0]!.text.includes('node_offline'))
    const noFabricDeps = await makeDeps(join(rootDir, 'ra-remote-2b'), { nodeIdOf: () => 'n1' })
    const noFabric = await createRegisterArtifactTool(noFabricDeps).execute(
      { path: 'leak.bin' },
      makeApi(join(dir, 'proj')),
      BACKGROUND_CONTEXT,
    )
    assert.equal(noFabric.isError, true)
    assert.ok((noFabric.output as Array<{ text: string }>)[0]!.text.includes('env_fabric_missing'))
    assert.equal(calls.length, 0, '离线/缺 fabric 不得发起任何远端读取')
  })

  it('读前 fileInfo 超限拒绝（不读字节）；读后字节数超限同样显式拒绝', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'ra-remote-3')
    const cap = 15 * 1024 * 1024
    // 读前超限：fileInfo.size > 上限，readBinaryFile 绝不发起。
    const pre = makeRemoteFileEnv({
      canonical: { '/proj/huge.bin': '/proj/huge.bin' },
      files: new Map([['/proj/huge.bin', { kind: 'file', size: cap + 1, bytes: Buffer.alloc(0) }]]),
    })
    const preDeps = await makeDeps(dir, {
      envFabric: makeFabric({ platform: 'linux', env: pre.env }),
      nodeIdOf: () => 'n1',
    })
    const preResult = await createRegisterArtifactTool(preDeps).execute(
      { path: 'huge.bin' },
      makeApi('/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(preResult.isError, true)
    assert.ok((preResult.output as Array<{ text: string }>)[0]!.text.includes('artifact_too_large'))
    assert.ok(!pre.calls.some((c) => c.startsWith('readBinaryFile')), '读前超限不得读字节')
    // 读后超限：fileInfo 谎报小尺寸，readBinaryFile 返回超限字节。
    const post = makeRemoteFileEnv({
      canonical: { '/proj/grew.bin': '/proj/grew.bin' },
      files: new Map([
        ['/proj/grew.bin', { kind: 'file', size: 16, bytes: Buffer.alloc(cap + 1, 0x62) }],
      ]),
    })
    const postDeps = await makeDeps(join(rootDir, 'ra-remote-3b'), {
      envFabric: makeFabric({ platform: 'linux', env: post.env }),
      nodeIdOf: () => 'n1',
    })
    const postResult = await createRegisterArtifactTool(postDeps).execute(
      { path: 'grew.bin' },
      makeApi('/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(postResult.isError, true)
    const postText = (postResult.output as Array<{ text: string }>)[0]!.text
    assert.ok(postText.includes('artifact_too_large'), `读后超限必须显式拒绝（${postText.slice(0, 80)}）`)
    assert.ok(postText.includes(String(cap + 1)), '错误信息携带真实读到的字节数')
  })
})

describe('read/write/edit/bash：真实 target 路径与 nodeId 回显', { timeout: 60_000 }, () => {
  it('write/edit 成功消息与结构化输出回显绝对路径 + nodeId（非原始入参）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'echo-1')
    const deps = await makeDeps(dir)
    const writeTool = createWriteTool(deps)
    const writeResult = await writeTool.execute(
      { path: 'sub/out/报告.md', content: '# 报告\n第一版' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!writeResult.isError, false)
    const expected = join(dir, 'sub', 'out', '报告.md')
    const writeStructured = writeResult.structuredOutput as { path: string; nodeId: string; bytesWritten: number }
    assert.equal(writeStructured.path, expected)
    assert.equal(writeStructured.nodeId, 'local')
    const writeText = (writeResult.output as Array<{ text: string }>)[0]!.text
    assert.ok(writeText.includes(expected), `write 成功消息必须回显绝对路径（${writeText}）`)
    assert.ok(writeText.includes('节点 local'))
    const editTool = createEditTool(deps)
    const editResult = await editTool.execute(
      { path: 'sub/out/报告.md', oldText: '第一版', newText: '第二版' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!editResult.isError, false)
    const editStructured = editResult.structuredOutput as { path: string; nodeId: string; replaced: boolean }
    assert.equal(editStructured.path, expected)
    assert.equal(editStructured.nodeId, 'local')
    assert.ok((editResult.output as Array<{ text: string }>)[0]!.text.includes(expected))
  })

  it('read 结构化输出回显词法绝对路径 + nodeId（远端为 canonical 路径）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'echo-2')
    const deps = await makeDeps(dir)
    writeFileSync(join(dir, 'note.txt'), '内容')
    const readResult = await createReadTool(deps).execute(
      { path: 'note.txt' },
      makeApi(dir),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!readResult.isError, false)
    const structured = readResult.structuredOutput as { path: string; nodeId: string; content: string }
    assert.equal(structured.path, join(dir, 'note.txt'))
    assert.equal(structured.nodeId, 'local')
    // 远端：canonicalPath 解析后的真实路径回显。
    const { env } = makeRemoteFileEnv({
      canonical: { '/proj/link.txt': '/proj/real.txt' },
      files: new Map([
        ['/proj/real.txt', { kind: 'file', size: 12, bytes: Buffer.alloc(0) }],
      ]),
    })
    const remoteEnv = {
      ...env,
      async readTextFile(path: string, _context: Context) {
        return { ok: true, value: '远端内容' }
      },
    }
    const remoteDeps = await makeDeps(join(rootDir, 'echo-2b'), {
      envFabric: makeFabric({ platform: 'linux', env: remoteEnv }),
      nodeIdOf: () => 'n1',
    })
    const remoteResult = await createReadTool(remoteDeps).execute(
      { path: 'link.txt' },
      makeApi('/proj'),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!remoteResult.isError, false)
    const remoteStructured = remoteResult.structuredOutput as { path: string; nodeId: string }
    assert.equal(remoteStructured.path, '/proj/real.txt', '远端 read 回显 canonical 解析后路径')
    assert.equal(remoteStructured.nodeId, 'n1')
  })

  it('bash 结构化输出携带实际 nodeId/cwd；文本 stdout 原样', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'echo-3')
    const deps = await makeDeps(dir)
    const tool = createBashTool(deps)
    const result = await tool.execute(
      { command: 'echo bash-observable' },
      makeApi(dir, 1),
      BACKGROUND_CONTEXT,
    )
    assert.equal(!!result.isError, false)
    const structured = result.structuredOutput as {
      ok: boolean
      output: string
      nodeId: string
      cwd: string
    }
    assert.equal(structured.nodeId, 'local')
    assert.equal(structured.cwd, dir, 'local cwd 为会话目录（绝对路径）')
    assert.ok(structured.output.includes('bash-observable'))
    // 失败命令（退出码非 0）仍回显执行事实。
    const fail = await tool.execute({ command: 'exit 7' }, makeApi(dir, 1), BACKGROUND_CONTEXT)
    assert.equal(fail.isError, true)
    const failStructured = fail.structuredOutput as { nodeId: string; cwd: string }
    assert.equal(failStructured.nodeId, 'local')
    assert.equal(failStructured.cwd, dir)
  })

  it('远端 win32 目标：bash 结构化 cwd 是规范化后 Windows 路径（/mnt/c 与 /c 视图均不回显原始入参）', { timeout: 60_000 }, async () => {
    const execCalls: Array<{ cwd?: string }> = []
    const recEnv = {
      id: 'remote:rec-exec',
      async exec(
        _command: string,
        options: { cwd?: string },
        _context: Context,
      ): Promise<{ ok: true; value: { exitCode: number } }> {
        execCalls.push({ cwd: options?.cwd })
        return { ok: true, value: { exitCode: 0 } }
      },
    }
    const deps = await makeDeps(join(rootDir, 'echo-4'), {
      envFabric: makeFabric({ platform: 'win32', env: recEnv }),
      nodeIdOf: () => 'n1',
    })
    const tool = createBashTool(deps)
    for (const view of ['/mnt/c/proj', '/c/proj']) {
      const result = await tool.execute({ command: 'dir' }, makeApi(view, 1), BACKGROUND_CONTEXT)
      assert.equal(!!result.isError, false, `视图 ${view} 应执行成功`)
      const structured = result.structuredOutput as { nodeId: string; cwd: string }
      assert.equal(structured.nodeId, 'n1')
      assert.equal(structured.cwd, 'C:\\proj', `视图 ${view} 必须回显规范化 Windows 路径`)
      assert.notEqual(structured.cwd, view, '绝不回显原始 POSIX 视图入参')
    }
    assert.ok(execCalls.every((c) => c.cwd === 'C:\\proj'), '远端 exec 收到的也是规范化路径')
  })
})

describe('HELM_EXECUTION_SCOPE：稳定锚点与受管覆盖锁定', { timeout: 60_000 }, () => {
  it('executionScopeHash：格式 helm-<24hex>；同输入恒定；跨会话/节点/cwd/实例隔离', { timeout: 60_000 }, () => {
    const a = executionScopeHash('/data', 7, 'local', '/work')
    assert.match(a, /^helm-[0-9a-f]{24}$/)
    assert.equal(a, executionScopeHash('/data', 7, 'local', '/work'), '同输入必须恒定（多命令相同）')
    assert.notEqual(a, executionScopeHash('/data', 8, 'local', '/work'), '跨会话不同')
    assert.notEqual(a, executionScopeHash('/data', 7, 'n1', '/work'), '跨节点不同')
    assert.notEqual(a, executionScopeHash('/data', 7, 'local', '/work-2'), '跨 cwd/worktree 不同')
    assert.notEqual(a, executionScopeHash('/data-2', 7, 'local', '/work'), '跨 Helm 实例不同')
    // 输入序列化无分隔符歧义：组件拼接不产生碰撞。
    assert.notEqual(
      executionScopeHash('/data', 7, 'local', '/a'),
      executionScopeHash('/data', 7, 'locala', ''),
    )
  })

  it('buildManagedEnv 注入 scope；buildToolEnv 受管固定覆盖逐调用注入', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'scope-1'))
    const managed = buildManagedEnv(deps, '/work', 9, 'local')
    assert.equal(managed['HELM_EXECUTION_SCOPE'], executionScopeHash(deps.dataDir, 9, 'local', '/work'))
    const composed = composeExecutionEnv(
      'local',
      buildManagedEnv(deps, '/work', 9, 'local'),
      { HELM_EXECUTION_SCOPE: 'spoofed-scope', OTHER: 'kept' },
    )
    assert.ok(composed['HELM_EXECUTION_SCOPE']!.startsWith('helm-'), '逐调用注入不得覆盖受管 scope')
    assert.equal(composed['OTHER'], 'kept', '非受管键正常透传')
  })

  it('runShell 子进程可见 scope：同会话同靶点多命令恒定、跨会话隔离', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'scope-2'))
    mkdirSync(join(rootDir, 'scope-2', 'sub'), { recursive: true })
    const readScope = async (conversationId: number, cwd?: string) => {
      const result = await runShell(deps, 'printf %s "$HELM_EXECUTION_SCOPE"', {
        conversationId,
        ...(cwd !== undefined ? { cwd } : {}),
      })
      assert.equal(result.ok, true, result.output)
      return result.output
    }
    const s1a = await readScope(1)
    const s1b = await readScope(1)
    assert.match(s1a, /^helm-[0-9a-f]{24}$/)
    assert.equal(s1a, s1b, '同会话同靶点多命令 scope 恒定')
    const s2 = await readScope(2)
    assert.notEqual(s1a, s2, '跨会话 scope 隔离')
    const s1other = await readScope(1, join(rootDir, 'scope-2', 'sub'))
    assert.notEqual(s1a, s1other, '同会话不同 cwd（如另一 worktree）scope 隔离')
    assert.match(s1other!, /^helm-[0-9a-f]{24}$/)
    // 与 buildManagedEnv 合成值一致（同 dataDir/会话/节点/cwd）。
    assert.equal(s1a, executionScopeHash(deps.dataDir, 1, 'local', deps.defaultCwd))
  })

  it('宿主继承的 scope（含大小写变体）被剥除；受管值固定覆盖', { timeout: 60_000 }, () => {
    const saved: Record<string, string | undefined> = {}
    const injected: Array<[string, string]> = [
      ['HELM_EXECUTION_SCOPE', 'host-scope'],
      ['helm_execution_scope', 'host-scope-variant'],
    ]
    for (const [key, value] of injected) {
      saved[key] = process.env[key]
      process.env[key] = value
    }
    try {
      const composed = composeExecutionEnv('local', { HELM_EXECUTION_SCOPE: 'managed-scope' })
      assert.equal(composed['HELM_EXECUTION_SCOPE'], 'managed-scope')
      assert.equal(composed['helm_execution_scope'], undefined, '大小写变体一并剥除')
      assert.equal(composed['HELM_EXECUTION_SCOPE'] !== 'host-scope' as string, true)
    } finally {
      for (const [key] of injected) {
        const prev = saved[key]
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }
    }
  })

  it('Herdr 窗格：Profile 注入的 HELM_EXECUTION_SCOPE 被受管值固定覆盖', { timeout: 60_000 }, async () => {
    const deps = await makeDeps(join(rootDir, 'scope-3'))
    const managed = buildManagedEnv(deps, '/wt/pane', 12, 'local')
    const { env } = buildSpawnPaneEnv(
      managed,
      { HELM_EXECUTION_SCOPE: 'evil-scope', CUSTOM: 'ok' },
      { remote: false },
    )
    assert.equal(env['HELM_EXECUTION_SCOPE'], managed['HELM_EXECUTION_SCOPE'], '受管 scope 权威')
    assert.equal(env['CUSTOM'], 'ok', '非受管 Profile env 正常保留')
  })

  it('scope 别名劫持防护：stash / profileEnv / 授予值的大小写变体一律剥除', { timeout: 60_000 }, async () => {
    // 1) stash 别名：secret 命中 helm_execution_scope / Helm_Cwd 等变体时，
    //    buildManagedEnv 直接剥除（Windows env 名大小写不敏感，别名可劫持）。
    const stash = new SecretStash()
    const evilScope = '{{SECRET_evil_scope}}'
    const evilCwd = '{{SECRET_evil_cwd}}'
    stash.put(1, 'helm_execution_scope', evilScope)
    stash.put(1, 'Helm_Cwd', evilCwd)
    stash.put(1, 'LEGIT', 'kept')
    const dir = join(rootDir, 'scope-alias-1')
    await ensureDataDir(dir)
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: (id) => stash.envFor(id),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const env = buildManagedEnv(deps, '/work', 1, 'local')
    assert.equal('helm_execution_scope' in env, false, 'stash lowercase 别名必须剥除')
    assert.equal('Helm_Cwd' in env, false, 'stash 混合大小写别名必须剥除')
    assert.ok(env['HELM_EXECUTION_SCOPE']!.startsWith('helm-'), 'canonical scope 权威存在')
    assert.equal(env['HELM_CWD'], '/work', 'canonical HELM_CWD 权威')
    assert.equal(env['LEGIT'], 'kept', '非受管 secret 正常注入')
    // 子进程实测：任何大小写形式都只解析出受管 scope（Windows 语义等价验证）。
    const probe = await runShell(deps, 'printf %s "$HELM_EXECUTION_SCOPE"', { conversationId: 1 })
    assert.equal(probe.ok, true)
    assert.ok(probe.output.startsWith('helm-'), '子进程读到的是受管 scope 而非别名')

    // 2) Profile env 别名：buildSpawnPaneEnv 大小写不敏感剥除受管键。
    const managed = buildManagedEnv(deps, '/wt', 1, 'local')
    const pane = buildSpawnPaneEnv(
      managed,
      { helm_execution_scope: 'evil', Helm_Execution_Scope: 'evil2', OK_VALUE: 'ok' },
      { remote: false },
    )
    assert.equal('helm_execution_scope' in pane.env, false)
    assert.equal('Helm_Execution_Scope' in pane.env, false)
    assert.equal(pane.env['HELM_EXECUTION_SCOPE'], managed['HELM_EXECUTION_SCOPE'])
    assert.equal(pane.env['OK_VALUE'], 'ok')

    // 3) 授予值别名：mergeGrantedEnvWithManagedLocks 剥除变体并重申基线。
    const merged = mergeGrantedEnvWithManagedLocks(
      { HELM_EXECUTION_SCOPE: managed['HELM_EXECUTION_SCOPE']!, HELM_CWD: '/base' },
      { helm_execution_scope: 'evil-granted', GRANTED_KEY: 'ok' },
    )
    assert.equal('helm_execution_scope' in merged, false, '授予名命中变体不得劫持基线 scope')
    assert.equal(merged['HELM_EXECUTION_SCOPE'], managed['HELM_EXECUTION_SCOPE'])
    assert.equal(merged['GRANTED_KEY'], 'ok', '非受管授予值正常保留')
  })
})
