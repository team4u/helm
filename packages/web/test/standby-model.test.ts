/**
 * Pure-logic tests for standby draft storage and the first-send pipeline (standby-model.ts):
 * covers synchronous dedupe, step order (create -> patch -> upload -> submit), failure-anchor
 * retention, retry reuse (no duplicate create / no duplicate upload), environment and create
 * input assembly, and the attachment size cap.
 */
import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import type { ArtifactMetadata, ConversationInit, ConversationSummary } from '@helm/protocol'
import {
  standbyManageAction,
  admitStandbyFiles,
  buildStandbyCreateInit,
  clearStandbyDraft,
  executeStandbySend,
  getStandbyDraft,
  inheritedEnvOf,
  resetEnvStandbyDraft,
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
      const meta: ArtifactMetadata = { id: `art-${log.uploads.length}`, conversationId: id, kind: 'upload', name: file.name, path: `artifacts/${id}/${file.name}`, mimeType: file.type, size: file.size, createdAt: 0 }
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

test('synchronous dedupe: a second call after the sending flag is claimed returns busy with no duplicate create', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
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
  assert.equal(second, 'busy', 'the in-flight second call is rejected synchronously')
  releaseCreate()
  // The first call's remaining steps (submit) still run
  await first
  assert.equal(log.creates.length, 1)
  assert.equal(log.submits.length, 1)
})

test('step order: create -> patch thinkingLevel -> per-file upload -> submit carries attachments', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
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
  assert.equal(getStandbyDraft(key).text, '', 'the draft clears on success')
})

test('no thinkingLevel patch when unset; no environment fields when not customized', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  updateStandbyDraft(key, { text: '默认配置' })
  await run(key, 'assistant', makeDeps(log))
  assert.deepEqual(log.creates, [{ profileId: 'assistant' }])
  assert.equal(log.patches.length, 0)
  assert.equal(log.submits[0]!.payload.attachments, undefined)
})

test('create failure: failed, no anchor, draft preserved; retry re-creates', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  log.failures.create = new Error('boom')
  updateStandbyDraft(key, { text: '第一条' })
  const first = await run(key, 'assistant', makeDeps(log))
  assert.equal(first, 'failed')
  assert.equal(log.errors[0]?.conversationId, undefined)
  const draft = getStandbyDraft(key)
  assert.equal(draft.text, '第一条', 'the draft is preserved')
  assert.equal(draft.conversationId, undefined, 'no anchor without a successful create')
  assert.equal(draft.sending, false, 'sending resets after failure')
  const second = await run(key, 'assistant', makeDeps(log))
  assert.equal(second, 'sent')
  assert.equal(log.creates.length, 2)
})

test('submit failure after create: the real id is kept; retry never re-creates', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  log.failures.submit = new Error('submit boom')
  updateStandbyDraft(key, { text: '会创建但失败' })
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'failed')
  assert.equal(getStandbyDraft(key).conversationId, 9, 'the real conversation id is kept')
  assert.notEqual(getStandbyDraft(key).error, null)
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'sent')
  assert.equal(log.creates.length, 1, 'retry reuses the conversation without re-creating')
  assert.equal(log.submits.length, 2)
})

test('partial upload failure: uploaded files are finalized; retry uploads only the missing files', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  log.failures.uploadNames = ['b.txt']
  const { draft } = admitStandbyFiles(getStandbyDraft(key), [makeFile('a.txt'), makeFile('b.txt')])
  updateStandbyDraft(key, { ...draft, text: '部分上传失败' })
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'failed')
  assert.equal(getStandbyDraft(key).conversationId, 9)
  const afterFail = getStandbyDraft(key)
  assert.deepEqual(afterFail.localFiles.map((f) => f.name), ['b.txt'], 'the failed file stays in local staging')
  assert.deepEqual(afterFail.uploaded.map((u) => u.name), ['a.txt'], 'the successful file is finalized')
  log.failures.uploadNames = undefined
  assert.equal(await run(key, 'assistant', makeDeps(log)), 'sent')
  assert.deepEqual(log.uploads.map((u) => u.name), ['a.txt', 'b.txt'], 'retry uploads only b.txt')
  assert.equal(log.submits.length, 1, 'the failed first attempt never reached submit')
  assert.deepEqual(log.submits[0]!.payload.attachments, ['art-1', 'art-2'])
})

test('user switched away: no navigation, a background notice instead; replace-navigation only while still viewing', { timeout: 60_000 }, async () => {
  const awayKey = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const awayLog = makeLog()
  awayLog.viewing = false
  updateStandbyDraft(awayKey, { text: '后台完成' })
  await run(awayKey, 'assistant', makeDeps(awayLog))
  assert.deepEqual(awayLog.navigations, [], 'never hijacks navigation')
  assert.deepEqual(awayLog.backgroundNotices, [9], 'a background notice goes out')

  const hereKey = standbyDraftKey({ panel: 'split', profileId: 'assistant' })
  const hereLog = makeLog()
  updateStandbyDraft(hereKey, { text: '仍在查看' })
  await run(hereKey, 'assistant', makeDeps(hereLog))
  assert.deepEqual(hereLog.navigations, [9])
  assert.deepEqual(hereLog.backgroundNotices, [])
})

