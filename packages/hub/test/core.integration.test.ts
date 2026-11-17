/**
 * helm 核心组合端到端验收测试（真实 createHelm 组合根 + pi-durable SQLite + PluginHost + startHub + CLI）：
 * - 共享主 Hub 实例覆盖：profile/memory 默认协同与跨回合记忆落库、load_skill 目录与白名单/托管技能启停同步、
 *   SecretStash 全链路零泄漏、ctx.action/ctx.tool Schema 校验与在途 409、subagent parentToolCallId 广播、
 *   受管 bash HELM_TOKEN 直连、CLI --meta -> turn_settled 增量 SSE 与分页、ctx.doc 公私边界/manageConversation/scope、
 *   agent_spawn 外部后端 onResolved/onGateResult/journal 重放与缺报拒绝；
 * - 独立 HTTP/CLI 鉴权闭环：匿名 401、scrypt setup/login、初始会话可删除、?wait=1、出站脱敏、公开路由与真实子进程 CLI；
 * - 独立跨重启闭环：helm-cli/generative-ui 受管技能防篡改覆盖补齐、对话历史与 SSE seq/completionSeq 保持、双 Profile 隔离与 PATCH 切换。
 */
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type PluginDefinition } from '@helm/protocol'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runCli } from '../../cli/src/index.js'
import { startHub } from '../../kernel/src/http/index.js'
import { redactJsonValue } from '../../kernel/src/redact.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { MemoryStore } from '../../plugins/src/memory/store.js'
import { HELM_CLI_SKILL_ASSET } from '../../plugins/src/profile.js'
import {
  createHubTestApp,
  openHubHttpEnv,
  useTempDir,
  waitFor as waitForCondition,
  type HubHttpTestEnv,
} from './helpers/hub-test-env.js'

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

function runCliChild(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 25_000): Promise<CliRunResult> {
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

async function runCliInProcess(
  argv: string[],
  envVars: NodeJS.ProcessEnv,
): Promise<{ code: number; out: string; err: string }> {
  let out = ''
  let err = ''
  const code = await runCli(argv, {
    env: { PATH: process.env.PATH, ...envVars },
    stdout: (t) => { out += t },
    stderr: (t) => { err += t },
  })
  return { code, out, err }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  await waitForCondition(predicate, { timeoutMs, message: 'waitFor timeout' })
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
  const ready = new Promise<void>((resolve) => { signalReady = resolve })
  const frames = collectSse(base, token, until, timeoutMs, signalReady)
  return { frames, ready }
}

function writeProfile(dataDir: string, id: string, files: { system?: string; memory?: string; model?: string }): void {
  const dir = join(dataDir, 'profiles', id)
  mkdirSync(dir, { recursive: true })
  const profile: Record<string, unknown> = { id, name: id }
  if (files.model !== undefined) profile.model = files.model
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile))
  if (files.system !== undefined) writeFileSync(join(dir, 'SYSTEM.md'), files.system)
  if (files.memory !== undefined) writeFileSync(join(dir, 'MEMORY.md'), files.memory)
}

function writeSkill(dataDir: string, id: string, skillMd: string, refs: Record<string, string>): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  const refDir = join(dir, 'references')
  if (!existsSync(refDir)) mkdirSync(refDir)
  for (const [name, content] of Object.entries(refs)) writeFileSync(join(refDir, name), content)
}

function sqliteTablesContaining(dbPath: string, needle: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true })
  try {
    const hits: string[] = []
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
    for (const { name } of tables) {
      const rows = db.prepare(`SELECT * FROM "${name}"`).all() as unknown[]
      if (rows.map((r) => JSON.stringify(r)).join('\n').includes(needle)) hits.push(name)
    }
    return hits
  } finally {
    db.close()
  }
}

async function rejectsExplicitly(fn: () => Promise<unknown>, expected: { code?: string; message: RegExp }): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    if (expected.code !== undefined) {
      assert.ok(err instanceof HelmError)
      assert.equal(err.code, expected.code)
    }
    assert.match(err instanceof Error ? err.message : String(err), expected.message)
    return true
  })
}

// ---------------------------------------------------------------------------
// 共享主 Hub 环境（覆盖模块协同、技能白名单、机密零泄漏、动作/工具、受管 Token、SSE/分页/Scope、外部后端）
// ---------------------------------------------------------------------------

let mainEnv: HubHttpTestEnv
let dbPath = ''
const capturedRequests: Array<{
  roles: string[]
  systemSections: string[]
  userTexts: string[]
  assistantTexts: string[]
}> = []

