import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { KernelRuntime } from '../src/runtime/index.js'
import { createWorkflowPlugin } from '../src/builtin-plugins/workflow.js'

test('外部子代理执行元数据的工具正文与持久结果统一脱敏', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-spawn-metadata-'))
  const models = createModels()
  const faux = fauxProvider() as unknown as {
    provider: Parameters<typeof models.setProvider>[0]
    setResponses(responses: unknown[]): void
  }
  models.setProvider(faux.provider)
  const kernel = await KernelRuntime.open({ dataDir, cwd: dataDir, models, model: 'faux/faux-1', watchdogIntervalMs: 0 })
  try {
    const secret = 'private-metadata-folder'
    kernel.stash.put(1, 'PATH_SECRET', secret)
    // subagent 工具由 builtin:workflow 插件提供（进程内 state 即可）。
    const docs = new Map<string, unknown>()
    await kernel.plugins.register(createWorkflowPlugin({
      state: {
        get: <T>(key: string, initial: T): T => (docs.has(key) ? (docs.get(key) as T) : initial),
        set: <T>(key: string, value: T): void => {
          docs.set(key, value)
        },
      },
    }))
    await kernel.plugins.register({
      id: 'test:metadata-boundary',
      definePlugin(ctx) {
        ctx.hook.onAgentSpawn((request) => {
          request.onResolved?.({
            nodeId: 'local',
            executionId: 'pane-9',
            effectiveCwd: `/srv/${secret}/task`,
            worktree: { path: `/srv/${secret}/task`, branch: `helm/${secret}/task` },
          })
          return { action: 'handled', result: { answer: 42 } }
        })
      },
    })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('subagent', { prompt: '检查元数据', agentType: 'herdr:pi' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('完成'),
    ])
    await kernel.submitInput(1, '执行任务')
    await kernel.waitForIdle(1)
    const detail = await kernel.getConversationDetail(1, { limit: 30 })
    const output = JSON.stringify(detail)
    assert.ok(detail.entries.some((entry) => entry.kind === 'pi.tool-result'))
    assert.ok(output.includes('pane-9'), '非机密续接标识仍可读取')
    assert.ok(output.includes('[REDACTED:'), '正文或元数据应包含真实 stash 标记')
    assert.ok(!output.includes(secret), '执行目录与分支中的机密不得落入工具正文或结构化结果')
  } finally {
    await kernel.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
