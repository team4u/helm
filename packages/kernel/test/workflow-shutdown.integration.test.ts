import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { WorkflowRunSummary } from '@helm/protocol'
import { createHelm } from '../src/app.js'
import { KernelRuntime } from '../src/runtime/runtime.js'
import { openHelmDatabase } from '../src/runtime/sqlite.js'

test('真实 SQLite：关闭在途工作流后，未启动插件也能从重开的数据库读回终态与最终投影', { timeout: 60_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-workflow-shutdown-'))
  let app: Awaited<ReturnType<typeof createHelm>> | undefined
  let reopened: KernelRuntime | undefined
  try {
    app = await createHelm({ dataDir, cwd: dataDir })
    const { run } = await app.kernel.plugins.invokeAction('builtin:workflow', 'run', {
      conversationId: 1,
      script: 'export const meta = { name: "shutdown-persistence", description: "验证在途任务关闭落盘" }; await new Promise(() => {})',
    }) as { run: WorkflowRunSummary }
    assert.equal(run.status, 'running')

    await app.close()
    app = undefined

    // 不注册 workflow，防止其 start() 重算 runs 投影后掩盖停止阶段的漏写。
    reopened = await KernelRuntime.open({ dataDir, cwd: dataDir, autoResume: false })
    assert.equal(reopened.plugins.list().some((plugin) => plugin.id === 'builtin:workflow'), false)
    const records = reopened.documentStore.get<Record<string, unknown>>('builtin:workflow:records', {})
    const persisted = Object.values(records).find((value): value is WorkflowRunSummary =>
      value !== null && typeof value === 'object' && 'id' in value && value.id === run.id,
    )
    assert.ok(persisted, '私有 records 必须从 SQLite 读回该 run，而非仅存在于旧进程镜像')
    assert.equal(persisted.status, 'aborted', JSON.stringify(persisted))
    await reopened.close()
    reopened = undefined

    // 直接读 state.sqlite 表：runs 会话分片（helm_plugin_session_docs）与全局
    // 紧凑角标（helm_plugin_docs）都必须在插件重启前已真实落库。
    const db = await openHelmDatabase(dataDir)
    try {
      const sessionRows = await db.db.all<{ plugin_id: string; name: string; conversation_id: number; value: string }>(
        'SELECT plugin_id, name, conversation_id, value FROM helm_plugin_session_docs WHERE plugin_id = ? AND name = ?',
        'builtin:workflow',
        'runs',
      )
      assert.equal(sessionRows.length, 1, `runs 会话分片恰有一条（会话 1；实际 ${JSON.stringify(sessionRows)}）`)
      assert.equal(sessionRows[0]!.conversation_id, 1)
      const projection = JSON.parse(sessionRows[0]!.value) as { runs: Array<{ id: string; status: string }> }
      assert.equal(
        projection.runs.find((item) => item.id === run.id)?.status,
        'aborted',
        '最终 runs 会话分片必须含该 run 的 aborted 终态',
      )
      const badgeRows = await db.db.all<{ value: string }>(
        'SELECT value FROM helm_plugin_docs WHERE plugin_id = ? AND name = ?',
        '__global',
        'builtin:workflow:run-badges',
      )
      assert.equal(badgeRows.length, 1, `run-badges 全局角标已落库（实际 ${JSON.stringify(badgeRows)}）`)
      const badges = JSON.parse(badgeRows[0]!.value) as { byConversation: Record<string, { count: number }> }
      assert.equal(badges.byConversation['1']?.count ?? 0, 1, `角标含会话 1 计数（实际 ${JSON.stringify(badges)}）`)
      // 全局层不得泄漏完整 run 摘要（badge 只允许导航元数据字段）。
      const badgeEntry = badges.byConversation['1'] as Record<string, unknown>
      for (const key of Object.keys(badgeEntry)) {
        assert.ok(
          key === 'count' || key === 'tone' || key === 'footerText',
          `run-badges 条目只允许 count/tone/footerText，发现 ${key}`,
        )
      }
    } finally {
      await db.close()
    }
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
