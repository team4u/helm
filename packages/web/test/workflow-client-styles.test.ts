import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import * as React from 'react'
import { renderToString } from 'react-dom/server'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PluginClientContext as PluginClientContextType, WorkflowRunSummary } from '@helm/protocol'
import { compilePluginClientModule } from '../../kernel/src/plugins/client-compiler.js'
import { PluginClientContext } from '../src/lib/plugin-client-context.js'
import { evictPluginClientCache, getCachedClientComponent, loadPluginClientModule, resetPluginClientCache } from '../src/lib/plugin-client.js'
import { mountSharedPluginNamespaces, setWorkflowClientStub } from './helpers/workflow-client.js'

GlobalRegistrator.register()
mountSharedPluginNamespaces()

const context: PluginClientContextType = {
  pluginId: 'builtin:workflow',
  callAction: async () => undefined,
  openScreen: () => {},
  openSplitScreen: () => {},
  openConversationDrawer: () => {},
  openArtifact: () => {},
  openWorkbench: () => {},
  closeWorkbench: () => {},
  notify: () => {},
  submitInput: async () => {},
  getPluginSessionDoc: async () => undefined,
  getPluginDoc: async () => undefined,
  submitInput: async () => {},
  getPluginSessionDoc: async () => undefined,
  conversationId: 1,
  theme: 'dark',
}

const run: WorkflowRunSummary = {
  id: 'wf_styles', name: '阶段状态样式', conversationId: 1,
  status: 'running', parentToolCallId: 'style-call', createdAt: 1, updatedAt: 2,
  phases: [{ title: '完成阶段' }, { title: '失败阶段' }, { title: '执行阶段' }, { title: '等待阶段' }],
  nodes: [
    { id: 'done', kind: 'action', status: 'done', phaseTitle: '完成阶段', output: '已完成' },
    { id: 'failed', kind: 'action', status: 'failed', phaseTitle: '失败阶段', error: '测试失败' },
    { id: 'active', kind: 'action', status: 'running', phaseTitle: '执行阶段' },
  ],
}

test('工作流真实编译与加载：阶段状态颜色不被基础样式覆盖，停用后重新加载可恢复', { timeout: 60_000 }, async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), 'helm-workflow-css-'))
  const originalFetch = globalThis.fetch
  const originalCreateObjectURL = URL.createObjectURL
  const originalRevokeObjectURL = URL.revokeObjectURL
  const theme = document.createElement('style')
  theme.textContent = ':root { --fg-muted: #666666; --border: #333333; --bg-subtle: #eeeeee; --ok: #008800; --ok-border: #007700; --ok-bg: #ddffdd; --err: #ee0000; --err-border: #cc0000; --err-bg: #ffdddd; --accent: #0000ee; --accent-border: #0000cc; --accent-bg: #ddddff; }'
  document.head.appendChild(theme)
  const host = document.createElement('div')
  document.body.appendChild(host)
  try {
    const clientRoot = fileURLToPath(new URL('../../kernel/src/builtin-plugins/workflow/client', import.meta.url))
    const { code, contentHash } = await compilePluginClientModule('builtin:workflow', clientRoot, 'index.tsx', cacheDir)
    globalThis.fetch = async () => new Response(code, { headers: { 'x-helm-client-hash': contentHash } })
    let imports = 0
    URL.createObjectURL = () => `data:text/javascript;base64,${Buffer.from(code).toString('base64')}#${++imports}`
    URL.revokeObjectURL = () => {}
    setWorkflowClientStub({ docValue: { runs: [run] } })

    const checkColors = () => {
      const cases = [
        ['.phase-segment-done', 'ok', 'ok-border', 'ok-bg'],
        ['.phase-segment-failed', 'err', 'err-border', 'err-bg'],
        ['.phase-segment-active', 'accent', 'accent-border', 'accent-bg'],
        ['.phase-segment:not(.phase-segment-done):not(.phase-segment-failed):not(.phase-segment-active)', 'fg-muted', 'border', 'bg-subtle'],
      ] as const
      for (const [selector, foreground, border, background] of cases) {
        const phase = host.querySelector(selector)
        assert.ok(phase, `真实组件必须渲染 ${selector}`)
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
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const loaded = await loadPluginClientModule('builtin:workflow', 'index.tsx')
      const Component = loaded.module.WorkflowToolView as React.ComponentType<Record<string, unknown>>
      host.innerHTML = renderToString(React.createElement(PluginClientContext.Provider, { value: context },
        React.createElement(Component, { callId: 'style-call', toolName: 'SubagentWorkflow', status: 'running', conversationId: 1 })))
      assert.equal(document.querySelectorAll('style[data-helm-plugin-css]').length, 1, '每个有效入口只挂一份合并样式')
      checkColors()
      evictPluginClientCache('builtin:workflow')
      assert.equal(document.querySelectorAll('style[data-helm-plugin-css]').length, 0, '停用移除插件样式')
      assert.equal(getCachedClientComponent('builtin:workflow', 'index.tsx', 'WorkflowToolView'), undefined)
    }
  } finally {
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreateObjectURL
    URL.revokeObjectURL = originalRevokeObjectURL
    resetPluginClientCache()
    setWorkflowClientStub()
    host.remove()
    theme.remove()
    await rm(cacheDir, { recursive: true, force: true })
  }
})
