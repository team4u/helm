/**
 * helm core end-to-end collection into verify (only this file and app-workflow.integration.test.ts, do not modify implement).
 *
 * combine discipline: one rule via real combine entry createHelm(src/app.ts) group install - - true pi-durable
 * SQLite durable layer + true PluginHost + true builtin:profile / builtin:memory + true WorkflowService +
 * faux provider(pi-ai official test provider, process inside script response). do not new
 * KernelRuntime, do not self create MemoryDocStore, do not manually piece together HTTP kernel adapter.
 *
 * honest discipline:
 * - all model output all from faux.setResponses script, does not mean real outside network model capability;
 * - if runtime collection into fix (createHelm combine) not yet together this worktree while leads to
 *   import crash, the whole set test such as failed (attach diagnose), do not skip, do not mock app;
 * - each items assertion for across module contract (see each test note release), do not mirror implement detail.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import { test } from 'node:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type PluginDefinition } from '@helm/protocol'
import { HELM_CLI_SKILL_ASSET } from '../../plugins/src/profile.js'
import { MemoryStore } from '../../plugins/src/memory/store.js'
import { createProfileFileHost } from '../../kernel/test/helpers/profile-file-host.js'
import { startHub } from '../../kernel/src/http/index.js'
import { redactJsonValue } from '../../kernel/src/redact.js'
import {
  createHubTestApp,
  waitFor as waitForCondition,
  type FauxProviderHandle,
  type HubTestApp,
} from './helpers/hub-test-env.js'

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
  faux: FauxProviderHandle
  app: HubTestApp
  runWorkflow(request: Record<string, unknown>): Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>
  inspectRun(runId: string): Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>
  close(): Promise<void>
}

async function makeCoreEnv(): Promise<CoreEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-'))
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir })
  const plugins = app.kernel.plugins
  return {
    dataDir,
    dbPath: join(dataDir, 'state.sqlite'),
    faux,
    app,
    runWorkflow: (request) =>
      plugins.invokeAction('builtin:workflow', 'run', request) as Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>,
    inspectRun: (runId) =>
      plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as Promise<{ run: import('@helm/plugins/contracts').WorkflowRunSummary }>,
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// base create: real createHelm combine environment
// ---------------------------------------------------------------------------

interface TestEnv {
  dataDir: string
  dbPath: string
  faux: FauxProviderHandle
  /** createHelm return complete app(real combine entry artifact). */
  app: HubTestApp
  /** each time model request complete message (faux official TranscriptContext catch). */
  requests: Array<{ roles: string[]; systemSections: string[]; userTexts: string[]; assistantTexts: string[] }>
  /** first time start broadcast initial assistant entry conversation ID(by SDK root #1 bear load, ordinary conversation semantics). */
  initialConvId: number
  /** real commit + wait for idle (contains turn_settled hook). */
  submitAndWait(text: string, opts?: { origin?: 'human' | 'agent' | 'trigger' }): Promise<void>
  /** append a capture response to faux queue. */
  capture(): FauxResponseStep
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dataDir, 'state.sqlite')

  // real combine entry: true SQLite + true PluginHost + profile/memory + WorkflowService.
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
  })

  const requests: TestEnv['requests'] = []
  faux.setResponses([])

  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('first time start should broadcast assistant entry conversation')
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
        return fauxAssistantMessage('(not script response: test should explicit setResponses)')
      }
    },
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return env
}

/** declaration skill package (real file:SKILL.md + references/*.md). */
function writeSkill(dataDir: string, id: string, skillMd: string, refs: Record<string, string>): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  const refDir = join(dir, 'references')
  if (!existsSync(refDir)) mkdirSync(refDir)
  for (const [name, content] of Object.entries(refs)) writeFileSync(join(refDir, name), content)
}

/** sqlite all table byte level scan: return contains needle table name set (secret do not written to the database assertion). */
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

/** assertion reject: takes precedence match HelmError(code), also accept service layer original generate Error + message. */
async function rejectsExplicitly(
  fn: () => Promise<unknown>,
  expected: { code?: string; message: RegExp },
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      if (expected.code !== undefined) {
        assert.ok(err instanceof HelmError, `should be HelmError, actual ${String(err)}`)
        assert.equal(err.code, expected.code)
      }
      assert.match(err instanceof Error ? err.message : String(err), expected.message)
      return true
    },
    `should explicit reject:${expected.message}`,
  )
}

// ---------------------------------------------------------------------------
// 1. profile/memory self raise + real turn + before_turn sections real enter model request
// ---------------------------------------------------------------------------

test('collection into1: createHelm combine - -profile/memory by default coordinate same,locked protect,SYSTEM/MEMORY sections real enter model request,update_memory across turn durable', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // fix after plugins getter non- undefined(runtime collection into fix target); test by contract directly consume
    const host = kernel.plugins!

    // --- self raise:locked builtin:profile + by default enable can deactivate builtin:memory
    const profileSummary = host.list().find((p) => p.id === 'builtin:profile')
    assert.ok(profileSummary, 'builtin:profile should via createHelm register')
    assert.equal(profileSummary.locked, true)
    assert.equal(profileSummary.enabled, true)
    assert.ok(profileSummary.tools.includes('load_skill'))
    await rejectsExplicitly(() => host.disable('builtin:profile'), { code: 'plugin_locked', message: /lock/ })
    await rejectsExplicitly(() => host.unregister('builtin:profile'), { code: 'plugin_locked', message: /lock/ })
    const memorySummary = host.list().find((p) => p.id === 'builtin:memory')
    assert.ok(memorySummary, 'builtin:memory should via createHelm register')
    assert.equal(memorySummary.locked, false)
    assert.equal(memorySummary.enabled, true)
    assert.ok(memorySummary.tools.includes('update_memory'))
    assert.ok(memorySummary.actions.includes('get') && memorySummary.actions.includes('set') && memorySummary.actions.includes('configure'))

    // --- conversation #1 by createHelm create (real SQLite durable)
    const conv = kernel.getConversation(env.initialConvId)
    assert.equal(conv.id, env.initialConvId)
    assert.equal(conv.profileId, 'assistant')

    // --- first round request:before_turn sections via real system message enter model (faux catch)
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    assert.equal(env.requests.length, 1, 'first round exactly once model request')
    const first = env.requests[0]!
    assert.ok(first.roles.includes('system'), 'request should contains role=system message (sections real inject)')
    const allText = first.systemSections.join('\n') + first.userTexts.join('\n')
    assert.ok(first.systemSections.some((s) => s.includes('# System Prompt')), 'SYSTEM.md should via sections inject')
    assert.ok(allText.includes('<memory>'), 'MEMORY.md should via sections inject (<memory> package wrap)')

    // --- real tool link:faux start update_memory → file append → under one round request visible
    const MEMORY_FACT = 'FAVORITE_COLOR=cyan porcelain green'
    env.requests.length = 0
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('update_memory', { text: MEMORY_FACT, mode: 'append' })],
        { stopReason: 'toolUse' },
      ),
      env.capture(),
    ])
    await env.submitAndWait('please record I most like color is cyan porcelain green')

    const memoryFile = await new MemoryStore(createProfileFileHost(kernel.dataDir)).getMemory('assistant')
    assert.ok(memoryFile.includes(MEMORY_FACT), 'MEMORY.md should contains new memory (real file write)')

    // wrap-up round request carries new memory (across module: tool write → before_turn heavy read → model request)
    const afterTurn = env.requests[0]!
    assert.ok(
      afterTurn.systemSections.join('\n').includes(MEMORY_FACT),
      'after write request system sections should contains new memory',
    )

    // --- third round: across turn durable (memory is not only in tool when round visible)
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('I before say like what color?')
    assert.ok(
      env.requests[0]!.systemSections.join('\n').includes(MEMORY_FACT),
      'new turn request still contains memory',
    )

    // persist core verify:entry real written to the database (the same state.sqlite)
    assert.ok(
      sqliteTablesContaining(env.dbPath, MEMORY_FACT).length > 0,
      'memory content should real persist (pi_entries)',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. load_skill:references can read + out of bounds reject (real SkillService guard against defend)
// ---------------------------------------------------------------------------

test('collection into2: load_skill read SKILL.md and references/ sub- file, path through exceeds/absolute path/unknown skill by explicit reject', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    writeSkill(
      env.dataDir,
      'deploy-playbook',
      '---\nname: deploy manual\ndescription: publish stream process\n---\n# deploy\nsee references/.',
      { 'rollback.md': 'rollback: execute helm rollback --canary', 'db-migrate.md': 'migration before backup state.sqlite' },
    )

    const host = env.app.kernel.plugins!
    const readMain = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook' },
      { conversationId: env.initialConvId },
    )) as { text: string }
    assert.ok(readMain.text.includes('deploy'), 'default read SKILL.md')

    const readRef = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook', path: 'references/rollback.md' },
      { conversationId: env.initialConvId },
    )) as { text: string }
    assert.ok(readRef.text.includes('helm rollback'), 'should can on demand read references sub- file')

    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '../profiles/assistant/MEMORY.md' }, { conversationId: env.initialConvId }),
      { message: /forbidden path traversal|reference validation failed/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'deploy-playbook', path: '/etc/passwd' }, { conversationId: env.initialConvId }),
      { message: /absolute path|reference validation failed/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: env.initialConvId }),
      { message: /missing|no-such-skill/ },
    )

    // model directory inject:before_turn  <available_skills> segment contains skill and references path
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('read db-migrate manual')
    const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
    assert.ok(catalog, '<available_skills> segment should inject model request')
    assert.ok(catalog!.includes('deploy-playbook'), 'directory should contains skill id')
    assert.ok(catalog!.includes('references/db-migrate.md'), 'directory should contains references path')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.5 helm-cli system level inside placement skill self raise (builtin:profile service.start idempotent patch complete)
