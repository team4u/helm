/**
 * builtin:herdr 插件回归：真实 PluginHost + 受控 HerdrTransport。
 *
 * 覆盖（协议集成测试——不声称真实模型/SSH 验证）：
 * - 文件交接 A（成功）/B（缺文件自愈一次）/C（两次失败 herdr_output_contract_violation
 *   + 40 行脱敏快照 + pane 保留）；非缺失 IO 错误不自愈；
 * - 双入口（herdr:<kind>[@nodeId] 前缀与 Profile.runtime）寻址与参数校验、
 *   显式 model/effort 拒绝；
 * - blocked 审批桥：socket 事件与 wait 双路径只建一次 Ask、只发一次键、
 *   Web 回答 CAS 复核、终端先处理 superseded、取消不批准、
 *   send_keys 已发但同 seq blocked 重复事件不重发、延迟创建期间 working 新 seq；
 * - Gate 恰好一次 / env 注入 / 远端剥除 loopback；
 * - 双轨清理（workflow settled / 父 turn settled）与失败保留；
 * - Worktree 注 env（两步建窗 + 关初始 tab + workspace.close）；
 * - resume（同父复用 / 跨父拒绝 / 未知拒绝 / 并发拒绝）；
 * - gateTimeoutMs：仅对 Herdr 处理路径（新建 / 已登记 resume）显式拒绝，
 *   原生 passthrough 不受影响；
 * - 超时安全边界（TimeoutError）：保留 pane 与诊断、绝不代发按键；底层
 *   working/blocked/启动期未定时 resume 显式拒绝，idle 后复用同一 pane 续接；
 * - abort 立即取消 Ask 并关闭自有 PTY；
 * - 启停：默认停用注册、启用连接、liveTasks 409 保护、结算后可 disable、
 *   对账失败自行清理订阅；
 * - 启动对账：孤儿回收、failed 保留、同 ID 换 human agent 不误关；
 * - human 红线：非自有 pane 的 blocked 事件不建 Ask；
 * - report_metadata 防自激（同 token 不重复投射）；
 * - actions list/read/focus 契约；agent_not_ready 桥接。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HelmError, type AgentExecutionInfo } from '@helm/protocol'
import { PluginHost } from '../../kernel/src/plugins/index.js'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { createHerdrPlugin } from '../src/herdr.js'
import { extractWorkflowExecutionMeta } from '../src/contracts.js'
import { EMPTY_MANAGED_DOC } from '../src/herdr/panes.js'
import type { HerdrEvent, HerdrTarget, HerdrTransport } from '../src/herdr/contracts.js'
import type { DiagnosticsCollection } from '../src/diagnostics.js'
import {
  HERDR_FAST_TEST_TIMINGS,
  HerdrFakeBackend as FakeBackend,
  StandardFakeHerdrTransport as FakeTransport,
  herdrFileNameOf as fileNameOf,
  herdrTurnSettledOf as turnSettledOf,
  ipcLineCall,
  openHerdrUnitEnv as makeEnv,
  scriptHerdrSuccess as scriptSuccess,
  serveTransport,
  spawnHerdrDirect as spawnDirect,
} from './helpers/herdr-unit-fixture.js'
import {
  MemoryConfigStore,
  MemoryDocStore,
  waitFor as baseWaitFor,
} from './helpers/plugin-test-env.js'

const waitFor = (predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000, intervalMs = 15): Promise<void> =>
  baseWaitFor(predicate, { timeoutMs, intervalMs, message: 'waitFor 超时：条件在限定时间内未成立' })

// ---------------------------------------------------------------------------
// 文件交接 A/B/C
// ---------------------------------------------------------------------------

test('gateTimeoutMs: Herdr spawn/已登记 resume 显式拒绝；原生 passthrough 不受影响', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 原生 passthrough：非 Herdr 运行时的请求携带 gateTimeoutMs 原样放行内核。
    const native = (await spawnDirect(env, { gate: 'true', gateTimeoutMs: 1_000 })) as {
      __transformed?: { gateTimeoutMs?: number }
    }
    assert.ok(native.__transformed !== undefined, '原生请求不被 Herdr 接管')
    assert.equal(native.__transformed.gateTimeoutMs, 1_000, 'gateTimeoutMs 原样透传内核')

    // Herdr 运行时新建：进入建窗前显式拒绝。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', gate: 'true', gateTimeoutMs: 1_000 }),
      (error: unknown) => error instanceof HelmError && error.code === 'unsupported_runtime',
    )
    assert.equal(env.transport.calls.some((call) => call.method === 'agent.start'), false)

    // 已登记 resume：识别为受管 pane 后同样显式拒绝，不发续接 prompt。
    scriptSuccess(env, 'first')
    await spawnDirect(env, { agentType: 'herdr:agy', agentId: 'wf_gt:node-a' })
    const promptsBefore = env.transport.calls.filter((c) => c.method === 'agent.prompt').length
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_gt:node-a', gate: 'true', gateTimeoutMs: 1_000 }),
      (error: unknown) => error instanceof HelmError && error.code === 'unsupported_runtime',
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt').length, promptsBefore, '拒绝时不发续接 prompt')
  } finally {
    await env.close()
  }
})

test('文件交接A: 成功路径——两步建窗、交接读取、文件清理、gate 一次、保活登记', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, JSON.stringify({ answer: 42 }))
    let resolved: Record<string, unknown> | undefined
    const result = await spawnDirect(env, {
      agentType: 'herdr:agy',
      cwd: '/tmp/helm-cwd-a',
      schema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'], additionalProperties: false },
      onResolved: (info: Record<string, unknown>) => { resolved = info },
    })
    assert.deepEqual(result, { answer: 42 })
    const outputPrompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!
    const outputFileName = fileNameOf(outputPrompt.params['text'] as string)
    assert.ok(outputFileName !== '', 'prompt 必须包含交接文件名')
    assert.equal(existsSync(`${[...env.transport.panes.values()][0]!.cwd}/.helm/${outputFileName}`), false, '交接文件读取后清理')
    // 两步建窗：tab.create 先于 agent.start。
    const tabAt = env.transport.calls.findIndex((c) => c.method === 'tab.create')
    const startAt = env.transport.calls.findIndex((c) => c.method === 'agent.start')
    assert.ok(tabAt >= 0 && startAt > tabAt)
    const tabCreate = env.transport.calls[tabAt]!
    assert.equal(tabCreate.params['cwd'], '/tmp/helm-cwd-a')
    assert.equal(tabCreate.params['focus'], false)
    assert.ok((tabCreate.params['label'] as string).startsWith('helm-wf-'), 'label 为 helm-wf- 前缀')
    assert.ok(((tabCreate.params['label'] as string).length <= 32), 'agent 名称 <= 32')
    const start = env.transport.calls[startAt]!
    assert.equal(start.params['kind'], 'agy')
    assert.equal(start.params['timeout_ms'], 30_000)
    // prompt --wait 契约。
    const prompt = env.transport.calls.find((c) => c.method === 'agent.prompt')!
    assert.deepEqual((prompt.params['wait'] as { until: string[] }).until, ['done', 'idle', 'blocked'])
    assert.ok((prompt.params['text'] as string).includes('.helm/wf-out-'), '提示词强制落盘')
    // onResolved 回传 executionId/effectiveCwd。
    assert.ok(resolved && typeof resolved['executionId'] === 'string' && resolved['executionId'] !== '')
    assert.equal(resolved!['effectiveCwd'], '/tmp/helm-cwd-a')
    // 保活登记。
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'keepalive')
  } finally {
    await env.close()
  }
})

test('文件交接B: 首次缺文件自愈一次后成功', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    let promptCount = 0
    env.transport.onPrompt = (pane, text) => {
      promptCount += 1
      if (promptCount >= 2) {
        // 自愈 prompt 时写入文件。
        env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, '# 结果\n完成。')
      }
    }
    const result = await spawnDirect(env, { agentType: 'herdr:agy' })
    assert.equal(result, '# 结果\n完成。')
    assert.equal(promptCount, 2, '自愈恰好一次')
    assert.ok(env.backend.notifications.some((n) => n.title === 'Herdr handoff self-heal'))
  } finally {
    await env.close()
  }
})

test('文件交接C: 两次失败 herdr_output_contract_violation + 脱敏快照 + pane 保留', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    // 全程不写文件。
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'herdr:agy',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_contract_violation')
        assert.ok(error.message.includes('[REDACTED]'), '快照脱敏')
        return true
      },
    )
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string; paneId: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed')
    const pane = env.transport.panes.get(list.panes[0]!.paneId)!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, false, '失败 pane 保留现场')
  } finally {
    await env.close()
  }
})

test('坏 JSON / Schema 不合格同样走自愈；两次后同样显式违约', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = ['done', 'done']
    env.transport.onPrompt = (pane, text) => {
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, '{"broken": ')
    }
    await assert.rejects(
      spawnDirect(env, {
        agentType: 'herdr:agy',
        schema: { type: 'object', properties: { a: { type: 'number' } }, required: ['a'], additionalProperties: false },
      }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_contract_violation')
        return true
      },
    )
  } finally {
    await env.close()
  }
})

test('交接路径非普通文件时不自愈，如实抛诊断', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'done'
    env.transport.onPrompt = (pane, text) => {
      // 零参生产 transport 真实读取文件；目录作为输出路径稳定模拟非缺失 I/O 违约。
      mkdirSync(join(pane.cwd, '.helm', fileNameOf(text)), { recursive: true })
    }
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy' }),
      (error: unknown) => {
        assert.ok(error instanceof HelmError)
        assert.equal(error.code, 'herdr_output_not_file')
        return true
      },
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt').length, 1, '不重投任务')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 双入口与参数校验
// ---------------------------------------------------------------------------

test('Profile.runtime 入口: 继承 args/workspace/env；非 herdr Profile 放行', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('coder', {
      id: 'coder',
      runtime: { kind: 'herdr', agent: 'claude', args: ['--flag-a'], workspace: '/tmp/helm-profile-ws', env: { TOOL: 'x' } },
    })
    env.profiles.set('writer', { id: 'writer' })
    scriptSuccess(env, 'profile-ok')
    await spawnDirect(env, { agentType: 'coder' })
    const start = env.transport.calls.find((c) => c.method === 'agent.start')!
    assert.deepEqual(start.params['args'], ['--flag-a'])
    const tabCreate = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(tabCreate.params['cwd'], '/tmp/helm-profile-ws')
    const envSent = tabCreate.params['env'] as Record<string, string>
    assert.equal(envSent['TOOL'], 'x')
    assert.equal(envSent['HELM_TOKEN'], 'SECRET-TOKEN')
    // cwd 解析链：request.cwd 优先。
    const before = env.transport.calls.length
    const outcome = await env.host.runHook('agent_spawn', { parentConversationId: 1, prompt: 'x', agentType: 'writer' } as never)
    assert.notEqual(outcome.action, 'handled')
    assert.equal(env.transport.calls.length, before, '非 herdr Profile 零调用')
  } finally {
    await env.close()
  }
})

test('cwd 解析链: request.cwd > profile.workspace > 父会话 cwd > defaultCwd', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    let tabCreate = env.transport.calls.find((c) => c.method === 'tab.create')!
    assert.equal(tabCreate.params['cwd'], env.backend.conversations.get(1)!.cwd, '缺省用父会话 cwd')
  } finally {
    await env.close()
  }
})

test('非法输入拒绝: 相对 cwd / 非法 kind / nodeId 注入 / 显式 model / effort', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', cwd: 'relative/path' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:BAD KIND' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy:remote' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy@remote --evil' }), (e: unknown) => (e as HelmError).code === 'validation_error')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', model: 'faux/big' }), (e: unknown) => (e as HelmError).code === 'unsupported_runtime')
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:agy', effort: 'high' }), (e: unknown) => (e as HelmError).code === 'unsupported_runtime')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// blocked 审批桥
// ---------------------------------------------------------------------------

test('审批桥: 双路径单飞——只建一次 Ask、只发一次键、CAS 复核', { timeout: 60_000 }, async () => {
  // 退避不用全局快参：本用例验证「同 seq 不重发不重建」窗口，重开需 2 次退避（300+300ms）后才触发。
  const env = await makeEnv({ timingOverrides: { blockedBackoffBaseMs: 150, blockedBackoffCapMs: 300 } })
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    assert.match(askId, /^herdr:local:.+:\d+$/, '预分配 id 形如 herdr:local:<pane>:<seq>')
    // 权威复核：createAsk 前 agent.get。
    assert.ok(env.transport.calls.some((c) => c.method === 'agent.get'))
    // socket 重复事件（同 seq）不重建。
    const pane = [...env.transport.panes.values()][0]!
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(40)
    assert.equal(env.backend.createdAsks.length, 1, '重复事件不重建 Ask')
    // 人类回答 allow-y -> 复核 seq -> 一次 send_keys。
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['y'])
    // send_keys 已发但 agent.get 短暂仍 blocked 同 seq + socket 重复：不重发不重建。
    env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(40)
    assert.equal(env.transport.sendKeysLog.length, 1, '同 seq 不重发键')
    assert.equal(env.backend.createdAsks.length, 1)
    // 终端真实进展（延迟推进）-> done -> 文件交接成功。
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'approved')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'approved')
  } finally {
    await env.close()
  }
})

test('审批桥: 终端先处理（seq 推进）pending Ask superseded 且不发送键', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const pane = [...env.transport.panes.values()][0]!
    // 延迟 Ask 创建期间收到 working 新 seq（事件路径先于 createAsk 落库）。
    env.transport.advancePane(pane.paneId, 'working')
    await waitFor(() => env.backend.cancelledAsks.length === 1)
    assert.equal(env.backend.cancelledAsks[0]!.reason, 'superseded')
    // 主循环继续等待真实进展 -> done -> 交接。
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'terminal-first')
    env.transport.advancePane(pane.paneId, 'done')
    assert.equal(await resultPromise, 'terminal-first')
    assert.equal(env.transport.sendKeysLog.length, 0, '终端先处理时不发送键')
  } finally {
    await env.close()
  }
})

test('审批桥: 人类取消时不批准、关闭自有 pane 并中止', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    env.backend.answerAsk(askId, { id: askId, status: 'cancelled', answers: {} })
    await assert.rejects(resultPromise, (e: unknown) => (e as HelmError).code === 'aborted')
    const pane = [...env.transport.panes.values()][0]!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, true, '取消后关闭自有 pane')
    assert.equal(env.transport.sendKeysLog.length, 0, '取消绝不批准')
  } finally {
    await env.close()
  }
})

test('审批桥: 回答后终端 seq 已推进时不发键，直接续等', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const askId = env.backend.createdAsks[0]!['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    // 人类回答的同时终端已处理（seq 推进为 done）。
    env.transport.advancePane(pane.paneId, 'done')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'race-resolved')
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    assert.equal(await resultPromise, 'race-resolved')
    assert.equal(env.transport.sendKeysLog.length, 0, 'seq 已推进时不发键（CAS 复核）')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// gate 与远端
// ---------------------------------------------------------------------------

test('Gate 恰好一次 + env 注入（本机 runLocalGate 携带 spawn env）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'gate-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', gate: 'exit 0' })
    assert.equal(env.gateLog.length, 1, 'gate 恰好一次')
    assert.equal(env.gateLog[0]!.command, 'exit 0')
    assert.equal(env.gateLog[0]!.cwd, env.backend.conversations.get(1)!.cwd, 'gate 在实际 cwd 执行')
    assert.equal(env.gateLog[0]!.env?.['HELM_ENV'], '1')
    assert.equal(env.gateLog[0]!.env?.['HELM_CWD'], env.backend.conversations.get(1)!.cwd)
  } finally {
    await env.close()
  }
})

test('远端节点: 全部调用走 nodeId target、剥除 loopback HUB_URL/TOKEN、远端 gate', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'remote-ok')
    await spawnDirect(env, { agentType: 'herdr:agy@remote-node', gate: 'exit 0' })
    for (const call of env.transport.calls) {
      // 订阅与对账契约只承诺本机 socket。
      if (call.method === 'events.subscribe' || call.method === 'session.snapshot') continue
      assert.deepEqual(call.target, { nodeId: 'remote-node' }, `调用 ${call.method} 走 nodeId target`)
    }
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal('HELM_HUB_URL' in envSent, false)
    assert.equal('HELM_TOKEN' in envSent, false)
    // 远端 gate 不走本机 runLocalGate：生产 transport.runGate 经 nodeChannel
    // .envFor（= backend.executionEnv 真实 NodeExecutionEnv）在实际 cwd 执行
    // exit 0 成功；FakeTransport.runGate 不再是承载点。
    assert.equal(env.gateLog.length, 0)
    assert.equal(env.transport.calls.filter((c) => c.method === 'runGate').length, 0)
    // buildSpawnEnv 收到目标 nodeId（窗格 env 按节点构造）。
    assert.ok(env.spawnEnvLog.some((e) => e.nodeId === 'remote-node'), '远端窗格 env 按目标 nodeId 构造')
  } finally {
    await env.close()
  }
})

test('远端 Profile 显式配置可达 HELM_HUB_URL 时保留回连变量', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.profiles.set('far', {
      id: 'far',
      runtime: { kind: 'herdr', agent: 'agy', nodeId: 'remote-node', env: { HELM_HUB_URL: 'http://10.0.0.5:3202' } },
    })
    scriptSuccess(env, 'far-ok')
    await spawnDirect(env, { agentType: 'far' })
    const envSent = env.transport.calls.find((c) => c.method === 'tab.create')!.params['env'] as Record<string, string>
    assert.equal(envSent['HELM_HUB_URL'], 'http://10.0.0.5:3202', '显式远端可达 URL 保留')
    assert.equal(envSent['HELM_TOKEN'], 'SECRET-TOKEN', 'token 随可达 URL 保留')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// worktree 与双轨清理
// ---------------------------------------------------------------------------

test('Worktree 隔离: 两步建窗注入 env、关初始 tab、workspace.close 清理', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'wt-ok')
    let resolved: Record<string, unknown> | undefined
    await spawnDirect(env, {
      agentType: 'herdr:agy',
      isolation: 'worktree',
      onResolved: (info: Record<string, unknown>) => { resolved = info },
    })
    const worktreeCreate = env.transport.calls.find((c) => c.method === 'worktree.create')!
    assert.equal(worktreeCreate.params['trust_repository'], true)
    assert.equal(worktreeCreate.params['focus'], false)
    assert.match(worktreeCreate.params['branch'] as string, /^helm\/wf-/)
    // env 非空 -> workspace 内补建 tab + 关初始 tab。
    const tabCreates = env.transport.calls.filter((c) => c.method === 'tab.create')
    assert.equal(tabCreates.length, 1, '补建一个带 env 的 tab')
    assert.ok(tabCreates[0]!.params['workspace_id'])
    assert.ok(env.transport.calls.some((c) => c.method === 'tab.close'), '关闭初始空 tab')
    // onResolved 回传 worktree 元数据（workflow 命名空间）+ effectiveCwd 为 worktree.path。
    const wt = extractWorkflowExecutionMeta(resolved as AgentExecutionInfo).worktree
    assert.ok(wt?.path.includes('.worktrees/'))
    assert.equal(resolved!['effectiveCwd'], wt!.path)
    // 父回合 settle -> workspace.close。
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.ok([...env.transport.workspaces.values()].some((w) => w.closed), '关闭自有最后一个 tab 后 Herdr 回收空 worktree workspace')
  } finally {
    await env.close()
  }
})

test('双轨清理: workflowRunId 由 onWorkflowSettled 关；独立 pane 由父回合关', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // workflow 轨道。
    scriptSuccess(env, 'wf-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', meta: { 'builtin:workflow': { runId: 'wf_run1' } } })
    const pane1 = [...env.transport.panes.values()][0]!
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.equal(env.transport.tabs.get(pane1.tabId)!.closed, false, 'workflow pane 不由父回合关')
    for (const listener of env.backend.workflowListeners) {
      await listener({ id: 'wf_run1', name: 'n', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2 })
    }
    assert.equal(env.transport.tabs.get(pane1.tabId)!.closed, true, 'workflow settle 关闭 pane')

    // 独立轨道。
    scriptSuccess(env, 'solo-ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    const pane2 = [...env.transport.panes.values()][1]!
    await env.host.runHook('turn_settled', turnSettledOf(1))
    assert.equal(env.transport.tabs.get(pane2.tabId)!.closed, true, '独立 pane 由父回合关')
    // 不同父回合不误关他人 pane。
    scriptSuccess(env, 'other-ok')
    await spawnDirect(env, { agentType: 'herdr:agy', })
    const pane3 = [...env.transport.panes.values()][2]!
    await env.host.runHook('turn_settled', turnSettledOf(2))
    assert.equal(env.transport.tabs.get(pane3.tabId)!.closed, false, '他人父回合不误关')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// resume
// ---------------------------------------------------------------------------

test('resume: 同父复用 pane 不新建；跨父拒绝；未知拒绝；并发拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'first')
    await spawnDirect(env, { agentType: 'herdr:agy', agentId: 'wf_1:node-a' })
    const pane = [...env.transport.panes.values()][0]!
    const tabsBefore = env.transport.calls.filter((c) => c.method === 'tab.create').length

    scriptSuccess(env, 'second')
    const resumed = await spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_1:node-a', agentId: 'wf_1:node-a' })
    assert.equal(resumed, 'second')
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, tabsBefore, 'resume 不新建 tab')
    assert.equal(env.transport.panes.size, 1, '复用既有 pane')

    // 跨父会话拒绝（经 runHook 直接断言错误传播）。
    const crossParent = env.host.runHook('agent_spawn', {
      parentConversationId: 2,
      prompt: 'x',
      agentType: 'herdr:agy',
      resume: 'wf_1:node-a',
    } as never)
    await assert.rejects(crossParent, (e: unknown) => {
      assert.equal((e as HelmError).code, 'cross_parent_resume_rejected')
      return true
    })

    // 未知 ref 拒绝。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', resume: 'no-such-ref' }),
      (e: unknown) => (e as HelmError).code === 'not_found',
    )
    void pane
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// abort
// ---------------------------------------------------------------------------

test('abort: 立即取消 Ask 并关闭自有 PTY（清理不受 aborted 阻碍）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const controller = new AbortController()
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy', signal: controller.signal })
    await waitFor(() => env.backend.createdAsks.length === 1)
    controller.abort()
    await assert.rejects(resultPromise, (e: unknown) => (e as HelmError).code === 'aborted')
    const pane = [...env.transport.panes.values()][0]!
    await waitFor(() => env.transport.tabs.get(pane.tabId)?.closed === true)
    // abort 同时销单。
    assert.ok(env.backend.cancelledAsks.some((c) => c.id === env.backend.createdAsks[0]!['id']), 'abort 取消关联 Ask')
  } finally {
    await env.close()
  }
})

test('超时（TimeoutError）保留 pane：working 时 resume 显式拒绝不发键；idle 后可 resume 复用同一 pane', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 首轮任务投递后底层 CLI 持续 working（不写交接文件）。
    env.transport.promptStatus = 'working'
    const waitBreak = new AbortController()
    env.transport.waitAbort = waitBreak.signal
    const controller = new AbortController()
    const spawned = spawnDirect(env, { agentType: 'herdr:agy', agentId: 'wf_to:a', signal: controller.signal })
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt'))
    // 回合超时（AbortSignal.timeout 同源语义：reason 为 TimeoutError）。
    controller.abort(new DOMException('turn timed out', 'TimeoutError'))
    let timedOut: unknown = undefined
    await assert.rejects(spawned, (e: unknown) => {
      timedOut = e
      return e instanceof HelmError && e.code === 'agent_timeout'
    })
    assert.ok(timedOut instanceof HelmError)
    const details = timedOut.details as { snapshot?: unknown } | undefined
    const snapshotOfTimeout = String(details?.snapshot ?? '')
    assert.ok(snapshotOfTimeout.length > 0, '超时错误附终端诊断快照')

    const pane = [...env.transport.panes.values()][0]!
    assert.equal(env.transport.tabs.get(pane.tabId)?.closed, false, '超时保留 pane 不关窗')
    assert.equal(pane.agentStatus, 'working', '底层 CLI 仍 working')
    assert.equal(env.transport.sendKeysLog.length, 0, '绝不代发按键中止')
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
    assert.equal(list.panes[0]!.outcome, 'failed', 'registry 标 failed 留档')

    // 底层仍 working：resume 在任何 prompt 发送前显式拒绝（不新建、不发键）。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_to:a' }),
      (e: unknown) => e instanceof HelmError && e.code === 'resume_agent_busy',
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.prompt').length, 1, '拒绝续接时不追加 prompt')
    assert.equal(env.transport.sendKeysLog.length, 0)

    // 释放 fake agent.wait 后底层转 idle：权威确认通过，复用同一 pane 续接。
    waitBreak.abort()
    await waitFor(() => env.transport.waitBreaks === 1)
    env.transport.advancePane(pane.paneId, 'idle')
    scriptSuccess(env, 'resumed-after-timeout')
    const tabsBefore = env.transport.calls.filter((c) => c.method === 'tab.create').length
    const resumed = await spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_to:a' })
    assert.equal(resumed, 'resumed-after-timeout')
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, tabsBefore, '复用既有 pane 不新建 tab')
    assert.equal(env.transport.panes.size, 1)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 启停与 liveTasks
// ---------------------------------------------------------------------------

test('启停: 默认停用注册不连接；启用连接；保活期间 disable 409；结算后可 disable', { timeout: 60_000 }, async () => {
  const env = await makeEnv({ enabled: false })
  try {
    assert.equal(env.transport.calls.filter((c) => c.method === 'events.subscribe').length, 0)
    assert.equal(env.host.list().find((p) => p.id === 'builtin:herdr')!.enabled, false)
    const outcome = await env.host.runHook('agent_spawn', { parentConversationId: 1, prompt: 'x', agentType: 'herdr:agy' } as never)
    assert.notEqual(outcome.action, 'handled', '停用态不接管')

    await env.host.enable('builtin:herdr')
    assert.equal(env.transport.calls.filter((c) => c.method === 'events.subscribe').length, 1, '启用即连接')

    scriptSuccess(env, 'keepalive')
    await spawnDirect(env, { agentType: 'herdr:agy' })

    // 成功保活 pane 期间无活跃 spawn hook 仍 409（空隙保护）。
    await assert.rejects(env.host.disable('builtin:herdr'), (e: unknown) => {
      assert.equal((e as HelmError).code, 'plugin_has_live_tasks')
      assert.ok((e as HelmError).message.includes('herdr-keepalive'))
      return true
    })

    // 父回合结算清空后可 disable。
    await env.host.runHook('turn_settled', turnSettledOf(1))
    await env.host.disable('builtin:herdr')
    const pane = [...env.transport.panes.values()][0]!
    assert.equal(env.transport.tabs.get(pane.tabId)!.closed, true, 'stop 清理可回收 pane')
  } finally {
    await env.close()
  }
})

test('服务启动半途失败: snapshot 失败时自行清理订阅，注册整体失败', { timeout: 60_000 }, async () => {
  const transport = new FakeTransport()
  transport.errors.set('session.snapshot', () => new HelmError('herdr_socket', 'snapshot failed', 502))
  const backend = new FakeBackend()
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-halfway-'))
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs: new MemoryDocStore(), config: new MemoryConfigStore({ socketPath }) })
  try {
    await assert.rejects(
      host.register(createHerdrPlugin(HERDR_FAST_TEST_TIMINGS)),
      (e: unknown) => ['plugin_registration_failed', 'plugin_service_start_failed', 'herdr_socket'].includes((e as HelmError).code),
    )
    // 订阅已清理（listener 集空）。wire stop() 只 destroy 客户端 socket；
    // fixture server 侧的 close 释放是异步到达，等其收敛。
    await waitFor(() => transport.eventListeners.length === 0)
    assert.equal(transport.eventListeners.length, 0, '半途失败清理订阅')
  } finally {
    await host.dispose().catch(() => {})
    await served.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 启动对账
// ---------------------------------------------------------------------------

test('启动对账: 孤儿回收；failed 保留；同 ID 换 human agent 不误关；keepalive 不当孤儿', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-recon-'))
  const docs = new MemoryDocStore()
  const orphanPaneId = 'ws-default:p1'
  const failedPaneId = 'ws-default:p2'
  const humanPaneId = 'ws-default:p3'
  const keepalivePaneId = 'ws-default:p4'
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: [
      { target: {}, routing: { kind: 'agy' }, paneId: orphanPaneId, tabId: 'ws-default:t1', effectiveCwd: '/tmp/a', agentName: 'helm-wf-abc', parentConversationId: 1, outcome: 'running', createdAt: 1 },
      { target: {}, routing: { kind: 'agy' }, paneId: failedPaneId, tabId: 'ws-default:t2', effectiveCwd: '/tmp/b', agentName: 'helm-wf-def', parentConversationId: 1, outcome: 'failed', createdAt: 1, failureNote: 'x' },
      { target: {}, routing: { kind: 'agy' }, paneId: humanPaneId, tabId: 'ws-default:t3', effectiveCwd: '/tmp/c', agentName: 'human-agent', parentConversationId: 1, outcome: 'running', createdAt: 1 },
      { target: {}, routing: { kind: 'agy' }, paneId: keepalivePaneId, tabId: 'ws-default:t4', effectiveCwd: '/tmp/d', agentName: 'helm-wf-ghi', parentConversationId: 1, outcome: 'keepalive', createdAt: 1 },
    ],
  })
  const backend = new FakeBackend()
  const transport = new FakeTransport()
  transport.panes.set(orphanPaneId, { paneId: orphanPaneId, tabId: 'ws-default:t1', workspaceId: 'ws-default', agentStatus: 'done', seq: 3, name: 'helm-wf-abc', cwd: '/tmp/a' })
  transport.panes.set(failedPaneId, { paneId: failedPaneId, tabId: 'ws-default:t2', workspaceId: 'ws-default', agentStatus: 'idle', seq: 3, name: 'helm-wf-def', cwd: '/tmp/b' })
  transport.panes.set(humanPaneId, { paneId: humanPaneId, tabId: 'ws-default:t3', workspaceId: 'ws-default', agentStatus: 'working', seq: 3, name: 'human-agent', cwd: '/tmp/c' })
  transport.panes.set(keepalivePaneId, { paneId: keepalivePaneId, tabId: 'ws-default:t4', workspaceId: 'ws-default', agentStatus: 'done', seq: 3, name: 'helm-wf-ghi', cwd: '/tmp/d' })
  for (const t of ['ws-default:t1', 'ws-default:t2', 'ws-default:t3', 'ws-default:t4']) {
    transport.tabs.set(t, { closed: false })
  }

  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(transport, socketPath)
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs, config: new MemoryConfigStore({ socketPath }) })
  try {
    // doc pane target 显式指向测试 served socket：target:{} 会 resolve 到宿主
    // 真实 ~/.config/herdr/herdr.sock（对账拿到外部 pane 集合，孤儿回收误判）。
    const doc = docs.store.get('builtin:herdr:managed') as { panes: Array<{ target: Record<string, unknown> }> }
    for (const pane of doc.panes) pane.target = { socketPath }
    await host.register(createHerdrPlugin(HERDR_FAST_TEST_TIMINGS))
    assert.equal(transport.tabs.get('ws-default:t1')!.closed, true, '孤儿（running+done）回收')
    assert.equal(transport.tabs.get('ws-default:t2')!.closed, false, 'failed 保留现场（即使实际 idle）')
    assert.equal(transport.tabs.get('ws-default:t3')!.closed, false, '同 ID 换 human agent 不误关')
    assert.equal(transport.tabs.get('ws-default:t4')!.closed, true, '已结束 keepalive 孤儿同样回收')
  } finally {
    await host.dispose().catch(() => {})
    await served.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// human 红线与防自激
// ---------------------------------------------------------------------------

test('human 红线: 非自有 pane 的 blocked 事件不建 Ask、不发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.panes.set('ws-other:p9', { paneId: 'ws-other:p9', tabId: 'ws-other:t9', workspaceId: 'ws-other', agentStatus: 'blocked', seq: 5, cwd: '/tmp' })
    env.transport.emit({ type: 'pane.updated', paneId: 'ws-other:p9' })
    await delay(40)
    assert.equal(env.backend.createdAsks.length, 0)
    assert.equal(env.transport.sendKeysLog.length, 0)
  } finally {
    await env.close()
  }
})

test('report_metadata 防自激: 同 token 重复事件不重复投射', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'meta-ok')
    const p = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.prompt'))
    const pane = [...env.transport.panes.values()][0]!
    for (let i = 0; i < 5; i += 1) env.transport.emit({ type: 'pane.updated', paneId: pane.paneId })
    await delay(50)
    const reports = env.transport.metadataReports.filter((r) => r['pane_id'] === pane.paneId)
    assert.ok(reports.length <= 2, `同 token 去重（实际 ${reports.length} 次）`)
    await p
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// actions 与 agent_not_ready
// ---------------------------------------------------------------------------

test('actions: list/read/focus（read 40 行脱敏；未知 pane 404）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    scriptSuccess(env, 'act-ok')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ paneId: string; nodeId: string; outcome: string }> }
    assert.ok(list.panes.length >= 1)
    assert.equal(list.panes[0]!.nodeId, 'local')
    const read = (await env.host.invokeAction('builtin:herdr', 'read', { paneId: list.panes[0]!.paneId })) as { text: string }
    assert.ok(read.text.includes('[REDACTED]'), 'read 脱敏')
    const focus = (await env.host.invokeAction('builtin:herdr', 'focus', { paneId: list.panes[0]!.paneId })) as { focused: boolean }
    assert.equal(focus.focused, true)
    assert.ok(env.transport.calls.some((c) => c.method === 'agent.focus'))
    await assert.rejects(
      env.host.invokeAction('builtin:herdr', 'read', { paneId: 'nope:p1' }),
      (e: unknown) => (e as HelmError).status === 404,
    )
  } finally {
    await env.close()
  }
})

test('新窗格 shell 尚未就绪：仅对零启动的 agent_pane_busy 等待再试', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.errors.set('agent.start', () => {
      env.transport.errors.delete('agent.start')
      return new HelmError('agent_pane_busy', 'shell 尚未就绪，未启动 Agent', 409)
    })
    env.transport.onPrompt = (pane, text) => {
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, 'ready-result')
    }
    assert.equal(await spawnDirect(env, { agentType: 'herdr:pi' }), 'ready-result')
    assert.equal(env.transport.calls.filter((call) => call.method === 'agent.start').length, 2)
    assert.equal(env.transport.calls.filter((call) => call.method === 'agent.prompt').length, 1)
    assert.equal(env.transport.calls.filter((call) => call.method === 'tab.create').length, 1)
  } finally {
    await env.close()
  }
})

test('新窗格启动结果不确定时不重试 agent.start', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.errors.set('agent.start', () => new HelmError('herdr_timeout', '启动响应超时，可能已启动', 504))
    await assert.rejects(spawnDirect(env, { agentType: 'herdr:pi' }), (error: unknown) => (error as HelmError).code === 'herdr_timeout')
    assert.equal(env.transport.calls.filter((call) => call.method === 'agent.start').length, 1)
    assert.equal(env.transport.calls.filter((call) => call.method === 'agent.prompt').length, 0)
  } finally {
    await env.close()
  }
})

test('启动期超时后 resume：agent.start 完成与否未定时权威确认失败则显式拒绝，不盲目重发', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 启动期超时：agent.start 响应不确定，窗格登记 failed 且无受管 Agent 身份。
    env.transport.errors.set('agent.start', () => new HelmError('herdr_timeout', '启动响应超时，可能已启动', 504))
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', agentId: 'wf_su:a' }),
      (error: unknown) => (error as HelmError).code === 'herdr_timeout',
    )
    const starts = env.transport.calls.filter((c) => c.method === 'agent.start').length
    assert.equal(starts, 1)

    // resume 先由权威 agent.get 确认：窗格无受管 Agent 身份（name 缺失）→
    // 显式拒绝；不重发 agent.start、不新建、不发 prompt。
    await assert.rejects(
      spawnDirect(env, { agentType: 'herdr:agy', resume: 'wf_su:a' }),
      (e: unknown) => e instanceof HelmError && e.code === 'herdr_ownership_lost',
    )
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.start').length, starts, 'resume 不盲目重发 agent.start')
    assert.equal(env.transport.calls.some((c) => c.method === 'agent.prompt'), false, '拒绝续接时不发 prompt')
  } finally {
    await env.close()
  }
})

test('agent_not_ready 桥接: 权威 blocked 时复用既有 agent，不启动第二个', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.errors.set('agent.start', () => new HelmError('agent_not_ready', 'agent not ready', 409))
    // pane 上已有 blocked agent（tab.create 后由 fake 设定——prompt 前的 start 阶段）。
    env.transport.promptStatus = 'blocked'
    // 在 tab.create 后立刻把 pane 置为 blocked（有 name 的 helm-wf agent）。
    const originalCall = env.transport.call.bind(env.transport)
    ;(env.transport as { call: unknown }).call = async (target: HerdrTarget, method: string, params: Record<string, unknown>) => {
      const result = await originalCall(target, method, params)
      if (method === 'tab.create') {
        const paneId = (result as { root_pane: { pane_id: string } }).root_pane.pane_id
        const pane = env.transport.panes.get(paneId)!
        pane.name = 'helm-wf-existing'
        pane.agentStatus = 'blocked'
      }
      return result
    }
    const p = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1, 8000)
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.start').length, 1, '只尝试一次 start')
    assert.ok(env.backend.notifications.some((n) => n.title.includes('already has a waiting Agent')), '桥接通知')
    // 收尾：取消 Ask。
    env.backend.answerAsk(env.backend.createdAsks[0]!['id'] as string, { id: 'x', status: 'cancelled', answers: {} })
    await assert.rejects(p, () => true)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 快照菜单提取与审批闭环复核
// ---------------------------------------------------------------------------

/** Agy 信任目录弹窗快照（游标列表选择式对话框）。 */
const AGY_TRUST_SNAPSHOT = [
  '/root/.herdr/worktrees/helm/helm-wf-cocmre',
  '',
  'Do you trust the contents of this project?',
  '',
  'Antigravity CLI requires permission to read, edit, and',
  'execute files here.',
  '',
  '> Yes, I trust this folder',
  '  No, exit',
  '',
  '  ↑/↓ Navigate · enter Confirm',
  '',
].join('\n')