function captureStep(): FauxResponseStep {
  return (context) => {
    capturedRequests.push({
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
    return fauxAssistantMessage('captured')
  }
}

before(async () => {
  mainEnv = await openHubHttpEnv({
    prefix: 'helm-core-main-',
    swallowCloseError: true,
  })
  dbPath = join(mainEnv.dataDir, 'state.sqlite')
  const runtime = mainEnv.kernel as unknown as { setHubUrl?: (url: string) => void }
  runtime.setHubUrl?.(mainEnv.hubUrl)
})

after(async () => {
  await mainEnv?.close()
})

test('核心协同 1：profile/memory 默认装配与锁定保护、SYSTEM/MEMORY 段落注入、update_memory 跨回合持久化及 subagent parentToolCallId 广播', { timeout: 60_000 }, async () => {
  const { kernel, faux } = mainEnv
  const host = kernel.plugins

  const profileSummary = host.list().find((p) => p.id === 'builtin:profile')!
  assert.equal(profileSummary.locked, true)
  assert.equal(profileSummary.enabled, true)
  assert.ok(profileSummary.tools.includes('load_skill'))
  await rejectsExplicitly(() => host.disable('builtin:profile'), { code: 'plugin_locked', message: /lock/ })
  await rejectsExplicitly(() => host.unregister('builtin:profile'), { code: 'plugin_locked', message: /lock/ })

  const memorySummary = host.list().find((p) => p.id === 'builtin:memory')!
  assert.equal(memorySummary.locked, false)
  assert.equal(memorySummary.enabled, true)
  assert.ok(memorySummary.tools.includes('update_memory'))
  assert.ok(['get', 'set', 'configure'].every((a) => memorySummary.actions.includes(a)))

  const conv = await kernel.createConversation({ title: 'profile-memory-e2e', profileId: 'assistant' })
  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(conv.id, '你好')
  await kernel.waitForIdle(conv.id)
  const first = capturedRequests[0]!
  assert.ok(first.roles.includes('system'))
  assert.ok(first.systemSections.some((s) => s.includes('# System Prompt')))
  assert.ok((first.systemSections.join('\n') + first.userTexts.join('\n')).includes('<memory>'))

  const MEMORY_FACT = 'FAVORITE_COLOR=cyan porcelain green'
  capturedRequests.length = 0
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('update_memory', { text: MEMORY_FACT, mode: 'append' })], { stopReason: 'toolUse' }),
    captureStep(),
  ])
  await kernel.submitInput(conv.id, 'record color')
  await kernel.waitForIdle(conv.id)
  assert.ok((await new MemoryStore(createProfileFileHost(kernel.dataDir)).getMemory('assistant')).includes(MEMORY_FACT))
  assert.ok(capturedRequests[0]!.systemSections.join('\n').includes(MEMORY_FACT))

  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(conv.id, 'next turn')
  await kernel.waitForIdle(conv.id)
  assert.ok(capturedRequests[0]!.systemSections.join('\n').includes(MEMORY_FACT))
  assert.ok(sqliteTablesContaining(dbPath, MEMORY_FACT).length > 0)

  // subagent 派生实时关联 parentToolCallId 并广播 conversation.upsert
  const upserts: Array<{ id: number; parentConversationId?: number; parentToolCallId?: string }> = []
  const off = kernel.events.subscribe((frame) => {
    const ev = frame.event as { type?: string; conversation?: { id: number; parentConversationId?: number; parentToolCallId?: string } }
    if (ev?.type === 'conversation.upsert' && ev.conversation !== undefined) {
      upserts.push(ev.conversation)
    }
  })
  try {
    const subParent = await kernel.createConversation({ title: 'subagent-parent' })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: 'sub-task', background: false })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('subagent done'),
      fauxAssistantMessage('parent done'),
    ])
    await kernel.submitInput(subParent.id, 'dispatch subagent')
    await kernel.waitForIdle(subParent.id)
    const child = kernel.listConversations().find((c) => c.parentConversationId === subParent.id && c.parentToolCallId !== undefined)
    assert.ok(child?.parentToolCallId)
    assert.ok(upserts.some((u) => u.id === child.id && u.parentToolCallId === child.parentToolCallId))
  } finally {
    off()
  }
})

test('核心协同 2：load_skill 读取与路径防护、Profile skills 白名单/空数组禁用、托管技能随插件启停同步', { timeout: 60_000 }, async () => {
  const { kernel, faux, dataDir } = mainEnv
  const host = kernel.plugins

  writeSkill(
    dataDir,
    'deploy-playbook',
    '---\nname: deploy manual\ndescription: publish stream process\n---\n# deploy\nsee references/.',
    { 'rollback.md': 'rollback: execute helm rollback --canary', 'db-migrate.md': 'migration before backup state.sqlite' },
  )
  writeSkill(dataDir, 'alpha-guide', '---\nname: Alpha manual\ndescription: A\n---\n# Alpha', { 'intro.md': 'Alpha quote say: only blank name single.' })
  writeSkill(dataDir, 'beta-guide', '---\nname: Beta manual\ndescription: B\n---\n# Beta', {})
  writeSkill(dataDir, 'managed-guide', '---\nname: hosting manual\ndescription: hosting\nmanagedByPlugin: builtin:superagent\n---\n# hosting', {})

  const defaultConv = await kernel.createConversation({ title: 'skill-default' })
  assert.ok(((await host.executeTool('load_skill', { skillId: 'deploy-playbook' }, { conversationId: defaultConv.id })) as { text: string }).text.includes('deploy'))
  assert.ok(((await host.executeTool('load_skill', { skillId: 'deploy-playbook', path: 'references/rollback.md' }, { conversationId: defaultConv.id })) as { text: string }).text.includes('helm rollback'))

  await rejectsExplicitly(
    () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '../profiles/assistant/MEMORY.md' }, { conversationId: defaultConv.id }),
    { message: /path through exceeds|reference validation failed/ },
  )
  await rejectsExplicitly(
    () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '/etc/passwd' }, { conversationId: defaultConv.id }),
    { message: /absolute path|reference validation failed/ },
  )
  await rejectsExplicitly(
    () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: defaultConv.id }),
    { code: 'not_found', message: /missing|no-such-skill/ },
  )

  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(defaultConv.id, 'check default catalog')
  await kernel.waitForIdle(defaultConv.id)
  const defaultCatalog = capturedRequests[0]!.systemSections.find((s) => s.includes('<available_skills>'))!
  for (const item of ['deploy-playbook', 'references/db-migrate.md', 'helm-cli', 'alpha-guide', 'beta-guide', 'generative-ui']) {
    assert.ok(defaultCatalog.includes(item))
  }
  assert.ok(!capturedRequests[0]!.systemSections.join('\n').includes('MetricGrid'))

  // 白名单与空数组禁用
  await kernel.profiles.save({ id: 'white-profile', name: 'whitelist', tags: [], skills: ['alpha-guide', 'managed-guide'] })
  await kernel.profiles.save({ id: 'none-profile', name: 'none', tags: [], skills: [] })
  const convWhite = await kernel.createConversation({ title: 'white', profileId: 'white-profile' })
  const convNone = await kernel.createConversation({ title: 'none', profileId: 'none-profile' })

  assert.ok(((await host.executeTool('load_skill', { skillId: 'alpha-guide', path: 'references/intro.md' }, { conversationId: convWhite.id })) as { text: string }).text.includes('blank name single'))
  await rejectsExplicitly(() => host.executeTool('load_skill', { skillId: 'beta-guide' }, { conversationId: convWhite.id }), { code: 'skill_not_available', message: /is unavailable for profile/ })
  await rejectsExplicitly(() => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }), { code: 'skill_not_available', message: /is unavailable for profile|is disabled/ })

  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(convNone.id, 'none turn')
  await kernel.waitForIdle(convNone.id)
  assert.equal(capturedRequests[0]!.systemSections.find((s) => s.includes('<available_skills>')), undefined)
  await rejectsExplicitly(() => host.executeTool('load_skill', { skillId: 'helm-cli' }, { conversationId: convNone.id }), { code: 'skill_not_available', message: /is unavailable for profile/ })

  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(convWhite.id, 'white turn')
  await kernel.waitForIdle(convWhite.id)
  const catW = capturedRequests[0]!.systemSections.find((s) => s.includes('<available_skills>'))!
  assert.ok(catW.includes('id="alpha-guide"'))
  for (const absent of ['beta-guide', 'helm-cli', 'managed-guide']) assert.ok(!catW.includes(`id="${absent}"`))

  await host.enable('builtin:superagent')
  try {
    assert.ok(((await host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id })) as { text: string }).text.includes('hosting'))
    capturedRequests.length = 0
    faux.setResponses([captureStep()])
    await kernel.submitInput(convWhite.id, 'white after enable')
    await kernel.waitForIdle(convWhite.id)
    assert.ok(capturedRequests[0]!.systemSections.find((s) => s.includes('<available_skills>'))?.includes('id="managed-guide"'))
  } finally {
    await host.disable('builtin:superagent')
  }

  await kernel.profiles.save({ id: 'white-profile', name: 'whitelist', tags: [], skills: [] })
  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(convWhite.id, 'white cleared')
  await kernel.waitForIdle(convWhite.id)
  assert.equal(capturedRequests[0]!.systemSections.find((s) => s.includes('<available_skills>')), undefined)
})

