/**
 * 设计文档 §2.3 / §3.2 / §4.2-4.3 的 service/journal 侧核心测试：
 * - journal key v3（cwd 槽）与 agent 行 execution/gate 记录（校验 + 脱敏 + 每次尝试独立 index）；
 * - invokeSpawn 失败分支保留 executionInfo/gateResult、timeoutMs 单回合超时（自有
 *   AbortController + unref 计时器：TimeoutError reason、timedOut:true、返回前等完
 *   自己触发的守卫中止、成功出口撤销计时器）；
 * - RunRecord 完整体原子落 dataDir/artifacts/<convId>/workflow-<runId>.record.json，
 *   records doc 仅存轻量索引；resume 新 run 接管（resumedByRunId 防重复、
 *   autoResumeCount 累计、notifyParentOnSettle 继承；幽灵标记需四面无痕才可重接管）；
 * - 跨重启 resume：手工 seed 失败 attempt 行（attempt=1 + execution.conversationId，
 *   invocationIndex=0 前向兼容），resumeRef 直传 conversationId 字符串到
 *   AgentSpawnRequest.resume；
 * - prepare/init 读取损坏索引：显式 workflow_index_corrupt 拒绝且不修改任何记录；
 * - nodesFromProgress 长文本截断（1024 + 指示）与 gate.exitCode/timedOut 全链保留。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { HelmError } from '@helm/protocol'
import { deferred } from '@helm/test-kit'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { assertNoUnhandledRejection } from './helpers/plugin-test-env.js'
import {
  JournalWriter,
  agentJournalKey,
  readJournal,
  redactJournalEntry,
  type JournalWriteInput,
} from '../src/workflow/engine/journal.js'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/workflow/engine/service.js'
import type { WorkflowSpawnRequest, WorkflowSpawnResult } from '../src/workflow/engine/runtime.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// journal：key v3 cwd 槽 / agent 行 execution+gate / 脱敏
// ---------------------------------------------------------------------------

test('agentJournalKey v3：cwd 参与指纹，未提供时键值稳定', timeout, () => {
  const base = { prompt: 'p', label: 'l' }
  const withoutCwd = agentJournalKey(base)
  assert.equal(agentJournalKey({ ...base }), withoutCwd, '同输入同键（版本前缀稳定）')
  assert.notEqual(agentJournalKey({ ...base, cwd: '/repo/a' }), withoutCwd, 'cwd 变化即不同调用')
  assert.notEqual(agentJournalKey({ ...base, cwd: '/repo/b' }), agentJournalKey({ ...base, cwd: '/repo/a' }))
})

test('agent 行携带 execution/gate 落盘可回读，不触发 actionUncertain；损坏形状计 ioError', timeout, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-journal-v3-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const path = join(dir, 'workflow-wf_x.jsonl')
  const writer = new JournalWriter(path)
  await writer.append({
    type: 'agent',
    index: 0,
    key: 'k0', scopePath: 'root', scopeCallIndex: 0,
    ok: false,
    execution: { conversationId: 7, effectiveCwd: '/w', worktree: { path: '/w', branch: 'helm/spawn-x' } },
    gate: { ok: false, output: 'gate output', exitCode: null, timedOut: true },
  })
  // 每次重试独立 index：同 key 不同 index 各占一行，互不覆盖。
  await writer.append({ type: 'agent', index: 1, key: 'k1', scopePath: 'root', scopeCallIndex: 1, ok: true, text: 'ok' })
  await writer.close()
  const journal = readJournal(path)
  assert.equal(journal.actionUncertain, false)
  assert.equal(journal.ioErrors, 0)
  assert.equal(journal.entries.length, 2)
  const first = journal.entries[0] as Extract<(typeof journal.entries)[number], { type: 'agent' }>
  assert.equal(first.execution?.conversationId, 7)
  assert.equal(first.execution?.worktree?.branch, 'helm/spawn-x')
  assert.equal(first.gate?.timedOut, true)
  assert.equal(first.gate?.exitCode, null)

  // 非法 execution 形状：按 agent 損行计 ioError（不阻断重放），绝不明为 uncertain。
  const corruptPath = join(dir, 'workflow-wf_bad.jsonl')
  writeFileSync(
    corruptPath,
    `${JSON.stringify({ v: 1, seq: 0, type: 'agent', index: 0, key: 'k', scopePath: 'root', scopeCallIndex: 0, ok: true, execution: { conversationId: 'x' } })}\n`,
    'utf8',
  )
  const corrupt = readJournal(corruptPath)
  assert.equal(corrupt.ioErrors, 1, 'execution 形状非法按 agent 損行计数')
  assert.equal(corrupt.actionUncertain, false, 'agent 行损坏不冒充 action 不确定')
})

test('账本版本/序号损坏和相同 seq 的冲突记录不能掩盖已执行 action', timeout, (t) => {
  const env = makeEnv(t, async () => 'unused')
  const path = join(env.dataDir, 'journal-corrupt.jsonl')
  const agent = { v: 1, seq: 0, type: 'agent', index: 0, key: 'agent', scopePath: 'root', scopeCallIndex: 0, ok: true, text: 'done' }
  const action = { v: 1, seq: 0, type: 'action', index: 1, key: 'effect', scopePath: 'root', scopeCallIndex: 1, ok: true, result: 'sent' }
  for (const row of [
    { ...action, seq: -1 }, { ...action, v: 2 }, { ...action, seq: null },
    { ...action, scopePath: undefined }, { ...action, scopeCallIndex: -1 },
    { ...action, scopePath: 'outside/0' }, { ...action, scopePath: 'root/../1' },
  ]) {
    writeFileSync(path, `${JSON.stringify(row)}\n`)
    assert.equal(readJournal(path).actionUncertain, true)
  }
  writeFileSync(path, `${JSON.stringify(agent)}\n${JSON.stringify(action)}\n`)
  const conflict = readJournal(path)
  assert.equal(conflict.actionUncertain, true, '相同 seq 的冲突行不能通过去重丢掉 action')
  assert.equal(conflict.ioErrors, 1)
  writeFileSync(path, `${JSON.stringify(agent)}\n${JSON.stringify(agent)}\n`)
  const duplicate = readJournal(path)
  assert.equal(duplicate.actionUncertain, false)
  assert.equal(duplicate.entries.length, 1)
  const intent = { ...action, type: 'action_started', scopePath: 'root/0', scopeCallIndex: 0 }
  const otherScopeResult = { ...action, seq: 1, scopePath: 'root/1', scopeCallIndex: 0 }
  writeFileSync(path, `${JSON.stringify(intent)}\n${JSON.stringify(otherScopeResult)}\n`)
  assert.equal(readJournal(path).actionUncertain, true, '其他 scope 的终态不能掩盖悬挂的非幂等意图')
})

test('redactJournalEntry：text/execution/gate 逐值脱敏，action 行原样透传', timeout, () => {
  const redact = (text: string): string => text.replaceAll('sec', '***')
  const agentEntry: JournalWriteInput = {
    type: 'agent',
    index: 0,
    key: 'k', scopePath: 'root', scopeCallIndex: 0,
    ok: false,
    text: 'contains sec-ret',
    execution: { conversationId: 1, effectiveCwd: '/sec-dir', worktree: { path: '/sec-dir/wt', branch: 'b' } },
    gate: { ok: false, output: 'failed with sec' },
  }
  const redacted = redactJournalEntry(agentEntry, redact) as Extract<JournalWriteInput, { type: 'agent' }>
  assert.equal(redacted.text, 'contains ***-ret')
  assert.equal(redacted.execution?.effectiveCwd, '/***-dir')
  assert.equal(redacted.execution?.worktree?.path, '/***-dir/wt')
  assert.equal(redacted.gate?.output, 'failed with ***')
  // 原条目不被原地改写（纯函数）。
  const original = agentEntry as Extract<JournalWriteInput, { type: 'agent' }>
  assert.equal(original.text, 'contains sec-ret')
  const actionEntry: JournalWriteInput = { type: 'action', index: 1, key: 'a', scopePath: 'root', scopeCallIndex: 1, ok: true, result: { out: 'sec' } }
  assert.equal(redactJournalEntry(actionEntry, redact), actionEntry, 'action 行由引擎层处理，此处原样透传')
})

// ---------------------------------------------------------------------------
// service 测试环境
// ---------------------------------------------------------------------------

function makeParentSummary(id: number, cwd: string) {
  return {
    id, title: '测试父会话', profileId: 'assistant', tags: [], cwd,
    model: 'test/model', thinkingLevel: '', status: 'idle' as const, stateChangeSeq: 1, completionSeq: 0,
    unread: false, pinned: false, pendingAskCount: 0, createdAt: 0, updatedAt: 0,
  }
}

function makeEnv(
  t: TestContext,
  spawnAgent: WorkflowServiceHost['spawnAgent'],
  hostOverrides?: Partial<WorkflowServiceHost>,
  stateOverride?: WorkflowStateStore,
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-service-core-'))
  const docs = new Map<string, unknown>()
  const state: WorkflowStateStore = stateOverride ?? {
    get<T>(key: string, initial: T): T {
      return docs.has(key) ? (docs.get(key) as T) : initial
    },
    set(key, value) {
      docs.set(key, value)
    },
  }
  const guardedAborts: number[] = []
  const host: WorkflowServiceHost = {
    spawnAgent,
    async invokeAction() {
      throw new Error('此测试不调用动作')
    },
    listActions: () => [],
    getConversation: (id: number) => makeParentSummary(id, dataDir),
    async abortConversationGuarded(id: number) {
      guardedAborts.push(id)
    },
    emitEvent: () => {},
    ...hostOverrides,
  }
  const service = new WorkflowService({ dataDir, state, host })
  t.after(async () => {
    await service.close().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  })
  return { dataDir, docs, state, service, guardedAborts }
}

const recordPath = (dataDir: string, conversationId: number, runId: string) =>
  join(dataDir, 'artifacts', String(conversationId), `workflow-${runId}.record.json`)

const readRecordFile = (dataDir: string, conversationId: number, runId: string) =>
  JSON.parse(readFileSync(recordPath(dataDir, conversationId, runId), 'utf-8')) as Record<string, unknown>

// ---------------------------------------------------------------------------
// §4.3 records 瘦身：文件存完整体，records doc 仅轻量索引
// ---------------------------------------------------------------------------

test('run 完成后：record file存完整体，records doc 仅存轻量索引（无 nodes/result/script）', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const started = await env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "slim", description: "d" }\nreturn await agent("任务")',
  })
  await env.service.wait(started.id)
  assert.deepEqual([...env.docs.keys()], ['workflow/runs'], 'records doc 只剩唯一索引键')
  const index = env.docs.get('workflow/runs') as Array<Record<string, unknown>>
  assert.equal(index.length, 1)
  const entry = index[0]!
  assert.equal(entry['id'], started.id)
  assert.equal(entry['status'], 'completed')
  assert.equal(entry['conversationId'], 1)
  for (const heavy of ['nodes', 'result', 'script', 'progress', 'args']) {
    assert.equal(entry[heavy], undefined, `索引不得携带重量字段 ${heavy}`)
  }
  assert.ok(existsSync(recordPath(env.dataDir, 1, started.id)), '完整记录必须落文件')
  const fileRecord = readRecordFile(env.dataDir, 1, started.id)
  assert.equal(fileRecord['status'], 'completed')
  assert.equal(
    fileRecord['script'],
    'export const meta = { name: "slim", description: "d" }\nreturn await agent("任务")',
    '内联 script 存文件（索引不存）——文件是完整体',
  )
  assert.ok(Array.isArray(fileRecord['nodes']), 'nodes 存文件')
})

test('run 完成后跨重启可从文件读回摘要', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const started = await env.service.run({
    conversationId: 2,
    script: 'export const meta = { name: "revive", description: "d" }\nreturn await agent("任务")',
  })
  await env.service.wait(started.id)
  const docs2 = new Map<string, unknown>([['workflow/runs', structuredClone(env.docs.get('workflow/runs'))]])
  const host2: WorkflowServiceHost = {
    spawnAgent: async () => 'unused',
    invokeAction: async () => ({}),
    listActions: () => [],
    getConversation: () => makeParentSummary(2, env.dataDir),
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const revived = new WorkflowService({
    dataDir: env.dataDir,
    state: {
      get<T>(key: string, initial: T): T {
        return docs2.has(key) ? (docs2.get(key) as T) : initial
      },
      set(key, value) {
        docs2.set(key, value)
      },
    },
    host: host2,
  })
  try {
    const summary = revived.getRun(started.id)
    assert.equal(summary.status, 'completed')
    assert.equal(summary.nodes?.length, 1)
  } finally {
    await revived.close()
  }
})

// ---------------------------------------------------------------------------
// §3.2 resume 接管：resumedByRunId 防重复、autoResumeCount 累计、notify 继承
// ---------------------------------------------------------------------------

test('resumeFromRunId：新 run 接管原 run（resumedByRunId/autoResumeCount/notify 继承），重复 resume 409', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const first = await env.service.run(
    {
      conversationId: 3,
      script: 'export const meta = { name: "takeover", description: "d" }\nreturn await agent("任务")',
    },
    { notifyParentOnSettle: true },
  )
  await env.service.wait(first.id)
  const second = await env.service.run({ resumeFromRunId: first.id })
  await env.service.wait(second.id)
  // 原 run 被接管。
  const firstFile = readRecordFile(env.dataDir, 3, first.id)
  assert.equal(firstFile['resumedByRunId'], second.id)
  // 新 run 继承后台标记并累计续跑次数。
  const secondFile = readRecordFile(env.dataDir, 3, second.id)
  assert.equal(secondFile['notifyParentOnSettle'], true)
  assert.equal(secondFile['autoResumeCount'], 1)
  const index = env.docs.get('workflow/runs') as Array<Record<string, unknown>>
  assert.equal(index.find((e) => e['id'] === first.id)?.['resumedByRunId'], second.id, '索引同步接管标记')
  assert.equal(index.find((e) => e['id'] === second.id)?.['autoResumeCount'], 1, '索引同步续跑计数')
  // 防重复：同一源 run 二次 resume 显式 409。
  await assert.rejects(
    () => env.service.run({ resumeFromRunId: first.id }),
    (error: unknown) => error instanceof HelmError && error.code === 'conflict',
  )
})

// ---------------------------------------------------------------------------
// §4.3 nodesFromProgress 长文本截断
// ---------------------------------------------------------------------------

test('节点 prompt 超过 1024 字符时截断并附指示（完整内容在子会话/账本）', timeout, async (t) => {
  const env = makeEnv(t, async () => '结果')
  const longPrompt = 'x'.repeat(3000)
  const started = await env.service.run({
    conversationId: 4,
    script: `export const meta = { name: "trunc", description: "d" }\nreturn await agent(${JSON.stringify(longPrompt)})`,
  })
  await env.service.wait(started.id)
  const node = env.service.getRun(started.id).nodes![0]!
  assert.ok(node.prompt !== undefined)
  assert.ok(node.prompt!.length <= 1024 + '\n...[truncated, full content in conversation/journal]'.length)
  assert.ok(node.prompt!.endsWith('...[truncated, full content in conversation/journal]'))
})

// ---------------------------------------------------------------------------
// §2.3 invokeSpawn：失败保留 executionInfo/gate；§2.2 timeoutMs 守卫中止
// ---------------------------------------------------------------------------

/** 直接驱动私有 invokeSpawn（公开面要经 runtime，其扩展字段由并行分支接入）。 */
async function callInvokeSpawn(
  env: ReturnType<typeof makeEnv>,
  request: WorkflowSpawnRequest & { timeoutMs?: number },
): Promise<WorkflowSpawnResult> {
  const record = {
    id: 'wf_invoke00001',
    name: 'invoke',
    conversationId: 5,
    status: 'running' as const,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    journalPath: join(env.dataDir, 'artifacts', '5', 'workflow-wf_invoke00001.jsonl'),
  }
  const run = {
    runId: record.id,
    conversationId: 5,
    abort: new AbortController(),
    done: Promise.resolve(),
    summary: {},
    journalPath: record.journalPath,
    writer: new JournalWriter(record.journalPath),
    progress: [],
    timeline: [],
    pendingAborts: new Set<Promise<void>>(),
    pendingExecs: new Set<Promise<unknown>>(),
    childConversations: new Set<number>(),
    record,
    lastPersistAt: Date.now(),
    lastNodeEventAt: Date.now(),
  }
  const parent = makeParentSummary(5, env.dataDir)
  // invokeSpawn 为引擎私有接缝（公开面经 runtime），测试以受控私有调用直测。
  const service = env.service as unknown as {
    invokeSpawn(
      run: unknown,
      parent: unknown,
      map: Map<string, number>,
      request: WorkflowSpawnRequest,
      isResume: boolean,
    ): Promise<WorkflowSpawnResult>
  }
  return service.invokeSpawn(run, parent, new Map(), request, false)
}

