/**
 * Verification of ownership projection, `managedByPlugin` auto-seeding, and cross-platform `dispatch_worker`.
 *
 * Covers:
 * 1. Real-time `ConversationSummary.ownedBy` projection: normal conversations and root `#1` stay `'human'`;
 *    after enabling `builtin:superagent`, resident `router`/`watchdog` conversations and workers spawned
 *    via `dispatch_worker` report `ownedBy === 'helm'` in both `getConversation` and `listConversations`;
 *    `markConversationOwnership` changes emit `conversation.upsert` with the updated `ownedBy`.
 * 2. `managedByPlugin` auto-seeding: newly seeded `superagent`/`watchdog` Profiles and `watchdog-playbooks`
 *    Skill carry `'builtin:superagent'` and `humanSelectable=false`; existing user assets (lacking those
 *    fields) are preserved byte-for-byte without backfilling, overwriting, or migrating, while only missing
 *    files are populated (partial seeding).
 * 3. `dispatch_worker` supports `nodeId` and cross-platform `cwd`: POSIX absolute paths, Windows drive paths
 *    (`C:\\repo\\app` / `C:/repo/app`), and UNC paths dispatch cleanly; relative paths reject explicitly;
 *    `nodeId` passes through to the Worker conversation mirror (`nodeId === 'local'` passed explicitly).
 *
 * Composition discipline: real `createHelm` (real SQLite + real `PluginHost`) + faux provider;
 * honesty discipline: throw on failure, never skip or swallow errors.
 *
 * Runner: `tsx --test`; every test declares `{ timeout: 60_000 }` against deadlocks.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type HelmEventFrame } from '@helm/protocol'
import {
  openHubTestEnv,
  waitFor as waitForCondition,
  type FauxProviderHandle,
  type HubTestApp,
} from './helpers/hub-test-env.js'

/** Initial conversation ID (SDK reserves #1; ordinary conversation semantics, no product-level special privileges). */
const ROOT_CONVERSATION_ID = 1 as const

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface TestEnv {
  dataDir: string
  faux: FauxProviderHandle
  app: HubTestApp
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const env = await openHubTestEnv({ prefix: 'helm-ownership-' })
  env.faux.setResponses([fauxAssistantMessage('receives')])
  return {
    dataDir: env.dataDir,
    faux: env.faux,
    app: env.app,
    close: env.close,
  }
}

/** Polls until predicate holds (5s default timeout). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  await waitForCondition(predicate, { timeoutMs, message: 'waitFor timeout: condition did not become true within the time limit' })
}

/** Reads resident conversation IDs from the persisted index doc (flushes docs then reads SQLite directly). */
async function residentIds(env: TestEnv): Promise<{ router?: number; watchdog?: number }> {
  await env.app.kernel.documentStore.flush()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(env.dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = 'builtin:superagent:index'")
      .get() as { value: string } | undefined
    assert.ok(row, 'index doc should be persisted')
    const doc = JSON.parse(row.value) as { routerConversationId?: number; watchdogConversationId?: number }
    return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 1. Real-time ownedBy projection
// ---------------------------------------------------------------------------

test('ownership1: normal and root conversations have ownedBy=human; superagent residents and Workers have ownedBy=helm', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // Root #1 and human conversations: default `'human'`.
    assert.equal(kernel.getConversation(ROOT_CONVERSATION_ID).ownedBy, 'human')
    const human = await kernel.createConversation({ title: 'human conversation', profileId: 'assistant' })
    assert.equal(human.ownedBy, 'human')
    assert.equal(kernel.getConversation(human.id).ownedBy, 'human')
    const listBefore = kernel.listConversations()
    for (const s of listBefore) {
      if (s.id === human.id || s.id === ROOT_CONVERSATION_ID) assert.equal(s.ownedBy, 'human')
    }

    // Enable superagent: router/watchdog resident conversations become `helm`-owned.
    await kernel.plugins.enable('builtin:superagent')
    const ids = await residentIds(env)
    assert.ok(ids.router, 'router resident conversation should be allocated')
    assert.ok(ids.watchdog, 'watchdog resident conversation should be allocated')
    assert.equal(kernel.getConversation(ids.router!).ownedBy, 'helm')
    assert.equal(kernel.getConversation(ids.watchdog!).ownedBy, 'helm')
    const listed = new Map(kernel.listConversations().map((s) => [s.id, s.ownedBy]))
    assert.equal(listed.get(ids.router!), 'helm')
    assert.equal(listed.get(ids.watchdog!), 'helm')
    assert.equal(listed.get(ROOT_CONVERSATION_ID), 'human')
    assert.equal(listed.get(human.id), 'human')

    // Worker spawned via `dispatch_worker`: `helm`-owned in both `getConversation` and `listConversations`.
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'ownership verify task',
    })) as { workerConversationId: number }
    await kernel.waitForIdle(dispatched.workerConversationId)
    assert.equal(kernel.getConversation(dispatched.workerConversationId).ownedBy, 'helm')
    assert.equal(
      kernel.listConversations().find((s) => s.id === dispatched.workerConversationId)?.ownedBy,
      'helm',
    )
  } finally {
    await env.close()
  }
})

