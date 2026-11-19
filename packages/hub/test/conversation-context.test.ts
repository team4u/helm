/**
 * 会话上下文、跨平台 cwd 收口与多模态附件端到端集成测试（共享单实例 createHelmx + startHub）：
 * - 上下文操作：reset（handoff / 空重置 / 404）、compact（taskId / 404）、fork（继承链 / 标题 / 404 / 400）、
 *   withdraw（排队撤回 / 二次 settled / 404）及对应 HTTP 路由契约（含 replaceFromEntryId HTTP 透传）；
 * - cwd 平台收口：create / update 按目标节点可信平台（NodeRegistry WS 注册 win32 / 未知平台 / 本机）确定性归一与拒绝；
 * - 多模态附件：本会话/父会话授权、跨会话 403、缺失 404、SQLite 零 base64 膨胀、图片多模态块、input hook 改写复核与 spawnAgent 附件注入。
 */
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage, type FauxResponseStep } from '@earendil-works/pi-ai/providers/faux'
import type { Harness } from '@earendil-works/pi-durable'
import {
  HelmxError,
  type NodeRegisterInput,
  type NodeRegisterResult,
  type PluginDefinition,
} from '@helmx/protocol'
import { createBirpc } from 'birpc'
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import WebSocket from 'ws'
import type { HubConnectionLocal, NodeConnection } from '../../kernel/src/env/index.js'
import {
  messageTextsOf,
  openHubHttpEnv,
  sdkEntrySummaries,
  waitFor,
  type HubHttpTestEnv,
} from './helpers/hub-test-env.js'

let env: HubHttpTestEnv
const nodeClosers: Array<() => void> = []

/** 原始 WS 节点注册（可控平台上报，不掺杂真实 daemon 环境副作用）。 */
async function registerFakeNode(
  hubUrl: string,
  nodeId: string,
  token: string,
  platform: string,
): Promise<() => void> {
  const ws = new WebSocket(`${hubUrl.replace(/^http/, 'ws')}/ws/node?nodeId=${nodeId}`)
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  const rpc = createBirpc<
    { register(input: NodeRegisterInput): Promise<NodeRegisterResult> },
    HubConnectionLocal
  >(
    { onEnvExecOutput: () => undefined, onIpcEvent: () => undefined, onIpcClosed: () => undefined },
    {
      post: (data) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data))
      },
      on: (cb) => {
        ws.on('message', (raw) => {
          try {
            cb(JSON.parse(typeof raw === 'string' ? raw : Buffer.from(raw as ArrayBuffer).toString('utf8')) as never)
          } catch {
            /* 忽略非 JSON 帧 */
          }
        })
      },
      serialize: (d) => d,
      deserialize: (d) => d as never,
      timeout: 10_000,
    },
  )
  const outcome = await rpc.register({ nodeId, token, hostname: 'fake', platform })
  assert.ok(outcome.ok, `fake node register failed: ${JSON.stringify(outcome)}`)
  return () => {
    try {
      rpc.$close()
    } catch {
      /* 已关闭 */
    }
    ws.close()
  }
}

before(async () => {
  env = await openHubHttpEnv({
    prefix: 'helmx-conv-ctx-',
    swallowCloseError: true,
    hubPlatform: () => 'linux',
  })
  const winIssued = await env.kernel.nodes.issueNodeToken('win-build')
  nodeClosers.push(await registerFakeNode(env.hubUrl, 'win-build', winIssued.token, 'win32'))
  const silentIssued = await env.kernel.nodes.issueNodeToken('silent-node')
  nodeClosers.push(await registerFakeNode(env.hubUrl, 'silent-node', silentIssued.token, ''))
}, { timeout: 60_000 })

after(async () => {
  for (const close of nodeClosers) close()
  await env?.close()
}, { timeout: 60_000 })

function harnessOf(): Harness {
  return (env.kernel as unknown as { harness: Harness }).harness
}

/** 1x1 PNG 合法图片字节。 */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
])