test('invokeSpawn 失败分支保留 executionInfo 与 gate 回报（不丢弃 Worktree/会话坐标）', timeout, async (t) => {
  // 覆盖 host.spawnAgent：回传执行元数据与门禁结果后抛 gate_failed。
  const custom = makeEnv(t, async (proto: unknown) => {
    const request = proto as {
      onResolved?: (info: unknown) => void
      onGateResult?: (gate: unknown) => void
    }
    request.onResolved?.({ conversationId: 7, effectiveCwd: '/work/dir' })
    request.onGateResult?.({ ok: false, output: '门禁输出' })
    throw new HelmError('gate_failed', '门禁失败', 502)
  })
  const result = await callInvokeSpawn(custom, {
    agentId: 'a',
    index: 0,
    prompt: 'p',
    label: 'worker',
    agentType: '',
    gate: 'test -n x',
  })
  assert.equal(result.ok, false)
  assert.ok(result.error!.includes('[gate_failed]'))
  assert.equal(result.executionInfo?.conversationId, 7, '失败分支必须保留 executionInfo')
  assert.equal(result.executionInfo?.effectiveCwd, '/work/dir')
  assert.equal(result.gate?.ok, false, '失败分支必须保留 gate 回报')
  assert.equal(result.gate?.output, '门禁输出')
  await custom.service.close()
})

