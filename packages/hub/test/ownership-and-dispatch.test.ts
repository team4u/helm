/**
 * ownership right throw shoot / self raise hosting mark record / dispatch_worker across platform dispatch work verify.
 *
 * override:
 * 1. ConversationSummary.ownedBy real-time throw shoot: ordinary conversation and root #1 constant human;
 *    superagent enable after router/watchdog common resident conversation and dispatch_worker derive
 *    Worker in getConversation / listConversations in ownedBy === 'helm';
 *    markConversationOwnership change when publish carry most new ownedBy  conversation.upsert.
 * 2. managedByPlugin self raise:superagent/watchdog Profile and watchdog-playbooks
 *    Skill new template carry 'builtin:superagent' mark record and humanSelectable=false;
 *    since has same name user asset (without the field) one by one byte keep - - do not back fill mark record, does not override any
 *    field and file (does not migration), only patch complete missing file (partial-start).
 * 3. dispatch_worker support nodeId and across platform cwd:POSIX absolute path,Windows symbol
 *    (C:\\repo\\app / C:/repo/app) and UNC all can dispatch work; relative path explicit reject;
 *    nodeId pass-through to Worker conversation mirror (nodeId === 'local' explicit pass).
 *
 * combine discipline: real createHelm(true SQLite + true PluginHost)+ faux provider;
 * honest discipline: failed such as throw, do not skip, do not swallow.
 *
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock; command add total timeout.
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

/** initial conversation id(SDK keep #1 bear load; ordinary conversation semantics, without produce product level special right). */
const ROOT_CONVERSATION_ID = 1 as const

// ---------------------------------------------------------------------------
// base create
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

/** wait for say term into establish (polling, by default 5s timeout). */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  await waitForCondition(predicate, { timeoutMs, message: 'waitFor timeout: condition in limit set time inside not into establish' })
}

/** from disk index doc read common resident conversation ID(doc flush after direct read SQLite). */
async function residentIds(env: TestEnv): Promise<{ router?: number; watchdog?: number }> {
  await env.app.kernel.documentStore.flush()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(env.dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = 'builtin:superagent:index'")
      .get() as { value: string } | undefined
    assert.ok(row, 'doc index should persisted')
    const doc = JSON.parse(row.value) as { routerConversationId?: number; watchdogConversationId?: number }
    return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 1. ownedBy real-time throw shoot
// ---------------------------------------------------------------------------

test('ownership1: ordinary conversation and root ownedBy=human;superagent common resident/Worker ownedBy=helm', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // root #1 and person class ordinary conversation: default human
    assert.equal(kernel.getConversation(ROOT_CONVERSATION_ID).ownedBy, 'human')
    const human = await kernel.createConversation({ title: 'person class conversation', profileId: 'assistant' })
    assert.equal(human.ownedBy, 'human')
    assert.equal(kernel.getConversation(human.id).ownedBy, 'human')
    const listBefore = kernel.listConversations()
    for (const s of listBefore) {
      if (s.id === human.id || s.id === ROOT_CONVERSATION_ID) assert.equal(s.ownedBy, 'human')
    }

    // enable superagent:router/watchdog common resident conversation helm ownership
    await kernel.plugins.enable('builtin:superagent')
    const ids = await residentIds(env)
    assert.ok(ids.router, 'router common resident conversation should already allocate')
    assert.ok(ids.watchdog, 'watchdog common resident conversation should already allocate')
    assert.equal(kernel.getConversation(ids.router!).ownedBy, 'helm')
    assert.equal(kernel.getConversation(ids.watchdog!).ownedBy, 'helm')
    const listed = new Map(kernel.listConversations().map((s) => [s.id, s.ownedBy]))
    assert.equal(listed.get(ids.router!), 'helm')
    assert.equal(listed.get(ids.watchdog!), 'helm')
    assert.equal(listed.get(ROOT_CONVERSATION_ID), 'human')
    assert.equal(listed.get(human.id), 'human')

    // dispatch_worker derive Worker:helm ownership (getConversation and list double channel)
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

test('ownership2: markConversationOwnership change publish carry most new ownedBy  conversation.upsert', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const frames: HelmEventFrame[] = []
    const off = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      const conv = await kernel.createConversation({ title: 'ownership event verify', profileId: 'assistant' })
      // same value mark record (human -> human): do not publish ownership event (idempotent, without change).
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      assert.equal(
        frames.filter((f) => f.event.type === 'conversation.upsert').length,
        0,
        'same value mark record must not publish event',
      )
      // change mark record (human -> helm): publish carry ownedBy=helm  upsert.
      kernel.markConversationOwnership(conv.id, 'helm')
      const upsert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(upsert, 'ownership change should publish conversation.upsert')
      assert.equal((upsert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'helm')
      assert.equal(kernel.getConversation(conv.id).ownedBy, 'helm')
      // fall back human: again publish and ownedBy=human.
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      const revert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(revert, 'ownership fall back should publish conversation.upsert')
      assert.equal((revert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'human')
    } finally {
      off()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. managedByPlugin self raise and old asset back fill
// ---------------------------------------------------------------------------

test('ownership3: new self raise asset carry managedByPlugin=builtin:superagent and humanSelectable=false', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    // Profile: disk profile.json and ProfileService read double channel
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
    // new self raise by default skill policy: router hub skills=[](disable all); watchdog only watchdog-playbooks
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      [],
      'new self raise router Profile skills should be empty array',
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      ['watchdog-playbooks'],
      'new self raise watchdog Profile skills should only contains watchdog-playbooks',
    )
    // by default assistant by itself plugin hosting, do not subject to superagent self raise take over.
    assert.equal(profiles.find((p) => p.id === 'assistant')?.managedByPlugin, 'builtin:profile')
    assert.equal(profiles.find((p) => p.id === 'assistant')?.humanSelectable, undefined)
    // Skill:SKILL.md frontmatter and SkillService read double channel
    const skillMd = readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8')
    assert.match(skillMd, /^managedByPlugin: builtin:superagent$/m)
    const skills = await env.app.kernel.skills.list()
    assert.equal(skills.find((s) => s.id === 'watchdog-playbooks')?.managedByPlugin, 'builtin:superagent')
  } finally {
    await env.close()
  }
})

test('ownership4: since has self define Profile/Skill one by one byte keep; only patch missing file; without migration', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // pre- placement user self define content:superagent profile.json(user change name/model, without
    // hosting mark record),SYSTEM.md/MEMORY.md user all text,SKILL.md user self define frontmatter
    // and body text;references directory empty (verify missing patch complete);watchdog Profile fully missing.
    const profileJsonRaw =
      JSON.stringify({ id: 'superagent', name: 'I router hub', model: 'faux/faux-1' }, null, 2) + '\n'
    const systemMdRaw = '# I router hub hint\n'
    const memoryMdRaw = '# Memory\n\nuser memory\n'
    const skillMdRaw = [
      '---',
      'name: watchdog-playbooks',
      'description: I self define manual',
      '---',
      '',
      '# I manual body text',
      '',
    ].join('\n')
    mkdirSync(join(env.dataDir, 'profiles', 'superagent'), { recursive: true })
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), profileJsonRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), systemMdRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), memoryMdRaw)
    mkdirSync(join(env.dataDir, 'skills', 'watchdog-playbooks'), { recursive: true })
    writeFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), skillMdRaw)
    await env.app.kernel.plugins.enable('builtin:superagent')

    // since has user asset one by one byte keep: do not back fill managedByPlugin / humanSelectable,
    // do not change write name/model,SYSTEM.md / MEMORY.md / SKILL.md original.
    assert.equal(
      readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
      profileJsonRaw,
      'since has profile.json must one by one byte keep (do not back fill hosting mark record)',
    )
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), systemMdRaw)
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), 'utf8'), memoryMdRaw)
    assert.equal(
      readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'),
      skillMdRaw,
      'since has SKILL.md must one by one byte keep (do not back insert frontmatter mark record row)',
    )
    // ProfileService read such as reverse reflect user self define shape (without hosting mark record, optional optional in)
    const userP = (await env.app.kernel.profiles.list()).find((p) => p.id === 'superagent')
    assert.equal(userP?.managedByPlugin, undefined)
    assert.equal(userP?.humanSelectable, undefined)
    assert.equal(userP?.name, 'I router hub')
    assert.equal(userP?.model, 'faux/faux-1')
    const userSkill = (await env.app.kernel.skills.list()).find((s) => s.id === 'watchdog-playbooks')
    assert.equal(userSkill?.managedByPlugin, undefined)
    assert.equal(userSkill?.description, 'I self define manual')

    // partial-start: since has SKILL.md under missing references patch complete, but do not touch since has file
    const herdrRef = readFileSync(
      join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'herdr-stalled.md'),
      'utf8',
    )
    assert.match(herdrRef, /Handling Stalled Herdr Terminal Panes/)
    // all new write watchdog Profile carry new template field (managedByPlugin + humanSelectable=false)
    const watchdogJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; humanSelectable?: boolean }
    assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
    assert.equal(watchdogJson.humanSelectable, false)

    // idempotent: again deactivate/enable still one by one byte do not motion since has asset
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
// 3. dispatch_worker:nodeId and across platform cwd
// ---------------------------------------------------------------------------