test('单测A: 快照游标菜单提取与按键映射——allow-enter/menu-1/custom 均正确发键', { timeout: 60_000 }, async () => {
  // 阶段 1：纯函数验证（不启动插件）。
  const { extractMenuItemsFromSnapshot, buildHerdrAskPromptPlan, parseCustomKeys } = await import('../src/herdr/prompt-options.js')
  const items = extractMenuItemsFromSnapshot(AGY_TRUST_SNAPSHOT)
  assert.equal(items.length, 2)
  assert.deepEqual(
    items.map((i) => ({ label: i.label, keys: i.keys, selected: i.selected })),
    [
      { label: 'Yes, I trust this folder', keys: ['enter'], selected: true },
      { label: 'No, exit', keys: ['down', 'enter'], selected: false },
    ],
  )
  const plan = buildHerdrAskPromptPlan(AGY_TRUST_SNAPSHOT)
  assert.deepEqual(plan.decisionKeys.get('allow-enter'), ['enter'])
  assert.deepEqual(plan.decisionKeys.get('menu-1'), ['down', 'enter'])
  assert.deepEqual(parseCustomKeys('down, enter'), ['down', 'enter'])
  assert.deepEqual(parseCustomKeys(''), [])

  // 阶段 2：AskDoc options 与 description 代码块围栏。
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = AGY_TRUST_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter')
    assert.ok(options[0]!.label.includes('Yes, I trust this folder'))
    assert.equal(options[1]!.value, 'menu-1')
    assert.ok(options[1]!.label.includes('No, exit'))
    assert.ok(options[1]!.label.includes('down + enter'))
    assert.ok((ask['description'] as string).includes('```'), 'description 含代码块围栏')

    // 回答 allow-enter -> 发送 ['enter']。
    const askId = ask['id'] as string
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['enter'])

    // 终端消化后收尾。
    const pane = [...env.transport.panes.values()][0]!
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'trusted')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'trusted')
  } finally {
    await env.close()
  }
})

