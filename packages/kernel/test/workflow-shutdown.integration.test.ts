import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowRunsDocState, WorkflowRunSummary } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { KernelRuntime } from '../src/runtime/runtime.js'

test('真实 SQLite：关闭在途工作流后，未启动插件也能从重开的数据库读回终态与最终投影', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-workflow-shutdown-'))
  let app: Awaited<ReturnType<typeof createHelm>> | undefined
  let reopened: KernelRuntime | undefined
  try {
    app = await createHelm({ dataDir, cwd: dataDir, watchdogIntervalMs: 0 })
    const { run } = await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      conversationId: 1,
      script: 'export const meta = { name: "shutdown-persistence", description: "验证在途任务关闭落盘" }; await new Promise(() => {})',
    }) as { run: WorkflowRunSummary }
    assert.equal(run.status, 'running')

    await app.close()
    app = undefined

    // 不注册 workflow，防止其 start() 重算 runs 投影后掩盖停止阶段的漏写。
    reopened = await KernelRuntime.open({ dataDir, cwd: dataDir, watchdogIntervalMs: 0, autoResume: false })
    assert.equal(reopened.plugins.list().some((plugin) => plugin.id === 'builtin:workflow'), false)
    const records = reopened.documentStore.get<Record<string, unknown>>('builtin:workflow:records', {})
    const persisted = Object.values(records).find((value): value is WorkflowRunSummary =>
      value !== null && typeof value === 'object' && 'id' in value && value.id === run.id,
    )
    assert.ok(persisted, '私有 records 必须从 SQLite 读回该 run，而非仅存在于旧进程镜像')
    assert.equal(persisted.status, 'aborted', JSON.stringify(persisted))
    const projection = reopened.documentStore.get<WorkflowRunsDocState>('builtin:workflow:runs', { runs: [], byConversation: {} })
    assert.equal(projection.runs.find((item) => item.id === run.id)?.status, 'aborted', '最终 runs 投影必须在插件重启前已落库')
  } finally {
    try {
      await app?.close()
    } finally {
      try {
        await reopened?.close()
      } finally {
        await rm(dataDir, { recursive: true, force: true })
      }
    }
  }
})