test('invokeSpawn timeoutMs：超时守卫中止子会话并返回 [agent_timeout]（保留 executionInfo；signal.reason 为 TimeoutError；timedOut=true）', timeout, async (t) => {
  let observedReason: unknown
  const custom = makeEnv(t, (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
    request.onResolved?.({ conversationId: 9, effectiveCwd: '/hang/dir' })
    request.signal?.addEventListener('abort', () => {
      observedReason = request.signal?.reason
    })
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new HelmError('aborted', '回合中止', 409)), { once: true })
    })
  })
  const result = await callInvokeSpawn(custom, {
    agentId: 'b',
    index: 0,
    prompt: 'p',
    label: 'hang',
    agentType: '',
    timeoutMs: 1_000,
  })
  assert.equal(result.ok, false)
  assert.ok(result.error!.includes('[agent_timeout]'), `错误应含超时锚点：${result.error}`)
  assert.equal(result.timedOut, true, '超时失败必须携带 timedOut: true 供引擎记账')
  assert.equal(result.executionInfo?.conversationId, 9, '超时失败保留 executionInfo 供 resume')
  assert.deepEqual(custom.guardedAborts, [9], '超时必须守卫中止子会话')
  const reason = observedReason as { name?: string } | undefined
  assert.equal(reason?.name, 'TimeoutError', `signal.reason.name 必须是 TimeoutError（Herdr 识别锚点）：${String(observedReason)}`)
})

