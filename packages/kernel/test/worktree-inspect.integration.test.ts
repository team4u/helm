/**
 * builtin:workflow 受管 worktree 只读检视集成测试（list_worktrees /
 * inspect_worktree 动作）。
 *
 * 覆盖（经真实 createHelm + faux 模型 + 临时真实 Git 仓库 + 插件公开动作）：
 * 1. 真实 spawnAgent isolation:'worktree' 后 list_worktrees 返回登记元数据；
 * 2. inspect_worktree（worktreeId 精确选择器）在目标节点真实执行 git 只读
 *    命令：未提交文件、领先基线提交、diff 统计与预览均为真实值；
 * 3. 边界诚实性：未登记路径 404、选择器互斥 400、已清理记录返回
 *    unavailableReason=removed（仅元数据，不跑 git）、零选择器 400；
 * 4. conversationId 选择器与 worktreeId 等价定位同一记录；
 * 5. porcelain 首列保留：staged/unstaged/untracked 原行不 trim；
 * 6. 只有 untracked 文件时 status 非空而 diff 为空（契约：untracked 见
 *    状态清单、不进 diff）；
 * 7. 大 diff 超 16KiB 上限被截断（diffTruncated=true 且为真实 diff 前缀）；
 *    脏文件超 200 行时 dirtyFileCount 保留真实总数。
 *
 * 契约纪律：只读检视绝不产生写副作用（检视前后 worktree 内容不变）；
 * 全部经真实 createHelm + builtin:workflow 公开动作验证，不 mock git。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
 */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AgentExecutionInfo, AgentSpawnRequest } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-worktree-inspect-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

/** 真实临时 Git 仓库（git init + 初始 commit；用户级配置隔离）。 */
function makeGitRepo(dir: string): string {
  mkdirSync(dir, { recursive: true })
  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  git(['init', '-q', '-b', 'main'])
  git(['config', 'user.email', 'test@helm.local'])
  git(['config', 'user.name', 'helm-test'])
  writeFileSync(join(dir, 'README.md'), '# repo\n')
  git(['add', '.'])
  git(['commit', '-qm', 'init'])
  return dir
}

interface RuntimeEnv {
  app: Awaited<ReturnType<typeof createHelm>>
  kernel: Awaited<ReturnType<typeof createHelm>>['kernel']
  faux: ReturnType<typeof fauxProvider>
  invoke: {
    listWorktrees(): Promise<Array<Record<string, unknown>>>
    inspectWorktree(input: Record<string, unknown>): Promise<Record<string, unknown>>
    cleanupWorktree(input: Record<string, unknown>): Promise<Record<string, unknown>>
  }
  close(): Promise<void>
}

async function openRuntime(dataDir: string, cwd: string): Promise<RuntimeEnv> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const app = await createHelm({
    dataDir,
    cwd,
    model: 'faux/faux-1',
    models: models as never,
  } as never)
  const kernel = app.kernel
  return {
    app,
    kernel,
    faux,
    invoke: {
      listWorktrees: async (): Promise<Array<Record<string, unknown>>> => {
        const result = (await kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
          worktrees: Array<Record<string, unknown>>
        }
        return result.worktrees
      },
      inspectWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'inspect_worktree', input) as never,
      cleanupWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'cleanup_worktree', input) as never,
    },
    async close() {
      await app.close().catch(() => {})
    },
  }
}

/** 派生一个无工具调用的干净隔离 worktree（无残留文件，便于精确构造状态）。 */
async function spawnCleanWorktree(env: RuntimeEnv): Promise<{ worktreeId: string; path: string; branch: string }> {
  let resolved: AgentExecutionInfo | undefined
  env.faux.setResponses([fauxAssistantMessage('直接完成，无工具调用')])
  await env.kernel.spawnAgent({
    parentConversationId: 1,
    prompt: '在隔离工作树执行任务',
    isolation: 'worktree',
    onResolved: (info) => {
      resolved = info
    },
  } as AgentSpawnRequest)
  assert.ok(resolved?.worktree?.id, '应回传受管 worktree id')
  return {
    worktreeId: resolved!.worktree!.id,
    path: resolved!.worktree!.path,
    branch: resolved!.worktree!.branch,
  }
}

