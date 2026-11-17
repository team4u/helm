/**
 * Helm core end-to-end integration verification (never modify implementation just for tests).
 *
 * Composition discipline: wired exclusively via real createHelm (src/app.ts) — real pi-durable
 * SQLite persistence + real PluginHost + real builtin:profile / builtin:memory + real WorkflowService +
 * faux provider (pi-ai official test provider, in-process scripted responses). Never instantiate
 * KernelRuntime manually, never create MemoryDocStore manually, and never hand-assemble HTTP kernel adapters.
 *
 * Honesty discipline:
 * - All model outputs come from faux.setResponses scripts and do not imply real external network model capability;
 * - If a runtime integration fix (createHelm wiring) is incomplete in this worktree and causes import failure,
 *   let the whole suite fail with diagnostics rather than skipping or mocking the app;
 * - Every assertion targets cross-module contracts (documented per test), not mirrored implementation details.
 *
 * Runner: tsx --test; each test specifies timeout: 60_000 to guard against deadlocks.
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
// Fixture setup: real createHelm composition environment
// ---------------------------------------------------------------------------

interface TestEnv {
  dataDir: string
  dbPath: string
  faux: FauxProviderHandle
  /** Complete app returned by createHelm (artifact of the real composition entrypoint). */
  app: HubTestApp
  /** Complete messages per model request (captured via official faux TranscriptContext). */
  requests: Array<{ roles: string[]; systemSections: string[]; userTexts: string[]; assistantTexts: string[] }>
  /** Initial assistant conversation ID seeded on first boot (backed by SDK root #1, with normal conversation semantics). */
  initialConvId: number
  /** Submit real input + wait for idle (including turn_settled hook). */
  submitAndWait(text: string, opts?: { origin?: 'human' | 'agent' | 'trigger' }): Promise<void>
  /** Append a capture response to the faux queue. */
  capture(): FauxResponseStep
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dataDir, 'state.sqlite')

  // Real composition entrypoint: real SQLite + real PluginHost + profile/memory + WorkflowService.
  const { app, faux } = await createHubTestApp({
    dataDir,
    cwd: dataDir,
  })

  const requests: TestEnv['requests'] = []
  faux.setResponses([])

  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('first boot should seed initial assistant conversation')
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
        return fauxAssistantMessage('(unscripted response: test should setResponses explicitly)')
      }
    },
    async close() {
      await app.close().catch(() => {})
      rmSync(dataDir, { recursive: true, force: true })
    },
  }
  return env
}

