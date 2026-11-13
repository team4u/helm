/**
 * 跨 Profile 点名协作集成验收（builtin:profile）。
 *
 * 验收对象（docs/plugins/profile.md「跨 Profile 点名与协同目录」契约；实现
 * 合入前本文件预期红，绝不以 mock 服务端或伪数据冒充通过）：
 * 1. plugins.listUi 暴露 builtin:profile 的 composer.completer（trigger '@'，
 *    source 为 action list_mentionable），且动作清单声明 idempotent:true
 *    （补全源高频只读查询的硬性前置）。
 * 2. 真 HTTP POST /api/actions/builtin%3Aprofile/list_mentionable：
 *    按 query 过滤候选、insertText 为 '@<id> '（尾随空格）、动作只读
 *    （不派生会话、零模型调用）、显式校验真实会话（不存在 404）、
 *    外层 body.conversationId 存在时优先作为可信上下文（不接受 input
 *    伪造目标会话）。
 * 3. 真 runCli 动态命令 helm profile list_mentionable（manifest 经真 HTTP
 *    拉取，不 mock 服务端响应）：--current（读 HELM_CONVERSATION_ID）与
 *    无上下文 --input 显式 conversationId 均正确；空查询命中完整目录排除
 *    规则（当前 Profile / humanSelectable:false / 停用插件托管角色）；
 *    --current 存在时优先使用 HELM_CONVERSATION_ID，不接受 input 冒充目标。
 * 4. 父会话输入「让 @reviewer 审查」→ faux 脚本显式调用
 *    subagent({agentType:'reviewer'}) → 真子会话（parentConversationId 与
 *    profileId 如实落库，携带 parentToolCallId）→ 父收尾轮模型上下文含
 *    <available_profiles> 协作目录（含 reviewer 职责摘要、排除内部与孤儿
 *    角色），子会话拿到自己的 profile SYSTEM 且无团队目录。
 *
 * 诚实性纪律：
 * - 所有「模型输出」均来自 faux.setResponses 脚本，faux 只证明链路连接，
 *   不证明真实 LLM 会按自然语言自主决策委派；
 * - 不创建人类直连其他 Profile 的旧会话冒充委派，派生关系以
 *   parentConversationId 真实落库为准；
 * - 不 mock WorkflowService / spawnAgent / HTTP 层。
 *
 * 工作流 agent({attachments}) 附件链路由另一专项端到端测试覆盖，此处不重复。
 *
 * runner: tsx --test；每项显式 timeout: 60_000。
 */
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'

import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'

import assert from 'node:assert/strict'

// ---------------------------------------------------------------------------
// 资产标记：各 Profile SYSTEM 首个非标题自然段携带唯一标记，
// 供「目录摘要提取」与「子会话 SYSTEM 注入」双向断言。
// ---------------------------------------------------------------------------

const REVIEWER_SIGN = 'REVIEWER-SIGN-c6d9f2'
const TESTER_SIGN = 'TESTER-SIGN-a41f77'
const INTERNAL_SIGN = 'INTERNAL-SIGN-2e77b1'
const ORPHAN_SIGN = 'ORPHAN-SIGN-88ab03'

interface CapturedRequest {
  systemSections: string[]
  userTexts: string[]
}

interface CollabEnv {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  /** 每次模型请求的 system sections 与用户文本（faux TranscriptContext 捕获）。 */
  requests: CapturedRequest[]
  /** 首次启动播种的 assistant 入口会话 ID（点名协作的父会话）。 */
  rootId: number
  /** 与 rootId 不同的真实会话（冲突校验用）。 */
  secondConvId: number
  /** 记录请求上下文并返回给定响应的 faux 脚本步骤。 */
  scriptedStep(make: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep
  submitAndWait(text: string): Promise<void>
  close(): Promise<void>
}

async function makeCollabEnv(): Promise<CollabEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-profile-collab-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  // 真实组合入口：真 SQLite + 真 PluginHost + 真 builtin:profile/workflow/memory。
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const kernel = app.kernel