test('核心协同 3：SecretStash 跨层零泄漏（SQLite/模型请求/SSE/JSON 值级脱敏）与 ctx.action/ctx.tool Schema 校验及在途 409', { timeout: 60_000 }, async () => {
  const { kernel, faux } = mainEnv
  const host = kernel.plugins

  // 1. 双引号 + 换行机密值零入库、零进模型、零进 SSE 帧
  const secConv = await kernel.createConversation({ title: 'secret-e2e' })
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const placeholder = kernel.services.stash.put(secConv.id, 'TRICKY_TOKEN', SECRET_TRICKY)
  assert.match(placeholder, /^\[REDACTED:stash:[0-9a-f-]{36}\]$/)

  capturedRequests.length = 0
  faux.setResponses([captureStep()])
  await kernel.submitInput(secConv.id, `deploy with ${placeholder}`)
  await kernel.waitForIdle(secConv.id)
  const req = capturedRequests[0]!
  assert.ok(req.userTexts.join('\n').includes(placeholder))
  assert.ok(!(req.systemSections.join('\n') + req.userTexts.join('\n')).includes(SECRET_TRICKY))
  assert.equal(kernel.services.stash.envFor(secConv.id)['TRICKY_TOKEN'], SECRET_TRICKY)
  assert.equal(kernel.services.stash.envFor(999)['TRICKY_TOKEN'], undefined)

  const frames: string[] = []
  const off = kernel.events.subscribe((frame) => frames.push(JSON.stringify(frame)))
  kernel.events.publish('notification', { level: 'info', title: 'deploy', body: `token ${SECRET_TRICKY} used` })
  off()
  const joinedFrames = frames.join('\n')
  assert.ok(!joinedFrames.includes(SECRET_TRICKY) && !joinedFrames.includes('quote\\"') && joinedFrames.includes(placeholder))
  assert.deepEqual(sqliteTablesContaining(dbPath, SECRET_TRICKY), [])

  const redacted = redactJsonValue({ text: `prefix ${SECRET_TRICKY} ${placeholder}` }, (t) => kernel.services.stash.redact(t)) as { text: string }
  assert.ok(!redacted.text.includes('line') && !redacted.text.includes('quote') && redacted.text.includes(placeholder))
  kernel.services.stash.clear(secConv.id)
  assert.equal(kernel.services.stash.envFor(secConv.id)['TRICKY_TOKEN'], undefined)

  // 2. ctx.action / ctx.tool 共享 Schema 校验、合法 null 返回与在途任务阻断停用
  const calls: string[] = []
  let releaseSlow!: () => void
  const slowGate = new Promise<void>((r) => { releaseSlow = r })
  await host.register({
    id: 'test:core-probe',
    name: 'core probe',
    definePlugin(ctx) {
      ctx.action<{ n: number }, { doubled: number }>({
        id: 'double',
        description: 'double',
        inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { doubled: { type: 'number' } }, required: ['doubled'], additionalProperties: false },
        handler: (input) => { calls.push(`double:${input.n}`); return { doubled: input.n * 2 } },
      })
      ctx.action<{ ok: boolean }, null>({
        id: 'null_out',
        description: 'null out',
        inputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        outputSchema: { type: 'null' },
        handler: () => null,
      })
      ctx.action<Record<string, never>, { done: boolean }>({
        id: 'slow',
        description: 'slow',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { done: { type: 'boolean' } }, required: ['done'], additionalProperties: false },
        handler: async () => { await slowGate; return { done: true } },
      })
      ctx.tool<{ text: string }>({
        name: 'probe_echo',
        description: 'echo',
        inputSchema: { type: 'object', properties: { text: { type: 'string', minLength: 1 } }, required: ['text'], additionalProperties: false },
        execute: (input) => { calls.push(`echo:${input.text}`); return { echoed: input.text } },
      })
    },
  })

  assert.deepEqual(await host.invokeAction('test:core-probe', 'double', { n: 21 }), { doubled: 42 })
  for (const bad of [{ n: 'x' }, {}, { n: 1, extra: true }]) {
    await rejectsExplicitly(() => host.invokeAction('test:core-probe', 'double', bad), { code: 'validation_error', message: /validation failed/ })
  }
  assert.equal(await host.invokeAction('test:core-probe', 'null_out', { ok: true }), null)
  assert.deepEqual(await host.executeTool('probe_echo', { text: 'hi' }, { conversationId: 1 }), { echoed: 'hi' })
  await rejectsExplicitly(() => host.executeTool('probe_echo', { text: '' }, { conversationId: 1 }), { code: 'validation_error', message: /validation failed/ })
  assert.deepEqual(calls, ['double:21', 'echo:hi'])
  await rejectsExplicitly(() => host.invokeAction('test:core-probe', 'nope', {}), { code: 'unknown_action', message: /not declaration/ })
  await rejectsExplicitly(() => host.executeTool('nope', {}, { conversationId: 1 }), { code: 'unknown_tool', message: /not registered/ })

  const slowPromise = host.invokeAction('test:core-probe', 'slow', {})
  await assert.rejects(host.disable('test:core-probe'), (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks')
  releaseSlow()
  assert.deepEqual(await slowPromise, { done: true })
  await host.disable('test:core-probe')
})