test('invokeSpawn 超时：返回前等完自己触发的守卫中止（后续 resume 不撞在途 abort）', timeout, async (t) => {
  const abortEntered = deferred()
  const abortGate = deferred()
  const custom = makeEnv(
    t,
    (proto: unknown) => {
      const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
      request.onResolved?.({ conversationId: 12 })
      return new Promise((_resolve, reject) => {
        request.signal?.addEventListener('abort', () => reject(new HelmError('aborted', '回合中止', 409)), { once: true })
      })
    },
    {
      abortConversationGuarded: async (id: number) => {
        custom.guardedAborts.push(id)
        abortEntered.resolve()
        await abortGate.promise
      },
    },
  )
  let settled = false
  const pending = callInvokeSpawn(custom, {
    agentId: 'slow-abort',
    index: 0,
    prompt: 'p',
    label: 'slow',
    agentType: '',
    timeoutMs: 1_000,
  }).then((result) => {
    settled = true
    return result
  })
  await Promise.race([
    abortEntered.promise,
    pending.then(() => assert.fail('spawn settled before starting the guarded abort')),
  ])
  try {
    // Flush the continuations that would settle spawn if it did not await the guarded abort.
    await nextTurn()
    assert.equal(settled, false, '自己触发的守卫中止完成前不得返回（防 resume 撞忙）')
  } finally {
    abortGate.resolve()
  }
  const result = await pending
  assert.equal(result.timedOut, true)
  assert.deepEqual(custom.guardedAborts, [12])
})

test('invokeSpawn 成功返回后撤销超时计时器：旧 attempt 迟到超时不误伤同会话新 attempt', timeout, async (t) => {
  const custom = makeEnv(t, async (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void }
    request.onResolved?.({ conversationId: 31 })
    return 'quick'
  })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const result = await callInvokeSpawn(custom, {
    agentId: 'e',
    index: 0,
    prompt: 'p',
    label: 'quick',
    agentType: '',
    timeoutMs: 1_000,
  })
  assert.equal(result.ok, true)
  assert.equal(result.timedOut, undefined)
  // 等待越过 timeoutMs：旧 attempt 的计时器必须已被成功出口撤销，绝不
  // 迟到触发守卫中止（同会话可能已被新 attempt 续接）。
  t.mock.timers.tick(1_000)
  await nextTurn()
  assert.deepEqual(custom.guardedAborts, [], '成功出口后不得有迟到超时中止')
})

test('外部回合超时保留执行方诊断，不宣称底层进程已停止', timeout, async (t) => {
  const custom = makeEnv(t, (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
    request.onResolved?.({ nodeId: 'local', executionId: 'pane-timeout' })
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => reject(new HelmError(
        'agent_timeout', '底层 CLI 可能仍在执行\n终端最后 40 行（脱敏）：\nworking at task', 408,
      )), { once: true })
    })
  })
  const result = await callInvokeSpawn(custom, {
    agentId: 'external-timeout', index: 0, prompt: 'p', label: 'external', agentType: '', timeoutMs: 1_000,
  })
  assert.equal(result.ok, false)
  assert.equal(result.timedOut, true)
  assert.equal(result.executionInfo?.executionId, 'pane-timeout')
  assert.match(result.error ?? '', /底层 CLI 可能仍在执行/)
  assert.match(result.error ?? '', /终端最后 40 行/)
  assert.doesNotMatch(result.error ?? '', /已中止子会话/)
  assert.deepEqual(custom.guardedAborts, [])
})

