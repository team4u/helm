import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowRunSummary } from '../src/contracts.js'
import { createHelmx } from '../../hub/src/app.js'
import { KernelRuntime } from '../../kernel/src/runtime/runtime.js'
import { openHelmxDatabase } from '../../kernel/src/runtime/sqlite.js'
import { createPluginBuildProvider } from '@helmx/plugin-build'

async function verifyShutdownPersistence(options: { autoRecover: boolean }): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), 'helmx-workflow-shutdown-'))
  let app: Awaited<ReturnType<typeof createHelmx>> | undefined
  let reopened: KernelRuntime | undefined
  let reopenedApp: Awaited<ReturnType<typeof createHelmx>> | undefined
  const expectedStatus = options.autoRecover ? 'running' : 'aborted'
  try {
    app = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir })
    if (!options.autoRecover) {
      await app.kernel.plugins.setConfig('builtin:workflow', { autoRecoverOnRestart: false })
    }
    const { run } = await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      conversationId: 1,
      script: 'export const meta = { name: "shutdown-persistence", description: "验证在途任务关闭落盘" }; await new Promise(() => {})',
    }) as { run: WorkflowRunSummary }
    assert.equal(run.status, 'running')

    await app.close()
    app = undefined

    // 不注册 workflow，直接校验持久层 records 与 .record.json。
    reopened = await KernelRuntime.open({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir, autoResume: false })
    assert.equal(reopened.plugins.list().some((plugin) => plugin.id === 'builtin:workflow'), false)
    const records = reopened.documentStore.get<Record<string, unknown>>('builtin:workflow:records', {})
    const index = (records['workflow/runs'] as Array<Partial<WorkflowRunSummary>> | undefined) ?? []
    const entry = index.find((item) => item?.id === run.id)
    assert.ok(entry, `私有 records 索引必须从 SQLite 读回该 run（实际 ${JSON.stringify(index)}）`)
    assert.equal(entry.status, expectedStatus, JSON.stringify(entry))
    const persisted = JSON.parse(
      await readFile(join(dataDir, 'plugins', 'builtin%3Aworkflow', 'artifacts', '1', `workflow-${run.id}.record.json`), 'utf-8'),
    ) as WorkflowRunSummary & { suspendedCleanly?: boolean }
    assert.equal(persisted.status, expectedStatus, JSON.stringify(persisted))
    if (options.autoRecover) {
      assert.equal(persisted.suspendedCleanly, true, '默认优雅关停必须落盘 suspendedCleanly=true')
    } else {
      assert.equal(persisted.suspendedCleanly, undefined)
    }
    await reopened.close()
    reopened = undefined

    // durable: false 契约：runs 与 run-badges 为纯内存瞬态投影，SQLite 零落库、零写放大。
    const db = await openHelmxDatabase(dataDir)
    try {
      const sessionRows = await db.db.all<{ plugin_id: string; name: string; conversation_id: number; value: string }>(
        'SELECT plugin_id, name, conversation_id, value FROM helmx_plugin_session_docs WHERE plugin_id = ? AND name = ?',
        'builtin:workflow',
        'runs',
      )
      assert.equal(sessionRows.length, 0, `runs 瞬态分片不得写入 SQLite（实际 ${JSON.stringify(sessionRows)}）`)
      const badgeRows = await db.db.all<{ value: string }>(
        'SELECT value FROM helmx_plugin_docs WHERE plugin_id = ? AND name = ?',
        '__global',
        'builtin:workflow:run-badges',
      )
      assert.equal(badgeRows.length, 0, `run-badges 瞬态角标不得写入 SQLite（实际 ${JSON.stringify(badgeRows)}）`)
    } finally {
      await db.close()
    }

    // 经 createHelmx 完整重开：start() 从私有持久层恢复并在内存中干净重投影 runs 与 run-badges。
    reopenedApp = await createHelmx({ buildProvider: createPluginBuildProvider(), dataDir, cwd: dataDir })
    const projection = reopenedApp.kernel.plugins.getPublicSessionDoc('builtin:workflow', 'runs', 1).value as {
      runs: Array<{ id: string; status: string }>
    }
    assert.equal(
      projection.runs.find((item) => item.id === run.id)?.status,
      expectedStatus,
      `重开后内存 runs 分片必须含该 run 的 ${expectedStatus} 状态`,
    )
    const badges = reopenedApp.kernel.plugins.getPublicDoc('builtin:workflow', 'run-badges').value as {
      byConversation: Record<string, Record<string, unknown>>
    }
    const badgeEntry = badges.byConversation['1']
    assert.ok(badgeEntry, `重开后内存 run-badges 应含会话 1 角标（实际 ${JSON.stringify(badges)}）`)
    assert.equal(badgeEntry['count'], 1)
    for (const key of Object.keys(badgeEntry)) {
      assert.ok(
        key === 'count' || key === 'tone' || key === 'footerText',
        `run-badges 条目只允许 count/tone/footerText，发现 ${key}`,
      )
    }
    await reopenedApp.close()
    reopenedApp = undefined
  } finally {
    try {
      await app?.close()
    } finally {
      try {
        await reopened?.close()
      } finally {
        try {
          await reopenedApp?.close()
        } finally {
          await rm(dataDir, { recursive: true, force: true })
        }
      }
    }
  }
}

test('真实 SQLite（默认 autoRecoverOnRestart=true）：关闭在途工作流后走 suspend 挂起落盘 running + suspendedCleanly 与最终投影', { timeout: 60_000 }, async () => {
  await verifyShutdownPersistence({ autoRecover: true })
})

test('真实 SQLite（autoRecoverOnRestart=false 回退路径）：关闭在途工作流后落盘 aborted 终态与最终投影', { timeout: 60_000 }, async () => {
  await verifyShutdownPersistence({ autoRecover: false })
})
