/**
 * WorkflowService.listAutoResumeCandidates 专属单测（§3.2 断点续跑候选筛选）。
 *
 * 只读验证安全筛选契约，不起真实 run：record file与轻量索引均按现行契约手工构造
 * （writeRecord / RunRecord / RunIndexEntry / WorkflowJournalEntry），覆盖：
 * 1. 命中全部条件的失败后台 run 成为候选（failedAt=updatedAt，autoResumeCount
 *    缺省报 0，候选形状恰为四字段）；
 * 2. 逐项过滤矩阵：非 failed 状态 / 非后台（未置 notifyParentOnSettle）/ 已被
 *    接管（resumedByRunId，接管目标真实存在）/ subagent 种类 / 次数达上限 /
 *    不可重试错误（workflow_action_uncertain、[validation_error]、脚本语法
 *    错误——大小写不敏感；无括号的普通 validation 字样不在排除面）；
 * 3. 账本不确定（悬挂 action_started / ok:false action / 損坏行）一律排除，
 *    即便存在 ok agent 行；带 execution 的失败尝试与 action_started+action ok
 *    配对是可安全恢复锚点；
 * 4. 账本无任何可安全恢复锚点（空文件 / 无 execution 的失败 agent 行 / 文件
 *    缺失 ENOENT）排除；
 * 5. 按 failedAt 升序（最旧失败优先），与索引写入顺序无关；
 * 6. maxAttempts 边界：非正整数显式 validation_error；1 时 count 1 排除、
 *    0 保留；
 * 7. 单条损坏记录（record file缺失/損坏）诊断后跳过，不影响其他候选；
 * 8. 索引損坏（非数组/项形状非法）显式 workflow_index_corrupt 上抛，绝不
 *    静默当空索引返回空候选；
 * 9. 幽灵接管标记同规则甄别：接管 run 四面无痕（索引/磁盘均无记录与账本）
 *    才放行重接管；磁盘仍有记录/账本文件（即使索引缺失）或接管目标損坏
 *    一律不放行。
 */
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { HelmxError, type ConversationSummary } from '@helmx/protocol'
import {
  WorkflowService,
  type WorkflowServiceHost,
  type WorkflowStateStore,
} from '../src/workflow/engine/service.js'
import {
  makeConversationSummary as baseConversationSummary,
  useTempDir as createTempDir,
} from './helpers/plugin-test-env.js'

const timeout = { timeout: 60_000 } as const

// ---------------------------------------------------------------------------
// 测试环境：真实 dataDir + Map 态 state store + 最小宿主桩
// ---------------------------------------------------------------------------

const makeConversationSummary = (id: number): ConversationSummary =>
  baseConversationSummary({ id, model: 'faux/faux-1', createdAt: 0, updatedAt: 0 })

function makeEnv(t: TestContext) {
  const dataDir = createTempDir(t, 'helmx-wf-auto-resume-')
  const docs = new Map<string, unknown>()
  const state: WorkflowStateStore = {
    get<T>(key: string, initial: T): T {
      return docs.has(key) ? (docs.get(key) as T) : initial
    },
    set(key: string, value: unknown) {
      docs.set(key, value)
    },
  }
  // 本测试不起真实 run：宿主桩仅满足构造形状，任何回调被触发即测试用例写错。
  const host: WorkflowServiceHost = {
    spawnAgent: () => {
      throw new Error('listAutoResumeCandidates 不得派生子会话')
    },
    invokeAction: () => {
      throw new Error('listAutoResumeCandidates 不得调用动作')
    },
    listActions: () => [],
    getConversation: makeConversationSummary,
    abortConversationGuarded: async () => {},
    emitEvent: () => {},
  }
  const service = new WorkflowService({ dataDir, state, host })
  t.after(async () => {
    await service.close().catch(() => {})
  })
  return { dataDir, docs, service }
}

// ---------------------------------------------------------------------------
// 按现行契约构造持久事实：record file + 轻量索引 + JSONL 账本
// ---------------------------------------------------------------------------