/** Declare a skill package (real files: SKILL.md + references/*.md). */
function writeSkill(dataDir: string, id: string, skillMd: string, refs: Record<string, string>): void {
  const dir = join(dataDir, 'skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'SKILL.md'), skillMd)
  const refDir = join(dir, 'references')
  if (!existsSync(refDir)) mkdirSync(refDir)
  for (const [name, content] of Object.entries(refs)) writeFileSync(join(refDir, name), content)
}

/** Byte-level scan across all SQLite tables: returns names of tables containing needle (secret non-persistence assertion). */
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

/** Assert explicit rejection: prefers matching HelmError(code), also accepts native service Error + message. */
async function rejectsExplicitly(
  fn: () => Promise<unknown>,
  expected: { code?: string; message: RegExp },
): Promise<void> {
  await assert.rejects(
    fn,
    (err: unknown) => {
      if (expected.code !== undefined) {
        assert.ok(err instanceof HelmError, `expected HelmError, got ${String(err)}`)
        assert.equal(err.code, expected.code)
      }
      assert.match(err instanceof Error ? err.message : String(err), expected.message)
      return true
    },
    `should reject explicitly: ${expected.message}`,
  )
}

// ---------------------------------------------------------------------------
// 1. profile/memory bootstrapping + real turn + before_turn sections entering model requests
// ---------------------------------------------------------------------------

test('integration 1: createHelm wiring — profile/memory enabled together, locked protection, SYSTEM/MEMORY sections reach model request, update_memory persists across turns', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // plugins getter is non-undefined after fix (target of runtime integration fix); test consumes contract directly
    const host = kernel.plugins!

    // --- Bootstrapping: locked builtin:profile + default-enabled disableable builtin:memory
    const profileSummary = host.list().find((p) => p.id === 'builtin:profile')
    assert.ok(profileSummary, 'builtin:profile should be registered via createHelm')
    assert.equal(profileSummary.locked, true)
    assert.equal(profileSummary.enabled, true)
    assert.ok(profileSummary.tools.includes('load_skill'))
    await rejectsExplicitly(() => host.disable('builtin:profile'), { code: 'plugin_locked', message: /lock/ })
    await rejectsExplicitly(() => host.unregister('builtin:profile'), { code: 'plugin_locked', message: /lock/ })
    const memorySummary = host.list().find((p) => p.id === 'builtin:memory')
    assert.ok(memorySummary, 'builtin:memory should be registered via createHelm')
    assert.equal(memorySummary.locked, false)
    assert.equal(memorySummary.enabled, true)
    assert.ok(memorySummary.tools.includes('update_memory'))
    assert.ok(memorySummary.actions.includes('get') && memorySummary.actions.includes('set') && memorySummary.actions.includes('configure'))

    // --- Conversation #1 created by createHelm (real SQLite persistence)
    const conv = kernel.getConversation(env.initialConvId)
    assert.equal(conv.id, env.initialConvId)
    assert.equal(conv.profileId, 'assistant')

    // --- Round 1 request: before_turn sections enter model via real system message (captured by faux)
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    assert.equal(env.requests.length, 1, 'round 1 should issue exactly one model request')
    const first = env.requests[0]!
    assert.ok(first.roles.includes('system'), 'request should include role=system message (sections really injected)')
    const allText = first.systemSections.join('\n') + first.userTexts.join('\n')
    assert.ok(first.systemSections.some((s) => s.includes('# System Prompt')), 'SYSTEM.md should be injected via sections')
    assert.ok(allText.includes('<memory>'), 'MEMORY.md should be injected via sections (<memory> wrapper)')

    // --- Real tool pipeline: faux triggers update_memory -> writes file -> visible in next round request
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
    assert.ok(memoryFile.includes(MEMORY_FACT), 'MEMORY.md should contain new memory (real file write)')

    // Wrap-up round request carries updated memory (cross-module: tool write -> before_turn re-read -> model request)
    const afterTurn = env.requests[0]!
    assert.ok(
      afterTurn.systemSections.join('\n').includes(MEMORY_FACT),
      'system sections after write should contain new memory',
    )

    // --- Round 3: persists across turns (memory is not only visible within the tool round)
    env.requests.length = 0
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('what color did I say I liked before?')
    assert.ok(
      env.requests[0]!.systemSections.join('\n').includes(MEMORY_FACT),
      'new turn request still contains memory',
    )

    // Persistence core verification: entries really written to DB (same state.sqlite)
    assert.ok(
      sqliteTablesContaining(env.dbPath, MEMORY_FACT).length > 0,
      'memory content should be persisted in sqlite',
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. load_skill: readable references + out-of-bounds rejection (real SkillService defense)
// ---------------------------------------------------------------------------

test('integration 2: load_skill reads SKILL.md and references/ subfiles; path traversal / absolute path / unknown skill explicitly rejected', { timeout: 60_000 }, async () => {
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
    assert.ok(readMain.text.includes('deploy'), 'defaults to reading SKILL.md')

    const readRef = (await host.executeTool(
      'load_skill',
      { skillId: 'deploy-playbook', path: 'references/rollback.md' },
      { conversationId: env.initialConvId },
    )) as { text: string }
    assert.ok(readRef.text.includes('helm rollback'), 'should read references subfiles on demand')

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

    // Model catalog injection: before_turn <available_skills> section contains skill and references paths
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('read db-migrate manual')
    const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
    assert.ok(catalog, '<available_skills> section should be injected into model request')
    assert.ok(catalog!.includes('deploy-playbook'), 'catalog should contain skill id')
    assert.ok(catalog!.includes('references/db-migrate.md'), 'catalog should contain references path')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.5 helm-cli built-in system skill bootstrapping (builtin:profile service.start idempotent completion)
// ---------------------------------------------------------------------------

test('integration 2.5: createHelm startup syncs helm-cli skill (managed overwrite), load_skill reads SKILL.md and three references, restart restores source version', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // At startup, helm-cli exists (managedByPlugin = builtin:profile, with three references)
    const skills = await kernel.skills.list()
    const summary = skills.find((s) => s.id === 'helm-cli')
    assert.ok(summary, 'helm-cli skill should be bootstrapped by builtin:profile startup')
    assert.equal(summary.managedByPlugin, 'builtin:profile')
    for (const ref of [
      'references/workflows-and-agents.md',
      'references/skill-and-plugin-dev.md',
      'references/plugin-client-code-splitting.md',
    ]) {
      assert.ok(summary.references.includes(ref), `references should contain ${ref}`)
    }
    // generative-ui skill is bootstrapped by builtin:json-render plugin (enabled by default), filtered by plugin toggle
    const genUi = skills.find((sk) => sk.id === 'generative-ui')
    assert.ok(genUi, 'generative-ui skill should be bootstrapped by builtin:json-render startup')
    assert.equal(genUi.managedByPlugin, 'builtin:json-render')

    // Normal turns inject only the skill catalog, never stuffing full UI/workflow manuals into ambient context.
    env.faux.setResponses([env.capture()])
    await env.submitAndWait('你好')
    const sections = env.requests[0]!.systemSections.join('\n')
    assert.ok(sections.includes('helm-cli'), 'normal turns should discover built-in skills')
    assert.ok(sections.includes('generative-ui'), 'catalog should contain json-render plugin skill (rich render entry)')
    assert.ok(!sections.includes('MetricGrid'), 'UI component dictionary must not stay permanently resident')
    assert.ok(!sections.includes('workflow(ref, args?)'), 'workflow manual must not stay permanently resident')

    // load_skill tool chain: SKILL.md and all three references are readable with expected content
    const host = kernel.plugins!
    const readSkill = (path?: string) =>
      host.executeTool(
        'load_skill',
        path === undefined ? { skillId: 'helm-cli' } : { skillId: 'helm-cli', path },
        { conversationId: env.initialConvId },
      ) as Promise<{ text: string }>
    const main = await readSkill()
    assert.ok(main.text.includes('helm') && main.text.includes('--json'), 'SKILL.md should contain CLI iron rules')
    const ui = await host.executeTool(
      'load_skill',
      { skillId: 'generative-ui' },
      { conversationId: env.initialConvId },
    ) as { text: string }
    assert.ok(ui.text.includes('```ui'), 'generative-ui skill should contain fence block usage')
    assert.ok(ui.text.includes('primitives.md'), 'should point to primitive contract references')
    const wf = await readSkill('references/workflows-and-agents.md')
    assert.ok(wf.text.includes('pipeline') && wf.text.includes('resumeFromRunId'), 'workflows should contain orchestration API and checkpoint replay')
    const dev = await readSkill('references/skill-and-plugin-dev.md')
    assert.ok(dev.text.includes('definePlugin') && dev.text.includes('ctx.action'), 'skill-and-plugin-dev should contain plugin development guide')
    const splitting = await readSkill('references/plugin-client-code-splitting.md')
    assert.ok(
      splitting.text.includes('__helm_import_chunk') && splitting.text.includes('import()') && splitting.text.includes('helm plugins doctor'),
      'plugin-client-code-splitting should contain AI usage rules, forbidden host bridges, and doctor check command',
    )

    // Managed overwrite on restart (rebuilding app): manual edits to SKILL.md/references on disk are
    // overwritten back to source, deleted references are restored; user-created skills remain untouched and writable
    const customMain = '---\nname: helm-cli\ndescription: user change write\n---\nI version\n'
    const customRef = '# I change UI manual\n'
    writeFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), customMain)
    writeFileSync(join(env.dataDir, 'skills', 'generative-ui', 'SKILL.md'), customRef)
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'))
    rmSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'))
    writeSkill(env.dataDir, 'user-skill', '---\nname: user-skill\ndescription: user self create\n---\nbody text\n', { 'notes.md': '# user notes\n' })
    await env.app.close()

    const { app: app2 } = await createHubTestApp({ dataDir: env.dataDir, cwd: env.dataDir })
    try {
      // Managed skill: tampered files overwritten back to source, missing references restored
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'SKILL.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.skillMd,
        'SKILL.md must revert to source version after restart',
      )
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'workflows-and-agents.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['workflows-and-agents.md']!,
        'managed reference must revert to source version after restart',
      )
      const restored = readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'skill-and-plugin-dev.md'), 'utf8')
      assert.equal(restored, HELM_CLI_SKILL_ASSET.references['skill-and-plugin-dev.md']!, 'missing reference should be restored to source version')
      assert.equal(
        readFileSync(join(env.dataDir, 'skills', 'helm-cli', 'references', 'plugin-client-code-splitting.md'), 'utf8'),
        HELM_CLI_SKILL_ASSET.references['plugin-client-code-splitting.md']!,
        'missing code-splitting reference should be restored to source version',
      )
      const again = await app2.kernel.skills.list()
      assert.equal(again.find((s) => s.id === 'helm-cli')?.description, HELM_CLI_SKILL_ASSET.skillMd.match(/description: (.+)/)?.[1])

      // Managed skill write API: service boundary returns 403 managed_skill_readonly
      await assert.rejects(
        () => app2.kernel.skills.writeFile('helm-cli', 'SKILL.md', 'tamper'),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'managed_skill_readonly')
          assert.equal(err.status, 403)
          return true
        },
      )

      // User-created skill: content not overwritten and remains writable
      assert.ok(readFileSync(join(env.dataDir, 'skills', 'user-skill', 'SKILL.md'), 'utf8').includes('user self create'), 'user-created skill must not be touched by managed overwrite')
      await app2.kernel.skills.writeFile('user-skill', 'references/extra.md', '# user new increase\n')
      assert.ok(
        readFileSync(join(env.dataDir, 'skills', 'user-skill', 'references', 'extra.md'), 'utf8').includes('user new increase'),
        'user-created skill remains writable',
      )
    } finally {
      await app2.close()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2.7 Profile skills allowlist: dual-Profile isolation, [] disables all, sync filter with plugin toggle
// ---------------------------------------------------------------------------

test('integration 2.7: Profile skills allowlist — dual Profile catalog isolation, [] has no catalog and rejects all, allowlisted references readable, plugin toggle syncs, runtime edits apply next turn', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!

    // Three skills: regular A/B + plugin-managed skill (frontmatter declares managedByPlugin)
    writeSkill(
      env.dataDir,
      'alpha-guide',
      '---\nname: Alpha manual\ndescription: A\n---\n# Alpha\nsee references/.',
      { 'intro.md': 'Alpha note: allowlisted only.' },
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

    // Dual Profiles: allowlist contains only alpha-guide; disable-all Profile has skills=[]
    await kernel.profiles.save({ id: 'white-profile', name: 'allowlist', tags: [], skills: ['alpha-guide'] })
    await kernel.profiles.save({ id: 'none-profile', name: 'disabled-all', tags: [], skills: [] })
    const convWhite = await kernel.createConversation({ title: 'allowlist conversation', profileId: 'white-profile' })
    const convNone = await kernel.createConversation({ title: 'disabled-all conversation', profileId: 'none-profile' })

    // 1) Allowlisted skill and its references subfiles are readable
    const main = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(main.text.includes('Alpha'), 'allowlisted SKILL.md should be readable')
    const ref = (await host.executeTool(
      'load_skill',
      { skillId: 'alpha-guide', path: 'references/intro.md' },
      { conversationId: convWhite.id },
    )) as { text: string }
    assert.ok(ref.text.includes('allowlisted'), 'allowlisted references subfile should be readable')

    // 2) Outside allowlist (exists in global catalog but not in profile.skills) -> 403 skill_not_available
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'beta-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )

    // 3) [] Profile: no catalog injected + all skills rejected (including built-in helm-cli)
    {
      // Drive disabled-all conversation directly with kernel.submitInput (faux captures sections for this turn)
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convNone.id, 'disabled-all round')
      await kernel.waitForIdle(convNone.id)
      const catalogNone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogNone, undefined, 'Profile with skills=[] must not inject skill catalog')
    }
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'alpha-guide' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'helm-cli' }, { conversationId: convNone.id }),
      { code: 'skill_not_available', message: /is unavailable for profile/ },
    )

    // 4) Default assistant Profile (undefined): injects all available skills (including helm-cli and non-allowlisted beta)
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await env.submitAndWait('default catalog')
      const catalog = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalog, 'default Profile should inject catalog')
      for (const id of ['helm-cli', 'alpha-guide', 'beta-guide']) {
        assert.ok(catalog!.includes(`id="${id}"`), `default catalog should contain ${id}`)
      }
    }

    // 5) Allowlisted Profile catalog: contains only allowlisted skills, excluding others (including disabled-plugin managed-guide)
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'allowlist round')
      await kernel.waitForIdle(convWhite.id)
      const catalogW = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogW, 'allowlist Profile should inject catalog')
      assert.ok(catalogW!.includes('id="alpha-guide"'), 'catalog should contain allowlisted skill')
      for (const absent of ['beta-guide', 'helm-cli', 'managed-guide']) {
        assert.ok(!catalogW!.includes(`id="${absent}"`), `catalog must not contain ${absent}`)
      }
      // Allowlist Profile catalog excludes helm-cli too: conditional load semantics when SYSTEM_DEFAULT mentions helm-cli
    }

    // 6) Plugin-managed skill: when plugin disabled (superagent disabled by default) -> still 403 even if allowlisted
    await kernel.profiles.save({ id: 'white-profile', name: 'allowlist', tags: [], skills: ['alpha-guide', 'managed-guide'] })
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile|is disabled/ },
    )
    // After enabling plugin, the same skill becomes immediately readable (enabledPluginIds re-read dynamically)
    await host.enable('builtin:superagent')
    {
      const managed = (await host.executeTool(
        'load_skill',
        { skillId: 'managed-guide' },
        { conversationId: convWhite.id },
      )) as { text: string }
      assert.ok(managed.text.includes('hosting'), 'managed skill is readable after enabling plugin')
    }
    // Catalog sync: appears in catalog after enabling when allowlisted
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'round after enabling managed plugin')
      await kernel.waitForIdle(convWhite.id)
      const catalogE = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.ok(catalogE?.includes('id="managed-guide"'), 'catalog should include managed skill after enabling plugin')
    }
    await host.disable('builtin:superagent')
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'managed-guide' }, { conversationId: convWhite.id }),
      { code: 'skill_not_available', message: /is unavailable for profile|is disabled/ },
    )

    // 7) Runtime Profile edit (changing allowlist) takes effect next turn: clearing allowlist to [] removes catalog
    await kernel.profiles.save({ id: 'white-profile', name: 'allowlist', tags: [], skills: [] })
    {
      env.requests.length = 0
      env.faux.setResponses([env.capture()])
      await kernel.submitInput(convWhite.id, 'round after changing to disabled-all')
      await kernel.waitForIdle(convWhite.id)
      const catalogGone = env.requests[0]!.systemSections.find((s) => s.includes('<available_skills>'))
      assert.equal(catalogGone, undefined, 'catalog disappears on next turn after setting Profile skills to []')
    }

    // 8) Unknown skill returns 404 (no content leaked); allowlisted but uninstalled -> also 404
    await rejectsExplicitly(
      () => host.executeTool('load_skill', { skillId: 'no-such-skill' }, { conversationId: convWhite.id }),
      { code: 'not_found', message: /missing|no-such-skill/ },
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. SecretStash: real secret values never enter SQLite, model requests, or SSE frames
// ---------------------------------------------------------------------------

test('integration 3: secret containing quotes+newline never appears in any SQLite table, model request, or SSE frame; placeholders flow safely', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // Quotes + newline: naive redaction that runs only on post-JSON.stringify text will leak this class of values
    const SECRET_TRICKY = ['quote"', 'line'].join('\n')
    const placeholder = kernel.services.stash.put(env.initialConvId, 'TRICKY_TOKEN', SECRET_TRICKY)
    assert.match(placeholder, /^\[REDACTED:stash:[0-9a-f-]{36}\]$/)

    // Model turn: placeholder enters context, secret value never reaches provider
    env.faux.setResponses([env.capture()])
    await env.submitAndWait(`please use token ${placeholder} deploy`)
    const req = env.requests[0]!
    assert.ok(req.userTexts.join('\n').includes(placeholder), 'placeholder should enter context normally')
    const reqAll = req.systemSections.join('\n') + req.userTexts.join('\n') + req.assistantTexts.join('\n')
    assert.ok(!reqAll.includes(SECRET_TRICKY), 'secret value must not enter any model message')

    // envFor isolated per conversation
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], SECRET_TRICKY)
    assert.equal(kernel.services.stash.envFor(999)['TRICKY_TOKEN'], undefined)

    // SSE frames (unified EventHub publish redaction): publishing secret-containing payload after subscribe emits placeholders only
    const frames: string[] = []
    kernel.events.subscribe((frame) => frames.push(JSON.stringify(frame)))
    kernel.events.publish('notification', { level: 'info', title: 'deploy', body: `token ${SECRET_TRICKY} already use` })
    const joined = frames.join('\n')
    assert.ok(!joined.includes(SECRET_TRICKY), 'SSE frames must not contain plaintext secret')
    assert.ok(!joined.includes('quote\\"'), 'SSE frames must not contain JSON-escaped secret')
    assert.ok(joined.includes(placeholder), 'SSE frames should preserve placeholder')

    // Full-table byte scan (after turn + SSE persistence)
    assert.deepEqual(
      sqliteTablesContaining(env.dbPath, SECRET_TRICKY),
      [],
      'secret value must not appear in any state.sqlite table',
    )

    // Structural redaction comparison: redactJsonValue replaces recursively at value level without leaking quotes/newlines
    const obj = { text: `prefix ${SECRET_TRICKY} ${placeholder}` }
    const redacted = redactJsonValue(obj, (t) => kernel.services.stash.redact(t)) as { text: string }
    assert.ok(!redacted.text.includes('line'), 'value-level redaction must leave no newline fragment')
    assert.ok(!redacted.text.includes('quote'), 'value-level redaction must leave no quote fragment')
    assert.ok(redacted.text.includes(placeholder), 'redaction preserves placeholder')

    // Stash destroyed after clear
    kernel.services.stash.clear()
    assert.equal(kernel.services.stash.envFor(env.initialConvId)['TRICKY_TOKEN'], undefined)
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 4. ctx.action five-endpoint shared validator: invokeAction / executeTool / HTTP / persisted doc
// ---------------------------------------------------------------------------

