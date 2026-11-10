/**
 * 归属权投射 / 自举托管标记 / dispatch_worker 跨平台派工验收。
 *
 * 覆盖：
 * 1. ConversationSummary.ownedBy 实时投射：普通会话与 root #1 恒 human；
 *    superagent 启用后 router/watchdog 常驻会话与 dispatch_worker 派生的
 *    Worker 在 getConversation / listConversations 中 ownedBy === 'helm'；
 *    markConversationOwnership 变化时发布携带最新 ownedBy 的 conversation.upsert。
 * 2. managedByPlugin 自举：superagent/watchdog Profile 与 watchdog-playbooks
 *    Skill 新模板携带 'builtin:superagent' 标记与 humanSelectable=false；
 *    既有同名用户资产（无该字段）逐字节保留——不回填标记、不覆盖任何
 *    字段与文件（不做迁移），仅补齐缺失文件（partial-start）。
 * 3. dispatch_worker 支持 nodeId 与跨平台 cwd：POSIX 绝对路径、Windows 盘符
 *    （C:\\repo\\app / C:/repo/app）与 UNC 均可派工；相对路径显式拒绝；
 *    nodeId 透传到 Worker 会话镜像（nodeId === 'local' 显式传递）。
 *
 * 组合纪律：真实 createHelm（真 SQLite + 真 PluginHost）+ faux provider；
 * 诚实性纪律：失败如实抛出，不 skip、不吞。
 *
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁；命令加总超时。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'

import { HelmError, type HelmEventFrame } from '@helm/protocol'
import { createHelm } from '../src/app.js'

/** 初始会话 id（SDK 保留 #1 承载；普通会话语义，无产品级特权）。 */
const ROOT_CONVERSATION_ID = 1 as const

// ---------------------------------------------------------------------------
// 基建
// ---------------------------------------------------------------------------

interface TestEnv {
  dataDir: string
  faux: ReturnType<typeof fauxProvider>
  app: Awaited<ReturnType<typeof createHelm>>
  close(): Promise<void>
}

async function makeEnv(): Promise<TestEnv> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-ownership-'))
  const faux = fauxProvider()
  const models = createModels()
  models.setProvider(faux.provider)
  const app = await createHelm({ dataDir, cwd: dataDir, model: 'faux/faux-1', models, watchdogIntervalMs: 0 })
  faux.setResponses([fauxAssistantMessage('收到')])
  const env: TestEnv = {
    dataDir,
    faux,
    app,
    async close() {
      try {
        await app.close()
      } finally {
        rmSync(dataDir, { recursive: true, force: true })
      }
    },
  }
  return env
}

/** 等待谓词成立（轮询，默认 5s 超时）。 */
async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() > deadline) assert.fail('waitFor 超时：条件在限定时间内未成立')
    await new Promise((r) => setTimeout(r, 25))
  }
}