test('after a successful clear, finally never revives the empty record', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  updateStandbyDraft(key, { text: '清理校验' })
  await run(key, 'assistant', makeDeps(log))
  assert.deepEqual(getStandbyDraft(key), {
    text: '', localFiles: [], uploaded: [], model: undefined, thinkingLevel: undefined,
    envCustomized: false, envNodeId: undefined, envCwd: undefined,
    conversationId: undefined, sending: false, error: null,
  })
})

test('buildStandbyCreateInit: environment/model ride along only when explicitly set', { timeout: 60_000 }, () => {
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

test('standbyEnvError: always passes when not customized; applies the absolute-path validation once customized', { timeout: 60_000 }, () => {
  assert.equal(standbyEnvError({ envCustomized: false, envNodeId: undefined, envCwd: undefined }), null)
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: '' }), 'Enter the working directory on the target node (absolute path)')
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: 'relative/path' }), 'Working directory must be an absolute path (POSIX / or Windows drive letter)')
  assert.equal(standbyEnvError({ envCustomized: true, envNodeId: 'r', envCwd: '/abs' }), null)
})

test('admitStandbyFiles: rejects above the 15 MiB cap and keeps accepted items', { timeout: 60_000 }, () => {
  const big = makeFile('big.bin')
  Object.defineProperty(big, 'size', { value: 16 * 1024 * 1024 })
  const small = makeFile('small.txt')
  const { draft, accepted, rejected } = admitStandbyFiles(getStandbyDraft('x'), [big, small])
  assert.deepEqual(accepted.map((f) => f.name), ['small.txt'])
  assert.deepEqual(rejected.map((r) => r.file.name), ['big.bin'])
  assert.equal(rejected[0]!.reason.includes('15 MiB'), true)
  assert.equal(draft.localFiles.length, 1)
})

test('inheritedEnvOf: empty values are not inherited; the local node default is the caller decision', { timeout: 60_000 }, () => {
  assert.deepEqual(inheritedEnvOf({}), {})
  assert.deepEqual(inheritedEnvOf({ nodeId: 'remote', cwd: '/w' }), { nodeId: 'remote', cwd: '/w' })
  assert.deepEqual(inheritedEnvOf({ nodeId: '', cwd: '' }), {})
})

test('clearStandbyDraft: clearing an absent key broadcasts no error', { timeout: 60_000 }, () => {
  clearStandbyDraft('missing:key')
  assert.equal(getStandbyDraft('missing:key').text, '')
})

test('standbyManageAction: /new clears the draft; /clear and /compact need an existing conversation; the rest is plain input', { timeout: 60_000 }, () => {
  assert.deepEqual(standbyManageAction('/new'), { kind: 'clear-draft' })
  assert.deepEqual(standbyManageAction('  /new  '), { kind: 'clear-draft' })
  assert.deepEqual(standbyManageAction('/clear'), { kind: 'needs-conversation', command: '/clear' })
  assert.deepEqual(standbyManageAction('/compact'), { kind: 'needs-conversation', command: '/compact' })
  assert.deepEqual(standbyManageAction('/compact 保留架构决策'), { kind: 'needs-conversation', command: '/compact' })
  assert.equal(standbyManageAction('/definitely-not-registered'), null)
  assert.equal(standbyManageAction('请帮我执行 /new'), null, 'non-exact hits are not intercepted')
})

test('standbyDraftKey: unambiguous full entry coordinate, empty values normalized', { timeout: 60_000 }, () => {
  const plain = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const r1 = standbyDraftKey({ panel: 'primary', profileId: 'assistant', nodeId: 'r1', cwd: '/a' })
  const r2 = standbyDraftKey({ panel: 'primary', profileId: 'assistant', nodeId: 'r2', cwd: '/b' })
  assert.notEqual(plain, r1)
  assert.notEqual(r1, r2)
  // Empty strings equal unset; primary/split same coordinates yield different keys
  assert.equal(standbyDraftKey({ panel: 'primary', profileId: 'p', nodeId: '', cwd: '' }), plain.replace('assistant', 'p'))
  assert.notEqual(standbyDraftKey({ panel: 'split', profileId: 'assistant', nodeId: 'r1', cwd: '/a' }), r1)
  assert.notEqual(
    standbyDraftKey({ panel: 'primary', profileId: 'qa-helper', nodeId: 'node', cwd: '/a' }),
    standbyDraftKey({ panel: 'primary', profileId: 'qa', nodeId: 'helper-node', cwd: '/a' }),
    'React instances and drafts must share the unambiguous coordinate key, not hyphen-joined fields',
  )
})

