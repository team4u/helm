/**
 * helm 核心端到端集成验收（仅本文件与 app-workflow.integration.test.ts，不修改实现）。
 *
 * 组合纪律：一律经真实组合入口 createHelm（src/app.ts）组装——真 pi-durable
 * SQLite 持久层 + 真 PluginHost + 真 builtin:profile / builtin:memory + 真 WorkflowService +
 * faux provider（pi-ai 官方测试 provider，进程内脚本化响应）。不 new
 * KernelRuntime、不自建 MemoryDocStore、不手拼 HTTP kernel adapter。
 *
 * 诚实性纪律：
 * - 所有「模型输出」均来自 faux.setResponses 脚本，不代表真实外网模型能力；
 * - 若 runtime 集成修复（createHelm 组合）尚未合入本 worktree 而导致
 *   import 崩溃，整套测试如实失败（附诊断），不 skip、不 mock app；
 * - 每项断言针对跨模块契约（见各 test 注释），不镜像实现细节。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { createModels } from '@earendil-works/pi-ai/models'
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type PluginDefinition } from '@helm/protocol'
import { HELM_CLI_SKILL_ASSET } from '../src/builtin-plugins/profile.js'
import { MemoryStore } from '../src/builtin-plugins/memory/store.js'
import { createProfileFileHost } from './helpers/profile-file-host.js'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import { redactJsonValue } from '../src/redact.js'

import assert from 'node:assert/strict'

const testDir = dirname(fileURLToPath(import.meta.url))
const ROOT_CONVERSATION_ID = 1 as const
const repoRoot = join(testDir, '..', '..', '..')
const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
const require = createRequire(import.meta.url)
const tsxCli = require.resolve('tsx/cli')

interface CliRunResult {
  code: number | null
  out: string
  err: string
  timedOut: boolean
}

function runCliChild(
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 25_000,
): Promise<CliRunResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')))
    child.stderr.on('data', (c: Buffer) => (err += c.toString('utf8')))
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: null, out, err, timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, out, err, timedOut })
    })
  })
}

async function httpCall(
  base: string,
  method: string,
  path: string,
  opts?: { body?: unknown; token?: string },
): Promise<{ status: number; body: string }> {
  const headers: Record<string, string> = {}
  if (opts?.body !== undefined) headers['content-type'] = 'application/json'
  if (opts?.token !== undefined) headers.authorization = `Bearer ${opts.token}`
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  })
  return { status: response.status, body: await response.text() }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时')
    await new Promise((r) => setTimeout(r, 25))
  }
}

async function collectSse(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 15_000,
  onReady?: () => void,
): Promise<string[]> {
  const controller = new AbortController()
  const frames: string[] = []
  let readyFired = false
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${base}/api/events`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    assert.equal(response.status, 200)
    const reader = response.body!.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (;;) {
      if (until(frames)) break
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        frames.push(frame)
        if (!readyFired && frame.startsWith('event: snapshot')) {
          readyFired = true
          onReady?.()
        }
      }
    }
    return frames
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

function openSseSubscription(
  base: string,
  token: string,
  until: (frames: string[]) => boolean,
  timeoutMs = 25_000,
): { frames: Promise<string[]>; ready: Promise<void> } {
  let signalReady!: () => void
  const ready = new Promise<void>((resolve) => (signalReady = resolve))
  const frames = collectSse(base, token, until, timeoutMs, signalReady)
  return { frames, ready }
}

function writeProfile(
  dataDir: string,
  id: string,
  files: { system?: string; memory?: string; model?: string },
): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  const profile: Record<string, unknown> = { id, name: id }
  if (files.model !== undefined) profile.model = files.model
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile))
  if (files.system !== undefined) writeFileSync(join(dir, 'SYSTEM.md'), files.system)
  if (files.memory !== undefined) writeFileSync(join(dir, 'MEMORY.md'), files.memory)
}

interface CoreEnv {
  dataDir: string
  dbPath: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  runWorkflow(request: Record<string, unknown>): Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>
  inspectRun(runId: string): Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>
  close(): Promise<void>
}

async function makeCoreEnv(): Promise<CoreEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
  const plugins = app.kernel.plugins
  return {
    dataDir,
    dbPath: join(dataDir, 'state.sqlite'),
    faux,
    app,
    runWorkflow: (request) =>
      plugins.invokeAction('builtin:workflow', 'run', request) as Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>,
    inspectRun: (runId) =>
      plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{ run: import('@helm/protocol').WorkflowRunSummary }>,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// 基建：真实 createHelm 组合环境
// ---------------------------------------------------------------------------

interface TestEnv {
  dataDir: string
  dbPath: string
  faux: ReturnType<typeof fauxProvider>
  /** createHelm 返回的完整 app（真实组合入口产物）。 */
  app: Awaited<ReturnType<typeof createHelm>>
  /** 每次模型请求的完整消息（faux 官方 TranscriptContext 捕获）。 */
  requests: Array<{ roles: string[]; systemSections: string[]; userTexts: string[]; assistantTexts: string[] }>
  /** 首次启动播种的初始 assistant 入口会话 ID（由 SDK root #1 承载，普通会话语义）。 */
  initialConvId: number
  /** 真实提交 + 等待空闲（含 turn_settled 钩子）。 */
  submitAndWait(text: string, opts?: { origin?: 'human' | 'agent' | 'trigger' }): Promise<void>
  /** 追加一个 capture 响应到 faux 队列。 */
  capture(): FauxResponseStep
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dataDir, 'state.sqlite')

  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)

  // 真实组合入口：真 SQLite + 真 PluginHost + profile/memory + WorkflowService。
  const app = await createHelm({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
  })

  const requests: TestEnv['requests'] = []
  faux.setResponses([])

  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('首次启动应播种 assistant 入口会话')
  const env: TestEnv = {
    dataDir,
    dbPath,
    faux,
    app,
    requests,
    initialConvId: initialConv.id,
    async submitAndWait(text, opts) {
      await app.kernel.submitInput(initialConv.id, text, opts)
      await app.kernel.waitForIdle(initialConv.id)
    },
    capture(): FauxResponseStep {
      return (context) => {
        requests.push({
          roles: context.messages.map((m) => m.role),
          systemSections: context.messages
            .filter((m) => m.role === 'system')
            .flatMap((m) => Object.values((m as { sections?: Record<string, string> }).sections ?? {})),
          userTexts: context.messages
            .filter((m) => m.role === 'user')
            .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
          assistantTexts: context.messages
            .filter((m) => m.role === 'assistant')
            .flatMap((m) => m.content.filter((c): c is { type: 'text'; text: string } => c.type === 'text').map((c) => c.text)),
        })
        return fauxAssistantMessage('（未脚本化响应：测试应显式 setResponses）')
      }
    },
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return env
}

/** 声明技能包（真实文件：SKILL.md + references/*.md）。 */
function writeSkill(dataDir: string, id: string, skillMd: string, refs: Record<string, string>): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  const refDir = join(dir, 'references')
  if (!existsSync(refDir)) mkdirSync(refDir)
  for (const [name, content] of Object.entries(refs)) writeFileSync(join(refDir, name), content)
}

/** sqlite 全表字节级扫描：返回包含 needle 的表名集合（secret 不落库断言）。 */
function sqliteTablesContaining(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hits: string[] = []
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]
      const serialized = rows.map((r) => JSON.stringify(r)).join('\n')
      if (serialized.includes(needle)) hits.push(name)
    }
    return hits
  } finally {
    db.close()
  }
}

/** 断言拒绝：优先匹配 HelmError(code)，同时接受服务层原生 Error + message。 */
async function rejectsExplicitly(
  fn: () => Promise<unknown>,
  expected: { code?: string; message: RegExp },
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      if (expected.code !== undefined) {
        assert.ok(err instanceof HelmError, `应为 HelmError，实际 ${String(err)}`)
        assert.equal(err.code, expected.code)
      }
      assert.match(err instanceof Error ? err.message : String(err), expected.message)
      return true
    },
    `应显式拒绝：${expected.message}`,
  )
}

// ---------------------------------------------------------------------------
// 1. profile/memory 自举 + 真实回合 + before_turn sections 真实进入模型请求
// ---------------------------------------------------------------------------

test('集成1: createHelm 组合——profile/memory 默认协同、locked 保护、SYSTEM/MEMORY sections 真实进入模型请求、update_memory 跨回合持久', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 修复后的 plugins getter 非 undefined（runtime 集成修复目标）；测试按契约直接消费
    const host = kernel.plugins!

    // --- 自举：locked builtin:profile + 默认启用可停用的 builtin:memory
    const profileSummary = host.list().find((p) => p.id === 'builtin:profile')
    assert.ok(profileSummary, 'builtin:profile 应经 createHelm 注册')
    assert.equal(profileSummary.locked, true)
    assert.equal(profileSummary.enabled, true)
    assert.ok(profileSummary.tools.includes('load_skill'))
    await rejectsExplicitly(() => host.disable('builtin:profile'), { code: 'plugin_locked', message: /锁定/ })
    await rejectsExplicitly(() => host.unregister('builtin:profile'), { code: 'plugin_locked', message: /锁定/ })
    const memorySummary = host.list().find((p) => p.id === 'builtin:memory')
    assert.ok(memorySummary, 'builtin:memory 应经 createHelm 注册')
    assert.equal(memorySummary.locked, false)
    assert.equal(memorySummary.enabled, true)
    assert.ok(memorySummary.tools.includes('update_memory'))
    assert.ok(memorySummary.actions.includes('get') && memorySummary.actions.includes('set') && memorySummary.actions.includes('configure'))

    // --- 根会话 #1 由 createHelm 创建（真实 SQLite 持久）
    const conv = kernel.getConversation(env.initialConvId)
    assert.equal(conv.id, env.initialConvId)
    assert.equal(conv.profileId, 'assistant')

    // --- 首轮请求：before_turn sections 经真实 system 消息进入模型（faux 捕获）
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    assert.equal(env.requests.length, 1, '首轮恰好一次模型请求')
    const first = env.requests[0]!
    assert.ok(first.roles.includes('system'), '请求应含 role=system 消息（sections 真实注入）')
    const allText = first.systemSections.join('\n') + first.userTexts.join('\n')
    assert.ok(first.systemSections.some((s) => s.includes('# System Prompt')), 'SYSTEM.md 应经 sections 注入')
    assert.ok(allText.includes('<memory>'), 'MEMORY.md 应经 sections 注入（<memory> 包裹）')

    // --- 真实工具链路：faux 发起 update_memory → 文件追加 → 下一轮请求可见
    const MEMORY_FACT = 'FAVORITE_COLOR=青瓷绿'
    env.requests.length = 0
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('update_memory', { text: MEMORY_FACT, mode: 'append' })],
        { stopReason: 'toolUse' },
      ),
      env.capture(),
    ])
    await env.submitAndWait('请记住我最喜欢的颜色是青瓷绿')

    const memoryFile = await new MemoryStore(createProfileFileHost(kernel.dataDir)).getMemory('assistant')
    assert.ok(memoryFile.includes(MEMORY_FACT), 'MEMORY.md 应含新记忆（真实文件写入）')

    // 收尾轮请求带新记忆（跨模块：工具写入 → before_turn 重读 → 模型请求）
    const afterTurn = env.requests[0]!
    assert.ok(
      afterTurn.systemSections.join('\n').includes(MEMORY_FACT),
      '写入后的请求 system sections 应含新记忆',
    )

    // --- 第三轮：跨回合持久（记忆不是只在工具当轮可见）
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('我之前说过喜欢什么颜色？')
    assert.ok(
      env.requests[0]!.systemSections.join('\n').includes(MEMORY_FACT),
      '新回合请求仍含记忆',
    )

    // 持久化核验：entry 真实落库（同一 state.sqlite）
    assert.ok(
      sqliteTablesContaining(env.dbPath, MEMORY_FACT).length > 0,
      '记忆内容应真实持久化（pi_entries）',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. load_skill：references 可读 + 越界拒绝（真实 SkillService 防御）
// ---------------------------------------------------------------------------

test('集成2: load_skill 读取 SKILL.md 与 references/ 子文件，路径穿越/绝对路径/未知技能被显式拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    writeSkill(
      env.dataDir,
      'deploy-playbook',
      '---\nname: 部署手册\ndescription: 发布流程\n---\n# 部署\n见 references/。',
      { 'rollback.md': '回滚：执行 helm rollback --canary', 'db-migrate.md': '迁移前备份 state.sqlite' },
    )

    const host = env.app.kernel.plugins!
    const readMain = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook' },
      { conversationId: env.initialConvId },
    )) as { text: string }
    assert.ok(readMain.text.includes('部署'), '缺省读取 SKILL.md')

    const readRef = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook', path: 'references/rollback.md' },
      { conversationId: env.initialConvId },
    )) as { text: string }
    assert.ok(readRef.text.includes('helm rollback'), '应能按需读取 references 子文件')

    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '../profiles/assistant/MEMORY.md' }, { conversationId: env.initialConvId }),
      { message: /路径穿越|入参校验失败/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '/etc/passwd' }, { conversationId: env.initialConvId }),
      { message: /绝对路径|入参校验失败/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: env.initialConvId }),
      { message: /不存在|no-such-skill/ },
    )

    // 模型目录注入：before_turn 的 <available_skills> 段含技能与 references 路径
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('读一下 db-migrate 手册')
    const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
    assert.ok(catalog, '<available_skills> 段应注入模型请求')
    assert.ok(catalog!.includes('deploy-playbook'), '目录应含技能 id')
    assert.ok(catalog!.includes('references/db-migrate.md'), '目录应含 references 路径')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.5 helm-cli 系统级内置技能自举（builtin:profile service.start 幂等补齐）
