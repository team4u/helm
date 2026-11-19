import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
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
import type { HelmxToolDeps } from '../src/runtime/tool-deps.js'
import type { EnvFabric } from '../src/env/index.js'

describe('write tool artifact registration behavior', { timeout: 60_000 }, () => {
  let rootDir: string

  before(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'helmx-write-artifact-test-'))
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

  it('local node: when artifact is undefined or false, only writes to cwd without registering artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-plain')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmxToolDeps = {
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
    const noteAbs = join(dir, 'note.txt')
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(outputText, `write_ok: ${noteAbs} (node local, 11 bytes)`)
    assert.doesNotMatch(outputText, /\[Artifact\]/)
    const structured = res.structuredOutput as { path: string; nodeId: string; bytesWritten: number; artifactId?: string }
    assert.equal(structured.path, noteAbs, 'structured path should return resolved real absolute path')
    assert.equal(structured.nodeId, 'local')
    assert.equal(structured.bytesWritten, 11)
    assert.equal(structured.artifactId, undefined)
    // details stays aligned with structuredOutput for UI rendering (bytes written and artifact badges).
    assert.deepEqual(res.details, structured)
    assert.equal(readFileSync(noteAbs, 'utf8'), 'hello world')
    // artifact repository should be empty
    assert.equal((await artifacts.list(1)).length, 0)
  })

  it('local node: artifact: true writes cwd and synchronously registers conversation artifact, returning [Artifact] and artifactId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'local-art')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const deps: HelmxToolDeps = {
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
    const chartAbs = join(dir, 'reports', 'chart.svg')
    const structured = res.structuredOutput as { path: string; nodeId: string; bytesWritten: number; artifactId?: string }
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(
      outputText,
      `write_ok: ${chartAbs} (node local, 17 bytes)\n[Artifact] id=${structured.artifactId} name=chart.svg`,
    )
    assert.equal(structured.path, chartAbs, 'structured path should return resolved real absolute path')
    assert.equal(structured.nodeId, 'local')
    assert.equal(structured.bytesWritten, 17)
    assert.ok(typeof structured.artifactId === 'string')

    // verify both the cwd file and the registered artifact metadata exist
    assert.equal(readFileSync(chartAbs, 'utf8'), '<svg>circle</svg>')
    const metaList = await artifacts.list(2)
    assert.equal(metaList.length, 1)
    assert.equal(metaList[0]!.id, structured.artifactId)
    assert.equal(metaList[0]!.name, 'chart.svg')
  })

  it('artifact: true returns explicit error when artifact service does not support writeUploaded', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'no-write-uploaded')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts: HelmxToolDeps['artifacts'] = {
      spill: async () => ({ text: '' }),
      get: async () => { throw new Error('not implemented') },
      readContent: async () => '',
      readBuffer: async () => Buffer.alloc(0),
      writeUploaded: undefined,
    }
    const deps: HelmxToolDeps = {
      dataDir: dir,
      defaultCwd: dir,
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t) => stash.redact(t),
      artifacts,
    }
    const tool = createWriteTool(deps)
    const res = await tool.execute(
      { path: 'test.md', content: '# test', artifact: true },
      makeApi(dir, 3) as never,
      BACKGROUND_CONTEXT,
    )
    assert.equal(res.isError, true)
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.equal(outputText, 'write_failed: artifact service does not support writeUploaded; cannot register conversation artifact')
  })

  it('remote node: artifact: true writes remotely and synchronously registers conversation artifact', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'remote-art')
    await ensureDataDir(dir)
    const stash = new SecretStash()
    const artifacts = new ArtifactService(dir, new InMemoryArtifactRepository(), stash)
    const remoteFiles = new Map<string, string>()
    const stubEnv = {
      id: 'remote:stub-node',
      async absolutePath(p: string) {
        return { ok: true as const, value: p }
      },
      async joinPath(parts: string[]) {
        return { ok: true as const, value: parts.join('/') }
      },
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

    const deps: HelmxToolDeps = {
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
    const resultAbs = '/remote/workspace/output/result.json'
    const outputText = (res.output as Array<{ text: string }>)[0]!.text
    assert.ok(outputText.startsWith(`write_ok: ${resultAbs} (node worker-node-1, 17 bytes)`), `should echo remote absolute path and node (${outputText})`)
    assert.match(outputText, /\[Artifact\] id=([A-Za-z0-9-]+) name=result\.json/)
    const structured = res.structuredOutput as { path: string; nodeId: string; bytesWritten: number; artifactId?: string }
    assert.equal(structured.path, resultAbs, 'remote structured path should return remote absolute path')
    assert.equal(structured.nodeId, 'worker-node-1')
    assert.ok(typeof structured.artifactId === 'string')
    assert.equal(remoteFiles.get(resultAbs), '{"status":"done"}')
    const metas = await artifacts.list(5)
    assert.equal(metas.length, 1)
    assert.equal(metas[0]!.id, structured.artifactId)
    assert.equal(metas[0]!.name, 'result.json')
  })
})