/** 账本行构造（与 WorkflowJournalEntry 同形；同文件内 seq 必须唯一——读端按 seq 去重）。
 * agent 行携带 invocationIndex: 0（账本新增可选字段，未落入前解析器容忍未知键，
 * 落地后即契合新行格式；agentJournalKey 不含该字段，键值稳定）。所有行携带
 * scopePath: 'root'；scopeCallIndex 为 DSL 调用序号（agent 行取 invocationIndex，
 * action 行取 index；自动重试共用同一序号）。 */
const agentOk = (seq: number, index = 0, key = `k${seq}`) =>
  JSON.stringify({ v: 1, seq, type: 'agent', index, key, scopePath: 'root', scopeCallIndex: 0, ok: true, text: 'done', invocationIndex: 0 })
const agentFail = (seq: number, index = 0, key = `k${seq}`) =>
  JSON.stringify({ v: 1, seq, type: 'agent', index, key, scopePath: 'root', scopeCallIndex: 0, ok: false, invocationIndex: 0 })
/** 带 execution 的失败尝试行（可安全恢复锚点；attempt ≥ 1）。 */
const agentFailAttempt = (seq: number, conversationId: number, index = 0, key = `k${seq}`) =>
  JSON.stringify({
    v: 1, seq, type: 'agent', index, key, scopePath: 'root', scopeCallIndex: 0, ok: false, attempt: 1,
    error: '[agent_failed] 尝试失败', invocationIndex: 0,
    execution: { conversationId },
  })
/** 无 execution 的失败尝试行（无锚点）。 */
const agentFailAttemptNoExec = (seq: number, index = 0, key = `k${seq}`) =>
  JSON.stringify({
    v: 1, seq, type: 'agent', index, key, scopePath: 'root', scopeCallIndex: 0, ok: false, attempt: 1,
    error: '[agent_failed] 尝试失败', invocationIndex: 0,
  })
const actionStarted = (seq: number, index = 0, key = `a${index}`) =>
  JSON.stringify({ v: 1, seq, type: 'action_started', index, key, scopePath: 'root', scopeCallIndex: index })
const actionOk = (seq: number, index = 0, key = `a${index}`) =>
  JSON.stringify({ v: 1, seq, type: 'action', index, key, scopePath: 'root', scopeCallIndex: index, ok: true, result: 1 })

interface SeedSpec {
  runId: string
  conversationId: number
  failedAt: number
  status?: 'running' | 'completed' | 'failed' | 'aborted'
  error?: string
  kind?: 'workflow' | 'subagent'
  /** 缺省 true：自动续跑只面向后台 run。 */
  notifyParentOnSettle?: boolean
  autoResumeCount?: number
  resumedByRunId?: string
  /** 账本行；undefined = 不写账本文件（ENOENT 空账本路径）。 */
  journal?: string[]
}

/**
 * 以 writeRecord 的现行契约落一份 run 持久事实：完整 RunRecord 原子落
 * artifacts/<convId>/workflow-<runId>.record.json，索引仅轻量字段
 * （notifyParentOnSettle 只在 true 时携带，可选字段缺省不写）。
 */
function seedRun(env: ReturnType<typeof makeEnv>, spec: SeedSpec): void {
  const status = spec.status ?? 'failed'
  const journalPath = join(
    env.dataDir,
    'artifacts',
    String(spec.conversationId),
    `workflow-${spec.runId}.jsonl`,
  )
  const record = {
    id: spec.runId,
    name: 'auto-resume-fixture',
    conversationId: spec.conversationId,
    status,
    createdAt: spec.failedAt - 5_000,
    updatedAt: spec.failedAt,
    ...(spec.error !== undefined ? { error: spec.error } : {}),
    journalPath,
    ...(spec.kind !== undefined ? { kind: spec.kind } : {}),
    ...(spec.notifyParentOnSettle !== false ? { notifyParentOnSettle: true } : {}),
    ...(spec.autoResumeCount !== undefined ? { autoResumeCount: spec.autoResumeCount } : {}),
    ...(spec.resumedByRunId !== undefined ? { resumedByRunId: spec.resumedByRunId } : {}),
  }
  const dir = join(env.dataDir, 'artifacts', String(spec.conversationId))
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, `workflow-${spec.runId}.record.json`),
    JSON.stringify(record),
    'utf8',
  )
  if (spec.journal !== undefined) {
    writeFileSync(journalPath, `${spec.journal.join('\n')}\n`, 'utf8')
  }
  const index = (env.docs.get('workflow/runs') ?? []) as Array<Record<string, unknown>>
  index.push({
    id: spec.runId,
    conversationId: spec.conversationId,
    status,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    ...(spec.notifyParentOnSettle !== false ? { notifyParentOnSettle: true } : {}),
    ...(spec.autoResumeCount !== undefined ? { autoResumeCount: spec.autoResumeCount } : {}),
    ...(spec.resumedByRunId !== undefined ? { resumedByRunId: spec.resumedByRunId } : {}),
  })
  env.docs.set('workflow/runs', index)
}