// ---------------------------------------------------------------------------

test('集成2.5: createHelm 启动即同步 helm-cli 技能（受管覆盖），load_skill 可读 SKILL.md 与三个 references，重启覆盖回源码版本', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 启动即包含 helm-cli（managedByPlugin = builtin:profile，含三个 references）
    const skills = await kernel.skills.list()
    const summary = skills.find((s) => s.id === 'helm-cli')
    assert.ok(summary, 'helm-cli 技能应经 builtin:profile 启动自举')
    assert.equal(summary.managedByPlugin, 'builtin:profile')
    for (const ref of [
      'references/workflows-and-agents.md',
      'references/skill-and-plugin-dev.md',
      'references/plugin-client-code-splitting.md',
    ]) {
      assert.ok(summary.references.includes(ref), `references 应含 ${ref}`)
    }
    // generative-ui 技能由 builtin:json-render 插件自举（默认启用），随插件启停过滤
    const genUi = skills.find((sk) => sk.id === 'generative-ui')
    assert.ok(genUi, 'generative-ui 技能应经 builtin:json-render 启动自举')
    assert.equal(genUi.managedByPlugin, 'builtin:json-render')

    // 普通回合只注入技能目录，不把 UI/工作流手册全文塞入常驻上下文。
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    const sections = env.requests[0]!.systemSections.join('\n')
    assert.ok(sections.includes('helm-cli'), '普通回合应能发现内建技能')
    assert.ok(sections.includes('generative-ui'), '目录应含 json-render 插件技能（富展示入口）')
    assert.ok(!sections.includes('MetricGrid'), 'UI 组件字典不应常驻')
    assert.ok(!sections.includes('workflow(ref, args?)'), '工作流手册不应常驻')

    // load_skill 工具链路：SKILL.md 与三个 references 均可读且内容实质
    const host = kernel.plugins!
    const readSkill = (path?: string) =>
      host.executeTool(
        'load_skill',
        path === undefined ? { skillId: 'helm-cli' } : { skillId: 'helm-cli', path },
        { conversationId: env.initialConvId },
      ) as Promise<{ text: string }>
    const main = await readSkill()
    assert.ok(main.text.includes('helm') && main.text.includes('--json'), 'SKILL.md 应含 CLI 铁律')
    const ui = await host.executeTool(
      'load_skill',
      { skillId: 'generative-ui' },
      { conversationId: env.initialConvId },
    ) as { text: string }
    assert.ok(ui.text.includes('```ui'), 'generative-ui 技能应含围栏用法')
    assert.ok(ui.text.includes('primitives.md'), '应指向原语契约 references')
    const wf = await readSkill('references/workflows-and-agents.md')
    assert.ok(wf.text.includes('pipeline') && wf.text.includes('resumeFromRunId'), 'workflows 应含编排 API 与断点重放')
    const dev = await readSkill('references/skill-and-plugin-dev.md')
    assert.ok(dev.text.includes('definePlugin') && dev.text.includes('ctx.action'), 'skill-and-plugin-dev 应含插件开发指南')
    const splitting = await readSkill('references/plugin-client-code-splitting.md')
    assert.ok(
      splitting.text.includes('__helm_import_chunk') && splitting.text.includes('import()') && splitting.text.includes('helm plugins doctor'),
      'plugin-client-code-splitting 应含 AI 使用规则、宿主桥接禁用项与验证命令',
    )

    // 重启（重建 app）后受管覆盖：磁盘手工篡改的 SKILL.md 与 reference 回到
    // 源码版本，被删的 reference 补齐；用户自建技能不受影响且仍可写
    const customMain = '---\nname: helm-cli\ndescription: 用户改写\n---\n我的版本\n'
    const customRef = '# 我改过的 UI 手册\n'
    writeFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), customMain)
    writeFileSync(join(env.dataDir, 'skills', 'generative-ui', 'SKILL.md'), customRef)
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'))
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'))
    writeSkill(env.dataDir, 'user-skill', '---\nname: user-skill\ndescription: 用户自建\n---\n正文\n', { 'notes.md': '# 用户笔记\n' })
    await env.app.close()

    const faux2 = fauxProvider()
    const models2 = createModels()
    models2.setProvider(faux2.provider)
    const app2 = await createHelm({ dataDir: env.dataDir, cwd: env.dataDir, model: 'faux/faux-1', models: models2 })
    try {
      // 受管技能：篡改文件被覆盖回源码版本，缺失 reference 被补齐
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.skillMd,
        '重启后 SKILL.md 必须回到源码版本',
      )
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'workflows-and-agents.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['workflows-and-agents.md']!,
        '重启后受管 reference 必须回到源码版本',
      )
      const restored = readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'), 'utf8')
      assert.equal(restored, HELM_CLI_SKILL_ASSET.references['skill-and-plugin-dev.md']!, '缺失的 reference 被补齐为源码版本')
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['plugin-client-code-splitting.md']!,
        '缺失的代码分割 reference 被补齐为源码版本',
      )
      const again = await app2.kernel.skills.list()
      assert.equal(again.find((s) => s.id === 'helm-cli')?.description, HELM_CLI_SKILL_ASSET.skillMd.match(/description: (.+)/)?.[1])

      // 受管技能写入口：服务边界 403 managed_skill_readonly
      await assert.rejects(
        () => app2.kernel.skills.writeFile('helm-cli', 'SKILL.md', '篡改'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'managed_skill_readonly')
          assert.equal(err.status, 403)
          return true
        },
      )

      // 用户自建技能：内容不被覆盖、仍可写
      assert.ok(readFileSync(join(env.dataDir, 'skills', 'user-skill', 'SKILL.md'), 'utf8').includes('用户自建'), '用户自建技能不被受管覆盖触碰')
      await app2.kernel.skills.writeFile('user-skill', 'references/extra.md', '# 用户新增\n')
      assert.ok(
        readFileSync(join(env.dataDir, 'skills', 'user-skill', 'references', 'extra.md'), 'utf8').includes('用户新增'),
        '用户自建技能仍可写',
      )
    } finally {
      await app2.close()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.7 Profile skills 白名单：双 Profile 隔离、[] 禁用、插件启停同步过滤
// ---------------------------------------------------------------------------

test('集成2.7: Profile skills 白名单——双 Profile 目录隔离、[] 无目录且拒绝、白名单内 references 可读、插件启停同步、运行时改写下轮生效', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!

    // 三个用户技能：普通甲/乙 + 插件托管技能（frontmatter 声明托管者）
    writeSkill(
      env.dataDir,
      'alpha-guide',
      '---\nname: Alpha 手册\ndescription: 甲\n---\n# Alpha\n见 references/。',
      { 'intro.md': 'Alpha 引言：只入白名单。' },
    )
    writeSkill(
      env.dataDir,
      'beta-guide',
      '---\nname: Beta 手册\ndescription: 乙\n---\n# Beta\n正文。',
      {},
    )
    writeSkill(
      env.dataDir,
      'managed-guide',
      '---\nname: 托管手册\ndescription: 托管\nmanagedByPlugin: builtin:superagent\n---\n# 托管\n正文。',
      {},
    )

    // 双 Profile：白名单只含 alpha-guide；全禁 Profile skills=[]
    await kernel.profiles.save({ id: 'white-profile', name: '白名单', tags: [], skills: ['alpha-guide'] })
    await kernel.profiles.save({ id: 'none-profile', name: '全禁', tags: [], skills: [] })
    const convWhite = await kernel.createConversation({ title: '白名单会话', profileId: 'white-profile' })
    const convNone = await kernel.createConversation({ title: '全禁会话', profileId: 'none-profile' })

    // ① 白名单内技能可读，references 子文件同规则可读
    const main = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(main.text.includes('Alpha'), '白名单内 SKILL.md 可读')
    const ref = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide', path: 'references/intro.md' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(ref.text.includes('白名单'), '白名单内 references 子文件可读')

    // ② 白名单外（在目录里但不在 profile.skills）→ 403 skill_not_available
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'beta-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /不可用/ },
    )

    // ③ [] Profile：目录不注入 + 全部技能拒绝（含 helm-cli 内置技能）
    {
      // 用 kernel.submitInput 直接驱动全禁会话（faux 捕获该回合 sections）
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convNone.id, '全禁回台')
      await kernel.waitForIdle(convNone.id)
      const catalogNone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogNone, undefined, 'skills=[] 的 Profile 不得注入技能目录')
    }
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'alpha-guide' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /不可用/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'helm-cli' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /不可用/ },
    )

    // ④ 默认 assistant Profile（缺省）：全部可用技能注入（含 helm-cli 与白名单外的 beta）
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await env.submitAndWait('缺省目录')
      const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalog, '缺省 Profile 应注入目录')
      for (const id of ['helm-cli', 'alpha-guide', 'beta-guide']) {
        assert.ok(catalog!.includes(`id="${id}"`), `缺省目录应含 ${id}`)
      }
    }

    // ⑤ 白名单 Profile 目录：只含白名单内技能，不含其它（含托管的 managed-guide 未启用插件）
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, '白名单回台')
      await kernel.waitForIdle(convWhite.id)
      const catalogW = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogW, '白名单 Profile 应注入目录')
      assert.ok(catalogW!.includes('id="alpha-guide"'), '目录应含白名单内技能')
      for (const absent of ['beta-guide', 'helm-cli', 'managed-guide']) {
        assert.ok(!catalogW!.includes(`id="${absent}"`), `目录不得含 ${absent}`)
      }
      // 白名单 Profile 目录也不含 helm-cli：SYSTEM_DEFAULT 指引「含 helm-cli 时」才加载的条件语义生效
    }

    // ⑥ 插件托管技能：插件停用（superagent 默认未启用）→ 白名单内也 403
    await kernel.profiles.save({ id: 'white-profile', name: '白名单', tags: [], skills: ['alpha-guide', 'managed-guide'] })
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /不可用|停用/ },
    )
    // 启用插件后同一技能即时可读（enabledPluginIds 同回合重读）
    await host.enable('builtin:superagent')
    {
      const managed = (await host.executeTool(
        'load_skill',
        { skillId: 'managed-guide' },
        { conversationId: convWhite.id },
      )) as { text: string }
      assert.ok(managed.text.includes('托管'), '插件启用后托管技能可读')
    }
    // 目录同步：启用后白名单含托管技能 → 目录出现
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, '启用托管后回台')
      await kernel.waitForIdle(convWhite.id)
      const catalogE = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogE?.includes('id="managed-guide"'), '插件启用后目录应含托管技能')
    }
    await host.disable('builtin:superagent')
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /不可用|停用/ },
    )

    // ⑦ 运行时修改 Profile（改白名单）下一回合生效：白名单清成 [] 后目录消失
    await kernel.profiles.save({ id: 'white-profile', name: '白名单', tags: [], skills: [] })
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, '改为全禁后回台')
      await kernel.waitForIdle(convWhite.id)
      const catalogGone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogGone, undefined, 'Profile 改为 [] 后下回合目录即消失')
    }

    // ⑧ 未知技能 404（不泄漏内容）；白名单内但未安装 → 404 同样
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: convWhite.id }),
      { code: 'not_found', message: /不存在/ },
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. SecretStash：真实秘密值不进 SQLite、不进模型请求、SSE 帧
// ---------------------------------------------------------------------------