// ---------------------------------------------------------------------------

test('collection into2.5: createHelm start i.e. sync helm-cli skill (managed override),load_skill can read SKILL.md and three references, restart override back source code version', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // start i.e. contains helm-cli(managedByPlugin = builtin:profile, contains three references)
    const skills = await kernel.skills.list()
    const summary = skills.find((s) => s.id === 'helm-cli')
    assert.ok(summary, 'helm-cli skill should via builtin:profile start self raise')
    assert.equal(summary.managedByPlugin, 'builtin:profile')
    for (const ref of [
      'references/workflows-and-agents.md',
      'references/skill-and-plugin-dev.md',
      'references/plugin-client-code-splitting.md',
    ]) {
      assert.ok(summary.references.includes(ref), `references should contains ${ref}`)
    }
    // generative-ui skill by builtin:json-render plugin self raise (by default enable), follow plugin start stop filter
    const genUi = skills.find((sk) => sk.id === 'generative-ui')
    assert.ok(genUi, 'generative-ui skill should via builtin:json-render start self raise')
    assert.equal(genUi.managedByPlugin, 'builtin:json-render')

    // ordinary turn only inject skill directory, does not UI/workflow manual all text stuff common resident context.
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    const sections = env.requests[0]!.systemSections.join('\n')
    assert.ok(sections.includes('helm-cli'), 'ordinary turn should can discover inside create skill')
    assert.ok(sections.includes('generative-ui'), 'directory should contains json-render plugin skill (rich render entry)')
    assert.ok(!sections.includes('MetricGrid'), 'UI component dictionary must not common resident')
    assert.ok(!sections.includes('workflow(ref, args?)'), 'workflow manual must not common resident')

    // load_skill tool link:SKILL.md and three references all can read and content quality
    const host = kernel.plugins!
    const readSkill = (path?: string) =>
      host.executeTool(
        'load_skill',
        path === undefined ? { skillId: 'helm-cli' } : { skillId: 'helm-cli', path },
        { conversationId: env.initialConvId },
      ) as Promise<{ text: string }>
    const main = await readSkill()
    assert.ok(main.text.includes('helm') && main.text.includes('--json'), 'SKILL.md should contains CLI iron rule')
    const ui = await host.executeTool(
      'load_skill',
      { skillId: 'generative-ui' },
      { conversationId: env.initialConvId },
    ) as { text: string }
    assert.ok(ui.text.includes('```ui'), 'generative-ui skill should contains surround column use method')
    assert.ok(ui.text.includes('primitives.md'), 'should points to original language contract references')
    const wf = await readSkill('references/workflows-and-agents.md')
    assert.ok(wf.text.includes('pipeline') && wf.text.includes('resumeFromRunId'), 'workflows should contains orchestration API and checkpoint replay')
    const dev = await readSkill('references/skill-and-plugin-dev.md')
    assert.ok(dev.text.includes('definePlugin') && dev.text.includes('ctx.action'), 'skill-and-plugin-dev should contains plugin development guide')
    const splitting = await readSkill('references/plugin-client-code-splitting.md')
    assert.ok(
      splitting.text.includes('__helm_import_chunk') && splitting.text.includes('import()') && splitting.text.includes('helm plugins doctor'),
      'plugin-client-code-splitting should contains AI use rule, host bridge disable items and verify command',
    )

    // restart (rebuild app) after managed override: disk manually work tamper SKILL.md and reference back to
    // source code version, by delete reference patch complete; user self create skill do not subject to affect and still can write
    const customMain = '---\nname: helm-cli\ndescription: user change write\n---\nI version\n'
    const customRef = '# I change UI manual\n'
    writeFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), customMain)
    writeFileSync(join(env.dataDir, 'skills', 'generative-ui', 'SKILL.md'), customRef)
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'))
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'))
    writeSkill(env.dataDir, 'user-skill', '---\nname: user-skill\ndescription: user self create\n---\nbody text\n', { 'notes.md': '# user pen record\n' })
    await env.app.close()

    const { app: app2 } = await createHubTestApp({ dataDir: env.dataDir, cwd: env.dataDir })
    try {
      // managed skill: tamper file by override back source code version, missing reference by patch complete
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.skillMd,
        'after restart SKILL.md must back to source code version',
      )
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'workflows-and-agents.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['workflows-and-agents.md']!,
        'after restart managed reference must back to source code version',
      )
      const restored = readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'), 'utf8')
      assert.equal(restored, HELM_CLI_SKILL_ASSET.references['skill-and-plugin-dev.md']!, 'missing reference by patch complete is source code version')
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['plugin-client-code-splitting.md']!,
        'missing code split reference by patch complete is source code version',
      )
      const again = await app2.kernel.skills.list()
      assert.equal(again.find((s) => s.id === 'helm-cli')?.description, HELM_CLI_SKILL_ASSET.skillMd.match(/description: (.+)/)?.[1])

      // managed skill write opening: service boundary 403 managed_skill_readonly
      await assert.rejects(
        () => app2.kernel.skills.writeFile('helm-cli', 'SKILL.md', 'tamper'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'managed_skill_readonly')
          assert.equal(err.status, 403)
          return true
        },
      )

      // user self create skill: content do not by override, still can write
      assert.ok(readFileSync(join(env.dataDir, 'skills', 'user-skill', 'SKILL.md'), 'utf8').includes('user self create'), 'user self create skill do not by managed override trigger touch')
      await app2.kernel.skills.writeFile('user-skill', 'references/extra.md', '# user new increase\n')
      assert.ok(
        readFileSync(join(env.dataDir, 'skills', 'user-skill', 'references', 'extra.md'), 'utf8').includes('user new increase'),
        'user self create skill still can write',
      )
    } finally {
      await app2.close()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.7 Profile skills blank name single: double Profile isolated,[] disable, plugin start stop sync filter
// ---------------------------------------------------------------------------

test('collection into2.7: Profile skills blank name single - - double Profile directory isolated,[] without directory and reject, blank name single inside references can read, plugin start stop sync, runtime change write under round takes effect', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!

    // three user skill: ordinary A/B + plugin hosting skill (frontmatter declaration hosting)
    writeSkill(
      env.dataDir,
      'alpha-guide',
      '---\nname: Alpha manual\ndescription: A\n---\n# Alpha\nsee references/.',
      { 'intro.md': 'Alpha quote say: only blank name single.' },
    )
    writeSkill(
      env.dataDir,
      'beta-guide',
      '---\nname: Beta manual\ndescription: B\n---\n# Beta\nbody text.',
      {},
    )
    writeSkill(
      env.dataDir,
      'managed-guide',
      '---\nname: hosting manual\ndescription: hosting\nmanagedByPlugin: builtin:superagent\n---\n# hosting\nbody text.',
      {},
    )

    // double Profile: blank name single only contains alpha-guide; all forbid Profile skills=[]
    await kernel.profiles.save({ id: 'white-profile', name: 'blank name single', tags: [], skills: ['alpha-guide'] })
    await kernel.profiles.save({ id: 'none-profile', name: 'all forbid', tags: [], skills: [] })
    const convWhite = await kernel.createConversation({ title: 'blank name single conversation', profileId: 'white-profile' })
    const convNone = await kernel.createConversation({ title: 'all forbid conversation', profileId: 'none-profile' })

    // ① blank name single inside skill can read,references sub- file same rule can read
    const main = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(main.text.includes('Alpha'), 'blank name single inside SKILL.md can read')
    const ref = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide', path: 'references/intro.md' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(ref.text.includes('blank name single'), 'blank name single inside references sub- file can read')

    // ② blank name single outside (in directory in but do not in profile.skills)→ 403 skill_not_available
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'beta-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )

    // ③ [] Profile: directory do not inject + all skill reject (contains helm-cli inside placement skill)
    {
      // use kernel.submitInput directly drive all forbid conversation (faux catch the turn sections)
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convNone.id, 'all forbid back stage')
      await kernel.waitForIdle(convNone.id)
      const catalogNone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogNone, undefined, 'skills=[]  Profile must not inject skill directory')
    }
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'alpha-guide' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'helm-cli' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )

    // ④ by default assistant Profile(default): all available skill inject (contains helm-cli and blank name single outside beta)
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await env.submitAndWait('default directory')
      const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalog, 'default Profile should inject directory')
      for (const id of ['helm-cli', 'alpha-guide', 'beta-guide']) {
        assert.ok(catalog!.includes(`id="${id}"`), `default directory should contains ${id}`)
      }
    }

    // ⑤ blank name single Profile directory: only contains blank name single inside skill, excludes other (contains hosting managed-guide not enabled plugin)
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'blank name single back stage')
      await kernel.waitForIdle(convWhite.id)
      const catalogW = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogW, 'blank name single Profile should inject directory')
      assert.ok(catalogW!.includes('id="alpha-guide"'), 'directory should contains blank name single inside skill')
      for (const absent of ['beta-guide', 'helm-cli', 'managed-guide']) {
        assert.ok(!catalogW!.includes(`id="${absent}"`), `directory must not contains ${absent}`)
      }
      // blank name single Profile directory also excludes helm-cli:SYSTEM_DEFAULT refer quote contains helm-cli when only then load condition semantics takes effect
    }

    // ⑥ plugin hosting skill: plugin deactivate (superagent by default not enabled)→ blank name single inside also 403
    await kernel.profiles.save({ id: 'white-profile', name: 'blank name single', tags: [], skills: ['alpha-guide', 'managed-guide'] })
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile|is disabled/ },
    )
    // enable plugin after the same skill i.e. when can read (enabledPluginIds same turn heavy read)
    await host.enable('builtin:superagent')
    {
      const managed = (await host.executeTool(
        'load_skill',
        { skillId: 'managed-guide' },
        { conversationId: convWhite.id },
      )) as { text: string }
      assert.ok(managed.text.includes('hosting'), 'plugin enable after hosting skill can read')
    }
    // directory sync: enable after blank name single contains hosting skill → directory appear
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'enable hosting after back stage')
      await kernel.waitForIdle(convWhite.id)
      const catalogE = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogE?.includes('id="managed-guide"'), 'plugin enable after directory should contains hosting skill')
    }
    await host.disable('builtin:superagent')
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile|is disabled/ },
    )

    // ⑦ runtime modify Profile(change blank name single) under one turn takes effect: blank name single clean into [] after directory disappear
    await kernel.profiles.save({ id: 'white-profile', name: 'blank name single', tags: [], skills: [] })
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'change is all forbid after back stage')
      await kernel.waitForIdle(convWhite.id)
      const catalogGone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogGone, undefined, 'Profile change is [] after under turn directory i.e. disappear')
    }

    // ⑧ unknown skill 404(without leaking content); blank name single inside but not installed → 404 same
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: convWhite.id }),
      { code: 'not_found', message: /missing|no-such-skill/ },
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. SecretStash: real secret value does not enter SQLite, does not enter model request,SSE frame
// ---------------------------------------------------------------------------

