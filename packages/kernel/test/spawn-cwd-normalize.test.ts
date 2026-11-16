/**
 * original generate subagent cwd consolidate (runNativeSpawn) and resolveSpawnTarget(workflow
 * worktree source directory kernel right threat parse) test:
 * - creates new spawn:cwd chain (request > profile > parent > Hub default) parse result in
 *   SDK createConversation / sub-conversation mirror / onResolved / gate before by target node
 *   platform unify consolidate;
 * - remote node platform only message TrustedNodePlatformSource(NodeRegistry register fact inject):
 *   win32 target on WSL / symbol view determinism convert; broken POSIX cwd explicit failed and do not create
 *   sub-conversation (do not mirror); platform unknown pass-through do not change write;
 * - resume: default strictly along use atomic conversation cwd(semantics do not change); explicit cwd via
 *   updateConversation port (produce is ConversationService the same consolidate chain) should use;
 * - resolveSpawnTarget:sourceCwd by eventually node platform consolidate (builtin:workflow
 *   isolation  worktree source directory entry);parentCwd original return (parent conversation mirror fact).
 *
 * real SDK Harness(MemoryStorage + faux provider); host port use process inside Map
 * mirror (and spawn-ask same construct).envFabric use structure stub only provide registry platform
 * fact (target-cwd  TrustedPlatformHost structure), never mock specification itself.
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmError } from '@helm/protocol'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { RuntimeAgentSpawn } from '../src/runtime/runtime-agent-spawn.js'
import type { TrustedPlatformHost } from '../src/runtime/target-cwd.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'
import type { EnvFabric } from '../src/env/index.js'
import { cleanupDir, makeFauxModels, makeTempDir } from './helpers.js'

type FauxHandle = ReturnType<typeof makeFauxModels>['faux']

interface SpawnEnv {
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  mirrors: Map<number, { profileId: string; cwd: string; nodeId?: string; model: string }>
  updates: Array<{ id: number; patch: Record<string, unknown> }>
  close(): Promise<void>
}

/** structure envFabric stub: remote take registry,local can inject Hub platform fact. */
function platformHostOf(platforms: Record<string, string>, hubPlatform?: string): TrustedPlatformHost {
  return {
    registry: {
      get: (nodeId: string): { platform: string } | undefined =>
        platforms[nodeId] !== undefined ? { platform: platforms[nodeId] } : undefined,
    },
    hubPlatform: () => hubPlatform,
  }
}