/** 便捷种子：一条可续跑的失败后台 run（可重试错误 + ok agent 行）。 */
function seedCandidateRun(
  env: ReturnType<typeof makeEnv>,
  runId: string,
  conversationId: number,
  failedAt: number,
  over: Partial<SeedSpec> = {},
): void {
  seedRun(env, {
    runId,
    conversationId,
    failedAt,
    error: '[agent_failed] worker 任务失败',
    journal: [agentOk(0)],
    ...over,
  })
}

// ---------------------------------------------------------------------------
// 1. 命中全部条件：候选形状与缺省值
// ---------------------------------------------------------------------------

test('命中全部安全条件的失败后台 run 成为候选（failedAt=updatedAt，autoResumeCount 缺省报 0）', timeout, (t) => {
  const env = makeEnv(t)
  const failedAt = 1_700_000_000_000
  seedCandidateRun(env, 'wf_000000000001', 11, failedAt)
  const candidates = env.service.listAutoResumeCandidates()
  assert.equal(candidates.length, 1)
  assert.deepEqual(
    candidates[0],
    { runId: 'wf_000000000001', conversationId: 11, failedAt, autoResumeCount: 0 },
    '候选恰为四字段；记录未写 autoResumeCount 时按 0 上报',
  )
})

// ---------------------------------------------------------------------------
// 2. 过滤矩阵：每行一个 run，仅命中全部条件者入选
// ---------------------------------------------------------------------------

test('过滤矩阵：状态/后台标记/接管/种类/次数/不可重试错误逐项排除', timeout, (t) => {
  const env = makeEnv(t)
  const at = (n: number) => 1_700_000_000_000 + n * 1_000
  const journal = { journal: [agentOk(0)] }
  // 入选基准与边界内项。
  seedCandidateRun(env, 'wf_base00000001', 101, at(1), journal)
  seedCandidateRun(env, 'wf_count0000002', 102, at(2), { ...journal, autoResumeCount: 2 })
  seedCandidateRun(env, 'wf_plainvalid03', 103, at(3), {
    ...journal,
    // 无括号的 validation 字样不属于 [validation_error] 契约面，仍可重试。
    error: 'model call failed during validation phase',
  })
  // 状态非 failed。
  seedCandidateRun(env, 'wf_completed0004', 104, at(4), { ...journal, status: 'completed' })
  seedCandidateRun(env, 'wf_aborted00005', 105, at(5), { ...journal, status: 'aborted' })
  seedCandidateRun(env, 'wf_running00006', 106, at(6), { ...journal, status: 'running' })
  // 非后台 run（未置/显式 false 均不算）。
  seedCandidateRun(env, 'wf_sync00000007', 107, at(7), { ...journal, notifyParentOnSettle: false })
  // 已被接管（防重复续跑）：接管目标真实存在（终态记录仍在索引）。
  seedCandidateRun(env, 'wf_resumed00008', 108, at(8), { ...journal, resumedByRunId: 'wf_next0001' })
  seedRun(env, { runId: 'wf_next0001', conversationId: 108, failedAt: at(8) - 1, status: 'completed', journal: [] })
  // subagent 种类（单子代理后台任务不走工作流断点续跑）。
  seedCandidateRun(env, 'wf_subagent009', 109, at(9), { ...journal, kind: 'subagent' })
  // 次数达默认上限 3。
  seedCandidateRun(env, 'wf_count0000010', 110, at(10), { ...journal, autoResumeCount: 3 })
  // 不可重试错误：副作用不确定 / 校验拒绝 / 脚本语法错误（含大小写不敏感变体）。
  seedCandidateRun(env, 'wf_uncertain011', 111, at(11), {
    ...journal,
    error: 'workflow_action_uncertain: journal replay broke prefix at index 3',
  })
  seedCandidateRun(env, 'wf_uncertain012', 112, at(12), {
    ...journal,
    error: 'WORKFLOW_ACTION_UNCERTAIN: prior run left uncertain journal',
  })
  seedCandidateRun(env, 'wf_validation013', 113, at(13), {
    ...journal,
    error: 'HelmxError [validation_error] 工作流参数非法',
  })
  seedCandidateRun(env, 'wf_syntax000014', 114, at(14), {
    ...journal,
    error: 'WorkflowRuntimeError: Workflow script has a syntax error: Unexpected token',
  })
  const ids = env.service.listAutoResumeCandidates().map((c) => c.runId)
  assert.deepEqual(ids, ['wf_base00000001', 'wf_count0000002', 'wf_plainvalid03'])
})