test('核心闭环 1 & 2：受管 bash HELM_TOKEN 免磁盘登录直连 CLI 且全链路（CLI/模型/SSE/SQLite/工具回传）脱敏不回显', { timeout: 60_000 }, async (t) => {
  const { kernel, faux, hubUrl, token: userToken } = mainEnv
  const managedToken = (kernel as unknown as { toolDeps?: { processToken?: () => string } }).toolDeps!.processToken!()
  assert.notEqual(kernel.services.stash.redact(managedToken), managedToken)

  // 1. 无磁盘 cli-token 下 HELM_TOKEN 直连 CLI --current
  const cliDataDir = useTempDir(t, 'helm-align-cli-')
  assert.equal(existsSync(join(cliDataDir, 'cli-token')), false)
  const got = await runCliInProcess(['conversations', 'get', '--current', '--json'], {
    HELM_HUB_URL: hubUrl,
    HELM_DATA_DIR: cliDataDir,
    HELM_TOKEN: managedToken,
    HELM_CONVERSATION_ID: String(ROOT_CONVERSATION_ID),
  })
  assert.equal(got.code, 0, got.err)
  assert.equal((JSON.parse(got.out) as { id: number }).id, ROOT_CONVERSATION_ID)
  assert.ok(!got.out.includes(managedToken) && !got.err.includes(managedToken))

  // 模型请求、SSE 增量帧与 SQLite 全表均不含原始受管 Token
  const sub = openSseSubscription(
    hubUrl,
    userToken,
    (fs) => fs.some((f) => f.includes('event: conversation.entry')) && fs.some((f) => f.includes('event: conversation.upsert')),
  )
  await sub.ready
  const seenModel: string[] = []
  faux.setResponses([(ctx) => { seenModel.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('ok') }])
  await kernel.submitInput(ROOT_CONVERSATION_ID, `credentials is ${managedToken} keep`)
  await kernel.waitForIdle(ROOT_CONVERSATION_ID)
  assert.ok(!seenModel[0]!.includes(managedToken))
  assert.ok(!(await sub.frames).join('\n').includes(managedToken))
  assert.deepEqual(sqliteTablesContaining(dbPath, managedToken), [])

  // 2. 真实 bash 工具子进程执行 helm conversations get --current --json
  const bashCliDir = join(mainEnv.dataDir, 'cli-isolated')
  const cmd = [
    `export HELM_DATA_DIR="${bashCliDir}"`,
    `export HELM_CONVERSATION_ID=${ROOT_CONVERSATION_ID}`,
    `"${process.execPath}" "${tsxCli}" "${cliEntry}" conversations get --current --json`,
    'echo CLI_OK',
  ].join(' && ')
  const toolResults: string[] = []
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall('bash', { command: cmd })], { stopReason: 'toolUse' }),
    (ctx) => { toolResults.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('done') },
  ])
  await kernel.submitInput(ROOT_CONVERSATION_ID, 'run cli in managed bash')
  await kernel.waitForIdle(ROOT_CONVERSATION_ID)
  const toolCtx = toolResults[0]!
  assert.ok(!toolCtx.includes(managedToken))
  assert.ok(toolCtx.includes('CLI_OK') && toolCtx.includes('helm.input') && toolCtx.includes('person assist') && toolCtx.includes('entries'))
  assert.ok(/id\\?"?\s*:\s*1\b/.test(toolCtx))
})

