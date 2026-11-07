/**
 * 原生 spawn resume 配置基线回归（真实 KernelRuntime + 真实 SDK 持久化 + faux 请求）。
 *
 * 主代理定位的真实缺陷：resume 时 childCwd 每次从 request/profile/Hub 重算、
 * onResolved 提前回报、model/effort 计算后从不真实 configure、未给 agentType
 * 时回默认 assistant 而非原子会话 Profile。
 *
 * 覆盖：
 * - T1 首调自定义 cwd 再 resume 无 cwd：onResolved/Gate/SDK 实际 cwd 三者一致
 *   （SDK cwd 经子会话内真实 bash pwd 工具调用取证；Gate 经真实 shell）；
 * - T2 resume 显式 cwd/model/effort：真实进入 SDK（faux 工厂逐请求记录
 *   modelId 与 reasoning）、镜像/override 更新、身份字段（title/tags/createdAt/
 *   parent）保留、重启后镜像与 SDK cwd 一致；
 * - T3 原子会话 Profile 继承：resume 缺省不偷偷换 assistant（镜像 profileId
 *   与生效模型保持），cwd 仍为原子会话 cwd；
 * - T4 跨 parent resume 拒绝且子会话配置零变更（无 SDK configure、无 faux 调用）。
 *
 * 诚实性纪律：全部走真实 KernelRuntime.spawnAgent（真实 pi-durable SDK + SQLite
 * 持久化），模型输出来自 faux 脚本（工厂记录真实请求参数），SDK cwd 用子会话内
 * bash 工具真实执行取证；绝不 mock 完成。
 */

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { HelmError } from '@helm/protocol'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KernelRuntime } from '../src/runtime/index.js'

/** 每次真实模型请求的取证记录（faux 工厂第 2/4 参数）。 */
interface RequestRecord {
  modelId: string
  reasoning?: string
}

interface TestEnv {
  kernel: KernelRuntime
  faux: ReturnType<typeof fauxProvider>
  requests: RequestRecord[]
  dataDir: string
  close(): Promise<void>
}

/**
 * 真实 KernelRuntime + 双模型 faux 目录（faux-1/faux-2）。响应队列项可以是
 * 消息或工厂：工厂签名 (context, options, state, model)，记录 model.id 与
 * options.reasoning（SDK thinkingLevel 的真实映射产物）。
 */
async function openEnv(dataDir: string): Promise<TestEnv> {
  const models = createModels()
  const faux = fauxProvider({
    models: [
      { id: 'faux-1', name: 'faux-1' },
      { id: 'faux-2', name: 'faux-2' },
    ],
  })
  models.setProvider(faux.provider)
  const requests: RequestRecord[] = []
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models: models as never,
    watchdogIntervalMs: 0,
  })
  return {
    kernel,
    faux,
    requests,
    dataDir,
    async close() {
      await kernel.close()
    },
  }
}

/** 包装 faux 响应：工厂记录本次真实请求的 modelId/reasoning 后返回预置消息。 */
function record(env: TestEnv, message: AssistantMessage) {
  return (_ctx: unknown, options: { reasoning?: string } | undefined, _state: unknown, model: { id: string }) => {
    env.requests.push({ modelId: model.id, reasoning: options?.reasoning })
    return message
  }
}

/** 子会话内真实 bash pwd 取证（SDK 实际 cwd 的事实来源，非镜像）。 */
function pwdToolCall() {
  return fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd' })], { stopReason: 'toolUse' })
}

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-native-resume-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 写入真实 Profile 文件（ProfileService 读取 profiles/<id>/profile.json）。 */
function writeProfile(dataDir: string, id: string, fields: Record<string, unknown>): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'profile.json'), JSON.stringify({ id, ...fields }, null, 2))
}

// ---------------------------------------------------------------------------
// T1：首调自定义 cwd + resume 无 cwd —— onResolved/Gate/SDK cwd 三者一致
// ---------------------------------------------------------------------------

