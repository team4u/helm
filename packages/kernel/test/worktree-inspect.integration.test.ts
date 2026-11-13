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
 * 4. conversationId 选择器与 worktreeId 等价定位同一记录。
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
})