test('collection into3: double quotes+newline secret value do not appear in SQLite any table, model request and SSE frame in; placeholder can security stream rotate', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // double quotes + newline: only for JSON.stringify after text redaction plain implement will leak this kind of value
    const SECRET_TRICKY = ['quote"', 'line'].join('\n')
    const placeholder = kernel.services.stash.put(env.initialConvId, 'TRICKY_TOKEN', SECRET_TRICKY)
    assert.match(placeholder, /^\[REDACTED:stash:[0-9a-f-]{36}\]$/)

    // model turn: placeholder context, secret value forever do not reach provider
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(`please use token ${placeholder} deploy`)
    const req = env.requests[0]!
    assert.ok(req.userTexts.join('\n').includes(placeholder), 'placeholder can normal enter context')
    const reqAll = req.systemSections.join('\n') + req.userTexts.join('\n') + req.assistantTexts.join('\n')
    assert.ok(!reqAll.includes(SECRET_TRICKY), 'secret value must not enter any model message')

    // envFor conversation isolated
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], SECRET_TRICKY)
    assert.equal(kernel.services.stash.envFor(999)['TRICKY_TOKEN'], undefined)

    // SSE frame (EventHub publish unify redaction): subscribe after publish contains secret payload, frame in only placeholder
    const frames: string[] = []
    kernel.events.subscribe((frame) => frames.push(JSON.stringify(frame)))
    kernel.events.publish('notification', { level: 'info', title: 'deploy', body: `token ${SECRET_TRICKY} already use` })
    const joined = frames.join('\n')
    assert.ok(!joined.includes(SECRET_TRICKY), 'SSE frame must not contains secret plaintext')
    assert.ok(!joined.includes('quote\\"'), 'SSE frame must not contains secret JSON escaping form')
    assert.ok(joined.includes(placeholder), 'SSE frame should keep placeholder form')

    // all table byte scan (turn + SSE already written to the database after)
    assert.deepEqual(
      sqliteTablesContaining(env.dbPath, SECRET_TRICKY),
      [],
      'secret value must not appear in state.sqlite any table',
    )

    // structure redaction compare:redactJsonValue recursion value level replace do not leak double quotes newline
    const obj = { text: `prefix ${SECRET_TRICKY} ${placeholder}` }
    const redacted = redactJsonValue(obj, (t) => kernel.services.stash.redact(t)) as { text: string }
    assert.ok(!redacted.text.includes('line'), 'value level redaction after must not store newline segment')
    assert.ok(!redacted.text.includes('quote'), 'value level redaction after must not store quotes segment')
    assert.ok(redacted.text.includes(placeholder), 'redaction after keep placeholder')

    // clear after stash semantics destroy
    kernel.services.stash.clear()
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], undefined)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. ctx.action five end sharing validator:invokeAction / executeTool / HTTP / persist doc
// ---------------------------------------------------------------------------

