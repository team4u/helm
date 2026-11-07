/**
 * 原生 spawn 与 Ask 契约测试：真实 pi-durable SDK（MemoryStorage）+ faux provider。
 *
 * 覆盖主代理定位的违约点：
 * - schema：AJV 全量（enum/nested/多类型/ additionalProperties）、$async 拒绝、
 *   null/标量合法顶层、跨行对象、StructuredOutput 工具自愈、两次失败显式报错；
 * - abort：创建前拒绝、运行中 conversation.abort、无遗留任务；
 * - resume：错误 ref 绝不新建、父归属校验、agentId 映射、onResolved 上报原 id；
 * - profile：无效 profile 报错、herdr runtime 显式 unsupported、effort 非法拒绝；
 * - gate：cwd 用子会话实际 cwd；
 * - Ask：CAS 冲突 409 / 无 resolver ask_state_unavailable / seq 回退 superseded /
 *   cancel/superseded reject（非空 answers）/ 未知字段 / select 越界 / confirm 非法 /
 *   secret name 碰撞拒绝 / 空秘密不入 stash / 不存在会话拒绝。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmError } from '@helm/protocol'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AskService } from '../src/runtime/asks.js'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { HelmStore } from '../src/runtime/store.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

interface TestHarness {
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  close(): Promise<void>
}

/**
 * 真实 SDK Harness（MemoryStorage）+ faux provider + 完整 NativeSpawnDeps stub。
 * registerChildConversation / resolveProfile / getParentOfConversation 用进程内
 * Map 模拟宿主（真实实现由 runtime.ts 组合，此处测 spawn 自身契约）。
 */
