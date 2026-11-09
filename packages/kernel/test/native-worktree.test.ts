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
 *   移除并置 removed、未登记路径显式 not_found（绝不误删外部目录）；
 * - 安全加固：external 登记去重与真实清理、baseCommit 为空也按主工作树
 *   HEAD 检查未合入提交、同路径跨节点登记歧义显式 validation_error、
 *   git status 失败 fail closed（绝不当作干净或目录缺失）、登记路径被替换
 *   （改签分支/主工作树/软链/locked/缺失目录）拒绝清理且登记保留、
 *   分支删除部分失败先固化 removed 事实并可重试、从已有 worktree 再派生
 *   定位真正主仓（不嵌套 .helm-worktrees）、持久化元数据含机密显式拒绝。
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
import { WorktreeAllocator, type ManagedWorktreeRecord } from '../src/runtime/worktree.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'
import { PluginHost, type PluginHostBackend } from '../src/plugins/index.js'
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
  /** docStore 原始落库内容（记录状态/branchDeleted 等断言用）。 */
  docs: Map<string, unknown>
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
    docs,
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


/** 经 builtin:workflow 插件工具执行 cleanup_worktree（backend.cleanupWorktree 绑定给定 allocator）。 */
async function executeCleanupTool(
  cleanup: (request: import('@helm/protocol').WorktreeCleanupRequest, signal?: AbortSignal) => Promise<unknown>,
  input: Record<string, unknown>,
): Promise<{ output?: Array<{ type: string; text?: string }>; structuredOutput?: Record<string, unknown>; isError?: boolean }> {
  const dataDir = mkdtempSync(join(tmpdir(), 'helm-wf-tool-'))
  const backend: PluginHostBackend = {
    dispatchTrigger: async () => {},
    submitInput: async () => {},
    createConversation: async () => ({}) as never,
    listConversations: () => [],
    getConversation: () => {
      throw new HelmError('not_found', 'no conv', 404)
    },
    updateConversation: async () => ({}) as never,
    abortConversation: async () => {},
    spawnAgent: async () => ({}),
    runGate: async () => ({ ok: true, output: '' }),
    prepareInterruptedConversations: async () => {},
    cleanupWorktree: (request: import('@helm/protocol').WorktreeCleanupRequest, signal?: AbortSignal) => cleanup(request, signal) as Promise<import('@helm/protocol').WorktreeCleanupResult>,
    invokeAction: async () => ({}),
    listActions: () => [],
    manageConversation: () => () => {},
    markConversationOwnership: () => {},
    createAsk: async () => ({}) as never,
    cancelAsk: async () => {},
    registerAskSeqResolver: () => () => {},
    onEvent: () => () => {},
    emitEvent: () => {},
  }
  const host = new PluginHost({
    dataDir,
    host: backend,
    docs: {
      get: <T>(_key: string, initial: T): T => initial,
      set: () => {},
    },
  })
  try {
    await host.register(createWorkflowPlugin())
    const result = (await host.executeTool('cleanup_worktree', input, { conversationId: 1 })) as {
      output?: Array<{ type: string; text?: string }>
      structuredOutput?: Record<string, unknown>
      isError?: boolean
    }
    return result
  } finally {
    await host.dispose().catch(() => {})
    rmSync(dataDir, { recursive: true, force: true })
  }
}

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

      const dirty = await executeCleanupTool((request, signal) => th.allocator.cleanup({ ...request, signal }), {
        conversationId: childId,
      })
      assert.equal(dirty.isError, true, '脏工作区应返回错误')
      const dirtyText = (dirty.output as Array<{ text: string }>)[0]!.text
      assert.ok(dirtyText.includes('worktree_dirty') || dirtyText.includes('未提交修改'), `错误应含指引：${dirtyText}`)

      const ok = await executeCleanupTool((request, signal) => th.allocator.cleanup({ ...request, signal }), {
        conversationId: childId,
        deleteBranch: true,
        force: true,
      })
      assert.equal(ok.isError, undefined)
      assert.equal(ok.structuredOutput?.['ok'], true)
      assert.equal(ok.structuredOutput?.['removed'], true)
    } finally {
      await th.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. 安全加固：external 登记 / 未合入检查 / 跨节点歧义 / fail closed
// ---------------------------------------------------------------------------

/** 直建 allocator（不经 spawn 链）的轻量夹具。 */
function bareAllocator(docs: Map<string, unknown>, extra?: { isPathInUse?: (nodeId: string, path: string) => boolean; redact?: (t: string) => string }) {
  return new WorktreeAllocator({
    envFabric: createEnvFabric({}),
    docStore: {
      get<T>(key: string, initial: T): T {
        return (docs.get(key) as T | undefined) ?? initial
      },
      set<T>(key: string, value: T): void {
        docs.set(key, value)
      },
    },
    ...(extra?.redact !== undefined ? { redact: extra.redact } : {}),
    ...(extra?.isPathInUse !== undefined ? { isPathInUse: extra.isPathInUse } : {}),
  })
}

/** 从 docStore 读全部受管记录（原始落库内容断言；无文档时空数组）。 */
function rawRecords(docs: Map<string, unknown>): ManagedWorktreeRecord[] {
  return ((docs.get('runtime/worktrees') as { records?: ManagedWorktreeRecord[] } | undefined)?.records ?? []) as ManagedWorktreeRecord[]
}

describe('external 登记与真实清理', { timeout: 60_000 }, () => {
  it('registerExternal 去重同 (nodeId,path)；cleanup 真实移除 external worktree；repoRoot 解析并持久化主工作树', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't7a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      // 手工建一个 external worktree（模拟 herdr worktree.create 产物）。
      const wtPath = join(dir, '.helm-worktrees', 'repo-ext01')
      execFileSync('git', ['worktree', 'add', wtPath, '-b', 'helm/wf-ext01'], { cwd: repo })
      const first = allocator.registerExternal({ nodeId: 'local', path: wtPath, branch: 'helm/wf-ext01', parentConversationId: 1, executionId: 'exec-1' })
      const second = allocator.registerExternal({ nodeId: 'local', path: wtPath, branch: 'helm/wf-ext01', parentConversationId: 1, executionId: 'exec-1' })
      assert.equal(second.id, first.id, '同 (nodeId,path) 登记应去重为一条')
      assert.equal(rawRecords(docs).filter((r) => r.id === first.id).length, 1, '登记记录不得重复堆积')
      assert.equal(first.repoRoot, '', 'external 初始 repoRoot 为空')

      // 干净 external worktree：无 baseCommit 也照常清理（unmerged 相对主 HEAD=0）。
      const result = await allocator.cleanup({ worktreeId: first.id, deleteBranch: true })
      assert.equal(result.removed, true)
      assert.equal(result.branchDeleted, true)
      assert.ok(!existsSync(wtPath), 'external worktree 目录应被移除')
      const after = rawRecords(docs).find((r) => r.id === first.id)!
      assert.equal(after.status, 'removed')
      assert.equal(after.repoRoot, repo, 'repoRoot 应已解析并持久化为真正主工作树')
      // 幂等重放。
      const again = await allocator.cleanup({ worktreeId: first.id })
      assert.equal(again.removed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('external 记录在 worktree 内有未合入提交时（baseCommit 为空）同样拒绝 worktree_dirty', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't7b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const wtPath = join(dir, '.helm-worktrees', 'repo-ext02')
      execFileSync('git', ['worktree', 'add', wtPath, '-b', 'helm/wf-ext02'], { cwd: repo })
      writeFileSync(join(wtPath, 'feat.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: wtPath })
      execFileSync('git', ['commit', '-qm', 'feat'], { cwd: wtPath })
      const record = allocator.registerExternal({ nodeId: 'local', path: wtPath, branch: 'helm/wf-ext02', parentConversationId: 1 })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_dirty')
          const details = err.details as { unmergedCommits?: number }
          assert.ok((details?.unmergedCommits ?? 0) >= 1, 'baseCommit 为空也必须按主工作树 HEAD 报告未合入提交')
          return true
        },
      )
      assert.ok(existsSync(wtPath), '拒绝时目录不得被移除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('同路径跨节点歧义', { timeout: 60_000 }, () => {
  it('多节点同名路径：未指定 nodeId 显式 validation_error；指定 nodeId 或 worktreeId 精确清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const sharedPath = join(dir, 'shared-wt')
      // 两个节点各自登记同一路径（真实 worktree 只建一个；local + 远端
      // 节点同名登记模拟多节点同仓同路径场景——歧义检查在 git 探测之前）。
      execFileSync('git', ['worktree', 'add', sharedPath, '-b', 'helm/spawn-m001'], { cwd: repo })
      const a = allocator.registerExternal({ nodeId: 'local', path: sharedPath, branch: 'helm/spawn-m001', parentConversationId: 1 })
      const b = allocator.registerExternal({ nodeId: 'node-b', path: sharedPath, branch: 'helm/spawn-m001', parentConversationId: 1 })

      await assert.rejects(
        () => allocator.cleanup({ path: sharedPath }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'validation_error')
          assert.ok(err.message.includes('local') && err.message.includes('node-b'), '错误应列出歧义节点')
          return true
        },
      )
      // findActive 同样拒绝歧义查询。
      assert.throws(() => allocator.findActive({ path: sharedPath }), (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal((err as HelmError).code, 'validation_error')
        return true
      })
      // 指定 nodeId 精确清理 local 登记（local env 真实执行 git）。
      // 注：node-b 登记指向同一物理目录，local 清理成功后目录即消失，
      // node-b 记录保留 active（目录缺失场景另行显式报告，见 t10d）。
      const result = await allocator.cleanup({ path: sharedPath, nodeId: 'local', deleteBranch: true })
      assert.equal(result.removed, true)
      assert.equal(rawRecords(docs).find((r) => r.id === a.id)!.status, 'removed')
      assert.equal(rawRecords(docs).find((r) => r.id === b.id)!.status, 'active', '其他节点登记不受影响')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('选择器互斥：worktreeId 与 conversationId/path 互斥；nodeId 仅搭 path；缺选择器 validation_error', { timeout: 60_000 }, async () => {
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    const cases: Array<Record<string, unknown>> = [
      { worktreeId: 'local:/x', conversationId: 1 },
      { worktreeId: 'local:/x', path: '/x' },
      { nodeId: 'local' },
      { conversationId: 1, path: '/x' },
      {},
    ]
    for (const input of cases) {
      await assert.rejects(
        () => allocator.cleanup(input as never),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'validation_error', `input=${JSON.stringify(input)}`)
          return true
        },
      )
    }
  })
})

describe('状态命令失败 fail closed', { timeout: 60_000 }, () => {
  it('git status 失败（索引损坏）不删除、不当作干净、不当作目录缺失', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't9')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 损坏该 worktree 的索引文件：git status 必失败但目录仍在。
      // 链接 worktree 的 --git-dir 即 <主仓>/.git/worktrees/<name>，index 在其下。
      const wtGitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: record.path, encoding: 'utf8' }).trim()
      writeFileSync(join(wtGitDir, 'index'), 'garbage-not-an-index')

      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_check_failed', 'status 失败必须显式报错，绝不静默当干净')
          return true
        },
      )
      assert.ok(existsSync(record.path), 'fail closed 时目录不得被删除')
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)!.status, 'active', '记录保持 active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('登记路径被替换/挪用：归属校验拒绝', { timeout: 60_000 }, () => {
  it('分支被改签（worktree 改 checkout 其他分支）拒绝 worktree_owner_mismatch，force 也不可越过', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 用户在登记路径上改签其他分支。
      execFileSync('git', ['checkout', '-q', '-b', 'human/other'], { cwd: record.path })
      for (const force of [false, true]) {
        await assert.rejects(
          () => allocator.cleanup({ worktreeId: record.id, ...(force ? { force: true } : {}) }),
          (err: unknown) => {
            assert.ok(err instanceof HelmError)
            assert.equal(err.code, 'worktree_owner_mismatch', `force=${force} 也不可越过归属校验`)
            const details = err.details as { reason?: string }
            assert.equal(details?.reason, 'branch_changed')
            return true
          },
        )
      }
      assert.ok(existsSync(record.path), '拒绝时目录不得被移除')
      assert.equal(rawRecords(docs).find((r) => r.id === record.id)!.status, 'active')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('登记路径指向主工作树（repoRoot 被改写为主仓自身）显式拒绝 main_worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 恶意/误操作把记录的 path 改写为主工作树本身（清空后手工塞入记录，
      // 模拟记录被外部篡改）。
      const wtRecords = rawRecords(docs)
      wtRecords.length = 0
      docs.set('runtime/worktrees', {
        version: 1,
        records: [
          {
            ...record,
            id: 'local:' + repo,
            path: repo,
            branch: 'helm/spawn-fake1',
          },
        ],
      })
      // 主仓手工建同名分支，使权威登记 branch 匹配后进入 main-worktree 检查。
      execFileSync('git', ['branch', 'helm/spawn-fake1'], { cwd: repo })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: 'local:' + repo }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_owner_mismatch')
          const details = err.details as { reason?: string }
          assert.equal(details?.reason, 'main_worktree')
          return true
        },
      )
      assert.ok(existsSync(repo), '主工作树绝不被清除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('git worktree lock 后拒绝清理（worktree_locked；force 不可越过）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      execFileSync('git', ['worktree', 'lock', record.path], { cwd: repo })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_locked', 'locked 检查不可被 force 越过')
          return true
        },
      )
      assert.ok(existsSync(record.path))
      execFileSync('git', ['worktree', 'unlock', record.path], { cwd: repo })
      const ok = await allocator.cleanup({ worktreeId: record.id })
      assert.equal(ok.removed, true, '解锁后可正常清理')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录缺失：节点真实 fs 探测证实后显式 worktree_missing 且登记保留（不 prune 全仓）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 外部强删目录（模拟人类清理）。
      rmSync(record.path, { recursive: true, force: true })
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_missing')
          return true
        },
      )
      const after = rawRecords(docs).find((r) => r.id === record.id)!
      assert.equal(after.status, 'active', '缺目录记录保留登记（显式 worktree_missing，不自动 prune）')
      // 分支也未被误删。
      const branchList = execFileSync('git', ['branch', '--list', record.branch], { cwd: repo, encoding: 'utf8' })
      assert.notEqual(branchList.trim(), '', '登记分支不得被顺手删除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('软链替换：登记路径经真实路径解析指向主工作树，拒绝 symlink_redirect/main_worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't10e')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 把登记目录替换为指向主工作树的软链（同名分支已在 allocate 时创建，
      // 权威登记 branch 匹配 → canonical 校验发现跳树）。
      const realPath = record.path
      rmSync(realPath, { recursive: true, force: true })
      const { symlinkSync } = await import('node:fs')
      symlinkSync(repo, realPath)
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_owner_mismatch', '软链跳树必须拒绝')
          return true
        },
      )
      assert.ok(existsSync(repo), '主工作树绝不被清除')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('分支删除部分失败', { timeout: 60_000 }, () => {
  it('worktree 已移除但分支删除失败：记录先置 removed（branchDeleted:false + 诊断），可重试成功', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't11')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 制造分支 ref 锁：git branch -D 必失败（worktree remove 仍成功）。
      // 锁文件为完整 ref 路径 + .lock（.git/refs/heads/helm/spawn-<id>.lock）。
      const refsDir = join(repo, '.git', 'refs', 'heads', 'helm')
      mkdirSync(refsDir, { recursive: true })
      const lockPath = join(refsDir, `spawn-${record.branch.slice('helm/spawn-'.length)}.lock`)
      writeFileSync(lockPath, '')
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id, deleteBranch: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'branch_delete_failed')
          return true
        },
      )
      const after = rawRecords(docs).find((r) => r.id === record.id)!
      assert.equal(after.status, 'removed', 'worktree 已 removed 的事实必须先固化（不可永远 active）')
      assert.equal(after.branchDeleted, false)
      assert.ok((after.branchDeleteError ?? '').length > 0, '失败诊断应保留在记录上')
      assert.ok(!existsSync(record.path), 'worktree 目录已被移除')

      // 解除 ref 锁后重试 deleteBranch（幂等路径）。
      rmSync(lockPath, { force: true })
      const retry = await allocator.cleanup({ worktreeId: record.id, deleteBranch: true })
      assert.equal(retry.removed, false, '重试时 worktree 已移除（removed:false）')
      assert.equal(retry.branchDeleted, true, '重试删除分支成功')
      const final = rawRecords(docs).find((r) => r.id === record.id)!
      assert.equal(final.branchDeleted, true)
      assert.equal(final.branchDeleteError, undefined)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('从已有 worktree 再派生（嵌套隔离）', { timeout: 60_000 }, () => {
  it('sourceCwd 为隔离 worktree 时定位真正主仓：同级分配不嵌套 .helm-worktrees；baseCommit 取实际源 HEAD', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't12')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const parent = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      // 父隔离树内提交（子树基准必须包含它，不得回退到主仓 HEAD）。
      writeFileSync(join(parent.path, 'parent-work.txt'), 'x\n')
      execFileSync('git', ['add', '.'], { cwd: parent.path })
      execFileSync('git', ['commit', '-qm', 'parent work'], { cwd: parent.path })
      const parentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: parent.path, encoding: 'utf8' }).trim()

      const child = await allocator.allocate({ nodeId: 'local', sourceCwd: parent.path, parentConversationId: 1 })
      assert.equal(child.repoRoot, repo, 'repoRoot 应为真正主工作树（不把隔离树当主仓）')
      assert.equal(child.baseCommit, parentHead, 'baseCommit 取实际源 HEAD（含父隔离树已提交改动）')
      // 同级分配：child.path 与 parent.path 同在 <repo>/../.helm-worktrees 下。
      assert.equal(
        dirnameOf(child.path),
        dirnameOf(parent.path),
        '嵌套派生不得反复嵌套 .helm-worktrees',
      )
      assert.ok(existsSync(join(child.path, 'parent-work.txt')), '子树应包含父隔离树已提交内容')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/** POSIX dirname（测试辅助）。 */