/** 从磁盘 index doc 读常驻会话 ID（doc flush 后直读 SQLite）。 */
async function residentIds(env: TestEnv): Promise<{ router?: number; watchdog?: number }> {
  await env.app.kernel.documentStore.flush()
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(env.dataDir, 'state.sqlite'), { readOnly: true })
  try {
    const row = db
      .prepare("SELECT value FROM helm_plugin_docs WHERE plugin_id = '__global' AND name = 'builtin:superagent:index'")
      .get() as { value: string } | undefined
    assert.ok(row, 'doc index 应已持久化')
    const doc = JSON.parse(row.value) as { routerConversationId?: number; watchdogConversationId?: number }
    return { router: doc.routerConversationId, watchdog: doc.watchdogConversationId }
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// 1. ownedBy 实时投射
// ---------------------------------------------------------------------------

test('ownership1: 普通会话与 root ownedBy=human；superagent 常驻/Worker ownedBy=helm', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    // root #1 与人类普通会话：缺省 human
    assert.equal(kernel.getConversation(ROOT_CONVERSATION_ID).ownedBy, 'human')
    const human = await kernel.createConversation({ title: '人类会话', profileId: 'assistant' })
    assert.equal(human.ownedBy, 'human')
    assert.equal(kernel.getConversation(human.id).ownedBy, 'human')
    const listBefore = kernel.listConversations()
    for (const s of listBefore) {
      if (s.id === human.id || s.id === ROOT_CONVERSATION_ID) assert.equal(s.ownedBy, 'human')
    }

    // 启用 superagent：router/watchdog 常驻会话 helm 归属
    await kernel.plugins.enable('builtin:superagent')
    const ids = await residentIds(env)
    assert.ok(ids.router, 'router 常驻会话应已分配')
    assert.ok(ids.watchdog, 'watchdog 常驻会话应已分配')
    assert.equal(kernel.getConversation(ids.router!).ownedBy, 'helm')
    assert.equal(kernel.getConversation(ids.watchdog!).ownedBy, 'helm')
    const listed = new Map(kernel.listConversations().map((s) => [s.id, s.ownedBy]))
    assert.equal(listed.get(ids.router!), 'helm')
    assert.equal(listed.get(ids.watchdog!), 'helm')
    assert.equal(listed.get(ROOT_CONVERSATION_ID), 'human')
    assert.equal(listed.get(human.id), 'human')

    // dispatch_worker 派生的 Worker：helm 归属（getConversation 与 list 双通道）
    const dispatched = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '归属验证任务',
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

test('ownership2: markConversationOwnership 变化发布携带最新 ownedBy 的 conversation.upsert', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    const kernel = env.app.kernel
    const frames: HelmEventFrame[] = []
    const off = kernel.events.subscribe((frame) => frames.push(frame))
    try {
      const conv = await kernel.createConversation({ title: '归属事件验证', profileId: 'assistant' })
      // 同值标记（human -> human）：不发布归属事件（幂等，无变化）。
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      assert.equal(
        frames.filter((f) => f.event.type === 'conversation.upsert').length,
        0,
        '同值标记不得发布事件',
      )
      // 变化标记（human -> helm）：发布携带 ownedBy=helm 的 upsert。
      kernel.markConversationOwnership(conv.id, 'helm')
      const upsert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(upsert, '归属变化应发布 conversation.upsert')
      assert.equal((upsert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'helm')
      assert.equal(kernel.getConversation(conv.id).ownedBy, 'helm')
      // 回退 human：再次发布且 ownedBy=human。
      frames.length = 0
      kernel.markConversationOwnership(conv.id, 'human')
      const revert = frames.find(
        (f) => f.event.type === 'conversation.upsert' && (f.event as { conversation?: { id?: number } }).conversation?.id === conv.id,
      )
      assert.ok(revert, '归属回退应发布 conversation.upsert')
      assert.equal((revert.event as { conversation?: { ownedBy?: string } }).conversation?.ownedBy, 'human')
    } finally {
      off()
    }
  } finally {
    await env.close()
  }
})

// ---------------------------------------------------------------------------
// 2. managedByPlugin 自举与旧资产回填
// ---------------------------------------------------------------------------

test('ownership3: 新自举资产携带 managedByPlugin=builtin:superagent 与 humanSelectable=false', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    // Profile：磁盘 profile.json 与 ProfileService 读取双通道
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
    // 新自举默认技能策略：中枢 skills=[]（禁用全部）；看门狗仅 watchdog-playbooks
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      [],
      '新自举 router Profile skills 应为空数组',
    )
    assert.deepEqual(
      (JSON.parse(readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8')) as { skills?: string[] }).skills,
      ['watchdog-playbooks'],
      '新自举 watchdog Profile skills 应仅含 watchdog-playbooks',
    )
    // 默认 assistant 由自身插件托管，不受 superagent 自举接管。
    assert.equal(profiles.find((p) => p.id === 'assistant')?.managedByPlugin, 'builtin:profile')
    assert.equal(profiles.find((p) => p.id === 'assistant')?.humanSelectable, undefined)
    // Skill：SKILL.md frontmatter 与 SkillService 读取双通道
    const skillMd = readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8')
    assert.match(skillMd, /^managedByPlugin: builtin:superagent$/m)
    const skills = await env.app.kernel.skills.list()
    assert.equal(skills.find((s) => s.id === 'watchdog-playbooks')?.managedByPlugin, 'builtin:superagent')
  } finally {
    await env.close()
  }
})

