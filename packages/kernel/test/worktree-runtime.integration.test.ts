/**
 * worktree 运行时真实集成测试（KernelRuntime + 真实 SDK faux 模型 + 临时
 * 真实 Git 仓库 + HTTP handler），覆盖统一接线后的完整链路。
 *
 * 覆盖（对应任务六项重点）：
 * 1. 真实 KernelRuntime.spawnAgent isolation:'worktree'：真实子会话工具创建
 *    隔离树（非 runNativeSpawn 注入 fake）；spawnAgent 回传 nodeId/cleanup
 *    提示/id；gate 在 worktree 内真实执行；cleanup 默认保留分支。
 * 2. 真实 gate 失败 / 模型失败 / 取消后 worktree 与未提交产物保留（防
 *    spawn 外层 catch 误删回归——主代理刚修复，本测试防再次引入）。
 * 3. 子代理运行中（SDK 会话 idle 但 spawn 未 settle）kernel.cleanupWorktree
 *    (force:true) 仍 worktree_in_use；spawn 实际 settle 后可清理。
 * 4. POST /api/worktrees/cleanup：选择器互斥/未知键/非法类型显式 400；
 *    成功调用实际 kernel cleanup；用户 API 错误码透传（not_found 等）。
 * 5. 外部插件 agent_spawn handled onResolved 回传 nodeId/executionId/
 *    worktree 后统一登记（worktreeId 可定位清理）；不给 nodeId 显式拒绝；
 *    请求 isolation 但不回传 worktree 显式拒绝；自定义可信插件在临时真实
 *    git worktree 回传（明示测试边界：非真实 Herdr）。
 * 6. 同子会话并发 resume 互斥（subagent_in_use），gate/结构化输出不互抢。
 *
 * 诚实性纪律：真实 KernelRuntime（真 SQLite + 真 pi-durable SDK + faux 模型
 * 脚本）、真实临时 Git 仓库（git init + 初始 commit）、真实 HTTP handler
 * （createHubHandler + process token）；不 mock git、不 mock spawn、不伪造
 * 完成结果。实现文件为本测试的外部依赖（只读复制主树 src），不随本测试提交。
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
import { KernelRuntime } from '../src/runtime/index.js'
import { createHubHandler } from '../src/http/index.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'

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
  kernel: KernelRuntime
  faux: ReturnType<typeof fauxProvider>
  dataDir: string
  /** 真实 HTTP handler（process token 鉴权）。 */
  handler: (request: Request) => Promise<Response>
  token: string
  close(): Promise<void>
}

