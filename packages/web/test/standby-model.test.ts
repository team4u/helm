/**
 * 待命草稿存储与首发编排纯逻辑测试（standby-model.ts）：
 * 覆盖同步去重、步骤顺序（create -> patch -> upload -> submit）、失败锚点保留、
 * 重试复用（不重复 create / 不重复上传）、环境与创建入参组装、附件上限。
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ArtifactMetadata, ConversationInit, ConversationSummary } from '@helm/protocol'
import {
  admitStandbyFiles,
  buildStandbyCreateInit,
  clearStandbyDraft,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetStandbyDrafts,
  standbyDraftKey,
  standbyEnvError,
  updateStandbyDraft,
  type StandbySendDeps,
  type StandbySendResult,
} from '../src/conversation/standby-model.js'

afterEach(() => resetStandbyDrafts())

function makeFile(name: string, text = 'x'): File {
  return new File([text], name, { type: 'text/plain' })
}

interface DepLog {
  creates: Array<ConversationInit>
  patches: Array<{ id: number; thinkingLevel: string }>
  uploads: Array<{ id: number; name: string }>
  submits: Array<{ id: number; payload: { text: string; attachments?: string[] } }>
  errors: Array<{ title: string; conversationId?: number }>
  backgroundNotices: number[]
  navigations: number[]
  failures: { create?: Error; patch?: Error; uploadNames?: string[]; submit?: Error }
  viewing: boolean
}

function makeDeps(log: DepLog, nextId = { value: 9 }): StandbySendDeps {
  return {
    create: async (init) => {
      log.creates.push(init)
      if (log.failures.create !== undefined) {
        const err = log.failures.create
        log.failures.create = undefined
        throw err
      }
      const summary = {
        id: nextId.value++,
        title: '',
        profileId: String(init.profileId ?? ''),
        tags: [],
        cwd: '',
        model: '',
        thinkingLevel: '',
        status: 'idle',
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: 0,
        updatedAt: 0,
      } satisfies ConversationSummary
      return summary
    },
    patchThinkingLevel: async (id, thinkingLevel) => {
      log.patches.push({ id, thinkingLevel })
      if (log.failures.patch !== undefined) throw log.failures.patch
    },
    upload: async (id, file) => {
      if (log.failures.uploadNames?.includes(file.name)) throw new Error(`upload failed: ${file.name}`)
      log.uploads.push({ id, name: file.name })
      const meta: ArtifactMetadata = { id: `art-${log.uploads.length}`, conversationId: id, name: file.name, path: `artifacts/${id}/${file.name}`, mimeType: file.type, size: file.size, createdAt: 0 }
      return meta
    },
    submit: async (id, payload) => {
      log.submits.push({ id, payload: payload as { text: string; attachments?: string[] } })
      if (log.failures.submit !== undefined) {
        const err = log.failures.submit
        log.failures.submit = undefined
        throw err
      }
    },
    notifyError: (title, err, conversationId) => {
      log.errors.push({ title, conversationId })
      void err
    },
    notifySentInBackground: (conversationId) => { log.backgroundNotices.push(conversationId) },
    navigateToConversation: (conversationId) => { log.navigations.push(conversationId) },
    isStillViewing: () => log.viewing,
  }
}

function makeLog(): DepLog {
  return {
    creates: [], patches: [], uploads: [], submits: [], errors: [], backgroundNotices: [], navigations: [],
    failures: {}, viewing: true,
  }
}

async function run(key: string, profileId: string, deps: StandbySendDeps): Promise<StandbySendResult> {
  return executeStandbySend(key, profileId, deps)
}

test('同步去重：sending 标记后的第二次调用直接 busy，不重复 create', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  let releaseCreate!: () => void
  const gate = new Promise<void>((r) => { releaseCreate = r })
  const deps = makeDeps(log)
  deps.create = async (init) => {
    log.creates.push(init)
    await gate
    return { id: 9, profileId: 'assistant' } as ConversationSummary
  }
  updateStandbyDraft(key, { text: 'hello' })
  const first = run(key, 'assistant', deps)
  const second = await run(key, 'assistant', deps)
  assert.equal(second, 'busy', '在途第二次调用被同步拒绝')
  releaseCreate()
  // first 的后续步骤（submit）会执行
  await first
  assert.equal(log.creates.length, 1)
  assert.equal(log.submits.length, 1)
})

test('步骤顺序：create -> patch thinkingLevel -> 逐个上传 -> submit 携带附件', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  const { draft } = admitStandbyFiles(getStandbyDraft(key), [makeFile('a.txt'), makeFile('b.txt')])
  updateStandbyDraft(key, { ...draft, text: '带附件', thinkingLevel: 'high', model: 'faux/glm-4.6' })
  const result = await run(key, 'assistant', makeDeps(log))
  assert.equal(result, 'sent')
  assert.equal(log.creates.length, 1)
  assert.deepEqual(log.patches, [{ id: 9, thinkingLevel: 'high' }])
  assert.deepEqual(log.uploads.map((u) => u.name), ['a.txt', 'b.txt'])
  assert.equal(log.submits.length, 1)
  assert.deepEqual(log.submits[0]!.payload.attachments, ['art-1', 'art-2'])
  assert.deepEqual(log.navigations, [9])
  assert.equal(getStandbyDraft(key).text, '', '成功后草稿清空')
})

test('thinkingLevel 未设置不 patch；环境未定制不携带', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  updateStandbyDraft(key, { text: '默认配置' })
  await run(key, 'assistant', makeDeps(log))
  assert.deepEqual(log.creates, [{ profileId: 'assistant' }])
  assert.equal(log.patches.length, 0)
  assert.equal(log.submits[0]!.payload.attachments, undefined)
})

test('create 失败：failed、无锚点、草稿保留；重试重新 create', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  log.failures.create = new Error('boom')
  updateStandbyDraft(key, { text: '第一条' })
  const first = await run(key, 'assistant', makeDeps(log))
  assert.equal(first, 'failed')
  assert.equal(log.errors[0]?.conversationId, undefined)
  const draft = getStandbyDraft(key)
  assert.equal(draft.text, '第一条', '草稿保留')
  assert.equal(draft.conversationId, undefined, '未创建成功不产生锚点')
  assert.equal(draft.sending, false, '失败后复位 sending')
  const second = await run(key, 'assistant', makeDeps(log))
  assert.equal(second, 'sent')
  assert.equal(log.creates.length, 2)
})

test('submit 失败于 create 之后：保留真实 ID；重试不重复 create', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  log.failures.submit = new Error('submit boom')
  updateStandbyDraft(key, { text: '会创建但失败' })
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'failed')
  assert.equal(getStandbyDraft(key).conversationId, 9, '真实会话 ID 保留')
  assert.notEqual(getStandbyDraft(key).error, null)
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'sent')
  assert.equal(log.creates.length, 1, '重试复用会话，不重复创建')
  assert.equal(log.submits.length, 2)
})

test('上传部分失败：已上传转正；重试只补传缺的文件', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  log.failures.uploadNames = ['b.txt']
  const { draft } = admitStandbyFiles(getStandbyDraft(key), [makeFile('a.txt'), makeFile('b.txt')])
  updateStandbyDraft(key, { ...draft, text: '部分上传失败' })
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'failed')
  assert.equal(getStandbyDraft(key).conversationId, 9)
  const afterFail = getStandbyDraft(key)
  assert.deepEqual(afterFail.localFiles.map((f) => f.name), ['b.txt'], '失败文件留在本地暂存')
  assert.deepEqual(afterFail.uploaded.map((u) => u.name), ['a.txt'], '成功文件已转正')
  log.failures.uploadNames = undefined
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'sent')
  assert.deepEqual(log.uploads.map((u) => u.name), ['a.txt', 'b.txt'], '重试只补传 b.txt')
  assert.equal(log.submits.length, 1, '上传失败时首次未走到 submit')
  assert.deepEqual(log.submits[0]!.payload.attachments, ['art-1', 'art-2'])
})

test('用户已切走：不导航改后台通知；仍查看时才 replace 导航', { timeout: 60_000 }, async () => {
  const awayKey = standbyDraftKey('primary', 'assistant')
  const awayLog = makeLog()
  awayLog.viewing = false
  updateStandbyDraft(awayKey, { text: '后台完成' })
  await run(awayKey, 'assistant', makeDeps(awayLog))
  assert.deepEqual(awayLog.navigations, [], '不抢新导航')
  assert.deepEqual(awayLog.backgroundNotices, [9], '发出后台通知')

  const hereKey = standbyDraftKey('split', 'assistant')
  const hereLog = makeLog()
  updateStandbyDraft(hereKey, { text: '仍在查看' })
  await run(hereKey, 'assistant', makeDeps(hereLog))
  assert.deepEqual(hereLog.navigations, [9])
  assert.deepEqual(hereLog.backgroundNotices, [])
})

test('成功清空后 finally 不复活空记录', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey('primary', 'assistant')
  const log = makeLog()
  updateStandbyDraft(key, { text: '清理校验' })
  await run(key, 'assistant', makeDeps(log))
  assert.deepEqual(getStandbyDraft(key), {
    text: '', localFiles: [], uploaded: [], model: undefined, thinkingLevel: undefined,
    envCustomized: false, envNodeId: undefined, envCwd: undefined,
    conversationId: undefined, sending: false, error: null,
  })
})

test('buildStandbyCreateInit：环境/模型仅在显式设置时携带', { timeout: 60_000 }, () => {
  assert.deepEqual(buildStandbyCreateInit('p', { envCustomized: false, envNodeId: undefined, envCwd: undefined, model: undefined }), { profileId: 'p' })
  assert.deepEqual(
    buildStandbyCreateInit('p', { envCustomized: true, envNodeId: 'remote', envCwd: ' /w ', model: '' }),
    { profileId: 'p', nodeId: 'remote', cwd: '/w' },
  )
  assert.deepEqual(
    buildStandbyCreateInit('p', { envCustomized: true, envNodeId: undefined, envCwd: '/abs', model: 'faux/m' }),
    { profileId: 'p', nodeId: 'local', cwd: '/abs', model: 'faux/m' },
  )
})

test('standbyEnvError：未定制恒通过；定制后沿用绝对路径校验', { timeout: 60_000 }, () => {
  assert.equal(standbyEnvError({ envCustomized: false, envNodeId: undefined, envCwd: undefined }), null)
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: '' }), '请填写目标节点上的工作目录（绝对路径）')
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: 'relative/path' }), '工作目录必须是绝对路径（POSIX / 或 Windows 盘符开头）')
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: '/abs' }), null)
})

test('admitStandbyFiles：15MiB 上限拒绝并保留接受项', { timeout: 60_000 }, () => {
  const big = makeFile('big.bin')
  Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 })
  const small = makeFile('small.txt')
  const { draft, accepted, rejected } = admitStandbyFiles(getStandbyDraft('x'), [big, small])
  assert.deepEqual(accepted.map((f) => f.name), ['small.txt'])
  assert.deepEqual(rejected.map((r) => r.file.name), ['big.bin'])
  assert.equal(rejected[0]!.reason.includes('15 MiB'), true)
  assert.equal(draft.localFiles.length, 1)
})

test('inheritedEnvOf：空值不继承，local 节点按缺省处理由调用方决定', { timeout: 60_000 }, () => {
  assert.deepEqual(inheritedEnvOf({}), {})
  assert.deepEqual(inheritedEnvOf({ nodeId: 'remote', cwd: '/w' }), { nodeId: 'remote', cwd: '/w' })
  assert.deepEqual(inheritedEnvOf({ nodeId: '', cwd: '' }), {})
})

test('clearStandbyDraft：不存在的键清理不广播报错', { timeout: 60_000 }, () => {
  clearStandbyDraft('missing:key')
  assert.equal(getStandbyDraft('missing:key').text, '')
})
