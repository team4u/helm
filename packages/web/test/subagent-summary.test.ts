/**
 * builtin:workflow 插件 client 纯逻辑测试（经 kernel 真实 esbuild 编译产物）：
 * - resolveSubagentElapsedMs / resolveSubagentHeaderSnippet / buildSubagentStatSegments
 *   迁移自原 subagent-live-model.ts（语义不变：后台完成结果与耗时来自 run）。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ConversationEntry, WorkflowRunSummary } from '@helm/protocol'
import { importWorkflowModels, mountSharedPluginNamespaces } from './helpers/workflow-client.js'

mountSharedPluginNamespaces()
const m = await importWorkflowModels()

const run: WorkflowRunSummary = {
  id: 'wf_current', name: '本次任务', kind: 'subagent', conversationId: 1,
  status: 'completed', createdAt: 1000, updatedAt: 9000,
  nodes: [{ id: 'agent', kind: 'agent', status: 'done', durationMs: 8000, output: '本轮测试通过' }],
}

test('后台完成结果与耗时来自 run，不来自父工具返回启动句柄的结果和耗时', { timeout: 60_000 }, () => {
  const toolSummary = { durationMs: 12, resultText: JSON.stringify({ ok: true, runId: run.id, status: 'running' }) }
  assert.equal(m.resolveSubagentElapsedMs({ backgroundRun: run, toolSummary }), 8000)
  assert.deepEqual(m.resolveSubagentHeaderSnippet({ badgeStatus: 'done', backgroundRun: run, toolSummary }), { kind: 'done', text: '本轮测试通过' })
  assert.equal(m.resolveSubagentHeaderSnippet({ badgeStatus: 'done', backgroundRun: { ...run, nodes: [] }, toolSummary }), undefined)
})

test('当前正文生成优先于保留的旧思考快照', { timeout: 60_000 }, () => {
  const snippet = m.resolveSubagentHeaderSnippet({ badgeStatus: 'working', live: {
    conversationId: 12, text: '正在生成结论', thinking: '先检查测试结果', tools: [], updatedAt: 1,
  } })
  assert.deepEqual(snippet, { kind: 'text', tag: '输出', text: '正在生成结论' })
})

test('新一轮输入尚无回答时，不把上一轮 assistant 结论作为本轮结果', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [
    { id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text: '旧轮次结论' }] }] },
    { id: '2', kind: 'helm.input', data: { text: '重新执行' } },
  ]
  assert.equal(m.resolveSubagentHeaderSnippet({ badgeStatus: 'done', entries }), undefined)
  assert.deepEqual(m.resolveSubagentHeaderSnippet({ badgeStatus: 'done', entries, toolSummary: { resultText: '本轮结果' } }), { kind: 'done', text: '本轮结果' })
})

test('路径按执行会话 cwd 缩短，支持远端目录和 Windows，不硬编码宿主仓库', { timeout: 60_000 }, () => {
  assert.deepEqual(m.formatSemanticToolAction('read', { path: '/workspace/project/src/app.ts' }, '/workspace/project'), { tag: '读取', text: 'src/app.ts' })
  assert.deepEqual(m.formatSemanticToolAction('read', { path: 'C:\\work\\project\\app.ts' }, 'C:\\work\\project'), { tag: '读取', text: 'app.ts' })
  assert.equal(m.formatSemanticToolAction('read', { path: '/root/code/helm/app.ts' }).text, '/root/code/helm/app.ts')
})

test('已加载工具数量按 callId 合并 live，不将分页记录伪装为本轮完整步数', { timeout: 60_000 }, () => {
  const entries: ConversationEntry[] = [{ id: '1', kind: 'pi.assistant', model: [{ role: 'assistant', content: [
    { type: 'toolCall', id: 'a', name: 'read', arguments: { path: 'a.ts' } },
  ] }] }]
  const stats = m.buildSubagentStatSegments({ entries, live: { conversationId: 12, text: '', tools: [
    { callId: 'a', toolName: 'read', status: 'done' },
    { callId: 'b', toolName: 'bash', status: 'running' },
  ], updatedAt: 1 } })
  assert.deepEqual(stats, ['已载 2 次工具'])
})
import { buildTimelineItems } from '../src/conversation/timeline-model.js'

test('工具计时起点来自本次持久化调用条目，后续 resume 不复用会话创建时间', { timeout: 60_000 }, () => {
  const items = buildTimelineItems([{ id: '1', kind: 'pi.assistant', createdAt: 10000, model: [{ role: 'assistant', content: [
    { type: 'toolCall', id: 'spawn_current', name: 'subagent', arguments: { resume: '12', prompt: '继续' } },
  ] }] }], { working: true })
  const item = items[0]
  assert.ok(item?.kind === 'assistant')
  // 插件化后 subagent 不再硬编码豁免折叠（tool.view 未注册时随常规步骤入组）
  const seg = item.segments.find((s) => s.kind === 'step-group') ?? item.segments[0]
  assert.ok(seg?.kind === 'step-group')
  const step = seg.steps.find((s) => s.kind === 'tool')
  assert.ok(step?.kind === 'tool')
  assert.equal(step.tool.startedAt, 10000)
  assert.equal(m.resolveSubagentElapsedMs({ toolSummary: { startedAt: step.tool.startedAt }, isWorking: true, nowMs: 14000 }), 4000)
})