test('ownership4: 既有自定义 Profile/Skill 逐字节保留；仅补缺失文件；无迁移', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    // 预置用户自定义内容：superagent profile.json（用户改过 name/model，无
    // 托管标记）、SYSTEM.md/MEMORY.md 用户全文、SKILL.md 用户自定义 frontmatter
    // 与正文；references 目录留空（验证缺失补齐）；watchdog Profile 完全缺失。
    const profileJsonRaw =
      JSON.stringify({ id: 'superagent', name: '我的中枢', model: 'faux/faux-1' }, null, 2) + '\n'
    const systemMdRaw = '# 我的中枢提示\n'
    const memoryMdRaw = '# Memory\n\n用户记忆\n'
    const skillMdRaw = [
      '---',
      'name: watchdog-playbooks',
      'description: 我的自定义手册',
      '---',
      '',
      '# 我的手册正文',
      '',
    ].join('\n')
    mkdirSync(join(env.dataDir, 'profiles', 'superagent'), { recursive: true })
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), profileJsonRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), systemMdRaw)
    writeFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), memoryMdRaw)
    mkdirSync(join(env.dataDir, 'skills', 'watchdog-playbooks'), { recursive: true })
    writeFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), skillMdRaw)
    await env.app.kernel.plugins.enable('builtin:superagent')

    // 既有用户资产逐字节保留：不回填 managedByPlugin / humanSelectable，
    // 不改写 name/model，SYSTEM.md / MEMORY.md / SKILL.md 原样。
    assert.equal(
      readFileSync(join(env.dataDir, 'profiles', 'superagent', 'profile.json'), 'utf8'),
      profileJsonRaw,
      '既有 profile.json 必须逐字节保留（不回填托管标记）',
    )
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'SYSTEM.md'), 'utf8'), systemMdRaw)
    assert.equal(readFileSync(join(env.dataDir, 'profiles', 'superagent', 'MEMORY.md'), 'utf8'), memoryMdRaw)
    assert.equal(
      readFileSync(join(env.dataDir, 'skills', 'watchdog-playbooks', 'SKILL.md'), 'utf8'),
      skillMdRaw,
      '既有 SKILL.md 必须逐字节保留（不回插 frontmatter 标记行）',
    )
    // ProfileService 读取如实反映用户自定义形状（无托管标记、可选可选中）
    const userP = (await env.app.kernel.profiles.list()).find((p) => p.id === 'superagent')
    assert.equal(userP?.managedByPlugin, undefined)
    assert.equal(userP?.humanSelectable, undefined)
    assert.equal(userP?.name, '我的中枢')
    assert.equal(userP?.model, 'faux/faux-1')
    const userSkill = (await env.app.kernel.skills.list()).find((s) => s.id === 'watchdog-playbooks')
    assert.equal(userSkill?.managedByPlugin, undefined)
    assert.equal(userSkill?.description, '我的自定义手册')

    // partial-start：既有 SKILL.md 下缺失的 references 补齐，但不碰既有文件
    const herdrRef = readFileSync(
      join(env.dataDir, 'skills', 'watchdog-playbooks', 'references', 'herdr-stalled.md'),
      'utf8',
    )
    assert.match(herdrRef, /Herdr 终端窗格停滞处置/)
    // 全新写入的 watchdog Profile 携带新模板字段（managedByPlugin + humanSelectable=false）
    const watchdogJson = JSON.parse(
      readFileSync(join(env.dataDir, 'profiles', 'watchdog', 'profile.json'), 'utf8'),
    ) as { managedByPlugin?: string; humanSelectable?: boolean }
    assert.equal(watchdogJson.managedByPlugin, 'builtin:superagent')
    assert.equal(watchdogJson.humanSelectable, false)

    // 幂等：再次停用/启用仍逐字节不动既有资产
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
// 3. dispatch_worker：nodeId 与跨平台 cwd
// ---------------------------------------------------------------------------

test('ownership5: dispatch_worker 支持显式 nodeId 与跨平台 cwd（POSIX/盘符/UNC）', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // POSIX 绝对路径 + 显式 local 节点：cwd/nodeId 透传到 Worker 会话镜像
    const posixWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'POSIX 派工',
      nodeId: 'local',
      cwd: '/tmp/posix-worker',
    })) as { workerConversationId: number }
    const posixSummary = kernel.getConversation(posixWorker.workerConversationId)
    assert.equal(posixSummary.nodeId, 'local')
    assert.equal(posixSummary.cwd, '/tmp/posix-worker')
    await kernel.waitForIdle(posixWorker.workerConversationId)

    // Windows 盘符反斜杠：C:\repo\app
    const winWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows 派工',
      cwd: 'C:\\repo\\app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winWorker.workerConversationId).cwd, 'C:\\repo\\app')
    await kernel.waitForIdle(winWorker.workerConversationId)

    // Windows 盘符正斜杠：C:/repo/app
    const winFwdWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'Windows 正斜杠派工',
      cwd: 'C:/repo/app',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(winFwdWorker.workerConversationId).cwd, 'C:/repo/app')
    await kernel.waitForIdle(winFwdWorker.workerConversationId)

    // UNC 路径：\\server\share\repo
    const uncWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: 'UNC 派工',
      cwd: '\\\\server\\share\\repo',
    })) as { workerConversationId: number }
    assert.equal(kernel.getConversation(uncWorker.workerConversationId).cwd, '\\\\server\\share\\repo')
    await kernel.waitForIdle(uncWorker.workerConversationId)

    // 远端节点 ID：nodeId 透传（节点存在性由靶点解析链处理，此处验证透传）
    const remoteWorker = (await kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', {
      prompt: '远端节点派工',
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

test('ownership6: dispatch_worker 非法 nodeId / 相对 cwd 显式拒绝', { timeout: 60_000 }, async () => {
  const env = await makeEnv()
  try {
    await env.app.kernel.plugins.enable('builtin:superagent')
    const kernel = env.app.kernel

    // 相对路径 cwd：schema 层放行（minLength 1）但 assertWorkerCwd 显式拒绝
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'repo/app' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // 盘符相对路径（C:repo）：依赖进程 cwd 语义，同样拒绝
    await assert.rejects(
      () => kernel.plugins.invokeAction('builtin:superagent', 'dispatch_worker', { prompt: 'x', cwd: 'C:repo' }),
      (err: unknown) => err instanceof HelmError && err.code === 'validation_error' && /跨平台绝对路径/.test(err.message),
    )
    // 空白/超长/含路径分隔符的 nodeId：schema 层即拒绝（validatePluginInput
    // 先于 handler 执行；assertWorkerNodeId 为直调路径的第二道防线）
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