test('invokeSpawn timeoutMs 非法值在边界显式拒绝（1_000..3_600_000）', timeout, async (t) => {
  const custom = makeEnv(t, async () => 'unused')
  await assert.rejects(
    () =>
      callInvokeSpawn(custom, {
        agentId: 'c',
        index: 0,
        prompt: 'p',
        label: 'bad',
        agentType: '',
        timeoutMs: 100,
      }),
    (error: unknown) => error instanceof HelmError && error.code === 'validation_error',
  )
})

// ---------------------------------------------------------------------------
// 跨重启 resume：手工 seed 失败 attempt 行，resumeRef 直传 conversationId
// ---------------------------------------------------------------------------

/** 手工构造持久事实（record file + 轻量索引 + 账本），与 writeRecord 现行契约同形。 */
function seedPersistedRun(
  dataDir: string,
  docs: Map<string, unknown>,
  spec: {
    runId: string
    conversationId: number
    status: 'running' | 'completed' | 'failed' | 'aborted'
    createdAt?: number
    updatedAt?: number
    script?: string
    error?: string
    kind?: 'workflow' | 'subagent'
    notifyParentOnSettle?: boolean
    childConversationIds?: number[]
    resumedByRunId?: string
    journal?: string[]
  },
): { journalPath: string; recordFile: string } {
  const dir = join(dataDir, 'artifacts', String(spec.conversationId))
  mkdirSync(dir, { recursive: true })
  const journalPath = join(dir, `workflow-${spec.runId}.jsonl`)
  const recordFile = join(dir, `workflow-${spec.runId}.record.json`)
  const createdAt = spec.createdAt ?? 1_000
  const updatedAt = spec.updatedAt ?? 2_000
  writeFileSync(
    recordFile,
    JSON.stringify({
      id: spec.runId,
      name: 'seeded',
      conversationId: spec.conversationId,
      status: spec.status,
      createdAt,
      updatedAt,
      ...(spec.error !== undefined ? { error: spec.error } : {}),
      ...(spec.script !== undefined ? { script: spec.script } : {}),
      ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
      ...(spec.notifyParentOnSettle !== undefined ? { notifyParentOnSettle: spec.notifyParentOnSettle } : {}),
      ...(spec.childConversationIds !== undefined ? { childConversationIds: spec.childConversationIds } : {}),
      ...(spec.resumedByRunId !== undefined ? { resumedByRunId: spec.resumedByRunId } : {}),
      journalPath,
    }),
    'utf8',
  )
  writeFileSync(journalPath, `${(spec.journal ?? []).join('\n')}${(spec.journal ?? []).length > 0 ? '\n' : ''}`, 'utf8')
  const index = (docs.get('workflow/runs') ?? []) as Array<Record<string, unknown>>
  index.push({
    id: spec.runId,
    conversationId: spec.conversationId,
    status: spec.status,
    createdAt,
    updatedAt,
    ...(spec.notifyParentOnSettle !== undefined ? { notifyParentOnSettle: spec.notifyParentOnSettle } : {}),
    ...(spec.resumedByRunId !== undefined ? { resumedByRunId: spec.resumedByRunId } : {}),
  })
  docs.set('workflow/runs', index)
  return { journalPath, recordFile }
}

function stateOver(docs: Map<string, unknown>): WorkflowStateStore {
  return {
    get<T>(key: string, initial: T): T {
      return docs.has(key) ? (docs.get(key) as T) : initial
    },
    set(key: string, value: unknown) {
      docs.set(key, value)
    },
  }
}

test('跨重启 resume：失败 attempt 行的 execution.conversationId 经 resumeRef 直传 AgentSpawnRequest.resume（不拼 runId）', timeout, async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-restart-resume-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const convId = 9
  const priorRunId = 'wf_seedfail0001'
  const prompt = '跨重启续接任务'
  // 手工 seed 失败 attempt 行：attempt=1 + execution.conversationId=77（无
  // executionId → persistedHandle=String(77)）；invocationIndex=0 为账本新增
  // 可选字段（agentJournalKey 不含该字段，键值稳定）。maxAttempts=2 时
  // attempt 1 失败已入账，第 2 次必须经 resume 续接，不能提前返回失败。
  const docs = new Map<string, unknown>()
  seedPersistedRun(dataDir, docs, {
    runId: priorRunId,
    conversationId: convId,
    status: 'failed',
    error: '[agent_failed] 尝试失败',
    script: `export const meta = { name: "restart-resume", description: "d" }\nreturn await agent(${JSON.stringify(prompt)}, { maxAttempts: 2 })`,
    journal: [
      JSON.stringify({
        v: 1,
        seq: 0,
        type: 'agent',
        index: 0,
        key: agentJournalKey({ prompt }), scopePath: 'root', scopeCallIndex: 0,
        ok: false,
        attempt: 1,
        error: '[agent_failed] 尝试失败',
        invocationIndex: 0,
        execution: { conversationId: 77 },
      }),
    ],
  })
  const spawns: Array<{ resume?: string; agentId?: string }> = []
  const host: WorkflowServiceHost = {
    spawnAgent: async (request) => {
      spawns.push({ resume: request.resume, agentId: request.agentId })
      return 'retry-ok'
    },
    invokeAction: async () => {
      throw new Error('本测试不调用动作')
    },
    listActions: () => [],
    getConversation: (id: number) => makeParentSummary(id, dataDir),
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const revived = new WorkflowService({ dataDir, state: stateOver(docs), host })
  try {
    const summary = await revived.run({ resumeFromRunId: priorRunId })
    await revived.wait(summary.id)
    assert.equal(revived.getRun(summary.id).status, 'completed')
    assert.equal(spawns.length, 1, '重放后仅一次续接 spawn')
    assert.equal(spawns[0]!.resume, '77', 'resumeRef 直传 conversationId 字符串到 resume，不拼 runId 前缀')
    assert.ok(spawns[0]!.agentId!.includes(':'), '原生 agentId 仍带 runId 命名空间（与 resume 字段互不干扰）')
  } finally {
    await revived.close()
  }
})