test('ownership5: dispatch_worker support explicit nodeId and across platform cwd(POSIX/symbol/UNC)', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // POSIX absolute path + explicit local node:cwd/nodeId pass-through to Worker conversation mirror
    const posixWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'POSIX dispatch work',
      nodeId: 'local',
      cwd: '/tmp/posix-worker',
    })) as { workerConversationId: number }
    const posixSummary = kernel.getConversation(posixWorker.workerConversationId)
    assert.equal(posixSummary.nodeId, 'local')
    assert.equal(posixSummary.cwd, '/tmp/posix-worker')
    await kernel.waitForIdle(posixWorker.workerConversationId)

    // Windows symbol backslash:C:\repo\app
    const winWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows dispatch work',
      cwd: 'C:\\repo\\app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winWorker.workerConversationId).cwd, 'C:\\repo\\app')
    await kernel.waitForIdle(winWorker.workerConversationId)

    // Windows symbol correct slash:C:/repo/app
    const winFwdWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows correct slash dispatch work',
      cwd: 'C:/repo/app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winFwdWorker.workerConversationId).cwd, 'C:/repo/app')
    await kernel.waitForIdle(winFwdWorker.workerConversationId)

    // UNC path:\\server\share\repo
    const uncWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'UNC dispatch work',
      cwd: '\\\\server\\share\\repo',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(uncWorker.workerConversationId).cwd, '\\\\server\\share\\repo')
    await kernel.waitForIdle(uncWorker.workerConversationId)

    // remote node ID:nodeId pass-through (node store in by target parse chain handle, this where verify pass-through)
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

test('ownership6: dispatch_worker illegal nodeId / each other for cwd explicit reject', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // relative path cwd:schema layer let through (minLength 1) but assertWorkerCwd explicit reject
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'repo/app' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // symbol relative path (C:repo): dependency process cwd semantics, same reject
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'C:repo' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // whitespace/over long/contains path isolate symbol nodeId:schema layer i.e. reject (validatePluginInput
    // first at handler execute;assertWorkerNodeId is direct tune path second path guard against line)
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
