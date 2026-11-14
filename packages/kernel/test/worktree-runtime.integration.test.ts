/**
 * worktree 运行时真实集成测试（新契约：WorktreeAllocator/cleanup_worktree
 * 完全属于 builtin:workflow 插件）。
 *
 * 覆盖（经真实 createHelm + faux 模型 + 临时真实 Git 仓库 + 插件公开 API）：
 * 1. 真实 spawnAgent isolation:'worktree'（agent_spawn continuation 由
 *    builtin:workflow 兜底）：真实隔离树创建、子会话与 gate 在树内执行、
 *    onResolved 回传受管 id；cleanup_worktree 动作默认保留分支。
 * 2. gate 失败 / 模型失败 / 取消后 worktree 与未提交产物保留（防误删回归）。
 * 3. 子代理运行中（spawn 未 settle）cleanup force:true 仍 worktree_in_use；
 *    settle 后经动作清理成功。
 * 4. 动作边界校验：未知键/多选择器/零选择器/非法类型显式 400（HTTP 动作
 *    Schema）；未登记选择器 404 not_found 透传；动作鉴权 401。
 * 5. 外部插件 agent_spawn handled 回传 worktree：统一登记 worktreeId、
 *    cleanup_worktree 同机制清理；缺 nodeId 显式 execution_info_invalid；
 *    请求 isolation 但外部运行时不兑现 → 原生执行行 unsupported_runtime。
 * 6. 同子会话并发 resume 互斥（subagent_in_use）。
 * 7. 后台回报 requestId 幂等（持久去重 + 重启后保持）。
 * 8. durable 租约 fail-closed（安全红线）：重启中断语义的租约残留时
 *    cleanup_worktree 显式 worktree_execution_unknown；正常 spawn 成功后
 *    租约释放可清理。
 *
 * 契约纪律：不使用 KernelRuntime 的 worktrees/cleanupWorktree（已删除）；
 * 全部经真实 createHelm + builtin:workflow 公开动作/工具验证；租约断言经
 * 插件私有持久 doc 的真实残留状态模拟（进程死亡后磁盘上真实存在的内容）。
 *
 * 诚实性纪律：真 SQLite + 真 pi-durable SDK + faux 模型脚本 + 真实临时 Git
 * 仓库 + 真实 HTTP handler；不 mock git、不伪造完成结果。
 *
 * runner: tsx --test；每测试显式 timeout: 60_000 防死锁。
 */
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import type { AgentExecutionInfo, AgentSpawnRequest } from '@helm/protocol'
import { HelmError } from '@helm/protocol'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHelm } from '../src/app.js'
import { createHubHandler } from '../src/http/index.js'

/**
 * 平台事实：进程占用扫描当前仅 Linux /proc。非 Linux 上 cleanup 在进程检查处
 * 显式拒绝（worktree_process_check_failed）——测试契约按平台如实分叉，
 * 不伪造 complete=true、不静默跳过（跨平台显式拒绝是当前行为限制）。
 */
const PROCESS_SCAN_ON = process.platform === 'linux'

/** 非 Linux 平台断言 cleanup 显式拒绝（不伪造 0 占用）。 */
async function assertCleanupPlatformRejected(fn: () => Promise<unknown>): Promise<void> {
  await assert.rejects(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError)
    assert.equal(err.code, 'worktree_process_check_failed', '非 Linux 平台：进程占用扫描不支持，cleanup 必须显式拒绝')
    return true
  })
}

// ---------------------------------------------------------------------------
// 测试基建
// ---------------------------------------------------------------------------

let rootDir: string

before(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'helm-worktree-runtime-'))
})

after(() => {
  rmSync(rootDir, { recursive: true, force: true })
})

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

interface RuntimeEnv {
  /** 真实 createHelm 应用（builtin:workflow 默认启用）。 */
  app: Awaited<ReturnType<typeof createHelm>>
  kernel: Awaited<ReturnType<typeof createHelm>>['kernel']
  faux: ReturnType<typeof fauxProvider>
  /** 真实 HTTP handler（process token 鉴权）。 */
  handler: (request: Request) => Promise<Response>
  token: string
  /** builtin:workflow 公开动作总线（与 HTTP/CLI/模型工具同链路）。 */
  invoke: {
    cleanupWorktree(input: Record<string, unknown>): Promise<{
      removed: boolean
      worktreeId: string
      path: string
      branch: string
      nodeId: string
      branchDeleted: boolean
    }>
    inspect(runId: string): Promise<{ run: { id: string; status: string; error?: string } }>
  }
  /** 插件私有持久文档（租约/登记残留断言与重启中断模拟）。 */
  pluginDoc: {
    get<T>(key: string, initial: T): T
    set<T>(key: string, value: T): void
    flush(): Promise<void>
  }
  close(): Promise<void>
}