describe('resume 配置基线：原子会话 cwd', { timeout: 60_000 }, () => {
  it('T1 首调自定义 cwd 再 resume 无 cwd：onResolved/Gate/SDK 实际 cwd 一致（不回 Hub 目录）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const childDir = join(dir, 'child-work')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      // 首调：显式非 Hub cwd；子会话回答纯文本。
      env.faux.setResponses([record(env, fauxAssistantMessage('第一段完成'))])
      let childId = 0
      const first = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '第一段',
        cwd: childDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(first, '第一段完成')
      assert.ok(childId > 0, '应派生子会话')
      assert.equal(env.kernel.getConversation(childId).cwd, childDir, '首调镜像 cwd')

      // resume：不带 cwd —— onResolved 与 Gate 必须仍在原子会话 cwd。
      const resolved: string[] = []
      env.faux.setResponses([record(env, pwdToolCall()), record(env, fauxAssistantMessage('续接完成'))])
      const second = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '续接（bash pwd 取证）',
        resume: String(childId),
        gate: `[ "$(pwd)" = "${childDir}" ]`,
        onResolved: (info) => {
          resolved.push(info.effectiveCwd ?? '')
        },
      })
      assert.equal(second, '续接完成')
      // onResolved 回报原子会话实际 cwd（缺陷下会回 Hub 数据目录）。
      assert.equal(resolved[0], childDir, `onResolved effectiveCwd 应为 ${childDir}，实得 ${resolved[0]}`)
      // Gate 在原子会话 cwd 真实执行通过（缺陷下 pwd != childDir，gate_failed 会抛出，测试在此失败）。
      // SDK 实际 cwd：子会话内 bash pwd 输出（bash 工具用 agent.cwd）。
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, '子会话应有 bash 工具结果（pwd 取证）')
      const bashText = JSON.stringify(bashEntry.model ?? '')
      assert.ok(
        bashText.includes(childDir.replace(/\/$/, '')),
        `bash pwd 应输出原子会话 cwd：${bashText.slice(0, 300)}`,
      )
      // 镜像 cwd 不变。
      assert.equal(env.kernel.getConversation(childId).cwd, childDir)
    } finally {
      await env.close()
    }
  })

  it('T3 原子会话 Profile 继承：resume 缺省不偷偷换 assistant，模型/cwd 保持', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const researchDir = join(dir, 'research-work')
    mkdirSync(researchDir, { recursive: true })
    writeProfile(dir, 'research', { name: '研究', model: 'faux/faux-2' })
    const env = await openEnv(dir)
    try {
      // 首调：research Profile（模型 faux-2），显式 cwd。
      env.faux.setResponses([record(env, fauxAssistantMessage('research 首调'))])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'research 首调',
        agentType: 'research',
        cwd: researchDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      const firstSummary = env.kernel.getConversation(childId)
      assert.equal(firstSummary.profileId, 'research')
      assert.equal(firstSummary.model, 'faux/faux-2', 'Profile 模型继承')
      assert.equal(env.requests[0]!.modelId, 'faux-2', '首调真实请求用 faux-2')

      // resume：不给 agentType —— 原子会话 Profile 保持 research，模型保持
      // faux-2（缺陷下按默认 assistant 解析），cwd 不回 Hub 目录。
      const resolved: string[] = []
      env.faux.setResponses([record(env, fauxAssistantMessage('research 续接'))])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'research 续接',
        resume: String(childId),
        onResolved: (info) => {
          resolved.push(info.effectiveCwd ?? '')
        },
      })
      const after = env.kernel.getConversation(childId)
      assert.equal(after.profileId, 'research', 'resume 缺省不得偷偷换 assistant')
      assert.equal(after.model, 'faux/faux-2', 'resume 缺省保持原子会话生效模型')
      assert.equal(env.requests[1]!.modelId, 'faux-2', '续接真实请求仍用 faux-2')
      assert.equal(resolved[0], researchDir, 'onResolved 用原子会话 cwd')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T2：resume 显式 cwd/model/effort 真实进入 SDK + 镜像 + 重启一致
// ---------------------------------------------------------------------------