function dirnameOf(p: string): string {
  const parts = p.split('/')
  parts.pop()
  return parts.join('/') || '/'
}

describe('持久化元数据机密检查', { timeout: 60_000 }, () => {
  it('registerExternal 路径含已登记 secret：显式 worktree_metadata_secret（含非机密定位字段），绝不 raw 落库', { timeout: 60_000 }, () => {
    const docs = new Map<string, unknown>()
    const SECRET = 'sk-secret-token-123'
    const allocator = bareAllocator(docs, { redact: (t) => t.replaceAll(SECRET, '***') })
    assert.throws(
      () =>
        allocator.registerExternal({
          nodeId: 'local',
          path: `/repo/.helm-worktrees/wt-${SECRET}`,
          branch: 'helm/wf-s1',
          parentConversationId: 7,
          conversationId: 9,
          executionId: 'exec-42',
        }),
      (err: unknown) => {
        assert.ok(err instanceof HelmError)
        assert.equal(err.code, 'worktree_metadata_secret')
        assert.ok(!err.message.includes(SECRET), 'message 绝不泄漏 secret 原文')
        assert.ok(err.message.includes('exec-42'), 'message 应含非机密 executionId 以便定位失败的外部执行')
        assert.ok(err.message.includes('conversationId: 9'), 'message 应含非机密 conversationId')
        return true
      },
    )
    assert.equal(rawRecords(docs).length, 0, '拒绝后不得有任何记录落库')
  })

  it('allocate 目标路径含 secret（redact 差异）同样拒绝且不落库', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't13b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const SECRET = 'sk-alloc-secret-9'
    const allocator = bareAllocator(docs, { redact: (t) => t.replaceAll(SECRET, '***') })
    try {
      // 把主仓目录名改成含 secret 的形态（路径进持久化字段）。
      const secretRepoRoot = join(dir, `repo-${SECRET}`)
      execFileSync('git', ['clone', '-q', repo, secretRepoRoot], { cwd: dir })
      await assert.rejects(
        () => allocator.allocate({ nodeId: 'local', sourceCwd: secretRepoRoot, parentConversationId: 1 }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_metadata_secret')
          assert.ok(!err.message.includes(SECRET))
          return true
        },
      )
      assert.equal(rawRecords(docs).length, 0, '拒绝后不得有任何记录落库')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('cleanup_worktree 工具 schema 扩展', { timeout: 60_000 }, () => {
  it('工具支持 worktreeId/nodeId 参数透传且幂等返回 removed:false', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't14')
    const repo = makeGitRepo(join(dir, 'repo'))
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      const cleanupVia = (request: import('@helm/protocol').WorktreeCleanupRequest, signal?: AbortSignal) =>
        allocator.cleanup({ ...request, signal })
      const ok = await executeCleanupTool(cleanupVia, { worktreeId: record.id, deleteBranch: true })
      assert.equal(ok.isError, undefined)
      const so = ok.structuredOutput as { ok: boolean; removed: boolean; worktreeId: string; branchDeleted: boolean }
      assert.equal(so.ok, true)
      assert.equal(so.removed, true)
      assert.equal(so.worktreeId, record.id)
      assert.equal(so.branchDeleted, true)
      // 幂等重放（按 id）。
      const again = await executeCleanupTool(cleanupVia, { worktreeId: record.id })
      assert.equal((again.structuredOutput as { removed: boolean }).removed, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('ignored 文件保护', { timeout: 60_000 }, () => {
  it('仅含 ignored 文件（.env）的 clean worktree 默认拒绝 worktree_dirty；force 可显式清除', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't15')
    const repo = makeGitRepo(join(dir, 'repo'))
    // 主仓先提交 .gitignore（忽略 .env）。
    writeFileSync(join(repo, '.gitignore'), '.env\n')
    execFileSync('git', ['add', '.gitignore'], { cwd: repo })
    execFileSync('git', ['commit', '-qm', 'ignore env'], { cwd: repo })
    const docs = new Map<string, unknown>()
    const allocator = bareAllocator(docs)
    try {
      const record = await allocator.allocate({ nodeId: 'local', sourceCwd: repo, parentConversationId: 1 })
      writeFileSync(join(record.path, '.env'), 'SECRET=1\n')
      // 默认（force=false）：git status 默认口径为 clean，但 remove 实测会
      // 删掉 ignored 内容——保护必须覆盖。
      await assert.rejects(
        () => allocator.cleanup({ worktreeId: record.id }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_dirty', 'ignored 文件必须计入脏检查（git worktree remove 无 --force 也会删 ignored 内容）')
          const details = err.details as { dirtyFiles?: string[] }
          assert.ok(details?.dirtyFiles?.some((f) => f.includes('.env')), 'details 应列出 ignored 的 .env')
          return true
        },
      )
      assert.ok(existsSync(join(record.path, '.env')), '拒绝时 ignored 文件不得被删')
      // force：显式清除。
      const result = await allocator.cleanup({ worktreeId: record.id, force: true })
      assert.equal(result.removed, true)
      assert.ok(!existsSync(record.path))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