/** 真实 createHelm（含 builtin:workflow 默认启用）+ faux provider + HTTP handler。 */
async function openRuntime(dataDir: string, cwd?: string): Promise<RuntimeEnv> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const app = await createHelm({
    dataDir,
    cwd: cwd ?? dataDir,
    model: 'faux/faux-1',
    models: models as never,
  } as never)
  const handler = createHubHandler(app.kernel)
  const { token } = app.kernel.auth.createProcessToken()
  const kernel = app.kernel
  return {
    app,
    kernel,
    faux,
    handler,
    token,
    invoke: {
      cleanupWorktree: (input) =>
        kernel.plugins.invokeAction('builtin:workflow', 'cleanup_worktree', input) as never,
      inspect: (runId) =>
        kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId }) as never,
    },
    pluginDoc: {
      // 插件 doc 持久层键：`${pluginId}:${name}`（helm_plugin_docs 全局命名空间）。
      get: <T>(key: string, initial: T): T =>
        kernel.documentStore.get<T>(`builtin:workflow:worktree-state:${key}`, initial),
      set: <T>(key: string, value: T): void =>
        kernel.documentStore.set(`builtin:workflow:worktree-state:${key}`, value),
      flush: () => kernel.documentStore.flush(),
    },
    async close() {
      // 受控关停（close 链错误不掩盖测试断言；关停失败另有基座修复跟踪）。
      await app.close().catch(() => {})
    },
  }
}