test('resetEnvStandbyDraft: clears the environment and moves the text; never overwrites an existing target draft', { timeout: 60_000 }, () => {
  const from = standbyDraftKey({ panel: 'primary', profileId: 'p', nodeId: 'r1', cwd: '/a' })
  const to = standbyDraftKey({ panel: 'primary', profileId: 'p' })
  updateStandbyDraft(from, { text: '跟随正文', envCustomized: true, envNodeId: 'r1', envCwd: '/a' })
  assert.equal(resetEnvStandbyDraft(from, to), true)
  const moved = getStandbyDraft(to)
  assert.equal(moved.text, '跟随正文')
  assert.equal(moved.envCustomized, false)
  assert.equal(moved.envNodeId, undefined)
  assert.equal(getStandbyDraft(from).text, '', 'the old-coordinate record is removed by the move')

  // Target already holds a draft: no overwrite, returns false, the source draft is preserved
  const from2 = standbyDraftKey({ panel: 'split', profileId: 'p', nodeId: 'r1', cwd: '/a' })
  updateStandbyDraft(from2, { text: '分屏草稿' })
  updateStandbyDraft(standbyDraftKey({ panel: 'split', profileId: 'p' }), { text: '已有默认草稿' })
  assert.equal(resetEnvStandbyDraft(from2, standbyDraftKey({ panel: 'split', profileId: 'p' })), false)
  assert.equal(getStandbyDraft(standbyDraftKey({ panel: 'split', profileId: 'p' })).text, '已有默认草稿')
  assert.equal(getStandbyDraft(from2).text, '分屏草稿')
})

test('epoch voiding: after a reset, in-flight responses return stale — no anchor write, no submit, no notice', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  let releaseCreate!: () => void
  const gate = new Promise<void>((r) => { releaseCreate = r })
  const deps = makeDeps(log)
  deps.create = async (init) => {
    log.creates.push(init)
    await gate
    return { id: 9, profileId: 'assistant' } as import('@helm/protocol').ConversationSummary
  }
  updateStandbyDraft(key, { text: '会被释放的草稿' })
  const task = run(key, 'assistant', deps)
  resetStandbyDrafts()
  releaseCreate()
  assert.equal(await task, 'stale')
  assert.equal(getStandbyDraft(key).text, '', 'the response must not revive the text')
  assert.equal(getStandbyDraft(key).conversationId, undefined, 'no anchor write')
  assert.equal(log.submits.length, 0)
  assert.equal(log.errors.length, 0, 'no notices sent')
  assert.deepEqual(log.navigations, [], 'no navigation')

  // A new-epoch draft under the same key: the old task's cleanup must not overwrite its sending state
  updateStandbyDraft(key, { text: '新世代草稿' })
  assert.equal(getStandbyDraft(key).sending, false)
})

test('epoch voiding: a reset during the upload wait stops the submit; finalized uploads are voided', { timeout: 60_000 }, async () => {
  const key = standbyDraftKey({ panel: 'primary', profileId: 'assistant' })
  const log = makeLog()
  let releaseUpload!: () => void
  const gate = new Promise<void>((r) => { releaseUpload = r })
  const deps = makeDeps(log)
  deps.upload = async (id, file) => {
    await gate
    log.uploads.push({ id, name: file.name })
    return { id: 'art-1', conversationId: id, kind: 'upload', name: file.name, path: '', mimeType: file.type, size: file.size, createdAt: 0 }
  }
  const { draft } = admitStandbyFiles(getStandbyDraft(key), [makeFile('wait.txt')])
  updateStandbyDraft(key, { ...draft, text: '上传中释放' })
  const task = run(key, 'assistant', deps)
  await new Promise((r) => setTimeout(r, 5))
  resetStandbyDrafts()
  releaseUpload()
  assert.equal(await task, 'stale')
  assert.equal(log.submits.length, 0, 'no further submit')
  assert.equal(getStandbyDraft(key).uploaded.length, 0, 'the response must not revive attachments')
})

test('admitStandbyFiles: fake-File plain objects are rejected at admission; real Files stage normally', { timeout: 60_000 }, () => {
  // Plain objects riding synthetic events (name/size fields only, no arrayBuffer): they once sneaked
  // into drafts and threw synchronously at file.arrayBuffer() during the first send's uploadArtifact,
  // cutting the anchored chain in half (verified in a browser).
  const fake = { name: 'fake.txt', size: 10, type: 'text/plain' } as unknown as File
  const readableButNotBlob = {
    name: 'fake-readable.txt', size: 10, type: 'text/plain',
    arrayBuffer: async () => new ArrayBuffer(0),
  } as unknown as File
  const real = makeFile('real.txt')
  const realBlobLike = Object.assign(new Blob(['blob']), { name: 'blob-named.txt' }) as unknown as File
  const { draft, accepted, rejected } = admitStandbyFiles(getStandbyDraft('x'), [fake, readableButNotBlob, real, realBlobLike])
  assert.deepEqual(accepted.map((f) => f.name), ['real.txt', 'blob-named.txt'], 'real Blobs/Files both stage')
  assert.equal(rejected.length, 2)
  assert.equal(rejected[0]!.file, fake)
  assert.equal(rejected[1]!.file, readableButNotBlob, 'faking only the arrayBuffer method is still not a Blob')
  assert.ok(rejected[0]!.reason.includes('Unsupported attachment source'), 'a user-readable reason is given explicitly')
  assert.equal(draft.localFiles.length, 2, 'fake objects never enter localFiles')
})
