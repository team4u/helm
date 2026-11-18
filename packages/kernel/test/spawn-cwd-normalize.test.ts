/**
 * Native subagent cwd normalization (runNativeSpawn) and resolveSpawnTarget (authoritative kernel resolver
 * for workflow worktree source directories):
 * - Fresh spawn: cwd chain (request > profile > parent > Hub default) result is normalized uniformly for target node
 *   platform across SDK createConversation / child conversation mirror / onResolved / before gate;
 * - Remote node platform relies solely on TrustedNodePlatformSource (NodeRegistry registered fact injection):
 *   win32 target converts WSL/mixed separators deterministically; unmappable POSIX cwd fails explicitly without
 *   creating a child conversation (or mirror); unknown platform passes through unchanged;
 * - Resume: strictly preserves existing conversation cwd by default (semantics unchanged); explicit cwd routes through
 *   updateConversation port (same normalization chain as ConversationService);
 * - resolveSpawnTarget: normalizes sourceCwd per final node platform (entry point for builtin:workflow
 *   isolated worktree source dirs); returns parentCwd verbatim (raw parent conversation mirror state).
 *
 * Uses real SDK Harness (MemoryStorage + faux provider); host ports use in-process Maps
 * for mirrors (matching spawn-ask). envFabric uses a structural stub only to supply registry platform
 * facts (per TrustedPlatformHost in target-cwd), never mocking normalization itself.
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

/** Builds an envFabric stub: remote comes from registry; local can inject Hub platform fact. */
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
    // Construct platform fact stub (remote registry; local injects Hub platform explicitly).
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
      if (!m) throw new HelmError('not_found', `conversation not found: ${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmError('not_found', `child conversation not found: ${childId}`, 404)
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

test('fresh spawn: cwd is normalized identically across SDK create, mirror, and onResolved (local platform)', { timeout: 60_000 }, async () => {
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
    assert.equal(resolved?.effectiveCwd, '/tmp/helm/wt/a/c', 'onResolved returns canonical cwd once POSIX Hub platform is injected')
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/tmp/helm/wt/a/c', 'child conversation mirror stores canonical cwd')
  } finally {
    await env.close()
  }
})

test('fresh spawn: remote win32 node (registered platform injected) -- deterministic WSL path conversion', { timeout: 60_000 }, async () => {
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
    assert.equal(mirror.cwd, 'C:\\repo\\helm', 'mirror stores Windows canonical path')
    assert.equal(mirror.nodeId, 'win-build')
  } finally {
    await env.close()
  }
})

test('fresh spawn: unmappable POSIX cwd on remote win32 node fails explicitly without creating child conversation', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ platforms: { 'win-build': 'win32' }, profiles: { assistant: { nodeId: 'win-build' } } })
  try {
    await assert.rejects(
      runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'dry', cwd: '/home/build' } as never),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    assert.equal(env.mirrors.size, 0, 'unmappable POSIX cwd does not create child conversation mirror')
  } finally {
    await env.close()
  }
})

test('fresh spawn: remote node with unknown platform -- passes cwd through unmodified (never guesses platform)', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ profiles: { assistant: { nodeId: 'mystery-node' } } })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'dry', cwd: '/home/build' } as never)
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/home/build', 'unknown platform keeps cwd verbatim')
  } finally {
    await env.close()
  }
})

test('fresh spawn: relative cwd rejects (preserves existing absolute path contract)', { timeout: 60_000 }, async () => {
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

test('resume: preserves original conversation cwd by default (no recompute, no update)', { timeout: 60_000 }, async () => {
  // Inject POSIX Hub platform: /tmp default cwd at end of fallback chain cannot map on win32 hosts,
  // and this case asserts resume semantics rather than cross-platform normalization.
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    const first = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'first round' } as never)
    assert.equal(first, 'first')
    const childId = [...env.mirrors.keys()].at(-1)!
    env.updates.length = 0
    const second = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: 'resume', resume: String(childId) } as never)
    assert.equal(second, 'second')
    assert.equal(env.updates.length, 0, 'default resume triggers no config update (cwd semantics unchanged)')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm-spawn-default', 'default keeps original conversation cwd')
  } finally {
    await env.close()
  }
})

test('resume: explicit cwd is passed through updateConversation port (normalized identically at service layer)', { timeout: 60_000 }, async () => {
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
    assert.equal(update.patch['cwd'], '/tmp/helm/moved/dir', 'explicit cwd flows through updateConversation port (service-layer normalization)')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm/moved/dir')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// resolveSpawnTarget (authoritative kernel entry point for builtin:workflow worktree source dirs)
// ---------------------------------------------------------------------------

/** Minimal RuntimeAgentSpawn fixture (only exercises resolveSpawnTarget; other ports throw). */
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
      throw new Error('unused in this test')
    }) as never,
    markConversationOwnership: () => undefined,
  })
  return (input: { parentConversationId: number; profileId?: string; requestCwd?: string }) =>
    spawn.resolveSpawnTarget(input)
}

test('resolveSpawnTarget: normalizes sourceCwd per resolved node platform (win32 convert / unknown passthrough / posix canonical)', { timeout: 60_000 }, async () => {
  // Remote win32: explicit requestCwd and profile/parent fallbacks all normalize per target platform.
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { cwd: '/mnt/c/parent', nodeId: 'win-build' } })
  assert.deepEqual(
    await resolve({ parentConversationId: 1, requestCwd: '/mnt/c/req/helm' }),
    { nodeId: 'win-build', sourceCwd: 'C:\\req\\helm', parentCwd: '/mnt/c/parent' },
  )
  assert.equal((await resolve({ parentConversationId: 1 })).sourceCwd, 'C:\\parent', 'parent cwd fallback normalizes too')

  // Unknown platform: passes through (parent points to unregistered remote; avoids falling back to Hub local platform).
  const unknown = spawnTargetResolver({ platforms: {}, parent: { cwd: '/home/keep', nodeId: 'mystery-node' } })
  assert.equal((await unknown({ parentConversationId: 1 })).sourceCwd, '/home/keep')

  // Local POSIX: explicitly inject Hub platform to test path normalization deterministically across hosts.
  const local = spawnTargetResolver({ platforms: {}, hubPlatform: 'linux', parent: {} })
  assert.equal((await local({ parentConversationId: 1, requestCwd: '/tmp/x/./y/../z' })).sourceCwd, '/tmp/x/z')
})

test('resolveSpawnTarget: unmappable POSIX sourceCwd on remote win32 target rejects explicitly (no silent worktree dir)', { timeout: 60_000 }, async () => {
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { nodeId: 'win-build' } })
  await assert.rejects(
    resolve({ parentConversationId: 1, requestCwd: '/home/build' }),
    (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
  )
})

// ---------------------------------------------------------------------------
// spawnAgent entry guard: Profile.restrictToCwd confines explicit request cwd to the parent cwd
// ---------------------------------------------------------------------------

/** Minimal spawnAgent fixture: store/hookBridge stubs; the sentinel proves execution passed the guard. */
function spawnEntryGuard(options: { restricted: boolean; parentCwd: string }) {
  const spawn = new RuntimeAgentSpawn({
    store: { getConv: () => ({ id: 1, cwd: options.parentCwd, profileId: 'worker' }) } as never,
    toolDeps: { defaultCwd: '/tmp/helm-fallback', restrictToCwdOf: async () => options.restricted } as never,
    harness: {} as never,
    registry: {} as never,
    tracker: {} as never,
    conversations: {} as never,
    events: {} as never,
    envFabric: {} as never,
    modelsRegistry: {} as never,
    hookBridge: {
      runHookAround: async () => {
        throw new Error('past-guard')
      },
    } as never,
    stashService: {} as never,
    updateConversation: (() => {
      throw new Error('unused in this test')
    }) as never,
    markConversationOwnership: () => undefined,
  })
  return (request: Record<string, unknown>) => spawn.spawnAgent(request as never)
}

test('spawnAgent guard: restricted parent rejects explicit cwd outside the parent cwd with path_outside_workspace', { timeout: 60_000 }, async () => {
  const spawn = spawnEntryGuard({ restricted: true, parentCwd: '/tmp/helm/repo' })
  await assert.rejects(
    spawn({ parentConversationId: 1, prompt: 'x', cwd: '/etc' }),
    (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'path_outside_workspace')
      assert.equal(error.status, 403)
      assert.ok(error.message.includes('/etc'))
      return true
    },
  )
  await assert.rejects(
    spawn({ parentConversationId: 1, prompt: 'x', cwd: '../outside' }),
    (error: unknown) => {
      assert.ok(error instanceof HelmError)
      assert.equal(error.code, 'path_outside_workspace')
      return true
    },
  )
})

test('spawnAgent guard: inside cwd / unrestricted parent / absent cwd all pass the guard', { timeout: 60_000 }, async () => {
  const restricted = spawnEntryGuard({ restricted: true, parentCwd: '/tmp/helm/repo' })
  // Inside subdir and the cwd itself pass; execution proceeds until the hook sentinel.
  await assert.rejects(restricted({ parentConversationId: 1, prompt: 'x', cwd: '/tmp/helm/repo/sub' }), /past-guard/)
  const unrestricted = spawnEntryGuard({ restricted: false, parentCwd: '/tmp/helm/repo' })
  await assert.rejects(unrestricted({ parentConversationId: 1, prompt: 'x', cwd: '/etc' }), /past-guard/)
  await assert.rejects(restricted({ parentConversationId: 1, prompt: 'x' }), /past-guard/)
})
