/**
 * 原生 spawn isolation: 'worktree' 与 WorktreeAllocator 真实行为测试。
 *
 * 覆盖：
 * - 原生 runNativeSpawn 传 isolation: 'worktree'：真实 git worktree 创建于
 *   仓库同级 .helm-worktrees 下、helm/spawn-* 分支、子会话与 gate 均在
 *   worktree 目录内执行、onResolved 回传 worktree 元数据；
 * - 并发 4 个 worktree 分配：per-repo mutex 生效，无 .git/config.lock 冲突；
 * - 非 Git 目录：显式 not_a_git_repo；
 * - dirty 源仓库：dirtySource 如实记录，子代理 prompt 含隔离通知；
 * - resume：沿用原 worktree（不二次创建）、冲突 cwd 显式 resume_cwd_conflict、
 *   目录被删后显式 worktree_missing；
 * - cleanup_worktree：脏工作区拒绝（worktree_dirty）、force+deleteBranch 成功
 *   移除并置 removed、未登记路径显式 not_found（绝不误删外部目录）。
 *
 * 诚实性纪律：全部走真实临时 Git 仓库（git init + 初始 commit）与真实 SDK
 * Harness（faux 模型输出），worktree/gate 经 NodeExecutionEnv 真实 shell 执行；
 * 绝不 mock git 行为、绝不伪造完成结果。
 */

import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { Harness, createRegistry } from '@earendil-works/pi-durable'
import { MemoryStorage } from '@earendil-works/pi-durable/storage/memory'
import { HelmError } from '@helm/protocol'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createEnvFabric } from '../src/env/fabric.js'
import { runNativeSpawn, type NativeSpawnDeps } from '../src/runtime/spawn.js'
import { WorktreeAllocator, createCleanupWorktreeTool } from '../src/runtime/worktree.js'
import { ArtifactService, SecretStash } from '../src/services/index.js'

type FauxHandle = ReturnType<typeof fauxProvider>

/** 真实临时 Git 仓库（git init + 初始 commit；用户级配置隔离）。 */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@helm.local'])
  git(['config', 'user.name', 'helm-test'])
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  return dir
}