test('核心闭环 3 & 4：CLI --meta -> turn_settled、游标分页、SSE 增量（entry/live/plugin.changed/workflow.updated/doc.updated）、manageConversation 与 scope', { timeout: 60_000 }, async (t) => {
  const { kernel, faux, hubUrl, token } = mainEnv
  const host = kernel.plugins

  const settledMetas: Array<Record<string, unknown> | undefined> = []
  await host.register({
    id: 'test:meta-probe',
    name: 'meta probe',
    definePlugin(ctx) {
      ctx.hook.onTurnSettled((payload) => {
        for (const i of payload.inputs) settledMetas.push(i.meta)
      })
    },
  } satisfies PluginDefinition)

  const metaConv = await kernel.createConversation({ title: 'meta-pagination' })
  const subA = openSseSubscription(
    hubUrl,
    token,
    (fs) => fs.some((f) => f.includes('event: conversation.entry') && f.includes('test.render')) && fs.some((f) => f.includes('event: conversation.live')),
  )
  const subB = openSseSubscription(hubUrl, token, (fs) => fs.filter((f) => f.includes('event: plugin.changed')).length >= 2)
  const subC = openSseSubscription(hubUrl, token, (fs) => fs.some((f) => f.includes('event: workflow.updated') && f.includes('"status":"completed"')))
  await Promise.all([subA.ready, subB.ready, subC.ready])

  const meta = { renderer: 'test.render', ticket: 7, nested: { ok: true } }
  const cliDir = useTempDir(t, 'helm-meta-cli-')
  faux.setResponses([fauxAssistantMessage('meta turn complete')])
  const sent = await runCliInProcess(
    ['send', String(metaConv.id), 'carries metadata input', '--meta', JSON.stringify(meta), '--wait', '--json'],
    { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: cliDir, HELM_TOKEN: token },
  )
  assert.equal(sent.code, 0, sent.err)
  assert.equal((JSON.parse(sent.out) as { text: string }).text, 'meta turn complete')
  await waitFor(() => settledMetas.some((m) => m !== undefined))
  assert.deepEqual(settledMetas.find((m) => m !== undefined), meta)
  await host.disable('test:meta-probe')

  const framesA = await subA.frames
  const snapFrame = framesA.find((f) => f.startsWith('event: snapshot'))!
  assert.ok(snapFrame.includes('"ui"') && snapFrame.includes('"pluginDocs"'))

  // 游标分页首尾不丢不重
  const full = (await mainEnv.call('GET', `/api/conversations/${metaConv.id}`)).body as { entries: Array<{ id: string }> }
  const firstPage = (await mainEnv.call('GET', `/api/conversations/${metaConv.id}?limit=1`)).body as { entries: Array<{ id: string }>; nextCursor?: string }
  assert.equal(firstPage.entries.length, 1)
  const collected = [firstPage.entries[0]!.id]
  let cursor = firstPage.nextCursor
  while (cursor !== undefined) {
    const page = (await mainEnv.call('GET', `/api/conversations/${metaConv.id}?limit=2&cursor=${encodeURIComponent(cursor)}`)).body as {
      entries: Array<{ id: string }>
      nextCursor?: string
    }
    collected.push(...page.entries.map((e) => e.id))
    cursor = page.nextCursor
  }
  assert.equal(new Set(collected).size, collected.length)
  assert.deepEqual([...collected].sort(), full.entries.map((e) => e.id).sort())

  // plugin.changed 携带 ui 贡献与空数组回退 + CLI workflows run --wait 触发 workflow.updated
  await host.register({
    id: 'test:ui-probe',
    definePlugin(ctx) { ctx.ui.sidebarItem({ id: 'ui-probe', label: 'probe', target: 'conversation:1' }) },
  })
  await host.disable('test:ui-probe')
  const changed = (await subB.frames).filter((f) => f.includes('event: plugin.changed'))
  assert.ok(changed.some((f) => f.includes('sidebar.item')) && changed.some((f) => f.includes('"enabled":false') && /"ui":\s*\[\]/.test(f)))

  const wfPath = join(cliDir, 'align-wait.workflow.js')
  writeFileSync(wfPath, 'export const meta = { name: "align-wait", description: "t" }\nreturn args.x * 2\n')
  const wfRes = await runCliInProcess(
    ['workflows', 'run', wfPath, '--args', JSON.stringify({ x: 21 }), '--conversation-id', String(metaConv.id), '--wait', '--json'],
    { HELM_HUB_URL: hubUrl, HELM_DATA_DIR: cliDir, HELM_TOKEN: token },
  )
  assert.equal(wfRes.code, 0, wfRes.err)
  const wfRun = (JSON.parse(wfRes.out) as { run: { id: string; result?: unknown } }).run
  assert.equal(wfRun.result, 42)
  assert.ok((await subC.frames).some((f) => f.includes(wfRun.id) && f.includes('"status":"completed"')))

  // ctx.doc 公私边界与脱敏增量、manageConversation 托管保护、scope 工具与 run_action 门禁
  const DOC_SECRET = 'align-doc-secret-blue'
  const docPlaceholder = kernel.services.stash.put(metaConv.id, 'DOC_SECRET', DOC_SECRET)
  const managedConv = await kernel.createConversation({ title: 'managed-conv' })
  let updatePubDoc!: (fn: (v: { note: string; secret: string }) => { note: string; secret: string }) => void

  await host.register({
    id: 'test:guard',
    definePlugin(ctx) {
      const pub = ctx.doc('status', { note: 'init', secret: DOC_SECRET }, { public: true })
      const priv = ctx.doc('inner', { count: 0 })
      updatePubDoc = (fn) => pub.update(fn)
      priv.update((v) => ({ count: v.count + 1 }))
      ctx.action({
        id: 'blocked_out',
        description: 'scoped action',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
        outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false },
        scope: { conversationIds: [managedConv.id] },
        handler: () => ({ ok: true }),
      })
      ctx.tool<{ text: string }>({
        name: 'guard_scoped',
        description: 'scoped tool',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        scope: { profileIds: ['assistant'] },
        execute: (input) => ({ echoed: input.text }),
      })
      ctx.host.manageConversation(managedConv.id)
    },
  })

  try {
    assert.equal((await mainEnv.call('GET', '/api/plugins/test:guard/docs/inner')).status, 404)
    const pubDoc1 = await mainEnv.call('GET', '/api/plugins/test:guard/docs/status')
    assert.equal(pubDoc1.status, 200)
    assert.ok(!pubDoc1.raw.includes(DOC_SECRET) && pubDoc1.raw.includes(docPlaceholder))

    const docSub = openSseSubscription(hubUrl, token, (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes('after-subscribe')))
    await docSub.ready
    updatePubDoc((v) => ({ ...v, note: 'after-subscribe' }))
    const docFrame = (await docSub.frames).find((f) => f.includes('event: plugin.doc.updated'))!
    assert.ok(!docFrame.includes(DOC_SECRET) && docFrame.includes(docPlaceholder))

    const delManaged = await mainEnv.call('DELETE', `/api/conversations/${managedConv.id}`)
    assert.equal(delManaged.status, 409)
    assert.equal(delManaged.body.error.code, 'conversation_managed_by_plugin')

    const rootSummary = kernel.getConversation(ROOT_CONVERSATION_ID)
    const assistantTools = host.listTools(rootSummary).map((tl) => tl.name)
    const otherTools = host.listTools({ ...rootSummary, id: 999, profileId: 'other', tags: [] }).map((tl) => tl.name)
    assert.ok(assistantTools.includes('guard_scoped') && !otherTools.includes('guard_scoped'))

    assert.deepEqual(await host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: managedConv.id }), { ok: true })
    await assert.rejects(
      () => host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: metaConv.id }),
      (err: unknown) => err instanceof HelmError && /scope|effect domain/.test(err.message),
    )
    assert.equal((await mainEnv.call('POST', '/api/actions/test:guard/blocked_out', { input: {} })).status, 200)

    const runActionOutputs: string[] = []
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('run_action', { actionId: 'test:guard.blocked_out', input: {} })], { stopReason: 'toolUse' }),
      (ctx) => { runActionOutputs.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('end') },
    ])
    await kernel.submitInput(metaConv.id, 'try scoped action')
    await kernel.waitForIdle(metaConv.id)
    assert.ok(runActionOutputs.some((o) => /scope|effect domain|reject/.test(o)))
  } finally {
    await host.disable('test:guard')
  }
  assert.equal((await mainEnv.call('DELETE', `/api/conversations/${managedConv.id}`)).status, 200)
})