  // 委派目标与被排除角色（save 的 system 字段原子同步至 SYSTEM.md）。
  await kernel.profiles.save({
    id: 'reviewer',
    name: '代码审查员',
    system: `# 代码审查员\n\n你是严谨的代码审查员，负责审查代码变更并给出通过或阻塞结论。${REVIEWER_SIGN}\n`,
  })
  await kernel.profiles.save({
    id: 'tester',
    name: '测试验证员',
    system: `# 测试验证员\n\n你负责运行测试并验证行为是否符合预期。${TESTER_SIGN}\n`,
  })
  // humanSelectable:false 内部角色：不应出现在人类可点名目录。
  await kernel.profiles.save({
    id: 'internal-ops',
    name: '内部调度',
    humanSelectable: false,
    system: `# 内部调度\n\n内部常驻调度角色，不应出现在点名目录。${INTERNAL_SIGN}\n`,
  })
  // 所属插件未启用的受管角色：不应被目录推荐。
  await kernel.profiles.save({
    id: 'orphan-worker',
    name: '孤儿托管角色',
    managedByPlugin: 'community:reporter',
    system: `# 孤儿托管角色\n\n由未启用插件托管，不应被推荐委派。${ORPHAN_SIGN}\n`,
  })

  const initial = kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initial === undefined) throw new Error('首次启动应播种 assistant 入口会话')
  const second = await kernel.createConversation({ title: '冲突校验会话', profileId: 'assistant' })

  const requests: CapturedRequest[] = []
  const record = (context: { messages: Array<{ role: string; content: unknown; sections?: Record<string, string> }> }) => {
    requests.push({
      systemSections: context.messages
        .filter((m) => m.role === 'system')
        .flatMap((m) => Object.values(m.sections ?? {})),
      userTexts: context.messages
        .filter((m) => m.role === 'user')
        .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
    })
  }
  const scriptedStep = (make: () => ReturnType<typeof fauxAssistantMessage>): FauxResponseStep =>
    (context) => {
      record(context as never)
      return make()
    }

  return {
    dataDir,
    faux,
    app,
    requests,
    rootId: initial.id,
    secondConvId: second.id,
    scriptedStep,
    async submitAndWait(text) {
      await kernel.submitInput(initial.id, text)
      await kernel.waitForIdle(initial.id)
    },
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

/** HTTP 环境：真 startHub（port 0，不占固定端口）+ 真 setup 鉴权。 */
async function makeCollabHttpEnv() {
  const base = await makeCollabEnv()
  const hub = await startHub({ kernel: base.app.kernel as never, port: 0 })
  const setup = await fetch(`${hub.url}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: '点名协作集成密码十位' }),
  })
  assert.equal(setup.status, 200, 'auth setup 应成功')
  const token = (JSON.parse(await setup.text()) as { token: string }).token
  const actionPath = `/api/actions/${encodeURIComponent('builtin:profile')}/list_mentionable`
  const call = async (body: unknown): Promise<{ status: number; body: string }> => {
    const response = await fetch(`${hub.url}${actionPath}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: response.status, body: await response.text() }
  }
  return {
    ...base,
    hub,
    token,
    call,
    async close() {
      await hub.close()
      await base.close()
    },
  }
}

interface MentionItem {
  id: string
  label: string
  insertText: string
  hint?: unknown
  icon?: unknown
}

function parseItems(raw: string): MentionItem[] {
  const parsed = JSON.parse(raw) as { items?: unknown }
  assert.ok(Array.isArray(parsed.items), `动作输出应含 items 数组：${raw}`)
  for (const item of parsed.items as MentionItem[]) {
    assert.equal(typeof item.id, 'string', '候选 id 必须是非空字符串')
    assert.equal(typeof item.label, 'string', '候选 label 必须是非空字符串')
    assert.equal(typeof item.insertText, 'string', '候选 insertText 必须是字符串')
  }
  return parsed.items as MentionItem[]
}

// ---------------------------------------------------------------------------
// 1. UI 贡献与动作清单：composer.completer('@') + idempotent 动作
// ---------------------------------------------------------------------------