test('integration 4: plugin ctx.action shared schema validation — valid executes, invalid 400 skips handler, valid null not fabricated, doc persists', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins!
    const calls: string[] = []

    const probePlugin: PluginDefinition = {
      id: 'test:probe',
      name: 'integration probe',
      definePlugin(ctx) {
        ctx.action<{ n: number }, { doubled: number }>({
          id: 'double',
          description: 'double number',
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
        // Valid null output: must not be fabricated into {ok:true}
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
          description: 'echo text',
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

    // Valid input executes normally
    const ok = (await host.invokeAction('test:probe', 'double', { n: 21 })) as { doubled: number }
    assert.equal(ok.doubled, 42)

    // Invalid input: rejected identically (single source for HTTP 400 / CLI non-zero), handler is not executed
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 'x' }), { code: 'validation_error', message: /validation failed/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', {}), { code: 'validation_error', message: /validation failed/ })
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'double', { n: 1, extra: true }), { code: 'validation_error', message: /validation failed/ })

    // Valid null output is returned verbatim (never fabricates ok)
    const nullOut = await host.invokeAction('test:probe', 'null_out', { ok: true })
    assert.equal(nullOut, null)

    // Tool path enforces identical validation
    const echoed = (await host.executeTool('probe_echo', { text: 'hi' }, { conversationId: 1 })) as { echoed: string }
    assert.equal(echoed.echoed, 'hi')
    await rejectsExplicitly(() => host.executeTool('probe_echo', { text: '' }, { conversationId: 1 }), { code: 'validation_error', message: /validation failed/ })
    assert.deepEqual(calls, ['double:21', 'echo:hi'], 'invalid input must not invoke handler')

    // Unknown action/tool explicitly returns 404
    await rejectsExplicitly(() => host.invokeAction('test:probe', 'nope', {}), { code: 'unknown_action', message: /not declaration/ })
    await rejectsExplicitly(() => host.executeTool('nope', {}, { conversationId: 1 }), { code: 'unknown_tool', message: /not registered/ })

    // Disabling plugin while action is in-flight explicitly returns 409 (never silently splits registry): live suspended action holds task tracker
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
      assert.ok(err instanceof HelmError, `expected HelmError, got ${String(err)}`)
      assert.equal(err.code, 'plugin_has_live_tasks')
      return true
    })
    release2()
    assert.deepEqual(await slow, { done: true })
    // Disable succeeds after task finishes
    await host.disable('test:slow')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 5. Durable conversation restart: reopen createHelm on same dataDir, preserving #1/history/SSE seq
// ---------------------------------------------------------------------------