test('核心闭环 5：agent_spawn 外部后端 handled 接管（onResolved / onGateResult 真实元数据、Gate 恰好一次、journal 重放与缺报 gate_result_missing 拒绝）', { timeout: 60_000 }, async () => {
  const { kernel, dataDir } = mainEnv
  const runWorkflow = (req: Record<string, unknown>) =>
    kernel.plugins.invokeAction('builtin:workflow', 'run', req) as Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>
  const inspectRun = (runId: string) =>
    kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>

  const execDir = join(dataDir, 'external-exec')
  mkdirSync(execDir, { recursive: true })
  const gateDir = join(dataDir, 'gate-files')
  const execId = `ext-${Date.now()}`
  const gates: string[] = []
  let settleCount = 0
  let settleEntered = false
  let releaseSettle: () => void = () => {}
  const settleGate = new Promise<void>((r) => { releaseSettle = r })

  await kernel.plugins.register({
    id: 'test:ext-backend',
    definePlugin(ctx) {
      ctx.hook.onAgentSpawn(async (request) => {
        if (!request.onResolved || !request.onGateResult) throw new HelmError('test_backend_contract', 'missing callbacks', 500)
        request.onResolved({
          nodeId: 'local',
          executionId: execId,
          effectiveCwd: execDir,
          meta: { 'builtin:workflow': { worktree: { path: execDir, branch: 'align-wt' } } },
        })
        if (request.gate !== undefined) {
          const result = await kernel.runGate(request.gate, { cwd: execDir, conversationId: request.parentConversationId })
          gates.push(request.gate)
          request.onGateResult(result)
        }
        return { action: 'handled', result: { answer: 42, source: 'external' } }
      })
      ctx.host.onEvent('workflow.settled', async () => {
        settleEntered = true
        settleCount += 1
        await settleGate
      })
    },
  } satisfies PluginDefinition)

  try {
    const gateCmd = `mkdir -p "${gateDir}" && printf x >> "${join(gateDir, 'count')}"`
    const script =
      'export const meta = { name: "align-ext", description: "external backend" }\n' +
      'return await agent("external extract", { schema: ' +
      JSON.stringify({ type: 'object', properties: { answer: { type: 'number' }, source: { type: 'string' } }, required: ['answer'], additionalProperties: false }) +
      ', gate: ' + JSON.stringify(gateCmd) + ' })'

    const startedPromise = runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    await waitFor(() => settleEntered)
    releaseSettle()
    const { run: started } = await startedPromise
    assert.deepEqual(started.result, { answer: 42, source: 'external' })

    const node = (await inspectRun(started.id)).run.nodes?.find((n) => n.kind === 'agent')!
    assert.equal(node.executionId, execId)
    assert.equal(node.effectiveCwd, execDir)
    assert.equal(node.worktree?.id, `local:${execDir}`)
    assert.equal(node.gate?.ok, true)
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x')
    assert.equal(settleCount, 1)

    const { run: resumed } = await runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    assert.equal((resumed.result as { answer: number }).answer, 42)
    assert.equal(gates.length, 1)
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x')
  } finally {
    releaseSettle()
    await kernel.plugins.disable('test:ext-backend')
  }

  await kernel.plugins.register({
    id: 'test:ext-nogate',
    definePlugin(ctx) {
      ctx.hook.onAgentSpawn((request) => {
        request.onResolved?.({ executionId: `${execId}-nogate`, effectiveCwd: execDir })
        return { action: 'handled', result: { answer: 1 } }
      })
    },
  } satisfies PluginDefinition)
  try {
    const badScript =
      'export const meta = { name: "align-nogate", description: "gate missing" }\n' +
      `const v = await agent("missing gate", { gate: "printf should-not-run >> '${join(gateDir, 'count')}'" })\n` +
      'if (!v) throw new Error("agent failed")\nreturn v'
    let badId = ''
    await assert.rejects(
      () => runWorkflow({ script: badScript, conversationId: ROOT_CONVERSATION_ID, wait: true }),
      (err: unknown) => {
        badId = String((err as { details?: { runId?: string } }).details?.runId ?? '')
        return err instanceof HelmError && err.code === 'workflow_failed'
      },
    )
    const badNode = (await inspectRun(badId)).run.nodes?.find((n) => n.kind === 'agent')!
    assert.ok(badNode.error?.includes('gate_result_missing'))
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x')
  } finally {
    await kernel.plugins.disable('test:ext-nogate')
  }
})

// ---------------------------------------------------------------------------
// 独立 HTTP + CLI 真实鉴权闭环（覆盖匿名 401、scrypt setup/login、cli-token、真实子进程 CLI 与出站脱敏）
// ---------------------------------------------------------------------------

