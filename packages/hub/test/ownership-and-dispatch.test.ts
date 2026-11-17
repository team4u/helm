/**
 * 归属权实时投射、受管自举资产与 dispatch_worker 跨平台派工集成验证（共享主实例 + 用户既有资产独立实例）。
 */
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { HelmError, type HelmEventFrame } from '@helm/protocol'
import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, before, test } from 'node:test'
import { openHubTestEnv, type HubTestEnv } from './helpers/hub-test-env.js'

const ROOT_CONVERSATION_ID = 1 as const

let env: HubTestEnv

before(async () => {
  env = await openHubTestEnv({ prefix: 'helm-ownership-' })
})

after(async () => {
  await env?.close()
})

async function residentIds(target: HubTestEnv): Promise<{ router?: number; watchdog?: number }> {
  await target.kernel.documentStore.flush()
  const db = new DatabaseSync(join(target.dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = 'builtin:superagent:index'")
      .get() as { value: string } | undefined
    assert.ok(row)
    const doc = JSON.parse(row.value) as { routerConversationId?: number; watchdogConversationId?: number }
    return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
  } finally {
    db.close()
  }
}

test('ownedBy 实时投射与事件广播、superagent 新自举资产标记及 dispatch_worker 跨平台派工与参数校验', { timeout: 60_000 }, async () => {
  const { kernel } = env

  // 1. 普通会话与初始 #1 恒为 human；markConversationOwnership 幂等与变更广播
  assert.equal(kernel.getConversation(ROOT_CONVERSATION_ID).ownedBy, 'human')
  const human = await kernel.createConversation({ title: 'human conversation', profileId: 'assistant' })
  assert.equal(human.ownedBy, 'human')

  const frames: HelmEventFrame[] = []
  const off = kernel.events.subscribe((frame) => frames.push(frame))
  try {
    frames.length = 0
    kernel.markConversationOwnership(human.id, 'human')
    assert.equal(frames.filter((f) => f.event.type === 'conversation.upsert').length, 0)

    kernel.markConversationOwnership(human.id, 'helm')
    const upsert = frames.find(
      (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === human.id,
    )
    assert.equal((upsert?.event as { conversation?: { ownedBy?: string } })?.conversation?.ownedBy, 'helm')
    assert.equal(kernel.getConversation(human.id).ownedBy, 'helm')

    frames.length = 0
    kernel.markConversationOwnership(human.id, 'human')
    const revert = frames.find(
      (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === human.id,
    )
    assert.equal((revert?.event as { conversation?: { ownedBy?: string } })?.conversation?.ownedBy, 'human')
  } finally {
    off()
  }

  // 2. 启用 builtin:superagent：常驻 router/watchdog 为 helm，新自举 Profile/Skill 携带受管标记
  await kernel.plugins.enable('builtin:superagent')
  const ids = await residentIds(env)
  assert.ok(ids.router && ids.watchdog)
  assert.equal(kernel.getConversation(ids.router).ownedBy, 'helm')
  assert.equal(kernel.getConversation(ids.watchdog).ownedBy, 'helm')
  const listed = new Map(kernel.listConversations().map((s) => [s.id, s.ownedBy]))
  assert.equal(listed.get(ids.router), 'helm')
  assert.equal(listed.get(ids.watchdog), 'helm')
  assert.equal(listed.get(ROOT_CONVERSATION_ID), 'human')

  const superagentJson = JSON.parse(
    readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
  ) as { managedByPlugin?: string; humanSelectable?: boolean; skills?: string[] }
  assert.equal(superagentJson.managedByPlugin, 'builtin:superagent')
  assert.equal(superagentJson.humanSelectable, false)
  assert.deepEqual(superagentJson.skills, [])

  const watchdogJson = JSON.parse(
    readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8'),
  ) as { managedByPlugin?: string; humanSelectable?: boolean; skills?: string[] }
  assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
  assert.equal(watchdogJson.humanSelectable, false)
  assert.deepEqual(watchdogJson.skills, ['watchdog-playbooks'])

  const profiles = await kernel.profiles.list()
  assert.equal(profiles.find((p) => p.id === 'assistant')?.managedByPlugin, 'builtin:profile')
  assert.equal(profiles.find((p) => p.id === 'assistant')?.humanSelectable, undefined)
  assert.match(readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'), /^managedByPlugin: builtin:superagent$/m)
  assert.equal((await kernel.skills.list()).find((s) => s.id === 'watchdog-playbooks')?.managedByPlugin, 'builtin:superagent')

  // 3. dispatch_worker 归属权（helm）、显式 nodeId 与跨平台 cwd（POSIX / 盘符反斜杠与正斜杠 / UNC / 远端节点）
  env.faux.setResponses(Array.from({ length: 12 }, () => fauxAssistantMessage('receives')))
  for (const c of [
    { input: { prompt: 'ownership verify task' }, expectNode: 'local' },
    { input: { prompt: 'POSIX', nodeId: 'local', cwd: '/tmp/posix-worker' }, expectNode: 'local', expectCwd: '/tmp/posix-worker' },
    { input: { prompt: 'Win', cwd: 'C:\\repo\\app' }, expectCwd: 'C:\\repo\\app' },
    { input: { prompt: 'WinFwd', cwd: 'C:/repo/app' }, expectCwd: 'C:/repo/app' },
    { input: { prompt: 'UNC', cwd: '\\\\server\\share\\repo' }, expectCwd: '\\\\server\\share\\repo' },
    { input: { prompt: 'Remote', nodeId: 'remote-node-1', cwd: 'C:\\remote\\workspace' }, expectNode: 'remote-node-1', expectCwd: 'C:\\remote\\workspace' },
  ]) {
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', c.input)) as {
      workerConversationId: number
    }
    const summary = kernel.getConversation(dispatched.workerConversationId)
    assert.equal(summary.ownedBy, 'helm')
    if (c.expectNode !== undefined) assert.equal(summary.nodeId, c.expectNode)
    if (c.expectCwd !== undefined) assert.equal(summary.cwd, c.expectCwd)
    await kernel.waitForIdle(dispatched.workerConversationId)
  }

  // 4. 非法相对 cwd 与非法 nodeId 显式拒绝
  for (const badCwd of ['repo/app', 'C:repo']) {
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: badCwd }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
  }
  for (const badNodeId of ['a b', 'a/b']) {
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', nodeId: badNodeId }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /nodeId/.test(err.message),
    )
  }
})

test('既有自定义 Profile/Skill 逐字节保持且仅补齐缺失文件（partial-start 幂等，零迁移回填）', { timeout: 60_000 }, async () => {
  const custom = await openHubTestEnv({ prefix: 'helm-ownership-custom-' })
  try {
    const profileJsonRaw = JSON.stringify({ id: 'superagent', name: 'I router hub', model: 'faux/faux-1' }, null, 2) + '\n'
    const systemMdRaw = '# I router hub hint\n'
    const memoryMdRaw = '# Memory\n\nuser memory\n'
    const skillMdRaw = ['---', 'name: watchdog-playbooks', 'description: I self define manual', '---', '', '# I manual body text', ''].join('\n')

    mkdirSync(join(custom.dataDir, 'profiles', 'superagent'), { recursive: true })
    writeFileSync(join(custom.dataDir, 'profiles', 'superagent', 'profile.json'), profileJsonRaw)
    writeFileSync(join(custom.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), systemMdRaw)
    writeFileSync(join(custom.dataDir, 'profiles', 'superagent', 'MEMORY.md'), memoryMdRaw)
    mkdirSync(join(custom.dataDir, 'skills', 'watchdog-playbooks'), { recursive: true })
    writeFileSync(join(custom.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), skillMdRaw)

    await custom.kernel.plugins.enable('builtin:superagent')
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'), profileJsonRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), systemMdRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'superagent', 'MEMORY.md'), 'utf8'), memoryMdRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'), skillMdRaw)

    const userP = (await custom.kernel.profiles.list()).find((p) => p.id === 'superagent')
    assert.equal(userP?.managedByPlugin, undefined)
    assert.equal(userP?.humanSelectable, undefined)
    assert.equal(userP?.name, 'I router hub')
    assert.equal((await custom.kernel.skills.list()).find((s) => s.id === 'watchdog-playbooks')?.managedByPlugin, undefined)

    assert.match(
      readFileSync(join(custom.dataDir, 'skills', 'watchdog-playbooks', 'references', 'herdr-stalled.md'), 'utf8'),
      /Handling Stalled Herdr Terminal Panes/,
    )
    const watchdogJson = JSON.parse(readFileSync(join(custom.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8')) as {
      managedByPlugin?: string
      humanSelectable?: boolean
    }
    assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
    assert.equal(watchdogJson.humanSelectable, false)

    await custom.kernel.plugins.disable('builtin:superagent')
    await custom.kernel.plugins.enable('builtin:superagent')
    assert.equal(readFileSync(join(custom.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'), profileJsonRaw)
    assert.equal(readFileSync(join(custom.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'), skillMdRaw)
  } finally {
    await custom.close()
  }
})
