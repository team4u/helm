/**
 * builtin:workflow（subagent fork + Git Worktree）与 builtin:herdr（assertNoFork）端到端测试：
 * - 真实 Git 仓库 + createHelm + WorktreeAllocator：
 *   1. subagent({ fork: true, isolation: 'worktree', gate }) 省略 agentType 时继承非默认
 *      Profile 与父已完成上下文，在隔离工作树修改文件并通过 gate（源仓库无污染），
 *      随后可用返回 footer 中的 conversationId 经 subagent({ resume }) 在同一工作树续接；
 *   2. subagent({ fork: true, resume }) 显式返回错误信封（不派发、不建工作树）；
 *   3. herdr:* 与 Profile.runtime + fork: true + isolation: 'worktree' 显式拒绝
 *      unsupported_runtime，且 Worktree 列表与 git worktree list 零孤儿残留；
 * - HerdrExecutor.handle 对 herdr:* 与 Profile.runtime 携带 fork: true 防御性拒绝
 *   400 unsupported_runtime（零 transport 副作用），普通原生 fork 透传 continue。
 */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from '@earendil-works/pi-ai/providers/faux'
import { createPluginBuildProvider } from '@helm/plugin-build'
import { HelmError, type AgentGateResult, type Profile } from '@helm/protocol'
import { createHelm } from '../../hub/src/app.js'
import { AskCoordinator } from '../src/herdr/asks.js'
import type { HerdrEvent, HerdrNodeChannel, HerdrTarget, HerdrTransport } from '../src/herdr/contracts.js'
import { HerdrExecutor, type ExecutorHost } from '../src/herdr/executor.js'
import { MetadataProjector } from '../src/herdr/metadata.js'
import { EMPTY_MANAGED_DOC, PaneRegistry, type ManagedDoc } from '../src/herdr/panes.js'
import {
  assertRejectsCode,
  createGitTemplate,
  makeFauxModels as createPluginFauxModels,
  waitFor,
  type GitTemplate,
} from './helpers/plugin-test-env.js'

let savedHelmModel: string | undefined
let rootDir: string
let gitTemplate: GitTemplate

before(() => {
  savedHelmModel = process.env['HELM_MODEL']
  delete process.env['HELM_MODEL']
  rootDir = mkdtempSync(join(tmpdir(), 'helm-plugin-subagent-fork-'))
  gitTemplate = createGitTemplate('helm-plugin-subagent-fork-git-')
})

after(() => {
  if (savedHelmModel === undefined) delete process.env['HELM_MODEL']
  else process.env['HELM_MODEL'] = savedHelmModel
  gitTemplate.cleanup()
  rmSync(rootDir, { recursive: true, force: true })
})

function makeGitRepo(repoDir: string): string {
  return gitTemplate.cloneTo(repoDir)
}

function makeFauxModels() {
  return createPluginFauxModels({
    models: [
      { id: 'faux-1', reasoning: true },
      { id: 'faux-2', reasoning: true },
    ],
  })
}

function userMessageTexts(
  messages: ReadonlyArray<{ role?: string; content?: unknown }>,
): string[] {
  const texts: string[] = []
  for (const message of messages) {
    if (message.role !== 'user') continue
    if (typeof message.content === 'string') {
      texts.push(message.content)
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
          texts.push((block as { text: string }).text)
        }
      }
    }
  }
  return texts
}

function findToolResultByCallId(
  detail: { entries: Array<{ model?: unknown[] }> },
  toolCallId: string,
): { text: string; isError: boolean; details?: Record<string, unknown> } {
  for (const entry of detail.entries) {
    for (const msg of entry.model ?? []) {
      const m = msg as {
        role?: string
        toolCallId?: string
        isError?: boolean
        details?: Record<string, unknown>
        content?: Array<{ type?: string; text?: string }>
      }
      if (m.role === 'toolResult' && m.toolCallId === toolCallId) {
        const text = (m.content ?? [])
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text!)
          .join('')
        return { text, isError: m.isError === true, ...(m.details !== undefined ? { details: m.details } : {}) }
      }
    }
  }
  throw new Error(`未找到 toolCallId=${toolCallId} 的工具结果`)
}