describe('builtin:workflow 受管 worktree 只读检视动作', { timeout: 60_000 }, () => {
  it('spawn 后 list 登记真实元数据；inspect 返回真实 git 只读探测（脏文件/提交/diff）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd > .helm-child-pwd.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('任务完成'),
      ])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '在隔离工作树执行任务',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(resolved?.worktree?.id, '应回传受管 worktree id')
      const worktreeId = resolved!.worktree!.id
      const path = resolved!.worktree!.path
      const branch = resolved!.worktree!.branch
      const childId = resolved!.conversationId!

      // ---- list_worktrees：登记元数据完整且新建在前。----
      const list = await env.invoke.listWorktrees()
      assert.ok(Array.isArray(list) && list.length === 1, `应恰好一条登记（实得 ${list.length}）`)
      const record = list[0]! as Record<string, unknown>
      assert.equal(record['id'], worktreeId)
      assert.equal(record['path'], path)
      assert.equal(record['branch'], branch)
      assert.equal(record['nodeId'], 'local')
      assert.equal(record['status'], 'active')
      assert.equal(record['conversationId'], childId)

      // ---- 工作树内真实改动：未提交文件 + 一个新提交。----
      writeFileSync(join(path, 'draft.txt'), 'uncommitted draft\n')
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      writeFileSync(join(path, 'feature.txt'), 'committed change\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: one commit'])

      // ---- inspect_worktree（worktreeId 精确选择器）。----
      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect['exists'], true)
      assert.equal(inspect['unavailableReason'], undefined)
      assert.equal(inspect['currentBranch'], branch)
      assert.equal(inspect['branchChanged'], undefined, '权威分支与登记一致时不得置 branchChanged')
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 2, 'draft.txt 与 .helm-child-pwd.txt 两个未跟踪文件（feature.txt 已提交不在未提交清单）')
      assert.ok(
        dirtyFiles.some((l) => l.includes('draft.txt')) && dirtyFiles.some((l) => l.includes('.helm-child-pwd.txt')),
        `未提交清单应含两个未跟踪文件（实得 ${JSON.stringify(dirtyFiles)}）`,
      )
      assert.equal(inspect['commitsAhead'], 1, '相对登记 baseCommit 领先 1 个提交')
      assert.equal(inspect['diffBase'], 'baseCommit')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt'), `diff 统计应含已提交改动（实得 ${diffStat}）`)
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+committed change'), 'diff 预览应含新增行内容')
      assert.equal(inspect['diffTruncated'], false)

      // ---- conversationId 选择器定位同一记录（等价入口）。----
      const byConversation = await env.invoke.inspectWorktree({ conversationId: childId })
      assert.equal((byConversation['record'] as Record<string, unknown>)['id'], worktreeId)

      // ---- 只读铁律：检视不产生任何写副作用。----
      assert.equal(existsSync(join(path, 'draft.txt')), true)
      assert.equal(existsSync(join(path, 'feature.txt')), true)
    } finally {
      await env.close()
    }
  })

  it('边界诚实性：未登记路径 404、选择器互斥/零选择器 400、已清理记录仅返回元数据', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('直接完成，无工具调用')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '在隔离工作树执行任务',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const worktreeId = resolved!.worktree!.id

      // 未登记路径：404 not_found（不支持任意目录）。
      await assert.rejects(
        () => env.invoke.inspectWorktree({ path: repo }),
        (err: unknown) => err instanceof Error && /\bnot_found\b|未找到路径/.test(err.message),
      )
      // 零选择器与选择器互斥：400 validation_error。
      await assert.rejects(
        () => env.invoke.inspectWorktree({}),
        (err: unknown) => err instanceof Error && /需提供|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ worktreeId, path: resolved!.worktree!.path }),
        (err: unknown) => err instanceof Error && /互斥|validation_error/.test(err.message),
      )
      await assert.rejects(
        () => env.invoke.inspectWorktree({ nodeId: 'local' }),
        (err: unknown) => err instanceof Error && /需提供|仅可与 path 搭配|validation_error/.test(err.message),
      )

      // diff:false 省略 diff 正文（统计与元数据仍返回）。
      const noDiff = await env.invoke.inspectWorktree({ worktreeId, diff: false })
      assert.equal(noDiff['diffPreview'], undefined)

      // 清理（force：树内可能仍有未提交 gate 产物）后检视：仅元数据 + removed。
      await env.invoke.cleanupWorktree({ worktreeId, force: true })
      const after = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(after['exists'], false)
      assert.equal(after['unavailableReason'], 'removed')
      assert.equal((after['record'] as Record<string, unknown>)['status'], 'removed')
      assert.deepEqual(after['dirtyFiles'], [])
    } finally {
      await env.close()
    }
  })

  it('porcelain 首列保留：先提交 tracked 再 staged/unstaged 改动，状态原行不 trim；diff 覆盖 tracked 改动且不含 untracked', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't3')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })

      // 先提交 tracked 文件，再构造 staged/unstaged/untracked 三类改动。
      writeFileSync(join(path, 'feature.txt'), 'v1\n')
      git(['add', 'feature.txt'])
      git(['commit', '-qm', 'feat: tracked file'])
      writeFileSync(join(path, 'feature.txt'), 'v2 unstaged body\n') // 未暂存修改（首列为空格）
      writeFileSync(join(path, 'staged.txt'), 'staged new body\n')
      git(['add', 'staged.txt']) // 暂存新增（首列 A）
      writeFileSync(join(path, 'README.md'), '# repo modified\n')
      git(['add', 'README.md']) // 暂存修改（首列 M）
      writeFileSync(join(path, 'untracked.txt'), 'only untracked body\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(inspect['dirtyFileCount'], 4)
      // 原行保留：XY 首列与列间空格绝无 trim。
      assert.ok(dirtyFiles.includes(' M feature.txt'), `未暂存首列空格必须保留（实得 ${JSON.stringify(dirtyFiles)}）`)
      assert.ok(dirtyFiles.includes('A  staged.txt'), `暂存新增首列 A 必须保留（实得 ${JSON.stringify(dirtyFiles)}）`)
      assert.ok(dirtyFiles.includes('M  README.md'), `暂存修改首列 M 必须保留（实得 ${JSON.stringify(dirtyFiles)}）`)
      assert.ok(dirtyFiles.includes('?? untracked.txt'), `未跟踪原行 ?? 必须保留（实得 ${JSON.stringify(dirtyFiles)}）`)
      assert.equal(inspect['dirtyFilesTruncated'], false)

      // diff（相对 baseCommit）覆盖 staged + unstaged 的 tracked 改动，不含 untracked。
      const diffPreview = inspect['diffPreview'] as string
      assert.ok(diffPreview.includes('+v2 unstaged body'), 'diff 应含未暂存修改内容')
      assert.ok(diffPreview.includes('+staged new body'), 'diff 应含暂存新增内容')
      assert.ok(!diffPreview.includes('untracked.txt'), 'untracked 文件不得进入 diff')
      const diffStat = inspect['diffStat'] as string
      assert.ok(diffStat.includes('feature.txt') && diffStat.includes('staged.txt'))
      assert.ok(!diffStat.includes('untracked.txt'), 'untracked 文件不得进入 diff 统计')
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('只有 untracked 文件：status 非空而 diff 为空（untracked 见状态清单、不进 diff 契约）', {
    timeout: 60_000,
  }, async () => {
    const dir = join(rootDir, 't4')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      writeFileSync(join(path, 'untracked-only.txt'), 'only untracked\n')

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      assert.equal(inspect['dirtyFileCount'], 1)
      assert.deepEqual(inspect['dirtyFiles'], ['?? untracked-only.txt'])
      // 契约：无 tracked 改动时 diff 与统计均为空（undefined），而非伪造空串。
      assert.equal(inspect['diffStat'], undefined)
      assert.equal(inspect['diffPreview'], undefined)
      assert.equal(inspect['diffTruncated'], false)
    } finally {
      await env.close()
    }
  })

  it('大 diff 超 16KiB 截断为真实前缀；脏文件超 200 行保留真实总数与截断标记', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const { worktreeId, path } = await spawnCleanWorktree(env)
      const git = (args: string[]) => execFileSync('git', args, { cwd: path, encoding: 'utf-8' })
      // 单文件大改动（约 33KiB > 16KiB 预览上限）提交为 tracked 改动。
      const bigBody = Array.from({ length: 480 }, (_, i) => `line-${String(i).padStart(3, '0')}-${'x'.repeat(60)}`).join('\n')
      writeFileSync(join(path, 'big-change.txt'), `${bigBody}\n`)
      git(['add', 'big-change.txt'])
      git(['commit', '-qm', 'feat: big change'])
      // 205 个未跟踪文件（超出 200 行保留上限，真实计数必须保留）。
      for (let i = 0; i < 205; i++) {
        writeFileSync(join(path, `u-${String(i).padStart(3, '0')}.txt`), 'x\n')
      }

      const inspect = await env.invoke.inspectWorktree({ worktreeId })
      // diff 预览：采集阶段先到先截，恰好为上限字符数且是真实 diff 的前缀。
      assert.equal(inspect['diffTruncated'], true)
      const diffPreview = inspect['diffPreview'] as string
      assert.equal(diffPreview.length, 16_384, '预览应恰好为上限字符数')
      const base = (inspect['record'] as Record<string, unknown>)['baseCommit'] as string
      const realDiff = execFileSync('git', ['diff', '--no-ext-diff', '--no-textconv', base], {
        cwd: path,
        encoding: 'utf-8',
      })
      assert.ok(realDiff.length > 16_384, '测试前提：真实 diff 超过预览上限')
      assert.equal(diffPreview, realDiff.slice(0, 16_384), '预览必须是真实 diff 的前缀')
      // 状态清单：保留前 200 条原行，真实总数 205 不失真。
      const dirtyFiles = inspect['dirtyFiles'] as string[]
      assert.equal(dirtyFiles.length, 200)
      assert.equal(inspect['dirtyFileCount'], 205, '非空状态行真实总数不得因截断失真')
      assert.equal(inspect['dirtyFilesTruncated'], true)
      assert.ok(dirtyFiles[0]!.startsWith('?? u-'), '保留原行（含 ?? 首列）')
      // 统计未超上限（单文件大改动 --stat 很短）：不得误标截断。
      const diffStat = inspect['diffStat'] as string
      assert.ok(!diffStat.includes('截断'), `统计未超上限时不得附截断说明（实得 ${diffStat}）`)
    } finally {
      await env.close()
    }
  })
})