// ---------------------------------------------------------------------------
// prepare/init 读取损坏索引：显式拒绝且不修改任何记录
// ---------------------------------------------------------------------------

test('prepare/init 读取损坏索引：显式 workflow_index_corrupt 拒绝，且不修改记录/索引', timeout, async (t) => {
  const env = makeEnv(t, async () => 'unused')
  const record = {
    id: 'wf_idxcrash001',
    name: 'idx-crash',
    conversationId: 21,
    status: 'running',
    createdAt: 1,
    updatedAt: 2,
    kind: 'subagent' as const,
    journalPath: join(env.dataDir, 'artifacts', '21', 'workflow-wf_idxcrash001.jsonl'),
    notifyParentOnSettle: true,
    childConversationIds: [88],
  }
  seedPersistedRun(env.dataDir, env.docs, {
    runId: record.id,
    conversationId: 21,
    status: 'running',
    kind: 'subagent',
    notifyParentOnSettle: true,
    childConversationIds: [88],
  })
  // 损坏注入：索引变非数组（恢复屏障必须先于任何记录读取/修改显式拒绝）。
  env.docs.set('workflow/runs', { not: 'an-array' })
  await assert.rejects(
    () => env.service.prepareRecovery(),
    (error: unknown) => error instanceof HelmError && error.code === 'workflow_index_corrupt',
  )
  await assert.rejects(
    () => env.service.init(),
    (error: unknown) => error instanceof HelmError && error.code === 'workflow_index_corrupt',
  )
  // 拒绝必须发生在任何记录修改之前：记录保持 running 原样、索引保持损坏
  // 原样（绝不静默重建/剪枝）、子会话未被守卫中止（屏障未越过索引读取）。
  const after = JSON.parse(readFileSync(join(env.dataDir, 'artifacts', '21', 'workflow-wf_idxcrash001.record.json'), 'utf-8')) as { status: string }
  assert.equal(after.status, 'running', '记录不得被改终态')
  assert.deepEqual(env.docs.get('workflow/runs'), { not: 'an-array' }, '索引不得被静默重建')
  assert.deepEqual(env.guardedAborts, [], '损坏索引下不得触发任何子会话中止')
})

// ---------------------------------------------------------------------------
// 幽灵接管标记（run 入口）：四面无痕才可重接管；磁盘仍有痕迹保持 409
// ---------------------------------------------------------------------------

test('resume 幽灵接管标记：索引与磁盘均无痕迹才清标记重接管；磁盘仍有记录/账本保持 409', timeout, async (t) => {
  const env = makeEnv(t, async () => 'ghost-resume-result')
  const script = 'export const meta = { name: "orphan", description: "d" }\nreturn 41'
  // 真幽灵：接管 run 从未写任何记录/账本（索引无、磁盘无文件）。
  seedPersistedRun(env.dataDir, env.docs, {
    runId: 'wf_orphanA0001',
    conversationId: 23,
    status: 'failed',
    error: '[agent_failed] 失败',
    script,
    resumedByRunId: 'wf_vanish9999',
    journal: [],
  })
  const resumed = await env.service.run({ resumeFromRunId: 'wf_orphanA0001' })
  await env.service.wait(resumed.id)
  assert.equal(env.service.getRun(resumed.id).result, 41)
  const markerFile = JSON.parse(
    readFileSync(join(env.dataDir, 'artifacts', '23', 'workflow-wf_orphanA0001.record.json'), 'utf-8'),
  ) as { resumedByRunId?: string }
  assert.equal(markerFile.resumedByRunId, resumed.id, '真幽灵标记被新接管取代')

  // 索引缺失但磁盘仍有账本文件：保持 409（防重复副作用）。
  seedPersistedRun(env.dataDir, env.docs, {
    runId: 'wf_orphanB0002',
    conversationId: 23,
    status: 'failed',
    error: '[agent_failed] 失败',
    script,
    resumedByRunId: 'wf_keptj9998',
    journal: [],
  })
  writeFileSync(
    join(env.dataDir, 'artifacts', '23', 'workflow-wf_keptj9998.jsonl'),
    `${JSON.stringify({ v: 1, seq: 0, type: 'agent', index: 0, key: 'k', scopePath: 'root', scopeCallIndex: 0, ok: true, text: 'x' })}\n`,
    'utf8',
  )
  await assert.rejects(
    () => env.service.run({ resumeFromRunId: 'wf_orphanB0002' }),
    (error: unknown) =>
      error instanceof HelmError &&
      error.code === 'conflict' &&
      (error.details as { resumedByRunId?: string }).resumedByRunId === 'wf_keptj9998',
  )

  // 索引缺失但磁盘仍有record file：同样保持 409。
  seedPersistedRun(env.dataDir, env.docs, {
    runId: 'wf_orphanC0003',
    conversationId: 23,
    status: 'failed',
    error: '[agent_failed] 失败',
    script,
    resumedByRunId: 'wf_keptr9997',
    journal: [],
  })
  writeFileSync(
    join(env.dataDir, 'artifacts', '23', 'workflow-wf_keptr9997.record.json'),
    JSON.stringify({
      id: 'wf_keptr9997',
      name: 'taken',
      conversationId: 23,
      status: 'completed',
      createdAt: 0,
      updatedAt: 0,
      journalPath: join(env.dataDir, 'artifacts', '23', 'workflow-wf_keptr9997.jsonl'),
    }),
    'utf8',
  )
  await assert.rejects(
    () => env.service.run({ resumeFromRunId: 'wf_orphanC0003' }),
    (error: unknown) =>
      error instanceof HelmError &&
      error.code === 'conflict' &&
      (error.details as { resumedByRunId?: string }).resumedByRunId === 'wf_keptr9997',
  )
})

