/**
 * 原生 subagent cwd 收口（runNativeSpawn）与 resolveSpawnTarget（workflow
 * worktree 源目录的内核权威解析）测试：
 * - 新建 spawn：cwd 链（request > profile > parent > Hub 缺省）解析结果在
 *   SDK createConversation / 子会话镜像 / onResolved / gate 之前按目标节点
 *   平台统一收口；
 * - 远端节点平台只信 TrustedNodePlatformSource（NodeRegistry 注册事实注入）：
 *   win32 目标上 WSL / 盘符根视图确定性转换；坏 POSIX cwd 显式失败且不创建
 *   子会话（不落镜像）；平台未知透传不改写；
 * - resume：缺省严格沿用原子会话 cwd（语义不变）；显式 cwd 经
 *   updateConversation 端口（生产为 ConversationService 同一收口链）应用；
 * - resolveSpawnTarget：sourceCwd 按最终节点平台收口（builtin:workflow
 *   isolation 的 worktree 源目录入口）；parentCwd 原样返回（父会话镜像事实）。
 *
 * 真实 SDK Harness（MemoryStorage + faux provider）；宿主端口用进程内 Map
 * 镜像（与 spawn-ask 同构）。envFabric 用结构性 stub 只提供 registry 平台
 * 事实（target-cwd 的 TrustedPlatformHost 结构），绝不 mock 规范化本身。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmError } from '@helm/protocol'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { RuntimeAgentSpawn } from '../src/runtime/runtime-agent-spawn.js'
import type { TrustedPlatformHost } from '../src/runtime/target-cwd.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'
import type { EnvFabric } from '../src/env/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface SpawnEnv {
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  mirrors: Map<number, { profileId: string; cwd: string; nodeId?: string; model: string }>
  updates: Array<{ id: number; patch: Record<string, unknown> }>
  close(): Promise<void>
}

/** 结构性 envFabric stub：远端取 registry，local 可注入 Hub 平台事实。 */
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
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
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
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-spawn-cwd-'))

  const deps: NativeSpawnDeps = {
    dataDir,
    defaultCwd: '/tmp/helm-spawn-default',
    hubUrl: 'http://127.0.0.1:3200',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService(dataDir, { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    // 结构性平台事实 stub（远端 registry；local 由显式 Hub 平台注入）。
    envFabric: platformHostOf(options.platforms ?? {}, options.hubPlatform) as unknown as EnvFabric,
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
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
        title: `子代理 ${childId}`,
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
      if (!m) throw new HelmError('not_found', `会话不存在：${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmError('not_found', `子会话不存在：${childId}`, 404)
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
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('新建 spawn：cwd 词法归一进 SDK 创建、镜像与 onResolved（local 平台）', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    let resolved: { effectiveCwd?: string } | undefined
    await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: '干活',
      cwd: '/tmp/helm/wt/a/./b/../c',
      onResolved: (info: unknown) => {
        resolved = info as { effectiveCwd?: string }
      },
    } as never)
    assert.equal(resolved?.effectiveCwd, '/tmp/helm/wt/a/c', '注入 POSIX Hub 平台后 onResolved 回传规范化 cwd')
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/tmp/helm/wt/a/c', '子会话镜像登记规范化 cwd')
  } finally {
    await env.close()
  }
})

test('新建 spawn：远端 win32 节点（可信平台注入）——WSL 视图确定性转换', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ platforms: { 'win-build': 'win32' }, profiles: { assistant: { nodeId: 'win-build' } } })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    let resolved: { nodeId?: string; effectiveCwd?: string } | undefined
    await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: '干活',
      cwd: '/mnt/c/repo/helm',
      onResolved: (info: unknown) => {
        resolved = info as { nodeId?: string; effectiveCwd?: string }
      },
    } as never)
    assert.equal(resolved?.nodeId, 'win-build')
    assert.equal(resolved?.effectiveCwd, 'C:\\repo\\helm')
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, 'C:\\repo\\helm', '镜像登记 Windows 规范路径')
    assert.equal(mirror.nodeId, 'win-build')
  } finally {
    await env.close()
  }
})

test('新建 spawn：远端 win32 节点上的坏 POSIX cwd 显式失败且不创建子会话', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ platforms: { 'win-build': 'win32' }, profiles: { assistant: { nodeId: 'win-build' } } })
  try {
    await assert.rejects(
      runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '干活', cwd: '/home/build' } as never),
      (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
    )
    assert.equal(env.mirrors.size, 0, '坏 POSIX cwd 不落子会话镜像')
  } finally {
    await env.close()
  }
})

test('新建 spawn：远端节点平台未知——cwd 透传不改写（不猜平台）', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ profiles: { assistant: { nodeId: 'mystery-node' } } })
  try {
    env.faux.setResponses([fauxAssistantMessage('ok')])
    await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '干活', cwd: '/home/build' } as never)
    const mirror = [...env.mirrors.values()].at(-1)!
    assert.equal(mirror.cwd, '/home/build', '平台未知：原样保持')
  } finally {
    await env.close()
  }
})

test('新建 spawn：cwd 相对路径拒绝（既有绝对路径契约保持）', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv()
  try {
    for (const bad of ['relative/ws', 'C:relative']) {
      await assert.rejects(
        runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '干活', cwd: bad } as never),
        (e: unknown) => e instanceof HelmError && e.code === 'validation_error',
        `'${bad}' 必须拒绝`,
      )
    }
    assert.equal(env.mirrors.size, 0)
  } finally {
    await env.close()
  }
})

test('resume：缺省严格沿用原子会话 cwd（不重算、不产生 update）', { timeout: 60_000 }, async () => {
  // 注入 POSIX Hub 平台：fallback 链尾的 /tmp 缺省 cwd 在 win32 宿主的
  // local 目标上不可映射，本用例断言的是 resume 语义而非平台收口。
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    const first = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '首轮' } as never)
    assert.equal(first, 'first')
    const childId = [...env.mirrors.keys()].at(-1)!
    env.updates.length = 0
    const second = await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '续接', resume: String(childId) } as never)
    assert.equal(second, 'second')
    assert.equal(env.updates.length, 0, 'resume 缺省不触发配置更新（cwd 语义不变）')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm-spawn-default', '缺省沿用原子会话 cwd')
  } finally {
    await env.close()
  }
})

test('resume：显式 cwd 经 updateConversation 端口应用（生产为同一收口链）', { timeout: 60_000 }, async () => {
  const env = await openSpawnEnv({ hubPlatform: 'linux' })
  try {
    env.faux.setResponses([fauxAssistantMessage('first'), fauxAssistantMessage('second')])
    await runNativeSpawn(env.deps, { parentConversationId: 1, prompt: '首轮' } as never)
    const childId = [...env.mirrors.keys()].at(-1)!
    const second = await runNativeSpawn(env.deps, {
      parentConversationId: 1,
      prompt: '续接',
      resume: String(childId),
      cwd: '/tmp/helm/moved/dir',
    } as never)
    assert.equal(second, 'second')
    const update = env.updates.at(-1)!
    assert.equal(update.patch['cwd'], '/tmp/helm/moved/dir', '显式 cwd 走 updateConversation 端口（服务层收口）')
    assert.equal(env.mirrors.get(childId)!.cwd, '/tmp/helm/moved/dir')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// resolveSpawnTarget（builtin:workflow worktree 源目录的内核权威入口）
// ---------------------------------------------------------------------------

/** 最小 RuntimeAgentSpawn 装配（只驱动 resolveSpawnTarget；其余端口 throw）。 */
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
      throw new Error('本测试不触发')
    }) as never,
    markConversationOwnership: () => undefined,
  })
  return (input: { parentConversationId: number; profileId?: string; requestCwd?: string }) =>
    spawn.resolveSpawnTarget(input)
}

test('resolveSpawnTarget：sourceCwd 按最终节点平台收口（win32 转换 / 未知透传 / posix 归一）', { timeout: 60_000 }, async () => {
  // 远端 win32：显式 requestCwd 与 profile.cwd、parent.cwd 回退均按目标平台收口。
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { cwd: '/mnt/c/parent', nodeId: 'win-build' } })
  assert.deepEqual(
    await resolve({ parentConversationId: 1, requestCwd: '/mnt/c/req/helm' }),
    { nodeId: 'win-build', sourceCwd: 'C:\\req\\helm', parentCwd: '/mnt/c/parent' },
  )
  assert.equal((await resolve({ parentConversationId: 1 })).sourceCwd, 'C:\\parent', 'parent cwd 回退同样收口')

  // 平台未知：透传（parent 指向未注册远端，避免落回宿主 local 平台）。
  const unknown = spawnTargetResolver({ platforms: {}, parent: { cwd: '/home/keep', nodeId: 'mystery-node' } })
  assert.equal((await unknown({ parentConversationId: 1 })).sourceCwd, '/home/keep')

  // local posix：显式注入 Hub 平台，跨宿主稳定验证词法归一。
  const local = spawnTargetResolver({ platforms: {}, hubPlatform: 'linux', parent: {} })
  assert.equal((await local({ parentConversationId: 1, requestCwd: '/tmp/x/./y/../z' })).sourceCwd, '/tmp/x/z')
})

test('resolveSpawnTarget：远端 win32 目标上的坏 POSIX sourceCwd 显式拒绝（worktree 源目录不静默）', { timeout: 60_000 }, async () => {
  const resolve = spawnTargetResolver({ platforms: { 'win-build': 'win32' }, parent: { nodeId: 'win-build' } })
  await assert.rejects(
    resolve({ parentConversationId: 1, requestCwd: '/home/build' }),
    (e: unknown) => e instanceof HelmError && e.code === 'unmappable_posix_root',
  )
})
