/**
 * builtin:workflow 插件真实编译 CSS 与样式不变量测试（零 @helm/web 依赖）：
 * - 验证 compilePluginClientModule 导出的 __helmClientCss 注入后，阶段胶囊状态色
 *   不被通用基样式覆盖；
 * - 验证 styles.css 中整卡 hover、子级强调底色、唯一右推 .subagent-live-elapsed
 *   与窄屏可见性规则完整存在。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { compilePluginClientModule } from '@helm/plugin-build'
import { PLUGIN_CLIENT_CSS_EXPORT } from '@helm/protocol'
import type { WorkflowRunSummary } from '../src/contracts.js'
import {
  React,
  WORKFLOW_CLIENT_ROOT,
  createWorkflowHostHarness,
  makeConvSummary,
  mountSharedPluginNamespaces,
} from './helpers/workflow-client-harness.js'

mountSharedPluginNamespaces({ realHooks: true })

const run: WorkflowRunSummary = {
  id: 'wf_styles',
  name: '阶段状态样式',
  conversationId: 1,
  status: 'running',
  parentToolCallId: 'style-call',
  createdAt: 1,
  updatedAt: 2,
  phases: [{ title: '完成阶段' }, { title: '失败阶段' }, { title: '执行阶段' }, { title: '等待阶段' }],
  nodes: [
    { id: 'done', kind: 'action', status: 'done', phaseTitle: '完成阶段', output: '已完成' },
    { id: 'failed', kind: 'action', status: 'failed', phaseTitle: '失败阶段', error: '测试失败' },
    { id: 'active', kind: 'action', status: 'running', phaseTitle: '执行阶段' },
  ],
}

test('工作流真实编译样式：__helmClientCss 注入后阶段状态颜色表达正确', { timeout: 60_000 }, async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'helm-workflow-css-'))
  const theme = document.createElement('style')
  theme.textContent = ':root { --fg-muted: #666666; --border: #333333; --bg-subtle: #eeeeee; --ok: #008800; --ok-border: #007700; --ok-bg: #ddffdd; --err: #ee0000; --err-border: #cc0000; --err-bg: #ffdddd; --accent: #0000ee; --accent-border: #0000cc; --accent-bg: #ddddff; }'
  document.head.appendChild(theme)
  const pluginStyle = document.createElement('style')
  pluginStyle.setAttribute('data-helm-plugin-css', 'builtin:workflow:index.tsx')
  document.head.appendChild(pluginStyle)
  const host = document.createElement('div')
  document.body.appendChild(host)
  try {
    const { code } = await compilePluginClientModule('builtin:workflow', WORKFLOW_CLIENT_ROOT, 'index.tsx', cacheDir)
    const mod = (await import(`data:text/javascript;base64,${Buffer.from(code, 'utf8').toString('base64')}`)) as Record<string, unknown>
    const css = mod[PLUGIN_CLIENT_CSS_EXPORT]
    assert.ok(typeof css === 'string' && css.length > 0, '编译产物必须导出插件合并 CSS')
    pluginStyle.textContent = css

    const Panel = mod['WorkflowWorkbenchPanel'] as React.ComponentType<Record<string, unknown>>
    const conv = makeConvSummary(1, { status: 'working', profileId: 'assistant' })
    const h = createWorkflowHostHarness({
      conversationId: 1,
      conversations: [conv],
      runsByConversation: { 1: [run] },
    })
    const ui = h.mountNode(React.createElement(Panel, { conversation: conv }))
    try {
      const cases = [
        ['.phase-segment-done', 'ok', 'ok-border', 'ok-bg'],
        ['.phase-segment-failed', 'err', 'err-border', 'err-bg'],
        ['.phase-segment-active', 'accent', 'accent-border', 'accent-bg'],
        ['.phase-segment:not(.phase-segment-done):not(.phase-segment-failed):not(.phase-segment-active)', 'fg-muted', 'border', 'bg-subtle'],
      ] as const
      for (const [selector, foreground, border, background] of cases) {
        const phase = ui.container.querySelector(selector)
        assert.ok(phase !== null, `真实组件必须渲染 ${selector}`)
        const reference = document.createElement('span')
        reference.style.cssText = `color: var(--${foreground}); border: 1px solid var(--${border}); background: var(--${background});`
        document.body.appendChild(reference)
        try {
          const actual = getComputedStyle(phase)
          const expected = getComputedStyle(reference)
          assert.equal(actual.color, expected.color, `${selector} 文字颜色必须表达状态`)
          assert.equal(actual.borderTopColor, expected.borderTopColor, `${selector} 边框颜色必须表达状态`)
          assert.equal(actual.backgroundColor, expected.backgroundColor, `${selector} 背景颜色必须表达状态`)
        } finally {
          reference.remove()
        }
      }
    } finally {
      ui.unmount()
    }
  } finally {
    host.remove()
    pluginStyle.remove()
    theme.remove()
    await rm(cacheDir, { recursive: true, force: true })
  }
})

test('插件自有样式契约：整卡统一 hover 与唯一右推耗时位', { timeout: 60_000 }, () => {
  const pluginCss = readFileSync(join(WORKFLOW_CLIENT_ROOT, 'styles.css'), 'utf-8')
  assert.ok(pluginCss.includes('.subagent-card-clickable:hover'), '插件样式应包含整卡 hover 高亮规则')
  assert.match(
    pluginCss,
    /\.subagent-card-clickable:hover:not\(:has\(\.execution-children:hover/,
    '移入内层多级子会话区域时，外层父卡不得同时高亮',
  )
  assert.match(
    pluginCss,
    /\.execution-child-clickable:hover\s*\{[\s\S]*?background:\s*var\(--accent-bg\)/,
    '内层子会话行 hover 应使用与外层父卡区分的强调底色',
  )
  assert.ok(!pluginCss.includes('.subagent-live-trigger:hover'), '严禁为 trigger 设置独立 hover 背景')
  assert.ok(!pluginCss.includes('.subagent-live-subline:hover'), '严禁为 subline 设置独立 hover 背景')
  assert.match(pluginCss, /\.subagent-live-elapsed\s*\{[\s\S]*?margin-left:\s*auto/, '总耗时位应持有唯一右推 auto margin')
  assert.doesNotMatch(pluginCss, /\.subagent-live-stats\s*\{[^}]*margin-left/, '统计尾注不得再持有右推 margin（避免双 auto margin 空洞）')
  assert.doesNotMatch(pluginCss, /\.subagent-live-elapsed[^{]*\{[^}]*display:\s*none/, '总耗时位不得被窄屏规则隐藏')
})