/** 真实 SDK Harness（MemoryStorage）+ faux provider + 完整 NativeSpawnDeps（spawn-ask 同构）。 */
async function openSpawnHarness(repoDir: string, dataDir: string): Promise<{
  harness: Harness
  deps: NativeSpawnDeps
  faux: FauxHandle
  allocator: WorktreeAllocator
  markIdle: (childId: number) => void
  mirrors: Map<number, { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }>
  close(): Promise<void>
}> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const storage = new MemoryStorage()
  const registry = createRegistry()
  const harness = await Harness.open(
    storage,
    { models: () => models, registry },
    BACKGROUND_CONTEXT,
  )

  const stash = new SecretStash()
  const parents = new Map<number, number>()
  const lastTexts = new Map<number, string>()
  const observers = new Map<number, () => void>()
  const mirrors = new Map<
    number,
    { profileId: string; cwd: string; model: string; modelOverride?: string; title: string; tags: string[]; createdAt: number }
  >()

  // 真实 EnvFabric（local NodeExecutionEnv）+ 内存 docStore：allocator 真跑 git。
  const envFabric = createEnvFabric({})
  const docs = new Map<string, unknown>()
  const docStore = {
    get<T>(key: string, initial: T): T {
      return (docs.get(key) as T | undefined) ?? initial
    },
    set<T>(key: string, value: T): void {
      docs.set(key, value)
    },
  }
  const working = new Set<number>()
  const allocator = new WorktreeAllocator({
    envFabric,
    docStore,
    redact: (t) => stash.redact(t),
    isConversationWorking: (id) => working.has(id),
  })
  /** 标记子会话回合结束（占用检查与生产 tracker 同语义：回合后不在运行）。 */
  const markIdle = (childId: number): void => {
    working.delete(childId)
  }

  const deps: NativeSpawnDeps = {
    dataDir,
    defaultCwd: repoDir,
    hubUrl: 'http://127.0.0.1:3200',
    stashEnvFor: (id) => stash.envFor(id),
    redact: (t) => stash.redact(t),
    artifacts: new ArtifactService(dataDir, { get: () => undefined, list: () => [], put: () => {}, deleteByConversation: () => {} } as never),
    envFabric,
    harness,
    getLastAssistantText: (id) => lastTexts.get(id),
    resolveModel: () => ({ provider: 'faux', modelId: 'faux-1' }),
    agentSessions: new Map(),
    registerChildConversation: async (childId, parentId, profileId, childCwd, modelMirror) => {
      parents.set(childId, parentId)
      mirrors.set(childId, {
        profileId,
        cwd: childCwd,
        model: modelMirror,
        title: `子代理 ${childId}`,
        tags: [],
        createdAt: Date.now(),
      })
      working.add(childId)
      const conv = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
      if (!conv) return
      const observer = {
        advance: (call: { kind: string; value: { entries: Array<{ kind: string; id: number; model?: ReadonlyArray<{ content?: ReadonlyArray<{ type: string; text?: string }> }> }> } }) => {
          if (call.kind !== 'value') return
          const view = call.value
          for (let i = view.entries.length - 1; i >= 0; i -= 1) {
            const entry = view.entries[i]!
            if (entry.kind !== 'pi.assistant') continue
            const text = (entry.model?.[0]?.content ?? [])
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text as string)
              .join('\n')
            if (text !== '') {
              lastTexts.set(childId, text)
              break
            }
          }
        },
        end: () => {},
      }
      const observation = await harness.observeConversation(childId as never, observer as never, BACKGROUND_CONTEXT)
      observers.set(childId, () => observation.detach())
    },
    resolveProfile: async (profileId) => {
      if (profileId !== 'assistant') return undefined
      return {}
    },
    getParentOfConversation: (childId) => parents.get(childId),
    getModelOverride: (childId) => mirrors.get(childId)?.modelOverride,
    getConversation: (childId) => {
      const m = mirrors.get(childId)
      if (!m) return undefined
      return {
        id: childId,
        title: m.title,
        profileId: m.profileId,
        tags: m.tags,
        cwd: m.cwd,
        model: m.model,
        thinkingLevel: '',
        status: 'idle' as never,
        stateChangeSeq: 1,
        completionSeq: 0,
        unread: false,
        pinned: false,
        pendingAskCount: 0,
        createdAt: m.createdAt,
        updatedAt: m.createdAt,
      }
    },
    updateConversation: async (childId, patch) => {
      const m = mirrors.get(childId)
      if (!m) throw new HelmError('not_found', `会话不存在：${childId}`, 404)
      if (patch.cwd !== undefined) m.cwd = patch.cwd
      if (patch.profileId !== undefined) m.profileId = patch.profileId
      if (patch.model !== undefined) m.modelOverride = patch.model
      if (m.modelOverride === undefined) m.model = 'faux/faux-1'
      else m.model = m.modelOverride
      return deps.getConversation(childId)!
    },
    installChildExtension: (extension) => {
      registry.install(extension)
    },
    worktrees: allocator,
  }
  return {
    harness,
    deps,
    faux,
    allocator,
    mirrors,
    markIdle,
    async close() {
      for (const detach of observers.values()) detach()
      await harness.close(BACKGROUND_CONTEXT)
      await storage.close(BACKGROUND_CONTEXT)
      await envFabric.dispose()
    },
  }
}

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-native-worktree-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 读取子会话提交的 prompt 文本（pi.user entry 的 user 消息 content）。 */
async function childPromptText(harness: Harness, childId: number): Promise<string> {
  const conversation = await harness.conversation(childId as never, BACKGROUND_CONTEXT)
  assert.ok(conversation)
  const page = await conversation.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)
  for (const entry of [...page.items].reverse()) {
    if (entry.kind !== 'pi.user') continue
    const model = entry.model ?? []
    let text = ''
    for (const msg of model) {
      if (msg === null || typeof msg !== 'object') continue
      if ((msg as { role?: unknown }).role !== 'user') continue
      const content = (msg as { content?: unknown }).content
      if (typeof content === 'string') text += content
      else if (Array.isArray(content)) {
        for (const block of content) {
          if (block !== null && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
            text += (block as { text?: unknown }).text ?? ''
          }
        }
      }
    }
    if (text !== '') return text
  }
  return ''
}