test('接管账本为失效符号链接时仍保留接管标记，不能当成从未运行', timeout, async (t) => {
  if (process.platform === 'win32') {
    t.skip('Windows 创建符号链接需要额外权限；此用例验证 POSIX 失效链接')
    return
  }
  const env = makeEnv(t, async () => 'unused')
  const takeoverRunId = 'wf_linktarget001'
  seedPersistedRun(env.dataDir, env.docs, {
    runId: 'wf_linkprior001', conversationId: 23, status: 'failed',
    script: 'export const meta = { name: "link-marker", description: "d" }\nreturn 41',
    resumedByRunId: takeoverRunId,
  })
  symlinkSync(join(env.dataDir, 'missing-journal'), join(env.dataDir, 'artifacts', '23', `workflow-${takeoverRunId}.jsonl`))
  await assert.rejects(
    () => env.service.run({ resumeFromRunId: 'wf_linkprior001' }),
    (error: unknown) => error instanceof HelmError && error.code === 'conflict',
  )
})

test('resume 并发防双接管：标记已落盘、新 run 快照未落盘窗口内第二个 resume 409', timeout, async (t) => {
  const env = makeEnv(t, async () => 'conc-resume-result')
  const script = 'export const meta = { name: "conc", description: "d" }\nreturn 7'
  seedPersistedRun(env.dataDir, env.docs, {
    runId: 'wf_conc0000001',
    conversationId: 25,
    status: 'failed',
    error: '[agent_failed] 失败',
    script,
    journal: [],
  })
  // flush 门：把第一个 resume 挂在「标记已落盘、快照未落盘」窗口内。
  let releaseFlush: (() => void) | undefined
  const flushGate = new Promise<void>((resolve) => {
    releaseFlush = resolve
  })
  env.state.flush = async () => {
    await flushGate
  }
  const first = env.service.run({ resumeFromRunId: 'wf_conc0000001' })
  await new Promise((resolve) => setTimeout(resolve, 50))
  // 窗口内：旧 record 的接管标记已写盘，新 run 快照未落——第二个并发
  // resume 必须被进程内接管保留拦下（四面检查会误判幽灵）。
  await assert.rejects(
    () => env.service.run({ resumeFromRunId: 'wf_conc0000001' }),
    (error: unknown) =>
      error instanceof HelmError && error.code === 'conflict',
    '并发启动窗口内不得误判幽灵清标记（防双接管）',
  )
  releaseFlush!()
  const summary = await first
  await env.service.wait(summary.id)
  assert.equal(env.service.getRun(summary.id).result, 7, '第一个 resume 正常完成')
  const marker = JSON.parse(
    readFileSync(join(env.dataDir, 'artifacts', '25', 'workflow-wf_conc0000001.record.json'), 'utf-8'),
  ) as { resumedByRunId?: string }
  assert.equal(marker.resumedByRunId, summary.id, '接管标记指向第一个（唯一）新 run')
})

// ---------------------------------------------------------------------------
// gate.exitCode/timedOut 全链保留（折叠/脱敏/后台子代理）
// ---------------------------------------------------------------------------

test('节点 gate.exitCode/timedOut 全链保留（进度折叠与脱敏不丢诊断字段）', timeout, async (t) => {
  const env = makeEnv(
    t,
    async (proto: unknown) => {
      const request = proto as {
        onResolved?: (info: unknown) => void
        onGateResult?: (gate: unknown) => void
      }
      request.onResolved?.({ conversationId: 41 })
      request.onGateResult?.({ ok: false, output: 'gate 失败输出', exitCode: 3, timedOut: true })
      throw new HelmError('gate_failed', '门禁失败', 502)
    },
    { runGate: async () => ({ ok: true, output: 'host-gate' }) },
  )
  const started = await env.service.run({
    conversationId: 13,
    script:
      'export const meta = { name: "gate-diag", description: "d" }\nreturn await agent("gated task", { gate: "true", maxAttempts: 1 })',
  })
  await env.service.wait(started.id)
  const node = env.service.getRun(started.id).nodes![0]!
  assert.equal(node.gate?.ok, false)
  assert.equal(node.gate?.exitCode, 3, 'exitCode 必须保留（脱敏不丢诊断字段）')
  assert.equal(node.gate?.timedOut, true, 'timedOut 必须保留')
  const persisted = readRecordFile(env.dataDir, 13, started.id) as {
    nodes?: Array<{ gate?: { exitCode?: number | null; timedOut?: boolean } }>
  }
  assert.equal(persisted.nodes![0]!.gate!.exitCode, 3, '持久记录同样保留 exitCode')
  assert.equal(persisted.nodes![0]!.gate!.timedOut, true, '持久记录同样保留 timedOut')
})

test('startBackgroundAgent 节点 gate.exitCode/timedOut 保留（onGateResult 构建即不丢）', timeout, async (t) => {
  const env = makeEnv(t, async (proto: unknown) => {
    const request = proto as {
      onResolved?: (info: unknown) => void
      onGateResult?: (gate: unknown) => void
    }
    request.onResolved?.({ conversationId: 51 })
    request.onGateResult?.({ ok: false, output: 'bg gate 失败', exitCode: 2, timedOut: true })
    return 'bg-done'
  })
  const { run } = await env.service.startBackgroundAgent({
    parentConversationId: 14,
    prompt: '后台任务',
    gate: 'true',
  })
  await env.service.wait(run.id)
  const node = env.service.getRun(run.id).nodes![0]!
  assert.equal(node.gate?.ok, false)
  assert.equal(node.gate?.exitCode, 2)
  assert.equal(node.gate?.timedOut, true)
})