test('单测A-续: menu-1 与 custom 多键序列经完整审批桥发送', { timeout: 60_000 }, async () => {
  for (const answer of [{ decision: 'menu-1' }, { decision: 'custom', key: 'down, enter' }] as Record<string, string>[]) {
    const env = await makeEnv()
    try {
      env.transport.promptStatus = 'blocked'
      env.transport.snapshotText = AGY_TRUST_SNAPSHOT
      const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
      await waitFor(() => env.backend.createdAsks.length === 1)
      const askId = env.backend.createdAsks[0]!['id'] as string
      env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: answer })
      await waitFor(() => env.transport.sendKeysLog.length === 1)
      assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['down', 'enter'])
      const pane = [...env.transport.panes.values()][0]!
      const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'picked')
      env.transport.consumeKeys(pane.paneId, 'done')
      assert.equal(await resultPromise, 'picked')
    } finally {
      await env.close()
    }
  }
})

test('单测B: 按键未生效时闭环复核——自动重开 AskDoc 且带未生效提示，二次选择后成功', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    env.transport.promptStatus = 'blocked'
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })

    // 第 1 次 AskDoc：人类回答 allow-y，发出 ['y']。
    await waitFor(() => env.backend.createdAsks.length === 1)
    const pane = [...env.transport.panes.values()][0]!
    const firstId = env.backend.createdAsks[0]!['id'] as string
    assert.ok(/:10$|:\d+$/.test(firstId), '首个 id 形如 herdr:local:<pane>:<seq>')
    env.backend.answerAsk(firstId, { id: firstId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['y'])

    // 终端不响应 y：保持 blocked 且 seq 不变（consumeKeys 不调用）。
    // 经退避后协调器自动重开第 2 次 AskDoc（id 带 :r1 后缀）。
    await waitFor(() => env.backend.createdAsks.length === 2, 15_000, 50)
    const second = env.backend.createdAsks[1]!
    const secondId = second['id'] as string
    assert.equal(secondId, `${firstId}:r1`, '重开 AskDoc id 为 <key>:r1')
    assert.ok((second['description'] as string).includes('The last keystrokes sent [y] did not clear the block'), '重开描述含未生效提示')

    // 第 2 次回答 allow-enter -> 发送 ['enter'] -> 终端推进 done -> spawn 成功。
    env.backend.answerAsk(secondId, { id: secondId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 2)
    assert.deepEqual(env.transport.sendKeysLog[1]!.keys, ['enter'])
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'recovered')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'recovered')
    assert.equal(env.backend.createdAsks.length, 2, '整个闭环恰好两次 AskDoc')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 混合快慢路径：AI 快照解析辅助层