// ---------------------------------------------------------------------------
// 1. 原生 isolation: 'worktree'：真实 worktree 创建 + 子会话/gate 均在其中执行
// ---------------------------------------------------------------------------

describe('原生 isolation: worktree 基础链路', { timeout: 60_000 }, () => {
  it('创建真实 worktree 与 helm/spawn-* 分支；onResolved 回传 worktree；子会话与 gate 均在 worktree 内执行', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let resolved: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } } | undefined
      th.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd && git branch --show-current' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('任务完成'),
      ])
      const result = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '在 worktree 里执行 pwd',
        isolation: 'worktree',
        gate: 'test -f README.md && git rev-parse --is-inside-work-tree | grep -qx true',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          resolved = info as typeof resolved
        },
      } as never)
      assert.equal(result, '任务完成')

      // onResolved：worktree 元数据回传（path/branch），path 位于同级 .helm-worktrees。
      assert.ok(resolved?.worktree, 'onResolved 应回传 worktree 元数据')
      const wtPath = resolved!.worktree!.path
      const wtBranch = resolved!.worktree!.branch
      assert.ok(wtBranch.startsWith('helm/spawn-'), `分支名应为 helm/spawn-*：${wtBranch}`)
      assert.ok(wtPath.includes(join(dir, '.helm-worktrees')), `worktree 应位于同级 .helm-worktrees 下：${wtPath}`)
      assert.ok(existsSync(wtPath), 'worktree 目录应真实存在')
      assert.ok(existsSync(join(wtPath, 'README.md')), 'worktree 应检出初始提交内容')
      assert.equal(resolved!.effectiveCwd, wtPath, 'effectiveCwd 应为 worktree 目录')

      // 子会话 cwd 为 worktree 目录（镜像 + SDK 真实 pwd 取证）。
      const childId = resolved!.conversationId!
      assert.ok(childId > 0)
      assert.equal(th.mirrors.get(childId)?.cwd, wtPath, '子会话镜像 cwd 应为 worktree 目录')
      const prompt = await childPromptText(th.harness, childId)
      assert.ok(prompt.includes('在 worktree 里执行 pwd'), 'prompt 应原样提交给子会话')
      // gate 在 worktree 目录内执行：gate 命令校验 pwd 与 worktree 一致
      //（HELM_EXPECTED_WT 由下方第二次调用验证；首次用 gate 已通过的事实）。
      const allocatorRecord = th.allocator.findActive({ path: wtPath })
      assert.ok(allocatorRecord, '受管记录应已登记')
      assert.equal(allocatorRecord!.branch, wtBranch)
      assert.equal(allocatorRecord!.origin, 'native')
      assert.equal(allocatorRecord!.dirtySource, false, '干净源仓库 dirtySource 应为 false')
      assert.ok(/^[0-9a-f]{40}$/.test(allocatorRecord!.baseCommit), 'baseCommit 应为完整提交哈希')
    } finally {
      await th.close()
    }
  })

  it('gate 真实在 worktree 目录内执行（pwd 校验 + 文件存在性校验）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1-gate')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let gateOutput = ''
      th.faux.setResponses([fauxAssistantMessage('gate 取证完成')])
      let wtPath = ''
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'gate 取证',
        isolation: 'worktree',
        gate: 'pwd > .helm-gate-pwd.txt && test -f README.md',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          wtPath = info.worktree?.path ?? ''
        },
      } as never)
      assert.ok(wtPath !== '', '应回传 worktree path')
      // gate 在 worktree 目录内执行：其产物文件落在 worktree 而非源仓库。
      assert.ok(existsSync(join(wtPath, '.helm-gate-pwd.txt')), 'gate 产物应落在 worktree 目录内（gate cwd = worktree）')
      const { readFileSync } = await import('node:fs')
      gateOutput = readFileSync(join(wtPath, '.helm-gate-pwd.txt'), 'utf8').trim()
      assert.equal(gateOutput, wtPath, `gate pwd 应为 worktree 目录：${gateOutput}`)
      assert.ok(!existsSync(join(repo, '.helm-gate-pwd.txt')), '源仓库不得被 gate 污染')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. 并发分配：per-repo mutex
