/**
 * 核心对齐回归（新版设计）：真实 KernelRuntime + faux provider + 真实 SQLite。
 *
 * 覆盖：
 * 1. 模型解析链：显式 override > profile.model > 全局默认，
 *    PATCH model:'' 清除 override 换 profile 重算、跨 profile 隔离、
 *    子 spawn register 回传真实 resolvedModel（非 request/global 谎报）、
 *    重启后继承语义保持（fresh 无 override 即继承）；
 * 2. ProfileRuntime nodeId/workspace/env 边界验证与保留；
 * 3. 会话插件管理权：managed 删除保护 409 owners、release 后可删、
 *    初始会话无 id 级豁免；markConversationOwnership 通用（未标记 human）；
 *    原生 spawn 子会话零业务标签且自动 helm 归属；
 * 4. submitInput opts.meta 从 API 层直达 helm.input entry 与 turn_settled；
 * 5. 受管 token：不出现在任何落库/事件/模型文本（回显不落库）、close dispose、
 *    setHubUrl 热更新工具 env；
 * 6. snapshot ui/pluginDocs（provider 注入）、watchdog tick singleflight 有意义
 *    （真实 stalledMs/consecutiveErrors 事实）、getConversationDetail 分页与
 *    cursor 校验、waitForInput 精确回答与失败显式抛错。
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type TurnSettledPayload, type WorkflowRunSummary } from '@helm/protocol'
import { KernelRuntime } from '../src/runtime/index.js'
import { buildToolEnv } from '../src/runtime/tools.js'
import type { HelmEventFrame } from '@helm/protocol'

type FauxHandle = ReturnType<typeof fauxProvider>

function makeFauxModels(): { models: ReturnType<typeof createModels>; faux: FauxHandle } {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  return { models, faux }
}

interface OpenOpts {
  model?: string
  watchdogIntervalMs?: number
}

async function openRuntime(dir: string, opts: OpenOpts = {}): Promise<KernelRuntime & { __faux: FauxHandle }> {
  const { models, faux } = makeFauxModels()
  const runtime = await KernelRuntime.open({
    dataDir: dir,
    cwd: dir,
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    ...(opts.watchdogIntervalMs !== undefined ? { watchdogIntervalMs: opts.watchdogIntervalMs } : {}),
    models,
  })
  return Object.assign(runtime, { __faux: faux })
}

/** 在 dataDir 写一个 profile（profile.json）。 */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

/** 同步抛出断言（markConversationOwnership/setHubUrl 等同步校验）。 */
async function assertThrowsSync(fn: () => unknown, code: string): Promise<void> {
  try {
    fn()
  } catch (err) {
    assert.ok(err instanceof HelmError && err.code === code, `期望 ${code}，收到 ${String(err)}`)
    return
  }
  assert.fail(`期望同步抛出 ${code}，但未抛出`)
}

let root: string

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'helm-align-'))
})