// ---------------------------------------------------------------------------

/** 非标快捷键提示快照（正则无法识别为标准菜单）。 */
const NONSTANDARD_HINT_SNAPSHOT = [
  'Tool bash requires confirmation',
  'Press (o)nce, (a)lways allow, or (d)eny',
].join('\n')

test('单测C: 按键白名单与 AI JSON 清洗纯函数验证', { timeout: 60_000 }, async () => {
  const { isValidHerdrLogicalKey, parseAiSnapshotAnalysisText } = await import('../src/herdr/prompt-options.js')

  // 白名单：合法按键。
  for (const key of ['enter', 'down', 'shift+tab', 'ctrl+c', 'f1', 'a', '1']) {
    assert.equal(isValidHerdrLogicalKey(key), true, `合法按键 ${key}`)
  }
  // 白名单：非法按键（多字母单词 / 空串 / 带空格 / 分隔符 '+'）。加号用 plus。
  for (const key of ['', 'yes', 'allow', 'enter key', '+']) {
    assert.equal(isValidHerdrLogicalKey(key), false, `非法按键 "${key}"`)
  }
  assert.equal(isValidHerdrLogicalKey('plus'), true, 'plus 命名键合法')

  // JSON 提取：```json 围栏 + 脏选项剔除。
  const fenced = '```json\n{"summary":"等待 bash 执行确认","options":[{"label":"仅本次允许","keys":["o"]},{"label":"总是允许","keys":["yes"]},{"label":"移到下一项后确认","keys":["right","enter"]}]}\n```'
  const parsed = parseAiSnapshotAnalysisText(fenced)!
  assert.ok(parsed !== undefined, '围栏 JSON 可解析')
  assert.equal(parsed.summary, '等待 bash 执行确认')
  assert.deepEqual(
    parsed.options.map((o) => o.keys),
    [['o'], ['right', 'enter']],
    '含非法按键 ["yes"] 的脏选项被剔除，合法选项保留',
  )

  // JSON 提取：无围栏裸 JSON（截取首 { 到末 }）。
  const bare = parseAiSnapshotAnalysisText('好的，解析结果如下 {"summary":"等待确认","options":[{"label":"允许","keys":["a"]}]} 以上。')
  assert.ok(bare !== undefined)
  assert.deepEqual(bare.options, [{ label: '允许', keys: ['a'] }])

  // 解析失败：非 JSON 文本 / 非法 JSON / 全部选项被剔除且无摘要。
  assert.equal(parseAiSnapshotAnalysisText('模型拒绝回答'), undefined)
  assert.equal(parseAiSnapshotAnalysisText('{"broken": '), undefined)
  assert.equal(parseAiSnapshotAnalysisText('{"options":[{"label":"x","keys":["yes"]}]}'), undefined)
})