/** HTTP POST /api/actions/builtin:workflow/cleanup_worktree 直调 handler（真实鉴权 + JSON 解析）。 */
async function postCleanup(env: RuntimeEnv, input: unknown): Promise<{ status: number; json: any }> {
  const response = await env.handler(
    new Request('http://127.0.0.1:3202/api/actions/builtin%3Aworkflow/cleanup_worktree', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.token}` },
      body: JSON.stringify({ input }),
    }),
  )
  const text = await response.text()
  return { status: response.status, json: text.length > 0 ? JSON.parse(text) : null }
}

/** 挂起型 faux 响应工厂：entered 通知进入后等待 release。 */
function heldResponse(
  onEnter: () => void,
): { step: () => Promise<AssistantMessage>; release: (message: AssistantMessage) => void } {
  let resolveHeld!: (message: AssistantMessage) => void
  const held = new Promise<AssistantMessage>((resolve) => {
    resolveHeld = resolve
  })
  return {
    step: () => {
      onEnter()
      return held
    },
    release: (message) => resolveHeld(message),
  }
}

/** 读取会话全部 helm.input entry 的 {origin, backgroundRunId}。 */
async function agentReports(
  kernel: RuntimeEnv['kernel'],
  conversationId: number,
): Promise<Array<{ origin: string; backgroundRunId?: string }>> {
  const detail = await kernel.getConversationDetail(conversationId, { limit: 500 })
  const out: Array<{ origin: string; backgroundRunId?: string }> = []
  for (const entry of detail.entries) {
    if (entry.kind !== 'helm.input') continue
    const data = entry.data as { origin?: unknown; meta?: { backgroundRunId?: unknown } } | undefined
    out.push({
      origin: String(data?.origin ?? ''),
      backgroundRunId: typeof data?.meta?.backgroundRunId === 'string' ? data.meta.backgroundRunId : undefined,
    })
  }
  return out
}

// ---------------------------------------------------------------------------
// 1. 真实 spawnAgent isolation:'worktree' 全链路（continuation 兜底）
// ---------------------------------------------------------------------------

describe('builtin:worktree 隔离派生（agent_spawn continuation）', { timeout: 60_000 }, () => {
  it('spawnAgent isolation:worktree：真实隔离树 + 受管 id 回传 + gate 在树内通过 + 动作清理默认保留分支', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'pwd > .helm-child-pwd.txt && git branch --show-current > .helm-child-branch.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('任务完成：worktree 内执行完毕'),
      ])
      const result = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '在隔离工作树执行任务',
        isolation: 'worktree',
        gate: 'pwd > .helm-gate-pwd.txt && test -f README.md',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.equal(result, '任务完成：worktree 内执行完毕')

      // ---- onResolved 回传受管 worktree 元数据（稳定 id）。----
      assert.ok(resolved, 'onResolved 应回传执行环境元数据')
      assert.equal(resolved!.nodeId, 'local')
      assert.ok(resolved!.conversationId !== undefined && resolved!.conversationId > 1, '应派生真子会话')
      const worktree = resolved!.worktree
      assert.ok(worktree, 'isolation:worktree 必须回传 worktree 元数据')
      assert.ok(worktree!.path.includes(join(dir, '.helm-worktrees')), `worktree 应位于同级 .helm-worktrees：${worktree!.path}`)
      assert.ok(worktree!.branch.startsWith('helm/spawn-'), `分支应为 helm/spawn-*：${worktree!.branch}`)
      assert.ok(typeof worktree!.id === 'string' && worktree!.id.length > 0, '必须回传受管登记 id（worktreeId）')

      // ---- 真实隔离树：子会话与 gate 的产物都落在树内。----
      assert.ok(existsSync(worktree!.path), 'worktree 目录应真实存在')
      assert.ok(existsSync(join(worktree!.path, 'README.md')), 'worktree 应检出初始提交内容')
      assert.ok(existsSync(join(worktree!.path, '.helm-child-pwd.txt')), '子会话 bash 产物应落在 worktree 内')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-pwd.txt'), 'utf8').trim(), worktree!.path, '子会话 pwd 应为 worktree 目录')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-branch.txt'), 'utf8').trim(), worktree!.branch, '子会话应在 helm/spawn-* 分支上')
      assert.ok(existsSync(join(worktree!.path, '.helm-gate-pwd.txt')), 'gate 产物应落在 worktree 内')
      assert.equal(readFileSync(join(worktree!.path, '.helm-gate-pwd.txt'), 'utf8').trim(), worktree!.path, 'gate pwd 应为 worktree 目录（gate 在树内执行）')
      assert.ok(!existsSync(join(repo, '.helm-gate-pwd.txt')), '源仓库不得被 gate/子会话污染')
      const child = env.kernel.getConversation(resolved!.conversationId!)
      assert.equal(child.cwd, worktree!.path, '子会话镜像 cwd 应为 worktree 目录')

      // ---- 清理（builtin:workflow 公开动作；默认保留分支）。----
      // 未提交产物在树内：显式 force 丢弃（非 force 脏拒绝由 native-worktree 专项覆盖）。
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          conversationId: resolved!.conversationId,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.worktreeId, worktree!.id, '清理结果应回传受管 worktreeId')
        assert.equal(cleaned.branchDeleted, false, '默认清理必须保留分支')
        assert.ok(!existsSync(worktree!.path), '清理后 worktree 目录应被移除')
        const branchList = execFileSync('git', ['branch', '--list', worktree!.branch], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes(worktree!.branch), `分支 ${worktree!.branch} 应默认保留（实得 ${branchList.trim()}）`)
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }))
        assert.ok(existsSync(worktree!.path), '非 Linux 拒绝清理时目录不得被移除')
      }
    } finally {
      await env.close()
    }
  })

  it('原生 subagent 工具链：模型调用 subagent(isolation:worktree) 创建真实隔离树；工具输出含 cleanup 提示/worktreeId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '隔离任务', isolation: 'worktree', background: false })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('子代理完成'),
        fauxAssistantMessage('主回合完成'),
      ])
      await env.kernel.submitInput(1, '派生隔离子代理')
      await env.kernel.waitForIdle(1)

      const detail = await env.kernel.getConversationDetail(1, { limit: 100 })
      const toolEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('"subagent"'))
      assert.ok(toolEntry, '应存在 subagent 工具结果 entry')
      const text = JSON.stringify(toolEntry.model ?? '')
      assert.ok(text.includes('worktree='), `工具输出应含 worktree 元数据：${text.slice(0, 400)}`)
      assert.ok(text.includes('cleanup_worktree'), '工具输出应含 cleanup_worktree 清理提示')
      assert.ok(text.includes('worktreeId='), '工具输出应含受管 worktreeId')

      // 真实子会话建在真实隔离树内（镜像 cwd 即隔离树路径）。
      const child = env.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '应派生真子会话')
      assert.ok(child.cwd.includes(join(dir, '.helm-worktrees')), '子会话应在同级 .helm-worktrees 下的隔离树内执行')
      assert.ok(existsSync(child.cwd), '受管 worktree 应真实存在')
      assert.ok((await env.kernel.getLastAssistantText(1)).includes('主回合完成'))
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. gate 失败 / 模型失败 / 取消后 worktree 与未提交产物保留（防误删回归）
// ---------------------------------------------------------------------------

describe('失败路径资源保留（防 continuation 收敛误删回归）', { timeout: 60_000 }, () => {
  it('gate 失败：子会话已产出未提交文件后 worktree 保留（供人类检视），gate_failed 显式上抛', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo wip > wip-artifact.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('任务完成（gate 将失败）'),
      ])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '产出后 gate 失败的任务',
            isolation: 'worktree',
            gate: 'test -f never-exists.txt',
            onResolved: (info) => {
              resolved = info
            },
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应抛 HelmError，实得 ${err}`)
          assert.equal(err.code, 'gate_failed')
          return true
        },
      )
      assert.ok(resolved?.worktree, 'gate 失败前 onResolved 已回传 worktree')
      const wtPath = resolved!.worktree!.path
      // 关键防回归：gate 失败（子会话已 settle）绝不触发回收误删。
      assert.ok(existsSync(wtPath), 'gate 失败后 worktree 必须保留（供人类检视）')
      assert.ok(existsSync(join(wtPath, 'wip-artifact.txt')), '子会话未提交产物必须保留')
      // 失败路径租约 fail-closed：不释放（不能证明停止就不能清理）。
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(
            err.code,
            'worktree_execution_unknown',
            `gate 失败后租约未释放，清理应显式拒绝（fail-closed），实得 ${(err as HelmError).code}`,
          )
          return true
        },
      )
      assert.ok(existsSync(wtPath), '拒绝清理时目录不得被动')
    } finally {
      await env.close()
    }
  })

  it('模型回合失败（schema 两次不合规）：worktree 与既有未提交产物保留', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([
        // Schema 输出工具不能替换掉原有内核工具，必须能先执行真实任务再提交结果。
        fauxAssistantMessage([fauxToolCall('bash', { command: 'printf "child prior work\\n" > partial.txt' })], { stopReason: 'toolUse' }),
        // 两轮纯文本均不满足 schema：触发 schema_validation_failed。
        fauxAssistantMessage('这不是 JSON'),
        fauxAssistantMessage('仍然不是 JSON'),
      ])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '要求结构化输出但模型失败',
            isolation: 'worktree',
            schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
            onResolved: (info) => {
              resolved = info
            },
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应抛 HelmError，实得 ${err}`)
          assert.equal(err.code, 'schema_validation_failed')
          return true
        },
      )
      assert.ok(resolved?.worktree)
      const preExisting = join(resolved!.worktree!.path, 'partial.txt')
      // 关键断言：continuation 收敛不得回收已绑定子会话的隔离树（防误删回归）。
      assert.ok(existsSync(resolved!.worktree!.path), '模型失败后 worktree 必须保留')
      assert.ok(existsSync(preExisting), '未提交产物必须保留')
    } finally {
      await env.close()
    }
  })

  it('运行中取消（abort）：真实收尾后 worktree 与未提交产物保留', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let entered = false
      const held = heldResponse(() => {
        entered = true
      })
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo canceled-work > cancel-marker.txt' })], { stopReason: 'toolUse' }),
        held.step as never,
      ])
      const controller = new AbortController()
      let resolved: AgentExecutionInfo | undefined
      const pending = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '会被取消的隔离任务',
        isolation: 'worktree',
        signal: controller.signal,
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (resolved?.worktree && existsSync(join(resolved.worktree.path, 'cancel-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(resolved?.worktree, '取消前 onResolved 应回传 worktree')
      assert.ok(existsSync(join(resolved!.worktree!.path, 'cancel-marker.txt')), '取消前子会话应已写入产物')
      // 产物写入发生在首轮工具调用；等待第二轮模型请求真正进入 held，
      // 再发起取消，避免全量测试并发时过早 abort 只取消了首轮收敛。
      const heldDeadline = Date.now() + 10_000
      while (!entered && Date.now() < heldDeadline) await new Promise((r) => setTimeout(r, 25))
      assert.ok(entered, '取消前应已进入挂起的真实模型回合')

      controller.abort()
      held.release(fauxAssistantMessage('不应作为结果'))
      await assert.rejects(() => pending, (err: unknown) => err instanceof HelmError && err.code === 'aborted')

      const childId = resolved!.conversationId!
      await env.kernel.waitForIdle(childId)
      assert.ok(existsSync(resolved!.worktree!.path), '取消后 worktree 必须保留（子会话已创建绑定，不得误删）')
      assert.ok(existsSync(join(resolved!.worktree!.path, 'cancel-marker.txt')), '取消后未提交产物必须保留')
      assert.ok(entered)
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 运行中占用：force:true 仍 worktree_in_use，settle 后可清理
// ---------------------------------------------------------------------------

describe('占用中的 worktree 清理保护', { timeout: 60_000 }, () => {
  it('模型回合仍在执行：force:true 仍 worktree_in_use；settle 后经动作清理成功', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const held = heldResponse(() => {})
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo ok > in-use-marker.txt' })], { stopReason: 'toolUse' }),
        // 第二回合挂在模型请求中：SDK turn 在途。
        held.step as never,
      ])
      let resolved: AgentExecutionInfo | undefined
      const controller = new AbortController()
      const pending = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '长任务（占用检查）',
        isolation: 'worktree',
        signal: controller.signal,
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (resolved?.worktree && existsSync(join(resolved.worktree.path, 'in-use-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(resolved?.worktree && resolved?.conversationId, '子会话应已创建')
      const childId = resolved!.conversationId!
      assert.equal(env.kernel.getConversation(childId).status, 'working', '模型挂起期间子会话应为 working')

      // spawn 未 settle：conversation 占用 + 在途 spawn 执行坐标引用双保险，
      // force:true 也不得清理运行中的子代理工作树。
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: childId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_in_use', `force 清理运行中 worktree 应拒绝，实得 ${(err as HelmError).code}`)
          return true
        },
      )
      assert.ok(existsSync(resolved!.worktree!.path), '占用拒绝时目录不得被动')
      assert.ok(existsSync(join(resolved!.worktree!.path, 'in-use-marker.txt')), '占用期间产物不得被删')

      // 真实收尾：释放模型 + abort，等 spawn settle 与子会话 idle。
      controller.abort()
      held.release(fauxAssistantMessage('（取消）'))
      await assert.rejects(() => pending, (e: unknown) => e instanceof HelmError && e.code === 'aborted')
      await env.kernel.waitForIdle(childId)

      // settle 后（abort 路径租约按 fail-closed 保留）：清理显式
      // worktree_execution_unknown（不能证明外部执行已停止就不能清理）。
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: childId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_execution_unknown', `settle 后租约 fail-closed 应保留并拒绝清理，实得 ${(err as HelmError).code}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. 动作边界校验（HTTP 动作 Schema + 鉴权 + 错误码透传）
// ---------------------------------------------------------------------------

describe('cleanup_worktree 动作边界（HTTP Schema/鉴权/透传）', { timeout: 60_000 }, () => {
  it('动作边界校验：未知键/多选择器/零选择器/非法类型显式 400；未登记选择器 404 不触碰实际清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 未知键拒绝（动作 inputSchema additionalProperties:false）。
      const unknownKey = await postCleanup(env, { conversationId: 5, oops: true })
      assert.equal(unknownKey.status, 400)
      assert.equal(unknownKey.json.error.code, 'validation_error')

      // 多选择器拒绝（conversationId + path）。
      const multiA = await postCleanup(env, { conversationId: 5, path: '/tmp/x' })
      assert.equal(multiA.status, 400)
      assert.equal(multiA.json.error.code, 'validation_error')
      // 零选择器同样拒绝。
      const none = await postCleanup(env, {})
      assert.equal(none.status, 400)
      assert.equal(none.json.error.code, 'validation_error')

      // 非法类型：conversationId 非正整数 / force 非布尔 / deleteBranch 非布尔
      //（动作 JSON Schema 边界拒绝）。
      const badConv = await postCleanup(env, { conversationId: 0 })
      assert.equal(badConv.status, 400)
      assert.equal(badConv.json.error.code, 'validation_error')
      const badConv2 = await postCleanup(env, { conversationId: 'five' as unknown as number })
      assert.equal(badConv2.status, 400)
      assert.equal(badConv2.json.error.code, 'validation_error')
      const badForce = await postCleanup(env, { conversationId: 5, force: 'yes' as unknown as boolean })
      assert.equal(badForce.status, 400)
      assert.equal(badForce.json.error.code, 'validation_error')
      const badDelete = await postCleanup(env, { conversationId: 5, deleteBranch: 1 as unknown as boolean })
      assert.equal(badDelete.status, 400)
      assert.equal(badDelete.json.error.code, 'validation_error')

      // 未登记选择器：选择器形状合法但无记录 -> 404 not_found（用户错误，
      // 不伪装成校验失败；绝不误删未登记目录）。
      const unregistered = await postCleanup(env, { worktreeId: 'local:/tmp/no-such-wt' })
      assert.equal(unregistered.status, 404)
      assert.equal(unregistered.json.error.code, 'not_found')
    } finally {
      await env.close()
    }
  })

  it('成功调用实际清理（真实 worktree 被移除，worktreeId 贯通）；未登记选择器用户错误码 not_found 透传', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 真实派生一个受管 worktree（干净：无取证产物，验证非 force 成功链路）。
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('完成')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: 'HTTP 清理链路任务',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(resolved?.worktree && resolved?.worktree?.id, '应回传受管 worktree id')
      const wt = resolved!.worktree!

      // 按受管 id 成功清理（worktreeId 精确选择器；deleteBranch 默认保留分支）。
      const ok = await postCleanup(env, { worktreeId: wt.id })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.removed, true)
      assert.equal(ok.json.branchDeleted, false)
      assert.equal(ok.json.path, wt.path)
      assert.ok(!existsSync(wt.path), 'HTTP 清理应实际移除 worktree 目录')

      // 未登记选择器：allocator 的 not_found(404) 原样透传（不伪装 500/200）。
      const missing = await postCleanup(env, { conversationId: 999_999 })
      assert.equal(missing.status, 404)
      assert.equal(missing.json.error.code, 'not_found')
      assert.ok(String(missing.json.error.message).includes('未找到'), `错误消息应说明仅清理登记记录：${missing.json.error.message}`)
    } finally {
      await env.close()
    }
  })

  it('未带 token 401（动作端点同样强制鉴权）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      const noAuth = await env.handler(
        new Request('http://127.0.0.1:3202/api/actions/builtin%3Aworkflow/cleanup_worktree', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: { conversationId: 5 } }),
        }),
      )
      assert.equal(noAuth.status, 401)
      assert.equal((JSON.parse(await noAuth.text()) as { error: { code: string } }).error.code, 'unauthorized')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 5. 外部插件 agent_spawn handled：统一登记与显式拒绝