test('集成3: 双引号+换行秘密值不出现在 SQLite 任何表、模型请求与 SSE 帧中；占位符可安全流转', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 双引号 + 换行：只对 JSON.stringify 后文本脱敏的朴素实现会漏这种值
    const SECRET_TRICKY = ['quote"', 'line'].join('\n')
    const placeholder = kernel.services.stash.put(env.initialConvId, 'TRICKY_TOKEN', SECRET_TRICKY)
    assert.match(placeholder, /^\[REDACTED:stash:[0-9a-f-]{36}\]$/)

    // 模型回合：占位符入上下文，秘密值永不达 provider
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(`请用令牌 ${placeholder} 部署`)
    const req = env.requests[0]!
    assert.ok(req.userTexts.join('\n').includes(placeholder), '占位符可正常进入上下文')
    const reqAll = req.systemSections.join('\n') + req.userTexts.join('\n') + req.assistantTexts.join('\n')
    assert.ok(!reqAll.includes(SECRET_TRICKY), '秘密值不得进入任何模型消息')

    // envFor 会话隔离
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], SECRET_TRICKY)
    assert.equal(kernel.services.stash.envFor(999)['TRICKY_TOKEN'], undefined)

    // SSE 帧（EventHub publish 统一脱敏）：订阅后发布含秘密 payload，帧中只有占位符
    const frames: string[] = []
    kernel.events.subscribe((frame) => frames.push(JSON.stringify(frame)))
    kernel.events.publish('notification', { level: 'info', title: '部署', body: `令牌 ${SECRET_TRICKY} 已用` })
    const joined = frames.join('\n')
    assert.ok(!joined.includes(SECRET_TRICKY), 'SSE 帧不得含秘密明文')
    assert.ok(!joined.includes('quote\\"'), 'SSE 帧不得含秘密 JSON 转义形态')
    assert.ok(joined.includes(placeholder), 'SSE 帧应保留占位符形态')

    // 全表字节扫描（回合 + SSE 已落库后）
    assert.deepEqual(
      sqliteTablesContaining(env.dbPath, SECRET_TRICKY),
      [],
      '秘密值不得出现在 state.sqlite 任何表',
    )

    // 结构化脱敏对照：redactJsonValue 递归值级替换不漏双引号换行
    const obj = { text: `前缀 ${SECRET_TRICKY} ${placeholder}` }
    const redacted = redactJsonValue(obj, (t) => kernel.services.stash.redact(t)) as { text: string }
    assert.ok(!redacted.text.includes('line'), '值级脱敏后不得存留换行段')
    assert.ok(!redacted.text.includes('quote'), '值级脱敏后不得存留引号段')
    assert.ok(redacted.text.includes(placeholder), '脱敏后保留占位符')

    // clear 后 stash 语义销毁
    kernel.services.stash.clear()
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], undefined)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. ctx.action 五端共享 validator：invokeAction / executeTool / HTTP / 持久化 doc
// ---------------------------------------------------------------------------

test('集成4: 插件 ctx.action 共享 Schema 校验器——合法执行、非法 400 不执行 handler、合法 null 不伪造、doc 真实持久', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!
    const calls: string[] = []

    const probePlugin: PluginDefinition = {
      id: 'test:probe',
      name: '集成探针',
      definePlugin(ctx) {
        ctx.action<{ n: number }, { doubled: number }>({
          id: 'double',
          description: '翻倍',
          cli: { command: ['probe', 'double'] },
          inputSchema: {
            type: 'object',
            properties: { n: { type: 'number' } },
            required: ['n'],
            additionalProperties: false,
          },
          outputSchema: {
            type: 'object',
            properties: { doubled: { type: 'number' } },
            required: ['doubled'],
            additionalProperties: false,
          },
          handler: (input) => {
            calls.push(`double:${input.n}`)
            return { doubled: input.n * 2 }
          },
        })
        // 合法 null 输出：不得被伪造为 {ok:true} 之类
        ctx.action<{ ok: boolean }, null>({
          id: 'null_out',
          description: '返回 null',
          inputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          outputSchema: { type: 'null' },
          handler: () => null,
        })
        ctx.tool<{ text: string }>({
          name: 'probe_echo',
          description: '回声',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1 } },
            required: ['text'],
            additionalProperties: false,
          },
          execute: (input) => {
            calls.push(`echo:${input.text}`)
            return { echoed: input.text }
          },
        })
        const probeDoc = ctx.doc('counter', { ran: 0 })
        probeDoc.set({ ran: 1 })
      },
    }
    await host.register(probePlugin)

    // 合法输入真实执行
    const ok = (await host.invokeAction('test:probe', 'double', { n: 21 })) as { doubled: number }
    assert.equal(ok.doubled, 42)

    // 非法输入：同一校验器拒绝（HTTP 400 / CLI 非零的共同来源），handler 不执行
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 'x' }), { code: 'validation_error', message: /校验失败/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', {}), { code: 'validation_error', message: /校验失败/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 1, extra: true }), { code: 'validation_error', message: /校验失败/ })

    // 合法 null 输出原样返回（不伪造 ok）
    const nullOut = await host.invokeAction('test:probe', 'null_out', { ok: true })
    assert.equal(nullOut, null)

    // 工具路径同权校验
    const echoed = (await host.executeTool('probe_echo', { text: 'hi' }, { conversationId: 1 })) as { echoed: string }
    assert.equal(echoed.echoed, 'hi')
    await rejectsExplicitly(() => host.executeTool('probe_echo', { text: '' }, { conversationId: 1 }), { code: 'validation_error', message: /校验失败/ })
    assert.deepEqual(calls, ['double:21', 'echo:hi'], '非法输入不执行 handler')

    // 未知动作/工具显式 404
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'nope', {}), { code: 'unknown_action', message: /未声明/ })
    await rejectsExplicitly(() => host.executeTool('nope', {}, { conversationId: 1 }), { code: 'unknown_tool', message: /未注册/ })

    // 运行中动作时插件 disable 显式 409（不静默拆注册表）：真挂起动作占住 task tracker
    let release2!: () => void
    const gate2 = new Promise<void>((r) => (release2 = r))
    const slowPlugin: PluginDefinition = {
      id: 'test:slow',
      name: '慢动作',
      definePlugin(ctx) {
        ctx.action<Record<string, never>, { done: boolean }>({
          id: 'slow',
          description: '慢',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
            additionalProperties: false,
          },
          handler: async () => {
            await gate2
            return { done: true }
          },
        })
      },
    }
    await host.register(slowPlugin)
    const slow = host.invokeAction('test:slow', 'slow', {})
    const dis = host.disable('test:slow')
    await assert.rejects(dis, (err: unknown) => {
      assert.ok(err instanceof HelmError, `应为 HelmError，实际 ${String(err)}`)
      assert.equal(err.code, 'plugin_has_live_tasks')
      return true
    })
    release2()
    assert.deepEqual(await slow, { done: true })
    // 任务结束后 disable 成功
    await host.disable('test:slow')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. 持久会话重启：同一 dataDir 重开 createHelm，#1/历史/SSE seq 保留
// ---------------------------------------------------------------------------