test('单测D-1: 正则命中标准菜单时不调 AI（0ms 快路径优先）', { timeout: 60_000 }, async () => {
  let aiCalls = 0
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => {
      aiCalls += 1
      return '{"summary":"不应被调用","options":[{"label":"幻觉选项","keys":["z"]}]}'
    },
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = AGY_TRUST_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    await delay(40)
    assert.equal(aiCalls, 0, '正则命中时不调 AI（省 Token）')
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter', '仍是快路径菜单选项')
    assert.ok(!options.some((o) => o.value.startsWith('ai-')), '无 AI 选项注入')
    // 收尾。
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'fast-path')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'fast-path')
    assert.equal(aiCalls, 0, '全程零 AI 调用')
  } finally {
    await env.close()
  }
})

test('单测D-2: 非标快照时调 AI 生成选项并正确发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () =>
      JSON.stringify({
        summary: '终端等待 bash 工具执行确认',
        options: [
          { label: '仅本次允许 (once)', keys: ['o'] },
          { label: '总是允许 (always)', keys: ['a'] },
          { label: '拒绝 (deny)', keys: ['d'] },
        ],
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    assert.ok(description.includes('Block summary: 终端等待 bash 工具执行确认'), 'description includes the block summary')
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.equal(options[0]!.value, 'allow-enter', '首项补允许 enter')
    const ai0 = options.find((o) => o.value === 'ai-0')!
    const ai1 = options.find((o) => o.value === 'ai-1')!
    const ai2 = options.find((o) => o.value === 'ai-2')!
    assert.ok(ai0 && ai0.label.includes('仅本次允许') && ai0.label.includes('AI detected: send o'), 'ai-0 label includes the key')
    assert.ok(ai1 && ai1.label.includes('总是允许'))
    assert.ok(ai2 && ai2.label.includes('拒绝'))
    // 人类选择 ai-1（总是允许）-> 发送 ['a']。
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'ai-1' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['a'], 'ai-1 准确发送 [a]')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'ai-allowed')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'ai-allowed')
  } finally {
    await env.close()
  }
})

test('单测D-3: AI 抛错或返回 undefined 时无感回退通用选项', { timeout: 60_000 }, async () => {
  for (const behavior of ['throw', 'undefined'] as const) {
    const env = await makeEnv({
      analyzeBlockedSnapshot: async () => {
        if (behavior === 'throw') throw new Error('model timeout')
        return '模型拒绝回答'
      },
    })
    try {
      env.transport.promptStatus = 'blocked'
      env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
      const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
      await waitFor(() => env.backend.createdAsks.length === 1)
      const ask = env.backend.createdAsks[0]!
      const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
      const values = options.map((o) => o.value)
      assert.deepEqual(
        values,
        ['allow-enter', 'allow-y', 'deny-n', 'send-esc', 'custom'],
        `${behavior} 时平稳回退默认选项`,
      )
      assert.ok(!(ask['description'] as string).includes('Block summary:'), 'no AI summary')
      // 收尾：回答 deny-n -> 发送 ['n']。
      const askId = ask['id'] as string
      const pane = [...env.transport.panes.values()][0]!
      env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'deny-n' } })
      await waitFor(() => env.transport.sendKeysLog.length === 1)
      assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['n'])
      const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
      env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'fallback')
      env.transport.consumeKeys(pane.paneId, 'done')
      assert.equal(await resultPromise, 'fallback')
    } finally {
      await env.close()
    }
  }
})

// ---------------------------------------------------------------------------
// 快路径防误判 fixture：正文步骤列表 / 缩进建议正文不得识别成菜单
// ---------------------------------------------------------------------------

test('单测E-1: 正文步骤列表不是菜单——步骤编号 + y/n 提问不进快路径（走 AI）', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/herdr/prompt-options.js')
  const snapshot = ['之前步骤：', '  1. 安装依赖', '  2. 编译构建', '现在请确认是否继续？(y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(snapshot), [], '正文步骤列表不得识别为菜单')
})

test('单测E-2: 游标建议行 + 不同缩进正文不是菜单', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/herdr/prompt-options.js')
  const snapshot = ['> 我建议采用方案 A', '    补充说明'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(snapshot), [], '缩进层级不齐的正文不得当作菜单兄弟项')
})

test('单测E-3: 标准菜单 fixture 仍命中快路径且不调 AI（AGY / Codex 编号菜单）', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/herdr/prompt-options.js')
  // AGY 游标菜单（无编号）。
  const agy = extractMenuItemsFromSnapshot(AGY_TRUST_SNAPSHOT)
  assert.equal(agy.length, 2)
  assert.equal(agy[0]!.selected, true)
  // Codex 编号菜单（游标 + 导航提示）。
  const codexSnapshot = [
    '╭─ bash ─╮',
    '  > 1. Yes',
    '    2. Yes, and auto-accept',
    '    3. No',
    '╰────────╯',
    '  ↑/↓ Navigate · enter Confirm',
  ].join('\n')
  const codex = extractMenuItemsFromSnapshot(codexSnapshot)
  assert.equal(codex.length, 3, '编号菜单带游标 + 提示命中快路径')
  assert.equal(codex[0]!.selected, true)

  // 端到端：标准菜单 fixture 下 analyzeBlockedSnapshot 不被调用。
  let aiCalls = 0
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => {
      aiCalls += 1
      return '不应被调用'
    },
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = codexSnapshot
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.ok(options[0]!.value === 'allow-enter' && options.some((o) => o.value === 'menu-1'), '编号菜单快路径选项')
    assert.equal(aiCalls, 0, '标准菜单不调 AI')
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'codex-fast')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'codex-fast')
  } finally {
    await env.close()
  }
})

test('单测E-4: 疑似不截断——超 8 项连续编号 / 编号不连续 / 历史编号后跟新正文均返回空', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/herdr/prompt-options.js')
  // 超 8 项：更像正文步骤列表，不截成假菜单。
  const tooMany = ['Select an option:', ...Array.from({ length: 10 }, (_, i) => `  ${i + 1}. option ${i + 1}`)].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(tooMany), [], '超 8 项连续编号不截断')
  // 编号不从 1 开始连续：非真实菜单。
  const notFromOne = ['Select an option:', '  2. second', '  3. third'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(notFromOne), [], '编号不连续拒绝')
  // 历史编号块后跟新正文：不选历史菜单。
  const stale = ['  1. old choice', '  2. another old', '', 'some new body text line', 'now blocked? (y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(stale), [], '跨正文历史编号拒绝')
  // 无游标且无确认/选择提问：正文步骤（交 AI），不默认首项高亮。
  const noPrompt = ['  1. alpha', '  2. beta'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(noPrompt), [], '无游标无确认提问交 AI')
  // 无游标但带确认提问：同样不默认首项（无可靠选中信息一律交 AI）。
  const numberedPrompt = ['Select an option:', '  1. Deploy to production', '  2. Deploy to staging'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(numberedPrompt), [], '无游标编号列表不默认首项高亮')
  // 多游标编号块：解析噪声，拒绝。
  const multiCursor = ['  > 1. Yes', '  > 2. No', '', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(multiCursor), [], '多游标编号块拒绝')
})