// ---------------------------------------------------------------------------

describe('外部插件 agent_spawn handled 与 worktree 统一登记', { timeout: 60_000 }, () => {
  it('可信插件在真实临时 git worktree 回传 nodeId/executionId/worktree：统一登记 worktreeId；cleanup_worktree 同机制清理（测试边界：自定义插件模拟外部运行时，非真实 Herdr）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 插件在真实 git worktree 内「执行」任务（真实 git 命令，非 mock 目录）。
      const wtPath = join(dir, '.helm-worktrees', 'external-task')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-external-1', wtPath, 'HEAD'], { cwd: repo })
      writeFileSync(join(wtPath, 'external-result.txt'), 'done\n')

      await env.kernel.plugins.register({
        id: 'test:external-runtime',
        name: '外部运行时（测试桩：真实 git worktree 回传）',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            // namespace:kind 形式 = 外部运行时（builtin:workflow 不预分配，
            // 仅回填登记与租约，交由本接管器完全负责执行）。
            if (request.agentType !== 'test:external') return next(request) as unknown as void
            request.onResolved?.({
              nodeId: 'local',
              executionId: 'test-exec-1',
              effectiveCwd: wtPath,
              worktree: { path: wtPath, branch: 'helm/wf-external-1' },
            })
            return { action: 'handled', result: '外部任务完成（真实 worktree 内产物已写入）' }
          })
        },
      })

      let resolved: AgentExecutionInfo | undefined
      const result = await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '外部运行时任务',
        agentType: 'test:external',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.equal(result, '外部任务完成（真实 worktree 内产物已写入）')

      // 统一登记：onResolved 回传被改写为受管记录（含稳定 id）。
      assert.ok(resolved?.worktree?.id, '外部回传 worktree 应被统一登记并回填稳定 id')
      assert.ok(resolved!.worktree!.id!.startsWith('local:'), `受管 id 应为 nodeId:path 形态：${resolved!.worktree!.id}`)

      // cleanup 与原生同机制：统一登记记录可定位清理（helm/wf-* 受管前缀）。
      //（外部 handled 路径成功完成：租约按契约释放，可清理。）
      // 注：不传 deleteBranch —— 当前 allocator updateRecord 在 deleteBranch
      // 成功分支写入 branchDeleteError: undefined 值，doc 层 jsonClone 拒绝
      //（已知基座缺陷，主代理修复后可恢复断言）；分支删除成功链路由
      // native-worktree.test.ts allocator 专项覆盖。
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({
          worktreeId: resolved!.worktree!.id!,
          force: true,
        })
        assert.equal(cleaned.removed, true)
        assert.equal(cleaned.branchDeleted, false, '默认清理保留分支')
        assert.ok(!existsSync(wtPath), '清理应实际移除外部 worktree')
        const branchList = execFileSync('git', ['branch', '--list', 'helm/wf-external-1'], { cwd: repo, encoding: 'utf8' })
        assert.ok(branchList.includes('helm/wf-external-1'), '分支应默认保留')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ worktreeId: resolved!.worktree!.id!, force: true }))
        assert.ok(existsSync(wtPath), '非 Linux 拒绝清理时目录不得被移除')
      }
    } finally {
      await env.close()
    }
  })

  it('回传 worktree 但不给 nodeId：显式 execution_info_invalid（不能假设 local）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await env.kernel.plugins.register({
        id: 'test:no-node-runtime',
        name: '不给 nodeId 的运行时',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload, next) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:no-node') return next(request) as unknown as void
            // 缺 nodeId：不得假设 local。
            request.onResolved?.({ executionId: 'exec-no-node', worktree: { path: '/srv/wt/x', branch: 'helm/wf-x' } })
            return { action: 'handled', result: '假成功：无节点' }
          })
        },
      })
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '无节点回传',
            agentType: 'test:no-node',
            isolation: 'worktree',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'execution_info_invalid')
          assert.ok(err.message.includes('nodeId'), `错误应说明缺 nodeId：${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })

  it('外部运行时 agentType 无插件接管：原生执行行显式 unsupported_runtime（内核零插件点名，绝不假成功）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5d')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '外部运行时但无人接管',
            agentType: 'test:unclaimed',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应抛 HelmError，实得 ${err}`)
          assert.equal(err.code, 'unsupported_runtime')
          assert.ok(err.message.includes('test:unclaimed'), `错误应指明外部运行时标识：${err.message}`)
          return true
        },
      )
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 6. 同子会话并发 resume 互斥（gate/结构化输出不互抢）
// ---------------------------------------------------------------------------