test('集成5: 重启后播种会话与历史经真实 SQLite 保留，faux 续接可见完整历史，SSE seq 持久不回退', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dir, 'state.sqlite')

  const build = async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const app = await createHelm({ dataDir: dir, cwd: dir, model: 'faux/faux-1', models })
    return { faux, app }
  }

  const MARK = '重启前的关键结论-PERSIST-MARK'
  let seqAfterFirst = 0
  const first = await build()
  const firstConv = first.app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (firstConv === undefined) throw new Error('首次启动应播种 assistant 入口会话')
  try {
    first.faux.setResponses([fauxAssistantMessage(`已记录：${MARK}`)])
    await first.app.kernel.submitInput(firstConv.id, `请记住：${MARK}`)
    await first.app.kernel.waitForIdle(firstConv.id)
    assert.equal(first.faux.state.callCount, 1)
    seqAfterFirst = first.app.kernel.events.seq
    assert.ok(seqAfterFirst > 0, '第一回合应推进 SSE seq')
  } finally {
    await first.app.close()
  }

  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    assert.ok(convs.some((c) => c.id === firstConv.id), '重启后播种的入口会话仍在')
    assert.ok(
      second.app.kernel.events.seq >= seqAfterFirst,
      `重启后 SSE seq（${second.app.kernel.events.seq}）应 >= 首回合后（${seqAfterFirst}）`,
    )
    const conv = second.app.kernel.getConversation(firstConv.id)
    assert.ok(conv.completionSeq >= 1, 'completionSeq 跨重启保留')

    // 续接回合：模型可见完整历史
    const seen: string[] = []
    second.faux.setResponses([
      (ctx) => {
        seen.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('已回顾历史')
      },
    ])
    await second.app.kernel.submitInput(firstConv.id, '回顾一下我们说过什么')
    await second.app.kernel.waitForIdle(firstConv.id)
    assert.ok(seen[0]!.includes(MARK), '重启后模型请求应含历史消息')
    assert.ok(sqliteTablesContaining(dbPath, MARK).length > 0, '历史 entry 应持久化')
  } finally {
    await second.app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. HTTP 真实往返：真 startHub(port 0) + 真 app.kernel
// ---------------------------------------------------------------------------

async function makeHttpEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-http-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })

  // 播种入口会话 ID（首个 assistant 无父链会话；此环境内仍存在）
  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('makeHttpEnv：首次启动应播种 assistant 入口会话')

  // 集成探针插件：echo 动作回显 stash 真实值（验证出站脱敏链路）
  const stash = app.kernel.services.stash
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const trickyPlaceholder = stash.put(initialConv.id, 'TRICKY_TOKEN', SECRET_TRICKY)

  await app.kernel.plugins!.register({
    id: 'test:probe',
    name: '集成探针',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { text: string }>({
        id: 'echo',
        description: '回显（含秘密脱敏验证）',
        cli: { command: ['probe', 'echo'] },
        inputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        handler: (input) => ({ text: `${input.text} ${SECRET_TRICKY} ${trickyPlaceholder}` }),
      })
      ctx.action<{ n: number }, { doubled: number }>({
        id: 'double',
        description: '翻倍',
        cli: { command: ['probe', 'double'] },
        inputSchema: {
          type: 'object',
          properties: { n: { type: 'number' } },
          required: ['n'],
          additionalProperties: false,
        },
        outputSchema: {
          type: 'object',
          properties: { doubled: { type: 'number' } },
          required: ['doubled'],
          additionalProperties: false,
        },
        handler: (input) => ({ doubled: input.n * 2 }),
      })
      ctx.route({
        method: 'GET',
        path: '/ping',
        public: true,
        handler: () => new Response('{"ok":true,"via":"plugin-route"}', { headers: { 'content-type': 'application/json' } }),
      })
    },
  })

  // 真 startHub：port 0（内核分配），kernel 全部来自 createHelm
  const hub = await startHub({ kernel: app.kernel as never, port: 0 })
  return {
    hub, app, faux, dataDir, SECRET_TRICKY, trickyPlaceholder, initialConvId: initialConv.id,
    rootPassword: '集成测试Root密码八位',
    async close() {
      await hub.close()
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('集成6: HTTP 真实往返——鉴权/初始会话可删/动作校验同权/secret 不泄漏出站/SSE snapshot 首帧/插件 public 路由', { timeout: 60_000 }, async () => {
  const env = await makeHttpEnv()
  let token: string | undefined
  try {
    const base = env.hub.url
    const call = async (
      method: string,
      path: string,
      opts?: { body?: unknown; auth?: boolean },
    ): Promise<{ status: number; body: string }> => {
      const headers: Record<string, string> = {}
      if (opts?.body !== undefined) headers['content-type'] = 'application/json'
      if (opts?.auth !== false && token !== undefined) headers.authorization = `Bearer ${token}`
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(opts?.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
      })
      return { status: response.status, body: await response.text() }
    }

    // --- 鉴权边界
    const anon = await call('GET', '/api/conversations', { auth: false })
    assert.equal(anon.status, 401)
    const statusBefore = await call('GET', '/api/auth/status', { auth: false })
    assert.equal(statusBefore.status, 200)
    assert.equal(JSON.parse(statusBefore.body).configured, false)

    const setup = await call('POST', '/api/auth/setup', { body: { password: env.rootPassword }, auth: false })
    assert.equal(setup.status, 200)
    token = JSON.parse(setup.body).token as string
    assert.ok(typeof token === 'string' && token.length > 0)
    const badLogin = await call('POST', '/api/auth/login', { body: { password: '错误密码但足够长' }, auth: false })
    assert.equal(badLogin.status, 401)
    const relogin = await call('POST', '/api/auth/login', { body: { password: env.rootPassword }, auth: false })
    assert.equal(relogin.status, 200)

    // --- 初始入口会话可删（id 级豁免已移除；通用保护为插件管理权 409）
    const initialId = env.initialConvId
    const delInitial = await call('DELETE', `/api/conversations/${initialId}`)
    assert.equal(delInitial.status, 200, `删除初始会话应成功：${delInitial.body}`)
    const goneInitial = await call('GET', `/api/conversations/${initialId}`)
    assert.equal(goneInitial.status, 404)
    // 重建普通会话供后续回合使用
    const created = await call('POST', '/api/conversations', { body: { title: '集成会话', profileId: 'assistant' } })
    assert.equal(created.status, 201)
    const httpConvId = (JSON.parse(created.body) as { id: number }).id

    // --- 真实模型回合（HTTP submit → 真 kernel → faux）
    const conv = await call('GET', `/api/conversations/${httpConvId}`)
    assert.equal(conv.status, 200)
    assert.equal(JSON.parse(conv.body).id, httpConvId)
    env.faux.setResponses([fauxAssistantMessage('HTTP 回合完成')])
    // 非等待提交：路由默认 submission accepted（202 + {submissionId}），不伪造同步回答
    const sent = await call('POST', `/api/conversations/${httpConvId}/input`, { body: { text: '你好，集成测试' } })
    assert.equal(sent.status, 202)
    const submission = JSON.parse(sent.body) as { submissionId: string }
    assert.ok(typeof submission.submissionId === 'string' && submission.submissionId.length > 0, '202 应携带 submissionId')
    await env.app.kernel.waitForIdle(httpConvId)
    assert.ok(env.faux.state.callCount >= 1, 'HTTP submit 应触发真实模型回合')

    // 显式等待链：?wait=1 精确等待本次提交的回答（200 ConversationInputResult）
    env.faux.setResponses([fauxAssistantMessage('HTTP 等待回答')])
    const waited = await call('POST', `/api/conversations/${httpConvId}/input?wait=1`, { body: { text: '等待链验证' } })
    assert.equal(waited.status, 200, `wait=1 应返回本次回答：${waited.body}`)
    const waitResult = JSON.parse(waited.body) as { submissionId: string; text: string; entry: { id: string; kind: string } }
    assert.ok(waitResult.submissionId.length > 0)
    assert.equal(waitResult.text, 'HTTP 等待回答')
    assert.ok(waitResult.entry.id, 'wait 结果应含精确回答 entry')

    // --- 动作校验同权：HTTP 非法入参 400 validation_error（与 invokeAction 同一校验器）
    const actionList = await call('GET', '/api/actions')
    assert.equal(actionList.status, 200)
    assert.ok(JSON.parse(actionList.body).some((a: { pluginId: string; id: string }) => a.pluginId === 'test:probe' && a.id === 'echo'))
    const memoryWithoutTarget = await call('POST', '/api/actions/builtin:memory/get', { body: { input: {} } })
    assert.equal(memoryWithoutTarget.status, 400)
    assert.equal(JSON.parse(memoryWithoutTarget.body).error.code, 'validation_error')
    const memoryWithContext = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: {}, conversationId: httpConvId },
    })
    assert.equal(memoryWithContext.status, 200, memoryWithContext.body)
    assert.equal(JSON.parse(memoryWithContext.body).profileId, 'assistant', 'HTTP conversationId 上下文解析当前 Profile')
    const memoryInvalidExplicit = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: 'missing' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidExplicit.status, 404)
    assert.equal(JSON.parse(memoryInvalidExplicit.body).error.code, 'profile_not_found', '失效显式 Profile 不得回退到 HTTP 上下文')
    const memoryInvalidId = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: '../outside' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidId.status, 400)
    assert.equal(JSON.parse(memoryInvalidId.body).error.code, 'validation_error', '非法 Profile ID 在动作边界显式 400')
    const workflowWithoutTarget = await call('POST', '/api/actions/builtin:workflow/run', {
      body: { input: { script: 'export const meta = { name: "no-target", description: "t" }\nreturn 1' } },
    })
    assert.equal(workflowWithoutTarget.status, 400)
    assert.equal(JSON.parse(workflowWithoutTarget.body).error.code, 'validation_error')
    const badAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: 123 } } })
    assert.equal(badAction.status, 400)
    assert.equal(JSON.parse(badAction.body).error.code, 'validation_error')

    // --- HTTP 出站脱敏：echo 动作结果含 stash 真实值时，响应只带占位符。
    // hub 的统一 JsonRedactor（kernel.services.stash.redact）必须在出站前擦除明文。
    const echoAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: '前缀' } } })
    assert.equal(echoAction.status, 200)
    const echoBody = echoAction.body
    assert.ok(!echoBody.includes(env.SECRET_TRICKY), 'HTTP 响应不得含秘密明文（含换行形态）')
    assert.ok(!echoBody.includes('quote\\"'), 'HTTP 响应不得含秘密 JSON 转义形态')
    assert.ok(!echoBody.includes('line'), 'HTTP 响应不得含换行后半段明文')
    assert.ok(echoBody.includes(env.trickyPlaceholder), 'HTTP 响应应保留占位符')

    // --- SSE snapshot 首帧：鉴权后连接即收快照
    const sseResponse = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(sseResponse.headers.get('content-type'), 'text/event-stream')
    const reader = sseResponse.body!.getReader()
    const firstChunk = new TextDecoder().decode((await reader.read()).value)
    assert.ok(firstChunk.includes('event: snapshot'), 'SSE 首帧应为 snapshot')
    assert.ok(firstChunk.includes('"conversations"'), 'snapshot 应含会话清单')
    await reader.cancel().catch(() => {})

    // --- 插件 public 路由豁免鉴权 + encoded pluginId 解码匹配
    const encoded = encodeURIComponent('test:probe')
    const pub = await fetch(`${base}/api/plugins/${encoded}/routes/ping`)
    assert.equal(pub.status, 200)
    assert.equal((JSON.parse(await pub.text()) as { via: string }).via, 'plugin-route')

    // --- workflows：真实引擎经 builtin:workflow 插件动作（/api/actions 同链路）
    const wf = await call('POST', '/api/actions/builtin:workflow/run', {
      body: {
        input: {
          script: 'export const meta = { name: "http-wf", description: "t" }\nreturn args.x',
          args: { x: 7 },
          wait: true,
        },
        conversationId: httpConvId,
      },
    })
    assert.equal(wf.status, 200, `真实 workflow 引擎应接受 run：${wf.body}`)
    const summary = (JSON.parse(wf.body) as { run: { id: string; status: string } }).run
    assert.ok(summary.id.startsWith('wf_'), 'summary 应含 wf_ 前缀 runId')
    assert.ok(['running', 'completed'].includes(summary.status))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. CLI ↔ 真 Hub：进程内 runCli + 异步子进程真 CLI 入口
// ---------------------------------------------------------------------------