describe('resume 显式配置变更', { timeout: 60_000 }, () => {
  it('T2 resume 显式 cwd/model/effort：真实 configure（faux 请求取证）+ 镜像 + 身份保留 + 重启一致', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const firstDir = join(dir, 'first')
    const movedDir = join(dir, 'moved')
    mkdirSync(firstDir, { recursive: true })
    mkdirSync(movedDir, { recursive: true })
    writeProfile(dir, 'research', { name: '研究', model: 'faux/faux-2' })
    const env = await openEnv(dir)
    let childId = 0
    let identityBefore: { title: string; tags: string[]; createdAt: number; parentConversationId?: number } | undefined
    try {
      // 首调：默认 assistant（faux-1），显式 firstDir。工厂记录首调请求。
      env.faux.setResponses([record(env, fauxAssistantMessage('首调'))])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '首调',
        cwd: firstDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      assert.equal(env.requests[0]!.modelId, 'faux-1')
      identityBefore = (({ title, tags, createdAt, parentConversationId }) => ({ title, tags, createdAt, parentConversationId }))(
        env.kernel.getConversation(childId),
      )

      // resume：显式 cwd/model/effort —— 三者必须真实生效。
      env.faux.setResponses([
        record(env, pwdToolCall()),
        record(env, fauxAssistantMessage('续接完成')),
      ])
      const second = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '续接（显式配置）',
        resume: String(childId),
        cwd: movedDir,
        model: 'faux/faux-2',
        effort: 'high',
      })
      assert.equal(second, '续接完成')
      // SDK 真实请求：模型已切 faux-2，thinkingLevel high 已映射 reasoning。
      assert.equal(env.requests[1]!.modelId, 'faux-2', 'resume 显式 model 必须真实进入 SDK 请求')
      assert.equal(env.requests[1]!.reasoning, 'high', 'resume 显式 effort 必须真实进入 SDK 请求')
      assert.equal(env.requests[2]!.modelId, 'faux-2')
      // SDK 实际 cwd 已切 movedDir（bash pwd 取证）。
      const detail = await env.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, '应有 bash pwd 取证')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        `bash pwd 应输出新 cwd：${JSON.stringify(bashEntry.model ?? '').slice(0, 300)}`,
      )
      // 镜像：cwd/model 更新，身份字段保留。
      const after = env.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir)
      assert.equal(after.model, 'faux/faux-2')
      assert.equal(after.title, identityBefore!.title, 'title 保留')
      assert.deepEqual(after.tags, identityBefore!.tags, 'tags 保留')
      assert.equal(after.createdAt, identityBefore!.createdAt, 'createdAt 保留')
      assert.equal(after.parentConversationId, 1, 'parent 保留')
    } finally {
      await env.close()
    }

    // 重启一致性：同 dataDir 重开，镜像与 SDK cwd 均保持（SDK configure 已持久化）。
    const env2 = await openEnv(dir)
    try {
      const after = env2.kernel.getConversation(childId)
      assert.equal(after.cwd, movedDir, '重启后镜像 cwd 一致')
      assert.equal(after.model, 'faux/faux-2', '重启后镜像 model 一致')
      assert.equal(after.profileId, 'assistant')
      // SDK 持久化取证：重启后再续接一轮，bash pwd 仍输出 movedDir。
      env2.faux.setResponses([record(env2, pwdToolCall()), record(env2, fauxAssistantMessage('重启后续接'))])
      await env2.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '重启后续接',
        resume: String(childId),
      })
      const detail = await env2.kernel.getConversationDetail(childId, { limit: 50 })
      const bashEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('bash'))
      assert.ok(bashEntry, '重启后应有 bash pwd 取证')
      assert.ok(
        JSON.stringify(bashEntry.model ?? '').includes(movedDir),
        '重启后 SDK cwd 保持（configure 持久化）',
      )
    } finally {
      await env2.close()
    }
  })
})

// ---------------------------------------------------------------------------
// T4：跨 parent resume 拒绝且配置零变更
// ---------------------------------------------------------------------------

describe('跨 parent 保护', { timeout: 60_000 }, () => {
  it('T4 跨 parent resume 拒绝：not_found 且子会话配置零变更、无 SDK 请求', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4')
    const childDir = join(dir, 'child')
    mkdirSync(childDir, { recursive: true })
    const env = await openEnv(dir)
    try {
      env.faux.setResponses([fauxAssistantMessage('首调')])
      let childId = 0
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '首调',
        cwd: childDir,
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      })
      const before = env.kernel.getConversation(childId)
      const callsBefore = env.faux.state.callCount

      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 999,
            prompt: '劫持',
            resume: String(childId),
            cwd: '/tmp/hijack',
            model: 'faux/faux-2',
          }),
        (err: unknown) => err instanceof HelmError && err.code === 'not_found',
      )
      const after = env.kernel.getConversation(childId)
      assert.equal(after.cwd, childDir, '拒绝路径不得改写 cwd')
      assert.equal(after.model, before.model, '拒绝路径不得改写 model')
      assert.equal(after.profileId, before.profileId)
      assert.equal(after.stateChangeSeq, before.stateChangeSeq, '拒绝路径不得推进 stateChangeSeq')
      assert.equal(env.faux.state.callCount, callsBefore, '拒绝路径不得发起任何 SDK 模型请求')
    } finally {
      await env.close()
    }
  })
})