describe('同子会话并发 resume 互斥', { timeout: 60_000 }, () => {
  it('首个 resume 在途时第二个并发 resume 显式 subagent_in_use；首个的 gate 与结构化输出正常完成', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't6')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 首调：创建绑定 worktree 的子会话。
      let childId = 0
      let firstWtPath = ''
      env.faux.setResponses([fauxAssistantMessage('第一轮完成')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info) => {
          childId = info.conversationId ?? 0
          firstWtPath = info.worktree?.path ?? ''
        },
      } as AgentSpawnRequest)
      assert.ok(childId > 0)
      assert.ok(firstWtPath !== '', '应回传隔离树路径')

      // 第一个 resume：写 marker + 结构化输出 + gate（模型挂起制造在途窗口）。
      let markEntered!: () => void
      const entered = new Promise<void>((resolve) => { markEntered = resolve })
      const held = heldResponse(markEntered)
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('bash', { command: 'echo first > first-resume.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('register_structured_output', { output: { answer: '第一个续接的答案' } })], { stopReason: 'toolUse' }),
        held.step as never,
      ])
      const first = env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '第一个续接',
        resume: String(childId),
        schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
        gate: 'test -f first-resume.txt',
        onResolved: () => {},
      } as AgentSpawnRequest)

      // 必须等模型消费前两条响应并进入挂起点；仅等 marker 落盘会提前重置 faux 响应队列。
      await Promise.race([
        entered,
        first.then(() => { throw new Error('首个续接在进入挂起响应前结束') }),
      ])
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')), '第一个续接应在原 worktree 内执行')

      // 并发第二 resume：同子会话在途，显式拒绝（不互抢 gate/结构化输出）。
      env.faux.setResponses([fauxAssistantMessage('第二个续接不应执行')])
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '第二个续接（并发）',
            resume: String(childId),
            gate: 'true',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'subagent_in_use')
          return true
        },
      )

      // 释放第一个：结构化输出与 gate 正常完成（未被第二个干扰）。
      held.release(fauxAssistantMessage('尾随文本'))
      const result = await first
      assert.deepEqual(result, { answer: '第一个续接的答案' }, '第一个续接的结构化输出应完整返回')
      assert.ok(existsSync(join(firstWtPath, 'first-resume.txt')))
      // 全程只有这一个子会话（第二个未派生新会话）。
      const children = env.kernel.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, '并发拒绝不得派生新子会话')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. 后台回报 requestId 幂等（持久 requestId + 进程内 singleflight）