describe('subagent fork 与 Git Worktree 集成（createHelm 端到端）', { timeout: 60_000 }, () => {
  it('fork + isolation: worktree + gate 继承非默认 Profile 上下文，可用 conversationId 续接；fork+resume 报错', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wt-fork-resume')
    const dataDir = join(dir, 'data')
    const repo = makeGitRepo(join(dir, 'repo'))
    const { models, faux } = makeFauxModels()

    let childIdForResume: number | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('记住线索 TOKEN_WT_77')) {
        return fauxAssistantMessage('已记住 TOKEN_WT_77')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('分叉写入工作树标记')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                prompt: '写入标记文件并汇报',
                fork: true,
                isolation: 'worktree',
                gate: 'test -f .forked-marker && grep -q from-fork .forked-marker',
                background: false,
              },
              { id: 'call-wt-fork-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('写入标记文件并汇报')) {
        assert.ok(users.some((t) => t.includes('TOKEN_WT_77')), 'worktree fork 子代理必须继承父历史线索')
        return fauxAssistantMessage(
          [fauxToolCall('write', { path: '.forked-marker', content: 'from-fork\n' }, { id: 'call-write-1' })],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'write' && lastUser.includes('写入标记文件并汇报')) {
        return fauxAssistantMessage('已写入标记文件')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('续接同一个分叉子代理')) {
        assert.ok(childIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                resume: String(childIdForResume),
                prompt: '追加续接标记',
                background: false,
              },
              { id: 'call-wt-resume-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('追加续接标记')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'write',
              { path: '.forked-marker', content: 'from-fork\nresumed-ok\n' },
              { id: 'call-write-2' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'write' && lastUser.includes('追加续接标记')) {
        return fauxAssistantMessage('续接追加完成')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('触发 fork 与 resume 互斥报错')) {
        assert.ok(childIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              {
                fork: true,
                resume: String(childIdForResume),
                prompt: '不应执行',
                background: false,
              },
              { id: 'call-wt-conflict-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage('父回合结束')
      }
      throw new Error(`未预期的 faux 请求: lastRole=${lastMsg?.role}, lastUser=${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 24 }, () => step))

    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repo,
      model: 'faux/faux-1',
      models: models as never,
    })
    const coderStaticCwd = makeGitRepo(join(dir, 'coder-static-cwd'))
    try {
      await app.kernel.services.profiles.save({
        id: 'coder',
        name: '编码代理',
        model: 'faux/faux-2',
        thinkingLevel: 'low',
        cwd: coderStaticCwd,
      })
      const parent = await app.kernel.createConversation({
        profileId: 'coder',
        cwd: repo,
      })

      await app.kernel.submitInput(parent.id, '记住线索 TOKEN_WT_77')
      await app.kernel.waitForIdle(parent.id)

      await app.kernel.submitInput(parent.id, '分叉写入工作树标记')
      await app.kernel.waitForIdle(parent.id)

      const children = app.kernel.listConversations({ parentConversationId: parent.id })
      assert.equal(children.length, 1)
      const child = children[0]!
      assert.equal(child.profileId, 'coder', '省略 agentType 的同 Profile fork 应继承非默认 Profile')
      assert.equal(child.model, 'faux/faux-2')
      assert.equal(child.thinkingLevel, 'low')
      assert.notEqual(child.cwd, repo, 'isolation: worktree 应分配独立工作树目录')
      assert.notEqual(child.cwd, coderStaticCwd, '同角色 fork 不得误用 Profile.cwd 替代 parent.cwd')
      const repoWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      assert.ok(repoWorktrees.includes(child.cwd), `worktree 必须从 parent.cwd(${repo}) 派生：\n${repoWorktrees}`)
      const staticRepoWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: coderStaticCwd, encoding: 'utf8' })
      assert.equal(
        staticRepoWorktrees.split('\n').filter((line) => line.startsWith('worktree ')).length,
        1,
        `Profile.cwd 仓库不得被派生工作树：\n${staticRepoWorktrees}`,
      )
      assert.ok(existsSync(join(child.cwd, '.forked-marker')), '标记文件应落在隔离工作树中')
      assert.ok(!existsSync(join(repo, '.forked-marker')), '源 Git 仓库绝不被污染')

      const detailTurn2 = await app.kernel.getConversationDetail(parent.id, { limit: 50 })
      const forkResult = findToolResultByCallId(detailTurn2, 'call-wt-fork-1')
      assert.equal(forkResult.isError, false)
      assert.equal(forkResult.text.includes('[subagent '), false, `不应含旧 footer：${forkResult.text}`)
      assert.equal((forkResult.details?.['execution'] as Record<string, unknown> | undefined)?.['conversationId'], child.id)
      assert.ok(forkResult.text.includes('已写入标记文件'))

      const wtAfterFork = (await app.kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
        worktrees: Array<{ conversationId: number; path: string }>
      }
      assert.equal(wtAfterFork.worktrees.length, 1)
      assert.equal(wtAfterFork.worktrees[0]!.conversationId, child.id)
      assert.equal(wtAfterFork.worktrees[0]!.path, child.cwd)

      // 续接同一个 forked 子会话（沿用同一 worktree）
      childIdForResume = child.id
      await app.kernel.submitInput(parent.id, '续接同一个分叉子代理')
      await app.kernel.waitForIdle(parent.id)

      const detailTurn3 = await app.kernel.getConversationDetail(parent.id, { limit: 50 })
      const resumeResult = findToolResultByCallId(detailTurn3, 'call-wt-resume-1')
      assert.equal(resumeResult.isError, false)
      assert.ok(resumeResult.text.includes('续接追加完成'))
      assert.equal(
        readFileSync(join(child.cwd, '.forked-marker'), 'utf8'),
        'from-fork\nresumed-ok\n',
        'resume 应在同一工作树继续修改',
      )

      // fork + resume 互斥返回错误信封且不新建子会话
      await app.kernel.submitInput(parent.id, '触发 fork 与 resume 互斥报错')
      await app.kernel.waitForIdle(parent.id)

      const detailTurn4 = await app.kernel.getConversationDetail(parent.id, { limit: 50 })
      const conflictResult = findToolResultByCallId(detailTurn4, 'call-wt-conflict-1')
      assert.equal(conflictResult.isError, true)
      assert.ok(
        conflictResult.text.includes('subagent_failed') && conflictResult.text.includes('fork') && conflictResult.text.includes('resume'),
        `fork+resume 应返回显式错误文本：${conflictResult.text}`,
      )
      assert.equal(app.kernel.listConversations({ parentConversationId: parent.id }).length, 1)
    } finally {
      await app.close()
    }
  })

  it('herdr:* 与 Profile.runtime 携带 fork: true + isolation: worktree 显式拒绝且零孤儿 Worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wt-herdr-reject')
    const dataDir = join(dir, 'data')
    const repo = makeGitRepo(join(dir, 'repo'))
    const { models, faux } = makeFauxModels()

    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('建立父上下文')) {
        return fauxAssistantMessage('上下文已建立')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('尝试对外部运行时分叉')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { agentType: 'herdr:agy', fork: true, isolation: 'worktree', prompt: '拒绝1', background: false },
              { id: 'call-herdr-prefix' },
            ),
            fauxToolCall(
              'subagent',
              { agentType: 'herdr-prof', fork: true, isolation: 'worktree', prompt: '拒绝2', background: false },
              { id: 'call-herdr-profile' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage('已收到拒绝结果')
      }
      throw new Error(`未预期的 faux 请求: lastRole=${lastMsg?.role}, lastUser=${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 12 }, () => step))

    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repo,
      model: 'faux/faux-1',
      models: models as never,
    })
    try {
      await app.kernel.services.profiles.save({
        id: 'herdr-prof',
        name: 'Herdr Profile',
        runtime: { kind: 'herdr', agent: 'agy' },
      })
      const parent = await app.kernel.createConversation({ cwd: repo })
      await app.kernel.submitInput(parent.id, '建立父上下文')
      await app.kernel.waitForIdle(parent.id)

      await app.kernel.submitInput(parent.id, '尝试对外部运行时分叉')
      await app.kernel.waitForIdle(parent.id)

      const detail = await app.kernel.getConversationDetail(parent.id, { limit: 50 })
      const r1 = findToolResultByCallId(detail, 'call-herdr-prefix')
      const r2 = findToolResultByCallId(detail, 'call-herdr-profile')
      assert.equal(r1.isError, true)
      assert.equal(r2.isError, true)
      assert.ok(r1.text.includes('unsupported_runtime') || r1.text.includes('fork'), `r1 应显式报错：${r1.text}`)
      assert.ok(r2.text.includes('unsupported_runtime') || r2.text.includes('fork'), `r2 应显式报错：${r2.text}`)

      const wt = (await app.kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
        worktrees: unknown[]
      }
      assert.deepEqual(wt.worktrees, [], '拒绝的 fork 不得分配或残留 worktree 登记')
      const gitWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      const worktreeCount = gitWorktrees.split('\n').filter((line) => line.startsWith('worktree ')).length
      assert.equal(worktreeCount, 1, `Git 仓库只应有主工作树：\n${gitWorktrees}`)
    } finally {
      await app.close()
    }
  })

  it('人类会话默认后台（省略 background）subagent({ fork: true })：立即返回后台句柄，结算后 steer 汇报并可 resume', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'bg-default-fork')
    const dataDir = join(dir, 'data')
    mkdirSync(dataDir, { recursive: true })
    const { models, faux } = makeFauxModels()

    let bgChildIdForResume: number | undefined
    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const users = userMessageTexts(msgs)
      const lastUser = users.at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('记住后台线索 BG_CLUE_99')) {
        return fauxAssistantMessage('已记住 BG_CLUE_99')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('默认后台派发分叉子代理')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { prompt: '后台分叉子任务', fork: true },
              { id: 'call-bg-fork-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('后台分叉子任务')) {
        assert.ok(users.some((t) => t.includes('BG_CLUE_99')), '后台 fork 子代理必须继承父已完成上下文')
        return fauxAssistantMessage('后台分叉子任务完成')
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage(lastUser.includes('续接后台分叉') ? '后台续接汇总完成' : '已交由后台执行')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('续接后台分叉')) {
        assert.ok(bgChildIdForResume !== undefined)
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { resume: String(bgChildIdForResume), prompt: '后台续接核验', background: false },
              { id: 'call-bg-resume-1' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'user' && lastUser.includes('后台续接核验')) {
        assert.ok(users.some((t) => t.includes('后台分叉子任务')), 'resume 后应保留原后台分叉上下文')
        return fauxAssistantMessage('后台续接成功')
      }
      // steer 后台结算汇报到达父会话触发的新回合
      return fauxAssistantMessage('收到后台分叉汇报')
    }
    faux.setResponses(Array.from({ length: 20 }, () => step))

    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: dir,
      model: 'faux/faux-1',
      models: models as never,
    })
    try {
      await app.kernel.submitInput(1, '记住后台线索 BG_CLUE_99')
      await app.kernel.waitForIdle(1)

      await app.kernel.submitInput(1, '默认后台派发分叉子代理')
      await app.kernel.waitForIdle(1)

      const detailTurn2 = await app.kernel.getConversationDetail(1, { limit: 50 })
      const bgToolRes = findToolResultByCallId(detailTurn2, 'call-bg-fork-1')
      assert.equal(bgToolRes.isError, false)
      const bgPayload = JSON.parse(bgToolRes.text.split('\n')[0]!) as {
        ok?: boolean
        background?: boolean
        runId?: string
        execution?: { conversationId?: number }
      }
      assert.equal(bgPayload.ok, true)
      assert.equal(bgPayload.background, true)
      assert.equal(typeof bgPayload.runId, 'string')
      assert.equal(typeof bgPayload.execution?.conversationId, 'number')
      const runId = bgPayload.runId!
      const bgChildId = bgPayload.execution!.conversationId!

      await waitFor(
        async () => {
          const { runs } = (await app.kernel.plugins.invokeAction('builtin:workflow', 'runs', { conversationId: 1 })) as {
            runs: Array<{ id: string; status: string }>
          }
          const matched = runs.find((r) => r.id === runId)
          return matched !== undefined && matched.status !== 'running'
        },
        { timeoutMs: 20_000, intervalMs: 20, message: '等待超时: 后台 fork run 到达终态' },
      )

      let reportInput: { id?: unknown; origin?: unknown; meta?: { kind?: unknown; backgroundRunId?: unknown } } | undefined
      await waitFor(
        async () => {
          const d = await app.kernel.getConversationDetail(1, { limit: 200 })
          for (const e of d.entries) {
            if (e.kind !== 'helm.input') continue
            const data = e.data as { id?: unknown; origin?: unknown; meta?: { kind?: unknown; backgroundRunId?: unknown } } | undefined
            if (data?.meta?.backgroundRunId === runId) {
              reportInput = data
              return true
            }
          }
          return false
        },
        { timeoutMs: 20_000, intervalMs: 20, message: '等待超时: 后台 fork steer 汇报到达父会话' },
      )
      assert.equal(reportInput?.id, `helm:subagent-report:${runId}`)
      assert.equal(reportInput?.origin, 'agent')
      assert.equal(reportInput?.meta?.kind, 'subagent_report')

      await app.kernel.waitForIdle(1)

      bgChildIdForResume = bgChildId
      await app.kernel.submitInput(1, '续接后台分叉')
      await app.kernel.waitForIdle(1)

      const detailResume = await app.kernel.getConversationDetail(1, { limit: 50 })
      const resumeRes = findToolResultByCallId(detailResume, 'call-bg-resume-1')
      assert.equal(resumeRes.isError, false)
      assert.ok(resumeRes.text.includes('后台续接成功'))
    } finally {
      await app.close()
    }
  })

  it('priority: 250 上游 agent_spawn transform 改写为 fork: true + Profile.runtime + isolation: worktree：被 WorktreeIsolation 拒绝且零孤儿 Worktree', { timeout: 60_000 }, async () => {
    const dir = join(rootDir, 'wt-upstream-transform-reject')
    const dataDir = join(dir, 'data')
    const repo = makeGitRepo(join(dir, 'repo'))
    const { models, faux } = makeFauxModels()

    const step: FauxResponseFactory = (context) => {
      const msgs = context.messages as Array<{ role?: string; content?: unknown; toolName?: string }>
      const lastUser = userMessageTexts(msgs).at(-1) ?? ''
      const lastMsg = [...msgs].reverse().find((m) => m.role !== 'system')

      if (lastMsg?.role === 'user' && lastUser.includes('建立父上下文')) {
        return fauxAssistantMessage('上下文已建立')
      }
      if (lastMsg?.role === 'user' && lastUser.includes('触发上游改写拦截')) {
        return fauxAssistantMessage(
          [
            fauxToolCall(
              'subagent',
              { prompt: '上游将改为 fork + herdr-prof', isolation: 'worktree', background: false },
              { id: 'call-transform-wt' },
            ),
          ],
          { stopReason: 'toolUse' },
        )
      }
      if (lastMsg?.role === 'toolResult' && lastMsg.toolName === 'subagent') {
        return fauxAssistantMessage('上游改写拦截完成')
      }
      throw new Error(`未预期的 faux 请求: lastRole=${lastMsg?.role}, lastUser=${lastUser}`)
    }
    faux.setResponses(Array.from({ length: 10 }, () => step))

    const app = await createHelm({
      buildProvider: createPluginBuildProvider(),
      dataDir,
      cwd: repo,
      model: 'faux/faux-1',
      models: models as never,
    })
    try {
      await app.kernel.services.profiles.save({
        id: 'herdr-prof',
        name: 'Herdr Profile',
        runtime: { kind: 'herdr', agent: 'agy' },
      })
      await app.kernel.plugins.register({
        id: 'test:upstream-fork-transform',
        definePlugin(ctx) {
          ctx.hook.onAgentSpawn(
            (req) => {
              if (req.prompt === '上游将改为 fork + herdr-prof') {
                return { action: 'transform', value: { ...req, fork: true, agentType: 'herdr-prof' } }
              }
              return { action: 'continue' }
            },
            { priority: 250 },
          )
        },
      }, { enabled: true })

      const parent = await app.kernel.createConversation({ cwd: repo })
      await app.kernel.submitInput(parent.id, '建立父上下文')
      await app.kernel.waitForIdle(parent.id)

      await app.kernel.submitInput(parent.id, '触发上游改写拦截')
      await app.kernel.waitForIdle(parent.id)

      const detail = await app.kernel.getConversationDetail(parent.id, { limit: 50 })
      const res = findToolResultByCallId(detail, 'call-transform-wt')
      assert.equal(res.isError, true)
      assert.ok(res.text.includes('unsupported_runtime') || res.text.includes('fork'), `应拒绝改写后请求：${res.text}`)

      const wt = (await app.kernel.plugins.invokeAction('builtin:workflow', 'list_worktrees', {})) as {
        worktrees: unknown[]
      }
      assert.deepEqual(wt.worktrees, [], 'WorktreeIsolation 拦截后不得分配或残留 worktree 登记')
      const gitWorktrees = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' })
      const worktreeCount = gitWorktrees.split('\n').filter((line) => line.startsWith('worktree ')).length
      assert.equal(worktreeCount, 1, `Git 仓库只应有主工作树：\n${gitWorktrees}`)
    } finally {
      await app.close()
    }
  })
})