// ---------------------------------------------------------------------------
// 3. 账本不确定：即便存在 ok agent 行也一律排除
// ---------------------------------------------------------------------------

test('账本不确定（悬挂 action_started / ok:false action / 損坏行）排除，即使另有 ok agent 行', timeout, (t) => {
  const env = makeEnv(t)
  const at = (n: number) => 1_700_000_500_000 + n * 1_000
  seedCandidateRun(env, 'wf_journalok001', 201, at(1))
  // 悬挂 started：意图行无终态配对，副作用不可判定。
  seedCandidateRun(env, 'wf_dangling002', 202, at(2), {
    journal: [actionStarted(0, 0), agentOk(1, 1)],
  })
  // ok:false action（非幂等）：handler 抛错不等于零副作用，禁止自动重试。
  seedCandidateRun(env, 'wf_failact0003', 203, at(3), {
    journal: [
      actionStarted(0, 0),
      JSON.stringify({ v: 1, seq: 1, type: 'action', index: 0, key: 'a0', scopePath: 'root', scopeCallIndex: 0, ok: false, error: 'boom' }),
      agentOk(2, 1),
    ],
  })
  // 无法判定类型的損坏行：保守 uncertain。
  seedCandidateRun(env, 'wf_corrupt00004', 204, at(4), {
    journal: [agentOk(0), 'not-a-json-line-{{{'],
  })
  const ids = env.service.listAutoResumeCandidates().map((c) => c.runId)
  assert.deepEqual(ids, ['wf_journalok001'])
})

// ---------------------------------------------------------------------------
// 4. 账本无 ok agent/action：排除；action 配对成功放行
// ---------------------------------------------------------------------------

test('账本无 ok agent/action（空文件 / 仅失败 agent 行 / 文件缺失）排除；失败尝试带 execution 与 action ok 配对放行', timeout, (t) => {
  const env = makeEnv(t)
  const at = (n: number) => 1_700_001_000_000 + n * 1_000
  seedCandidateRun(env, 'wf_actok000001', 301, at(1), {
    journal: [actionStarted(0, 0), actionOk(1, 0)],
  })
  // 带 execution 的失败尝试（attempt=1 + conversationId）：可安全恢复锚点。
  seedCandidateRun(env, 'wf_attempt005', 305, at(5), {
    journal: [agentFailAttempt(0, 305)],
  })
  seedCandidateRun(env, 'wf_empty000002', 302, at(2), { journal: [] })
  seedCandidateRun(env, 'wf_agentfail003', 303, at(3), {
    journal: [agentFail(0, 0), agentFail(1, 1)],
  })
  // 失败尝试无 execution：无锚点，无法定位续接目标，排除。
  seedCandidateRun(env, 'wf_noexec006', 306, at(6), {
    journal: [agentFailAttemptNoExec(0)],
  })
  seedCandidateRun(env, 'wf_nojournal004', 304, at(4), { journal: undefined })
  const ids = env.service.listAutoResumeCandidates().map((c) => c.runId)
  assert.deepEqual(ids, ['wf_actok000001', 'wf_attempt005'])
})