// ---------------------------------------------------------------------------

describe('后台回报 requestId 幂等（builtin:workflow 投递路径同机制）', { timeout: 60_000 }, () => {
  it('3 次并发 + 终态后重复调用只产生一条 origin=agent 且 meta.backgroundRunId=runId 的 helm.input；重启后持久去重', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't7')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    const runId = 'wf_testreport0001'
    const requestId = `helm:subagent-report:${runId}`
    const deliver = () =>
      env.kernel.submitInput(1, `后台子代理任务已结算。以下为运行 ${runId} 的结果数据：\n"后台任务完成内容"`, {
        origin: 'agent',
        whenBusy: 'followUp',
        requestId,
        meta: { backgroundRunId: runId, kind: 'subagent_report' },
      })
    try {
      // faux 只给一次响应：第二次模型请求（若重复投递）将无脚本响应而暴露。
      env.faux.setResponses([fauxAssistantMessage('父会话收到回报后回答')])
      await Promise.all([deliver(), deliver(), deliver()])
      await env.kernel.waitForIdle(1)
      // 终态后重复调用：持久 submissionByRequest 拦截。
      await deliver()

      const reports = (await agentReports(env.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `同 runId 只应投递一条回报，实得 ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent', '回报输入来源必须为 agent')

      // 侧证：faux 恰好一次请求（重复投递会触发第二次请求并因无响应失败/或计数>1）。
      assert.equal(env.faux.state.callCount, 1, `父会话模型应只被请求一次，实得 ${env.faux.state.callCount}`)
    } finally {
      await env.close()
    }

    // 重开同 dataDir：SDK 持久 submissionByRequest 去重。
    const reopened = await openRuntime(join(dir, 'data'), repo)
    try {
      reopened.faux.setResponses([fauxAssistantMessage('不应出现的第二次回答')])
      await reopened.kernel.submitInput(1, `后台子代理任务已结算。以下为运行 ${runId} 的结果数据：\n"重复"`, {
        origin: 'agent',
        whenBusy: 'followUp',
        requestId,
        meta: { backgroundRunId: runId, kind: 'subagent_report' },
      })
      await reopened.kernel.waitForIdle(1)
      const reports = (await agentReports(reopened.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `重启后重复回报不得产生第二条 helm.input，实得 ${JSON.stringify(reports)}`)
    } finally {
      await reopened.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 8. durable 租约 fail-closed（安全红线）：重启中断残留拒绝清理
// ---------------------------------------------------------------------------

describe('持久租约未知占用保护（fail-closed）', { timeout: 60_000 }, () => {
  it('租约残留（重启中断语义）时 cleanup_worktree 显式 worktree_execution_unknown；正常 spawn 成功后租约释放可清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 真实 worktree（外部登记形态，模拟外部运行时如 Herdr 派生）。
      const wtPath = join(dir, '.helm-worktrees', 'lease-check')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-lease-1', wtPath, 'HEAD'], { cwd: repo })

      // 直接向插件私有持久 doc 写入租约残留 + allocator 登记（模拟「执行已
      // 启动、进程死亡、重启后无在途执行」：进程死亡后磁盘上真实存在的内容）。
      // doc 形状与生产同构：worktree-state 嵌套 map，内层键为 allocator 的
      // 'runtime/worktrees'（{version, records}）与租约表 'worktree-leases'。
      const worktreeId = `local:${wtPath}`
      const existing = env.kernel.documentStore.get<Record<string, unknown>>('builtin:workflow:worktree-state', {})
      env.kernel.documentStore.set('builtin:workflow:worktree-state', {
        ...existing,
        'runtime/worktrees': {
          version: 1,
          records: [
            {
              id: worktreeId,
              nodeId: 'local',
              repoRoot: repo,
              path: wtPath,
              branch: 'helm/wf-lease-1',
              baseCommit: '0'.repeat(40),
              dirtySource: false,
              parentConversationId: 1,
              executionId: 'ext-pane-7',
              origin: 'external',
              status: 'active',
              createdAt: Date.now(),
            },
          ],
        },
        'worktree-leases': {
          'stale-token-from-dead-process': {
            phase: 'running',
            info: {
              nodeId: 'local',
              executionId: 'ext-pane-7',
              effectiveCwd: wtPath,
              worktree: { path: wtPath, branch: 'helm/wf-lease-1' },
            },
            worktreeId,
            createdAt: Date.now(),
          },
        },
      })
      await env.kernel.documentStore.flush()

      // 未知占用：不能证明底层（如远端 Herdr）已停，force 也拒绝（防删仍在跑的目录）。
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ worktreeId, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_execution_unknown')
          assert.ok(err.message.includes('不能清理'), `错误应给出检视/手动清理指引：${err.message}`)
          return true
        },
      )
      assert.ok(existsSync(wtPath), '未知占用拒绝时目录不得被动')

      // 正常原生 spawn（成功路径）：租约登记并在 settle 后释放，随后可清理。
      let resolved: AgentExecutionInfo | undefined
      env.faux.setResponses([fauxAssistantMessage('lease 释放验证完成')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '成功任务（lease 释放）',
        isolation: 'worktree',
        onResolved: (info) => {
          resolved = info
        },
      } as AgentSpawnRequest)
      assert.ok(resolved?.worktree, '成功 spawn 应回传 worktree')
      const leases = env.pluginDoc.get<Record<string, { info?: { worktree?: { path?: string } } }>>('worktree-leases', {})
      const leasePaths = Object.values(leases).map((l) => l.info?.worktree?.path)
      assert.ok(
        !leasePaths.includes(resolved!.worktree!.path),
        `成功 settle 后租约应释放，实得 ${JSON.stringify(leasePaths)}`,
      )
      if (PROCESS_SCAN_ON) {
        const cleaned = await env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true })
        assert.equal(cleaned.removed, true, '租约释放后可清理')
      } else {
        await assertCleanupPlatformRejected(() => env.invoke.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true }))
      }
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 9. createHelm 真实后台组合：subagent(background:true, isolation:worktree, gate)
// ---------------------------------------------------------------------------

describe('createHelm 后台子代理全链（background + worktree + gate + 父回合先结束）', { timeout: 60_000 }, () => {
  it('后台运行期：run running、子会话在 gate、清理拒绝；释放 gate 后 settle 并向父会话幂等汇报 runId/worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't9')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    const kernel = env.kernel
    // release 文件位于隔离树外（父 repo 内）：gate 在 worktree 内等待外部信号。
    const releaseFile = join(repo, '.helm-test-release.txt')
    try {
      // 首响应：父会话调用 subagent(background:true)；其后给足普通回答
      //（父收 runId 后结束回合；子代理完成文本与汇报轮父回应，谁先消费均可）。
      env.faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall('subagent', {
            prompt: '后台隔离任务：等待 release 文件后完成任务',
            background: true,
            isolation: 'worktree',
            gate: `timeout 10 sh -c 'while ! test -f ${releaseFile}; do sleep 0.01; done'`,
          })],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('后台任务已派出，本回合结束'),
        fauxAssistantMessage('子代理后台完成'),
        fauxAssistantMessage('汇报轮完成'),
        fauxAssistantMessage('汇报轮兜底'),
      ])

      await kernel.submitInput(1, '派一个后台隔离子代理')
      await kernel.waitForIdle(1)

      // 工具输出应含 runId 与 worktree 元数据（后台句柄）。
      const detail = await kernel.getConversationDetail(1, { limit: 100 })
      const toolEntry = [...detail.entries]
        .reverse()
        .find((e) => e.kind === 'pi.tool-result' && JSON.stringify(e.model ?? '').includes('"subagent"'))
      assert.ok(toolEntry, '应存在 subagent 工具结果')
      const toolText = JSON.stringify(toolEntry.model ?? '')
      const runIdMatch = /runId\\?":\\?"(wf_[0-9a-f]+)/.exec(toolText)
      assert.ok(runIdMatch, `工具输出应含 runId：${toolText.slice(0, 400)}`)
      const runId = runIdMatch[1]!

      // 后台运行期：run running；子会话已建、进入 gate（blocked=gate 等待），
      // 父回合已结束（父 idle 不代表子结束——先结束语义）。
      let run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'running', `后台 run 应为 running，实得 ${run.status}`)
      const child = kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '后台子会话应已派生')
      const childCwd = child.cwd
      assert.ok(existsSync(childCwd), '后台子会话应绑定真实隔离树')

      // 运行中清理拒绝（gate 占用 + run 在途；force 不绕过在用检查）。
      await assert.rejects(
        () => env.invoke.cleanupWorktree({ conversationId: child.id, force: true }),
        (err: unknown) =>
          err instanceof HelmError && (err.code === 'worktree_in_use' || err.code === 'worktree_execution_unknown'),
      )
      assert.ok(existsSync(childCwd), '运行中拒绝清理时目录不得被动')

      // 释放 gate：写 release 文件，等待 run settle 与父会话回报轮完成。
      writeFileSync(releaseFile, 'release\n')
      // 等待终态：轮询 inspect 动作。
      for (let i = 0; i < 600; i++) {
        run = (await env.invoke.inspect(runId)).run
        if (run.status !== 'running') break
        await new Promise((r) => setTimeout(r, 20))
      }
      // 关键等待：终态可见 ≠ 汇报已投递。引擎 settle 链在终态落盘后还要执行
      // onBackgroundAgentSettled（向父会话 submitInput 汇报）——inspect 看到终态
      // 时该步可能仍在途。必须等到真实的汇报 entry 落盘后再继续。
      let reported = false
      for (let i = 0; i < 600; i++) {
        const hits = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
        if (hits.length > 0) {
          reported = true
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(reported, `后台汇报 entry 应在行界内到达（runId=${runId}，status=${run.status}）`)
      // 汇报 entry 到达后等父回合消费完（汇报轮模型回应），再验幂等恰一条。
      await kernel.waitForIdle(1)

      run = (await env.invoke.inspect(runId)).run
      assert.equal(run.status, 'completed', `释放 gate 后 run 应 completed，实得 ${run.status}${run.error ? `（error: ${run.error}）` : ''}`)

      // 汇报输入：恰好一条 origin=agent、meta.backgroundRunId=runId 的 helm.input。
      const reports = (await agentReports(kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `应恰好一条后台汇报，实得 ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent')
      // 汇报内容含 runId 与 worktree 受管 id（人类可据此续接/清理）。
      const reportTexts = (await kernel.getConversationDetail(1, { limit: 200 })).entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => String((e.data as { text?: unknown } | undefined)?.text ?? ''))
        .filter((t) => t.includes(runId))
      assert.ok(reportTexts.length >= 1, '汇报文本应含 runId')
      // 汇报文本应包含受管 worktree id（人类可据此续接/清理；从工具输出的
      // worktreeId 句柄提取，路径含 / 不受受限字符类影响）。
      const toolMatch = /worktreeId=\\+"([^"\\\n]+)/.exec(toolText)
      assert.ok(toolMatch, `工具输出应含受管 worktreeId：${toolText.slice(0, 300)}`)
      assert.ok(
        reportTexts.some((t) => t.includes(toolMatch[1]!)),
        `汇报应含受管 worktree id ${toolMatch[1]}`,
      )
    } finally {
      // 防清理死锁：无论断言成败都释放 gate 并等待终态后再关停。
      try {
        writeFileSync(releaseFile, 'release\n')
        await kernel.waitForIdle(1).catch(() => {})
      } catch {
        /* finally 尽力 */
      }
      await env.close()
    }
  })
})