test('collection into4: plugin ctx.action sharing Schema validate - - legal execute, illegal 400 do not execute handler, legal null do not fabricate,doc real durable', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!
    const calls: string[] = []

    const probePlugin: PluginDefinition = {
      id: 'test:probe',
      name: 'collection into probe needle',
      definePlugin(ctx) {
        ctx.action<{ n: number }, { doubled: number }>({
          id: 'double',
          description: 'translate multiple',
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
        // legal null output: must not by fabricate is {ok:true} of class
        ctx.action<{ ok: boolean }, null>({
          id: 'null_out',
          description: 'return null',
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
          description: 'back sound',
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

    // legal input real execute
    const ok = (await host.invokeAction('test:probe', 'double', { n: 21 })) as { doubled: number }
    assert.equal(ok.doubled, 42)

    // invalid input: the same validate reject (HTTP 400 / CLI non-zero jointly source),handler do not execute
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 'x' }), { code: 'validation_error', message: /validation failed/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', {}), { code: 'validation_error', message: /validation failed/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 1, extra: true }), { code: 'validation_error', message: /validation failed/ })

    // legal null output original return (do not fabricate ok)
    const nullOut = await host.invokeAction('test:probe', 'null_out', { ok: true })
    assert.equal(nullOut, null)

    // tool path same right validate
    const echoed = (await host.executeTool('probe_echo', { text: 'hi' }, { conversationId: 1 })) as { echoed: string }
    assert.equal(echoed.echoed, 'hi')
    await rejectsExplicitly(() => host.executeTool('probe_echo', { text: '' }, { conversationId: 1 }), { code: 'validation_error', message: /validation failed/ })
    assert.deepEqual(calls, ['double:21', 'echo:hi'], 'invalid input do not execute handler')

    // unknown action/tool explicit 404
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'nope', {}), { code: 'unknown_action', message: /not declaration/ })
    await rejectsExplicitly(() => host.executeTool('nope', {}, { conversationId: 1 }), { code: 'unknown_tool', message: /not registered/ })

    // run in action when plugin disable explicit 409(not silently split register table): true suspended action occupy task tracker
    let release2!: () => void
    const gate2 = new Promise<void>((r) => (release2 = r))
    const slowPlugin: PluginDefinition = {
      id: 'test:slow',
      name: 'slow action',
      definePlugin(ctx) {
        ctx.action<Record<string, never>, { done: boolean }>({
          id: 'slow',
          description: 'slow',
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
      assert.ok(err instanceof HelmError, `should be HelmError, actual ${String(err)}`)
      assert.equal(err.code, 'plugin_has_live_tasks')
      return true
    })
    release2()
    assert.deepEqual(await slow, { done: true })
    // task after end disable succeeded
    await host.disable('test:slow')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. durable conversation restart: the same dataDir heavy open createHelm,#1/history/SSE seq keep
// ---------------------------------------------------------------------------

test('collection into5: after restart broadcast conversation and history via real SQLite keep,faux resume visible complete history,SSE seq durable does not fall back', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dir, 'state.sqlite')

  const build = () => createHubTestApp({ dataDir: dir, cwd: dir })

  const MARK = 'restart before key conclusion-PERSIST-MARK'
  let seqAfterFirst = 0
  const first = await build()
  const firstConv = first.app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (firstConv === undefined) throw new Error('first time start should broadcast assistant entry conversation')
  try {
    first.faux.setResponses([fauxAssistantMessage(`already record:${MARK}`)])
    await first.app.kernel.submitInput(firstConv.id, `please record:${MARK}`)
    await first.app.kernel.waitForIdle(firstConv.id)
    assert.equal(first.faux.state.callCount, 1)
    seqAfterFirst = first.app.kernel.events.seq
    assert.ok(seqAfterFirst > 0, 'one turn should push enter SSE seq')
  } finally {
    await first.app.close()
  }

  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    assert.ok(convs.some((c) => c.id === firstConv.id), 'after restart broadcast entry conversation still in')
    assert.ok(
      second.app.kernel.events.seq >= seqAfterFirst,
      `after restart SSE seq(${second.app.kernel.events.seq}) should >= first turn after (${seqAfterFirst})`,
    )
    const conv = second.app.kernel.getConversation(firstConv.id)
    assert.ok(conv.completionSeq >= 1, 'completionSeq across restarts keep')

    // resume turn: model visible complete history
    const seen: string[] = []
    second.faux.setResponses([
      (ctx) => {
        seen.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('already back consider history')
      },
    ])
    await second.app.kernel.submitInput(firstConv.id, 'back consider we say what')
    await second.app.kernel.waitForIdle(firstConv.id)
    assert.ok(seen[0]!.includes(MARK), 'after restart model request should contains history message')
    assert.ok(sqliteTablesContaining(dbPath, MARK).length > 0, 'history entry should persist')
  } finally {
    await second.app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. HTTP real to return: true startHub(port 0) + true app.kernel
// ---------------------------------------------------------------------------

async function makeHttpEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-http-'))
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir })

  // broadcast entry conversation ID(first assistant without parent chain conversation; this environment inside still store in)
  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('makeHttpEnv: first time start should broadcast assistant entry conversation')

  // collection into probe needle plugin:echo action back visible stash real value (verify out station redaction link).
  // probe needle value via probeState indirectly reference: initial conversation delete i.e. reclaim its stash secret (new contract),
  // test system delete after will to store conversation re- register again assertion.
  const stash = app.kernel.services.stash
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const probeState = {
    secret: SECRET_TRICKY,
    placeholder: stash.put(initialConv.id, 'TRICKY_TOKEN', SECRET_TRICKY),
  }

  await app.kernel.plugins!.register({
    id: 'test:probe',
    name: 'collection into probe needle',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { text: string }>({
        id: 'echo',
        description: 'back visible (contains secret redaction verify)',
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
        handler: (input) => ({ text: `${input.text} ${probeState.secret} ${probeState.placeholder}` }),
      })
      ctx.action<{ n: number }, { doubled: number }>({
        id: 'double',
        description: 'translate multiple',
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

  // true startHub:port 0(kernel allocate),kernel all from createHelm
  const hub = await startHub({ kernel: app.kernel as never, port: 0 })
  return {
    hub, app, faux, dataDir, SECRET_TRICKY, probeState, stash, initialConvId: initialConv.id,
    rootPassword: 'integration testRootpassword eight',
    async close() {
      await hub.close()
      await app.close()
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('collection into6: HTTP real to return - - authentication/initial conversation can delete/action validate same right/secret without leaking out station/SSE snapshot first frame/plugin public routing', { timeout: 60_000 }, async () => {
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

    // --- authentication boundary
    const anon = await call('GET', '/api/conversations', { auth: false })
    assert.equal(anon.status, 401)
    const statusBefore = await call('GET', '/api/auth/status', { auth: false })
    assert.equal(statusBefore.status, 200)
    assert.equal(JSON.parse(statusBefore.body).configured, false)

    const setup = await call('POST', '/api/auth/setup', { body: { password: env.rootPassword }, auth: false })
    assert.equal(setup.status, 200)
    token = JSON.parse(setup.body).token as string
    assert.ok(typeof token === 'string' && token.length > 0)
    const badLogin = await call('POST', '/api/auth/login', { body: { password: 'error password but enough long' }, auth: false })
    assert.equal(badLogin.status, 401)
    const relogin = await call('POST', '/api/auth/login', { body: { password: env.rootPassword }, auth: false })
    assert.equal(relogin.status, 200)

    // --- initial entry conversation can delete (id level exemption already remove; through use protect is plugin manage right 409)
    const initialId = env.initialConvId
    const delInitial = await call('DELETE', `/api/conversations/${initialId}`)
    assert.equal(delInitial.status, 200, `delete initial conversation should succeeded:${delInitial.body}`)
    const goneInitial = await call('GET', `/api/conversations/${initialId}`)
    assert.equal(goneInitial.status, 404)
    // rebuild ordinary conversation supply after continue turn use
    const created = await call('POST', '/api/conversations', { body: { title: 'collection into conversation', profileId: 'assistant' } })
    assert.equal(created.status, 201)
    const httpConvId = (JSON.parse(created.body) as { id: number }).id

    // --- real model turn (HTTP submit → true kernel → faux)
    const conv = await call('GET', `/api/conversations/${httpConvId}`)
    assert.equal(conv.status, 200)
    assert.equal(JSON.parse(conv.body).id, httpConvId)
    env.faux.setResponses([fauxAssistantMessage('HTTP turn complete')])
    // non- wait for commit: routing by default submission accepted(202 + {submissionId}), do not fabricate sync answer
    const sent = await call('POST', `/api/conversations/${httpConvId}/input`, { body: { text: '你好, integration test' } })
    assert.equal(sent.status, 202)
    const submission = JSON.parse(sent.body) as { submissionId: string }
    assert.ok(typeof submission.submissionId === 'string' && submission.submissionId.length > 0, '202 should carry submissionId')
    await env.app.kernel.waitForIdle(httpConvId)
    assert.ok(env.faux.state.callCount >= 1, 'HTTP submit should trigger real model turn')

    // explicit wait for chain:?wait=1 precise wait for this time commit answer (200 ConversationInputResult)
    env.faux.setResponses([fauxAssistantMessage('HTTP wait for answer')])
    const waited = await call('POST', `/api/conversations/${httpConvId}/input?wait=1`, { body: { text: 'wait for chain verify' } })
    assert.equal(waited.status, 200, `wait=1 should return this time answer:${waited.body}`)
    const waitResult = JSON.parse(waited.body) as { submissionId: string; text: string; entry: { id: string; kind: string } }
    assert.ok(waitResult.submissionId.length > 0)
    assert.equal(waitResult.text, 'HTTP wait for answer')
    assert.ok(waitResult.entry.id, 'wait result should contains precise answer entry')

    // --- action validate same right:HTTP illegal reference 400 validation_error(and invokeAction the same validate)
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
    assert.equal(JSON.parse(memoryWithContext.body).profileId, 'assistant', 'HTTP conversationId context parse when before Profile')
    const memoryInvalidExplicit = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: 'missing' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidExplicit.status, 404)
    assert.equal(JSON.parse(memoryInvalidExplicit.body).error.code, 'profile_not_found', 'expires explicit Profile must not fall back to HTTP context')
    const memoryInvalidId = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: '../outside' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidId.status, 400)
    assert.equal(JSON.parse(memoryInvalidId.body).error.code, 'validation_error', 'illegal Profile ID in action boundary explicit 400')
    const workflowWithoutTarget = await call('POST', '/api/actions/builtin:workflow/run', {
      body: { input: { script: 'export const meta = { name: "no-target", description: "t" }\nreturn 1' } },
    })
    assert.equal(workflowWithoutTarget.status, 400)
    assert.equal(JSON.parse(workflowWithoutTarget.body).error.code, 'validation_error')
    const badAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: 123 } } })
    assert.equal(badAction.status, 400)
    assert.equal(JSON.parse(badAction.body).error.code, 'validation_error')

    // --- HTTP out station redaction:echo action result contains stash real value when, response only carries placeholder.
    // hub unify JsonRedactor(kernel.services.stash.redact) must in out station before erase plaintext.
    // initial conversation already delete (its stash secret follow of reclaim): to store conversation re- register same value again verify.
    env.probeState.placeholder = env.stash.put(httpConvId, 'TRICKY_TOKEN', env.SECRET_TRICKY)
    const echoAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: 'prefix' } } })
    assert.equal(echoAction.status, 200)
    const echoBody = echoAction.body
    assert.ok(!echoBody.includes(env.SECRET_TRICKY), 'HTTP response must not contains secret plaintext (contains newline form)')
    assert.ok(!echoBody.includes('quote\\"'), 'HTTP response must not contains secret JSON escaping form')
    assert.ok(!echoBody.includes('line'), 'HTTP response must not contains newline after half segment plaintext')
    assert.ok(echoBody.includes(env.probeState.placeholder), 'HTTP response should keep placeholder')

    // --- SSE snapshot first frame: authentication after connect i.e. snapshot
    const sseResponse = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(sseResponse.headers.get('content-type'), 'text/event-stream')
    const reader = sseResponse.body!.getReader()
    const firstChunk = new TextDecoder().decode((await reader.read()).value)
    assert.ok(firstChunk.includes('event: snapshot'), 'SSE first frame should be snapshot')
    assert.ok(firstChunk.includes('"conversations"'), 'snapshot should contains conversation manifest')
    await reader.cancel().catch(() => {})

    // --- plugin public routing exemption authentication + encoded pluginId decode match
    const encoded = encodeURIComponent('test:probe')
    const pub = await fetch(`${base}/api/plugins/${encoded}/routes/ping`)
    assert.equal(pub.status, 200)
    assert.equal((JSON.parse(await pub.text()) as { via: string }).via, 'plugin-route')

    // --- workflows: real engine via builtin:workflow plugin action (/api/actions same link)
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
    assert.equal(wf.status, 200, `real workflow engine should accept run:${wf.body}`)
    const summary = (JSON.parse(wf.body) as { run: { id: string; status: string } }).run
    assert.ok(summary.id.startsWith('wf_'), 'summary should contains wf_ prefix runId')
    assert.ok(['running', 'completed'].includes(summary.status))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. CLI ↔ true Hub: process inside runCli + async child process true CLI entry
// ---------------------------------------------------------------------------

test('collection into7: CLI↔Hub real link - -setup credentials/status/conversations/send trigger true model turn/motion state action command/illegal reference non-zero exit/child process CLI', { timeout: 60_000 }, async () => {
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
   * async child process true CLI:spawn(non- spawnSync- -spawnSync blocking die parent process event loop,
   * same process Hub test under sub- CLI  HTTP forever do not response, is test method defect while non- CLI defect).
   * stdio pipes collect output; hard timeout kill guard against suspended.
   */
  const runCliChildInEnv = (args: string[], timeoutMs = 20_000): Promise<CliRunResult> =>
    runCliChild(
      args,
      { ...process.env, HELM_HUB_URL: hubUrl.toString(), HELM_DATA_DIR: env.dataDir, HELM_TOKEN: '' },
      timeoutMs,
    )

  try {
    // --- not login: subject to protect command explicit errors non-zero
    const anon = await run(['conversations', 'list', '--json'])
    assert.notEqual(anon.code, 0)
    assert.equal((JSON.parse(anon.err) as { error: { code: string } }).error.code, 'unauthorized')

    // --- setup: true scrypt credentials + independent cli-token file.
    const setup = await run(['setup', '--password', env.rootPassword, '--json'])
    assert.equal(setup.code, 0, setup.err)
    assert.ok(typeof (JSON.parse(setup.out) as { token: string }).token === 'string')
    const credRaw = JSON.parse(readFileSync(join(env.dataDir, 'cli-token'), 'utf8')) as {
      hubUrl?: string; token?: string
    }
    assert.ok(credRaw.token, 'login Token should save in cli-token')
    assert.ok(credRaw.hubUrl?.startsWith('http://127.0.0.1:'), 'hubUrl should persist')

    // --- status: public end point
    const status = await run(['status', '--json'])
    assert.equal(status.code, 0, status.err)
    assert.equal(JSON.parse(status.out).configured, true)

    // --- conversations list: via credentials file token authentication
    const list = await run(['conversations', 'list', '--json'])
    assert.equal(list.code, 0, list.err)
    const convs = JSON.parse(list.out) as Array<{ id: number; profileId: string }>
    assert.ok(convs.some((c) => c.profileId === 'assistant'), 'should column out assistant conversation')

    // --- memory motion state command: real CLI ↔ Hub, via --current parse conversation which belong Profile
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
    assert.equal(JSON.parse(explicitMemory.out).profileId, 'assistant', 'explicit --profile-id takes precedence at --current')
    const memoryNoTarget = await run(['memory', 'get', '--json'])
    assert.notEqual(memoryNoTarget.code, 0)
    assert.equal((JSON.parse(memoryNoTarget.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- send:CLI commit → real model turn
    const callCountBefore = env.faux.state.callCount
    env.faux.setResponses([fauxAssistantMessage('CLI turn complete')])
    const send = await run(['send', '1', '你好 CLI collection into', '--json'])
    assert.equal(send.code, 0, send.err)
    await env.app.kernel.waitForIdle(env.initialConvId)
    assert.ok(env.faux.state.callCount > callCountBefore, 'CLI send should trigger real model turn')

    // --- motion state action command:GET /api/actions generate helm probe double
    const doubled = await run(['probe', 'double', '--n', '21', '--json'])
    assert.equal(doubled.code, 0, doubled.err)
    assert.equal(JSON.parse(doubled.out).doubled, 42)

    // --- flag layer intercept:number convert failed non-zero
    const badFlag = await run(['probe', 'double', '--n', 'abc', '--json'])
    assert.notEqual(badFlag.code, 0)

    // --- server side Schema reject (--input bypass flag convert):validation_error
    const badSchema = await run(['probe', 'double', '--input', '{"n":"is not number"}', '--json'])
    assert.notEqual(badSchema.code, 0)
    assert.equal((JSON.parse(badSchema.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- create a ordinary conversation supply after continue child process get verify
    const mkConv = await run(['conversations', 'create', '--title', 'CLI conversation', '--profile-id', 'assistant', '--json'])
    assert.equal(mkConv.code, 0, mkConv.err)
    const cliConvId = (JSON.parse(mkConv.out) as { id: number }).id

    // --- child process true CLI entry (async spawn; parent process event loop keep response,Hub can answer):
    //     setup completed, child process via cli-token credentials access the same true Hub(three only read command concurrency run omit remove serial process start wait for).
    const [childStatus, childGet, childAuth] = await Promise.all([
      runCliChildInEnv(['status', '--json']),
      runCliChildInEnv(['conversations', 'get', String(cliConvId), '--json']),
      runCliChildInEnv(['conversations', 'list', '--json']),
    ])
    assert.equal(childStatus.timedOut, false, 'child process CLI must not suspended')
    assert.equal(childStatus.code, 0, `child process status failed:${childStatus.err}`)
    assert.equal(JSON.parse(childStatus.out).configured, true)

    assert.equal(childGet.timedOut, false, 'child process CLI must not suspended')
    assert.equal(childGet.code, 0, `child process conversations get failed:${childGet.err}`)
    assert.equal(JSON.parse(childGet.out).id, cliConvId)

    assert.equal(childAuth.timedOut, false)
    assert.equal(childAuth.code, 0, `child process authentication should via cli-token takes effect:${childAuth.err}`)
    assert.ok((JSON.parse(childAuth.out) as Array<{ id: number }>).some((c) => c.id === cliConvId))

    // --- delete initial conversation after: workflow without target explicit 400;--current and explicit target normal
    const delInitial = await run(['conversations', 'delete', String(env.initialConvId), '--json'])
    assert.equal(delInitial.code, 0, `delete initial conversation should succeeded:${delInitial.err}`)
    const goneCheck = await run(['conversations', 'get', String(env.initialConvId), '--json'])
    assert.notEqual(goneCheck.code, 0, 'after deletion GET should non-zero (404)')

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
    assert.equal(toolRun.structuredOutput?.summary?.conversationId, cliConvId, 'Workflow tool use real when before conversation, independent of id 1')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// subagent run phase real-time related:parentToolCallId write mirror and broadcast conversation.upsert
// ---------------------------------------------------------------------------

test('subagent derive: sub-conversation summary carry parentToolCallId and via conversation.upsert broadcast', { timeout: 60_000 }, async () => {
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
    // parent conversation model invoke subagent tool; subagent faux independent answer.
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'sub- task: check build', background: false })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('subagent already return, task complete'),
    ])
    // sub-conversation use the same faux provider(faux queue by request order consume: parent tool round -> subagent turn -> parent wrap-up round).
    await env.submitAndWait('please dispatch a subagent check build')

    // summary layer: derive out sub-conversation mirror carries parentToolCallId(parent conversation tool invoke ID).
    const child = kernel
      .listConversations()
      .find((c) => c.parentConversationId === env.initialConvId && c.parentToolCallId !== undefined)
    assert.ok(child !== undefined, 'sub-conversation summary must carry parentToolCallId(run phase real-time related contract)')
    assert.ok(child!.parentToolCallId !== undefined && child!.parentToolCallId !== '')

    // event layer:conversation.upsert broadcast in contains the sub-conversation and parentToolCallId(frontend SSE i.e. moment can related).
    const broadcast = upserts.find((u) => u.id === child!.id && u.parentToolCallId === child!.parentToolCallId)
    assert.ok(broadcast !== undefined, 'conversation.upsert must broadcast contains parentToolCallId sub-conversation summary')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// closed ring 1: managed Token - - managed bash in CLI fully independent of disk login
// ---------------------------------------------------------------------------

test('align1: managed bash inside CLI conversations get --current independent of disk login,HELM_TOKEN only with redaction form stream rotate', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    assert.equal(typeof runtime.setHubUrl, 'function', 'KernelRuntime.setHubUrl should store in')
    runtime.setHubUrl!(base)

    const tokenGetter = (env.app.kernel as unknown as {
      toolDeps?: { processToken?: () => string }
    }).toolDeps?.processToken
    assert.equal(typeof tokenGetter, 'function', 'toolDeps.processToken should store in')
    const managedToken = tokenGetter!()

    // CLI in new temporary dataDir(without cli-token disk file) under with HELM_TOKEN env direct connect.
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const cliEnvBase = {
      ...process.env,
      HELM_HUB_URL: base,
      HELM_DATA_DIR: cliDataDir,
      HELM_TOKEN: managedToken,
    }
    try {
      assert.equal(existsSync(join(cliDataDir, 'cli-token')), false, 'initial without disk login')

      const got = await runCliChild(
        ['conversations', 'get', '--current', '--json'],
        { ...cliEnvBase, HELM_CONVERSATION_ID: String(ROOT_CONVERSATION_ID) },
      )
      assert.equal(got.timedOut, false, 'CLI child process must not suspended')
      assert.equal(got.code, 0, `managed token CLI should succeeded:${got.err}`)
      const summary = JSON.parse(got.out) as { id: number; model?: unknown; entries?: unknown[] }
      assert.equal(summary.id, ROOT_CONVERSATION_ID)
      assert.ok(Array.isArray(summary.entries), 'CLI get should return detail situation (entries timeline)')
      assert.ok(!got.out.includes(managedToken) && !got.err.includes(managedToken), 'CLI output must not back visible original Token')

      // marker form: global redaction register after, any exit appear is [REDACTED] placeholder.
      const marker = env.app.kernel.services.stash.redact(managedToken)
      assert.notEqual(marker, managedToken, 'managed token must already by global redaction register')

      // first subscribe and etc. snapshot first frame (verify subscribe ready), again commit contains token input;
      // collect condition also want seek entry and upsert(upsert in turn compute when only then publish, only in
      // first entry then exit will leak compute frame).
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
          return fauxAssistantMessage('receives')
        },
      ])
      await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, `credentials is ${managedToken} please keep`)
      await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
      assert.ok(requests.length > 0, 'should catch model request')
      assert.ok(!requests[0]!.includes(managedToken), 'model request must not contains original managed Token')

      // SSE incremental (conversation.entry / upsert) excludes original token.
      const frames = await sub.frames
      const joined = frames.join('\n')
      assert.ok(joined.includes('event: conversation.entry'), 'should receives conversation.entry incremental event')
      assert.ok(joined.includes('event: conversation.upsert'), 'should receives conversation.upsert incremental event')
      assert.ok(!joined.includes(managedToken), 'SSE frame must not contains original managed Token')

      assert.deepEqual(
        sqliteTablesContaining(env.dbPath, managedToken),
        [],
        'state.sqlite any table must not contains original managed Token',
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
// closed ring 2: managed bash in real execute CLI(bash tool child process env carry managed token)
// ---------------------------------------------------------------------------

test('align2: managed bash tool inside execute helm conversations get - - env inject,exit 0 mark record, detail situation special sign back pass and Token do not back visible', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    void setupRes

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    runtime.setHubUrl!(base)

    const cliDataDir = join(env.dataDir, 'cli-isolated')
    // tail part && echo CLI_OK:CLI exit 0 only then will output the mark record (&& chain short route).
    const cmd = [
      `export HELM_DATA_DIR="${cliDataDir}"`,
      `export HELM_CONVERSATION_ID=${ROOT_CONVERSATION_ID}`,
      `"${process.execPath}" "${tsxCli}" "${cliEntry}" conversations get --current --json`,
      'echo CLI_OK',
    ].join(' && ')

    // faux  1 response start bash tool invoke;capture put in tool after 2 response - -
    // fixed final answer will not carry tool result context, forever cannot catch.
    const toolResults: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: cmd })], { stopReason: 'toolUse' }),
      (ctx) => {
        toolResults.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('done')
      },
    ])

    await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, 'please in managed shell in execute helm conversations get --current --json')
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.ok(toolResults.length > 0, 'should catch tool after model request')
    const toolCtx = toolResults[0]!
    const managedToken = (env.app.kernel as unknown as { toolDeps?: { processToken?: () => string } }).toolDeps?.processToken?.()
    assert.ok(managedToken, 'toolDeps.processToken should store in')
    assert.ok(!toolCtx.includes(managedToken!), 'tool result back pass model must not contains original managed Token')
    // CLI real succeeded verify based on chain:exit 0 mark record + detail  entries timeline + helm.input
    // entry + conversation title - - cannot only see number 1 then compute via.
    assert.ok(toolCtx.includes('CLI_OK'), 'tool output should contains CLI exit 0 mark record CLI_OK')
    assert.ok(toolCtx.includes('helm.input'), 'CLI detail situation should contains helm.input entry(this turn input already timeline)')
    assert.ok(toolCtx.includes('person assist'), 'CLI detail situation should contains conversation title')
    assert.ok(toolCtx.includes('entries'), 'CLI detail situation should contains entries timeline field')
    // toolCtx is message array JSON.stringify,CLI output inside embed when quotes by escaping (\"id\": 1)
    assert.ok(/id\\?"?\s*:\s*1\b/.test(toolCtx), 'CLI detail situation should contains conversation id')
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// closed ring 3: input meta all chain + detail situation page + event + snapshot extend + workflow incremental
// ---------------------------------------------------------------------------

test('align3: CLI send --meta → helm.input entry → turn_settled all chain; page first tail without lose;entry/live/plugin.changed/workflow.updated real incremental', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // plugin: collect turn_settled inputs(meta should original reach)
    const settledInputs: Array<{ origins: string[]; metas: Array<Record<string, unknown> | undefined> }> = []
    await env.app.kernel.plugins.register({
      id: 'test:meta-probe',
      name: 'meta probe needle',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledInputs.push({
            origins: payload.inputs.map((i) => i.origin),
            metas: payload.inputs.map((i) => i.meta),
          })
        })
      },
    } satisfies PluginDefinition)

    // three subscribe all etc. snapshot first frame ready after again trigger by test behavior:
    // A: CLI send turn conversation.entry / conversation.live incremental;
    // B: plugin.changed start/stop two frame;
    // C: pure script workflow run  workflow.updated complete incremental.
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
      env.faux.setResponses([fauxAssistantMessage('meta turn complete')])
      const sent = await runCliChild(
        ['send', String(ROOT_CONVERSATION_ID), 'carries metadata input', '--meta', JSON.stringify(meta), '--wait', '--json'],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir, HELM_TOKEN: userToken },
      )
      assert.equal(sent.timedOut, false)
      if (sent.code !== 0) {
        assert.fail(`send --meta --wait failed:${sent.err}`)
      }
      // send --wait return ConversationInputResult:text i.e. this time answer,entry is answer item
      const waitResult = JSON.parse(sent.out) as { text: string; entry?: { id: string } }
      assert.equal(waitResult.text, 'meta turn complete', 'send --wait should return this time answer text')
      assert.ok(waitResult.entry?.id, 'send --wait should return this time answer entry id')
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }

    // turn_settled:meta all chain reach
    await waitFor(() => settledInputs.length > 0)
    assert.equal(settledInputs[0]!.metas.length, 1)
    assert.deepEqual(settledInputs[0]!.metas[0], meta, 'meta should from CLI original reach turn_settled')

    // detail situation:GET /api/conversations/1 contains helm.input entry  data.meta
    const detailRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    assert.equal(detailRes.status, 200)
    const detail = JSON.parse(detailRes.body) as {
      entries: Array<{ kind: string; data?: { meta?: Record<string, unknown>; text?: string }; model?: unknown[] }>
    }
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry, 'detail should contains helm.input entry')
    assert.deepEqual(inputEntry!.data?.meta, meta, 'helm.input entry should carry meta')

    // assistant text in entry.model(do not in data) - -detail do not lose model message
    const assistantEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
    if (assistantEntry) {
      assert.ok(
        JSON.stringify(assistantEntry.model ?? '').includes('meta turn complete'),
        'assistant text should in entry.model(model context message)',
      )
    }

    // SSE:conversation.entry and conversation.live real incremental reach (subscribe first at turn establish)
    const frames = await subA.frames
    const joined = frames.join('\n')
    assert.ok(joined.includes('event: conversation.entry'), 'should receives conversation.entry event')
    assert.ok(joined.includes('event: conversation.live'), 'should receives conversation.live event')
    const inputFrame = frames.find((f) => f.includes('event: conversation.entry') && f.includes('test.render'))
    assert.ok(inputFrame, 'conversation.entry incremental should carry helm.input  meta')

    // first frame snapshot extend:ui and pluginDocs(builtin:workflow public runs document)
    const snapFrame = frames.find((f) => f.startsWith('event: snapshot'))
    assert.ok(snapFrame, 'subscribe should receives first frame snapshot')
    assert.ok(snapFrame!.includes('"ui"'), 'snapshot should contains ui(plugin UI contribution)')
    assert.ok(snapFrame!.includes('"pluginDocs"'), 'snapshot should contains pluginDocs')

    // page:limit=1 first page + cursor translate page to tail, aggregate without lose without duplicate
    const firstPageRes = await httpCall(base, 'GET', '/api/conversations/1?limit=1', { token: userToken })
    assert.equal(firstPageRes.status, 200)
    const firstPage = JSON.parse(firstPageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
    assert.equal(firstPage.entries.length, 1)
    assert.ok(firstPage.nextCursor, 'should has under one page cursor')
    const collected = [...firstPage.entries.map((e) => e.id)]
    let cursor: string | undefined = firstPage.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 50) {
      const pageRes = await httpCall(base, 'GET', `/api/conversations/1?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: userToken })
      assert.equal(pageRes.status, 200, `cursor translate page failed:${pageRes.body}`)
      const page = JSON.parse(pageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
      collected.push(...page.entries.map((e) => e.id))
      cursor = page.nextCursor
    }
    assert.equal(new Set(collected).size, collected.length, 'page must not duplicate entry')
    const fullRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    const full = JSON.parse(fullRes.body) as { entries: Array<{ id: string }> }
    assert.deepEqual(
      [...collected].sort(),
      full.entries.map((e) => e.id).sort(),
      'page aggregate must and all amount consistent (first tail without lose)',
    )

    // plugin.changed carry ui: subscribe ready after start/stop carries UI contribution probe needle plugin,
    // same connect in order receives ui non-empty and ui empty array two frame, do not rely reconnect re- pull snapshot.
    await env.app.kernel.plugins.register({
      id: 'test:ui-probe',
      name: 'UI probe needle',
      definePlugin(ctx) {
        ctx.ui.sidebarItem({ id: 'ui-probe', label: 'align probe needle', target: 'conversation:1' })
      },
    } satisfies PluginDefinition)
    await env.app.kernel.plugins.disable('test:ui-probe')
    const changeFrames = await subB.frames
    const changed = changeFrames.filter((f) => f.includes('event: plugin.changed'))
    assert.ok(changed.length >= 2, `same connect should receives start/stop two time plugin.changed(actual ${changed.length})`)
    const withUi = changed.find((f) => f.includes('"ui"') && f.includes('sidebar.item'))
    assert.ok(withUi, 'enable event should carry ui contribution (contains surface)')
    const disabledEmptyUi = changed.find((f) => f.includes('"enabled":false') && /"ui":\s*\[\]/.test(f))
    assert.ok(disabledEmptyUi, 'deactivate event ui should be empty array (client based on this replace contribution)')

    // pure script workflow: subscribe ready after via CLI run --wait real execute,
    // validate CLI terminal state output and workflow.updated complete incremental two route verify based on.
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
        assert.fail(`workflows run --wait failed:${wf.err}`)
      }
      const runSummary = (JSON.parse(wf.out) as { run: { id: string; status: string; result?: unknown } }).run
      assert.equal(runSummary.status, 'completed')
      assert.equal(runSummary.result, 42)
      const wfFrames = await subC.frames
      const completedFrame = wfFrames.find(
        (f) => f.includes('event: workflow.updated') && f.includes(runSummary.id) && f.includes('"status":"completed"'),
      )
      assert.ok(completedFrame, 'same connect should receives the run  workflow.updated complete incremental')
    } finally {
      rmSync(cliDataDir2, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// closed ring 4: plugin doc public private / manageConversation / scope
// ---------------------------------------------------------------------------

test('align4: ctx.doc public private boundary,plugin.doc.updated redaction incremental,manageConversation hosting protect,scope tool visible and run_action force conversation', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  // busy gate release function:try outside declaration (finally si bottom can tune),resolve idempotent, duplicate invoke without harm
  let releaseBusy: () => void = () => {}
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins

    // public doc value contains secret form: public event must redaction (placeholder), private 404.
    const SECRET = 'align-doc-secret-blue'
    const placeholder = kernel.services.stash.put(ROOT_CONVERSATION_ID, 'DOC_SECRET', SECRET)

    const busyGate = new Promise<void>((r) => (releaseBusy = r))
    const eventsSeen: string[] = []

    // public doc update closed package: subscribe ready after by test explicit trigger, event only then is real incremental
    // (register phase update occur in subscribe before, forever etc. fewer than frame - - do not guess, do not blurry).
    type PubDoc = { note: string; secret: string }
    let updatePubDoc!: (fn: (v: PubDoc) => PubDoc) => void

    const conv = await kernel.createConversation({ title: 'hosting conversation', profileId: 'assistant' })

    await host.register({
      id: 'test:guard',
      name: 'guard probe needle',
      definePlugin(ctx) {
        const pub = ctx.doc('status', { note: 'init', secret: SECRET }, { public: true })
        const priv = ctx.doc('inner', { count: 0 })
        updatePubDoc = (fn) => pub.update(fn)
        ctx.action<Record<string, never>, { ok: boolean }>({
          id: 'blocked_out',
          description: 'scope outside cannot via conversation path invoke',
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
          description: 'scope limit set tool',
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
          description: 'occupy in-flight task',
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
        // hosting: this plugin manage conv
        ctx.host.manageConversation(conv.id)
        // private doc update do not event (only public doc is event exit)
        priv.update((v) => ({ count: v.count + 1 }))
      },
    } satisfies PluginDefinition)

    hub = await startHub({ kernel: kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // --- private doc:HTTP 404; public doc can read and secret with stash marker present
    const privateDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/inner`, { token: userToken })
    assert.equal(privateDoc.status, 404, `private doc must 404:${privateDoc.status}`)
    const publicDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    if (publicDoc.status !== 200) {
      assert.fail(`public doc should can read (plugin doc HTTP):${publicDoc.status}`)
    }
    assert.ok(!publicDoc.body.includes(SECRET), 'public doc out station must not contains secret plaintext')
    assert.ok(publicDoc.body.includes(placeholder), 'public doc secret field should with stash marker present')

    // --- plugin.doc.updated real incremental: subscribe ready after actual update and validate event redaction
    // (original write method subscribe occur in update after, timeout after catch([]), fundamentally not verify event).
    const docSub = openSseSubscription(
      base,
      userToken,
      (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes('after-subscribe')),
    )
    await docSub.ready
    updatePubDoc((v) => ({ ...v, note: 'after-subscribe' }))
    const docFrames = await docSub.frames
    const docFrame = docFrames.find((f) => f.includes('event: plugin.doc.updated'))
    assert.ok(docFrame, 'should receives plugin.doc.updated incremental event')
    assert.ok(!docFrame!.includes(SECRET), 'plugin.doc.updated must not contains secret plaintext')
    assert.ok(docFrame!.includes(placeholder), 'plugin.doc.updated secret should with stash marker present')
    assert.ok(docFrame!.includes('after-subscribe'), 'event should carry update after marker value')
    // public doc read value sync is update after content (marker still redaction)
    const publicDoc2 = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    assert.equal(publicDoc2.status, 200)
    assert.ok(publicDoc2.body.includes('after-subscribe'), 'public doc should reverse reflect update after value')
    assert.ok(!publicDoc2.body.includes(SECRET), 'update after public doc still must not contains secret plaintext')

    // --- hosting protect:DELETE managed conversation 409 conversation_managed_by_plugin
    const delManaged = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delManaged.status, 409)
    assert.equal(JSON.parse(delManaged.body).error.code, 'conversation_managed_by_plugin')
    // protect takes effect during produces no abort side effect: conversation still store in
    assert.equal(kernel.getConversation(conv.id).id, conv.id)

    // --- scope:listTools(conversation) by conversation filter choose
    const listToolsFn = host as unknown as {
      listTools?: (conversation?: { id: number; profileId: string; tags: string[] }) => Array<{ name: string }>
    }
    if (typeof listToolsFn.listTools !== 'function') {
      assert.fail('PluginHost.listTools(conversation) scope filter choose should store in')
    }
    const assistantTools = listToolsFn.listTools!({
      id: ROOT_CONVERSATION_ID,
      profileId: 'assistant',
      tags: [],
    })!.map((t) => t.name)
    const otherTools = listToolsFn.listTools!({ id: 999, profileId: 'other', tags: [] })!.map((t) => t.name)
    assert.ok(assistantTools.includes('guard_scoped'), 'assistant conversation should see guard_scoped')
    assert.ok(!otherTools.includes('guard_scoped'), 'other profile conversation must not see guard_scoped')

    // invokeAction carries conversationId must hit scope; missed explicit reject
    const okCall = await host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: conv.id })
    assert.deepEqual(okCall, { ok: true })
    await assert.rejects(
      () => host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: ROOT_CONVERSATION_ID }),
      (err: unknown) => err instanceof HelmError && /scope|effect domain/.test(err.message),
      'scope outside conversationId invoke should explicit reject',
    )
    // without conversationId human HTTP invoke do not subject to limit (conversation policy while non- user authentication)
    const httpNoCtx = await httpCall(base, 'POST', '/api/actions/test:guard/blocked_out', { token: userToken, body: { input: {} } })
    assert.equal(httpNoCtx.status, 200)

    // run_action meta tool force carry conversationId: bypass scope invoke by refuse.
    const runActionOutputs: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('run_action', { actionId: 'test:guard.blocked_out', input: {} })],
        { stopReason: 'toolUse' },
      ),
      (ctx) => {
        runActionOutputs.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('end')
      },
    ])
    // conversation #1 do not in scope(conversationIds only contains conv.id)→ tool result should explicit reject
    await kernel.submitInput(ROOT_CONVERSATION_ID, 'invoke run_action test:guard.blocked_out')
    await kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(
      runActionOutputs.some((o) => /scope|effect domain|reject/.test(o)),
      'run_action in scope outside conversation should by explicit reject (error visible at tool result)',
    )

    // --- in-flight task during disable reject (409 plugin_has_live_tasks); release after disable succeeded and solve except hosting
    const busy = host.invokeAction('test:guard', 'busy', {})
    await assert.rejects(
      () => host.disable('test:guard'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
    )
    releaseBusy()
    assert.deepEqual(await busy, { done: true })
    await host.disable('test:guard')

    // disable after hosting release:DELETE now should succeeded (deactivate automatically release)
    const delAfter = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delAfter.status, 200, `disable after hosting should release:${delAfter.body}`)
    void eventsSeen
  } finally {
    // failed path si bottom: release busy gate, avoid cleanup hang (resolve idempotent)
    releaseBusy?.()
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// closed ring 5: external backend onAgentSpawn handled - - onResolved/onGateResult true back pass
// ---------------------------------------------------------------------------

test('align5: test plugin agent_spawn handled external backend - -onResolved real metadata,onGateResult real kernel.runGate,Gate exactly once, compute order and missing gate explicit failed', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  // settle gate release function:try outside declaration (finally si bottom can tune),resolve idempotent, duplicate invoke without harm
  let releaseSettle: () => void = () => {}
  try {
    const kernel = env.app.kernel

    // external execute environment (real temp directory, do not guess host directory)
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
      name: 'external backend',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn(async (request) => {
          spawns.push({
            prompt: request.prompt,
            gate: request.gate,
            schema: request.schema,
          })
          if (request.onResolved === undefined || request.onGateResult === undefined) {
            throw new HelmError('test_backend_contract', 'external backend must receives onResolved/onGateResult call back', 500)
          }
          // back pass real execute metadata (real temp directory + executionId + worktree)
          request.onResolved({
            nodeId: 'local',
            executionId: execId,
            effectiveCwd: execDir,
            meta: { 'builtin:workflow': { worktree: { path: execDir, branch: 'align-wt' } } },
          })
          // gate in external execute environment inside real execute (kernel.runGate real shell at execDir)
          if (request.gate !== undefined) {
            const result = await kernel.runGate(request.gate, { cwd: execDir, conversationId: request.parentConversationId })
            gates.push({ command: request.gate, cwd: execDir })
            request.onGateResult(result)
          }
          // Schema business data (handled result;source such as declaration enter schema)
          return { action: 'handled', result: { answer: 42, source: 'external' } }
        })
        ctx.host.onEvent('workflow.settled', async () => {
          settleEntered = true
          settleCount += 1
          await settleGate
        })
      },
    } satisfies PluginDefinition)

    // gate counter file (real shell side effect, exactly once)
    const gateCmd = `mkdir -p "${gateDir}" && printf x >> "${join(gateDir, 'count')}" && test -f "${join(execDir, 'marker')}" || (touch "${join(execDir, 'marker')}"; true)`

    // schema such as declaration source:additionalProperties:false under handled return
    // {answer, source} must all schema, never rely pare weak validate swap via.
    const script =
      'export const meta = { name: "align-ext", description: "external backend" }\n' +
      'const v = await agent("external extract", { schema: ' +
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

    // compute chain verify:run terminal state via builtin:workflow plugin action (wait:true) return.
    // emitEvent can wait for semantics: engine onRunSettled will await workflow.settled listener
    //(settleGate), therefore must first etc. listener real enter (settleEntered) again release gate,
    // finally only then wait for run terminal state - - order reversed will die etc. (run etc. listener, listener etc. release).
    const startedPromise = env.runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    await waitFor(() => settleEntered === true)
    releaseSettle()
    const { run: started } = await startedPromise
    const result = started.result as { answer: number; source?: string }
    assert.deepEqual(result, { answer: 42, source: 'external' }, 'external backend handled result should back pass script')

    // node metadata keep:executionId / effectiveCwd / worktree / gate
    const summary = (await env.inspectRun(started.id)).run
    const node = summary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(node, 'should contains agent node')
    assert.equal(node!.executionId, execId, 'node should keep external executionId')
    assert.equal(node!.effectiveCwd, execDir, 'node should keep external effectiveCwd')
    assert.equal(node!.nodeId, 'local')
    assert.equal(node!.worktree?.path, execDir)
    assert.equal(node!.worktree?.branch, 'align-wt')
    assert.equal(node!.worktree?.id, `local:${execDir}`)
    assert.ok(node!.gate?.ok === true, 'node should contains gate execute result')

    // Gate file exactly once (onGateResult back report make engine skip second time execute)
    await waitFor(() => existsSync(join(gateDir, 'count')))
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate exactly execute once')
    await waitFor(() => settleCount === 1)
    assert.equal(settleCount, 1, 'workflow.settled should exactly trigger once')

    // resume replay no longer gate, no longer execute external backend
    const gatesBefore = gates.length
    const { run: resumed } = await env.runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const resumedResult = resumed.result as { answer: number; source?: string }
    assert.equal(resumedResult.answer, 42)
    assert.equal(gates.length, gatesBefore, 'resume replay must not again execute gate')
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate side effect does not repeat')

    // deactivate a handled backend, avoid it truncate obtain after continue missing gate scenario spawn
    await kernel.plugins.disable('test:ext-backend')

    // --- missing Gate back report: explicit failed, do not in host guess directory execute
    await kernel.plugins.register({
      id: 'test:ext-nogate',
      name: 'missing gate back report backend',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({ executionId: `${execId}-nogate`, effectiveCwd: execDir })
          // deliberately do not back report onGateResult
          return { action: 'handled', result: { answer: 1 } }
        })
      },
    } satisfies PluginDefinition)

    // agent() failed by engine contract return null(do not throw); script must in null when explicit
    // throw only then can let the whole run assertion is failed.
    const badScript =
      'export const meta = { name: "align-nogate", description: "gate result missing" }\n' +
      'const v = await agent("missing gate back report", { gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'if (v === null || v === undefined) throw new Error("agent not return result")\n' +
      'return v'
    // engine contract: script throw make run failed;wait:true action for failed terminal state throw
    // workflow_failed error message seal, change use non- wait run + inspect polling terminal state.
    let badId = ''
    await assert.rejects(
      () => env.runWorkflow({ script: badScript, conversationId: ROOT_CONVERSATION_ID, wait: true }),
      (err: unknown) => {
        badId = String((err as { details?: { runId?: string } }).details?.runId ?? '')
        return err instanceof HelmError && err.code === 'workflow_failed'
      },
    )
    assert.ok(badId !== '', 'error message seal should carry runId')
    const badSummary = (await env.inspectRun(badId)).run
    assert.equal(badSummary.status, 'failed', 'missing gate back report should explicit failed')
    const badNode = badSummary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(badNode, 'should contains agent node')
    assert.ok(badNode!.status === 'failed')
    // only recognize node real diagnose (gate_result_missing by engine write node.error);
    // ?? summary.error fall back will hit script self row throw character, is false via path, disable.
    assert.ok(
      typeof badNode!.error === 'string' && badNode!.error.includes('gate_result_missing'),
      `agent node error should contains real diagnose gate_result_missing:${String(badNode!.error)}`,
    )
    // do not in host guess directory execute:gate counter do not because the run add (real side effect while non- edit build message)
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'missing back report run must not in host directory execute gate')
    assert.equal(gates.length, gatesBefore, 'missing back report run must not via backend execute gate')
  } finally {
    // failed path si bottom: release settle gate, avoid workflow.settled listen forever long hang
    //(resolve idempotent).
    releaseSettle()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// closed ring 6: two Profile independent SYSTEM/MEMORY and model + HTTP PATCH switch + restart keep
// ---------------------------------------------------------------------------

test('align6: double Profile independent SYSTEM/MEMORY/model,PATCH switch and clean override after request consistent, restart keep', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-profile-'))

  writeProfile(dataDir, 'researcher', {
    system: '# Researcher System\nyou is research member. unique mark record ALIGN-SYS-RESEARCHER.',
    memory: 'RESEARCHER-MEM: bias well quote text',
  })
  writeProfile(dataDir, 'coder', {
    system: '# Coder System\nyou is program member. unique mark record ALIGN-SYS-CODER.',
    memory: 'CODER-MEM: bias well test',
  })

  const build = () => createHubTestApp({ dataDir, cwd: dataDir })

  const requests: string[] = []
  const first = await build()
  try {
    // two profile each conversation
    const r1 = await first.app.kernel.createConversation({ title: 'research member', profileId: 'researcher' })
    const c1 = await first.app.kernel.createConversation({ title: 'program member', profileId: 'coder' })

    // researcher turn:faux catch system sections
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r')
      },
    ])
    await first.app.kernel.submitInput(r1.id, ' researcher you is who')
    await first.app.kernel.waitForIdle(r1.id)

    // coder turn
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('c')
      },
    ])
    await first.app.kernel.submitInput(c1.id, ' coder you is who')
    await first.app.kernel.waitForIdle(c1.id)

    assert.ok(requests.length >= 2)
    assert.ok(requests[0]!.includes('ALIGN-SYS-RESEARCHER'), 'researcher turn should inject its SYSTEM')
    // note: across Profile collaboration directory (profile.catalog) will carries coder  SYSTEM first segment single row summary
    //(contains ALIGN-SYS-CODER mark record), this is design inside recognize know sharing; this where assertion is complete SYSTEM
    // do not string - - with title row # Coder System is allow.
    assert.ok(!requests[0]!.includes('# Coder System'), 'researcher turn must not string coder complete SYSTEM')
    assert.ok(requests[0]!.includes('RESEARCHER-MEM'), 'researcher turn should inject its MEMORY')
    assert.ok(requests[1]!.includes('ALIGN-SYS-CODER'), 'coder turn should inject its SYSTEM')
    assert.ok(requests[1]!.includes('CODER-MEM'), 'coder turn should inject its MEMORY')
    assert.ok(!requests[1]!.includes('# Researcher System'), 'coder turn must not string researcher complete SYSTEM')
  } finally {
    await first.app.close()
  }

  // restart:profile bind set and inject keep
  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    const r1 = convs.find((c) => c.title === 'research member')
    const c1 = convs.find((c) => c.title === 'program member')
    assert.ok(r1 && c1, 'after restart conversation keep')

    const requests2: string[] = []
    second.faux.setResponses([
      (ctx) => {
        requests2.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r2')
      },
    ])
    await second.app.kernel.submitInput(r1!.id, 'again question once')
    await second.app.kernel.waitForIdle(r1!.id)
    assert.ok(requests2[0]!.includes('ALIGN-SYS-RESEARCHER'), 'after restart SYSTEM inject keep')

    // HTTP PATCH swap Profile: inject follow of switch
    let hub: Awaited<ReturnType<typeof startHub>> | undefined
    try {
      hub = await startHub({ kernel: second.app.kernel as never, port: 0 })
      const base = hub.url
      const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
      const token = (JSON.parse(setupRes.body) as { token: string }).token

      const patched = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { profileId: 'coder' },
      })
      assert.equal(patched.status, 200, `PATCH profile failed:${patched.body}`)

      const requests3: string[] = []
      second.faux.setResponses([
        (ctx) => {
          requests3.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('c2')
        },
      ])
      await second.app.kernel.submitInput(r1!.id, 'swap profile after again question')
      await second.app.kernel.waitForIdle(r1!.id)
      assert.ok(requests3[0]!.includes('ALIGN-SYS-CODER'), 'PATCH swap Profile after inject should switch')
      assert.ok(!requests3[0]!.includes('# Researcher System'), 'must not leftover old Profile complete SYSTEM')

      // explicit model override + clean override:summary and real request consistent
      const override = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: 'faux/faux-1' },
      })
      assert.equal(override.status, 200)
      const cleared = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: '' },
      })
      assert.equal(cleared.status, 200, "PATCH model:'' clean override should by accept")
      const afterClear = JSON.parse(cleared.body) as { model: string }
      assert.ok(typeof afterClear.model === 'string' && afterClear.model !== '', 'clean override after takes effect model back Profile/global and non-empty')
    } finally {
      await hub?.close()
    }
  } finally {
    await second.app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