test('单测E-4b: 菜单块后跟新正文拒绝；Press enter to continue 与装饰框线为合法提示', { timeout: 60_000 }, async () => {
  const { extractMenuItemsFromSnapshot } = await import('../src/herdr/prompt-options.js')
  // 旧 Agy 游标菜单后跟新正文 y/n 提问：整体拒绝，不选历史菜单。
  const agyThenBody = ['> Yes, I trust this folder', '  No, exit', '', '  ↑/↓ Navigate · enter Confirm', '', '现在请确认？(y/n)'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(agyThenBody), [], '菜单块后新正文拒绝')
  // Codex 'Press enter to continue' 是合法交互证据。
  const codexHint = ['> Yes', '  No', '', 'Press enter to continue'].join('\n')
  assert.equal(extractMenuItemsFromSnapshot(codexHint).length, 2, 'Press enter to continue 命中快路径')
  // Codex 装饰框线（╭─ ─╮/╰─╯）是菜单装饰，不是正文。
  const codexFramed = ['╭─ bash ─╮', '  > 1. Yes', '    2. Yes, and auto-accept', '    3. No', '╰────────╯', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.equal(extractMenuItemsFromSnapshot(codexFramed).length, 3, '框线包围的编号菜单命中快路径')
  // 超 8 项游标列表：不截断成前 8 项。
  const tooManyCursor = ['> first', ...Array.from({ length: 10 }, (_, i) => `  option ${i + 2}`), '', '  ↑/↓ Navigate · enter Confirm'].join('\n')
  assert.deepEqual(extractMenuItemsFromSnapshot(tooManyCursor), [], '超 8 项游标列表不截断')
})

test('单测E-5: AI labels 与 summary 在最终 AskSpec 边界统一脱敏', { timeout: 60_000 }, async () => {
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () =>
      JSON.stringify({
        summary: '等待确认 SECRET-TOKEN 泄漏测试',
        options: [{ label: '允许 SECRET-TOKEN', keys: ['o'] }],
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    assert.ok(!description.includes('SECRET-TOKEN'), 'summary 脱敏后进入 description')
    for (const opt of options) {
      assert.ok(!opt.label.includes('SECRET-TOKEN'), `label 脱敏：${opt.label}`)
    }
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-y' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'redacted')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'redacted')
  } finally {
    await env.close()
  }
})

test('单测E-6: AI 解析失败通知与 description 尾部快照', { timeout: 60_000 }, async () => {
  const longTail = `${'x'.repeat(2000)}\nTAIL-MARKER`
  const env = await makeEnv({
    analyzeBlockedSnapshot: async () => '模型拒绝回答（非 JSON 文本触发回退诊断）',
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = longTail
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const description = ask['description'] as string
    // 诊断写入 description（人类可见的回退说明）。
    assert.ok(description.includes('fell back to generic keystroke options'), 'description 含回退诊断')
    // 快照展示尾部：人类能看到 AI 所据的当前菜单。
    assert.ok(description.includes('TAIL-MARKER'), 'description 快照取尾部')
    assert.ok(!description.slice(0, description.indexOf('```')).includes('xxxx'), '不展示快照头部')
    // 通知通道也如实说明（不静默）。
    await waitFor(() => env.backend.notifications.some((n) => n.title.includes('AI parse incomplete')), 5_000)
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'deny-n' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'notified')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'notified')
  } finally {
    await env.close()
  }
})

test('单测E-7: AI 等待期间 seq 推进不挂旧 AskDoc（synthetic superseded）', { timeout: 60_000 }, async () => {
  let releaseAi: (() => void) | undefined
  const env = await makeEnv({
    analyzeBlockedSnapshot: () =>
      new Promise((resolve) => {
        releaseAi = () => resolve('已无意义')
      }),
  })
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    // AI 挂起期间终端自行推进（seq +1 -> done）：不创建 Ask。
    await waitFor(() => env.transport.calls.some((c) => c.method === 'agent.read'), 5_000)
    const pane = [...env.transport.panes.values()][0]!
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'self-resolved')
    env.transport.consumeKeys(pane.paneId, 'done')
    releaseAi?.()
    // seq 已推进：旧 Ask 不落地，spawn 正常收尾。
    assert.equal(await resultPromise, 'self-resolved')
    const herdrAsks = env.backend.createdAsks.filter((a) => (a['id'] as string).startsWith('herdr:'))
    assert.equal(herdrAsks.length, 0, 'AI 等待期间 seq 推进后不再挂旧 AskDoc')
  } finally {
    releaseAi?.()
    await env.close()
  }
})

test('单测E-8: 无 AI 选项（端口未注入）时自动补 allow-enter 并发键', { timeout: 60_000 }, async () => {
  const env = await makeEnv() // 不注入 analyzeBlockedSnapshot。
  try {
    env.transport.promptStatus = 'blocked'
    env.transport.snapshotText = NONSTANDARD_HINT_SNAPSHOT
    const resultPromise = spawnDirect(env, { agentType: 'herdr:agy' })
    await waitFor(() => env.backend.createdAsks.length === 1)
    const ask = env.backend.createdAsks[0]!
    const options = ((ask['fields'] as Array<{ name: string; options?: Array<{ label: string; value: string }> }>)[0]!.options)!
    const values = options.map((o) => o.value)
    assert.deepEqual(values, ['allow-enter', 'allow-y', 'deny-n', 'send-esc', 'custom'])
    assert.ok(options[0]!.label.startsWith('Send enter'), '首项语义只描述发送键，不含授权承诺')
    const askId = ask['id'] as string
    const pane = [...env.transport.panes.values()][0]!
    env.backend.answerAsk(askId, { id: askId, status: 'answered', answers: { decision: 'allow-enter' } })
    await waitFor(() => env.transport.sendKeysLog.length === 1)
    assert.deepEqual(env.transport.sendKeysLog[0]!.keys, ['enter'], 'human choosing allow-enter automatically sends enter')
    const fileName = fileNameOf(env.transport.calls.find((c) => c.method === 'agent.prompt')!.params['text'] as string)
    env.transport.outputFiles.set(`${pane.cwd}/.helm/${fileName}`, 'auto-enter')
    env.transport.consumeKeys(pane.paneId, 'done')
    assert.equal(await resultPromise, 'auto-enter')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 探针短超时、并发采集与断线退避自愈
// ---------------------------------------------------------------------------

interface ProbeFakePane {
  paneId: string
  agentStatus: string
  seq: number
  name?: string
  cwd: string
}

class ProbeTransport implements HerdrTransport {
  panes = new Map<string, ProbeFakePane>()
  agentGetDelayMs = 0
  private subscriptionErrorTriggers: Array<(error: Error) => void> = []

  private agentInfoOf(pane: ProbeFakePane) {
    return {
      pane_id: pane.paneId,
      tab_id: `t-${pane.paneId}`,
      workspace_id: 'w',
      name: pane.name,
      agent_status: pane.agentStatus,
      interactive_ready: true,
      state_change_seq: pane.seq,
      cwd: pane.cwd,
    }
  }

  async call(
    _target: HerdrTarget,
    method: string,
    params: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ): Promise<unknown> {
    void options
    if (method === 'agent.get') {
      if (this.agentGetDelayMs > 0) await delay(this.agentGetDelayMs)
      const pane = this.panes.get(String(params['target']))
      if (!pane) throw new HelmError('agent_not_found', 'no pane', 404)
      return { type: 'agent_info', agent: this.agentInfoOf(pane) }
    }
    if (method === 'session.snapshot') {
      return {
        type: 'session_snapshot',
        snapshot: {
          version: 'test', protocol: 22, workspaces: [], tabs: [],
          panes: [...this.panes.values()].map((p) => ({
            pane_id: p.paneId, tab_id: `t-${p.paneId}`, workspace_id: 'w',
            focused: false, agent_status: p.agentStatus, cwd: p.cwd,
          })),
          layouts: [],
          agents: [...this.panes.values()].map((p) => this.agentInfoOf(p)),
        },
      }
    }
    return { type: 'ok' }
  }
  async readOutput(): Promise<string> { throw new HelmError('unsupported', 'test', 400) }
  async removeOutput(): Promise<void> {}
  async runGate() { return { ok: true, output: '' } }
  async subscribe(
    _target: HerdrTarget,
    _onEvent: (event: HerdrEvent) => void,
    onError: (error: unknown) => void,
  ): Promise<() => void> {
    this.subscriptionErrorTriggers.push((error) => onError(error))
    return () => {}
  }
  failLatestSubscription(error: Error): void {
    this.subscriptionErrorTriggers.at(-1)?.(error)
  }
  get subscribeCount(): number {
    return this.subscriptionErrorTriggers.length
  }
}

interface HerdrProbeEnv {
  host: PluginHost
  backend: FakeBackend
  transport: ProbeTransport
  ipcCalls: Array<{ method: string; timeoutMs?: number }>
  close(): Promise<void>
}

const HERDR_REMOTE_NODE = 'n1'

async function makeHerdrProbeEnv(
  panes: Array<{ paneId: string; agentName: string; cwd: string; status?: string; seq?: number }>,
): Promise<HerdrProbeEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-probe-'))
  const backend = new FakeBackend()
  const docs = new MemoryDocStore()
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: panes.map((p) => ({
      target: { nodeId: HERDR_REMOTE_NODE },
      paneId: p.paneId,
      tabId: `t-${p.paneId}`,
      effectiveCwd: p.cwd,
      agentName: p.agentName,
      routing: { kind: 'agy' },
      parentConversationId: 3,
      outcome: 'keepalive',
      createdAt: 1,
    })),
  })
  const transport = new ProbeTransport()
  for (const p of panes) {
    transport.panes.set(p.paneId, {
      paneId: p.paneId,
      agentStatus: p.status ?? 'working',
      seq: p.seq ?? 1,
      name: p.agentName,
      cwd: p.cwd,
    })
  }
  const socketPath = join(dataDir, 'herdr.sock')
  const served = await serveTransport(
    transport,
    socketPath,
    () => ({ nodeId: HERDR_REMOTE_NODE }),
  )
  const ipcCalls: Array<{ method: string; timeoutMs?: number }> = []
  backend.nodeIpc = {
    isOnline: () => true,
    getNodeHubUrl: () => undefined,
    call: async (_nodeId, input, signal) => {
      const method = (JSON.parse(input.line) as { method: string }).method
      ipcCalls.push({ method, timeoutMs: input.timeoutMs })
      return ipcLineCall(socketPath, input.line, input.timeoutMs, signal)
    },
    subscribe: async () => { throw new HelmError('unsupported', '本 fixture 不承载 IPC 订阅', 501) },
  }
  const host = new PluginHost({ buildProvider: createPluginBuildProvider(),
    dataDir,
    host: backend,
    docs,
    config: new MemoryConfigStore({ socketPath }),
  })
  try {
    await host.register(createHerdrPlugin(HERDR_FAST_TEST_TIMINGS), { enabled: true })
  } catch (error) {
    await host.dispose().catch(() => {})
    await served.close()
    rmSync(dataDir, { recursive: true, force: true })
    throw error
  }
  return {
    host,
    backend,
    transport,
    ipcCalls,
    async close() {
      await host.dispose().catch(() => {})
      await served.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

async function runHerdrTick(env: HerdrProbeEnv): Promise<DiagnosticsCollection> {
  const payload: DiagnosticsCollection = { timestamp: Date.now(), conversations: [], probes: [] }
  await env.backend.emitEvent('diagnostics.collect', payload)
  return payload
}

test('herdr tick：agent.get / session.snapshot 全部带 5s 短超时', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 5 },
  ])
  try {
    await runHerdrTick(env)
    const relevant = env.ipcCalls.filter((c) => c.method === 'agent.get' || c.method === 'session.snapshot')
    assert.ok(relevant.length > 0, '应有 agent.get / session.snapshot 经 nodeIpc 通道到达受控服务器')
    for (const call of relevant) {
      assert.equal(call.timeoutMs, 5_000, `${call.method} 应带 timeoutMs=5000（实际 ${String(call.timeoutMs)}）`)
    }
  } finally {
    await env.close()
  }
})