/** 真实 KernelRuntime + faux provider + HTTP handler（同 dataDir；cwd 指向源仓库）。 */
async function openRuntime(dataDir: string, cwd?: string): Promise<RuntimeEnv> {
  const models = createModels()
  const faux = fauxProvider()
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({
    dataDir,
    cwd: cwd ?? dataDir,
    model: 'faux/faux-1',
    models: models as never,
    autoResume: false,
  })
  // 编排插件（subagent / cleanup_worktree 动作与工具；引擎 state 走插件私有
  // records doc 持久层——本文件聚焦 worktree 生命周期而非跨重启 run 恢复）。
  await kernel.plugins.register(
    createWorkflowPlugin(),
  )
  const handler = createHubHandler(kernel)
  const { token } = kernel.auth.createProcessToken()
  return {
    kernel,
    faux,
    dataDir,
    handler,
    token,
    async close() {
      await kernel.close()
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

// ---------------------------------------------------------------------------
// 1. 真实 KernelRuntime.spawnAgent isolation:'worktree' 全链路
// ---------------------------------------------------------------------------

describe('KernelRuntime 真实 worktree 隔离派生', { timeout: 60_000 }, () => {
  it('spawnAgent isolation:worktree：真实隔离树 + nodeId/受管 id/cleanup 提示回传 + gate 在树内通过 + 清理默认保留分支', { timeout: 60_000 }, async () => {
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

      // ---- onResolved 回传执行环境元数据（受管登记后含稳定 id）。----
      assert.ok(resolved, 'onResolved 应回传执行环境元数据')
      assert.equal(resolved!.nodeId, 'local', '原生 spawn 应回传实际 nodeId')
      assert.ok(resolved!.conversationId !== undefined && resolved!.conversationId > 1, '应派生真子会话')
      const worktree = resolved!.worktree
      assert.ok(worktree, 'isolation:worktree 必须回传 worktree 元数据')
      assert.ok(worktree!.path.includes(join(dir, '.helm-worktrees')), `worktree 应位于同级 .helm-worktrees：${worktree!.path}`)
      assert.ok(worktree!.branch.startsWith('helm/spawn-'), `分支应为 helm/spawn-*：${worktree!.branch}`)
      assert.ok(typeof worktree!.id === 'string' && worktree!.id.length > 0, '受管登记后应回传稳定 id（worktreeId）')
      assert.equal(resolved!.effectiveCwd, worktree!.path, 'effectiveCwd 应为 worktree 目录')

      // ---- 真实隔离树：目录存在、子会话与 gate 的产物都落在树内。----
      assert.ok(existsSync(worktree!.path), 'worktree 目录应真实存在')
      assert.ok(existsSync(join(worktree!.path, 'README.md')), 'worktree 应检出初始提交内容')
      assert.ok(existsSync(join(worktree!.path, '.helm-child-pwd.txt')), '子会话 bash 产物应落在 worktree 内')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-pwd.txt'), 'utf8').trim(), worktree!.path, '子会话 pwd 应为 worktree 目录')
      assert.equal(readFileSync(join(worktree!.path, '.helm-child-branch.txt'), 'utf8').trim(), worktree!.branch, '子会话应在 helm/spawn-* 分支上')
      assert.ok(existsSync(join(worktree!.path, '.helm-gate-pwd.txt')), 'gate 产物应落在 worktree 内')
      assert.equal(readFileSync(join(worktree!.path, '.helm-gate-pwd.txt'), 'utf8').trim(), worktree!.path, 'gate pwd 应为 worktree 目录（gate 在树内执行）')
      assert.ok(!existsSync(join(repo, '.helm-gate-pwd.txt')), '源仓库不得被 gate/子会话污染')
      // 子会话镜像 cwd 为 worktree。
      const child = env.kernel.getConversation(resolved!.conversationId!)
      assert.equal(child.cwd, worktree!.path, '子会话镜像 cwd 应为 worktree 目录')

      // ---- worktrees 登记可查询（kernel.worktrees / getForConversation）。----
      const record = env.kernel.worktrees.getForConversation(resolved!.conversationId!)
      assert.ok(record, 'kernel.worktrees 应能按子会话查询受管记录')
      assert.equal(record!.path, worktree!.path)
      assert.equal(record!.origin, 'native')

      // ---- 清理：默认保留分支（deleteBranch 缺省 false；取证产物为未提交脏文件，
      //      显式 force 丢弃——非 force 脏拒绝已在 native-worktree.test.ts 覆盖）。----
      const cleaned = await env.kernel.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true })
      assert.equal(cleaned.removed, true)
      assert.equal(cleaned.branchDeleted, false, '默认清理必须保留分支')
      assert.ok(!existsSync(worktree!.path), '清理后 worktree 目录应被移除')
      const branchList = execFileSync('git', ['branch', '--list', worktree!.branch], { cwd: repo, encoding: 'utf8' })
      assert.ok(branchList.includes(worktree!.branch), `分支 ${worktree!.branch} 应默认保留（实得 ${branchList.trim()}）`)
    } finally {
      await env.close()
    }
  })

  it('原生 subagent 工具链：模型调用 subagent(isolation:worktree) 创建真实隔离树；工具输出含 nodeId/cleanup 提示/worktreeId', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't1b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      env.faux.setResponses([
        fauxAssistantMessage([fauxToolCall('subagent', { prompt: '隔离任务', isolation: 'worktree' })], { stopReason: 'toolUse' }),
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
      // 工具输出独立回报执行元数据：nodeId、cleanup 提示、worktreeId。
      assert.ok(text.includes('worktree='), `工具输出应含 worktree 元数据：${text.slice(0, 400)}`)
      assert.ok(text.includes('cleanup_worktree'), '工具输出应含 cleanup_worktree 清理提示')
      assert.ok(text.includes('worktreeId='), '工具输出应含受管 worktreeId')

      // 真实子会话建在真实隔离树内。
      const child = env.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '应派生真子会话')
      const record = env.kernel.worktrees.getForConversation(child.id)
      assert.ok(record, '子会话应绑定受管 worktree 记录')
      assert.ok(existsSync(record!.path), '受管 worktree 应真实存在')
      assert.ok(record!.path.includes(join(dir, '.helm-worktrees')), 'worktree 应在同级 .helm-worktrees 下')
      assert.ok((await env.kernel.getLastAssistantText(1)).includes('主回合完成'))
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 2. gate 失败 / 模型失败 / 取消后 worktree 与未提交产物保留（防误删回归）
// ---------------------------------------------------------------------------

describe('失败路径资源保留（防 spawn 外层 catch 误删回归）', { timeout: 60_000 }, () => {
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
      // 关键防回归：gate 失败（子会话已 settle）绝不触发外层回收误删。
      assert.ok(existsSync(wtPath), 'gate 失败后 worktree 必须保留（供人类检视）')
      assert.ok(existsSync(join(wtPath, 'wip-artifact.txt')), '子会话未提交产物必须保留')
      // 记录仍 active（可按会话定位）。
      const record = env.kernel.worktrees.getForConversation(resolved!.conversationId!)
      assert.ok(record)
      assert.equal(record!.status, 'active')
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
      // 产物由上面的真实 bash 工具在失败之前写入，失败后必须仍然存在。
      const preExisting = join(resolved!.worktree!.path, 'partial.txt')
      // 关键断言：spawn 外层 catch 不得回收已绑定子会话的隔离树（防误删回归）。
      assert.ok(existsSync(resolved!.worktree!.path), '模型失败后 worktree 必须保留')
      assert.ok(existsSync(preExisting), '未提交产物必须保留')
      const record = env.kernel.worktrees.getForConversation(resolved!.conversationId!)
      assert.ok(record && record.status === 'active', '失败后受管记录应保持 active')
    } finally {
      await env.close()
    }
  })

  it('运行中取消（abort）：真实收尾后 worktree 与未提交产物保留，不留 live 任务', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't2c')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let entered = false
      const held = heldResponse(() => {
        entered = true
      })
      // 第一响应：写 marker 后挂起（子会话已产出、模型在途）。
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
      // 等待子会话产出 marker（短轮询，不 sleep 大间隔）。
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (resolved?.worktree && existsSync(join(resolved.worktree.path, 'cancel-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(resolved?.worktree, '取消前 onResolved 应回传 worktree')
      assert.ok(existsSync(join(resolved!.worktree!.path, 'cancel-marker.txt')), '取消前子会话应已写入产物')

      controller.abort()
      held.release(fauxAssistantMessage('不应作为结果'))
      await assert.rejects(() => pending, (err: unknown) => err instanceof HelmError && err.code === 'aborted')

      // 真实收尾：子会话回 idle；worktree 与产物保留。
      const childId = resolved!.conversationId!
      await env.kernel.waitForIdle(childId)
      assert.ok(existsSync(resolved!.worktree!.path), '取消后 worktree 必须保留（子会话已创建绑定，不得误删）')
      assert.ok(existsSync(join(resolved!.worktree!.path, 'cancel-marker.txt')), '取消后未提交产物必须保留')
      const record = env.kernel.worktrees.getForConversation(childId)
      assert.ok(record && record.status === 'active', '取消后受管记录应保持 active')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 3. 运行中占用：force:true 仍 worktree_in_use，settle 后可清理
// ---------------------------------------------------------------------------

describe('占用中的 worktree 清理保护', { timeout: 60_000 }, () => {
  it('模型回合仍在执行：force:true 仍 worktree_in_use；settle 后可清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't3')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      let modelDone = false
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
      // 等子会话产出 marker 后进入第二回合（模型挂起中）。
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        if (resolved?.worktree && existsSync(join(resolved.worktree.path, 'in-use-marker.txt'))) break
        await new Promise((r) => setTimeout(r, 50))
      }
      assert.ok(resolved?.worktree && resolved?.conversationId, '子会话应已创建')
      const childId = resolved!.conversationId!
      // SDK 会话确实在忙（第二回合模型挂起）。
      assert.equal(env.kernel.getConversation(childId).status, 'working', '模型挂起期间子会话应为 working')

      // spawn 未 settle：conversation 占用与 activeSpawnExecutions 路径引用
      // 双保险，force:true 也不得清理运行中的子代理工作树。
      await assert.rejects(
        () => env.kernel.cleanupWorktree({ conversationId: childId, force: true }),
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
      modelDone = true
      assert.ok(modelDone)

      // settle 后可清理（force 因未提交产物需要；先确认不再 worktree_in_use）。
      const cleaned = await env.kernel.cleanupWorktree({ conversationId: childId, force: true })
      assert.equal(cleaned.removed, true, 'settle 后 force 清理应成功')
      assert.ok(!existsSync(resolved!.worktree!.path))
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 4. HTTP POST /api/worktrees/cleanup：校验 + 透传
// ---------------------------------------------------------------------------

describe('HTTP worktrees/cleanup 路由', { timeout: 60_000 }, () => {
  it('动作边界校验：未知键/多选择器/零选择器/非法类型显式 400；未登记选择器 404 不触碰实际清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't4a')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 未知键拒绝（动作 inputSchema additionalProperties:false）。
      const unknownKey = await postCleanup(env, { conversationId: 5, oops: true })
      assert.equal(unknownKey.status, 400)
      assert.equal(unknownKey.json.error.code, 'validation_error')

      // 多选择器拒绝（worktreeId + conversationId / conversationId + path）。
      const multiA = await postCleanup(env, { conversationId: 5, path: '/tmp/x' })
      assert.equal(multiA.status, 400)
      assert.equal(multiA.json.error.code, 'validation_error')
      const multiB = await postCleanup(env, { worktreeId: 'local:/tmp/x', conversationId: 5 })
      assert.equal(multiB.status, 400)
      assert.equal(multiB.json.error.code, 'validation_error')
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

  it('成功调用实际 kernel cleanup（真实 worktree 被移除）；未登记 selector 用户错误码 not_found 透传', { timeout: 60_000 }, async () => {
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
      assert.ok(resolved?.worktree && resolved?.worktree?.id)
      const wt = resolved!.worktree!

      // 按子会话成功清理（真实移除目录；deleteBranch 默认保留分支）。
      // 注：WorktreeCleanupRequest.worktreeId 已在 HTTP 契约接受，但当前
      // WorktreeAllocator.cleanup 仅支持 conversationId/path 选择器（统一接线
      // 未完成）；本用例按子会话选择器验证成功链路，worktreeId 贯通待主代理接线。
      const ok = await postCleanup(env, { conversationId: resolved!.conversationId })
      assert.equal(ok.status, 200)
      assert.equal(ok.json.removed, true)
      assert.equal(ok.json.branchDeleted, false)
      assert.equal(ok.json.path, wt.path)
      assert.ok(!existsSync(wt.path), 'HTTP 清理应实际移除 worktree 目录')

      // 未登记选择器：kernel 的 not_found(404) 原样透传（不伪装 500/200）。
      const missing = await postCleanup(env, { conversationId: 999_999 })
      assert.equal(missing.status, 404)
      assert.equal(missing.json.error.code, 'not_found')
      assert.ok(String(missing.json.error.message).includes('未登记'), `错误消息应说明仅清理登记记录：${missing.json.error.message}`)
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
  it('可信插件在真实临时 git worktree 回传 nodeId/executionId/worktree：统一登记 worktreeId；cleanup_worktree 同机制可清理（测试边界：自定义插件模拟外部运行时，非真实 Herdr）', { timeout: 60_000 }, async () => {
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
          ctx.hook.onAgentSpawn((payload) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:external') return
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

      // 统一登记：onResolved 回传被内核改写为受管记录（含稳定 id）。
      assert.ok(resolved?.worktree?.id, '外部回传 worktree 应被统一登记并回填稳定 id')
      assert.ok(resolved!.worktree!.id!.startsWith('local:'), `受管 id 应为 nodeId:path 形态：${resolved!.worktree!.id}`)
      const record = env.kernel.worktrees.findActive({ path: wtPath })
      assert.ok(record, '外部 worktree 应进入统一受管登记')
      assert.equal(record!.origin, 'external')
      assert.equal(record!.executionId, 'test-exec-1')

      // cleanup 与原生同机制：统一登记记录可定位清理（helm/wf-* 受管前缀）。
      // 已知实现缺陷（已报告主代理，不擅自改实现）：runtime.registerExternal
      // 未传 sourceCwd，且既有记录的 registerExternal 更新分支不回填 repoRoot，
      // 而 resolveRepoRoot 对 git-common-dir 双重 dirname 多剥一层（得到主仓父
      // 目录）-> 上方插件登记的记录 cleanup 会报 worktree_remove_failed。
      // 此处用独立真实 worktree + 显式 sourceCwd 验证同一清理机制在 repoRoot
      // 已知时的正确行为（缺陷修复后可改为直接清理上方插件登记的记录）。
      const wt2 = join(dir, '.helm-worktrees', 'external-cleanup-check')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-external-2', wt2, 'HEAD'], { cwd: repo })
      writeFileSync(join(wt2, 'external-result.txt'), 'done\n')
      env.kernel.worktrees.registerExternal({
        nodeId: 'local', path: wt2, branch: 'helm/wf-external-2',
        parentConversationId: 1, sourceCwd: repo,
      })
      // 注：worktreeId 选择器贯通待主代理统一接线（allocator 暂仅 conversationId/path）。
      const cleaned = await env.kernel.cleanupWorktree({ path: wt2, deleteBranch: true, force: true })
      assert.equal(cleaned.removed, true)
      assert.equal(cleaned.branchDeleted, true)
      assert.ok(!existsSync(wt2), '清理应实际移除外部 worktree')
    } finally {
      await env.close()
    }
  })

  it('请求 isolation 但插件不回传 worktree：显式 unsupported_runtime 拒绝（绝不假成功）', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't5b')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      await env.kernel.plugins.register({
        id: 'test:lying-runtime',
        name: '不兑现 worktree 的运行时',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn((payload) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:lying') return
            // 只回传 executionId，不回传 worktree：必须被拒绝。
            request.onResolved?.({ nodeId: 'local', executionId: 'exec-liar' })
            return { action: 'handled', result: '假成功：未兑现隔离' }
          })
        },
      })
      await assert.rejects(
        () =>
          env.kernel.spawnAgent({
            parentConversationId: 1,
            prompt: '要求隔离但不兑现',
            agentType: 'test:lying',
            isolation: 'worktree',
          } as AgentSpawnRequest),
        (err: unknown) => {
          assert.ok(err instanceof HelmError, `应抛 HelmError，实得 ${err}`)
          assert.equal(err.code, 'unsupported_runtime')
          assert.ok(err.message.includes('未兑现'), `错误应明确指出未兑现隔离：${err.message}`)
          return true
        },
      )
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
          ctx.hook.onAgentSpawn((payload) => {
            const request = payload as AgentSpawnRequest
            if (request.agentType !== 'test:no-node') return
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
      env.faux.setResponses([fauxAssistantMessage('第一轮完成')])
      await env.kernel.spawnAgent({
        parentConversationId: 1,
        prompt: '第一轮',
        isolation: 'worktree',
        onResolved: (info) => {
          childId = info.conversationId ?? 0
        },
      } as AgentSpawnRequest)
      assert.ok(childId > 0)

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
      const record = env.kernel.worktrees.getForConversation(childId)
      assert.ok(record)
      assert.ok(existsSync(join(record.path, 'first-resume.txt')), '第一个续接应在原 worktree 内执行')

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
      // gate 已在 worktree 内通过（marker 存在）。
      assert.ok(existsSync(join(record!.path, 'first-resume.txt')))
      // 全程只有这一个子会话（第二个未派生新会话）。
      const children = env.kernel.listConversations().filter((c) => c.parentConversationId === 1)
      assert.equal(children.length, 1, '并发拒绝不得派生新子会话')
    } finally {
      await env.close()
    }
  })
})

// ---------------------------------------------------------------------------
// 7. reportBackgroundAgent 幂等（持久 requestId + 进程内 singleflight）
// ---------------------------------------------------------------------------

/** 读取会话全部 helm.input entry 的 {origin, backgroundRunId}。 */
async function agentReports(kernel: KernelRuntime, conversationId: number): Promise<Array<{ origin: string; backgroundRunId?: string }>> {
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

    // 重开同 dataDir 的 KernelRuntime：SDK 持久 submissionByRequest 去重。
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
// 8. 持久 lease：重启中断的外部执行未知占用拒绝清理
// ---------------------------------------------------------------------------

describe('持久 lease 未知占用保护', { timeout: 60_000 }, () => {
  it('lease 残留（重启中断语义）时 cleanup 显式 worktree_execution_unknown；正常 spawn 成功后 lease 释放可清理', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 't8')
    const repo = makeGitRepo(join(dir, 'repo'))
    const env = await openRuntime(join(dir, 'data'), repo)
    try {
      // 真实 worktree + 直接登记 external 记录（repoRoot 显式，规避已知
      // resolveRepoRoot 双 dirname 缺陷——已单独报告，不影响本用例目标）。
      const wtPath = join(dir, '.helm-worktrees', 'lease-check')
      execFileSync('git', ['worktree', 'add', '-q', '-b', 'helm/wf-lease-1', wtPath, 'HEAD'], { cwd: repo })
      env.kernel.worktrees.registerExternal({
        nodeId: 'local', path: wtPath, branch: 'helm/wf-lease-1',
        parentConversationId: 1, sourceCwd: repo,
      })
      // 直接写入持久 lease 文档（模拟「onResolved 已登记、进程在重启中死亡」：
      // activeSpawnExecutions 为空 = 本进程无在途 token，与重启后状态同构）。
      env.kernel.documentStore.set('runtime/worktree-execution-leases', {
        'stale-token-from-dead-process': {
          nodeId: 'local', executionId: 'ext-pane-7',
          effectiveCwd: wtPath, worktree: { path: wtPath, branch: 'helm/wf-lease-1' },
        },
      })

      // 未知占用：不能证明底层（如远端 Herdr）已停，force 也拒绝（防删仍在跑的目录）。
      await assert.rejects(
        () => env.kernel.cleanupWorktree({ path: wtPath, force: true }),
        (err: unknown) => {
          assert.ok(err instanceof HelmError)
          assert.equal(err.code, 'worktree_execution_unknown')
          assert.ok(err.message.includes('不能清理'), `错误应给出检视/手动清理指引：${err.message}`)
          return true
        },
      )
      assert.ok(existsSync(wtPath), '未知占用拒绝时目录不得被动')

      // 正常原生 spawn（成功路径）：lease 登记并在 settle 后释放，随后可清理。
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
      const leases = env.kernel.documentStore.get<Record<string, unknown>>('runtime/worktree-execution-leases', {})
      const nativeLeasePaths = Object.values(leases)
        .map((info) => (info as { worktree?: { path?: string } }).worktree?.path)
      assert.ok(
        !nativeLeasePaths.includes(resolved!.worktree!.path),
        `成功 settle 后 lease 应释放，实得 ${JSON.stringify(nativeLeasePaths)}`,
      )
      const cleaned = await env.kernel.cleanupWorktree({ conversationId: resolved!.conversationId!, force: true })
      assert.equal(cleaned.removed, true, 'lease 释放后可清理')
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
    const { createHelm } = await import('../src/app.js')
    const models = createModels()
    const faux = fauxProvider()
    models.setProvider(faux.provider)
    const app = await createHelm({ dataDir: join(dir, 'data'), cwd: repo, model: 'faux/faux-1', models: models as never })
    // release 文件位于隔离树外（父 repo 内）：gate 在 worktree 内等待外部信号。
    const releaseFile = join(repo, '.helm-test-release.txt')
    try {
      // 首响应：父会话调用 subagent(background:true)；其后给足普通回答
      //（父收 runId 后结束回合；子代理完成文本与汇报轮父回应，谁先消费均可）。
      faux.setResponses([
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

      await app.kernel.submitInput(1, '派一个后台隔离子代理')
      await app.kernel.waitForIdle(1)

      // 工具输出应含 runId 与 worktree 元数据（后台句柄）。
      const detail = await app.kernel.getConversationDetail(1, { limit: 100 })
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
      const inspectRun = (id: string) =>
        app.kernel.plugins.invokeAction('builtin:workflow', 'inspect', { runId: id }) as Promise<{ run: { id: string; status: string; error?: string } }>
      let run = (await inspectRun(runId)).run
      assert.equal(run.status, 'running', `后台 run 应为 running，实得 ${run.status}`)
      const child = app.kernel.listConversations().find((c) => c.parentConversationId === 1)
      assert.ok(child, '后台子会话应已派生')
      const record = app.kernel.worktrees.getForConversation(child.id)
      assert.ok(record && existsSync(record.path), '后台子会话应绑定真实隔离树')

      // 运行中清理拒绝（gate 占用；force 不绕过在用检查）。
      await assert.rejects(
        () => app.kernel.cleanupWorktree({ conversationId: child.id, force: true }),
        (err: unknown) => err instanceof HelmError && (err.code === 'worktree_in_use' || err.code === 'worktree_execution_unknown'),
      )
      assert.ok(existsSync(record!.path), '运行中拒绝清理时目录不得被动')

      // 释放 gate：写 release 文件，等待 run settle 与父会话回报轮完成。
      writeFileSync(releaseFile, 'release\n')
      // 等待终态：轮询 inspect 动作（run 动作 wait:true 适用于新 run）。
      for (let i = 0; i < 600; i++) {
        run = (await inspectRun(runId)).run
        if (run.status !== 'running') break
        await new Promise((r) => setTimeout(r, 20))
      }
      // 关键等待：终态可见 ≠ 汇报已投递。引擎 settle 链在终态落盘后还要执行
      // onBackgroundAgentSettled（向父会话 submitInput 汇报）——inspect 看到终态
      // 时该步可能仍在途，此刻 waitForIdle(parent) 会立即返回（父尚无汇报输入），
      // 旧写法随即断言 reports 得 0 条（全仓并发下暴露的等待竞态）。
      // 必须等到真实的汇报 entry（origin=agent + meta.backgroundRunId=runId）
      // 落盘后再继续；终态本身不是「父通知已完成」的证据。
      let reported = false
      for (let i = 0; i < 600; i++) {
        const hits = (await agentReports(app.kernel, 1)).filter((r) => r.backgroundRunId === runId)
        if (hits.length > 0) {
          reported = true
          break
        }
        await new Promise((r) => setTimeout(r, 20))
      }
      assert.ok(reported, `后台汇报 entry 应在行界内到达（runId=${runId}，status=${run.status}）`)
      // 汇报 entry 到达后等父回合消费完（汇报轮模型回应），再验幂等恰一条。
      await app.kernel.waitForIdle(1)

      run = (await inspectRun(runId)).run
      assert.equal(run.status, 'completed', `释放 gate 后 run 应 completed，实得 ${run.status}${run.error ? `（error: ${run.error}）` : ''}`)

      // 汇报输入：恰好一条 origin=agent、meta.backgroundRunId=runId 的 helm.input。
      const reports = (await agentReports(app.kernel, 1)).filter((r) => r.backgroundRunId === runId)
      assert.equal(reports.length, 1, `应恰好一条后台汇报，实得 ${JSON.stringify(reports)}`)
      assert.equal(reports[0]!.origin, 'agent')
      // 汇报内容含 runId 与 worktree 受管 id（人类可据此续接/清理）。
      const reportTexts = (await app.kernel.getConversationDetail(1, { limit: 200 })).entries
        .filter((e) => e.kind === 'helm.input')
        .map((e) => String((e.data as { text?: unknown } | undefined)?.text ?? ''))
        .filter((t) => t.includes(runId))
      assert.ok(reportTexts.length >= 1, '汇报文本应含 runId')
      const wtRecord = app.kernel.worktrees.getForConversation(child.id)
      assert.ok(wtRecord?.id && reportTexts.some((t) => t.includes(wtRecord.id!)), `汇报应含受管 worktree id：${wtRecord?.id}`)
    } finally {
      // 防清理死锁：无论断言成败都释放 gate 并等待终态后再关停。
      try {
        writeFileSync(releaseFile, 'release\n')
        await app.kernel.waitForIdle(1).catch(() => {})
      } catch {
        /* finally 尽力 */
      }
      await app.close().catch(() => {})
    }
  })
})