test('startWorkflowRun 命名优先级与 label 边界校验，及 invokeAgentSpawn title 透传（fresh 传、resume 不传）', timeout, async (t) => {
  const spawns: Array<Record<string, unknown>> = []
  const env = makeEnv(t, async (proto: unknown) => {
    const req = proto as Record<string, unknown> & { onResolved?: (info: unknown) => void }
    spawns.push(req)
    req.onResolved?.({ conversationId: 61 })
    return 'agent-out'
  })

  // 1. label 边界校验：非字符串 / 空白拒绝
  await assert.rejects(
    () => env.service.run({ conversationId: 1, script: 'export const meta = { name: "m", description: "d" }\nreturn 1', label: '   ' }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
  )
  await assert.rejects(
    () => env.service.run({ conversationId: 1, script: 'export const meta = { name: "m", description: "d" }\nreturn 1', label: 123 as unknown as string }),
    (err: unknown) => err instanceof HelmError && err.code === 'validation_error',
  )

  // 2. 优先级：trimmed request.label > meta.name；fresh agent() 传 title，resume 不传
  const rLabel = await env.service.run({
    conversationId: 1,
    label: '  覆盖标题  ',
    script:
      'export const meta = { name: "meta-name", description: "d" }\n' +
      'const first = await agent("step1", { label: "worker-alpha" })\n' +
      'const second = await agent("step2", { resume: "worker-alpha" })\n' +
      'return { first, second }',
  })
  assert.equal(rLabel.name, '覆盖标题')
  await env.service.wait(rLabel.id)
  assert.equal(spawns.length, 2)
  assert.equal(spawns[0]!['title'], 'worker-alpha', 'fresh agent() 应透传 label 作为 title')
  assert.equal(spawns[1]!['title'], undefined, 'resume agent() 不得覆写 title')

  // 3. scriptPath 无可提取 meta.name 时，使用 basename（去 .js）
  const scriptFile = join(env.dataDir, 'custom-file-name.js')
  writeFileSync(scriptFile, 'return 99', 'utf8')
  const rScriptPath = await env.service.run({ conversationId: 1, scriptPath: scriptFile })
  assert.equal(rScriptPath.name, 'custom-file-name')
  await env.service.wait(rScriptPath.id)
})

// ---------------------------------------------------------------------------
// 并发注册时序 / 停机屏障 / emitEvent 收口
// ---------------------------------------------------------------------------

function makeGatedSnapshotStore(): {
  store: WorkflowStateStore
  capturedRunId(): string
  release(): void
} {
  const map = new Map<string, unknown>()
  let release: () => void = () => {}
  const released = new Promise<void>((resolve) => {
    release = resolve
  })
  let firstFlush = true
  let runId = ''
  return {
    capturedRunId: () => runId,
    release,
    store: {
      get<T>(key: string, initial: T): T {
        return (map.get(key) as T | undefined) ?? initial
      },
      set(key, value) {
        if (runId === '' && key === 'workflow/runs' && Array.isArray(value)) {
          const last = (value as Array<{ id?: string }>)[value.length - 1]
          if (typeof last?.id === 'string') runId = last.id
        }
        map.set(key, value)
      },
      async flush() {
        if (firstFlush) {
          firstFlush = false
          await released
        }
      },
    },
  }
}

async function assertPending(promise: Promise<unknown>, ms: number): Promise<void> {
  const outcome = await Promise.race([
    promise.then(() => 'settled', () => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), ms)),
  ])
  assert.equal(outcome, 'pending', '窗口期内不得提前返回（占位 done 会假完成）')
}

test('run 注册时序：启动窗口内 wait() 不得假返回，放行 running 快照后才拿真实结果', timeout, async (t) => {
  const gated = makeGatedSnapshotStore()
  const env = makeEnv(t, async () => 'ok', undefined, gated.store)
  const runPromise = env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "wait-gate", description: "test" }\nreturn 42',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const runId = gated.capturedRunId()
  assert.ok(runId !== '', 'runId 应已随 running 快照写入可捕获')

  const waitPromise = env.service.wait(runId)
  await assertPending(waitPromise, 80)

  gated.release()
  const summary = await runPromise
  assert.equal(summary.status, 'running')
  assert.equal(await waitPromise, 42, '放行后 wait 拿到真实结果（非占位 undefined）')
  assert.equal(env.service.getRun(runId).status, 'completed')
})

test('run 注册时序：启动窗口内 abort() 返回时 run 必已终态（契约与 wait 同一 done 通道）', timeout, async (t) => {
  const gated = makeGatedSnapshotStore()
  const env = makeEnv(t, async () => 'ok', undefined, gated.store)
  const runPromise = env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "abort-gate", description: "test" }\nreturn 7',
  })
  await new Promise((resolve) => setTimeout(resolve, 20))
  const runId = gated.capturedRunId()
  assert.ok(runId !== '')

  const abortPromise = env.service.abort(runId)
  await assertPending(abortPromise, 80)

  gated.release()
  await runPromise
  await abortPromise
  const final = env.service.getRun(runId)
  assert.notEqual(final.status, 'running', 'abort 返回时 run 必已终态')
  assert.equal(final.status, 'aborted')
})

test('停机屏障：init 完成后、active.set 前复查 closed，close 与 run 启动并发时越障启动显式拒绝', timeout, async (t) => {
  const env = makeEnv(t, async () => 'ok')
  const runPromise = env.service.run({
    conversationId: 1,
    script: 'export const meta = { name: "closed-race", description: "test" }\nreturn 1',
  })
  const rejection = assert.rejects(runPromise, (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'closed')
    return true
  })
  await env.service.close()
  await rejection
})

test('emitEvent 收口：宿主适配器 async 抛错时 run 生命周期不受影响且不产生 unhandledRejection', timeout, async (t) => {
  const env = makeEnv(t, async () => 'ok', {
    emitEvent: async () => {
      throw new HelmError('workflow_index_corrupt', '读取工作流 run 索引失败（模拟）', 500)
    },
  })
  await assertNoUnhandledRejection(async () => {
    const summary = await env.service.run({
      conversationId: 1,
      script: 'export const meta = { name: "emit-safe", description: "test" }\nreturn 5',
    })
    assert.equal(await env.service.wait(summary.id), 5, '事件观察面故障不得影响 run 结果')
    assert.equal(env.service.getRun(summary.id).status, 'completed')
  })
})