async function uploadArtifact(
  conversationId: number,
  name: string,
  bytes: Uint8Array,
  mimeType?: string,
): Promise<string> {
  const meta = await env.kernel.artifacts.writeUploaded(conversationId, {
    name,
    bytes,
    ...(mimeType !== undefined ? { mimeType } : {}),
  })
  return meta.id
}

// ---------------------------------------------------------------------------
// 1. reset / compact / fork
// ---------------------------------------------------------------------------

test('reset：清空上下文、handoff 进入新上下文、seq 推进并广播；空 handoff 合法；未知会话 404', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('one round answer')])
  const conv = await env.kernel.createConversation({ title: 'reset test' })
  await env.kernel.submitInput(conv.id, 'one round issue')
  await env.kernel.waitForIdle(conv.id)
  const beforeSummary = env.kernel.getConversation(conv.id)

  const events: unknown[] = []
  const unsubscribe = env.kernel.events.subscribe((frame) => {
    if (frame.event.type === 'conversation.upsert') events.push(frame)
  })
  try {
    const afterSummary = await env.kernel.resetConversation(conv.id, { handoff: 'reset after handover note' })
    await env.kernel.waitForIdle(conv.id)
    assert.ok(afterSummary.stateChangeSeq > beforeSummary.stateChangeSeq)
    assert.ok(events.length > 0)
  } finally {
    unsubscribe()
  }

  const detail = await env.kernel.getConversationDetail(conv.id)
  const resetEntry = detail.entries.find((e) => e.kind === 'pi.reset')
  assert.ok(resetEntry !== undefined)
  const userContent = (resetEntry.model ?? []).map((m) => (m as { content?: unknown }).content)
  assert.ok(
    userContent.some((c) =>
      typeof c === 'string' ? c === 'reset after handover note' : JSON.stringify(c).includes('reset after handover note'),
    ),
  )

  const emptyConv = await env.kernel.createConversation({ title: 'empty reset' })
  assert.equal((await env.kernel.resetConversation(emptyConv.id)).id, emptyConv.id)
  await assert.rejects(
    env.kernel.resetConversation(999999),
    (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
  )
})

test('compact：返回后台任务 ID 并进入 SDK 调度；未知会话 404', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('ordinary answer one')])
  const conv = await env.kernel.createConversation({ title: 'compress test' })
  await env.kernel.submitInput(conv.id, 'one segment enough long dialog content 1')
  await env.kernel.waitForIdle(conv.id)

  const { taskId, conversation } = await env.kernel.compactConversation(conv.id, {
    instructions: 'please sudden out key decide policy',
  })
  assert.ok(Number.isInteger(taskId) && taskId > 0)
  assert.equal(conversation.id, conv.id)
  assert.ok(conversation.stateChangeSeq >= 1)

  await assert.rejects(
    env.kernel.compactConversation(424242),
    (err: unknown) => err instanceof HelmxError && err.status === 404,
  )
})

test('fork：从既有条目或省略 entryId 干净锚点分叉（继承父链/profile/cwd/model、默认与自定义标题）及 409/404/400 边界', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('source conversation answer')])
  const source = await env.kernel.createConversation({ title: 'source conversation' })
  await env.kernel.submitInput(source.id, 'source conversation one question')
  await env.kernel.waitForIdle(source.id)
  const detail = await env.kernel.getConversationDetail(source.id)
  const entryId = Number(detail.entries[0]!.id)

  const forked = await env.kernel.forkConversation(source.id, { entryId })
  assert.notEqual(forked.id, source.id)
  assert.equal(forked.parentConversationId, source.id)
  assert.equal(forked.title, 'source conversation (fork)')
  assert.equal(forked.profileId, source.profileId)
  assert.equal(forked.cwd, source.cwd)
  assert.equal(forked.model, source.model)

  const forked2 = await env.kernel.forkConversation(source.id, { entryId, title: '  self define title  ' })
  assert.equal(forked2.title, 'self define title')

  const cleanForked = await env.kernel.forkConversation(source.id)
  assert.notEqual(cleanForked.id, source.id)
  assert.equal(cleanForked.parentConversationId, source.id)
  assert.equal(cleanForked.title, 'source conversation (fork)')
  assert.equal(cleanForked.profileId, source.profileId)
  assert.equal(cleanForked.cwd, source.cwd)
  assert.equal(cleanForked.model, source.model)

  const cleanForkedTitled = await env.kernel.forkConversation(source.id, { title: '  clean title  ' })
  assert.equal(cleanForkedTitled.title, 'clean title')

  const emptyConv = await env.kernel.createConversation({ title: 'empty source' })
  await assert.rejects(
    env.kernel.forkConversation(emptyConv.id),
    (err: unknown) => err instanceof HelmxError && err.status === 409 && err.code === 'fork_empty_history',
  )
  await assert.rejects(
    env.kernel.forkConversation(emptyConv.id, { entryId: 99999 }),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.status === 404 && err.code === 'not_found')
      const details = err.details as { conversationId: number; entryId: number }
      assert.equal(details.conversationId, emptyConv.id)
      assert.equal(details.entryId, 99999)
      return true
    },
  )
  await assert.rejects(
    env.kernel.forkConversation(emptyConv.id, { entryId: -1 }),
    (err: unknown) => err instanceof HelmxError && err.status === 400 && err.code === 'validation_error',
  )
  await assert.rejects(
    env.kernel.forkConversation(777777, { entryId: 1 }),
    (err: unknown) => err instanceof HelmxError && err.status === 404,
  )
  await assert.rejects(
    env.kernel.forkConversation(777777),
    (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
  )
})