test('仅有外部失败尝试句柄不能作为跨 Run 自动续跑锚点', timeout, (t) => {
  const env = makeEnv(t)
  seedCandidateRun(env, 'wf_externalonly', 307, 1_700_001_008_000, {
    journal: [JSON.stringify({
      v: 1, seq: 0, type: 'agent', index: 0, key: 'external', scopePath: 'root', scopeCallIndex: 0, ok: false, attempt: 1,
      invocationIndex: 0, error: 'external timeout', execution: { nodeId: 'local', executionId: 'pane-7' },
    })],
  })
  assert.deepEqual(env.service.listAutoResumeCandidates(), [])
})

// ---------------------------------------------------------------------------
// 5. 排序：failedAt 升序（最旧失败优先），与索引写入顺序无关
// ---------------------------------------------------------------------------

test('按 failedAt 升序输出（最旧失败优先），与索引写入顺序无关', timeout, (t) => {
  const env = makeEnv(t)
  // 故意按新失败在前写入索引。
  seedCandidateRun(env, 'wf_newest00001', 401, 1_700_002_000_000)
  seedCandidateRun(env, 'wf_middle00002', 402, 1_700_001_000_000)
  seedCandidateRun(env, 'wf_oldest00003', 403, 1_700_000_000_000)
  const candidates = env.service.listAutoResumeCandidates()
  assert.deepEqual(
    candidates.map((c) => c.runId),
    ['wf_oldest00003', 'wf_middle00002', 'wf_newest00001'],
  )
  const failedAts = candidates.map((c) => c.failedAt)
  assert.deepEqual([...failedAts].sort((a, b) => a - b), failedAts, 'failedAt 严格升序')
})

// ---------------------------------------------------------------------------
// 6. maxAttempts 边界
// ---------------------------------------------------------------------------

test('maxAttempts 非正整数显式 validation_error；1 时 count 1 排除、0 保留', timeout, (t) => {
  const env = makeEnv(t)
  const at = (n: number) => 1_700_003_000_000 + n * 1_000
  seedCandidateRun(env, 'wf_zero0000001', 501, at(1), { autoResumeCount: 0 })
  seedCandidateRun(env, 'wf_one00000002', 502, at(2), { autoResumeCount: 1 })
  for (const bad of [0, -1, 1.5, Number.NaN]) {
    assert.throws(
      () => env.service.listAutoResumeCandidates(bad),
      (error: unknown) => error instanceof HelmxError && error.code === 'validation_error',
      `maxAttempts=${String(bad)} 必须显式拒绝`,
    )
  }
  assert.deepEqual(
    env.service.listAutoResumeCandidates(1).map((c) => c.runId),
    ['wf_zero0000001'],
    '上限 1 时仅保留 count 0',
  )
})

// ---------------------------------------------------------------------------
// 7. record file缺失：诊断后跳过该条，不影响其他候选
// ---------------------------------------------------------------------------

test('单条损坏记录（record file缺失/損坏）诊断后跳过，保留其他健康候选', timeout, (t) => {
  const env = makeEnv(t)
  const journal = { journal: [agentOk(0)] }
  seedCandidateRun(env, 'wf_ok000000001', 601, 1_700_004_000_000, journal)
  seedCandidateRun(env, 'wf_miss0000002', 602, 1_700_004_001_000, journal)
  seedCandidateRun(env, 'wf_crpt000003', 603, 1_700_004_002_000, journal)
  // 模拟持久层不一致：索引保留，record file被外部删除 / 被写成非法 JSON。
  const recordFile = join(
    env.dataDir,
    'artifacts',
    '602',
    'workflow-wf_miss0000002.record.json',
  )
  rmSync(recordFile)
  writeFileSync(
    join(env.dataDir, 'artifacts', '603', 'workflow-wf_crpt000003.record.json'),
    'garbage-not-json{{{',
    'utf8',
  )
  assert.deepEqual(env.service.listAutoResumeCandidates().map((candidate) => candidate.runId), ['wf_ok000000001'])
})