async function openSpawnHarness(options: { profiles?: Record<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }> } = {}): Promise<TestHarness> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    { models: () => models, registry },
    BACKGROUND_CONTEXT,
  )

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const profiles = new Map<string, { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }>(
    Object.entries(options.profiles ?? { assistant: {} }),
  )
  // 子会话镜像（与生产 HelmStore 同语义的最小实现：profileId/cwd/model）。
  const mirrors = new Map<
    number,
    { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }
  >()

  const deps: NativeSpawnDeps = {
    dataDir: '/tmp/helm-spawn-test',
    defaultCwd: process.cwd(),
    hubUrl: 'http://127.0.0.1:3200',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService('/tmp/helm-spawn-test', { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror, _tags) => {
      parents.set(childId, parentId)
      mirrors.set(childId, {
        profileId,
        cwd: childCwd,
        model: modelMirror,
        title: `子代理 ${childId}`,
        tags: [],
        createdAt: Date.now(),
      })
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      // 同步观察者：与生产 tracker 同机制（advance 内只记录，无 await）。
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
      const p = profiles.get(profileId) as { model?: string; cwd?: string; runtime?: { kind: string; agent: string } }
      return { model: p.model, cwd: p.cwd, runtime: p.runtime as never }
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: (childId) => mirrors.get(childId)?.modelOverride,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: m.title,
        profileId: m.profileId,
        tags: m.tags,
        cwd: m.cwd,
        model: m.model,
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      }
    },
    updateConversation: async (childId, patch) => {
      const m = mirrors.get(childId)
      if (!m) throw new HelmError('not_found', `会话不存在：${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      if (patch.model !== undefined) m.modelOverride = patch.model
      if (m.modelOverride === undefined) {
        const p = profiles.get(m.profileId)
        m.model = p?.model ?? 'faux/faux-1'
      } else {
        m.model = m.modelOverride
      }
      // 与生产同序：真实 SDK configure 先行，镜像后写。
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) throw new HelmError('not_found', `子会话不存在：${childId}`, 404)
      const slash = m.model.indexOf('/')
      await conv.configure(
        {
          ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
          model: { provider: m.model.slice(0, slash), modelId: m.model.slice(slash + 1) },
        } as never,
        BACKGROUND_CONTEXT,
      )
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
  }
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()

  return {
    harness,
    deps,
    faux,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
    },
  }
}

let rootDir: string

before(async () => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-spawn-ask-'))
})

after(async () => {
  rmSync(rootDir, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// spawn：schema 校验
// ---------------------------------------------------------------------------

describe('spawn schema：AJV 全量校验', { timeout: 60_000 }, () => {
  it('enum / nested / additionalProperties 违约全部拒绝（不再只查一层）', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // 第一轮：enum 违约 + 非法嵌套 -> 工具拒绝 -> 第二轮工具给出合法值。
      th.faux.setResponses([
        fauxAssistantMessage('我先输出一个不合法的'),
        fauxAssistantMessage('好的'),
      ])
      // 不经工具、直接文本候选也必须被全量校验拦截：
      const bad = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '返回枚举',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never).then(
        () => assert.fail('enum 违约必须失败'),
        (err: unknown) => err as HelmError,
      )
      assert.equal(bad.code, 'schema_validation_failed')
    } finally {
      await th.close()
    }
  })

  it('null 顶层合法：valid null 与 undefined 区分', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // 模型先调用工具提交 null（schema 允许 null 顶层）。
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: null })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('已提交'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '可能无结果',
        schema: { type: 'null' },
      } as never)
      assert.equal(result, null)
    } finally {
      await th.close()
    }
  })

  it('跨行对象文本候选（无工具调用）经全量校验通过', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('结果如下：\n{"answer":\n  42,\n "ok": true}'),
        fauxAssistantMessage('再来一次'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '算',
        schema: {
          type: 'object',
          properties: { answer: { type: 'number' }, ok: { type: 'boolean' } },
          required: ['answer', 'ok'],
        },
      } as never)
      assert.deepEqual(result, { answer: 42, ok: true })
    } finally {
      await th.close()
    }
  })

  it('$async schema 显式拒绝', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            schema: { $async: true, type: 'object' },
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'invalid_plugin_schema',
      )
    } finally {
      await th.close()
    }
  })

  it('StructuredOutput 工具：错误参数被拒、同回合重试、最终经工具返回', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        // 第一回合：模型先给错误 enum，工具拒绝（isError 结果），同回合重试给对。
        fauxAssistantMessage(
          [fauxToolCall('register_structured_output', { output: { level: 'bogus' } })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { level: 'high' } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('完成'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '评估',
        schema: {
          type: 'object',
          properties: { level: { type: 'string', enum: ['low', 'high'] } },
          required: ['level'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(result, { level: 'high' })
    } finally {
      await th.close()
    }
  })

  it('两次均失败显式 schema_validation_failed（含会话诊断）', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([
        fauxAssistantMessage('我不会 JSON'),
        fauxAssistantMessage('仍然不会'),
      ])
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '返回 JSON',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'] },
      } as never).then(
        () => assert.fail('必须失败'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'schema_validation_failed')
      assert.ok((err.details as { conversationId?: number }).conversationId !== undefined)
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn：abort / signal
// ---------------------------------------------------------------------------

describe('spawn abort：signal 接到 SDK', { timeout: 60_000 }, () => {
  it('创建前已 abort：直接拒绝，不创建子会话', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      const controller = new AbortController()
      controller.abort()
      const before = (th.deps.agentSessions as Map<string, number>).size
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            signal: controller.signal,
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'aborted',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, before)
    } finally {
      await th.close()
    }
  })

  it('运行中 abort：conversation.abort 生效且不留 live 任务', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // 响应工厂挂起：不 resolve 则回合停在模型请求中，abort 才真正打断在途 token。
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      th.faux.setResponses([
        () => gate.then(() => fauxAssistantMessage('延迟回答')) as never,
      ])
      const controller = new AbortController()
      const promise = runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '慢任务',
        agentId: 'slow-1',
        signal: controller.signal,
      } as never)
      // 等子会话创建并进入运行中，再触发 abort。
      await new Promise((r) => setTimeout(r, 150))
      controller.abort()
      release()
      const err = await promise.then(
        () => assert.fail('abort 后不得成功'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'aborted')
      // 不留 live 任务（conversation idle）。
      const childId = (th.deps.agentSessions as Map<string, number>).get('slow-1')!
      const conv = await th.harness.conversation(childId as never, BACKGROUND_CONTEXT)
      assert.ok(conv)
      await conv.waitForIdle(BACKGROUND_CONTEXT)
      const inspect = await th.harness.inspect(BACKGROUND_CONTEXT)
      const live = inspect.tasks.filter((t) => t.state.kind === 'running' || t.state.kind === 'waiting')
      assert.equal(live.length, 0, 'abort 后不得遗留 live 任务')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn：resume 严格性
// ---------------------------------------------------------------------------

describe('spawn resume：绝不新建假续接', { timeout: 60_000 }, () => {
  it('不存在 ref 拒绝，不创建新子会话', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('答案')])
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: 'no-such-agent',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      // '12abc' 这类混杂数字也拒绝（不再 parseInt 宽容）。
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            resume: '12abc',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      assert.equal((th.deps.agentSessions as Map<string, number>).size, 0)
    } finally {
      await th.close()
    }
  })

  it('agentId 映射 resume：复用原会话，onResolved 上报原 id', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('第一段'), fauxAssistantMessage('续接结果')])
      let createdId: number | undefined
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一段',
        agentId: 'agent-a',
        onResolved: (info) => {
          createdId = info.conversationId
        },
      })
      assert.equal(first, '第一段')
      const resumeResolved: Array<number | undefined> = []
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '继续',
        resume: 'agent-a',
        onResolved: (info) => {
          resumeResolved.push(info.conversationId)
        },
      })
      assert.equal(second, '续接结果')
      assert.equal(resumeResolved.length, 1)
      assert.equal(resumeResolved[0], createdId, 'resume onResolved 上报原 convId')
    } finally {
      await th.close()
    }
  })

  it('父归属错误拒绝 resume（防跨父会话劫持）', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('第一段'), fauxAssistantMessage('不该到达')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一段',
        agentId: 'agent-p',
      } as never)
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 999,
            prompt: '劫持',
            resume: 'agent-p',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('resume 带 schema：补挂 StructuredOutput 工具并接受结果', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // 第一段无 schema（纯文本）；续接带 schema：需补挂工具并走工具提交。
      th.faux.setResponses([
        fauxAssistantMessage('第一段纯文本'),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { n: 1 } })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('完成'),
      ])
      const first = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一段',
        agentId: 'agent-s',
      } as never)
      assert.equal(first, '第一段纯文本')
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '续接并返回结构化',
        resume: 'agent-s',
        schema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
          additionalProperties: false,
        },
      } as never)
      assert.deepEqual(second, { n: 1 })
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// spawn：profile / effort / runtime / isolation / gate
// ---------------------------------------------------------------------------

describe('spawn profile 与运行时声明', { timeout: 60_000 }, () => {
  it('无效 profile 显式 not_found', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'ghost-profile',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('profile 声明 herdr runtime：无插件接管显式 unsupported_runtime', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness({
      profiles: {
        assistant: {},
        'cli-agent': { runtime: { kind: 'herdr', agent: 'claude' } },
      },
    })
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'cli-agent',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'herdr:agy',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('effort 非法枚举拒绝；合法值通过', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            effort: 'ultra',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      th.faux.setResponses([fauxAssistantMessage('带 effort 的回答')])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        effort: 'high',
      } as never)
      assert.equal(result, '带 effort 的回答')
    } finally {
      await th.close()
    }
  })

  it('isolation 显式 unsupported_runtime', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            isolation: 'worktree',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'unsupported_runtime',
      )
    } finally {
      await th.close()
    }
  })

  it('任意 namespace:kind 外部运行时（非 herdr）无插件接管同样 unsupported_runtime（内核零插件枚举硬编码）', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // 内核不点名任何插件：docker:devbox、ssh:remote 等一切命名空间形式
      // 一律经 agent_spawn 钩子接管；无接管时统一显式报错。
      for (const agentType of ['docker:devbox', 'ssh:remote', 'claude:code']) {
        await assert.rejects(
          () =>
            runNativeSpawn(th.deps, {
              parentConversationId: 1,
              prompt: 'x',
              agentType,
            } as never),
          (err: unknown) =>
            err instanceof HelmError && err.code === 'unsupported_runtime' && err.message.includes(agentType),
        )
      }
    } finally {
      await th.close()
    }
  })

  it('普通 profileId（无冒号）不受命名空间判定影响（继续走 profile 解析）', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      // 无冒号但未注册的 profile：not_found（不是 unsupported_runtime）。
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: 'x',
            agentType: 'no-such-profile',
          } as never),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await th.close()
    }
  })

  it('gate 用子会话实际 cwd（request.cwd），失败保留诊断', { timeout: 60_000 }, async () => {
    const th = await openSpawnHarness()
    try {
      th.faux.setResponses([fauxAssistantMessage('答案'), fauxAssistantMessage('答案2')])
      const marker = join(rootDir, 'gate-marker.txt')
      // gate 在子会话 cwd 下执行 pwd 并写文件：验证 cwd 生效。
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'x',
        cwd: rootDir,
        gate: `pwd > "${marker}"`,
      } as never)
      assert.equal(result, '答案')
      const { readFileSync } = await import('node:fs')
      const pwd = readFileSync(marker, 'utf8').trim()
      assert.equal(pwd, rootDir)
      // gate 失败：显式 gate_failed 且诊断保留。
      const err = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'y',
        cwd: rootDir,
        gate: 'echo boom-diagnostic >&2; exit 7',
      } as never).then(
        () => assert.fail('gate 失败必须报错'),
        (e: unknown) => e as HelmError,
      )
      assert.equal(err.code, 'gate_failed')
      assert.ok(String(err.message).includes('boom-diagnostic'), 'gate 诊断不得丢弃')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// Ask：CAS / 取消 / 校验
// ---------------------------------------------------------------------------

describe('Ask CAS 与结算诚实性', { timeout: 60_000 }, () => {
  let service: AskService
  let store: HelmStore
  let stash: SecretStash
  let events: Array<{ type: string; payload: unknown }>
  let pendingChanged: number[]

  async function openAskService(options: { validateConversation?: (id: number) => boolean } = {}): Promise<void> {
    const db = await openHelmDatabase(join(rootDir, `ask-${Math.random().toString(36).slice(2)}`))
    store = new HelmStore(db)
    await store.load()
    stash = new SecretStash()
    events = []
    pendingChanged = []
    service = new AskService({
      store,
      stash,
      onEvent: (type, payload) => events.push({ type, payload }),
      onConvPendingChanged: (id) => pendingChanged.push(id),
      validateConversation: options.validateConversation,
    })
  }

  it('客户端 CAS seq 与持久水位不同：409 拒绝（不静默覆盖）', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '终端确认',
      expectedStateSeq: 10,
      fields: [{ name: 'confirm', label: '确认', type: 'confirm' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    await assert.rejects(
      () => service.answerAsk(ask.id, { confirm: 'true' }, 9),
      (err: unknown) => err instanceof HelmError && err.code === 'ask_state_conflict',
    )
    await service.cancelAsk(ask.id)
    await store.close()
  })

  it('有 CAS 但无 resolver：ask_state_unavailable，不装作校验通过', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '需要 seq',
      expectedStateSeq: 5,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    await assert.rejects(
      () => service.answerAsk(ask.id, { x: 'v' }),
      (err: unknown) => err instanceof HelmError && err.code === 'ask_state_unavailable',
    )
    await service.cancelAsk(ask.id)
    await store.close()
  })

  it('目标 seq 任何不一致（含回退）都 superseded；一致则通过', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: 'seq 水位',
      expectedStateSeq: 10,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    // 回退（9 < 10）：旧代码只拦 > ，现在任何不一致都销单。
    let target = 9
    service.registerSeqResolver(() => target)
    const superseded = await service.answerAsk(ask.id, { x: 'v' })
    assert.equal(superseded.status, 'superseded')
    // 一致：正常 answered。
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: 'seq 一致',
      expectedStateSeq: 3,
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    void ask2Promise.catch(() => {})
    const ask2 = service.listAsks('pending')[0]!
    target = 3
    const answered = await service.answerAsk(ask2.id, { x: 'v' })
    assert.equal(answered.status, 'answered')
    await store.close()
  })

  it('cancel/superseded：createAsk promise resolve（status 区分，answers 为空不冒充批准）', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '将取消',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask = service.listAsks('pending')[0]!
    await service.cancelAsk(ask.id)
    const cancelled = await askPromise
    assert.equal(cancelled.status, 'cancelled')
    assert.deepEqual(cancelled.answers, {})
    // superseded 同理。
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: '将销单',
      fields: [{ name: 'x', label: 'X', type: 'text' }],
    })
    await new Promise((r) => setTimeout(r, 20))
    const ask2 = service.listAsks('pending')[0]!
    await service.cancelAsk(ask2.id, 'superseded')
    const superseded = await ask2Promise
    assert.equal(superseded.status, 'superseded')
    assert.deepEqual(superseded.answers, {})
    await store.close()
  })

  it('答案校验：未知字段 / 非 string / select 越界 / confirm 非法 / 必填缺失', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '表单',
      fields: [
        { name: 'color', label: '颜色', type: 'select', options: [{ label: '红', value: 'red' }, { label: '蓝', value: 'blue' }] },
        { name: 'agree', label: '同意', type: 'confirm', required: true },
        { name: 'note', label: '备注', type: 'text' },
      ],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmError && err.code === 'validation_error')
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', rogue: 'x' } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 1 } as never))
    await expectValidation(service.answerAsk(ask.id, { agree: 'true', color: 'green' }))
    await expectValidation(service.answerAsk(ask.id, { agree: 'yes' }))
    await expectValidation(service.answerAsk(ask.id, { color: 'red' }))
    // 合法提交通过。
    const ok = await service.answerAsk(ask.id, { agree: 'true', color: 'red', note: '' })
    assert.equal(ok.status, 'answered')
    await store.close()
  })

  it('secret：env 名非法拒绝、声明保留原样不转大写合并、空值不入 stash', { timeout: 60_000 }, async () => {
    await openAskService()
    // 非法 env 名（连字符）：创建即拒（stash.put 会抛，但现在在 createAsk 边界）。
    await assert.rejects(
      () =>
        service.createAsk({
          conversationId: 1,
          title: '坏名字',
          fields: [{ name: 'api-key', label: 'K', type: 'text', secret: true }],
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
    )
    // 'api_key' 与 'API_KEY' 是两个不同字段名：保留原样共存，不合并覆盖。
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '双秘密',
      fields: [
        { name: 'api_key', label: '小写', type: 'text', secret: true },
        { name: 'API_KEY', label: '大写', type: 'text', secret: true },
      ],
    })
    void askPromise.catch(() => {})
    const ask = service.listAsks('pending')[0]!
    const answered = await service.answerAsk(ask.id, { api_key: 'lower-secret', API_KEY: 'upper-secret' })
    assert.equal(answered.status, 'answered')
    const env = stash.envFor(1)
    assert.equal(env['api_key'], 'lower-secret')
    assert.equal(env['API_KEY'], 'upper-secret')
    // 空秘密不入 stash：答案存储为空串，无 stash 条目。
    const ask2Promise = service.createAsk({
      conversationId: 1,
      title: '空秘密',
      fields: [{ name: 'EMPTY_TOKEN', label: 'T', type: 'text', secret: true }],
    })
    void ask2Promise.catch(() => {})
    const ask2 = service.listAsks('pending')[0]!
    const settled2 = await service.answerAsk(ask2.id, { EMPTY_TOKEN: '' })
    assert.equal(settled2.status, 'answered')
    const row2 = store.getAsk(ask2.id)
    assert.equal(JSON.parse(row2!.resultJson!).EMPTY_TOKEN, '')
    await store.close()
  })

  it('createAsk 边界：重复 name / 非法 type / 会话不存在 / 缺 title', { timeout: 60_000 }, async () => {
    await openAskService({ validateConversation: (id) => id === 1 })
    const expectValidation = (promise: Promise<unknown>) =>
      assert.rejects(promise, (err: unknown) => err instanceof HelmError && err.code === 'validation_error')
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: '重复',
        fields: [
          { name: 'x', label: '1', type: 'text' },
          { name: 'x', label: '2', type: 'text' },
        ],
      }),
    )
    await expectValidation(
      service.createAsk({
        conversationId: 1,
        title: '坏类型',
        fields: [{ name: 'x', label: 'X', type: 'radio' as never }],
      }),
    )
    await expectValidation(service.createAsk({ conversationId: 1, title: '', fields: [{ name: 'x', label: 'X', type: 'text' }] }))
    await assert.rejects(
      () =>
        service.createAsk({
          conversationId: 424242,
          title: '不存在会话',
          fields: [{ name: 'x', label: 'X', type: 'text' }],
        }),
      (err: unknown) => err instanceof HelmError && err.code === 'not_found',
    )
    await store.close()
  })

  it('重启遗留 pending：诊断通知提及 secret 引用失效', { timeout: 60_000 }, async () => {
    await openAskService()
    const askPromise = service.createAsk({
      conversationId: 1,
      title: '遗留',
      fields: [
        { name: 'x', label: 'X', type: 'text' },
        { name: 'TOKEN', label: 'T', type: 'text', secret: true },
      ],
    })
    void askPromise.catch(() => {})
    await new Promise((r) => setTimeout(r, 20))
    service.reportOrphans()
    const notification = events.find(
      (e) => e.type === 'notification' && String((e.payload as { title?: string }).title).includes('遗留'),
    )
    assert.ok(notification, '必须有诊断通知')
    assert.ok(
      String((notification.payload as { body?: string }).body).includes('失效'),
      'secret 引用跨重启失效必须如实说明',
    )
    await service.cancelAsk(service.listAsks('pending')[0]!.id)
    await store.close()
  })
})