describe('HerdrExecutor.assertNoFork 防御性拒绝', { timeout: 60_000 }, () => {
  it('herdr:* 与 Profile.runtime 携带 fork: true 抛 400 unsupported_runtime 且零 RPC；原生 passthrough continue', { timeout: 60_000 }, async () => {
    const dataDir = join(rootDir, 'herdr-executor-fork')
    mkdirSync(dataDir, { recursive: true })
    const calls: Array<{ target: HerdrTarget; method: string; params: Record<string, unknown> }> = []
    const transport: HerdrTransport = {
      async call(target, method, params) {
        calls.push({ target, method, params })
        return {}
      },
      async readOutput() {
        return ''
      },
      async removeOutput() {},
      async runGate(): Promise<AgentGateResult> {
        return { ok: true, output: '' }
      },
      async subscribe(_target, _onEvent, _onError) {
        return () => {}
      },
    }
    const nodeChannel: HerdrNodeChannel = {
      isOnline: () => true,
      getNodeHubUrl: () => 'http://127.0.0.1:3202',
      ipcCall: () => {
        throw new HelmError('unsupported', 'stub', 501)
      },
      envFor: () => {
        throw new HelmError('unsupported', 'stub', 501)
      },
    }
    let doc: ManagedDoc = { ...EMPTY_MANAGED_DOC, panes: [...EMPTY_MANAGED_DOC.panes] }
    const registry = new PaneRegistry(
      { get: () => doc, set: (next) => { doc = next } },
      doc,
    )
    const profiles = new Map<string, Profile>([
      ['herdr-prof', { id: 'herdr-prof', name: 'Herdr', runtime: { kind: 'herdr', agent: 'agy' } }],
      ['native-prof', { id: 'native-prof', name: 'Native' }],
    ])
    const host: ExecutorHost = {
      parentCwdOf: () => dataDir,
      parentNodeIdOf: () => 'local',
      askConversationId: (id) => id,
      notify: () => undefined,
      startupTimeoutMs: () => 5_000,
      createAsk: (() => {
        throw new HelmError('unsupported', 'stub', 501)
      }) as never,
      cancelAsk: (() => {
        throw new HelmError('unsupported', 'stub', 501)
      }) as never,
    }
    const executor = new HerdrExecutor(
      {
        profiles: { get: async (id) => profiles.get(id) },
        buildSpawnEnv: (_conversationId, cwd) => ({ HELM_CWD: cwd }),
        redact: (t) => t,
        runLocalGate: async () => ({ ok: true, output: '' }),
        nodeChannel,
        transport,
      },
      registry,
      new AskCoordinator(() => undefined),
      new MetadataProjector(async () => ({}), () => undefined),
      host,
      transport,
      {},
      10,
    )

    await assertRejectsCode(
      () =>
        executor.handle({
          parentConversationId: 1,
          agentType: 'herdr:agy',
          fork: 'yes' as never,
          prompt: 'x',
        }),
      'validation_error',
      400,
    )
    await assertRejectsCode(
      () =>
        executor.handle({
          parentConversationId: 1,
          agentType: 'herdr:agy',
          fork: true,
          prompt: 'x',
        }),
      'unsupported_runtime',
      400,
    )
    await assertRejectsCode(
      () =>
        executor.handle({
          parentConversationId: 1,
          agentType: 'herdr-prof',
          fork: true,
          prompt: 'x',
        }),
      'unsupported_runtime',
      400,
    )
    assert.equal(calls.length, 0, '拒绝发生在任何 Herdr RPC 之前')

    const passthrough = await executor.handle({
      parentConversationId: 1,
      agentType: 'native-prof',
      fork: true,
      prompt: 'x',
    })
    assert.deepEqual(passthrough, { action: 'continue' })
    assert.equal(calls.length, 0)
  })
})
