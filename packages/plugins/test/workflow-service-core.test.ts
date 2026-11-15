/**
 * 设计文档 §2.3 / §3.2 / §4.2-4.3 的 service/journal 侧核心测试：
 * - journal key v3（cwd 槽）与 agent 行 execution/gate 记录（校验 + 脱敏 + 每次尝试独立 index）；
 * - invokeSpawn 失败分支保留 executionInfo/gateResult、timeoutMs 超时守卫中止子会话；
 * - RunRecord 完整体原子落 dataDir/artifacts/<convId>/workflow-<runId>.record.json，
 *   records doc 仅存轻量索引；resume 新 run 接管（resumedByRunId 防重复、
 *   autoResumeCount 累计、notifyParentOnSettle 继承）；
 * - nodesFromProgress 长文本截断（1024 + 指示）。
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { HelmError } from '@helm/protocol'
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
    key: 'k0',
    ok: false,
    execution: { conversationId: 7, effectiveCwd: '/w', worktree: { path: '/w', branch: 'helm/spawn-x' } },
    gate: { ok: false, output: 'gate output', exitCode: null, timedOut: true },
  })
  // 每次重试独立 index：同 key 不同 index 各占一行，互不覆盖。
  await writer.append({ type: 'agent', index: 1, key: 'k1', ok: true, text: 'ok' })
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
    `${JSON.stringify({ v: 1, seq: 0, type: 'agent', index: 0, key: 'k', ok: true, execution: { conversationId: 'x' } })}\n`,
    'utf8',
  )
  const corrupt = readJournal(corruptPath)
  assert.equal(corrupt.ioErrors, 1, 'execution 形状非法按 agent 損行计数')
  assert.equal(corrupt.actionUncertain, false, 'agent 行损坏不冒充 action 不确定')
})

test('redactJournalEntry：text/execution/gate 逐值脱敏，action 行原样透传', timeout, () => {
  const redact = (text: string): string => text.replaceAll('sec', '***')
  const agentEntry: JournalWriteInput = {
    type: 'agent',
    index: 0,
    key: 'k',
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
  const actionEntry: JournalWriteInput = { type: 'action', index: 1, key: 'a', ok: true, result: { out: 'sec' } }
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

function makeEnv(t: TestContext, spawnAgent: WorkflowServiceHost['spawnAgent'], hostOverrides?: Partial<WorkflowServiceHost>) {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-service-core-'))
  const docs = new Map<string, unknown>()
  const state: WorkflowStateStore = {
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

test('run 完成后：记录文件存完整体，records doc 仅存轻量索引（无 nodes/result/script）', timeout, async (t) => {
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

test('invokeSpawn timeoutMs：超时守卫中止子会话并返回 [agent_timeout]（保留 executionInfo）', timeout, async (t) => {
  const custom = makeEnv(t, (proto: unknown) => {
    const request = proto as { onResolved?: (info: unknown) => void; signal?: AbortSignal }
    request.onResolved?.({ conversationId: 9, effectiveCwd: '/hang/dir' })
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
  assert.equal(result.executionInfo?.conversationId, 9, '超时失败保留 executionInfo 供 resume')
  assert.deepEqual(custom.guardedAborts, [9], '超时必须守卫中止子会话')
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