test('integration 5: seeded conversation and history persist across restarts via real SQLite, faux resume sees full history, SSE seq never regresses', { timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-'))
  const dbPath = join(dir, 'state.sqlite')

  const build = () => createHubTestApp({ dataDir: dir, cwd: dir })

  const MARK = 'restart before key conclusion-PERSIST-MARK'
  let seqAfterFirst = 0
  const first = await build()
  const firstConv = first.app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (firstConv === undefined) throw new Error('first boot should seed initial assistant conversation')
  try {
    first.faux.setResponses([fauxAssistantMessage(`already record:${MARK}`)])
    await first.app.kernel.submitInput(firstConv.id, `please record:${MARK}`)
    await first.app.kernel.waitForIdle(firstConv.id)
    assert.equal(first.faux.state.callCount, 1)
    seqAfterFirst = first.app.kernel.events.seq
    assert.ok(seqAfterFirst > 0, 'one turn should advance SSE seq')
  } finally {
    await first.app.close()
  }

  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    assert.ok(convs.some((c) => c.id === firstConv.id), 'seeded initial conversation remains after restart')
    assert.ok(
      second.app.kernel.events.seq >= seqAfterFirst,
      `SSE seq after restart (${second.app.kernel.events.seq}) should be >= post-first-turn (${seqAfterFirst})`,
    )
    const conv = second.app.kernel.getConversation(firstConv.id)
    assert.ok(conv.completionSeq >= 1, 'completionSeq persists across restarts')

    // Resume turn: model sees complete history
    const seen: string[] = []
    second.faux.setResponses([
      (ctx) => {
        seen.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('reviewed history')
      },
    ])
    await second.app.kernel.submitInput(firstConv.id, 'recall what we said earlier')
    await second.app.kernel.waitForIdle(firstConv.id)
    assert.ok(seen[0]!.includes(MARK), 'model request after restart should contain history messages')
    assert.ok(sqliteTablesContaining(dbPath, MARK).length > 0, 'history entry should persist')
  } finally {
    await second.app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. Real HTTP loopback: real startHub(port 0) + real app.kernel
// ---------------------------------------------------------------------------

async function makeHttpEnv() {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-core-e2e-http-'))
  const { app, faux } = await createHubTestApp({ dataDir, cwd: dataDir })

  // Seeded initial conversation ID (first assistant conversation without parent; still exists in this environment)
  const initialConv = app.kernel
    .listConversations()
    .find((c) => c.profileId === 'assistant' && c.parentConversationId === undefined)
  if (initialConv === undefined) throw new Error('makeHttpEnv: first boot should seed initial assistant conversation')

  // Integration probe plugin: echo action returns real stash secret value (verifies outbound redaction pipeline).
  // Probe reads indirectly via probeState: deleting initial conversation reclaims its stash secret (per contract),
  // so the test re-registers the secret on a surviving conversation before asserting.
  const stash = app.kernel.services.stash
  const SECRET_TRICKY = ['quote"', 'line'].join('\n')
  const probeState = {
    secret: SECRET_TRICKY,
    placeholder: stash.put(initialConv.id, 'TRICKY_TOKEN', SECRET_TRICKY),
  }

  await app.kernel.plugins!.register({
    id: 'test:probe',
    name: 'integration probe',
    definePlugin(ctx) {
      ctx.action<{ text: string }, { text: string }>({
        id: 'echo',
        description: 'echo back (including secret redaction check)',
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
        description: 'double number',
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

  // Real startHub: port 0 (kernel-allocated), kernel entirely from createHelm
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

test('integration 6: real HTTP loopback — auth / initial conversation deletable / identical action validation / no outbound secret leak / SSE initial snapshot / public plugin route', { timeout: 60_000 }, async () => {
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

    // --- Authentication boundary
    const anon = await call('GET', '/api/conversations', { auth: false })
    assert.equal(anon.status, 401)
    const statusBefore = await call('GET', '/api/auth/status', { auth: false })
    assert.equal(statusBefore.status, 200)
    assert.equal(JSON.parse(statusBefore.body).configured, false)

    const setup = await call('POST', '/api/auth/setup', { body: { password: env.rootPassword }, auth: false })
    assert.equal(setup.status, 200)
    token = JSON.parse(setup.body).token as string
    assert.ok(typeof token === 'string' && token.length > 0)
    const badLogin = await call('POST', '/api/auth/login', { body: { password: 'wrong password but long enough' }, auth: false })
    assert.equal(badLogin.status, 401)
    const relogin = await call('POST', '/api/auth/login', { body: { password: env.rootPassword }, auth: false })
    assert.equal(relogin.status, 200)

    // --- Initial conversation deletable (id-level exemption removed; generic protection uses plugin management 409)
    const initialId = env.initialConvId
    const delInitial = await call('DELETE', `/api/conversations/${initialId}`)
    assert.equal(delInitial.status, 200, `deleting initial conversation should succeed: ${delInitial.body}`)
    const goneInitial = await call('GET', `/api/conversations/${initialId}`)
    assert.equal(goneInitial.status, 404)
    // Recreate a regular conversation for subsequent turns
    const created = await call('POST', '/api/conversations', { body: { title: 'integration conversation', profileId: 'assistant' } })
    assert.equal(created.status, 201)
    const httpConvId = (JSON.parse(created.body) as { id: number }).id

    // --- Real model turn (HTTP submit -> real kernel -> faux)
    const conv = await call('GET', `/api/conversations/${httpConvId}`)
    assert.equal(conv.status, 200)
    assert.equal(JSON.parse(conv.body).id, httpConvId)
    env.faux.setResponses([fauxAssistantMessage('HTTP turn complete')])
    // Non-blocking submit: route defaults to submission accepted (202 + {submissionId}), never fabricates synchronous reply
    const sent = await call('POST', `/api/conversations/${httpConvId}/input`, { body: { text: '你好, integration test' } })
    assert.equal(sent.status, 202)
    const submission = JSON.parse(sent.body) as { submissionId: string }
    assert.ok(typeof submission.submissionId === 'string' && submission.submissionId.length > 0, '202 should carry submissionId')
    await env.app.kernel.waitForIdle(httpConvId)
    assert.ok(env.faux.state.callCount >= 1, 'HTTP submit should trigger a real model turn')

    // Explicit wait path: ?wait=1 waits specifically for this submission's reply (200 ConversationInputResult)
    env.faux.setResponses([fauxAssistantMessage('HTTP wait for answer')])
    const waited = await call('POST', `/api/conversations/${httpConvId}/input?wait=1`, { body: { text: 'wait path check' } })
    assert.equal(waited.status, 200, `wait=1 should return this turn's reply: ${waited.body}`)
    const waitResult = JSON.parse(waited.body) as { submissionId: string; text: string; entry: { id: string; kind: string } }
    assert.ok(waitResult.submissionId.length > 0)
    assert.equal(waitResult.text, 'HTTP wait for answer')
    assert.ok(waitResult.entry.id, 'wait result should contain the exact reply entry')

    // --- Identical action validation: HTTP invalid params return 400 validation_error (same validator as invokeAction)
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
    assert.equal(JSON.parse(memoryWithContext.body).profileId, 'assistant', 'HTTP conversationId context resolves current Profile')
    const memoryInvalidExplicit = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: 'missing' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidExplicit.status, 404)
    assert.equal(JSON.parse(memoryInvalidExplicit.body).error.code, 'profile_not_found', 'invalid explicit Profile must not fall back to HTTP context')
    const memoryInvalidId = await call('POST', '/api/actions/builtin:memory/get', {
      body: { input: { profileId: '../outside' }, conversationId: httpConvId },
    })
    assert.equal(memoryInvalidId.status, 400)
    assert.equal(JSON.parse(memoryInvalidId.body).error.code, 'validation_error', 'invalid Profile ID rejected with 400 at action boundary')
    const workflowWithoutTarget = await call('POST', '/api/actions/builtin:workflow/run', {
      body: { input: { script: 'export const meta = { name: "no-target", description: "t" }\nreturn 1' } },
    })
    assert.equal(workflowWithoutTarget.status, 400)
    assert.equal(JSON.parse(workflowWithoutTarget.body).error.code, 'validation_error')
    const badAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: 123 } } })
    assert.equal(badAction.status, 400)
    assert.equal(JSON.parse(badAction.body).error.code, 'validation_error')

    // --- HTTP outbound redaction: when echo action result contains stash secret, response emits only placeholder.
    // Hub unified JsonRedactor (kernel.services.stash.redact) must scrub plaintext before egress.
    // Initial conversation was deleted (reclaiming its stash secret): re-register same value on surviving conversation first.
    env.probeState.placeholder = env.stash.put(httpConvId, 'TRICKY_TOKEN', env.SECRET_TRICKY)
    const echoAction = await call('POST', '/api/actions/test:probe/echo', { body: { input: { text: 'prefix' } } })
    assert.equal(echoAction.status, 200)
    const echoBody = echoAction.body
    assert.ok(!echoBody.includes(env.SECRET_TRICKY), 'HTTP response must not contain plaintext secret (multiline form)')
    assert.ok(!echoBody.includes('quote\\"'), 'HTTP response must not contain JSON-escaped secret')
    assert.ok(!echoBody.includes('line'), 'HTTP response must not contain second line of plaintext secret')
    assert.ok(echoBody.includes(env.probeState.placeholder), 'HTTP response should preserve placeholder')

    // --- SSE initial snapshot frame: immediately emits snapshot after authenticated connect
    const sseResponse = await fetch(`${base}/api/events`, { headers: { authorization: `Bearer ${token}` } })
    assert.equal(sseResponse.headers.get('content-type'), 'text/event-stream')
    const reader = sseResponse.body!.getReader()
    const firstChunk = new TextDecoder().decode((await reader.read()).value)
    assert.ok(firstChunk.includes('event: snapshot'), 'first SSE frame should be snapshot')
    assert.ok(firstChunk.includes('"conversations"'), 'snapshot should contain conversations list')
    await reader.cancel().catch(() => {})

    // --- Plugin public route bypasses auth + encoded pluginId decodes to match
    const encoded = encodeURIComponent('test:probe')
    const pub = await fetch(`${base}/api/plugins/${encoded}/routes/ping`)
    assert.equal(pub.status, 200)
    assert.equal((JSON.parse(await pub.text()) as { via: string }).via, 'plugin-route')

    // --- Workflows: real engine via builtin:workflow plugin action (same /api/actions pipeline)
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
    assert.equal(wf.status, 200, `real workflow engine should accept run: ${wf.body}`)
    const summary = (JSON.parse(wf.body) as { run: { id: string; status: string } }).run
    assert.ok(summary.id.startsWith('wf_'), 'summary should contain wf_-prefixed runId')
    assert.ok(['running', 'completed'].includes(summary.status))
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 7. CLI <-> real Hub: in-process runCli + async child process real CLI entrypoint
// ---------------------------------------------------------------------------

test('integration 7: CLI <-> Hub real path — setup credentials / status / conversations / send triggers real model turn / dynamic action commands / invalid args exit non-zero / child CLI process', { timeout: 60_000 }, async () => {
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
   * Async child-process real CLI: uses spawn (never spawnSync, which blocks the parent event loop
   * so an in-process Hub under test cannot respond over HTTP — a test flaw, not a CLI flaw).
   * Collects output via stdio pipes; hard timeout kill guards against hangs.
   */
  const runCliChildInEnv = (args: string[], timeoutMs = 20_000): Promise<CliRunResult> =>
    runCliChild(
      args,
      { ...process.env, HELM_HUB_URL: hubUrl.toString(), HELM_DATA_DIR: env.dataDir, HELM_TOKEN: '' },
      timeoutMs,
    )

  try {
    // --- Unauthenticated: protected commands fail explicitly with non-zero exit
    const anon = await run(['conversations', 'list', '--json'])
    assert.notEqual(anon.code, 0)
    assert.equal((JSON.parse(anon.err) as { error: { code: string } }).error.code, 'unauthorized')

    // --- setup: real scrypt credentials + separate cli-token file
    const setup = await run(['setup', '--password', env.rootPassword, '--json'])
    assert.equal(setup.code, 0, setup.err)
    assert.ok(typeof (JSON.parse(setup.out) as { token: string }).token === 'string')
    const credRaw = JSON.parse(readFileSync(join(env.dataDir, 'cli-token'), 'utf8')) as {
      hubUrl?: string; token?: string
    }
    assert.ok(credRaw.token, 'login token should be saved in cli-token')
    assert.ok(credRaw.hubUrl?.startsWith('http://127.0.0.1:'), 'hubUrl should persist')

    // --- status: public endpoint
    const status = await run(['status', '--json'])
    assert.equal(status.code, 0, status.err)
    assert.equal(JSON.parse(status.out).configured, true)

    // --- conversations list: authenticated via credentials file token
    const list = await run(['conversations', 'list', '--json'])
    assert.equal(list.code, 0, list.err)
    const convs = JSON.parse(list.out) as Array<{ id: number; profileId: string }>
    assert.ok(convs.some((c) => c.profileId === 'assistant'), 'should list assistant conversation')

    // --- Dynamic memory command: real CLI <-> Hub, resolves conversation Profile via --current
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
    assert.equal(JSON.parse(explicitMemory.out).profileId, 'assistant', 'explicit --profile-id overrides --current')
    const memoryNoTarget = await run(['memory', 'get', '--json'])
    assert.notEqual(memoryNoTarget.code, 0)
    assert.equal((JSON.parse(memoryNoTarget.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- send: CLI submit -> real model turn
    const callCountBefore = env.faux.state.callCount
    env.faux.setResponses([fauxAssistantMessage('CLI turn complete')])
    const send = await run(['send', '1', '你好 CLI integration', '--json'])
    assert.equal(send.code, 0, send.err)
    await env.app.kernel.waitForIdle(env.initialConvId)
    assert.ok(env.faux.state.callCount > callCountBefore, 'CLI send should trigger a real model turn')

    // --- Dynamic action command: GET /api/actions generates helm probe double
    const doubled = await run(['probe', 'double', '--n', '21', '--json'])
    assert.equal(doubled.code, 0, doubled.err)
    assert.equal(JSON.parse(doubled.out).doubled, 42)

    // --- Flag layer rejection: number conversion failure exits non-zero
    const badFlag = await run(['probe', 'double', '--n', 'abc', '--json'])
    assert.notEqual(badFlag.code, 0)

    // --- Server-side Schema rejection (--input bypasses flag conversion): validation_error
    const badSchema = await run(['probe', 'double', '--input', '{"n":"not a number"}', '--json'])
    assert.notEqual(badSchema.code, 0)
    assert.equal((JSON.parse(badSchema.err) as { error: { code: string } }).error.code, 'validation_error')

    // --- Create a regular conversation for child-process get verification
    const mkConv = await run(['conversations', 'create', '--title', 'CLI conversation', '--profile-id', 'assistant', '--json'])
    assert.equal(mkConv.code, 0, mkConv.err)
    const cliConvId = (JSON.parse(mkConv.out) as { id: number }).id

    // --- Child-process real CLI entrypoint (async spawn; parent event loop stays responsive so Hub can answer):
    //     after setup, child processes read cli-token credentials to access the same real Hub
    //     (run three read-only commands concurrently to avoid serial process startup wait).
    const [childStatus, childGet, childAuth] = await Promise.all([
      runCliChildInEnv(['status', '--json']),
      runCliChildInEnv(['conversations', 'get', String(cliConvId), '--json']),
      runCliChildInEnv(['conversations', 'list', '--json']),
    ])
    assert.equal(childStatus.timedOut, false, 'child-process CLI must not hang')
    assert.equal(childStatus.code, 0, `child-process status failed: ${childStatus.err}`)
    assert.equal(JSON.parse(childStatus.out).configured, true)

    assert.equal(childGet.timedOut, false, 'child-process CLI must not hang')
    assert.equal(childGet.code, 0, `child-process conversations get failed: ${childGet.err}`)
    assert.equal(JSON.parse(childGet.out).id, cliConvId)

    assert.equal(childAuth.timedOut, false)
    assert.equal(childAuth.code, 0, `child-process auth via cli-token should work: ${childAuth.err}`)
    assert.ok((JSON.parse(childAuth.out) as Array<{ id: number }>).some((c) => c.id === cliConvId))

    // --- After deleting initial conversation: workflow without target returns 400; --current and explicit target work normally
    const delInitial = await run(['conversations', 'delete', String(env.initialConvId), '--json'])
    assert.equal(delInitial.code, 0, `deleting initial conversation should succeed: ${delInitial.err}`)
    const goneCheck = await run(['conversations', 'get', String(env.initialConvId), '--json'])
    assert.notEqual(goneCheck.code, 0, 'GET after deletion should return non-zero (404)')

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
    assert.equal(toolRun.structuredOutput?.summary?.conversationId, cliConvId, 'Workflow tool uses actual current conversation, independent of id 1')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Subagent runtime live correlation: parentToolCallId written to mirror & broadcast in conversation.upsert
// ---------------------------------------------------------------------------

test('subagent spawn: child conversation summary carries parentToolCallId and broadcasts via conversation.upsert', { timeout: 60_000 }, async () => {
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
    // Parent conversation model invokes subagent tool; subagent responds independently via faux.
    env.faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall('subagent', { prompt: 'sub-task: check build', background: false })],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('subagent returned, task complete'),
    ])
    // Child conversation uses the same faux provider (faux queue consumed in request order: parent tool turn -> subagent turn -> parent wrap-up turn).
    await env.submitAndWait('please dispatch a subagent to check build')

    // Summary layer: spawned child conversation mirror carries parentToolCallId (parent's tool call ID).
    const child = kernel
      .listConversations()
      .find((c) => c.parentConversationId === env.initialConvId && c.parentToolCallId !== undefined)
    assert.ok(child !== undefined, 'child conversation summary must carry parentToolCallId (live runtime correlation contract)')
    assert.ok(child!.parentToolCallId !== undefined && child!.parentToolCallId !== '')

    // Event layer: conversation.upsert broadcast includes the child conversation and parentToolCallId (frontend correlates immediately over SSE).
    const broadcast = upserts.find((u) => u.id === child!.id && u.parentToolCallId === child!.parentToolCallId)
    assert.ok(broadcast !== undefined, 'conversation.upsert must broadcast child conversation summary with parentToolCallId')
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Loop 1: managed token — CLI inside managed bash works independently of disk login
// ---------------------------------------------------------------------------

test('loop 1: CLI conversations get --current inside managed bash works independently of disk login; HELM_TOKEN flows only in redacted form', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    const runtime = env.app.kernel as unknown as { setHubUrl?: (url: string) => void }
    assert.equal(typeof runtime.setHubUrl, 'function', 'KernelRuntime.setHubUrl should exist')
    runtime.setHubUrl!(base)

    const tokenGetter = (env.app.kernel as unknown as {
      toolDeps?: { processToken?: () => string }
    }).toolDeps?.processToken
    assert.equal(typeof tokenGetter, 'function', 'toolDeps.processToken should exist')
    const managedToken = tokenGetter!()

    // Connect directly via HELM_TOKEN env under a fresh temporary dataDir (no cli-token disk file).
    const cliDataDir = mkdtempSync(join(tmpdir(), 'helm-align-cli-'))
    const cliEnvBase = {
      ...process.env,
      HELM_HUB_URL: base,
      HELM_DATA_DIR: cliDataDir,
      HELM_TOKEN: managedToken,
    }
    try {
      assert.equal(existsSync(join(cliDataDir, 'cli-token')), false, 'initially has no disk login')

      const got = await runCliChild(
        ['conversations', 'get', '--current', '--json'],
        { ...cliEnvBase, HELM_CONVERSATION_ID: String(ROOT_CONVERSATION_ID) },
      )
      assert.equal(got.timedOut, false, 'CLI child process must not hang')
      assert.equal(got.code, 0, `managed-token CLI should succeed: ${got.err}`)
      const summary = JSON.parse(got.out) as { id: number; model?: unknown; entries?: unknown[] }
      assert.equal(summary.id, ROOT_CONVERSATION_ID)
      assert.ok(Array.isArray(summary.entries), 'CLI get should return detail payload (entries timeline)')
      assert.ok(!got.out.includes(managedToken) && !got.err.includes(managedToken), 'CLI output must not echo raw token')

      // Placeholder form: after global redactor registration, any egress shows [REDACTED] placeholder.
      const marker = env.app.kernel.services.stash.redact(managedToken)
      assert.notEqual(marker, managedToken, 'managed token must be registered in global redactor')

      // Subscribe first and wait for initial snapshot frame (ensuring subscription is ready), then submit token-bearing input;
      // wait condition requires both entry and upsert (upsert is emitted on turn settle, so exiting on entry alone would miss the settled frame).
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
          return fauxAssistantMessage('received')
        },
      ])
      await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, `credentials is ${managedToken} please keep`)
      await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)
      assert.ok(requests.length > 0, 'should capture model request')
      assert.ok(!requests[0]!.includes(managedToken), 'model request must not contain raw managed token')

      // SSE incremental events (conversation.entry / upsert) exclude raw token.
      const frames = await sub.frames
      const joined = frames.join('\n')
      assert.ok(joined.includes('event: conversation.entry'), 'should receive conversation.entry incremental event')
      assert.ok(joined.includes('event: conversation.upsert'), 'should receive conversation.upsert incremental event')
      assert.ok(!joined.includes(managedToken), 'SSE frames must not contain raw managed token')

      assert.deepEqual(
        sqliteTablesContaining(env.dbPath, managedToken),
        [],
        'no state.sqlite table may contain raw managed token',
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
// Loop 2: executing real CLI inside managed bash (bash tool child process env carries managed token)
// ---------------------------------------------------------------------------

test('loop 2: executing helm conversations get inside managed bash tool — env injection, exit 0 marker, detail markers returned, token never echoed', { timeout: 60_000 }, async () => {
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
    // Trailing && echo CLI_OK: prints marker only when CLI exits 0 (short-circuit via &&).
    const cmd = [
      `export HELM_DATA_DIR="${cliDataDir}"`,
      `export HELM_CONVERSATION_ID=${ROOT_CONVERSATION_ID}`,
      `"${process.execPath}" "${tsxCli}" "${cliEntry}" conversations get --current --json`,
      'echo CLI_OK',
    ].join(' && ')

    // Response #1 triggers bash tool call; capture goes in response #2 after tool result —
    // a fixed final answer won't carry tool result context and can never be captured.
    const toolResults: string[] = []
    env.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { command: cmd })], { stopReason: 'toolUse' }),
      (ctx) => {
        toolResults.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('done')
      },
    ])

    await env.app.kernel.submitInput(ROOT_CONVERSATION_ID, 'execute helm conversations get --current --json inside managed shell')
    await env.app.kernel.waitForIdle(ROOT_CONVERSATION_ID)

    assert.ok(toolResults.length > 0, 'should capture post-tool model request')
    const toolCtx = toolResults[0]!
    const managedToken = (env.app.kernel as unknown as { toolDeps?: { processToken?: () => string } }).toolDeps?.processToken?.()
    assert.ok(managedToken, 'toolDeps.processToken should exist')
    assert.ok(!toolCtx.includes(managedToken!), 'tool result passed to model must not contain raw managed token')
    // Evidence chain for real CLI success: exit 0 marker + detail entries timeline + helm.input
    // entry + conversation title — never pass just because the digit 1 appears.
    assert.ok(toolCtx.includes('CLI_OK'), 'tool output should contain CLI exit 0 marker CLI_OK')
    assert.ok(toolCtx.includes('helm.input'), 'CLI detail should contain helm.input entry (current input persisted)')
    assert.ok(toolCtx.includes('person assist'), 'CLI detail should contain conversation title')
    assert.ok(toolCtx.includes('entries'), 'CLI detail should contain entries timeline field')
    // toolCtx is JSON.stringify of message array, so quotes in CLI output are escaped (\"id\": 1)
    assert.ok(/id\\?"?\s*:\s*1\b/.test(toolCtx), 'CLI detail should contain conversation id')
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Loop 3: full input.meta pipeline + detail pagination + events + snapshot extensions + workflow deltas
// ---------------------------------------------------------------------------

test('loop 3: CLI send --meta -> helm.input entry -> turn_settled end-to-end; complete pagination; real entry/live/plugin.changed/workflow.updated deltas', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  try {
    hub = await startHub({ kernel: env.app.kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // Plugin: collects turn_settled inputs (meta must arrive intact)
    const settledInputs: Array<{ origins: string[]; metas: Array<Record<string, unknown> | undefined> }> = []
    await env.app.kernel.plugins.register({
      id: 'test:meta-probe',
      name: 'meta probe',
      definePlugin(ctx) {
        ctx.hook.onTurnSettled((payload) => {
          settledInputs.push({
            origins: payload.inputs.map((i) => i.origin),
            metas: payload.inputs.map((i) => i.meta),
          })
        })
      },
    } satisfies PluginDefinition)

    // All three subscriptions wait for initial snapshot ready before triggering actions:
    // A: CLI send turn conversation.entry / conversation.live deltas;
    // B: two plugin.changed frames for enable/disable;
    // C: workflow.updated completion delta for pure-script workflow run.
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
        ['send', String(ROOT_CONVERSATION_ID), 'input carrying metadata', '--meta', JSON.stringify(meta), '--wait', '--json'],
        { ...process.env, HELM_HUB_URL: base, HELM_DATA_DIR: cliDataDir, HELM_TOKEN: userToken },
      )
      assert.equal(sent.timedOut, false)
      if (sent.code !== 0) {
        assert.fail(`send --meta --wait failed: ${sent.err}`)
      }
      // send --wait returns ConversationInputResult: text is this turn's reply, entry is the reply item
      const waitResult = JSON.parse(sent.out) as { text: string; entry?: { id: string } }
      assert.equal(waitResult.text, 'meta turn complete', 'send --wait should return this turn reply text')
      assert.ok(waitResult.entry?.id, 'send --wait should return this turn reply entry id')
    } finally {
      rmSync(cliDataDir, { recursive: true, force: true })
    }

    // turn_settled: meta arrives intact across the pipeline
    await waitFor(() => settledInputs.length > 0)
    assert.equal(settledInputs[0]!.metas.length, 1)
    assert.deepEqual(settledInputs[0]!.metas[0], meta, 'meta should flow from CLI intact to turn_settled')

    // Detail view: GET /api/conversations/1 includes data.meta on helm.input entry
    const detailRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    assert.equal(detailRes.status, 200)
    const detail = JSON.parse(detailRes.body) as {
      entries: Array<{ kind: string; data?: { meta?: Record<string, unknown>; text?: string }; model?: unknown[] }>
    }
    const inputEntry = detail.entries.find((e) => e.kind === 'helm.input')
    assert.ok(inputEntry, 'detail should contain helm.input entry')
    assert.deepEqual(inputEntry!.data?.meta, meta, 'helm.input entry should carry meta')

    // Assistant text lives in entry.model (not data) — detail preserves model messages
    const assistantEntry = detail.entries.find((e) => e.kind === 'pi.assistant')
    if (assistantEntry) {
      assert.ok(
        JSON.stringify(assistantEntry.model ?? '').includes('meta turn complete'),
        'assistant text should be in entry.model (model context message)',
      )
    }

    // SSE: conversation.entry and conversation.live arrive incrementally (subscription established before turn)
    const frames = await subA.frames
    const joined = frames.join('\n')
    assert.ok(joined.includes('event: conversation.entry'), 'should receive conversation.entry event')
    assert.ok(joined.includes('event: conversation.live'), 'should receive conversation.live event')
    const inputFrame = frames.find((f) => f.includes('event: conversation.entry') && f.includes('test.render'))
    assert.ok(inputFrame, 'conversation.entry delta should carry helm.input meta')

    // Initial snapshot extensions: ui and pluginDocs (builtin:workflow public runs doc)
    const snapFrame = frames.find((f) => f.startsWith('event: snapshot'))
    assert.ok(snapFrame, 'subscription should receive initial snapshot frame')
    assert.ok(snapFrame!.includes('"ui"'), 'snapshot should contain ui (plugin UI contributions)')
    assert.ok(snapFrame!.includes('"pluginDocs"'), 'snapshot should contain pluginDocs')

    // Pagination: limit=1 first page + cursor paging to the end, aggregated with no drops or duplicates
    const firstPageRes = await httpCall(base, 'GET', '/api/conversations/1?limit=1', { token: userToken })
    assert.equal(firstPageRes.status, 200)
    const firstPage = JSON.parse(firstPageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
    assert.equal(firstPage.entries.length, 1)
    assert.ok(firstPage.nextCursor, 'should have next page cursor')
    const collected = [...firstPage.entries.map((e) => e.id)]
    let cursor: string | undefined = firstPage.nextCursor
    let guard = 0
    while (cursor !== undefined && guard++ < 50) {
      const pageRes = await httpCall(base, 'GET', `/api/conversations/1?limit=2&cursor=${encodeURIComponent(cursor)}`, { token: userToken })
      assert.equal(pageRes.status, 200, `cursor pagination failed: ${pageRes.body}`)
      const page = JSON.parse(pageRes.body) as { entries: Array<{ id: string }>; nextCursor?: string }
      collected.push(...page.entries.map((e) => e.id))
      cursor = page.nextCursor
    }
    assert.equal(new Set(collected).size, collected.length, 'pagination must not duplicate entries')
    const fullRes = await httpCall(base, 'GET', '/api/conversations/1', { token: userToken })
    const full = JSON.parse(fullRes.body) as { entries: Array<{ id: string }> }
    assert.deepEqual(
      [...collected].sort(),
      full.entries.map((e) => e.id).sort(),
      'paginated aggregation must match full set (no missing head/tail)',
    )

    // plugin.changed carries ui: enable/disable a probe plugin with UI contributions after subscription is ready,
    // receiving non-empty ui and empty-array ui frames in order on the same connection without reconnecting for snapshot.
    await env.app.kernel.plugins.register({
      id: 'test:ui-probe',
      name: 'UI probe',
      definePlugin(ctx) {
        ctx.ui.sidebarItem({ id: 'ui-probe', label: 'align probe', target: 'conversation:1' })
      },
    } satisfies PluginDefinition)
    await env.app.kernel.plugins.disable('test:ui-probe')
    const changeFrames = await subB.frames
    const changed = changeFrames.filter((f) => f.includes('event: plugin.changed'))
    assert.ok(changed.length >= 2, `same connection should receive two plugin.changed frames for enable/disable (got ${changed.length})`)
    const withUi = changed.find((f) => f.includes('"ui"') && f.includes('sidebar.item'))
    assert.ok(withUi, 'enable event should carry ui contributions (including surface)')
    const disabledEmptyUi = changed.find((f) => f.includes('"enabled":false') && /"ui":\s*\[\]/.test(f))
    assert.ok(disabledEmptyUi, 'disable event ui should be an empty array (client replaces contributions accordingly)')

    // Pure-script workflow: run via CLI run --wait after subscription ready,
    // double-verifying both CLI terminal output and workflow.updated completion delta.
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
        assert.fail(`workflows run --wait failed: ${wf.err}`)
      }
      const runSummary = (JSON.parse(wf.out) as { run: { id: string; status: string; result?: unknown } }).run
      assert.equal(runSummary.status, 'completed')
      assert.equal(runSummary.result, 42)
      const wfFrames = await subC.frames
      const completedFrame = wfFrames.find(
        (f) => f.includes('event: workflow.updated') && f.includes(runSummary.id) && f.includes('"status":"completed"'),
      )
      assert.ok(completedFrame, 'same connection should receive workflow.updated completion delta for the run')
    } finally {
      rmSync(cliDataDir2, { recursive: true, force: true })
    }
  } finally {
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Loop 4: public/private plugin docs / manageConversation / scope
// ---------------------------------------------------------------------------

test('loop 4: ctx.doc public/private boundary, plugin.doc.updated redaction delta, manageConversation protection, scoped tool visibility and run_action conversation enforcement', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  let hub: Awaited<ReturnType<typeof startHub>> | undefined
  // Busy gate releaser: declared outside try so finally can always settle it; resolve is idempotent
  let releaseBusy: () => void = () => {}
  try {
    const kernel = env.app.kernel
    const host = kernel.plugins

    // Public doc contains a secret value: public events must redact (placeholder), private doc returns 404.
    const SECRET = 'align-doc-secret-blue'
    const placeholder = kernel.services.stash.put(ROOT_CONVERSATION_ID, 'DOC_SECRET', SECRET)

    const busyGate = new Promise<void>((r) => (releaseBusy = r))
    const eventsSeen: string[] = []

    // Public doc updater closure: triggered explicitly after subscription ready so the event is a real delta
    // (updates during register happen before subscription and would never be captured).
    type PubDoc = { note: string; secret: string }
    let updatePubDoc!: (fn: (v: PubDoc) => PubDoc) => void

    const conv = await kernel.createConversation({ title: 'managed conversation', profileId: 'assistant' })

    await host.register({
      id: 'test:guard',
      name: 'guard probe',
      definePlugin(ctx) {
        const pub = ctx.doc('status', { note: 'init', secret: SECRET }, { public: true })
        const priv = ctx.doc('inner', { count: 0 })
        updatePubDoc = (fn) => pub.update(fn)
        ctx.action<Record<string, never>, { ok: boolean }>({
          id: 'blocked_out',
          description: 'out-of-scope cannot invoke via conversation path',
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
          description: 'scoped tool',
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
          description: 'holds in-flight task',
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
        // Manage conv from this plugin
        ctx.host.manageConversation(conv.id)
        // Private doc updates emit no events (only public docs emit events)
        priv.update((v) => ({ count: v.count + 1 }))
      },
    } satisfies PluginDefinition)

    hub = await startHub({ kernel: kernel as never, port: 0 })
    const base = hub.url
    const setupRes = await httpCall(base, 'POST', '/api/auth/setup', { body: { password: 'align test password at least eight' } })
    const userToken = (JSON.parse(setupRes.body) as { token: string }).token

    // --- Private doc: HTTP 404; public doc is readable and secret appears as stash placeholder
    const privateDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/inner`, { token: userToken })
    assert.equal(privateDoc.status, 404, `private doc must return 404: ${privateDoc.status}`)
    const publicDoc = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    if (publicDoc.status !== 200) {
      assert.fail(`public doc should be readable (plugin doc HTTP): ${publicDoc.status}`)
    }
    assert.ok(!publicDoc.body.includes(SECRET), 'public doc egress must not contain plaintext secret')
    assert.ok(publicDoc.body.includes(placeholder), 'public doc secret field should appear as stash placeholder')

    // --- plugin.doc.updated real delta: update after subscription ready and verify event redaction
    // (updating before subscribing would time out with [] and never verify the event).
    const docSub = openSseSubscription(
      base,
      userToken,
      (fs) => fs.some((f) => f.includes('event: plugin.doc.updated') && f.includes('after-subscribe')),
    )
    await docSub.ready
    updatePubDoc((v) => ({ ...v, note: 'after-subscribe' }))
    const docFrames = await docSub.frames
    const docFrame = docFrames.find((f) => f.includes('event: plugin.doc.updated'))
    assert.ok(docFrame, 'should receive plugin.doc.updated incremental event')
    assert.ok(!docFrame!.includes(SECRET), 'plugin.doc.updated must not contain plaintext secret')
    assert.ok(docFrame!.includes(placeholder), 'plugin.doc.updated secret should appear as stash placeholder')
    assert.ok(docFrame!.includes('after-subscribe'), 'event should carry updated marker value')
    // Public doc read reflects updated value (with secret still redacted)
    const publicDoc2 = await httpCall(base, 'GET', `/api/plugins/test:guard/docs/status`, { token: userToken })
    assert.equal(publicDoc2.status, 200)
    assert.ok(publicDoc2.body.includes('after-subscribe'), 'public doc should reflect updated value')
    assert.ok(!publicDoc2.body.includes(SECRET), 'updated public doc must still not contain plaintext secret')

    // --- Management protection: DELETE managed conversation returns 409 conversation_managed_by_plugin
    const delManaged = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delManaged.status, 409)
    assert.equal(JSON.parse(delManaged.body).error.code, 'conversation_managed_by_plugin')
    // Protection has no side effects: conversation still exists
    assert.equal(kernel.getConversation(conv.id).id, conv.id)

    // --- scope: listTools(conversation) filters per conversation
    const listToolsFn = host as unknown as {
      listTools?: (conversation?: { id: number; profileId: string; tags: string[] }) => Array<{ name: string }>
    }
    if (typeof listToolsFn.listTools !== 'function') {
      assert.fail('PluginHost.listTools(conversation) scope filter should exist')
    }
    const assistantTools = listToolsFn.listTools!({
      id: ROOT_CONVERSATION_ID,
      profileId: 'assistant',
      tags: [],
    })!.map((t) => t.name)
    const otherTools = listToolsFn.listTools!({ id: 999, profileId: 'other', tags: [] })!.map((t) => t.name)
    assert.ok(assistantTools.includes('guard_scoped'), 'assistant conversation should see guard_scoped')
    assert.ok(!otherTools.includes('guard_scoped'), 'other profile conversation must not see guard_scoped')

    // invokeAction with conversationId must match scope; out-of-scope rejects explicitly
    const okCall = await host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: conv.id })
    assert.deepEqual(okCall, { ok: true })
    await assert.rejects(
      () => host.invokeAction('test:guard', 'blocked_out', {}, { conversationId: ROOT_CONVERSATION_ID }),
      (err: unknown) => err instanceof HelmError && /scope|effect domain/.test(err.message),
      'out-of-scope conversationId invocation should reject explicitly',
    )
    // Human HTTP invocation without conversationId is unrestricted (conversation policy, not user auth)
    const httpNoCtx = await httpCall(base, 'POST', '/api/actions/test:guard/blocked_out', { token: userToken, body: { input: {} } })
    assert.equal(httpNoCtx.status, 200)

    // run_action meta-tool enforces conversationId: attempting to bypass scope is rejected.
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
    // Conversation #1 is out of scope (conversationIds only includes conv.id) -> tool result must explicitly reject
    await kernel.submitInput(ROOT_CONVERSATION_ID, 'invoke run_action test:guard.blocked_out')
    await kernel.waitForIdle(ROOT_CONVERSATION_ID)
    assert.ok(
      runActionOutputs.some((o) => /scope|effect domain|reject/.test(o)),
      'run_action in out-of-scope conversation should be explicitly rejected (error visible in tool result)',
    )

    // --- Disable rejects during in-flight task (409 plugin_has_live_tasks); succeeds after release and frees management
    const busy = host.invokeAction('test:guard', 'busy', {})
    await assert.rejects(
      () => host.disable('test:guard'),
      (err: unknown) => err instanceof HelmError && err.code === 'plugin_has_live_tasks',
    )
    releaseBusy()
    assert.deepEqual(await busy, { done: true })
    await host.disable('test:guard')

    // Management released after disable: DELETE now succeeds (auto-released on disable)
    const delAfter = await httpCall(base, 'DELETE', `/api/conversations/${conv.id}`, { token: userToken })
    assert.equal(delAfter.status, 200, `management should release after disable: ${delAfter.body}`)
    void eventsSeen
  } finally {
    // Failure fallback: release busy gate to avoid cleanup hang (resolve is idempotent)
    releaseBusy?.()
    await hub?.close()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Loop 5: external backend onAgentSpawn handled — real onResolved / onGateResult reporting
// ---------------------------------------------------------------------------

test('loop 5: test plugin agent_spawn handled external backend — real onResolved metadata, real kernel.runGate via onGateResult, gate runs once, settle ordering, missing gate fails explicitly', { timeout: 60_000 }, async () => {
  const env = await makeCoreEnv()
  // Settle gate releaser: declared outside try so finally can always release; resolve is idempotent
  let releaseSettle: () => void = () => {}
  try {
    const kernel = env.app.kernel

    // External execution environment (real temp directory, never guess host dir)
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
            throw new HelmError('test_backend_contract', 'external backend must receive onResolved/onGateResult callbacks', 500)
          }
          // Report real execution metadata (real temp directory + executionId + worktree)
          request.onResolved({
            nodeId: 'local',
            executionId: execId,
            effectiveCwd: execDir,
            meta: { 'builtin:workflow': { worktree: { path: execDir, branch: 'align-wt' } } },
          })
          // Run gate inside external execution environment (kernel.runGate executes real shell at execDir)
          if (request.gate !== undefined) {
            const result = await kernel.runGate(request.gate, { cwd: execDir, conversationId: request.parentConversationId })
            gates.push({ command: request.gate, cwd: execDir })
            request.onGateResult(result)
          }
          // Schema business payload (handled result; includes schema-declared field source)
          return { action: 'handled', result: { answer: 42, source: 'external' } }
        })
        ctx.host.onEvent('workflow.settled', async () => {
          settleEntered = true
          settleCount += 1
          await settleGate
        })
      },
    } satisfies PluginDefinition)

    // Gate counter file (real shell side effect, must run exactly once)
    const gateCmd = `mkdir -p "${gateDir}" && printf x >> "${join(gateDir, 'count')}" && test -f "${join(execDir, 'marker')}" || (touch "${join(execDir, 'marker')}"; true)`

    // Schema declares source: under additionalProperties:false, handled return value {answer, source}
    // must match schema completely without relying on strip-based lenient validation.
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

    // Settlement chain check: terminal run state returned via builtin:workflow plugin action (wait:true).
    // emitEvent awaits workflow.settled listeners (settleGate), so we wait until the listener enters (settleEntered),
    // release the gate, and then await run completion — reversing the order would deadlock.
    const startedPromise = env.runWorkflow({ script, conversationId: ROOT_CONVERSATION_ID, wait: true })
    await waitFor(() => settleEntered === true)
    releaseSettle()
    const { run: started } = await startedPromise
    const result = started.result as { answer: number; source?: string }
    assert.deepEqual(result, { answer: 42, source: 'external' }, 'external backend handled result should flow back to script')

    // Node metadata preserved: executionId / effectiveCwd / worktree / gate
    const summary = (await env.inspectRun(started.id)).run
    const node = summary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(node, 'should contain agent node')
    assert.equal(node!.executionId, execId, 'node should preserve external executionId')
    assert.equal(node!.effectiveCwd, execDir, 'node should preserve external effectiveCwd')
    assert.equal(node!.nodeId, 'local')
    assert.equal(node!.worktree?.path, execDir)
    assert.equal(node!.worktree?.branch, 'align-wt')
    assert.equal(node!.worktree?.id, `local:${execDir}`)
    assert.ok(node!.gate?.ok === true, 'node should contain gate execution result')

    // Gate executed exactly once (onGateResult skips redundant execution in engine)
    await waitFor(() => existsSync(join(gateDir, 'count')))
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate should execute exactly once')
    await waitFor(() => settleCount === 1)
    assert.equal(settleCount, 1, 'workflow.settled should trigger exactly once')

    // Resume replay neither re-runs gate nor re-executes external backend
    const gatesBefore = gates.length
    const { run: resumed } = await env.runWorkflow({ resumeFromRunId: started.id, conversationId: ROOT_CONVERSATION_ID, wait: true })
    const resumedResult = resumed.result as { answer: number; source?: string }
    assert.equal(resumedResult.answer, 42)
    assert.equal(gates.length, gatesBefore, 'resume replay must not re-run gate')
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'gate side effect must not repeat')

    // Disable previous handled backend so it does not intercept the missing-gate test spawn
    await kernel.plugins.disable('test:ext-backend')

    // --- Missing gate report: fails explicitly, never guesses a host dir to run gate
    await kernel.plugins.register({
      id: 'test:ext-nogate',
      name: 'missing-gate-report backend',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({ executionId: `${execId}-nogate`, effectiveCwd: execDir })
          // Intentionally omit onGateResult
          return { action: 'handled', result: { answer: 1 } }
        })
      },
    } satisfies PluginDefinition)

    // agent() returns null on failure by contract (does not throw); script must throw on null
    // so the overall run fails explicitly.
    const badScript =
      'export const meta = { name: "align-nogate", description: "gate result missing" }\n' +
      'const v = await agent("missing gate report", { gate: ' + JSON.stringify(gateCmd) + ' })\n' +
      'if (v === null || v === undefined) throw new Error("agent did not return result")\n' +
      'return v'
    // Engine contract: throwing in script fails the run; wait:true wraps failed runs in workflow_failed with runId details.
    let badId = ''
    await assert.rejects(
      () => env.runWorkflow({ script: badScript, conversationId: ROOT_CONVERSATION_ID, wait: true }),
      (err: unknown) => {
        badId = String((err as { details?: { runId?: string } }).details?.runId ?? '')
        return err instanceof HelmError && err.code === 'workflow_failed'
      },
    )
    assert.ok(badId !== '', 'error wrapper should carry runId')
    const badSummary = (await env.inspectRun(badId)).run
    assert.equal(badSummary.status, 'failed', 'missing gate report should fail explicitly')
    const badNode = badSummary.nodes?.find((n) => n.kind === 'agent')
    assert.ok(badNode, 'should contain agent node')
    assert.ok(badNode!.status === 'failed')
    // Only recognize genuine node diagnostic (gate_result_missing written to node.error by engine);
    // never fall back to summary.error which matches script's own thrown text.
    assert.ok(
      typeof badNode!.error === 'string' && badNode!.error.includes('gate_result_missing'),
      `agent node error should contain real diagnostic gate_result_missing: ${String(badNode!.error)}`,
    )
    // Never guesses a host dir to run gate: counter does not increase
    assert.equal(readFileSync(join(gateDir, 'count'), 'utf8'), 'x', 'missing-report run must not run gate in host dir')
    assert.equal(gates.length, gatesBefore, 'missing-report run must not run gate through backend')
  } finally {
    // Failure fallback: release settle gate so workflow.settled listener cannot hang forever (resolve is idempotent).
    releaseSettle()
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// Loop 6: two Profiles with independent SYSTEM/MEMORY/model + HTTP PATCH switch + persistence across restart
// ---------------------------------------------------------------------------

test('loop 6: dual Profile independent SYSTEM/MEMORY/model, consistent requests after PATCH switch and clearing override, preserved across restart', { timeout: 60_000 }, async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-align-profile-'))

  writeProfile(dataDir, 'researcher', {
    system: '# Researcher System\nyou are a researcher. unique marker ALIGN-SYS-RESEARCHER.',
    memory: 'RESEARCHER-MEM: prefers quoting sources',
  })
  writeProfile(dataDir, 'coder', {
    system: '# Coder System\nyou are a programmer. unique marker ALIGN-SYS-CODER.',
    memory: 'CODER-MEM: prefers writing tests',
  })

  const build = () => createHubTestApp({ dataDir, cwd: dataDir })

  const requests: string[] = []
  const first = await build()
  try {
    // One conversation per profile
    const r1 = await first.app.kernel.createConversation({ title: 'research member', profileId: 'researcher' })
    const c1 = await first.app.kernel.createConversation({ title: 'program member', profileId: 'coder' })

    // researcher turn: faux captures system sections
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r')
      },
    ])
    await first.app.kernel.submitInput(r1.id, 'researcher who are you')
    await first.app.kernel.waitForIdle(r1.id)

    // coder turn
    first.faux.setResponses([
      (ctx) => {
        requests.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('c')
      },
    ])
    await first.app.kernel.submitInput(c1.id, 'coder who are you')
    await first.app.kernel.waitForIdle(c1.id)

    assert.ok(requests.length >= 2)
    assert.ok(requests[0]!.includes('ALIGN-SYS-RESEARCHER'), 'researcher turn should inject its own SYSTEM')
    // Note: cross-Profile catalog (profile.catalog) includes a one-line summary of coder's first SYSTEM line
    // (which contains ALIGN-SYS-CODER), which is intentional sharing; here we assert full SYSTEM does not leak across profiles.
    assert.ok(!requests[0]!.includes('# Coder System'), 'researcher turn must not bleed coder full SYSTEM')
    assert.ok(requests[0]!.includes('RESEARCHER-MEM'), 'researcher turn should inject its own MEMORY')
    assert.ok(requests[1]!.includes('ALIGN-SYS-CODER'), 'coder turn should inject its own SYSTEM')
    assert.ok(requests[1]!.includes('CODER-MEM'), 'coder turn should inject its own MEMORY')
    assert.ok(!requests[1]!.includes('# Researcher System'), 'coder turn must not bleed researcher full SYSTEM')
  } finally {
    await first.app.close()
  }

  // Restart: profile binding and injection preserved
  const second = await build()
  try {
    const convs = second.app.kernel.listConversations()
    const r1 = convs.find((c) => c.title === 'research member')
    const c1 = convs.find((c) => c.title === 'program member')
    assert.ok(r1 && c1, 'conversations preserved across restart')

    const requests2: string[] = []
    second.faux.setResponses([
      (ctx) => {
        requests2.push(JSON.stringify(ctx.messages))
        return fauxAssistantMessage('r2')
      },
    ])
    await second.app.kernel.submitInput(r1!.id, 'ask once more')
    await second.app.kernel.waitForIdle(r1!.id)
    assert.ok(requests2[0]!.includes('ALIGN-SYS-RESEARCHER'), 'SYSTEM injection preserved across restart')

    // HTTP PATCH switches Profile: injection switches accordingly
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
      assert.equal(patched.status, 200, `PATCH profile failed: ${patched.body}`)

      const requests3: string[] = []
      second.faux.setResponses([
        (ctx) => {
          requests3.push(JSON.stringify(ctx.messages))
          return fauxAssistantMessage('c2')
        },
      ])
      await second.app.kernel.submitInput(r1!.id, 'ask again after switching profile')
      await second.app.kernel.waitForIdle(r1!.id)
      assert.ok(requests3[0]!.includes('ALIGN-SYS-CODER'), 'injection should switch after PATCH profile')
      assert.ok(!requests3[0]!.includes('# Researcher System'), 'old Profile full SYSTEM must not remain')

      // Explicit model override + clearing override: summary matches actual requests
      const override = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: 'faux/faux-1' },
      })
      assert.equal(override.status, 200)
      const cleared = await httpCall(base, 'PATCH', `/api/conversations/${r1!.id}`, {
        token,
        body: { model: '' },
      })
      assert.equal(cleared.status, 200, "PATCH model:'' clearing override should be accepted")
      const afterClear = JSON.parse(cleared.body) as { model: string }
      assert.ok(typeof afterClear.model === 'string' && afterClear.model !== '', 'effective model after clearing override reverts to Profile/global and is non-empty')
    } finally {
      await hub?.close()
    }
  } finally {
    await second.app.close()
    rmSync(dataDir, { recursive: true, force: true })
  }
})
