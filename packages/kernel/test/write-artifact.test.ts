import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
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
import { createWriteTool } from '../src/runtime/tools.js'
import type { HelmToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'

describe('write 工具登记产物特性', { timeout: 60_000 }, () => {
  let rootDir: string

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'helm-write-artifact-test-'))
  })

  after(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  function makeApi(cwd: string, conversationId = 1) {
    return {
      taskId: 'test-task',
      conversationId,
      callId: 'call-test-write',
      agent: async () => ({ cwd }),
      retainedOutput: () => ({ text: '', truncated: false }),
    }
  }

  it('local 节点：默认 artifact: undefined/false 仅写入 cwd，不登记产物', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-plain')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const tool = createWriteTool(deps)
    const res = await tool.execute(
      { path: 'note.txt', content: 'hello world' },
      makeApi(dir, 1) as never,
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, undefined)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.match(outputText, /^write_ok: note\.txt（11 字节）$/)
    assert.doesNotMatch(outputText, /\[Artifact\]/)
    const structured = res.structuredOutput as { path: string; bytesWritten: number; artifactId?: string }
    assert.equal(structured.path, 'note.txt')
    assert.equal(structured.bytesWritten, 11)
    assert.equal(structured.artifactId, undefined)
    assert.equal(readFileSync(join(dir, 'note.txt'), 'utf8'), 'hello world')
    // 产物仓库应为空
    assert.equal((await artifacts.list(1)).length, 0)
  })

  it('local 节点：artifact: true 同步写入 cwd 并登记为会话产物，返回 [Artifact] 与 artifactId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-art')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const tool = createWriteTool(deps)
    const res = await tool.execute(
      { path: 'reports/chart.svg', content: '<svg>circle</svg>', artifact: true },
      makeApi(dir, 2) as never,
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, undefined)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.match(outputText, /write_ok: reports\/chart\.svg（17 字节）/)
    assert.match(outputText, /\[Artifact\] id=([A-Za-z0-9-]+) name=chart\.svg/)
    const structured = res.structuredOutput as { path: string; bytesWritten: number; artifactId?: string }
    assert.equal(structured.path, 'reports/chart.svg')
    assert.equal(structured.bytesWritten, 17)
    assert.ok(typeof structured.artifactId === 'string')

    // 验证文件在 cwd 与产物服务中都存在
    assert.equal(readFileSync(join(dir, 'reports/chart.svg'), 'utf8'), '<svg>circle</svg>')
    const metaList = await artifacts.list(2)
    assert.equal(metaList.length, 1)
    assert.equal(metaList[0]!.id, structured.artifactId)
    assert.equal(metaList[0]!.name, 'chart.svg')
  })

  it('artifact: true 但产物服务未配置 writeUploaded 时显式报错', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'no-write-uploaded')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts: HelmToolDeps['artifacts'] = {
      spill: async () => ({ text: '' }),
      get: async () => { throw new Error('not implemented') },
      readContent: async () => '',
      readBuffer: async () => Buffer.alloc(0),
      writeUploaded: undefined,
    }
    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const tool = createWriteTool(deps)
    const res = await tool.execute(
      { path: 'test.md', content: '# 测试', artifact: true },
      makeApi(dir, 3) as never,
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, true)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(outputText, 'write_failed: 产物服务未配置 writeUploaded，无法登记会话产物')
  })

  it('远端节点：artifact: true 写入远端并同步登记会话产物', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-art')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const remoteFiles = new Map<string, string>()
    const stubEnv = {
      async canonicalPath(p: string) {
        return { ok: true as const, value: p }
      },
      async createDir() {
        return { ok: true as const, value: void 0 }
      },
      async writeFile(p: string, content: string) {
        remoteFiles.set(p, content)
        return { ok: true as const, value: void 0 }
      },
    }
    const stubFabric: EnvFabric = {
      registry: {} as never,
      envFor: () => stubEnv as never,
      envForTarget: () => { throw new Error('not used') },
      isOnline: () => true,
      waitForOnline: () => Promise.resolve(true),
      getNodeHubUrl: () => 'http://10.0.0.5:3202',
      evictConversation: () => undefined,
      debugBaseCount: () => 0,
      debugBases: () => [],
      ipcCall: () => { throw new Error('not used') },
      ipcSubscribe: () => { throw new Error('not used') },
      dispose: () => Promise.resolve(),
    } as never

    const deps: HelmToolDeps = {
      dataDir: dir,
      defaultCwd: '/remote/workspace',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => stash.redact(t),
      artifacts,
      envFabric: stubFabric,
      nodeIdOf: () => 'worker-node-1',
    }
    const tool = createWriteTool(deps)
    const res = await tool.execute(
      { path: 'output/result.json', content: '{"status":"done"}', artifact: true },
      makeApi('/remote/workspace', 5) as never,
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, undefined)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.match(outputText, /write_ok: output\/result\.json（17 字节）/)
    assert.match(outputText, /\[Artifact\] id=([A-Za-z0-9-]+) name=result\.json/)
    const structured = res.structuredOutput as { path: string; bytesWritten: number; artifactId?: string }
    assert.equal(structured.path, 'output/result.json')
    assert.ok(typeof structured.artifactId === 'string')
    assert.equal(remoteFiles.get('/remote/workspace/output/result.json'), '{"status":"done"}')
    const metas = await artifacts.list(5)
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.id, structured.artifactId)
    assert.equal(metas[0]!.name, 'result.json')
  })
})