test('ownership2: markConversationOwnership emits conversation.upsert with updated ownedBy on change', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const frames: HelmEventFrame[] = []
    const off = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      const conv = await kernel.createConversation({ title: 'ownership event verify', profileId: 'assistant' })
      // Same-value mark (human -> human): emits no ownership event (idempotent no-op).
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      assert.equal(
        frames.filter((f) => f.event.type === 'conversation.upsert').length,
        0,
        'same-value mark must not emit an event',
      )
      // Changed mark (human -> helm): emits `conversation.upsert` with `ownedBy=helm`.
      kernel.markConversationOwnership(conv.id, 'helm')
      const upsert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(upsert, 'ownership change should emit conversation.upsert')
      assert.equal((upsert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'helm')
      assert.equal(kernel.getConversation(conv.id).ownedBy, 'helm')
      // Revert back to human: emits again with `ownedBy=human`.
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      const revert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(revert, 'ownership revert should emit conversation.upsert')
      assert.equal((revert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'human')
    } finally {
      off()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. managedByPlugin auto-seeding and preservation of existing assets
// ---------------------------------------------------------------------------

test('ownership3: newly seeded assets carry managedByPlugin=builtin:superagent and humanSelectable=false', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    // Profile: verified via both disk `profile.json` and `ProfileService`.
    const superagentJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; humanSelectable?: boolean }
    assert.equal(superagentJson.managedByPlugin, 'builtin:superagent')
    assert.equal(superagentJson.humanSelectable, false)
    const watchdogJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; humanSelectable?: boolean }
    assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
    assert.equal(watchdogJson.humanSelectable, false)
    const profiles = await env.app.kernel.profiles.list()
    assert.equal(profiles.find((p) => p.id === 'superagent')?.managedByPlugin, 'builtin:superagent')
    assert.equal(profiles.find((p) => p.id === 'superagent')?.humanSelectable, false)
    assert.equal(profiles.find((p) => p.id === 'watchdog')?.managedByPlugin, 'builtin:superagent')
    assert.equal(profiles.find((p) => p.id === 'watchdog')?.humanSelectable, false)
    // Default skill policy on fresh seed: router hub has `skills=[]`; watchdog has only `watchdog-playbooks`.
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      [],
      'newly seeded router Profile skills should be an empty array',
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      ['watchdog-playbooks'],
      'newly seeded watchdog Profile skills should contain only watchdog-playbooks',
    )
    // Default assistant remains managed by its own plugin, unaffected by superagent seeding.
    assert.equal(profiles.find((p) => p.id === 'assistant')?.managedByPlugin, 'builtin:profile')
    assert.equal(profiles.find((p) => p.id === 'assistant')?.humanSelectable, undefined)
    // Skill: verified via both `SKILL.md` frontmatter and `SkillService`.
    const skillMd = readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8')
    assert.match(skillMd, /^managedByPlugin: builtin:superagent$/m)
    const skills = await env.app.kernel.skills.list()
    assert.equal(skills.find((s) => s.id === 'watchdog-playbooks')?.managedByPlugin, 'builtin:superagent')
  } finally {
    await env.close()
  }
})