// ---------------------------------------------------------------------------
// 2. withdraw 与 HTTP 上下文路由契约（含 replaceFromEntryId HTTP 透传）
// ---------------------------------------------------------------------------

test('withdraw：忙碌会话排队 followUp 可撤回并从 queuedInputs 消失且不执行，二次撤回返回 settled', { timeout: 60_000 }, async () => {
  let releaseFirst: (() => void) | undefined
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
  try {
    env.faux.setResponses([
      (async () => {
        await firstGate
        return fauxAssistantMessage('first question answer')
      }) as never,
      fauxAssistantMessage('queue up input answer'),
    ])

    const conv = await env.kernel.createConversation({ title: 'withdraw back queue up' })
    await env.kernel.submitInput(conv.id, 'first question')
    await waitFor(
      () => (env.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(conv.id),
      { timeoutMs: 10_000 },
    )

    const queued = await env.kernel.submitInput(conv.id, 'queue up in input', { whenBusy: 'followUp' })
    const submissionId = Number(queued.submissionId)
    const snap1 = env.kernel.events.currentSnapshot()
    assert.ok(
      snap1.conversationLives?.find((l) => l.conversationId === conv.id)?.queuedInputs?.some((q) => q.submissionId === queued.submissionId),
    )

    assert.deepEqual(await env.kernel.withdrawQueuedInput(conv.id, { submissionId }), { status: 'withdrawn' })
    const snap2 = env.kernel.events.currentSnapshot()
    assert.equal(
      snap2.conversationLives?.find((l) => l.conversationId === conv.id)?.queuedInputs?.some((q) => q.submissionId === queued.submissionId) ?? false,
      false,
    )

    releaseFirst?.()
    await env.kernel.waitForIdle(conv.id)
    const sdkConv = await harnessOf().conversation(conv.id as never, BACKGROUND_CONTEXT)
    const texts = messageTextsOf((await sdkConv!.context(BACKGROUND_CONTEXT)).messages as never)
    assert.ok(!texts.some((t) => t.includes('queue up in input')))
    assert.ok(texts.some((t) => t.includes('first question answer')))

    assert.equal((await env.kernel.withdrawQueuedInput(conv.id, { submissionId })).status, 'settled')
    await assert.rejects(
      env.kernel.withdrawQueuedInput(conv.id, { submissionId: 999999 }),
      (err: unknown) => err instanceof HelmxError && err.status === 404 && err.code === 'not_found',
    )
  } finally {
    releaseFirst?.()
  }
})

test('HTTP 上下文路由：reset / compact / fork / replaceFromEntryId / withdraw 状态码与错误信封', { timeout: 60_000 }, async () => {
  env.faux.setResponses([fauxAssistantMessage('http path answer')])
  const conv = await env.kernel.createConversation({ title: 'HTTP context' })
  await env.kernel.submitInput(conv.id, 'http path one question')
  await env.kernel.waitForIdle(conv.id)
  const entryId = Number((await env.kernel.getConversationDetail(conv.id)).entries[0]!.id)

  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/reset`)).status, 200)
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/reset`, { handoff: 'second time reset' })).status, 200)

  const compact = await env.call('POST', `/api/conversations/${conv.id}/compact`, { instructions: 'http compress instruction' })
  assert.equal(compact.status, 202)
  assert.ok(Number.isInteger(compact.body.taskId) && compact.body.taskId > 0)

  const fork = await env.call('POST', `/api/conversations/${conv.id}/fork`, { entryId, title: 'HTTP fork' })
  assert.equal(fork.status, 201)
  assert.equal(fork.body.title, 'HTTP fork')
  assert.equal(fork.body.parentConversationId, conv.id)
  const forkClean = await env.call('POST', `/api/conversations/${conv.id}/fork`, {})
  assert.equal(forkClean.status, 201)
  assert.equal(forkClean.body.title, 'HTTP context (fork)')
  assert.equal(forkClean.body.parentConversationId, conv.id)
  const forkNoBody = await env.call('POST', `/api/conversations/${conv.id}/fork`)
  assert.equal(forkNoBody.status, 201)
  assert.equal(forkNoBody.body.parentConversationId, conv.id)
  const emptyHttpConv = await env.kernel.createConversation({ title: 'HTTP empty fork' })
  const forkEmpty = await env.call('POST', `/api/conversations/${emptyHttpConv.id}/fork`, {})
  assert.equal(forkEmpty.status, 409)
  assert.equal(forkEmpty.body.error.code, 'fork_empty_history')
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/fork`, { entryId: 987654 })).status, 404)
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/fork`, { entryId: 0 })).status, 400)
  assert.equal((await env.call('POST', `/api/conversations/${conv.id}/fork`, { entryId: Number.MAX_SAFE_INTEGER + 1 })).status, 400)
  assert.equal((await env.call('POST', '/api/conversations/888888/reset')).status, 404)

  // replaceFromEntryId HTTP 透传与边界
  env.faux.setResponses([fauxAssistantMessage('http heavy a1'), fauxAssistantMessage('http heavy a2')])
  const rwConv = await env.kernel.createConversation({ title: 'HTTP heavy' })
  await env.kernel.submitInput(rwConv.id, 'http issue')
  await env.kernel.waitForIdle(rwConv.id)
  const rwInput = (await sdkEntrySummaries(env.kernel, rwConv.id)).find((e) => e.kind === 'helmx.input' && e.text === 'http issue')!
  assert.equal(
    (await env.call('POST', `/api/conversations/${rwConv.id}/input`, { text: 'http override heavy', replaceFromEntryId: rwInput.id })).status,
    202,
  )
  await env.kernel.waitForIdle(rwConv.id)
  const rwTexts = messageTextsOf((await (await harnessOf().conversation(rwConv.id as never, BACKGROUND_CONTEXT))!.context(BACKGROUND_CONTEXT)).messages as never)
  assert.ok(!rwTexts.some((t) => t.includes('http issue')) && rwTexts.some((t) => t.includes('http override heavy')))
  assert.equal((await env.call('POST', `/api/conversations/${rwConv.id}/input`, { text: 'x', replaceFromEntryId: 0 })).status, 400)
  assert.equal((await env.call('POST', `/api/conversations/${rwConv.id}/input`, { text: 'x', replaceFromEntryId: 888888 })).status, 404)

  // withdraw HTTP 路由与边界
  let release: (() => void) | undefined
  const gate = new Promise<void>((resolve) => { release = resolve })
  try {
    env.faux.setResponses([(async () => { await gate; return fauxAssistantMessage('http withdraw answer') }) as never])
    const wConv = await env.kernel.createConversation({ title: 'HTTP withdraw' })
    await env.kernel.submitInput(wConv.id, 'http withdraw first')
    await waitFor(
      () => (env.kernel as unknown as { tracker: { hasLiveWork(id: number): boolean } }).tracker.hasLiveWork(wConv.id),
      { timeoutMs: 10_000 },
    )
    const queued = await env.kernel.submitInput(wConv.id, 'http queued', { whenBusy: 'followUp' })
    const ok = await env.call('POST', `/api/conversations/${wConv.id}/withdraw`, { submissionId: Number(queued.submissionId) })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body, { status: 'withdrawn' })
    assert.equal((await env.call('POST', `/api/conversations/${wConv.id}/withdraw`, { submissionId: 0 })).status, 400)
    assert.equal((await env.call('POST', `/api/conversations/${wConv.id}/withdraw`, { submissionId: 1, bogus: 1 })).status, 400)
    assert.equal((await env.call('POST', `/api/conversations/${wConv.id}/withdraw`, { submissionId: 987654 })).status, 404)
    assert.equal((await env.call('POST', '/api/conversations/777777/withdraw', { submissionId: 1 })).status, 404)
    release?.()
    await env.kernel.waitForIdle(wConv.id)
  } finally {
    release?.()
  }
})