test('协作1: builtin:profile 注册 @ 补全源（trigger/source/label）与幂等 list_mentionable 动作清单', { timeout: 60_000 }, async () => {
  const env = await makeCollabEnv()
  try {
    const host = env.app.kernel.plugins!

    const completer = host.listUi().find(
      (u) => u.pluginId === 'builtin:profile' && u.surface === 'composer.completer',
    )
    assert.ok(completer !== undefined, 'plugins.listUi 应包含 builtin:profile 的 composer.completer 贡献')
    const spec = completer.spec as {
      id?: unknown
      label?: unknown
      trigger?: unknown
      source?: { kind?: unknown; actionId?: unknown; actionPluginId?: unknown }
    }
    assert.equal(typeof spec.id, 'string', '补全源需要非空 id')
    assert.equal(typeof spec.label, 'string', '补全源需要非空 label')
    assert.ok((spec.label as string).length > 0, '补全源 label 应非空')
    assert.equal(spec.trigger, '@', "点名补全源 trigger 应为 '@'")
    assert.ok(spec.source !== undefined && spec.source !== null, '补全源必须声明 source')
    assert.equal(spec.source!.kind, 'action', '点名补全应采用 action 数据源')
    assert.equal(spec.source!.actionId, 'list_mentionable', 'action 源应指向 list_mentionable')
    if (spec.source!.actionPluginId !== undefined) {
      assert.equal(spec.source!.actionPluginId, 'builtin:profile', '跨插件寻址只允许指回 builtin:profile')
    }

    const manifest = host
      .listActions()
      .find((a) => a.pluginId === 'builtin:profile' && a.id === 'list_mentionable')
    assert.ok(manifest !== undefined, '动作清单应包含 builtin:profile/list_mentionable')
    assert.equal(manifest!.idempotent, true, '补全源动作必须声明 idempotent:true（高频只读查询前置）')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. 真 HTTP 动作：过滤 / insertText / 只读 / 会话校验 / 上下文冲突
// ---------------------------------------------------------------------------

test('协作2: HTTP list_mentionable——query 过滤/insertText 尾随空格/只读零副作用/会话校验/上下文身份优先', { timeout: 60_000 }, async () => {
  const env = await makeCollabHttpEnv()
  try {
    const kernel = env.app.kernel
    const convCountBefore = kernel.listConversations().length
    const modelCallsBefore = env.faux.state.callCount

    // --- query 'review'：只匹配 reviewer；insertText '@reviewer '（尾随空格）
    const review = await env.call({ input: { query: 'review', conversationId: env.rootId } })
    assert.equal(review.status, 200, review.body)
    const reviewItems = parseItems(review.body)
    assert.equal(reviewItems.length, 1, `query 'review' 应只匹配 reviewer：${JSON.stringify(reviewItems)}`)
    assert.equal(reviewItems[0]!.id, 'reviewer')
    assert.equal(reviewItems[0]!.insertText, '@reviewer ', "insertText 应为 '@reviewer '（尾随空格，选中后接续输入）")
    assert.ok(reviewItems[0]!.label.length > 0, '候选 label 应非空')

    // --- query 'test'：只匹配 tester（同一过滤规则，非前缀巧合）
    const tested = await env.call({ input: { query: 'test', conversationId: env.rootId } })
    assert.equal(tested.status, 200, tested.body)
    const testItems = parseItems(tested.body)
    assert.equal(testItems.length, 1, `query 'test' 应只匹配 tester：${JSON.stringify(testItems)}`)
    assert.equal(testItems[0]!.id, 'tester')
    assert.equal(testItems[0]!.insertText, '@tester ')

    // --- 只读性：不派生会话、零模型调用
    assert.equal(kernel.listConversations().length, convCountBefore, 'list_mentionable 不得派生新会话')
    assert.equal(env.faux.state.callCount, modelCallsBefore, 'list_mentionable 不得发起模型调用')

    // --- 会话校验：不存在的会话显式 404（动作必须校验真实会话）
    const missing = await env.call({ input: { query: 'review', conversationId: 999999 } })
    assert.equal(missing.status, 404, `不存在的会话应显式 404：${missing.body}`)
    assert.match(
      (JSON.parse(missing.body) as { error: { code: string } }).error.code,
      /not_found/,
      '错误码应指向会话不存在',
    )

    // --- 上下文身份优先：外层 body.conversationId 决定真实会话，input.conversationId 只在无上下文时生效
    const contextWins = await env.call({
      input: { query: 'review', conversationId: env.rootId },
      conversationId: env.secondConvId,
    })
    assert.equal(contextWins.status, 200, contextWins.body)
    const contextItems = parseItems(contextWins.body)
    assert.equal(contextItems.length, 1)
    assert.equal(contextItems[0]!.id, 'reviewer', '有调用上下文时不能被 input.conversationId 冒充')

    // --- Schema 边界：query 非字符串 400 validation_error（HTTP/CLI 同一校验器）
    const bad = await env.call({ input: { query: 42, conversationId: env.rootId } })
    assert.equal(bad.status, 400, `非法入参应 400：${bad.body}`)
    assert.equal((JSON.parse(bad.body) as { error: { code: string } }).error.code, 'validation_error')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. 真 CLI 动态命令：--current / 无上下文 --input / 目录排除 / 冲突
// ---------------------------------------------------------------------------

test('协作3: CLI 动态命令 helm profile list_mentionable——--current/无上下文 --input/目录排除规则/上下文身份优先', { timeout: 60_000 }, async () => {
  const env = await makeCollabHttpEnv()
  const { runCli } = await import('../../cli/src/index.js')
  const run = async (argv: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> => {
    let out = ''
    let err = ''
    const code = await runCli(argv, {
      // 不继承 process.env：HELM_CONVERSATION_ID 只在显式给定时存在。
      env: {
        HELM_HUB_URL: env.hub.url,
        HELM_DATA_DIR: env.dataDir,
        HELM_TOKEN: env.token,
        PATH: process.env.PATH,
        ...extraEnv,
      },
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    })
    return { code, out, err }
  }
  try {
    // --- --current（HELM_CONVERSATION_ID 真实解析）+ --query 动态旗标
    const current = await run(
      ['profile', 'list_mentionable', '--query', 'review', '--current', '--json'],
      { HELM_CONVERSATION_ID: String(env.rootId) },
    )
    assert.equal(current.code, 0, current.err)
    const currentItems = parseItems(current.out)
    assert.equal(currentItems.length, 1, `--current + --query review 应只匹配 reviewer：${current.out}`)
    assert.equal(currentItems[0]!.id, 'reviewer')
    assert.equal(currentItems[0]!.insertText, '@reviewer ')

    // --- 无会话上下文：input.conversationId 显式指定同样正确
    const explicit = await run([
      'profile', 'list_mentionable', '--json',
      '--input', JSON.stringify({ query: 'review', conversationId: env.rootId }),
    ])
    assert.equal(explicit.code, 0, explicit.err)
    const explicitItems = parseItems(explicit.out)
    assert.equal(explicitItems.length, 1)
    assert.equal(explicitItems[0]!.id, 'reviewer')
    assert.equal(explicitItems[0]!.insertText, '@reviewer ')

    // --- 空查询：完整目录排除规则（当前 Profile / 内部角色 / 停用插件托管角色）
    const broad = await run([
      'profile', 'list_mentionable', '--json',
      '--input', JSON.stringify({ query: '', conversationId: env.rootId }),
    ])
    assert.equal(broad.code, 0, broad.err)
    const ids = parseItems(broad.out).map((i) => i.id).sort()
    assert.deepEqual(ids, ['reviewer', 'tester'], `点名目录应恰含可委派角色：${JSON.stringify(ids)}`)

    // --- 无任何会话目标：显式非零（动作必须校验真实会话，不猜测缺省）
    const noTarget = await run(['profile', 'list_mentionable', '--query', 'review', '--json'])
    assert.notEqual(noTarget.code, 0, '缺少会话目标应显式失败')

    // --- --current 与 --input 目标同时存在时，外层当前会话优先，不允许 input 冒充身份
    const contextWins = await run(
      [
        'profile', 'list_mentionable', '--current', '--json',
        '--input', JSON.stringify({ query: 'review', conversationId: env.secondConvId }),
      ],
      { HELM_CONVERSATION_ID: String(env.rootId) },
    )
    assert.equal(contextWins.code, 0, contextWins.err)
    assert.deepEqual(parseItems(contextWins.out).map((i) => i.id), ['reviewer'])
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. 点名委派真链路：subagent(agentType) → 真子会话 → 父目录/子 SYSTEM 隔离
// ---------------------------------------------------------------------------

test('协作4: 点名委派真链路——subagent(agentType reviewer) 派生真子会话，父收尾上下文含协作目录；一层子代理保留派工工具故同样注入目录', { timeout: 60_000 }, async () => {
  const env = await makeCollabEnv()
  try {
    const kernel = env.app.kernel
    const CHILD_REPLY = '审查完成：REVIEWER-OK-5b82'
    // faux 脚本（队列按请求顺序消费）：父工具轮（显式点名委派，模拟模型读到
    // 协作目录后调用 subagent）→ 子代理回合 → 父收尾总结轮。
    env.faux.setResponses([
      env.scriptedStep(() => fauxAssistantMessage(
        [fauxToolCall('subagent', { agentType: 'reviewer', prompt: '审查' })],
        { stopReason: 'toolUse' },
      )),
      env.scriptedStep(() => fauxAssistantMessage(CHILD_REPLY)),
      env.scriptedStep(() => fauxAssistantMessage('已收到审查结论，主会话总结完成')),
    ])

    await env.submitAndWait('让 @reviewer 审查')

    // --- 真派生关系：恰一个 reviewer 子会话挂在 root 下（非人类直连会话）
    const children = kernel.listConversations().filter((c) => c.parentConversationId === env.rootId)
    assert.equal(children.length, 1, `应派生恰一个真子会话，实得 ${JSON.stringify(children.map((c) => ({ id: c.id, profileId: c.profileId })))}`)
    assert.equal(children[0]!.profileId, 'reviewer', '子会话应按 agentType 绑定 reviewer Profile')
    assert.ok(
      children[0]!.parentToolCallId !== undefined && children[0]!.parentToolCallId !== '',
      '子会话应携带 parentToolCallId（真实工具调用运行期关联）',
    )
    const reviewerConvs = kernel.listConversations().filter((c) => c.profileId === 'reviewer')
    assert.equal(reviewerConvs.length, 1)
    assert.equal(reviewerConvs[0]!.parentConversationId, env.rootId, '不得以人类直连 reviewer 会话冒充委派')

    // --- 请求分类：父工具轮 + 子代理轮 + 父收尾轮，恰三次模型调用
    assert.equal(env.requests.length, 3, `应恰三次模型请求（父/子/父），实得 ${env.requests.length}`)
    const childRequests = env.requests.filter((r) => r.systemSections.some((s) => s.startsWith('# 代码审查员')))
    assert.equal(childRequests.length, 1, `reviewer SYSTEM 应注入恰一次（子代理回合）：${JSON.stringify(env.requests)}`)
    const childReq = childRequests[0]!
    // 深度契约（默认上限 2）：主会话直接派生的一层子代理保留派工工具，
    // 协作目录随工具清单自然注入（可继续点名委派）；仅达到上限的叶子
    // 子代理被剥离派工工具后不注入（见 subagent-depth.test.ts）。
    assert.ok(
      childReq.systemSections.some((s) => s.includes('<available_profiles>')),
      '一层子代理回合应含协作目录（保留派工工具，可继续点名委派）',
    )
    assert.ok(
      childReq.systemSections.every((s) => !s.includes('@reviewer')),
      '子会话目录不得含自身 Profile（排除当前会话 Profile）',
    )
    assert.ok(childReq.userTexts.some((t) => t.includes('审查')), '子会话用户消息应为委派 prompt')

    // --- 父收尾上下文：<available_profiles> 协作目录（含点名格式与职责摘要，
    //     排除当前 Profile / 内部角色 / 停用插件托管角色）
    const parentLast = env.requests[env.requests.length - 1]!
    assert.notEqual(parentLast, childReq, '最后一次请求应为父会话收尾轮')
    assert.ok(parentLast.systemSections.some((s) => s.includes('# System Prompt')), '父会话仍使用 assistant SYSTEM')
    const catalog = parentLast.systemSections.find((s) => s.includes('<available_profiles>'))
    assert.ok(catalog !== undefined, '父会话模型上下文应含 <available_profiles> 协作目录')
    assert.ok(catalog!.includes('@reviewer'), '目录应含 @reviewer 点名格式')
    assert.ok(catalog!.includes(REVIEWER_SIGN), '目录应含 reviewer 职责摘要（SYSTEM 首个非标题自然段提取）')
    assert.ok(!catalog!.includes(INTERNAL_SIGN), '目录不得含 humanSelectable:false 内部角色')
    assert.ok(!catalog!.includes(ORPHAN_SIGN), '目录不得含停用插件托管角色')
    assert.ok(!catalog!.includes('@assistant'), '目录不得含当前会话自身 Profile')
    assert.ok(parentLast.userTexts.some((t) => t.includes('让 @reviewer 审查')), '父会话应保留原始点名输入')
  } finally {
    await env.close()
  }
})