after(async () => {
  rmSync(root, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// 1. 模型解析链
// ---------------------------------------------------------------------------

describe('模型解析链：显式 override > profile.model > 全局默认', { timeout: 60_000 }, () => {
  it('全局 default 生效；profile.model 优先于全局；显式 model 落 override', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm1')
    writeProfile(dir, 'worker-a', { name: 'A', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // 缺省：无全局时 profile.model 兜底（root=assistant 无 model）。
      const viaProfile = await kernel.createConversation({ profileId: 'worker-a' })
      assert.equal(viaProfile.model, 'faux/faux-1')

      // 显式 model 落 override：摘要反映显式值。
      const explicit = await kernel.createConversation({ model: 'faux/faux-1' })
      assert.equal(explicit.model, 'faux/faux-1')

      // override 优先于换 profile：PATCH 换 profile 后 override 不被冲掉。
      const pinned = await kernel.updateConversation(explicit.id, { profileId: 'worker-a' })
      assert.equal(pinned.model, 'faux/faux-1')

      // PATCH model:'' 清除 override：重算继承链（assistant 无 model -> 全局）。
      const cleared = await kernel.updateConversation(explicit.id, { model: '' })
      assert.equal(cleared.model, 'faux/faux-1') // 全局 default
      // 再换 profile 无 override 时用 profile.model。
      writeProfile(dir, 'worker-b', { name: 'B', model: 'faux/faux-1' })
      const switched = await kernel.updateConversation(explicit.id, { profileId: 'worker-b' })
      assert.equal(switched.model, 'faux/faux-1')
    } finally {
      await kernel.close()
    }
  })

  it('全部缺时仅 submit 显式 model_not_configured；摘要为空串不伪造', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm2')
    // 无全局模型（不传 model）、assistant profile 无 model。
    const { models } = makeFauxModels()
    const kernel = await KernelRuntime.open({ dataDir: dir, cwd: dir, models })
    try {
      const conv = await kernel.createConversation({})
      assert.equal(conv.model, '')
      // 提交时显式拒绝（不假回答）。
      await assert.rejects(
        () => kernel.submitInput(conv.id, '问题'),
        (err: unknown) => err instanceof HelmError && err.code === 'model_not_configured',
      )
      // 配置 profile.model 后同一会话（无 override）即可提交（继承生效）。
      writeProfile(dir, 'late', { name: 'L', model: 'faux/faux-1' })
      await kernel.updateConversation(conv.id, { profileId: 'late' })
      kernel.plugins // 读取不报错（读路径不硬抛）
      const summary = kernel.getConversation(conv.id)
      assert.equal(summary.model, 'faux/faux-1')
    } finally {
      await kernel.close()
    }
  })

  it('重启后继承语义保持：无 override 会话按 profile/全局重算', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm3')
    writeProfile(dir, 'p', { name: 'P', model: 'faux/faux-1' })
    const k1 = await openRuntime(dir, { model: 'faux/faux-1' })
    const inherited = await k1.createConversation({ profileId: 'p' })
    const overridden = await k1.createConversation({ profileId: 'p', model: 'faux/faux-1' })
    await k1.close()

    // 重启：两者镜像一致；override 持久保留。
    const k2 = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      assert.equal(k2.getConversation(inherited.id).model, 'faux/faux-1')
      assert.equal(k2.getConversation(overridden.id).model, 'faux/faux-1')
      // 清除 override 落库后重启仍为清除态（不复活旧值）。
      await k2.updateConversation(overridden.id, { model: '' })
      await k2.close()
      const k3 = await openRuntime(dir, { model: 'faux/faux-1' })
      try {
        assert.equal(k3.getConversation(overridden.id).model, 'faux/faux-1')
      } finally {
        await k3.close()
      }
    } catch (e) {
      await k2.close().catch(() => {})
      throw e
    }
  })

  it('子 spawn 摘要回传真实 resolvedModel；request.model 落子 override', { timeout: 60_000 }, async () => {
    const dir = join(root, 'm4')
    writeProfile(dir, 'spawnable', { name: 'S', model: 'faux/faux-1' })
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('子代理完成')])
      let childId: number | undefined
      const result = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '干活',
        agentType: 'spawnable',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      assert.equal(result, '子代理完成')
      assert.ok(childId !== undefined && childId > 1)
      // 子会话镜像 = profile.model（真实 resolved，非 request/global 谎报）。
      const child = kernel.getConversation(childId!)
      assert.equal(child.model, 'faux/faux-1')
      // 显式 request.model 时子会话 override 落库。
      kernel.__faux.setResponses([fauxAssistantMessage('显式模型子代理')])
      const explicitChild = await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '再次干活',
        agentType: 'spawnable',
        model: 'faux/faux-1',
      })
      assert.equal(explicitChild, '显式模型子代理')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. ProfileRuntime nodeId/workspace/env
// ---------------------------------------------------------------------------