test('HTTP 与 CLI 真实鉴权往返闭环：setup/login、cli-token、?wait=1、出站脱敏、公开路由、真实子进程 CLI 与删除初始会话后工作流路由', { timeout: 60_000 }, async (t) => {
  const dataDir = join(useTempDir(t, 'helm-core-http-cli-'), 'hub')
  const { app, kernel, faux } = await createHubTestApp({ dataDir, cwd: dataDir })
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const probeState = { secret: SECRET_TRICKY, placeholder: '' }

  await kernel.plugins.register({
    id: 'test:probe',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { text: string }>({
        id: 'echo',
        description: 'echo',
        cli: { command: ['probe', 'echo'] },
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
        handler: (input) => ({ text: `${input.text} ${probeState.secret} ${probeState.placeholder}` }),
      })
      ctx.action<{ n: number }, { doubled: number }>({
        id: 'double',
        description: 'double',
        cli: { command: ['probe', 'double'] },
        inputSchema: { type: 'object', properties: { n: { type: 'number' } }, required: ['n'], additionalProperties: false },
        outputSchema: { type: 'object', properties: { doubled: { type: 'number' } }, required: ['doubled'], additionalProperties: false },
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

  const hub = await startHub({ kernel: kernel as never, port: 0 })
  const rootPassword = 'integration testRootpassword eight'
  const cliEnv = { HELM_HUB_URL: hub.url, HELM_DATA_DIR: dataDir }
  const run = (argv: string[], extra: NodeJS.ProcessEnv = {}) => runCliInProcess(argv, { ...cliEnv, ...extra })

  try {
    // 1. 未登录鉴权门禁（HTTP 401 + CLI unauthorized + /api/auth/status configured=false）
    assert.equal((await fetch(`${hub.url}/api/conversations`)).status, 401)
    assert.equal(((await (await fetch(`${hub.url}/api/auth/status`)).json()) as { configured: boolean }).configured, false)
    const anonCli = await run(['conversations', 'list', '--json'])
    assert.notEqual(anonCli.code, 0)
    assert.equal((JSON.parse(anonCli.err) as { error: { code: string } }).error.code, 'unauthorized')

    // 2. CLI setup 写入 cli-token + HTTP login 校验
    const setup = await run(['setup', '--password', rootPassword, '--json'])
    assert.equal(setup.code, 0, setup.err)
    const token = (JSON.parse(readFileSync(join(dataDir, 'cli-token'), 'utf8')) as { token: string }).token
    assert.equal(
      (await fetch(`${hub.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong password long enough' }) })).status,
      401,
    )
    assert.equal(
      (await fetch(`${hub.url}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: rootPassword }) })).status,
      200,
    )
    assert.equal(JSON.parse((await run(['status', '--json'])).out).configured, true)

    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${hub.url}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      })
      return { status: res.status, raw: await res.text() }
    }

    // 3. HTTP 提交（202 异步 + ?wait=1 同步等待）、动作校验、出站脱敏、SSE 首帧与公开插件路由
    const convId = (JSON.parse((await call('POST', '/api/conversations', { title: 'http-conv', profileId: 'assistant' })).raw) as { id: number }).id
    faux.setResponses([fauxAssistantMessage('HTTP async ok')])
    assert.equal((await call('POST', `/api/conversations/${convId}/input`, { text: 'hi' })).status, 202)
    await kernel.waitForIdle(convId)

    faux.setResponses([fauxAssistantMessage('HTTP wait answer')])
    const waited = await call('POST', `/api/conversations/${convId}/input?wait=1`, { text: 'wait check' })
    assert.equal(waited.status, 200)
    assert.equal((JSON.parse(waited.raw) as { text: string }).text, 'HTTP wait answer')

    assert.equal((await call('POST', '/api/actions/builtin:memory/get', { input: {} })).status, 400)
    assert.equal(JSON.parse((await call('POST', '/api/actions/builtin:memory/get', { input: {}, conversationId: convId })).raw).profileId, 'assistant')
    assert.equal((await call('POST', '/api/actions/builtin:memory/get', { input: { profileId: 'missing' }, conversationId: convId })).status, 404)
    assert.equal((await call('POST', '/api/actions/builtin:memory/get', { input: { profileId: '../outside' }, conversationId: convId })).status, 400)
    assert.equal((await call('POST', '/api/actions/test:probe/echo', { input: { text: 123 } })).status, 400)

    probeState.placeholder = kernel.services.stash.put(convId, 'TRICKY_TOKEN', SECRET_TRICKY)
    const echoRes = await call('POST', '/api/actions/test:probe/echo', { input: { text: 'prefix' } })
    assert.ok(!echoRes.raw.includes(SECRET_TRICKY) && !echoRes.raw.includes('quote\\"') && echoRes.raw.includes(probeState.placeholder))

    const sseRes = await fetch(`${hub.url}/api/events`, { headers: { authorization: `Bearer ${token}` } })
    const sseReader = sseRes.body!.getReader()
    assert.ok(new TextDecoder().decode((await sseReader.read()).value).includes('event: snapshot'))
    await sseReader.cancel().catch(() => {})

    const pubRoute = await fetch(`${hub.url}/api/plugins/${encodeURIComponent('test:probe')}/routes/ping`)
    assert.equal(pubRoute.status, 200)
    assert.equal(((await pubRoute.json()) as { via: string }).via, 'plugin-route')

    // 4. CLI memory --current、动态命令、真实 OS 子进程 CLI 与删除初始会话后 workflow 目标约束
    await kernel.services.profiles.save({ id: 'coder', name: 'Coder', tags: [] })
    const coderConv = await kernel.createConversation({ profileId: 'coder' })
    const curEnv = { HELM_CONVERSATION_ID: String(coderConv.id) }
    assert.equal((await run(['memory', 'set', '--current', '--text', '# Coder memory', '--json'], curEnv)).code, 0)
    assert.equal(JSON.parse((await run(['memory', 'get', '--current', '--json'], curEnv)).out).content, '# Coder memory')
    assert.equal(JSON.parse((await run(['memory', 'configure', '--current', '--enabled=false', '--json'], curEnv)).out).enabled, false)
    assert.equal(JSON.parse((await run(['memory', 'get', '--profile-id', 'assistant', '--current', '--json'], curEnv)).out).profileId, 'assistant')
    assert.notEqual((await run(['memory', 'get', '--json'])).code, 0)

    assert.equal(JSON.parse((await run(['probe', 'double', '--n', '21', '--json'])).out).doubled, 42)
    assert.notEqual((await run(['probe', 'double', '--n', 'abc', '--json'])).code, 0)
    assert.notEqual((await run(['probe', 'double', '--input', '{"n":"bad"}', '--json'])).code, 0)

    const [childStatus, childGet, childAuth] = await Promise.all([
      runCliChild(['status', '--json'], { ...process.env, ...cliEnv, HELM_TOKEN: '' }),
      runCliChild(['conversations', 'get', String(convId), '--json'], { ...process.env, ...cliEnv, HELM_TOKEN: '' }),
      runCliChild(['conversations', 'list', '--json'], { ...process.env, ...cliEnv, HELM_TOKEN: '' }),
    ])
    assert.equal(childStatus.code, 0, childStatus.err)
    assert.equal(childGet.code, 0, childGet.err)
    assert.equal(childAuth.code, 0, childAuth.err)

    assert.equal((await run(['conversations', 'delete', '1', '--json'])).code, 0)
    assert.equal((await call('GET', '/api/conversations/1')).status, 404)

    const wfScript = (name: string) => `export const meta = { name: "${name}", description: "t" }\nreturn 42`
    assert.notEqual((await run(['workflows', 'run', '--script', wfScript('no-target'), '--wait', '--json'])).code, 0)
    assert.equal(JSON.parse((await run(['workflows', 'run', '--script', wfScript('cur'), '--wait', '--current', '--json'], { HELM_CONVERSATION_ID: String(convId) })).out).run.conversationId, convId)
    assert.equal(JSON.parse((await run(['workflows', 'run', '--script', wfScript('exp'), '--wait', '--conversation-id', String(convId), '--json'])).out).run.conversationId, convId)

    const toolRun = await kernel.plugins.executeTool(
      'SubagentWorkflow',
      { script: wfScript('tool'), background: false },
      { conversationId: convId, callId: 'wf-tool' },
    ) as { structuredOutput?: { summary?: { conversationId?: number } } }
    assert.equal(toolRun.structuredOutput?.summary?.conversationId, convId)
  } finally {
    await hub.close()
    await app.close()
  }
})

