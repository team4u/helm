/**
 * helm 核心端到端集成验收（仅本文件与 app-workflow.integration.test.ts，不修改实现）。
 *
 * 组合纪律：一律经真实组合入口 createHelm（src/app.ts）组装——真 pi-durable
 * SQLite 持久层 + 真 PluginHost + 真 builtin:assistant + 真 WorkflowService +
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

import { ROOT_CONVERSATION_ID, HelmError, type PluginDefinition } from '@helm/protocol'
import { HELM_CLI_SKILL_ASSET } from '../src/builtin-plugins/assistant.js'
import { createHelm } from '../src/app.js'
import { startHub } from '../src/http/index.js'
import { redactJsonValue } from '../src/redact.js'

import assert from 'node:assert/strict'

const testDir = dirname(fileURLToPath(import.meta.url))

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

  // 真实组合入口：真 SQLite + 真 PluginHost + assistant + WorkflowService。
  const app = await createHelm({
    dataDir,
    cwd: dataDir,
    model: 'faux/faux-1',
    models,
  })

  const requests: TestEnv['requests'] = []
  faux.setResponses([])

  const env: TestEnv = {
    dataDir,
    dbPath,
    faux,
    app,
    requests,
    async submitAndWait(text, opts) {
      await app.kernel.submitInput(ROOT_CONVERSATION_ID, text, opts)
      await app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
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
// 1. assistant 自举 + 真实回合 + before_turn sections 真实进入模型请求
// ---------------------------------------------------------------------------

test('集成1: createHelm 组合——assistant 自举 #1、locked 保护、SYSTEM/MEMORY sections 真实进入模型请求、update_memory 跨回合持久', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 修复后的 plugins getter 非 undefined（runtime 集成修复目标）；测试按契约直接消费
    const host = kernel.plugins!

    // --- 自举：locked assistant 已注册启用，工具清单暴露 update_memory / load_skill
    const summary = host.list().find((p) => p.id === 'builtin:assistant')
    assert.ok(summary, 'builtin:assistant 应经 createHelm 注册')
    assert.equal(summary.locked, true)
    assert.equal(summary.enabled, true)
    assert.ok(summary.tools.includes('update_memory'))
    assert.ok(summary.tools.includes('load_skill'))
    await rejectsExplicitly(() => host.disable('builtin:assistant'), { code: 'plugin_locked', message: /锁定/ })
    await rejectsExplicitly(() => host.unregister('builtin:assistant'), { code: 'plugin_locked', message: /锁定/ })

    // --- 根会话 #1 由 createHelm 创建（真实 SQLite 持久）
    const conv = kernel.getConversation(ROOT_CONVERSATION_ID)
    assert.equal(conv.id, ROOT_CONVERSATION_ID)
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

    const memoryFile = await kernel.services.profiles.getMemory('assistant')
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
      { conversationId: ROOT_CONVERSATION_ID },
    )) as { text: string }
    assert.ok(readMain.text.includes('部署'), '缺省读取 SKILL.md')

    const readRef = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook', path: 'references/rollback.md' },
      { conversationId: ROOT_CONVERSATION_ID },
    )) as { text: string }
    assert.ok(readRef.text.includes('helm rollback'), '应能按需读取 references 子文件')

    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '../profiles/assistant/MEMORY.md' }, { conversationId: 1 }),
      { message: /路径穿越|入参校验失败/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '/etc/passwd' }, { conversationId: 1 }),
      { message: /绝对路径|入参校验失败/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: 1 }),
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
// 2.5 helm-cli 系统级内置技能自举（builtin:assistant service.start 幂等补齐）
// ---------------------------------------------------------------------------

test('集成2.5: createHelm 启动即同步 helm-cli 技能（受管覆盖），load_skill 可读 SKILL.md 与三个 references，重启覆盖回源码版本', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 启动即包含 helm-cli（managedByPlugin = builtin:assistant，含三个 references）
    const skills = await kernel.skills.list()
    const summary = skills.find((s) => s.id === 'helm-cli')
    assert.ok(summary, 'helm-cli 技能应经 builtin:assistant 启动自举')
    assert.equal(summary.managedByPlugin, 'builtin:assistant')
    for (const ref of ['references/generative-ui.md', 'references/workflows-and-agents.md', 'references/skill-and-plugin-dev.md']) {
      assert.ok(summary.references.includes(ref), `references 应含 ${ref}`)
    }

    // 普通回合只注入技能目录，不把 UI/工作流手册全文塞入常驻上下文。
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    const sections = env.requests[0]!.systemSections.join('\n')
    assert.ok(sections.includes('helm-cli'), '普通回合应能发现内建技能')
    assert.ok(sections.includes('references/generative-ui.md'), '目录应指向按需 UI 手册')
    assert.ok(!sections.includes('MetricGrid'), 'UI 组件字典不应常驻')
    assert.ok(!sections.includes('workflow(ref, args?)'), '工作流手册不应常驻')

    // load_skill 工具链路：SKILL.md 与三个 references 均可读且内容实质
    const host = kernel.plugins!
    const readSkill = (path?: string) =>
      host.executeTool(
        'load_skill',
        path === undefined ? { skillId: 'helm-cli' } : { skillId: 'helm-cli', path },
        { conversationId: ROOT_CONVERSATION_ID },
      ) as Promise<{ text: string }>
    const main = await readSkill()
    assert.ok(main.text.includes('helm') && main.text.includes('--json'), 'SKILL.md 应含 CLI 铁律')
    const ui = await readSkill('references/generative-ui.md')
    assert.ok(ui.text.includes('MetricGrid') && ui.text.includes('helm:action'), 'generative-ui 应含组件契约与动作指令')
    const wf = await readSkill('references/workflows-and-agents.md')
    assert.ok(wf.text.includes('pipeline') && wf.text.includes('resumeFromRunId'), 'workflows 应含编排 API 与断点重放')
    const dev = await readSkill('references/skill-and-plugin-dev.md')
    assert.ok(dev.text.includes('definePlugin') && dev.text.includes('ctx.action'), 'skill-and-plugin-dev 应含插件开发指南')

    // 重启（重建 app）后受管覆盖：磁盘手工篡改的 SKILL.md 与 reference 回到
    // 源码版本，被删的 reference 补齐；用户自建技能不受影响且仍可写
    const customMain = '---\nname: helm-cli\ndescription: 用户改写\n---\n我的版本\n'
    const customRef = '# 我改过的 UI 手册\n'
    writeFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), customMain)
    writeFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'generative-ui.md'), customRef)
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'))
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
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'generative-ui.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['generative-ui.md']!,
        '重启后受管 reference 必须回到源码版本',
      )
      const restored = readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'), 'utf8')
      assert.equal(restored, HELM_CLI_SKILL_ASSET.references['skill-and-plugin-dev.md']!, '缺失的 reference 被补齐为源码版本')
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
// 3. SecretStash：真实秘密值不进 SQLite、不进模型请求、SSE 帧
// ---------------------------------------------------------------------------

test('集成3: 双引号+换行秘密值不出现在 SQLite 任何表、模型请求与 SSE 帧中；占位符可安全流转', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // 双引号 + 换行：只对 JSON.stringify 后文本脱敏的朴素实现会漏这种值
    const SECRET_TRICKY = ['quote"', 'line'].join('\n')
    const placeholder = kernel.services.stash.put(ROOT_CONVERSATION_ID, 'TRICKY_TOKEN', SECRET_TRICKY)
    assert.match(placeholder, /^\[REDACTED:stash:[0-9a-f-]{36}\]$/)

    // 模型回合：占位符入上下文，秘密值永不达 provider
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(`请用令牌 ${placeholder} 部署`)
    const req = env.requests[0]!
    assert.ok(req.userTexts.join('\n').includes(placeholder), '占位符可正常进入上下文')
    const reqAll = req.systemSections.join('\n') + req.userTexts.join('\n') + req.assistantTexts.join('\n')
    assert.ok(!reqAll.includes(SECRET_TRICKY), '秘密值不得进入任何模型消息')

    // envFor 会话隔离
    assert.equal(kernel.services.stash.envFor(ROOT_CONVERSATION_ID)['TRICKY_TOKEN'], SECRET_TRICKY)
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
    assert.equal(kernel.services.stash.envFor(ROOT_CONVERSATION_ID)['TRICKY_TOKEN'], undefined)
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

test('集成5: 重启后根会话 #1 与历史经真实 SQLite 保留，faux 续接可见完整历史，SSE seq 持久不回退', { timeout: 60_000 }, async () => {
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
  try {
    first.faux.setResponses([fauxAssistantMessage(`已记录：${MARK}`)])
    await first.app.kernel.submitInput(ROOT_CONVERSATION_ID, `请记住：${MARK}`)
    await first.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.equal(first.faux.state.callCount, 1)
    seqAfterFirst = first.app.kernel.events.seq
    assert.ok(seqAfterFirst > 0, '第一回合应推进 SSE seq')
  } finally {
    await first.app.close()
  }

  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    assert.ok(convs.some((c) => c.id === ROOT_CONVERSATION_ID), '重启后根会话 #1 仍在')
    assert.ok(
      second.app.kernel.events.seq >= seqAfterFirst,
      `重启后 SSE seq（${second.app.kernel.events.seq}）应 >= 首回合后（${seqAfterFirst}）`,
    )
    const conv = second.app.kernel.getConversation(ROOT_CONVERSATION_ID)
    assert.ok(conv.completionSeq >= 1, 'completionSeq 跨重启保留')

    // 续接回合：模型可见完整历史
    const seen: string[] = []
    second.faux.setResponses([
      (ctx) => {
        seen.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('已回顾历史')
      },
    ])
    await second.app.kernel.submitInput(ROOT_CONVERSATION_ID, '回顾一下我们说过什么')
    await second.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
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

  // 集成探针插件：echo 动作回显 stash 真实值（验证出站脱敏链路）
  const stash = app.kernel.services.stash
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const trickyPlaceholder = stash.put(ROOT_CONVERSATION_ID, 'TRICKY_TOKEN', SECRET_TRICKY)

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
    hub, app, faux, dataDir, SECRET_TRICKY, trickyPlaceholder,
    rootPassword: '集成测试Root密码八位',
    async close() {
      await hub.close()
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('集成6: HTTP 真实往返——鉴权/根会话保护/动作校验同权/secret 不泄漏出站/SSE snapshot 首帧/插件 public 路由', { timeout: 60_000 }, async () => {
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

    // --- 根会话保护：DELETE #1 → 403（HTTP 边界显式拦截）
    const delRoot = await call('DELETE', '/api/conversations/1')
    assert.equal(delRoot.status, 403)
    assert.equal(JSON.parse(delRoot.body).error.code, 'root_conversation_protected')

    // --- 真实模型回合（HTTP submit → 真 kernel → faux）
    const conv = await call('GET', '/api/conversations/1')
    assert.equal(conv.status, 200)
    assert.equal(JSON.parse(conv.body).id, ROOT_CONVERSATION_ID)
    env.faux.setResponses([fauxAssistantMessage('HTTP 回合完成')])
    // 非等待提交：路由默认 submission accepted（202 + {submissionId}），不伪造同步回答
    const sent = await call('POST', '/api/conversations/1/input', { body: { text: '你好，集成测试' } })
    assert.equal(sent.status, 202)
    const submission = JSON.parse(sent.body) as { submissionId: string }
    assert.ok(typeof submission.submissionId === 'string' && submission.submissionId.length > 0, '202 应携带 submissionId')
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(env.faux.state.callCount >= 1, 'HTTP submit 应触发真实模型回合')

    // 显式等待链：?wait=1 精确等待本次提交的回答（200 ConversationInputResult）
    env.faux.setResponses([fauxAssistantMessage('HTTP 等待回答')])
    const waited = await call('POST', '/api/conversations/1/input?wait=1', { body: { text: '等待链验证' } })
    assert.equal(waited.status, 200, `wait=1 应返回本次回答：${waited.body}`)
    const waitResult = JSON.parse(waited.body) as { submissionId: string; text: string; entry: { id: string; kind: string } }
    assert.ok(waitResult.submissionId.length > 0)
    assert.equal(waitResult.text, 'HTTP 等待回答')
    assert.ok(waitResult.entry.id, 'wait 结果应含精确回答 entry')

    // --- 动作校验同权：HTTP 非法入参 400 validation_error（与 invokeAction 同一校验器）
    const actionList = await call('GET', '/api/actions')
    assert.equal(actionList.status, 200)
    assert.ok(JSON.parse(actionList.body).some((a: { pluginId: string; id: string }) => a.pluginId === 'test:probe' && a.id === 'echo'))
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

  const run = async (argv: string[]): Promise<{ code: number; out: string; err: string }> => {
    let out = ''
    let err = ''
    const code = await runCli(argv, {
      env: {
        HELM_HUB_URL: hubUrl.toString(),
        HELM_DATA_DIR: env.dataDir,
        PATH: process.env.PATH,
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
  const repoRoot = join(testDir, '..', '..', '..')
  const cliEntry = join(repoRoot, 'packages', 'cli', 'src', 'index.ts')
  const require = createRequire(import.meta.url)
  const tsxCli = require.resolve('tsx/cli')
  const runCliChild = (args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string; timedOut: boolean }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [tsxCli, cliEntry, ...args], {
        env: { ...process.env, HELM_HUB_URL: hubUrl.toString(), HELM_DATA_DIR: env.dataDir, HELM_TOKEN: '' },
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
    const convs = JSON.parse(list.out) as Array<{ id: number }>
    assert.ok(convs.some((c) => c.id === ROOT_CONVERSATION_ID), '应列出根会话 #1')

    // --- send：CLI 提交 → 真实模型回合
    const callCountBefore = env.faux.state.callCount
    env.faux.setResponses([fauxAssistantMessage('CLI 回合完成')])
    const send = await run(['send', '1', '你好 CLI 集成', '--json'])
    assert.equal(send.code, 0, send.err)
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
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

    // --- 根会话保护同权
    const delRoot = await run(['conversations', 'delete', '1', '--json'])
    assert.notEqual(delRoot.code, 0)
    assert.equal(
      (JSON.parse(delRoot.err) as { error: { code: string } }).error.code,
      'root_conversation_protected',
    )

    // --- 子进程真 CLI 入口（异步 spawn；父进程事件循环保持响应，Hub 可答）：
    //     setup 已完成，子进程经 cli-token 凭据访问同一真 Hub。
    const childStatus = await runCliChild(['status', '--json'])
    assert.equal(childStatus.timedOut, false, '子进程 CLI 不得挂起')
    assert.equal(childStatus.code, 0, `子进程 status 失败：${childStatus.err}`)
    assert.equal(JSON.parse(childStatus.out).configured, true)

    const childGet = await runCliChild(['conversations', 'get', '1', '--json'])
    assert.equal(childGet.timedOut, false, '子进程 CLI 不得挂起')
    assert.equal(childGet.code, 0, `子进程 conversations get 失败：${childGet.err}`)
    assert.equal(JSON.parse(childGet.out).id, ROOT_CONVERSATION_ID)

    const childAuth = await runCliChild(['conversations', 'list', '--json'])
    assert.equal(childAuth.timedOut, false)
    assert.equal(childAuth.code, 0, `子进程鉴权应经 cli-token 生效：${childAuth.err}`)
    assert.ok((JSON.parse(childAuth.out) as Array<{ id: number }>).some((c) => c.id === ROOT_CONVERSATION_ID))
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
        [fauxToolCall('subagent', { prompt: '子任务：检查构建' })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('子代理已返回，任务完成'),
    ])
    // 子会话用同一 faux provider（faux 队列按请求顺序消费：父工具轮 -> 子代理回合 -> 父收尾轮）。
    await env.submitAndWait('请派一个子代理检查构建')

    // 摘要层：派生出的子会话镜像带 parentToolCallId（父会话工具调用 ID）。
    const child = kernel
      .listConversations()
      .find((c) => c.parentConversationId === ROOT_CONVERSATION_ID && c.parentToolCallId !== undefined)
    assert.ok(child !== undefined, '子会话摘要必须携带 parentToolCallId（运行期实时关联契约）')
    assert.ok(child!.parentToolCallId !== undefined && child!.parentToolCallId !== '')

    // 事件层：conversation.upsert 广播中含该子会话与 parentToolCallId（前端 SSE 即刻可关联）。
    const broadcast = upserts.find((u) => u.id === child!.id && u.parentToolCallId === child!.parentToolCallId)
    assert.ok(broadcast !== undefined, 'conversation.upsert 必须广播含 parentToolCallId 的子会话摘要')
  } finally {
    await env.close()
  }
})