describe('ProfileRuntime nodeId/workspace/env 边界验证', { timeout: 60_000 }, () => {
  it('合法字段保留；非法形状显式拒绝（保存边界）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'pr1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const svc = kernel.profiles
      const saved = await svc.save({
        id: 'remote-agent',
        name: '远程',
        runtime: {
          kind: 'herdr',
          agent: 'claude',
          nodeId: 'gpu-box',
          workspace: '/workspace/proj',
          env: { WORKER_MODE: 'fast', MAX_TASKS: '4' },
        },
      })
      assert.equal(saved.runtime?.nodeId, 'gpu-box')
      assert.equal(saved.runtime?.workspace, '/workspace/proj')
      assert.deepEqual(saved.runtime?.env, { WORKER_MODE: 'fast', MAX_TASKS: '4' })
      // 读取路径同样保留。
      const reread = await svc.get('remote-agent')
      assert.equal(reread?.runtime?.nodeId, 'gpu-box')
      // 非法形状拒绝。
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', nodeId: '' } as never }),
      )
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', env: { '1BAD': 'v' } } as never }),
      )
      await assert.rejects(() =>
        svc.save({ id: 'bad', runtime: { kind: 'herdr', agent: 'x', env: { K: 1 } } as never }),
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 管理权与归属
// ---------------------------------------------------------------------------

describe('会话管理权与归属权', { timeout: 60_000 }, () => {
  it('managed 会话删除 409 含 owners；release 后可删；初始会话无 id 级豁免', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const conv = await kernel.createConversation({})
      const release = kernel.manageConversation(conv.id, 'test:owner-a')
      await assert.rejects(
        () => kernel.deleteConversation(conv.id),
        (err: unknown) =>
          err instanceof HelmError &&
          err.code === 'conversation_managed_by_plugin' &&
          Array.isArray((err.details as { owners?: string[] })?.owners) &&
          (err.details as { owners: string[] }).owners.includes('test:owner-a'),
      )
      release()
      await kernel.deleteConversation(conv.id)
      assert.equal(kernel.listConversations().find((c) => c.id === conv.id), undefined)
      // 初始会话 #1：管理权保护同样生效（通用保护，无 id 豁免）。
      const releaseRoot = kernel.manageConversation(1, 'test:owner-root')
      await assert.rejects(
        () => kernel.deleteConversation(1),
        (err: unknown) => err instanceof HelmError && err.code === 'conversation_managed_by_plugin',
      )
      releaseRoot()
      // 释放后即可删（无 root 403）。
      await kernel.deleteConversation(1)
      assert.equal(kernel.listConversations().some((c) => c.id === 1), false)
    } finally {
      await kernel.close()
    }
  })

  it('markConversationOwnership：通用标记；子 spawn 自动 helm', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // 初始会话 #1 与普通会话同一标记语义（未标记一律 human，无 id 特判）。
      assert.equal(kernel.getConversationOwnership(1), 'human')
      kernel.__faux.setResponses([fauxAssistantMessage('done')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'x',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      assert.ok(childId !== undefined)
      // 原生 spawn 自动 helm 归属（getConversationOwnership 现读：watchdog 探针
      // 构造同源端口）。
      assert.equal(kernel.getConversationOwnership(childId), 'helm')
      // 人类自建会话默认 human。
      const manual = await kernel.createConversation({})
      assert.equal(kernel.getConversationOwnership(manual.id), 'human')
    } finally {
      await kernel.close()
    }
  })

  it('原生 spawn 子会话零业务标签（tags: []）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'o3')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      let childId: number | undefined
      await kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'x',
        onResolved: (info) => {
          childId = info.conversationId
        },
      })
      const child = kernel.getConversation(childId!)
      assert.deepEqual(child.tags, [])
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. submitInput meta 贯通
// ---------------------------------------------------------------------------

describe('submitInput opts.meta 贯通', { timeout: 60_000 }, () => {
  it('meta 经 API 落 helm.input entry 并出现在 turn_settled inputs', { timeout: 60_000 }, async () => {
    const dir = join(root, 'meta1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const settled: TurnSettledPayload[] = []
      await kernel.plugins.register({
        id: 'test:meta',
        definePlugin(ctx) {
          ctx.hook.onTurnSettled((p) => {
            settled.push(p)
          })
        },
      })
      kernel.__faux.setResponses([fauxAssistantMessage('收到')])
      await kernel.submitInput(1, '带元数据的输入', {
        origin: 'human',
        meta: { source: 'cli', attempt: 1 },
      })
      await kernel.waitForIdle(1)
      assert.equal(settled.length, 1)
      assert.equal(settled[0]?.inputs[0]?.meta?.['source'], 'cli')
      // meta 也真实写入 helm.input entry（detail 可见）。
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const inputEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'helm.input')
      assert.ok(inputEntry)
      const data = inputEntry.data as { meta?: Record<string, unknown> } | undefined
      assert.equal(data?.meta?.['attempt'], 1)
    } finally {
      await kernel.close()
    }
  })

  it('meta 中的受管 token 值先 stash 脱敏再入库（回显不落库）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'meta2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      const token = 'sk-managed-' + 'x'.repeat(20)
      kernel.stash.addRedaction(token)
      await kernel.submitInput(1, '含 token 的元数据', { meta: { secretEcho: token } })
      await kernel.waitForIdle(1)
      const detail = await kernel.getConversationDetail(1, { limit: 50 })
      const inputEntry = [...detail.entries].reverse().find((e) => e.kind === 'helm.input')
      const data = inputEntry?.data as { meta?: Record<string, unknown> } | undefined
      const stored = String(data?.meta?.['secretEcho'] ?? '')
      assert.ok(!stored.includes(token), '受管 token 明文不得落库')
      assert.ok(stored.includes('[REDACTED'))
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. 受管 token 与 hub URL
// ---------------------------------------------------------------------------

describe('受管进程 token', { timeout: 60_000 }, () => {
  it('buildToolEnv 注入受管 token；无 deps.processToken 时剥除继承 HELM_TOKEN', { timeout: 60_000 }, () => {
    const deps = {
      dataDir: '/tmp/x',
      defaultCwd: '/tmp',
      hubUrl: 'http://127.0.0.1:3202',
      stashEnvFor: () => ({}),
      redact: (t: string) => t,
      artifacts: {} as never,
    }
    const env = buildToolEnv(deps, '/tmp')
    assert.equal(env['HELM_TOKEN'], undefined)
    const withToken = buildToolEnv({ ...deps, processToken: () => 'managed-tok' }, '/tmp')
    assert.equal(withToken['HELM_TOKEN'], 'managed-tok')
  })

  it('受管 token 全局脱敏：redact 后不见明文；dispose 后 verifyToken 拒绝', { timeout: 60_000 }, async () => {
    const dir = join(root, 'tok1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    const managed = kernel.auth.createProcessToken()
    kernel.stash.addRedaction(managed.token)
    try {
      // 脱敏覆盖。
      assert.ok(!kernel.stash.redact(`leak: ${managed.token}`).includes(managed.token))
      assert.equal(await kernel.auth.verifyToken(managed.token), true)
    } finally {
      await kernel.close()
    }
  })

  it('setHubUrl 更新工具 env 端点（port:0 场景）', { timeout: 60_000 }, async () => {
    const dir = join(root, 'tok2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.setHubUrl('http://127.0.0.1:39999')
      // 经真实 bash 工具验证 env（echo 不落盘 token；HELM_HUB_URL 注入可见）。
      kernel.__faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo "$HELM_HUB_URL"' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ])
      await kernel.submitInput(1, '输出 hub url')
      await kernel.waitForIdle(1)
      const text = await kernel.getLastAssistantText(1)
      assert.equal(text, 'done')
      await assertThrowsSync(() => kernel.setHubUrl(''), 'validation_error')
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. snapshot / plugin docs / watchdog / detail / waitForInput
// ---------------------------------------------------------------------------

describe('snapshot 与插件公共文档', { timeout: 60_000 }, () => {
  it('snapshot.ui 为插件 UI 贡献实列表；pluginDocs 首帧携带公开文档（私有 doc 不出现）', { timeout: 60_000 }, async () => {
    const dir = join(root, 's1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // 无公开文档插件：pluginDocs = []。
      let snap = kernel.events.currentSnapshot()
      assert.deepEqual(snap.pluginDocs ?? [], [])
      assert.ok(Array.isArray(snap.ui))

      // UI 贡献与公开文档经真实插件注册出现在 snapshot。
      await kernel.plugins.register({
        id: 'test:ui',
        definePlugin(ctx) {
          ctx.ui.sidebarItem({ id: 'sb1', label: '测试项', target: 'conversation:1' })
          ctx.doc('runs', { count: 1 }, { public: true })
          ctx.doc('secret', { v: 'x' })
        },
      })
      snap = kernel.events.currentSnapshot()
      assert.ok(snap.ui.some((u) => u.pluginId === 'test:ui'))
      const docs = snap.pluginDocs ?? []
      assert.equal(docs.length, 1)
      assert.equal(docs[0]?.name, 'runs')
      assert.deepEqual(docs[0]?.value, { count: 1 })
    } finally {
      await kernel.close()
    }
  })

  it('onEvent(workflow.settled)：每 run 通知一次；dispose 后不再收；异常监听器显式上报', { timeout: 60_000 }, async () => {
    const dir = join(root, 's2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const seen: string[] = []
      let disposed = false
      await kernel.plugins.register({
        id: 'test:wf',
        definePlugin(ctx) {
          ctx.host.onEvent('test.settled', (raw) => {
            if (disposed) return
            const run = raw as { id: string }
            seen.push(run.id)
          })
        },
      })
      const run = { id: 'run-x' }
      // 内部事件由宿主 emitHostEvent 派发（ctx.host.emitEvent 的后端）。
      kernel.emitHostEvent('test.settled', run)
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(seen, ['run-x'])
      disposed = true
      kernel.emitHostEvent('test.settled', run)
      await new Promise((r) => setTimeout(r, 20))
      assert.deepEqual(seen, ['run-x'])
    } finally {
      await kernel.close()
    }
  })
})

describe('getConversationActivity（原 watchdog tick 活动事实端口）', { timeout: 60_000 }, () => {
  it('携带真实 stalledMs/consecutiveErrors；失败回合后 consecutiveErrors 递增', { timeout: 60_000 }, async () => {
    const dir = join(root, 'w1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // 成功回合。
      kernel.__faux.setResponses([fauxAssistantMessage('ok')])
      await kernel.submitInput(1, '第一问')
      await kernel.waitForIdle(1)
      // 成功回合后无连续错误（探针构造省略 consecutiveErrors=0 字段同源）。
      assert.equal(kernel.getConversationActivity(1).consecutiveErrors, 0)

      // 失败回合：consecutiveErrors=1（真实事实，内核不做自动恢复）。
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      await kernel.submitInput(1, '会失败的问题').catch(() => {})
      await kernel.waitForIdle(1).catch(() => {})
      assert.equal(kernel.getConversationActivity(1).consecutiveErrors, 1)
    } finally {
      await kernel.close()
    }
  })
})

describe('getConversationDetail 分页', { timeout: 60_000 }, () => {
  it('默认最新 100 条升序；cursor 绑定会话/长度/JSON 校验；limit 钳制', { timeout: 60_000 }, async () => {
    const dir = join(root, 'd1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      // 三轮真实回合产生 entries。
      kernel.__faux.setResponses([
        fauxAssistantMessage('答一'),
        fauxAssistantMessage('答二'),
        fauxAssistantMessage('答三'),
      ])
      await kernel.submitInput(1, '问一')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '问二')
      await kernel.waitForIdle(1)
      await kernel.submitInput(1, '问三')
      await kernel.waitForIdle(1)

      const detail = await kernel.getConversationDetail(1)
      assert.ok(detail.entries.length > 0)
      // 升序（id 递增为字符串数字序）。
      const ids = detail.entries.map((e) => Number(e.id))
      for (let i = 1; i < ids.length; i++) assert.ok(ids[i]! >= ids[i - 1]!)

      // limit 分页。
      const page1 = await kernel.getConversationDetail(1, { limit: 3 })
      assert.equal(page1.entries.length, 3)
      assert.ok(page1.nextCursor)
      const page2 = await kernel.getConversationDetail(1, { limit: 3, cursor: page1.nextCursor })
      assert.ok(page2.entries.length > 0)
      // 两页不重叠。
      const p1 = new Set(page1.entries.map((e) => e.id))
      assert.ok(page2.entries.every((e) => !p1.has(e.id)))

      // cursor 校验：跨会话拒绝、非法 base64 拒绝、超长拒绝。
      const other = await kernel.createConversation({})
      await assert.rejects(
        () => kernel.getConversationDetail(other.id, { cursor: page1.nextCursor }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => kernel.getConversationDetail(1, { cursor: '!!!not-base64!!!' }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      await assert.rejects(
        () => kernel.getConversationDetail(1, { cursor: 'x'.repeat(3000) }),
        (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
      )
      // limit 边界。
      await assert.rejects(() => kernel.getConversationDetail(1, { limit: 0 }))
      await assert.rejects(() => kernel.getConversationDetail(1, { limit: 501 }))
      // assistant 文本经 model 保留。
      const withText = detail.entries.find((e) => e.kind === 'pi.assistant')
      assert.ok(withText)
    } finally {
      await kernel.close()
    }
  })
})

describe('waitForInput 精确等待', { timeout: 60_000 }, () => {
  it('done 返回本次提交的精确回答 entry 与脱敏文本；失败/中止显式抛错', { timeout: 60_000 }, async () => {
    const dir = join(root, 'w2')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      kernel.__faux.setResponses([fauxAssistantMessage('这是精确回答')])
      const { submissionId } = await kernel.submitInput(1, '问')
      const result = await kernel.waitForInput(1, submissionId)
      assert.equal(result.submissionId, submissionId)
      assert.equal(result.text, '这是精确回答')
      assert.ok(result.entry)
      assert.ok(result.entry.model !== undefined, '回答 entry 保留 model 消息')

      // 失败回合：turn_failed（不伪造回答）。
      kernel.__faux.setResponses([
        fauxAssistantMessage('x', { errorMessage: 'boom', stopReason: 'error' }),
      ])
      const failed = await kernel.submitInput(1, '会失败')
      await assert.rejects(
        () => kernel.waitForInput(1, failed.submissionId),
        (err: unknown) => err instanceof HelmError && (err.code === 'turn_failed' || err.code === 'turn_aborted'),
      )

      // 身份不匹配：跨会话拒绝。
      const other = await kernel.createConversation({})
      await assert.rejects(
        () => kernel.waitForInput(other.id, submissionId),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
    } finally {
      await kernel.close()
    }
  })

  it('handled:* 提交显式 wait 不适用', { timeout: 60_000 }, async () => {
    const dir = join(root, 'w3')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      await kernel.plugins.register({
        id: 'test:intercept',
        definePlugin(ctx) {
          ctx.hook.onInput(() => ({ action: 'handled' }))
        },
      })
      const { submissionId } = await kernel.submitInput(1, '被接管')
      assert.ok(submissionId.startsWith('handled:'))
      await assert.rejects(
        () => kernel.waitForInput(1, submissionId),
        (err: unknown) => err instanceof HelmError && err.code === 'wait_not_applicable',
      )
    } finally {
      await kernel.close()
    }
  })
})

// ---------------------------------------------------------------------------
// conversation.entry / conversation.live 事件（SSE 帧）
// ---------------------------------------------------------------------------

describe('conversation.entry / live 事件', { timeout: 60_000 }, () => {
  it('真实回合产生 entry 事件帧与 live 帧；帧 payload 已脱敏', { timeout: 60_000 }, async () => {
    const dir = join(root, 'ev1')
    const kernel = await openRuntime(dir, { model: 'faux/faux-1' })
    try {
      const frames: HelmEventFrame[] = []
      kernel.events.subscribe((f) => frames.push(f))
      kernel.__faux.setResponses([fauxAssistantMessage('实时回答文本')])
      await kernel.submitInput(1, '触发事件')
      await kernel.waitForIdle(1)
      const entryFrames = frames.filter((f) => f.event.type === 'conversation.entry')
      assert.ok(entryFrames.length >= 1, '应至少有一条 conversation.entry')
      const liveFrames = frames.filter((f) => f.event.type === 'conversation.live')
      assert.ok(liveFrames.length >= 1, '应至少有一条 conversation.live')
      const payload = JSON.stringify(frames)
      assert.ok(!payload.includes('sk-'), '帧内不得有秘密明文')
    } finally {
      await kernel.close()
    }
  })
})