// ---------------------------------------------------------------------------

describe('并发 worktree 分配（per-repo mutex）', { timeout: 60_000 }, () => {
  it('Promise.all 同时 4 个 allocate：全部成功创建，无 config.lock 冲突', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      const records = await Promise.all(
        [1, 2, 3, 4].map((i) =>
          th.allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1, labelHint: `p${i}` }),
        ),
      )
      assert.equal(records.length, 4)
      const paths = new Set(records.map((r) => r.path))
      const branches = new Set(records.map((r) => r.branch))
      assert.equal(paths.size, 4, '4 个 worktree 路径应互不相同')
      assert.equal(branches.size, 4, '4 个分支应互不相同')
      for (const record of records) {
        assert.ok(existsSync(record.path), `worktree 应存在：${record.path}`)
        assert.ok(record.branch.startsWith('helm/spawn-'))
      }
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 非 Git 目录
// ---------------------------------------------------------------------------

describe('非 Git 目录显式拒绝', { timeout: 60_000 }, () => {
  it('allocate 在非 Git 目录抛 not_a_git_repo（附真实 git 输出）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const notRepo = join(dir, 'plain')
    mkdirSync(notRepo, { recursive: true })
    const th = await openSpawnHarness(notRepo, join(dir, 'data'))
    try {
      await assert.rejects(
        () => th.allocator.allocate({ nodeId: 'local', sourceCwd: notRepo, parentConversationId: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应抛 HelmError，实得 ${err}`)
          assert.equal(err.code, 'not_a_git_repo')
          assert.ok(err.message.includes(notRepo), '错误消息应含目录路径')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('runNativeSpawn 在非 Git 目录传 isolation: worktree 抛 not_a_git_repo，不派生子会话', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3b')
    const notRepo = join(dir, 'plain')
    mkdirSync(notRepo, { recursive: true })
    const th = await openSpawnHarness(notRepo, join(dir, 'data'))
    try {
      th.faux.setResponses([fauxAssistantMessage('不应到达')])
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: '任务',
            isolation: 'worktree',
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'not_a_git_repo')
          return true
        },
      )
      assert.equal(th.mirrors.size, 0, '失败路径不得派生任何子会话')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. dirty 源仓库
// ---------------------------------------------------------------------------

describe('dirty 源仓库诚实提示', { timeout: 60_000 }, () => {
  it('dirtySource 如实记录；子代理 prompt 含 <worktree_isolation_notice>', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 源工作区制造未提交修改（不 commit）。
    writeFileSync(join(repo, 'uncommitted.txt'), 'dirty\n')
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: 'dirty 源任务',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      assert.ok(childId > 0)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record, '应能按会话查询受管 worktree')
      assert.equal(record!.dirtySource, true, 'dirty 源仓库应如实记录 dirtySource=true')
      // 隔离工作树不包含源工作区未提交文件。
      assert.ok(!existsSync(join(record!.path, 'uncommitted.txt')), '隔离工作树基于 HEAD，不应包含源未提交文件')
      // 子代理收到的 prompt 含诚实提示。
      const prompt = await childPromptText(th.harness, childId)
      assert.ok(prompt.includes('<worktree_isolation_notice>'), `prompt 应含隔离通知：${prompt.slice(-400)}`)
      assert.ok(prompt.includes('不包含源工作区未提交的改动'), '通知应说明不含未提交改动')
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. resume
// ---------------------------------------------------------------------------

describe('resume 续接绑定 worktree 的子会话', { timeout: 60_000 }, () => {
  it('沿用原 worktree 不二次创建；onResolved 回传 worktree 元数据', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      let firstWt: { path: string; branch: string } | undefined
      th.faux.setResponses([fauxAssistantMessage('第一轮')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
          firstWt = info.worktree
        },
      } as never)
      assert.ok(childId > 0 && firstWt)

      // resume：不传 isolation —— 严格沿用原 worktree。
      let resumedWt: { path: string; branch: string } | undefined
      th.faux.setResponses([fauxAssistantMessage('续接完成')])
      const second = await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '续接',
        resume: String(childId),
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          resumedWt = info.worktree
        },
      } as never)
      assert.equal(second, '续接完成')
      assert.ok(resumedWt, 'resume 的 onResolved 也应回传 worktree 元数据')
      assert.equal(resumedWt!.path, firstWt!.path, 'resume 应沿用原 worktree 路径')
      assert.equal(resumedWt!.branch, firstWt!.branch, 'resume 应沿用原 worktree 分支')
      assert.equal(th.mirrors.size, 1, 'resume 不得新建子会话')
      // 受管记录仍只有一条 active（未二次创建）。
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      assert.equal(record!.path, firstWt!.path)
    } finally {
      await th.close()
    }
  })

  it('resume 传冲突 cwd 显式抛 resume_cwd_conflict（不静默搬家）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('第一轮')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)

      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: '续接',
            resume: String(childId),
            cwd: '/tmp/conflicting-cwd',
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'resume_cwd_conflict')
          assert.ok(err.message.includes(record!.path), '错误消息应含原 worktree 路径')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('worktree 目录被删后 resume 显式抛 worktree_missing', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('第一轮')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // 外部强制删除 worktree 目录（模拟人类清理）。
      rmSync(record!.path, { recursive: true, force: true })
      await assert.rejects(
        () =>
          runNativeSpawn(th.deps, {
            parentConversationId: 1,
            prompt: '续接',
            resume: String(childId),
          } as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_missing')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. cleanup_worktree
// ---------------------------------------------------------------------------

describe('cleanup_worktree', { timeout: 60_000 }, () => {
  it('脏工作区（未提交文件）force=false 显式拒绝 worktree_dirty', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // worktree 内制造未提交修改。
      writeFileSync(join(record!.path, 'wip.txt'), 'uncommitted\n')
      th.markIdle(childId)

      await assert.rejects(
        () => th.allocator.cleanup({ conversationId: childId }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { dirtyFiles?: string[] }
          assert.ok(details?.dirtyFiles?.some((f) => f.includes('wip.txt')), 'details 应列出脏文件')
          return true
        },
      )
      // 目录仍在（拒绝即不动）。
      assert.ok(existsSync(record!.path), '拒绝清理时 worktree 不得被移除')
    } finally {
      await th.close()
    }
  })

  it('未合入提交（分支领先主仓 HEAD）force=false 显式拒绝 worktree_dirty', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // worktree 内提交一个 commit（分支领先，未合入主仓）。
      writeFileSync(join(record!.path, 'feature.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: record!.path })
      execFileSync('git', ['commit', '-qm', 'feature'], { cwd: record!.path })
      th.markIdle(childId)

      await assert.rejects(
        () => th.allocator.cleanup({ conversationId: childId, deleteBranch: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { unmergedCommits?: number }
          assert.ok((details?.unmergedCommits ?? 0) >= 1, 'details 应报告未合入提交数')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('force: true + deleteBranch: true 成功移除 worktree 与分支；记录置 removed；二次清理幂等', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      // 制造脏内容后 force 清理。
      writeFileSync(join(record!.path, 'wip.txt'), 'dirty\n')
      th.markIdle(childId)

      const result = await th.allocator.cleanup({ conversationId: childId, deleteBranch: true, force: true })
      assert.equal(result.removed, true)
      assert.equal(result.branchDeleted, true)
      assert.equal(result.path, record!.path)
      assert.ok(!existsSync(record!.path), 'worktree 目录应被移除')
      // 分支已删除（git branch --list 无输出）。
      const branchList = execFileSync('git', ['branch', '--list', record!.branch], { cwd: repo, encoding: 'utf8' })
      assert.equal(branchList.trim(), '', `分支 ${record!.branch} 应已删除`)
      // 记录状态置 removed。
      const after = th.allocator.getForConversation(childId)
      assert.ok(after)
      assert.equal(after!.status, 'removed')
      assert.ok(after!.removedAt !== undefined)
      // 幂等：二次清理返回 removed: false。
      const again = await th.allocator.cleanup({ conversationId: childId })
      assert.equal(again.removed, false)
    } finally {
      await th.close()
    }
  })

  it('未登记路径显式 not_found（绝不误删外部目录）；缺参数 validation_error', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      // 人类自建目录（未登记）。
      const humanDir = join(dir, 'human-stuff')
      mkdirSync(humanDir, { recursive: true })
      await assert.rejects(
        () => th.allocator.cleanup({ path: humanDir }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'not_found')
          return true
        },
      )
      assert.ok(existsSync(humanDir), '未登记目录绝不被删除')

      // 缺参数。
      await assert.rejects(
        () => th.allocator.cleanup({}),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'validation_error')
          return true
        },
      )
    } finally {
      await th.close()
    }
  })

  it('createCleanupWorktreeTool：脏工作区返回 isError + 清晰指引；成功返回 ok 摘要', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6e')
    const repo = makeGitRepo(join(dir, 'repo'))
    const th = await openSpawnHarness(repo, join(dir, 'data'))
    try {
      let childId = 0
      th.faux.setResponses([fauxAssistantMessage('完成')])
      await runNativeSpawn(th.deps, {
        parentConversationId: 1,
        prompt: '任务',
        isolation: 'worktree',
        onResolved: (info: { conversationId?: number; effectiveCwd?: string; worktree?: { path: string; branch: string } }) => {
          childId = info.conversationId ?? 0
        },
      } as never)
      const record = th.allocator.getForConversation(childId)
      assert.ok(record)
      writeFileSync(join(record!.path, 'wip.txt'), 'dirty\n')
      th.markIdle(childId)

      const tool = createCleanupWorktreeTool(th.allocator)
      const dirty = await tool.execute(
        { conversationId: childId },
        { conversationId: 1, callId: 'c1' } as never,
        { abortSignal: undefined } as never,
      )
      assert.equal(dirty.isError, true, '脏工作区应返回错误')
      const dirtyText = (dirty.output as Array<{ text: string }>)[0]!.text
      assert.ok(dirtyText.includes('worktree_dirty') || dirtyText.includes('未提交修改'), `错误应含指引：${dirtyText}`)

      const ok = await tool.execute(
        { conversationId: childId, deleteBranch: true, force: true },
        { conversationId: 1, callId: 'c2' } as never,
        { abortSignal: undefined } as never,
      )
      assert.equal(ok.isError, undefined)
      assert.equal((ok.structuredOutput as { ok: boolean }).ok, true)
      assert.equal((ok.structuredOutput as { removed: boolean }).removed, true)
    } finally {
      await th.close()
    }
  })
})