test('ownership4: existing custom Profile/Skill assets are preserved byte-for-byte; only missing files are seeded; no migration', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // Pre-populate custom user files: custom superagent `profile.json` (no managed marker), `SYSTEM.md`/`MEMORY.md`,
    // custom `SKILL.md` with empty `references/` (to verify partial seeding), and missing watchdog Profile.
    const profileJsonRaw =
      JSON.stringify({ id: 'superagent', name: 'My Router Hub', model: 'faux/faux-1' }, null, 2) + '\n'
    const systemMdRaw = '# My router hub prompt\n'
    const memoryMdRaw = '# Memory\n\nuser memory\n'
    const skillMdRaw = [
      '---',
      'name: watchdog-playbooks',
      'description: My custom playbook',
      '---',
      '',
      '# My custom playbook body',
      '',
    ].join('\n')
    mkdirSync(join(env.dataDir, 'profiles', 'superagent'), { recursive: true })
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), profileJsonRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), systemMdRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), memoryMdRaw)
    mkdirSync(join(env.dataDir, 'skills', 'watchdog-playbooks'), { recursive: true })
    writeFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), skillMdRaw)
    await env.app.kernel.plugins.enable('builtin:superagent')

    // Existing user assets preserved byte-for-byte: no backfilling `managedByPlugin`/`humanSelectable`,
    // no rewriting `name`/`model`, `SYSTEM.md`, `MEMORY.md`, or `SKILL.md`.
    assert.equal(
      readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
      profileJsonRaw,
      'existing profile.json must be preserved byte-for-byte without backfilling managed markers',
    )
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), systemMdRaw)
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), 'utf8'), memoryMdRaw)
    assert.equal(
      readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'),
      skillMdRaw,
      'existing SKILL.md must be preserved byte-for-byte without inserting frontmatter markers',
    )
    // ProfileService reflects the user's custom shape (no managed markers, still selectable).
    const userP = (await env.app.kernel.profiles.list()).find((p) => p.id === 'superagent')
    assert.equal(userP?.managedByPlugin, undefined)
    assert.equal(userP?.humanSelectable, undefined)
    assert.equal(userP?.name, 'My Router Hub')
    assert.equal(userP?.model, 'faux/faux-1')
    const userSkill = (await env.app.kernel.skills.list()).find((s) => s.id === 'watchdog-playbooks')
    assert.equal(userSkill?.managedByPlugin, undefined)
    assert.equal(userSkill?.description, 'My custom playbook')

    // Partial seeding: missing `references` under existing `SKILL.md` are seeded without touching existing files.
    const herdrRef = readFileSync(
      join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'herdr-stalled.md'),
      'utf8',
    )
    assert.match(herdrRef, /Handling Stalled Herdr Terminal Panes/)
    // Freshly written watchdog Profile carries new template fields (`managedByPlugin` + `humanSelectable=false`).
    const watchdogJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; humanSelectable?: boolean }
    assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
    assert.equal(watchdogJson.humanSelectable, false)

    // Idempotent: re-enabling after disable leaves existing assets untouched byte-for-byte.
    await env.app.kernel.plugins.disable('builtin:superagent')
    await env.app.kernel.plugins.enable('builtin:superagent')
    assert.equal(
      readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
      profileJsonRaw,
    )
    assert.equal(
      readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'),
      skillMdRaw,
    )
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 3. dispatch_worker: nodeId and cross-platform cwd
// ---------------------------------------------------------------------------

test('ownership5: dispatch_worker supports explicit nodeId and cross-platform cwd (POSIX/drive/UNC)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // POSIX absolute path + explicit local node: `cwd`/`nodeId` pass through to Worker conversation mirror.
    const posixWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'POSIX dispatch work',
      nodeId: 'local',
      cwd: '/tmp/posix-worker',
    })) as { workerConversationId: number }
    const posixSummary = kernel.getConversation(posixWorker.workerConversationId)
    assert.equal(posixSummary.nodeId, 'local')
    assert.equal(posixSummary.cwd, '/tmp/posix-worker')
    await kernel.waitForIdle(posixWorker.workerConversationId)

    // Windows drive backslash: `C:\repo\app`
    const winWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows dispatch work',
      cwd: 'C:\\repo\\app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winWorker.workerConversationId).cwd, 'C:\\repo\\app')
    await kernel.waitForIdle(winWorker.workerConversationId)

    // Windows drive forward slash: `C:/repo/app`
    const winFwdWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows forward slash dispatch work',
      cwd: 'C:/repo/app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winFwdWorker.workerConversationId).cwd, 'C:/repo/app')
    await kernel.waitForIdle(winFwdWorker.workerConversationId)

    // UNC path: `\\server\share\repo`
    const uncWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'UNC dispatch work',
      cwd: '\\\\server\\share\\repo',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(uncWorker.workerConversationId).cwd, '\\\\server\\share\\repo')
    await kernel.waitForIdle(uncWorker.workerConversationId)

    // Remote node ID: `nodeId` passes through (existence handled at target resolution; pass-through tested here).
    const remoteWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'remote node dispatch work',
      nodeId: 'remote-node-1',
      cwd: 'C:\\remote\\workspace',
    })) as { workerConversationId: number }
    const remoteSummary = kernel.getConversation(remoteWorker.workerConversationId)
    assert.equal(remoteSummary.nodeId, 'remote-node-1')
    assert.equal(remoteSummary.cwd, 'C:\\remote\\workspace')
    await kernel.waitForIdle(remoteWorker.workerConversationId)
  } finally {
    await env.close()
  }
})

test('ownership6: dispatch_worker rejects invalid nodeId and relative cwd explicitly', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // Relative cwd passes schema minLength 1 but is rejected explicitly by `assertWorkerCwd`.
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'repo/app' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // Drive-relative path (`C:repo`) depends on process cwd and is likewise rejected.
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'C:repo' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // Whitespace, oversized, or separator-containing `nodeId` is rejected at schema layer (`assertWorkerNodeId` guards direct calls).
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', nodeId: 'a b' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /nodeId/.test(err.message),
    )
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', nodeId: 'a/b' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /nodeId/.test(err.message),
    )
  } finally {
    await env.close()
  }
})