// ---------------------------------------------------------------------------
// 8. 索引损坏：显式 workflow_index_corrupt，绝不静默返回空候选
// ---------------------------------------------------------------------------

test('索引损坏（非数组 / 项形状非法）显式 workflow_index_corrupt 上抛，不静默返回空候选', timeout, (t) => {
  const env = makeEnv(t)
  seedCandidateRun(env, 'wf_okidx000001', 801, 1_700_005_000_000)
  const brokenIndexes: unknown[] = [
    null,
    { 0: {} },
    [{ id: 'wf_brokenentry', conversationId: 0, status: 'failed', createdAt: 1, updatedAt: 1 }],
  ]
  for (const broken of brokenIndexes) {
    env.docs.set('workflow/runs', broken)
    assert.throws(
      () => env.service.listAutoResumeCandidates(),
      (error: unknown) => error instanceof HelmxError && error.code === 'workflow_index_corrupt',
      '索引损坏必须显式上抛（Watchdog 依赖候选面，绝不静默空列表）',
    )
  }
})

// ---------------------------------------------------------------------------
// 9. 幽灵接管标记同规则甄别：真幽灵放行；磁盘仍有痕迹或接管目标损坏不放行
// ---------------------------------------------------------------------------

test('幽灵接管标记：真幽灵（索引与磁盘均无痕迹）放行；磁盘仍有记录/账本（即使索引缺失）或接管目标损坏不放行', timeout, (t) => {
  const env = makeEnv(t)
  const at = (n: number) => 1_700_006_000_000 + n * 1_000
  const journal = { journal: [agentOk(0)] }
  // 真幽灵：接管 run 从未存在（索引无、磁盘无记录/账本）——放行重接管。
  seedCandidateRun(env, 'wf_ghostok0001', 901, at(1), { ...journal, resumedByRunId: 'wf_never9011' })
  // 索引缺失但账本文件仍在磁盘：新 run 已产生副作用，不放行。
  seedCandidateRun(env, 'wf_ghostjour02', 902, at(2), { ...journal, resumedByRunId: 'wf_gonej9022' })
  writeFileSync(
    join(env.dataDir, 'artifacts', '902', 'workflow-wf_gonej9022.jsonl'),
    `${agentOk(0)}\n`,
    'utf8',
  )
  // 索引缺失但record file仍在磁盘：不放行。
  seedCandidateRun(env, 'wf_ghostrec03', 903, at(3), { ...journal, resumedByRunId: 'wf_goner9033' })
  writeFileSync(
    join(env.dataDir, 'artifacts', '903', 'workflow-wf_goner9033.record.json'),
    JSON.stringify({
      id: 'wf_goner9033',
      name: 'taken-over',
      conversationId: 903,
      status: 'completed',
      createdAt: 0,
      updatedAt: 0,
      journalPath: join(env.dataDir, 'artifacts', '903', 'workflow-wf_goner9033.jsonl'),
    }),
    'utf8',
  )
  // 接管目标记录损坏（索引指向但文件非法）：无法确证无副作用，不放行。
  seedCandidateRun(env, 'wf_ghostcrpt04', 904, at(4), { ...journal, resumedByRunId: 'wf_gonec9044' })
  seedRun(env, { runId: 'wf_gonec9044', conversationId: 904, failedAt: at(4) - 1, status: 'completed', journal: [] })
  writeFileSync(
    join(env.dataDir, 'artifacts', '904', 'workflow-wf_gonec9044.record.json'),
    'garbage-not-json{{{',
    'utf8',
  )
  const ids = env.service.listAutoResumeCandidates().map((c) => c.runId)
  assert.deepEqual(ids, ['wf_ghostok0001'], '仅真幽灵标记放行重接管')
})