test('集成7: CLI↔Hub 真实链路——setup 凭据落盘/status/conversations/send 触发真模型回合/动态动作命令/非法入参非零退出/子进程 CLI', { timeout: 60_000 }, async () => {
  const env = await makeHttpEnv()
  const { runCli } = await import('../../cli/src/index.js')
  const hubUrl = new URL(env.hub.url)

  const run = async (argv: string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ code: number; out: string; err: string }> => {
    let out = ''
    let err = ''
    const code = await runCli(argv, {
      env: {
        HELM_HUB_URL: hubUrl.toString(),
        HELM_DATA_DIR: env.dataDir,
        PATH: process.env.PATH,
        ...extraEnv,
      },
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
    })
    return { code, out, err }
  }

  /**
   * 异步子进程真 CLI：spawn（非 spawnSync——spawnSync 堵死父进程事件循环，
   * 同进程 Hub 测试下子 CLI 的 HTTP 永不响应，是测试方法缺陷而非 CLI 缺陷）。
   * stdio pipes 收集输出；硬超时 kill 防挂起。
   */
  const runCliChildInEnv = (args: string[], timeoutMs = 20_000): Promise<CliRunResult> =>
    runCliChild(
      args,
      { ...process.env, HELM_HUB_URL: hubUrl.toString(), HELM_DATA_DIR: env.dataDir, HELM_TOKEN: '' },
      timeoutMs,
    )

  try {
    // --- 未登录：受保护命令显式报错非零
    const anon = await run(['conversations', 'list', '--json'])
    assert.notEqual(anon.code, 0)
    assert.equal((JSON.parse(anon.err) as { error: { code: string } }).error.code, 'unauthorized')

    // --- setup：真 scrypt 凭据 + 独立 cli-token 文件。
    const setup = await run(['setup', '--password', env.rootPassword, '--json'])
    assert.equal(setup.code, 0, setup.err)
    assert.ok(typeof (JSON.parse(setup.out) as { token: string }).token === 'string')
    const credRaw = JSON.parse(readFileSync(join(env.dataDir, 'cli-token'), 'utf8')) as {
      hubUrl?: string; token?: string
    }
    assert.ok(credRaw.token, '登录 Token 应保存在 cli-token')
    assert.ok(credRaw.hubUrl?.startsWith('http://127.0.0.1:'), 'hubUrl 应持久化')

    // --- status：公开端点
    const status = await run(['status', '--json'])
    assert.equal(status.code, 0, status.err)
    assert.equal(JSON.parse(status.out).configured, true)

    // --- conversations list：经凭据文件 token 鉴权
    const list = await run(['conversations', 'list', '--json'])
    assert.equal(list.code, 0, list.err)
    const convs = JSON.parse(list.out) as Array<{ id: number; profileId: string }>
    assert.ok(convs.some((c) => c.profileId === 'assistant'), '应列出 assistant 会话')

    // --- memory 动态命令：真实 CLI ↔ Hub，经 --current 解析会话所属 Profile
    await env.app.kernel.services.profiles.save({ id: 'coder', name: 'Coder', tags: [] })
    const memoryConversation = await env.app.kernel.createConversation({ profileId: 'coder' })
    const currentEnv = { HELM_CONVERSATION_ID: String(memoryConversation.id) }
    const memorySet = await run(['memory', 'set', '--current', '--text', '# Coder memory', '--json'], currentEnv)
    assert.equal(memorySet.code, 0, memorySet.err)
    assert.equal(JSON.parse(memorySet.out).profileId, 'coder')
    const memoryGet = await run(['memory', 'get', '--current', '--json'], currentEnv)
    assert.equal(memoryGet.code, 0, memoryGet.err)
    assert.equal(JSON.parse(memoryGet.out).content, '# Coder memory')
    const memoryConfigure = await run(['memory', 'configure', '--current', '--enabled=false', '--json'], currentEnv)
    assert.equal(memoryConfigure.code, 0, memoryConfigure.err)
    assert.equal(JSON.parse(memoryConfigure.out).enabled, false)
    const memoryDisabled = await run(['memory', 'get', '--current', '--json'], currentEnv)
    assert.equal(JSON.parse(memoryDisabled.out).enabled, false)
    const explicitMemory = await run(['memory', 'get', '--profile-id', 'assistant', '--current', '--json'], currentEnv)
    assert.equal(explicitMemory.code, 0, explicitMemory.err)
    assert.equal(JSON.parse(explicitMemory.out).profileId, 'assistant', '显式 --profile-id 优先于 --current')
    const memoryNoTarget = await run(['memory', 'get', '--json'])
    assert.notEqual(memoryNoTarget.code, 0)
    assert.equal((JSON.parse(memoryNoTarget.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- send：CLI 提交 → 真实模型回合
    const callCountBefore = env.faux.state.callCount
    env.faux.setResponses([fauxAssistantMessage('CLI 回合完成')])
    const send = await run(['send', '1', '你好 CLI 集成', '--json'])
    assert.equal(send.code, 0, send.err)
    await env.app.kernel.waitForIdle(env.initialConvId)
    assert.ok(env.faux.state.callCount > callCountBefore, 'CLI send 应触发真实模型回合')

    // --- 动态动作命令：GET /api/actions 生成 helm probe double
    const doubled = await run(['probe', 'double', '--n', '21', '--json'])
    assert.equal(doubled.code, 0, doubled.err)
    assert.equal(JSON.parse(doubled.out).doubled, 42)

    // --- flag 层拦截：number 转换失败非零
    const badFlag = await run(['probe', 'double', '--n', 'abc', '--json'])
    assert.notEqual(badFlag.code, 0)

    // --- 服务端 Schema 拒绝（--input 绕过 flag 转换）：validation_error
    const badSchema = await run(['probe', 'double', '--input', '{"n":"不是数字"}', '--json'])
    assert.notEqual(badSchema.code, 0)
    assert.equal((JSON.parse(badSchema.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- 建一个普通会话供后续子进程 get 验证
    const mkConv = await run(['conversations', 'create', '--title', 'CLI 会话', '--profile-id', 'assistant', '--json'])
    assert.equal(mkConv.code, 0, mkConv.err)
    const cliConvId = (JSON.parse(mkConv.out) as { id: number }).id

    // --- 子进程真 CLI 入口（异步 spawn；父进程事件循环保持响应，Hub 可答）：
    //     setup 已完成，子进程经 cli-token 凭据访问同一真 Hub。
    const childStatus = await runCliChildInEnv(['status', '--json'])
    assert.equal(childStatus.timedOut, false, '子进程 CLI 不得挂起')
    assert.equal(childStatus.code, 0, `子进程 status 失败：${childStatus.err}`)
    assert.equal(JSON.parse(childStatus.out).configured, true)

    const childGet = await runCliChildInEnv(['conversations', 'get', String(cliConvId), '--json'])
    assert.equal(childGet.timedOut, false, '子进程 CLI 不得挂起')
    assert.equal(childGet.code, 0, `子进程 conversations get 失败：${childGet.err}`)
    assert.equal(JSON.parse(childGet.out).id, cliConvId)

    const childAuth = await runCliChildInEnv(['conversations', 'list', '--json'])
    assert.equal(childAuth.timedOut, false)
    assert.equal(childAuth.code, 0, `子进程鉴权应经 cli-token 生效：${childAuth.err}`)
    assert.ok((JSON.parse(childAuth.out) as Array<{ id: number }>).some((c) => c.id === cliConvId))

    // --- 删除初始会话后：工作流无目标明确 400；--current 与显式目标正常
    const delInitial = await run(['conversations', 'delete', String(env.initialConvId), '--json'])
    assert.equal(delInitial.code, 0, `删除初始会话应成功：${delInitial.err}`)
    const goneCheck = await run(['conversations', 'get', String(env.initialConvId), '--json'])
    assert.notEqual(goneCheck.code, 0, '删除后 GET 应非零（404）')

    const workflowScript = (name: string) => `export const meta = { name: "${name}", description: "t" }\nreturn 42`
    const workflowNoTarget = await run(['workflows', 'run', '--script', workflowScript('no-target-after-delete'), '--wait', '--json'])
    assert.notEqual(workflowNoTarget.code, 0)
    assert.equal((JSON.parse(workflowNoTarget.err) as { error: { code: string } }).error.code, 'validation_error')

    const workflowCurrent = await run([
      'workflows', 'run', '--script', workflowScript('current-target'), '--wait', '--current', '--json',
    ], { HELM_CONVERSATION_ID: String(cliConvId) })
    assert.equal(workflowCurrent.code, 0, workflowCurrent.err)
    assert.equal(JSON.parse(workflowCurrent.out).run.conversationId, cliConvId)

    const workflowExplicit = await run([
      'workflows', 'run', '--script', workflowScript('explicit-target'), '--wait', '--conversation-id', String(cliConvId), '--json',
    ])
    assert.equal(workflowExplicit.code, 0, workflowExplicit.err)
    assert.equal(JSON.parse(workflowExplicit.out).run.conversationId, cliConvId)

    const toolRun = await env.app.kernel.plugins!.executeTool(
      'SubagentWorkflow',
      { script: workflowScript('tool-target'), background: false },
      { conversationId: cliConvId, callId: 'workflow-tool-target' },
    ) as { isError?: boolean; structuredOutput?: { summary?: { conversationId?: number } } }
    assert.equal(toolRun.isError, undefined)
    assert.equal(toolRun.structuredOutput?.summary?.conversationId, cliConvId, 'Workflow 工具使用真实当前会话，不依赖 id 1')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// subagent 运行期实时关联：parentToolCallId 写镜像并广播 conversation.upsert
// ---------------------------------------------------------------------------

test('subagent 派生：子会话摘要携带 parentToolCallId 并经 conversation.upsert 广播', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const upserts: Array<{ id: number; parentConversationId?: number; parentToolCallId?: string }> = []
    kernel.events.subscribe((frame) => {
      const event = frame.event
      if (event !== null && typeof event === 'object' && (event as { type?: string }).type === 'conversation.upsert') {
        const conv = (event as { conversation?: { id: number; parentConversationId?: number; parentToolCallId?: string } }).conversation
        if (conv !== undefined) upserts.push({ id: conv.id, parentConversationId: conv.parentConversationId, parentToolCallId: conv.parentToolCallId })
      }
    })
    // 父会话模型调用 subagent 工具；子代理 faux 独立回答。
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: '子任务：检查构建', background: false })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('子代理已返回，任务完成'),
    ])
    // 子会话用同一 faux provider（faux 队列按请求顺序消费：父工具轮 -> 子代理回合 -> 父收尾轮）。
    await env.submitAndWait('请派一个子代理检查构建')

    // 摘要层：派生出的子会话镜像带 parentToolCallId（父会话工具调用 ID）。
    const child = kernel
      .listConversations()
      .find((c) => c.parentConversationId === env.initialConvId && c.parentToolCallId !== undefined)
    assert.ok(child !== undefined, '子会话摘要必须携带 parentToolCallId（运行期实时关联契约）')
    assert.ok(child!.parentToolCallId !== undefined && child!.parentToolCallId !== '')

    // 事件层：conversation.upsert 广播中含该子会话与 parentToolCallId（前端 SSE 即刻可关联）。
    const broadcast = upserts.find((u) => u.id === child!.id && u.parentToolCallId === child!.parentToolCallId)
    assert.ok(broadcast !== undefined, 'conversation.upsert 必须广播含 parentToolCallId 的子会话摘要')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 1：受管 Token —— 受管 bash 中 CLI 完全不依赖磁盘登录
// ---------------------------------------------------------------------------

test('对齐1: 受管 bash 内 CLI conversations get --current 不依赖磁盘登录，HELM_TOKEN 只以脱敏形态流转', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    assert.equal(typeof runtime.setHubUrl, 'function', 'KernelRuntime.setHubUrl 应存在')
    runtime.setHubUrl!(base)

    const tokenGetter = (env.app.kernel as unknown as {
      toolDeps?: { processToken?: () => string }
    }).toolDeps?.processToken
    assert.equal(typeof tokenGetter, 'function', 'toolDeps.processToken 应存在')
    const managedToken = tokenGetter!()

    // CLI 在新临时 dataDir（无 cli-token 磁盘文件）下以 HELM_TOKEN env 直连。
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const cliEnvBase = {
      ...process.env,
      HELM_HUB_URL: base,
      HELM_DATA_DIR: cliDataDir,
      HELM_TOKEN: managedToken,
    }
    try {
      assert.equal(existsSync(join(cliDataDir, 'cli-token')), false, '初始无磁盘登录')

      const got = await runCliChild(
        ['conversations', 'get', '--current', '--json'],
        { ...cliEnvBase, HELM_CONVERSATION_ID: String(ROOT_CONVERSATION_ID) },
      )
      assert.equal(got.timedOut, false, 'CLI 子进程不得挂起')
      assert.equal(got.code, 0, `受管 token CLI 应成功：${got.err}`)
      const summary = JSON.parse(got.out) as { id: number; model?: unknown; entries?: unknown[] }
      assert.equal(summary.id, ROOT_CONVERSATION_ID)
      assert.ok(Array.isArray(summary.entries), 'CLI get 应返回详情（entries 时间线）')
      assert.ok(!got.out.includes(managedToken) && !got.err.includes(managedToken), 'CLI 输出不得回显原始 Token')

      // marker 形态：全局脱敏登记后，任何出口出现的是 [REDACTED] 占位符。
      const marker = env.app.kernel.services.stash.redact(managedToken)
      assert.notEqual(marker, managedToken, '受管 token 必须已被全局脱敏登记')

      // 先订阅并等 snapshot 首帧（证明订阅就绪），再提交含 token 的输入；
      // 收集条件同时要求 entry 与 upsert（upsert 在回合结算时才发布，只在
      // 首个 entry 就退出会漏掉结算帧）。
      const sub = openSseSubscription(
        base,
        userToken,
        (fs) =>
          fs.some((f) => f.includes('event: conversation.entry')) &&
          fs.some((f) => f.includes('event: conversation.upsert')),
      )
      await sub.ready

      const requests: string[] = []
      env.faux.setResponses([
        (ctx) => {
          requests.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('收到')
        },
      ])
      await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, `凭据是 ${managedToken} 请保密`)
      await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
      assert.ok(requests.length > 0, '应捕获模型请求')
      assert.ok(!requests[0]!.includes(managedToken), '模型请求不得含原始受管 Token')

      // SSE 增量（conversation.entry / upsert）不含原始 token。
      const frames = await sub.frames
      const joined = frames.join('\n')
      assert.ok(joined.includes('event: conversation.entry'), '应收到 conversation.entry 增量事件')
      assert.ok(joined.includes('event: conversation.upsert'), '应收到 conversation.upsert 增量事件')
      assert.ok(!joined.includes(managedToken), 'SSE 帧不得含原始受管 Token')

      assert.deepEqual(
        sqliteTablesContaining(env.dbPath, managedToken),
        [],
        'state.sqlite 任何表不得含原始受管 Token',
      )
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 2：受管 bash 中真实执行 CLI（bash 工具子进程 env 携带受管 token）
// ---------------------------------------------------------------------------

test('对齐2: 受管 bash 工具内执行 helm conversations get —— env 注入、exit 0 标记、详情特征回传且 Token 不回显', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    void setupRes

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    runtime.setHubUrl!(base)

    const cliDataDir = join(env.dataDir, 'cli-isolated')
    // 尾部 && echo CLI_OK：CLI exit 0 才会输出该标记（&& 链短路）。
    const cmd = [
      `export HELM_DATA_DIR="${cliDataDir}"`,
      `export HELM_CONVERSATION_ID=${ROOT_CONVERSATION_ID}`,
      `"${process.execPath}" "${tsxCli}" "${cliEntry}" conversations get --current --json`,
      'echo CLI_OK',
    ].join(' && ')

    // faux 第 1 响应发起 bash 工具调用；capture 放在工具后的第 2 响应——
    // 固定终答不会携带工具结果上下文，永远无法捕获。
    const toolResults: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: cmd })], { stopReason: 'toolUse' }),
      (ctx) => {
        toolResults.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('done')
      },
    ])

    await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, '请在受管 shell 中执行 helm conversations get --current --json')
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.ok(toolResults.length > 0, '应捕获工具后模型请求')
    const toolCtx = toolResults[0]!
    const managedToken = (env.app.kernel as unknown as { toolDeps?: { processToken?: () => string } }).toolDeps?.processToken?.()
    assert.ok(managedToken, 'toolDeps.processToken 应存在')
    assert.ok(!toolCtx.includes(managedToken!), '工具结果回传模型不得含原始受管 Token')
    // CLI 真实成功的证据链：exit 0 标记 + detail 的 entries 时间线 + helm.input
    // entry + 根会话标题——不能只见数字 1 就算通过。
    assert.ok(toolCtx.includes('CLI_OK'), '工具输出应含 CLI exit 0 标记 CLI_OK')
    assert.ok(toolCtx.includes('helm.input'), 'CLI 详情应含 helm.input entry（本回合输入已落时间线）')
    assert.ok(toolCtx.includes('个人助理'), 'CLI 详情应含根会话标题')
    assert.ok(toolCtx.includes('entries'), 'CLI 详情应含 entries 时间线字段')
    // toolCtx 是消息数组的 JSON.stringify，CLI 输出内嵌时引号被转义（\"id\": 1）
    assert.ok(/id\\?"?\s*:\s*1\b/.test(toolCtx), 'CLI 详情应含会话 id')
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 3：输入 meta 全链 + 详情分页 + 事件 + snapshot 扩展 + workflow 增量
// ---------------------------------------------------------------------------

test('对齐3: CLI send --meta → helm.input entry → turn_settled 全链；分页首尾无丢；entry/live/plugin.changed/workflow.updated 真实增量', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // 插件：收集 turn_settled inputs（meta 应原样到达）
    const settledInputs: Array<{ origins: string[]; metas: Array<Record<string, unknown> | undefined> }> = []
    await env.app.kernel.plugins.register({
      id: 'test:meta-probe',
      name: 'meta 探针',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledInputs.push({
            origins: payload.inputs.map((i) => i.origin),
            metas: payload.inputs.map((i) => i.meta),
          })
        })
      },
    } satisfies PluginDefinition)

    // 三条订阅全部等 snapshot 首帧就绪后再触发被测行为：
    // A: CLI send 回合的 conversation.entry / conversation.live 增量；
    // B: plugin.changed 启/停两帧；
    // C: 纯脚本 workflow run 的 workflow.updated 完成增量。
    const subA = openSseSubscription(
      base,
      userToken,
      (fs) =>
        fs.some((f) => f.includes('event: conversation.entry')) &&
        fs.some((f) => f.includes('event: conversation.live')),
    )
    const subB = openSseSubscription(
      base,
      userToken,
      (fs) => fs.filter((f) => f.includes('event: plugin.changed')).length >= 2,
    )
    const subC = openSseSubscription(
      base,
      userToken,
      (fs) =>
        fs.some((f) => f.includes('event: workflow.updated') && f.includes('"status":"completed"')),
    )
    await Promise.all([subA.ready, subB.ready, subC.ready])

    // CLI send --meta + --wait
    const meta = { renderer: 'test.render', ticket: 7, nested: { ok: true } }
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    try {
      env.faux.setResponses([fauxAssistantMessage('meta 回合完成')])
      const sent = await runCliChild(
        ['send', String(ROOT_CONVERSATION_ID), '带元数据的输入', '--meta', JSON.stringify(meta), '--wait', '--json'],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir, HELM_TOKEN: userToken },
      )
      assert.equal(sent.timedOut, false)
      if (sent.code !== 0) {
        assert.fail(`send --meta --wait 失败：${sent.err}`)
      }
      // send --wait 返回 ConversationInputResult：text 即本次回答，entry 为回答条目
      const waitResult = JSON.parse(sent.out) as { text: string; entry?: { id: string } }
      assert.equal(waitResult.text, 'meta 回合完成', 'send --wait 应返回本次回答文本')
      assert.ok(waitResult.entry?.id, 'send --wait 应返回本次回答 entry id')
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }

    // turn_settled：meta 全链到达
    await waitFor(() => settledInputs.length > 0)
    assert.equal(settledInputs[0]!.metas.length, 1)
    assert.deepEqual(settledInputs[0]!.metas[0], meta, 'meta 应从 CLI 原样到达 turn_settled')

    // 详情：GET /api/conversations/1 含 helm.input entry 的 data.meta
    const detailRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    assert.equal(detailRes.status, 200)
    const detail = JSON.parse(detailRes.body) as {
      entries: Array<{ kind: string; data?: { meta?: Record<string, unknown>; text?: string }; model?: unknown[] }>
    }
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry, 'detail 应含 helm.input entry')
    assert.deepEqual(inputEntry!.data?.meta, meta, 'helm.input entry 应携带 meta')

    // assistant 文本在 entry.model（不在 data）——detail 不丢模型消息
    const assistantEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
    if (assistantEntry) {
      assert.ok(
        JSON.stringify(assistantEntry.model ?? '').includes('meta 回合完成'),
        'assistant 文本应在 entry.model（模型上下文消息）',
      )
    }

    // SSE：conversation.entry 与 conversation.live 真实增量到达（订阅先于回合建立）
    const frames = await subA.frames
    const joined = frames.join('\n')
    assert.ok(joined.includes('event: conversation.entry'), '应收到 conversation.entry 事件')
    assert.ok(joined.includes('event: conversation.live'), '应收到 conversation.live 事件')
    const inputFrame = frames.find((f) => f.includes('event: conversation.entry') && f.includes('test.render'))
    assert.ok(inputFrame, 'conversation.entry 增量应携带 helm.input 的 meta')

    // 首帧 snapshot 扩展：ui 与 pluginDocs（builtin:workflow 公开 runs 文档）
    const snapFrame = frames.find((f) => f.startsWith('event: snapshot'))
    assert.ok(snapFrame, '订阅应收到首帧 snapshot')
    assert.ok(snapFrame!.includes('"ui"'), 'snapshot 应含 ui（插件 UI 贡献）')
    assert.ok(snapFrame!.includes('"pluginDocs"'), 'snapshot 应含 pluginDocs')

    // 分页：limit=1 首页 + cursor 翻页到尾，聚合无丢失无重复
    const firstPageRes = await httpCall(base, 'GET', '/api/conversations/1?limit=1', { token: userToken })
    assert.equal(firstPageRes.status, 200)
    const firstPage = JSON.parse(firstPageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
    assert.equal(firstPage.entries.length, 1)
    assert.ok(firstPage.nextCursor, '应有下一页 cursor')
    const collected = [...firstPage.entries.map((e) => e.id)]
    let cursor: string | undefined = firstPage.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 50) {
      const pageRes = await httpCall(base, 'GET', `/api/conversations/1?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: userToken })
      assert.equal(pageRes.status, 200, `cursor 翻页失败：${pageRes.body}`)
      const page = JSON.parse(pageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
      collected.push(...page.entries.map((e) => e.id))
      cursor = page.nextCursor
    }
    assert.equal(new Set(collected).size, collected.length, '分页不得重复 entry')
    const fullRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    const full = JSON.parse(fullRes.body) as { entries: Array<{ id: string }> }
    assert.deepEqual(
      [...collected].sort(),
      full.entries.map((e) => e.id).sort(),
      '分页聚合必须与全量一致（首尾无丢）',
    )

    // plugin.changed 携带 ui：订阅 ready 后启/停带 UI 贡献的探针插件，
    // 同连接依次收到 ui 非空与 ui 空数组两帧，不靠重连重新拉 snapshot。
    await env.app.kernel.plugins.register({
      id: 'test:ui-probe',
      name: 'UI 探针',
      definePlugin(ctx) {
        ctx.ui.sidebarItem({ id: 'ui-probe', label: '对齐探针', target: 'conversation:1' })
      },
    } satisfies PluginDefinition)
    await env.app.kernel.plugins.disable('test:ui-probe')
    const changeFrames = await subB.frames
    const changed = changeFrames.filter((f) => f.includes('event: plugin.changed'))
    assert.ok(changed.length >= 2, `同连接应收到启/停两次 plugin.changed（实际 ${changed.length}）`)
    const withUi = changed.find((f) => f.includes('"ui"') && f.includes('sidebar.item'))
    assert.ok(withUi, '启用事件应携带 ui 贡献（含 surface）')
    const disabledEmptyUi = changed.find((f) => f.includes('"enabled":false') && /"ui":\s*\[\]/.test(f))
    assert.ok(disabledEmptyUi, '停用事件 ui 应为空数组（客户端据此替换贡献）')

    // 纯脚本 workflow：订阅 ready 后经 CLI run --wait 真实执行，
    // 校验 CLI 终态输出与 workflow.updated 完成增量两路证据。
    const cliDataDir2 = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const wfScriptPath = join(cliDataDir2, 'align-wait.workflow.js')
    writeFileSync(
      wfScriptPath,
      'export const meta = { name: "align-wait", description: "t" }\nreturn args.x * 2\n',
    )
    try {
      const wf = await runCliChild(
        [
          'workflows', 'run',
          wfScriptPath,
          '--args', JSON.stringify({ x: 21 }),
          '--conversation-id', String(env.app.kernel.listConversations()[0]!.id),
          '--wait', '--json',
        ],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir2, HELM_TOKEN: userToken },
      )
      assert.equal(wf.timedOut, false)
      if (wf.code !== 0) {
        assert.fail(`workflows run --wait 失败：${wf.err}`)
      }
      const runSummary = (JSON.parse(wf.out) as { run: { id: string; status: string; result?: unknown } }).run
      assert.equal(runSummary.status, 'completed')
      assert.equal(runSummary.result, 42)
      const wfFrames = await subC.frames
      const completedFrame = wfFrames.find(
        (f) => f.includes('event: workflow.updated') && f.includes(runSummary.id) && f.includes('"status":"completed"'),
      )
      assert.ok(completedFrame, '同连接应收到该 run 的 workflow.updated 完成增量')
    } finally {
      rmSync(cliDataDir2, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 4：插件 doc 公私 / manageConversation / scope
// ---------------------------------------------------------------------------

test('对齐4: ctx.doc 公私边界、plugin.doc.updated 脱敏增量、manageConversation 托管保护、scope 工具可见与 run_action 强制会话', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  // busy gate 释放函数：try 外声明（finally 兕底可调），resolve 幂等，重复调用无害
  let releaseBusy: () => void = () => {}
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins

    // 公共 doc 值含秘密形态：公共事件必须脱敏（占位符），私有 404。
    const SECRET = 'align-doc-secret-蓝色'
    const placeholder = kernel.services.stash.put(ROOT_CONVERSATION_ID, 'DOC_SECRET', SECRET)

    const busyGate = new Promise<void>((r) => (releaseBusy = r))
    const eventsSeen: string[] = []

    // 公共 doc 更新闭包：订阅 ready 后由测试显式触发，事件才是真实增量
    // （注册期更新发生在订阅之前，永远等不到帧——不猜、不糊）。
    type PubDoc = { note: string; secret: string }
    let updatePubDoc!: (fn: (v: PubDoc) => PubDoc) => void

    const conv = await kernel.createConversation({ title: '托管会话', profileId: 'assistant' })

    await host.register({
      id: 'test:guard',
      name: '守护探针',
      definePlugin(ctx) {
        const pub = ctx.doc('status', { note: 'init', secret: SECRET }, { public: true })
        const priv = ctx.doc('inner', { count: 0 })
        updatePubDoc = (fn) => pub.update(fn)
        ctx.action<Record<string, never>, { ok: boolean }>({
          id: 'blocked_out',
          description: 'scope 外不可经会话路径调用',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
          scope: { conversationIds: [conv.id] },
          handler: () => ({ ok: true }),
        })
        ctx.tool<{ text: string }>({
          name: 'guard_scoped',
          description: 'scope 限定工具',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            required: ['text'],
            additionalProperties: false,
          },
          scope: { profileIds: ['assistant'] },
          execute: (input) => ({ echoed: input.text }),
        })
        ctx.action<Record<string, never>, { done: boolean }>({
          id: 'busy',
          description: '占住在途任务',
          inputSchema: { type: 'object', properties: {}, additionalProperties: false },
          outputSchema: {
            type: 'object',
            properties: { done: { type: 'boolean' } },
            required: ['done'],
            additionalProperties: false,
          },
          handler: async () => {
            await busyGate
            return { done: true }
          },
        })
        ctx.hook.onTurnSettled(() => {
          eventsSeen.push('settled')
        })
        // 托管：本插件管理 conv
        ctx.host.manageConversation(conv.id)
        // 私有 doc 更新不发事件（仅公共 doc 是事件出口）
        priv.update((v) => ({ count: v.count + 1 }))
      },
    } satisfies PluginDefinition)

    hub = await startHub({ kernel: kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // --- 私有 doc：HTTP 404；公共 doc 可读且秘密以 stash marker 呈现
    const privateDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/inner`, { token: userToken })
    assert.equal(privateDoc.status, 404, `私有 doc 必须 404：${privateDoc.status}`)
    const publicDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    if (publicDoc.status !== 200) {
      assert.fail(`公共 doc 应可读（插件 doc HTTP）：${publicDoc.status}`)
    }
    assert.ok(!publicDoc.body.includes(SECRET), '公共 doc 出站不得含秘密明文')
    assert.ok(publicDoc.body.includes(placeholder), '公共 doc 秘密字段应以 stash marker 呈现')

    // --- plugin.doc.updated 真实增量：订阅 ready 后实际更新并校验事件脱敏
    // （原写法订阅发生在更新之后、超时后 catch([])，根本没验证事件）。
    const docSub = openSseSubscription(
      base,
      userToken,
      (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes('after-subscribe')),
    )
    await docSub.ready
    updatePubDoc((v) => ({ ...v, note: 'after-subscribe' }))
    const docFrames = await docSub.frames
    const docFrame = docFrames.find((f) => f.includes('event: plugin.doc.updated'))
    assert.ok(docFrame, '应收到 plugin.doc.updated 增量事件')
    assert.ok(!docFrame!.includes(SECRET), 'plugin.doc.updated 不得含秘密明文')
    assert.ok(docFrame!.includes(placeholder), 'plugin.doc.updated 秘密应以 stash marker 呈现')
    assert.ok(docFrame!.includes('after-subscribe'), '事件应携带更新后的 marker 值')
    // 公共 doc 读值同步为更新后内容（marker 仍脱敏）
    const publicDoc2 = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    assert.equal(publicDoc2.status, 200)
    assert.ok(publicDoc2.body.includes('after-subscribe'), '公共 doc 应反映更新后的值')
    assert.ok(!publicDoc2.body.includes(SECRET), '更新后公共 doc 仍不得含秘密明文')

    // --- 托管保护：DELETE 受管会话 409 conversation_managed_by_plugin
    const delManaged = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delManaged.status, 409)
    assert.equal(JSON.parse(delManaged.body).error.code, 'conversation_managed_by_plugin')
    // 保护生效期间不产生 abort 副作用：会话仍存在
    assert.equal(kernel.getConversation(conv.id).id, conv.id)

    // --- scope：listTools(conversation) 按会话筛选
    const listToolsFn = host as unknown as {
      listTools?: (conversation?: { id: number; profileId: string; tags: string[] }) => Array<{ name: string }>
    }
    if (typeof listToolsFn.listTools !== 'function') {
      assert.fail('PluginHost.listTools(conversation) scope 筛选应存在')
    }
    const assistantTools = listToolsFn.listTools!({
      id: ROOT_CONVERSATION_ID,
      profileId: 'assistant',
      tags: [],
    })!.map((t) => t.name)
    const otherTools = listToolsFn.listTools!({ id: 999, profileId: 'other', tags: [] })!.map((t) => t.name)
    assert.ok(assistantTools.includes('guard_scoped'), 'assistant 会话应见 guard_scoped')
    assert.ok(!otherTools.includes('guard_scoped'), '其他 profile 会话不得见 guard_scoped')

    // invokeAction 带 conversationId 必须命中 scope；未命中显式拒绝
    const okCall = await host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: conv.id })
    assert.deepEqual(okCall, { ok: true })
    await assert.rejects(
      () => host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: ROOT_CONVERSATION_ID }),
      (err: unknown) => err instanceof HelmError && /scope|作用域/.test(err.message),
      'scope 外 conversationId 调用应显式拒绝',
    )
    // 无 conversationId 的人工 HTTP 调用不受限（会话策略而非用户鉴权）
    const httpNoCtx = await httpCall(base, 'POST', '/api/actions/test:guard/blocked_out', { token: userToken, body: { input: {} } })
    assert.equal(httpNoCtx.status, 200)

    // run_action 元工具强制携带 conversationId：绕过 scope 的调用被拒。
    const runActionOutputs: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('run_action', { actionId: 'test:guard.blocked_out', input: {} })],
        { stopReason: 'toolUse' },
      ),
      (ctx) => {
        runActionOutputs.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('结束')
      },
    ])
    // 根会话 #1 不在 scope（conversationIds 仅含 conv.id）→ 工具结果应显式拒绝
    await kernel.submitInput(ROOT_CONVERSATION_ID, '调用 run_action test:guard.blocked_out')
    await kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(
      runActionOutputs.some((o) => /scope|作用域|拒绝/.test(o)),
      'run_action 在 scope 外会话应被显式拒绝（错误可见于工具结果）',
    )

    // --- 在途任务期间 disable 拒绝（409 plugin_has_live_tasks）；释放后 disable 成功并解除托管
    const busy = host.invokeAction('test:guard', 'busy', {})
    await assert.rejects(
      () => host.disable('test:guard'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
    )
    releaseBusy()
    assert.deepEqual(await busy, { done: true })
    await host.disable('test:guard')

    // disable 后托管释放：DELETE 现在应成功（停用自动释放）
    const delAfter = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delAfter.status, 200, `disable 后托管应释放：${delAfter.body}`)
    void eventsSeen
  } finally {
    // 失败路径兕底：释放 busy gate，避免 cleanup 挂住（resolve 幂等）
    releaseBusy?.()
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 5：外部后端 onAgentSpawn handled —— onResolved/onGateResult 真回传
// ---------------------------------------------------------------------------

test('对齐5: 测试插件 agent_spawn handled 外部后端——onResolved 真实元数据、onGateResult 真实 kernel.runGate、Gate 恰一次、结算顺序与缺 gate 显式失败', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  // settle gate 释放函数：try 外声明（finally 兕底可调），resolve 幂等，重复调用无害
  let releaseSettle: () => void = () => {}
  try {
    const kernel = env.app.kernel

    // 外部执行环境（真实临时目录，不猜宿主目录）
    const execDir = join(env.dataDir, 'external-exec')
    mkdirSync(execDir, { recursive: true })
    const gateDir = join(env.dataDir, 'gate-files')
    const execId = `ext-${Date.now()}`

    const spawns: Array<{ prompt: string; gate?: string; schema?: unknown }> = []
    const gates: Array<{ command: string; cwd?: string }> = []
    let settleCount = 0
    let settleEntered = false
    const settleGate = new Promise<void>((r) => (releaseSettle = r))

    await kernel.plugins.register({
      id: 'test:ext-backend',
      name: '外部后端',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn(async (request) => {
          spawns.push({
            prompt: request.prompt,
            gate: request.gate,
            schema: request.schema,
          })
          if (request.onResolved === undefined || request.onGateResult === undefined) {
            throw new HelmError('test_backend_contract', '外部后端必须收到 onResolved/onGateResult 回调', 500)
          }
          // 回传真实执行元数据（真实临时目录 + executionId + worktree）
          request.onResolved({
            nodeId: 'local',
            executionId: execId,
            effectiveCwd: execDir,
            worktree: { path: execDir, branch: 'align-wt' },
          })
          // gate 在外部执行环境内真实执行（kernel.runGate 真实 shell 于 execDir）
          if (request.gate !== undefined) {
            const result = await kernel.runGate(request.gate, { cwd: execDir, conversationId: request.parentConversationId })
            gates.push({ command: request.gate, cwd: execDir })
            request.onGateResult(result)
          }
          // Schema 业务数据（handled result；source 如实声明进 schema）
          return { action: 'handled', result: { answer: 42, source: 'external' } }
        })
        ctx.host.onEvent('workflow.settled', async () => {
          settleEntered = true
          settleCount += 1
          await settleGate
        })
      },
    } satisfies PluginDefinition)

    // gate 计数文件（真实 shell 副作用，恰一次）
    const gateCmd = `mkdir -p "${gateDir}" && printf x >> "${join(gateDir, 'count')}" && test -f "${join(execDir, 'marker')}" || (touch "${join(execDir, 'marker')}"; true)`

    // schema 如实声明 source：additionalProperties:false 下 handled 返回的
    // {answer, source} 必须全部入 schema，绝不靠削弱校验换通过。
    const script =
      'export const meta = { name: "align-ext", description: "external backend" }\n' +
      'const v = await agent("外部提取", { schema: ' +
      JSON.stringify({
        type: 'object',
        properties: {
          answer: { type: 'number' },
          source: { type: 'string' },
        },
        required: ['answer'],
        additionalProperties: false,
      }) +
      ', gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'return v'

    // 结算链验证：run 终态经 builtin:workflow 插件动作（wait:true）返回。
    // emitEvent 可等待语义：引擎 onRunSettled 会 await workflow.settled 监听器
    //（settleGate），因此必须先等监听器真实进入（settleEntered）再释放闸门，
    // 最后才等待 run 终态——顺序颠倒会死等（运行等监听器、监听器等释放）。
    const startedPromise = env.runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    await waitFor(() => settleEntered === true)
    releaseSettle()
    const { run: started } = await startedPromise
    const result = started.result as { answer: number; source?: string }
    assert.deepEqual(result, { answer: 42, source: 'external' }, '外部后端 handled 结果应回传脚本')

    // 节点元数据保留：executionId / effectiveCwd / worktree / gate
    const summary = (await env.inspectRun(started.id)).run
    const node = summary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(node, '应含 agent 节点')
    assert.equal(node!.executionId, execId, '节点应保留外部 executionId')
    assert.equal(node!.effectiveCwd, execDir, '节点应保留外部 effectiveCwd')
    assert.equal(node!.nodeId, 'local')
    assert.equal(node!.worktree?.path, execDir)
    assert.equal(node!.worktree?.branch, 'align-wt')
    assert.equal(node!.worktree?.id, `local:${execDir}`)
    assert.ok(node!.gate?.ok === true, '节点应含 gate 执行结果')

    // Gate 文件恰一次（onGateResult 回报使引擎跳过第二次执行）
    await waitFor(() => existsSync(join(gateDir, 'count')))
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate 恰好执行一次')
    await waitFor(() => settleCount === 1)
    assert.equal(settleCount, 1, 'workflow.settled 应恰好触发一次')

    // resume 重放不再 gate、不再执行外部后端
    const gatesBefore = gates.length
    const { run: resumed } = await env.runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const resumedResult = resumed.result as { answer: number; source?: string }
    assert.equal(resumedResult.answer, 42)
    assert.equal(gates.length, gatesBefore, 'resume 重放不得再执行 gate')
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate 副作用不重复')

    // 停用第一个 handled 后端，避免它截获后续缺 gate 场景的 spawn
    await kernel.plugins.disable('test:ext-backend')

    // --- 缺 Gate 回报：显式 failed，不在宿主猜目录执行
    await kernel.plugins.register({
      id: 'test:ext-nogate',
      name: '缺 gate 回报后端',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({ executionId: `${execId}-nogate`, effectiveCwd: execDir })
          // 故意不回报 onGateResult
          return { action: 'handled', result: { answer: 1 } }
        })
      },
    } satisfies PluginDefinition)

    // agent() 失败按引擎契约返回 null（不 throw）；脚本必须在 null 时显式
    // throw 才能让整个 run 断言为 failed。
    const badScript =
      'export const meta = { name: "align-nogate", description: "gate result missing" }\n' +
      'const v = await agent("缺 gate 回报", { gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'if (v === null || v === undefined) throw new Error("agent 未返回结果")\n' +
      'return v'
    // 引擎契约：脚本 throw 使 run failed；wait:true 动作对 failed 终态抛
    // workflow_failed 错误信封，改用非 wait run + inspect 轮询终态。
    let badId = ''
    await assert.rejects(
      () => env.runWorkflow({ script: badScript, conversationId: ROOT_CONVERSATION_ID, wait: true }),
      (err: unknown) => {
        badId = String((err as { details?: { runId?: string } }).details?.runId ?? '')
        return err instanceof HelmError && err.code === 'workflow_failed'
      },
    )
    assert.ok(badId !== '', '错误信封应携带 runId')
    const badSummary = (await env.inspectRun(badId)).run
    assert.equal(badSummary.status, 'failed', '缺 gate 回报应显式 failed')
    const badNode = badSummary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(badNode, '应含 agent 节点')
    assert.ok(badNode!.status === 'failed')
    // 只认节点真实诊断（gate_result_missing 由引擎写入 node.error）；
    // ?? summary.error 回退会命中脚本自行 throw 的字样，是假通过路径，禁用。
    assert.ok(
      typeof badNode!.error === 'string' && badNode!.error.includes('gate_result_missing'),
      `agent 节点 error 应含真实诊断 gate_result_missing：${String(badNode!.error)}`,
    )
    // 不在宿主猜目录执行：gate 计数不因该 run 增加（真实副作用而非编造消息）
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', '缺回报 run 不得在宿主目录执行 gate')
    assert.equal(gates.length, gatesBefore, '缺回报 run 不得经后端执行 gate')
  } finally {
    // 失败路径兕底：释放 settle gate，避免 workflow.settled 监听永久挂住
    //（resolve 幂等）。
    releaseSettle()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 闭环 6：两个 Profile 独立 SYSTEM/MEMORY 与模型 + HTTP PATCH 切换 + 重启保留
// ---------------------------------------------------------------------------

test('对齐6: 双 Profile 独立 SYSTEM/MEMORY/模型，PATCH 切换与清覆盖后请求一致，重启保留', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-profile-'))

  writeProfile(dataDir, 'researcher', {
    system: '# Researcher System\n你是研究员。唯一标记 ALIGN-SYS-RESEARCHER。',
    memory: 'RESEARCHER-MEM: 偏好引文',
  })
  writeProfile(dataDir, 'coder', {
    system: '# Coder System\n你是程序员。唯一标记 ALIGN-SYS-CODER。',
    memory: 'CODER-MEM: 偏好测试',
  })

  const build = async () => {
    const faux = fauxProvider()
    const models = createModels()
    models.setProvider(faux.provider)
    const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models })
    return { faux, app }
  }

  const requests: string[] = []
  const first = await build()
  try {
    // 两个 profile 各自会话
    const r1 = await first.app.kernel.createConversation({ title: '研究员', profileId: 'researcher' })
    const c1 = await first.app.kernel.createConversation({ title: '程序员', profileId: 'coder' })

    // researcher 回合：faux 捕获 system sections
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r')
      },
    ])
    await first.app.kernel.submitInput(r1.id, ' researcher 你是谁')
    await first.app.kernel.waitForIdle(r1.id)

    // coder 回合
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('c')
      },
    ])
    await first.app.kernel.submitInput(c1.id, ' coder 你是谁')
    await first.app.kernel.waitForIdle(c1.id)

    assert.ok(requests.length >= 2)
    assert.ok(requests[0]!.includes('ALIGN-SYS-RESEARCHER'), 'researcher 回合应注入其 SYSTEM')
    // 注意：跨 Profile 协作目录（profile.catalog）会带 coder 的 SYSTEM 首段单行摘要
    //（含 ALIGN-SYS-CODER 标记），这是设计内的认知共享；此处断言的是「完整 SYSTEM
    // 不串入」——以标题行 # Coder System 为准。
    assert.ok(!requests[0]!.includes('# Coder System'), 'researcher 回合不得串入 coder 完整 SYSTEM')
    assert.ok(requests[0]!.includes('RESEARCHER-MEM'), 'researcher 回合应注入其 MEMORY')
    assert.ok(requests[1]!.includes('ALIGN-SYS-CODER'), 'coder 回合应注入其 SYSTEM')
    assert.ok(requests[1]!.includes('CODER-MEM'), 'coder 回合应注入其 MEMORY')
    assert.ok(!requests[1]!.includes('# Researcher System'), 'coder 回合不得串入 researcher 完整 SYSTEM')
  } finally {
    await first.app.close()
  }

  // 重启：profile 绑定与注入保留
  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    const r1 = convs.find((c) => c.title === '研究员')
    const c1 = convs.find((c) => c.title === '程序员')
    assert.ok(r1 && c1, '重启后会话保留')

    const requests2: string[] = []
    second.faux.setResponses([
      (ctx) => {
        requests2.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r2')
      },
    ])
    await second.app.kernel.submitInput(r1!.id, '再问一次')
    await second.app.kernel.waitForIdle(r1!.id)
    assert.ok(requests2[0]!.includes('ALIGN-SYS-RESEARCHER'), '重启后 SYSTEM 注入保留')

    // HTTP PATCH 换 Profile：注入随之切换
    let hub: Awaited<ReturnType<typeof startHub>> | undefined
    try {
      hub = await startHub({ kernel: second.app.kernel as never, port: 0 })
      const base = hub.url
      const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: '对齐测试密码至少八位' } })
      const token = (JSON.parse(setupRes.body) as { token: string }).token

      const patched = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { profileId: 'coder' },
      })
      assert.equal(patched.status, 200, `PATCH profile 失败：${patched.body}`)

      const requests3: string[] = []
      second.faux.setResponses([
        (ctx) => {
          requests3.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('c2')
        },
      ])
      await second.app.kernel.submitInput(r1!.id, '换 profile 后再问')
      await second.app.kernel.waitForIdle(r1!.id)
      assert.ok(requests3[0]!.includes('ALIGN-SYS-CODER'), 'PATCH 换 Profile 后注入应切换')
      assert.ok(!requests3[0]!.includes('# Researcher System'), '不得残留旧 Profile 完整 SYSTEM')

      // 显式模型覆盖 + 清覆盖：summary 与真实请求一致
      const override = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: 'faux/faux-1' },
      })
      assert.equal(override.status, 200)
      const cleared = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: '' },
      })
      assert.equal(cleared.status, 200, "PATCH model:'' 清覆盖应被接受")
      const afterClear = JSON.parse(cleared.body) as { model: string }
      assert.ok(typeof afterClear.model === 'string' && afterClear.model !== '', '清覆盖后生效模型回落 Profile/全局且非空')
    } finally {
      await hub?.close()
    }
  } finally {
    await second.app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