// ---------------------------------------------------------------------------
// 独立跨重启持久闭环（受管技能防篡改覆盖、会话历史与 SSE seq 保持、双 Profile 隔离与 PATCH 切换）
// ---------------------------------------------------------------------------

test('跨重启持久闭环：helm-cli 受管技能篡改恢复与只读门禁、会话历史与 SSE seq 保持、双 Profile 隔离与 PATCH 切换', { timeout: 60_000 }, async (t) => {
  const dataDir = join(useTempDir(t, 'helm-core-restart-'), 'hub')
  writeProfile(dataDir, 'researcher', {
    system: '# Researcher System\nyou is research member. unique mark record ALIGN-SYS-RESEARCHER.',
    memory: 'RESEARCHER-MEM: bias well quote text',
  })
  writeProfile(dataDir, 'coder', {
    system: '# Coder System\nyou is program member. unique mark record ALIGN-SYS-CODER.',
    memory: 'CODER-MEM: bias well test',
  })

  const MARK = 'restart-persist-mark-PERSIST'
  let seqAfterFirst = 0
  let initialId = 0

  const first = await createHubTestApp({ dataDir, cwd: dataDir })
  try {
    // 校验 helm-cli 与 generative-ui 受管技能内容后模拟磁盘篡改/误删 + 用户自建技能
    const skills = await first.kernel.skills.list()
    const helmCli = skills.find((s) => s.id === 'helm-cli')!
    assert.equal(helmCli.managedByPlugin, 'builtin:profile')
    assert.ok(helmCli.references.includes('references/plugin-client-code-splitting.md'))
    assert.equal(skills.find((s) => s.id === 'generative-ui')?.managedByPlugin, 'builtin:json-render')

    writeFileSync(join(dataDir, 'skills', 'helm-cli', 'SKILL.md'), '---\nname: helm-cli\ndescription: tampered\n---\ntampered\n')
    rmSync(join(dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'))
    rmSync(join(dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'))
    writeSkill(dataDir, 'user-skill', '---\nname: user-skill\ndescription: user self create\n---\nbody\n', { 'notes.md': '# user\n' })

    // 初始会话历史落库 + 双 Profile 独立 SYSTEM/MEMORY 校验
    initialId = first.kernel.listConversations().find((c) => c.profileId === 'assistant')!.id
    first.faux.setResponses([fauxAssistantMessage(`recorded:${MARK}`)])
    await first.kernel.submitInput(initialId, `record:${MARK}`)
    await first.kernel.waitForIdle(initialId)

    const r1 = await first.kernel.createConversation({ title: 'research member', profileId: 'researcher' })
    const c1 = await first.kernel.createConversation({ title: 'program member', profileId: 'coder' })
    const seen1: string[] = []
    first.faux.setResponses([
      (ctx) => { seen1.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('r') },
      (ctx) => { seen1.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('c') },
    ])
    await first.kernel.submitInput(r1.id, 'who are you')
    await first.kernel.waitForIdle(r1.id)
    await first.kernel.submitInput(c1.id, 'who are you')
    await first.kernel.waitForIdle(c1.id)
    assert.ok(seen1[0]!.includes('ALIGN-SYS-RESEARCHER') && seen1[0]!.includes('RESEARCHER-MEM') && !seen1[0]!.includes('# Coder System'))
    assert.ok(seen1[1]!.includes('ALIGN-SYS-CODER') && seen1[1]!.includes('CODER-MEM') && !seen1[1]!.includes('# Researcher System'))
    seqAfterFirst = first.kernel.events.seq
  } finally {
    await first.app.close()
  }

  const second = await openHubHttpEnv({ dataDir, cwd: dataDir })
  try {
    // 1. 受管技能覆盖回源码且写接口 403，用户自建技能完好可写
    assert.equal(readFileSync(join(dataDir, 'skills', 'helm-cli', 'SKILL.md'), 'utf8'), HELM_CLI_SKILL_ASSET.skillMd)
    assert.equal(
      readFileSync(join(dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'), 'utf8'),
      HELM_CLI_SKILL_ASSET.references['skill-and-plugin-dev.md'],
    )
    assert.equal(
      readFileSync(join(dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'), 'utf8'),
      HELM_CLI_SKILL_ASSET.references['plugin-client-code-splitting.md'],
    )
    await assert.rejects(
      () => second.kernel.skills.writeFile('helm-cli', 'SKILL.md', 'tamper'),
      (err: unknown) => err instanceof HelmError && err.code === 'managed_skill_readonly' && err.status === 403,
    )
    assert.ok(readFileSync(join(dataDir, 'skills', 'user-skill', 'SKILL.md'), 'utf8').includes('user self create'))
    await second.kernel.skills.writeFile('user-skill', 'references/extra.md', '# user extra\n')

    // 2. 会话历史、SSE seq 与 completionSeq 保持
    assert.ok(second.kernel.events.seq >= seqAfterFirst)
    assert.ok(second.kernel.getConversation(initialId).completionSeq >= 1)
    const seenHistory: string[] = []
    second.faux.setResponses([(ctx) => { seenHistory.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('resumed') }])
    await second.kernel.submitInput(initialId, 'recall')
    await second.kernel.waitForIdle(initialId)
    assert.ok(seenHistory[0]!.includes(MARK))

    // 3. 双 Profile 重启保持、HTTP PATCH 切换 Profile 与模型覆盖清空
    const r1 = second.kernel.listConversations().find((c) => c.title === 'research member')!
    assert.equal((await second.call('PATCH', `/api/conversations/${r1.id}`, { profileId: 'coder' })).status, 200)
    const seenSwitched: string[] = []
    second.faux.setResponses([(ctx) => { seenSwitched.push(JSON.stringify(ctx.messages)); return fauxAssistantMessage('c2') }])
    await second.kernel.submitInput(r1.id, 'after patch')
    await second.kernel.waitForIdle(r1.id)
    assert.ok(seenSwitched[0]!.includes('ALIGN-SYS-CODER') && !seenSwitched[0]!.includes('# Researcher System'))

    assert.equal((await second.call('PATCH', `/api/conversations/${r1.id}`, { model: 'faux/faux-1' })).status, 200)
    const cleared = await second.call('PATCH', `/api/conversations/${r1.id}`, { model: '' })
    assert.equal(cleared.status, 200)
    assert.ok(typeof cleared.body.model === 'string' && cleared.body.model !== '')
  } finally {
    await second.close()
  }
})