async function openSpawnEnv(options: {
  platforms?: Record<string, string>
  hubPlatform?: string
  profiles?: Record<string, { cwd?: string; nodeId?: string }>
} = {}): Promise<SpawnEnv> {
  const { models, faux } = makeFauxModels()
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(storage, { models: () => models, registry }, BACKGROUND_CONTEXT)

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const profiles = new Map<string, { cwd?: string; nodeId?: string }>(
    Object.entries(options.profiles ?? { assistant: {} }),
  )
  const mirrors = new Map<number, { profileId: string; cwd: string; nodeId?: string; model: string }>()
  const updates: Array<{ id: number; patch: Record<string, unknown> }> = []
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()
  const dataDir = await makeTempDir('helm-spawn-cwd-')

  const deps: NativeSpawnDeps = {
    dataDir,
    defaultCwd: '/tmp/helm-spawn-default',
    hubUrl: 'http://127.0.0.1:3200',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService(dataDir, { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    // structure platform fact stub(remote registry;local by explicit Hub platform inject).
    envFabric: platformHostOf(options.platforms ?? {}, options.hubPlatform) as unknown as EnvFabric,
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    structuredOutputSessions: new Map(),
    registerChildConversation: async (childId, parentId, profileId, childCwd, _modelMirror, _tags, _thinking, nodeId) => {
      parents.set(childId, parentId)
      mirrors.set(childId, { profileId, cwd: childCwd, ...(nodeId !== undefined ? { nodeId } : {}), model: 'faux/faux-1' })
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      const observer = {
        advance: (call: { kind: string; value: { entries: Array<{ kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }> } }) => {
          if (call.kind !== 'value') return
          const view = call.value
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const entry = view.entries[i]!
            if (entry.kind !== 'pi.assistant') continue
            const text = (entry.model?.[0]?.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (text !== '') {
              lastTexts.set(childId, text)
              break
            }
          }
        },
        end: () => {},
      }
      const observation = await harness.observeConversation(childId as never, observer as never, BACKGROUND_CONTEXT)
      observers.set(childId, () => observation.detach())
    },
    resolveProfile: async (profileId) => {
      if (!profiles.has(profileId)) return undefined
      const p = profiles.get(profileId)!
      return { cwd: p.cwd, nodeId: p.nodeId }
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: () => undefined,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: `subagent ${childId}`,
        profileId: m.profileId,
        tags: [],
        cwd: m.cwd,
        model: m.model,
        thinkingLevel: '',
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 1,
        updatedAt: 1,
        ...(m.nodeId !== undefined ? { nodeId: m.nodeId } : {}),
      }
    },
    updateConversation: async (childId, patch) => {
      updates.push({ id: childId, patch: patch as Record<string, unknown> })
      const m = mirrors.get(childId)
      if (!m) throw new HelmError('not_found', `conversation missing:${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmError('not_found', `sub-conversation missing:${childId}`, 404)
      if (patch.cwd !== undefined) await conv.configure({ cwd: patch.cwd } as never, BACKGROUND_CONTEXT)
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
  }
  return {
    harness,
    deps,
    faux,
    mirrors,
    updates,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
      await cleanupDir(dataDir)
    },
  }
}

test('creates new spawn:cwd term method archive one enter SDK create, mirror and onResolved(local platform)', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    let resolved: { effectiveCwd?: string } | undefined
    await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: 'dry',
      cwd: '/tmp/helm/wt/a/./b/../c',
      onResolved: (info: unknown) => {
        resolved = info as { effectiveCwd?: string }
      },
    } as never)
    assert.equal(resolved?.effectiveCwd, '/tmp/helm/wt/a/c', 'inject POSIX Hub platform after onResolved back pass specification cwd')
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/tmp/helm/wt/a/c', 'sub-conversation mirror register specification cwd')
  } finally {
    await env.close()
  }
})

test('creates new spawn: remote win32 node (can message platform inject) - -WSL view determinism convert', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ platforms: { 'win-build': 'win32' }, profiles: { assistant: { nodeId: 'win-build' } } })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    let resolved: { nodeId?: string; effectiveCwd?: string } | undefined
    await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: 'dry',
      cwd: '/mnt/c/repo/helm',
      onResolved: (info: unknown) => {
        resolved = info as { nodeId?: string; effectiveCwd?: string }
      },
    } as never)
    assert.equal(resolved?.nodeId, 'win-build')
    assert.equal(resolved?.effectiveCwd, 'C:\\repo\\helm')
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, 'C:\\repo\\helm', 'mirror register Windows canonical path')
    assert.equal(mirror.nodeId, 'win-build')
  } finally {
    await env.close()
  }
})

test('creates new spawn: remote win32 node on broken POSIX cwd explicit failed and do not create sub-conversation', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ platforms: { 'win-build': 'win32' }, profiles: { assistant: { nodeId: 'win-build' } } })
  try {
    await assert.rejects(
      runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'dry', cwd: '/home/build' } as never),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    assert.equal(env.mirrors.size, 0, 'broken POSIX cwd do not sub-conversation mirror')
  } finally {
    await env.close()
  }
})

test('creates new spawn: remote node platform unknown - -cwd pass-through do not change write (do not guess platform)', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ profiles: { assistant: { nodeId: 'mystery-node' } } })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'dry', cwd: '/home/build' } as never)
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/home/build', 'platform unknown: original keep')
  } finally {
    await env.close()
  }
})

test('creates new spawn:cwd relative path reject (since has absolute path contract keep)', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv()
  try {
    for (const bad of ['relative/ws', 'C:relative']) {
      await assert.rejects(
        runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'dry', cwd: bad } as never),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `'${bad}' must reject`,
      )
    }
    assert.equal(env.mirrors.size, 0)
  } finally {
    await env.close()
  }
})

test('resume: default strictly along use atomic conversation cwd(do not heavy compute, produces no update)', { timeout: 60_000 }, async () => {
  // inject POSIX Hub platform:fallback chain tail /tmp default cwd in win32 host
  // local target on cannot mapping, this case assertion is resume semantics while non- platform consolidate.
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    const first = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'first round' } as never)
    assert.equal(first, 'first')
    const childId = [...env.mirrors.keys()].at(-1)!
    env.updates.length = 0
    const second = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'resume', resume: String(childId) } as never)
    assert.equal(second, 'second')
    assert.equal(env.updates.length, 0, 'resume default does not trigger config update (cwd semantics do not change)')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm-spawn-default', 'default along use atomic conversation cwd')
  } finally {
    await env.close()
  }
})

test('resume: explicit cwd via updateConversation port should use (produce is the same consolidate chain)', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'first round' } as never)
    const childId = [...env.mirrors.keys()].at(-1)!
    const second = await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: 'resume',
      resume: String(childId),
      cwd: '/tmp/helm/moved/dir',
    } as never)
    assert.equal(second, 'second')
    const update = env.updates.at(-1)!
    assert.equal(update.patch['cwd'], '/tmp/helm/moved/dir', 'explicit cwd away updateConversation port (service layer consolidate)')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm/moved/dir')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// resolveSpawnTarget(builtin:workflow worktree source directory kernel right threat entry)
// ---------------------------------------------------------------------------

/** most small RuntimeAgentSpawn install match (only drive resolveSpawnTarget; the rest port throw). */
function spawnTargetResolver(options: {
  platforms: Record<string, string>
  hubPlatform?: string
  parent: { cwd?: string; nodeId?: string }
  profiles?: Record<string, { cwd?: string; nodeId?: string }>
}) {
  const conversations = {
    readProfile: async (id: string) => options.profiles?.[id] ?? {},
  }
  const spawn = new RuntimeAgentSpawn({
    store: { getConv: () => options.parent } as never,
    toolDeps: { defaultCwd: '/tmp/helm-fallback' } as never,
    harness: {} as never,
    registry: {} as never,
    tracker: {} as never,
    conversations: conversations as never,
    events: {} as never,
    envFabric: platformHostOf(options.platforms, options.hubPlatform) as unknown as EnvFabric,
    modelsRegistry: {} as never,
    hookBridge: {} as never,
    stashService: {} as never,
    updateConversation: (() => {
      throw new Error('this test does not trigger')
    }) as never,
    markConversationOwnership: () => undefined,
  })
  return (input: { parentConversationId: number; profileId?: string; requestCwd?: string }) =>
    spawn.resolveSpawnTarget(input)
}

test('resolveSpawnTarget:sourceCwd by eventually node platform consolidate (win32 convert / unknown pass-through / posix archive one)', { timeout: 60_000 }, async () => {
  // remote win32: explicit requestCwd and profile.cwd,parent.cwd fall back all by target platform consolidate.
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { cwd: '/mnt/c/parent', nodeId: 'win-build' } })
  assert.deepEqual(
    await resolve({ parentConversationId: 1, requestCwd: '/mnt/c/req/helm' }),
    { nodeId: 'win-build', sourceCwd: 'C:\\req\\helm', parentCwd: '/mnt/c/parent' },
  )
  assert.equal((await resolve({ parentConversationId: 1 })).sourceCwd, 'C:\\parent', 'parent cwd fall back same consolidate')

  // platform unknown: pass-through (parent points to not registered remote, avoid back host local platform).
  const unknown = spawnTargetResolver({ platforms: {}, parent: { cwd: '/home/keep', nodeId: 'mystery-node' } })
  assert.equal((await unknown({ parentConversationId: 1 })).sourceCwd, '/home/keep')

  // local posix: explicit inject Hub platform, across host stable verify term method archive one.
  const local = spawnTargetResolver({ platforms: {}, hubPlatform: 'linux', parent: {} })
  assert.equal((await local({ parentConversationId: 1, requestCwd: '/tmp/x/./y/../z' })).sourceCwd, '/tmp/x/z')
})

test('resolveSpawnTarget: remote win32 target on broken POSIX sourceCwd explicit reject (worktree source directory not silently)', { timeout: 60_000 }, async () => {
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { nodeId: 'win-build' } })
  await assert.rejects(
    resolve({ parentConversationId: 1, requestCwd: '/home/build' }),
    (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
  )
})