test('herdr tick：5 个 100ms 探针并发采集（串行 500ms 应压到 350ms 内）', { timeout: 60_000 }, async () => {
  const panes = Array.from({ length: 5 }, (_, i) => ({
    paneId: `w:p${i + 1}`,
    agentName: `helm-wf-${i + 1}`,
    cwd: `/tmp/${i + 1}`,
    status: 'working',
    seq: 1,
  }))
  const env = await makeHerdrProbeEnv(panes)
  try {
    env.transport.agentGetDelayMs = 100
    const start = Date.now()
    const payload = await runHerdrTick(env)
    const elapsed = Date.now() - start
    assert.equal(payload.probes.length, 5)
    assert.ok(elapsed < 350, `并发采集应在 350ms 内完成（实际 ${elapsed}ms，疑似串行）`)
  } finally {
    await env.close()
  }
})

test('herdr 订阅断线：onError 后自动退避重连（watchdogEnabled 无关）', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const before = env.transport.subscribeCount
    env.transport.failLatestSubscription(new Error('socket reset by peer'))
    await waitFor(() => env.backend.notifications.some((n) => n.title === 'Herdr event subscription lost'), 2_000, 15)
    assert.ok(
      env.backend.notifications.some((n) => n.title === 'Herdr event subscription lost'),
      '断线应发出通知',
    )
    await waitFor(() => env.transport.subscribeCount > before, 2_000, 15)
    assert.ok(
      env.transport.subscribeCount > before,
      `断线后应自动重建订阅（before=${before} after=${env.transport.subscribeCount}）`,
    )
  } finally {
    await env.close()
  }
})

test('herdr 订阅重连后的流再次断线仍继续退避重试', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([])
  try {
    const before = env.transport.subscribeCount
    env.transport.failLatestSubscription(new Error('down 1'))
    await waitFor(() => env.transport.subscribeCount >= before + 1, 2_000, 15)
    await delay(30)
    env.transport.failLatestSubscription(new Error('down 2'))
    await waitFor(() => env.transport.subscribeCount >= before + 2, 2_000, 15)
    assert.ok(
      env.transport.subscribeCount >= before + 2,
      `多次断线应持续重连（before=${before} after=${env.transport.subscribeCount}）`,
    )
  } finally {
    await env.close()
  }
})

test('herdr tick：归属变化窗格结算移除后不再产出 probe', { timeout: 60_000 }, async () => {
  const env = await makeHerdrProbeEnv([
    { paneId: 'w:p1', agentName: 'helm-wf-a', cwd: '/tmp/a', status: 'working', seq: 1 },
  ])
  try {
    const first = await runHerdrTick(env)
    assert.equal(first.probes.length, 1)
    env.transport.panes.get('w:p1')!.name = 'human-agent'
    const second = await runHerdrTick(env)
    assert.equal(second.probes.length, 0, '归属变化窗格应结算移除，不再产出 probe')
    env.transport.panes.get('w:p1')!.name = 'helm-wf-a'
    const third = await runHerdrTick(env)
    assert.equal(third.probes.length, 0)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 生产形状启动就绪、resume 全维度校验、对账精确归属与批量清理隔离
// ---------------------------------------------------------------------------

test('启动就绪等待：unknown+launch_pending 与缺省 interactive_ready 均等到就绪才投递单次 prompt', { timeout: 60_000 }, async () => {
  // 1) startReady=false（unknown + launch_pending -> agent.wait 转 idle -> prompt）。
  const env1 = await makeEnv()
  try {
    env1.transport.startReady = false
    scriptSuccess(env1, 'real-start')
    assert.equal(await spawnDirect(env1, { agentType: 'herdr:agy' }), 'real-start')
    const startAt = env1.transport.calls.findIndex((c) => c.method === 'agent.start')
    const waitAt = env1.transport.calls.findIndex((c) => c.method === 'agent.wait' && (c.params['until'] as string[])?.includes('idle'))
    const promptAt = env1.transport.calls.findIndex((c) => c.method === 'agent.prompt')
    assert.ok(startAt >= 0 && waitAt > startAt && promptAt > waitAt)
  } finally {
    await env1.close()
  }

  // 2) idle 但 interactive_ready 缺省时持续轮询确认后再投递单次 prompt。
  const env2 = await makeEnv()
  try {
    scriptSuccess(env2, 'ready')
    const original = env2.transport.call.bind(env2.transport)
    let polls = 0
    ;(env2.transport as HerdrTransport).call = async (target, method, params) => {
      if (method === 'agent.prompt') assert.ok(polls >= 3, '实际输入前须确认 interactive_ready')
      const result = await original(target, method, params)
      if (['agent.start', 'agent.wait', 'agent.get'].includes(method)) {
        const response = result as { agent: Record<string, unknown> }
        if (method === 'agent.get') polls += 1
        if (polls < 3) {
          response.agent['agent_status'] = 'idle'
          response.agent['launch_pending'] = true
          delete response.agent['interactive_ready']
        }
      }
      return result
    }
    assert.equal(await spawnDirect(env2, { agentType: 'herdr:pi' }), 'ready')
    assert.equal(env2.transport.calls.filter((call) => call.method === 'agent.prompt').length, 1)
  } finally {
    await env2.close()
  }
})

test('resume 真实形状与全维度拒绝：standalone/workflow 无 agentType 续接、并发 pane_busy、跨轨/settled/cwd/kind 冲突与非 herdr 放行', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 1) standalone 无 agentId/agentType 续接 paneId，不重跑 agent.start；并发续接仅放行一个（另一方 pane_busy）。
    scriptSuccess(env, 'first-turn')
    await spawnDirect(env, { agentType: 'herdr:agy' })
    const soloPane = [...env.transport.panes.values()][0]!
    const startsBefore = env.transport.calls.filter((c) => c.method === 'agent.start').length
    const tabsBefore = env.transport.calls.filter((c) => c.method === 'tab.create').length
    scriptSuccess(env, 'resumed-turn')
    const concurrent = await Promise.allSettled([
      spawnDirect(env, { resume: soloPane.paneId }),
      spawnDirect(env, { resume: soloPane.paneId }),
    ])
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1)
    assert.equal((concurrent.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code, 'pane_busy')
    assert.equal(env.transport.calls.filter((c) => c.method === 'agent.start').length, startsBefore)
    assert.equal(env.transport.calls.filter((c) => c.method === 'tab.create').length, tabsBefore)

    // 2) workflow 无 agentType 续接、跨 workflow 轨道拒绝、settled 拒绝、cwd/kind 冲突拒绝。
    scriptSuccess(env, 'wf-first')
    await spawnDirect(env, { agentType: 'herdr:agy', agentId: 'run1:node-a', meta: { 'builtin:workflow': { runId: 'run1' } } })
    await assert.rejects(spawnDirect(env, { resume: 'run1:node-a' }), (e: unknown) => (e as HelmError).code === 'resume_workflow_mismatch')
    scriptSuccess(env, 'wf-second')
    assert.equal(
      await spawnDirect(env, { resume: 'run1:node-a', agentId: 'run1:node-a', meta: { 'builtin:workflow': { runId: 'run1' } }, prompt: 'continue' }),
      'wf-second',
    )
    await assert.rejects(
      spawnDirect(env, { resume: 'run1:node-a', meta: { 'builtin:workflow': { runId: 'run1' } }, cwd: '/tmp/other-cwd' }),
      (e: unknown) => (e as HelmError).code === 'resume_cwd_conflict',
    )
    await assert.rejects(
      spawnDirect(env, { resume: 'run1:node-a', meta: { 'builtin:workflow': { runId: 'run1' } }, agentType: 'herdr:claude' }),
      (e: unknown) => (e as HelmError).code === 'resume_kind_conflict',
    )
    for (const listener of env.backend.workflowListeners) {
      await listener({ id: 'run1', name: 'n', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2 })
    }
    await assert.rejects(
      spawnDirect(env, { resume: 'run1:node-a', meta: { 'builtin:workflow': { runId: 'run1' } } }),
      (e: unknown) => (e as HelmError).code === 'pane_settled',
    )

    // 3) 非 herdr 类型未知 resume 放行内核。
    const passthrough = await env.host.runHook('agent_spawn', {
      parentConversationId: 1,
      prompt: 'x',
      agentType: 'assistant',
      resume: '99',
    } as never)
    assert.notEqual(passthrough.action, 'handled')
  } finally {
    await env.close()
  }
})

test('启动对账精确归属（helm-wf-abc 不认领 helm-wf-abcde）、在途 working 报告与订阅 ack 失败释放监听器', { timeout: 60_000 }, async () => {
  // 1) 前缀相似非精确同名放弃所有权（settled），真正 working 保留并发送通知。
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-herdr-exact-'))
  const socketPath = join(dataDir, 'herdr.sock')
  const docs = new MemoryDocStore()
  docs.set('builtin:herdr:managed', {
    version: 1,
    panes: [
      { target: { socketPath }, routing: { kind: 'agy' }, paneId: 'w:p1', tabId: 'w:t1', effectiveCwd: '/tmp/a', agentName: 'helm-wf-abc', parentConversationId: 1, outcome: 'running', createdAt: 1 },
      { target: { socketPath }, routing: { kind: 'agy' }, paneId: 'w:p2', tabId: 'w:t2', effectiveCwd: '/tmp/b', agentName: 'helm-wf-busy', parentConversationId: 1, outcome: 'running', createdAt: 1 },
    ],
  })
  const transport = new FakeTransport()
  transport.panes.set('w:p1', { paneId: 'w:p1', tabId: 'w:t1', workspaceId: 'w', agentStatus: 'done', seq: 3, name: 'helm-wf-abcde', cwd: '/tmp/a' })
  transport.panes.set('w:p2', { paneId: 'w:p2', tabId: 'w:t2', workspaceId: 'w', agentStatus: 'working', seq: 3, name: 'helm-wf-busy', cwd: '/tmp/b' })
  transport.tabs.set('w:t1', { closed: false })
  transport.tabs.set('w:t2', { closed: false })
  const env = await makeEnv({ dataDir, socketPath, docs, transport })
  try {
    assert.equal(transport.tabs.get('w:t1')!.closed, false, '前缀相似但非精确同名不误关')
    assert.equal(transport.tabs.get('w:t2')!.closed, false, '真正 working 保留不伪装结束')
    assert.ok(env.backend.notifications.some((n) => n.title === 'Herdr startup reconciliation found in-flight panes'))
    const list = (await env.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ paneId: string; outcome: string }> }
    assert.equal(list.panes.find((p) => p.paneId === 'w:p1')!.outcome, 'settled')
  } finally {
    await env.close()
  }

  // 2) 订阅 ack 失败时释放已注册的 CAS resolver 与 workflow listener。
  const failTransport = new FakeTransport()
  failTransport.subscribeAck = 'fail'
  const failBackend = new FakeBackend()
  await assert.rejects(makeEnv({ transport: failTransport, backend: failBackend }))
  assert.equal(failBackend.askSeqResolvers.size, 0)
  assert.equal(failBackend.workflowListeners.size, 0)
})