// ---------------------------------------------------------------------------
// 3. 会话 create/update cwd 按目标节点平台统一收口（原 conversation-cwd-normalize.test.ts）
// ---------------------------------------------------------------------------

test('cwd 收口（create）：相对路径拒绝不入库；本机归一；远端 win32 转换与坏 POSIX 根拒绝；未知平台透传', { timeout: 60_000 }, async () => {
  const beforeCount = env.kernel.listConversations().length
  for (const bad of ['relative/ws', './x', 'C:relative']) {
    await assert.rejects(
      env.kernel.createConversation({ cwd: bad }),
      (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
    )
  }
  assert.equal(env.kernel.listConversations().length, beforeCount)

  const localConv = await env.kernel.createConversation({ cwd: '/tmp/helmx/a/./b/../c' })
  assert.equal(localConv.cwd, '/tmp/helmx/a/c')
  assert.equal(env.kernel.getConversation(localConv.id).cwd, '/tmp/helmx/a/c')

  const conn: NodeConnection | undefined = env.kernel.envFabric.registry.get('win-build')
  assert.equal(conn?.platform, 'win32')
  const wsl = await env.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/work/helmx' })
  assert.equal(wsl.cwd, 'C:\\work\\helmx')
  const drive = await env.kernel.createConversation({ nodeId: 'win-build', cwd: '/e/git/repo' })
  assert.equal(drive.cwd, 'E:\\git\\repo')

  const countBeforeWinReject = env.kernel.listConversations().length
  for (const bad of ['/home/user', '/tmp/build']) {
    await assert.rejects(
      env.kernel.createConversation({ nodeId: 'win-build', cwd: bad }),
      (e: unknown) => e instanceof HelmxError && e.code === 'unmappable_posix_root',
    )
  }
  assert.equal(env.kernel.listConversations().length, countBeforeWinReject)

  const silent = await env.kernel.createConversation({ nodeId: 'silent-node', cwd: '/home/user/project' })
  assert.equal(silent.cwd, '/home/user/project')
})

test('cwd 收口（update）：显式 cwd 修改、仅迁移 nodeId 与仅改标题均按契约收口', { timeout: 60_000 }, async () => {
  const conv = await env.kernel.createConversation({ nodeId: 'win-build', cwd: '/mnt/c/first' })
  assert.equal(conv.cwd, 'C:\\first')

  const updated = await env.kernel.updateConversation(conv.id, { cwd: '/c/second/third/../x' })
  assert.equal(updated.cwd, 'C:\\second\\x')

  await assert.rejects(
    env.kernel.updateConversation(conv.id, { cwd: '/home/nope' }),
    (e: unknown) => e instanceof HelmxError && e.code === 'unmappable_posix_root',
  )
  await assert.rejects(
    env.kernel.updateConversation(conv.id, { cwd: 'relative' }),
    (e: unknown) => e instanceof HelmxError && e.code === 'validation_error',
  )

  const migrated = await env.kernel.createConversation({ cwd: '/mnt/c/keep-me' })
  assert.equal(migrated.cwd, '/mnt/c/keep-me')
  const afterNodeMove = await env.kernel.updateConversation(migrated.id, { nodeId: 'win-build' })
  assert.equal(afterNodeMove.nodeId, 'win-build')
  assert.equal(afterNodeMove.cwd, 'C:\\keep-me')

  const localKeep = await env.kernel.createConversation({ cwd: '/tmp/helmx/keep-me' })
  const renamed = await env.kernel.updateConversation(localKeep.id, { title: 'change name' })
  assert.equal(renamed.cwd, '/tmp/helmx/keep-me')
})

// ---------------------------------------------------------------------------
// 4. 多模态输入附件（原 input-attachments.test.ts）
// ---------------------------------------------------------------------------

test('附件授权：本会话与父会话允许挂载、跨会话越权 403、不存在 404、重复 ID 去重', { timeout: 60_000 }, async () => {
  const parent = await env.kernel.createConversation({ title: 'parent conversation' })
  const child = await env.kernel.createConversation({ title: 'sub-conversation', parentConversationId: parent.id })
  const other = await env.kernel.createConversation({ title: 'without closure conversation' })

  const ownId = await uploadArtifact(child.id, 'own.txt', new TextEncoder().encode('own'))
  const parentId = await uploadArtifact(parent.id, 'parent.md', new TextEncoder().encode('parent'))
  const otherId = await uploadArtifact(other.id, 'other.txt', new TextEncoder().encode('other'))

  const own = await env.kernel.resolveAuthorizedAttachments(child.id, [ownId])
  assert.equal(own.length, 1)
  assert.equal(own[0]!.ref.name, 'own.txt')
  assert.equal(own[0]!.ref.size, 3)
  assert.ok(own[0]!.absPath.startsWith(env.dataDir))

  const viaParent = await env.kernel.resolveAuthorizedAttachments(child.id, [parentId])
  assert.equal(viaParent[0]!.metadata.conversationId, parent.id)

  await assert.rejects(
    env.kernel.resolveAuthorizedAttachments(child.id, [otherId]),
    (err: unknown) => {
      assert.ok(err instanceof HelmxError && err.code === 'artifact_forbidden' && err.status === 403)
      const details = err.details as { conversationId: number; artifactConversationId: number }
      assert.equal(details.conversationId, child.id)
      assert.equal(details.artifactConversationId, other.id)
      return true
    },
  )
  await assert.rejects(
    env.kernel.resolveAuthorizedAttachments(child.id, ['no-such-artifact-id']),
    (err: unknown) => err instanceof HelmxError && err.code === 'not_found' && err.status === 404,
  )
  assert.equal((await env.kernel.resolveAuthorizedAttachments(child.id, [ownId, ownId])).length, 1)
})

test('submitInput 附件：纯文本清单与 SQLite 零 base64 膨胀；图片多模态块；越权与 hook 改写复核', { timeout: 60_000 }, async () => {
  const captured: unknown[] = []
  const captureStep: FauxResponseStep = (context) => {
    const users = context.messages.filter((m) => m.role === 'user').map((m) => (m as { content: unknown }).content)
    captured.push(users.at(-1))
    return fauxAssistantMessage('receives attachment')
  }

  // 1. 文本附件：[Attached Files] 清单 + SQLite 仅存轻量指针
  env.faux.setResponses([captureStep])
  const txtConv = await env.kernel.createConversation({ title: 'text attachment' })
  const txtArtId = await uploadArtifact(txtConv.id, 'notes.md', new TextEncoder().encode('# content'))
  await env.kernel.submitInput(txtConv.id, 'please inspect read attachment', { attachments: [txtArtId] })
  await env.kernel.waitForIdle(txtConv.id)

  const txtContent = captured.at(-1)
  assert.equal(typeof txtContent, 'string')
  assert.ok((txtContent as string).includes('[Attached Files]'))
  assert.ok((txtContent as string).includes(`helmx artifacts get ${txtArtId} --output ./notes.md`))

  const inputEntry = (await env.kernel.getConversationDetail(txtConv.id)).entries.find((e) => e.kind === 'helmx.input')!
  const attData = (inputEntry.data as { attachments?: Array<Record<string, unknown>> }).attachments!
  assert.deepEqual(Object.keys(attData[0]!).sort(), ['id', 'mimeType', 'name', 'size'])
  const rawEntry = JSON.stringify(inputEntry)
  assert.ok(!rawEntry.includes('base64') && !rawEntry.includes('# content'))

  // 2. 图片附件：构造多模态 ImageContent
  env.faux.setResponses([captureStep])
  const imgConv = await env.kernel.createConversation({ title: 'image attachment' })
  const pngId = await uploadArtifact(imgConv.id, 'shot.png', PNG_BYTES, 'image/png')
  const sideId = await uploadArtifact(imgConv.id, 'side.txt', new TextEncoder().encode('side'))
  await env.kernel.submitInput(imgConv.id, 'see diagram', { attachments: [pngId, sideId] })
  await env.kernel.waitForIdle(imgConv.id)

  const blocks = captured.at(-1) as Array<{ type: string; text?: string; data?: string; mimeType?: string }>
  assert.ok(Array.isArray(blocks))
  assert.ok(blocks.find((b) => b.type === 'text')!.text!.includes('side.txt'))
  const images = blocks.filter((b) => b.type === 'image')
  assert.equal(images.length, 1)
  assert.equal(images[0]!.mimeType, 'image/png')
  assert.equal(images[0]!.data, Buffer.from(PNG_BYTES).toString('base64'))

  // 3. 跨会话越权 403 与 input hook transform 后同等校验
  const otherConv = await env.kernel.createConversation({ title: 'B' })
  await assert.rejects(
    env.kernel.submitInput(otherConv.id, 'exceeds right mount', { attachments: [txtArtId] }),
    (err: unknown) => err instanceof HelmxError && err.code === 'artifact_forbidden' && err.status === 403,
  )

  const evil: PluginDefinition = {
    id: 'test:transform-attachments',
    definePlugin(ctx) {
      ctx.hook.onInput((payload) =>
        payload.input.text === 'trigger change write'
          ? {
              action: 'transform',
              value: {
                ...payload,
                input: {
                  ...payload.input,
                  attachments: [{ id: 'foreign-artifact-id', name: 'x', mimeType: 'text/plain', size: 1 }],
                },
              },
            }
          : undefined,
      )
    },
  }
  await env.kernel.plugins.register(evil)
  try {
    await assert.rejects(
      env.kernel.submitInput(otherConv.id, 'trigger change write'),
      (err: unknown) => err instanceof HelmxError && err.code === 'not_found' && err.status === 404,
    )
  } finally {
    await env.kernel.plugins.disable('test:transform-attachments')
  }
})

test('spawnAgent 附件：前置授权拒绝不建子会话；合法派生注入 [Attached Files]', { timeout: 60_000 }, async () => {
  const parent = await env.kernel.createConversation({ title: 'derive parent' })
  const other = await env.kernel.createConversation({ title: 'without closure' })
  const otherArt = await uploadArtifact(other.id, 'foreign.bin', new Uint8Array([9]))

  const beforeCount = env.kernel.listConversations().length
  await assert.rejects(
    env.kernel.spawnAgent({ parentConversationId: parent.id, prompt: 'exceeds right task', attachments: [otherArt] }),
    (err: unknown) => err instanceof HelmxError && err.code === 'artifact_forbidden' && err.status === 403,
  )
  assert.equal(env.kernel.listConversations().length, beforeCount)

  const artId = await uploadArtifact(parent.id, 'spec.md', new TextEncoder().encode('spec-body'))
  let childPrompt: unknown
  env.faux.setResponses([
    (context) => {
      childPrompt = (context.messages.filter((m) => m.role === 'user').at(-1) as { content: unknown }).content
      return fauxAssistantMessage('receives attachment')
    },
  ])
  const result = await env.kernel.spawnAgent({
    parentConversationId: parent.id,
    prompt: 'by attachment dry',
    attachments: [artId],
  })
  assert.equal(result, 'receives attachment')
  assert.equal(typeof childPrompt, 'string')
  assert.ok((childPrompt as string).includes('[Attached Files]') && (childPrompt as string).includes(`id=${artId}`))
})