test('交接与错误边界：结构化脱敏、md 非原子写自愈、I/O 故障释放 liveTasks、人类关窗即释放机密 env', { timeout: 60_000 }, async () => {
  // 1) 结构化 JSON 交接结果脱敏 + buildSpawnPaneEnv Stash 优先于 Profile。
  const env1 = await makeEnv()
  try {
    scriptSuccess(env1, JSON.stringify({ answer: 'SECRET-VALUE' }))
    const structured = await spawnDirect(env1, {
      agentType: 'herdr:pi',
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    })
    assert.deepEqual(structured, { answer: '[REDACTED]' })
    const { buildSpawnPaneEnv } = await import('../src/herdr/spawn-rules.js')
    assert.equal(
      buildSpawnPaneEnv({ SESSION_SECRET: 'from-stash' }, { SESSION_SECRET: 'from-profile' }, { remote: false }).env['SESSION_SECRET'],
      'from-stash',
    )
  } finally {
    await env1.close()
  }

  // 2) md 稳定性复检：非原子分段写触发一次自愈追问。
  const env2 = await makeEnv({ timingOverrides: { mdStableRecheckMs: 120 } })
  try {
    env2.transport.promptStatus = 'done'
    let prompts = 0
    let activeKey: string | undefined
    const origCall = env2.transport.call.bind(env2.transport)
    env2.transport.call = async (target, method, params) => {
      const res = await origCall(target, method, params)
      if (method === 'agent.prompt' && prompts === 1 && activeKey) {
        const targetKey = activeKey
        activeKey = undefined
        setTimeout(() => env2.transport.outputFiles.set(targetKey, 'partial-first-half + rest'), 35)
      }
      return res
    }
    env2.transport.onPrompt = (pane, text) => {
      prompts += 1
      const key = `${pane.cwd}/.helm/${fileNameOf(text)}`
      if (prompts === 1) {
        env2.transport.outputFiles.set(key, 'partial-first-half')
        activeKey = key
      } else {
        env2.transport.outputFiles.set(key, 'final-complete')
      }
    }
    assert.equal(await spawnDirect(env2, { agentType: 'herdr:pi' }), 'final-complete')
    assert.equal(prompts, 2)
  } finally {
    await env2.close()
  }

  // 3) 启动/输出路径越界失败释放 liveTasks 并保留 failed 现场。
  for (const failure of ['agent.start', 'readOutput'] as const) {
    const env3 = await makeEnv()
    try {
      scriptSuccess(env3, 'ok')
      if (failure === 'agent.start') {
        env3.transport.errors.set('agent.start', () => new HelmError('herdr_io', 'I/O broken', 502))
      } else {
        env3.transport.onPrompt = (pane) => {
          rmSync(join(pane.cwd, '.helm'), { recursive: true, force: true })
          writeFileSync(join(pane.cwd, '.helm'), 'not-a-directory')
        }
      }
      await assert.rejects(
        spawnDirect(env3, { agentType: 'herdr:pi' }),
        { code: failure === 'readOutput' ? 'herdr_output_escaping' : 'herdr_io' },
      )
      const list = (await env3.host.invokeAction('builtin:herdr', 'list', {})) as { panes: Array<{ outcome: string }> }
      assert.equal(list.panes[0]?.outcome, 'failed')
      await env3.host.disable('builtin:herdr')
      assert.equal([...env3.transport.tabs.values()].some((tab) => tab.closed), false)
    } finally {
      await env3.close()
    }
  }

  // 4) 人类关闭在途窗格后机密 env 立即释放：Gate 报 herdr_context_unavailable 不执行。
  const env4 = await makeEnv({ timingOverrides: { mdStableRecheckMs: 80 } })
  try {
    env4.transport.promptStatus = 'done'
    env4.transport.onPrompt = (pane, text) => {
      env4.transport.outputFiles.set(`${pane.cwd}/.helm/${fileNameOf(text)}`, 'gate-content')
      setTimeout(() => env4.transport.emit({ type: 'pane.closed', paneId: pane.paneId }), 15)
    }
    await assert.rejects(
      spawnDirect(env4, { agentType: 'herdr:pi', gate: 'echo ok' }),
      (e: unknown) => (e as HelmError).code === 'herdr_context_unavailable',
    )
    assert.equal(env4.gateLog.length, 0)
  } finally {
    await env4.close()
  }
})

test('清理纪律：settled 幂等、abort+settle 单飞、身份变化与人类 tab 保护、dispose 清理远端、workflow 批量逐项隔离', { timeout: 60_000 }, async () => {
  // 1) settled 幂等 + abort 与 turn_settled 并发单飞关闭。
  const env1 = await makeEnv()
  try {
    scriptSuccess(env1, 'idem-ok')
    await spawnDirect(env1, { agentType: 'herdr:agy' })
    await env1.host.runHook('turn_settled', turnSettledOf(1))
    const callsAfterFirst = env1.transport.calls.length
    await env1.host.runHook('turn_settled', turnSettledOf(1))
    assert.equal(env1.transport.calls.length, callsAfterFirst, 'settled 后重复清理零调用')

    env1.transport.promptStatus = 'blocked'
    const controller = new AbortController()
    const pending = spawnDirect(env1, { agentType: 'herdr:agy', signal: controller.signal })
    await waitFor(() => env1.backend.createdAsks.length === 1)
    const activePane = [...env1.transport.panes.values()].at(-1)!
    const closeBefore = env1.transport.calls.filter((c) => c.method === 'tab.close').length
    controller.abort()
    await env1.host.runHook('turn_settled', turnSettledOf(1))
    await assert.rejects(pending, (e: unknown) => (e as HelmError).code === 'aborted')
    await waitFor(() => env1.transport.tabs.get(activePane.tabId)?.closed === true)
    assert.equal(env1.transport.calls.filter((c) => c.method === 'tab.close').length - closeBefore, 1)
  } finally {
    await env1.close()
  }

  // 2) 结算前发现 agent 身份变化放弃关闭，且 worktree 只关自建 tab（不误关同 workspace 人类 tab）。
  for (const replaced of [false, true]) {
    const env2 = await makeEnv()
    try {
      scriptSuccess(env2, 'ok')
      await spawnDirect(env2, { agentType: 'herdr:pi', isolation: 'worktree' })
      const pane = [...env2.transport.panes.values()].find((p) => p.name !== undefined)!
      env2.transport.tabs.set(`${pane.workspaceId}:human-tab`, { closed: false })
      env2.transport.panes.set(`${pane.workspaceId}:human-pane`, {
        paneId: `${pane.workspaceId}:human-pane`,
        tabId: `${pane.workspaceId}:human-tab`,
        workspaceId: pane.workspaceId,
        agentStatus: 'idle',
        seq: 1,
        cwd: pane.cwd,
      })
      if (replaced) pane.name = 'human-agent'
      await env2.host.runHook('turn_settled', turnSettledOf(1))
      assert.equal(env2.transport.tabs.get(pane.tabId)?.closed, !replaced)
      assert.equal(env2.transport.tabs.get(`${pane.workspaceId}:human-tab`)?.closed, false)
      assert.equal(env2.transport.calls.some((call) => call.method === 'workspace.close'), false)
    } finally {
      await env2.close()
    }
  }

  // 3) dispose 清理远端可回收 pane。
  const env3 = await makeEnv()
  try {
    scriptSuccess(env3, 'remote-ok')
    await spawnDirect(env3, { agentType: 'herdr:agy@remote-node' })
    await assert.rejects(env3.host.disable('builtin:herdr'), (e: unknown) => (e as HelmError).code === 'plugin_has_live_tasks')
    await env3.host.dispose()
    assert.ok(env3.transport.calls.some((c) => c.method === 'tab.close' && c.target.nodeId === 'remote-node'))
  } finally {
    await env3.close()
  }

  // 4) workflow 批量清理逐项隔离：首项失败不中断其余清理，陈旧快照 failed 保留 failureNote。
  const docs = new MemoryDocStore()
  const env4 = await makeEnv({ docs })
  let releaseP1Get: (() => void) | undefined
  let releaseAsk: (() => void) | undefined
  try {
    scriptSuccess(env4, 'p1-ok')
    await spawnDirect(env4, { agentType: 'herdr:pi', meta: { 'builtin:workflow': { runId: 'wf_bulk' } } })
    scriptSuccess(env4, 'p2-ok')
    await spawnDirect(env4, { agentType: 'herdr:pi', meta: { 'builtin:workflow': { runId: 'wf_bulk' } } })
    let askEntered = false
    const askGate = new Promise<void>((resolve) => { releaseAsk = resolve })
    env4.backend.createAsk = async () => {
      askEntered = true
      await askGate
      throw new HelmError('ask_backend_broken', 'ask store down', 500)
    }
    env4.transport.promptStatus = 'blocked'
    const p3run = spawnDirect(env4, { agentType: 'herdr:pi', meta: { 'builtin:workflow': { runId: 'wf_bulk' } } }).catch((e: unknown) => e)
    await waitFor(() => askEntered)
    const [p1, p2, p3] = [...env4.transport.panes.values()]
    assert.ok(p1 && p2 && p3)
    let slowGetEntered = false
    const p1GetGate = new Promise<void>((resolve) => { releaseP1Get = resolve })
    const orig = env4.transport.call.bind(env4.transport)
    ;(env4.transport as HerdrTransport).call = async (target, method, params) => {
      if (method === 'agent.get' && String(params['target']) === p1.paneId) {
        slowGetEntered = true
        await p1GetGate
      }
      if (method === 'tab.close' && params['tab_id'] === p1.tabId) {
        throw new HelmError('tab_close_failed', 'boom', 500)
      }
      return orig(target, method, params)
    }
    const settled = (async () => {
      for (const listener of env4.backend.workflowListeners) {
        await listener({ id: 'wf_bulk', name: 'n', conversationId: 1, status: 'completed', createdAt: 1, updatedAt: 2 })
      }
    })()
    await waitFor(() => slowGetEntered)
    releaseAsk?.()
    assert.equal(((await p3run) as HelmError).code, 'ask_backend_broken')
    await waitFor(() => docs.get('builtin:herdr:managed', EMPTY_MANAGED_DOC).panes.some((p) => p.paneId === p3.paneId && p.outcome === 'failed'))
    releaseP1Get?.()
    await settled
    assert.equal(env4.transport.tabs.get(p2.tabId)!.closed, true)
    assert.equal(env4.transport.tabs.get(p1.tabId)!.closed, false)
    assert.equal(env4.transport.tabs.get(p3.tabId)!.closed, false)
    const p3row = docs.get('builtin:herdr:managed', EMPTY_MANAGED_DOC).panes.find((p) => p.paneId === p3.paneId)!
    assert.equal(p3row.outcome, 'failed')
    assert.ok(p3row.failureNote)
    assert.ok(env4.backend.notifications.some((n) => n.title === 'Herdr pane cleanup failed'))
  } finally {
    releaseAsk?.()
    releaseP1Get?.()
    await env4.close()
  }
})
