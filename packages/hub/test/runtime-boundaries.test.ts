import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai/utils/transcript'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openHubTestEnv, type HubTestEnv } from './helpers/hub-test-env.js'

let fixture: HubTestEnv

before(async () => {
  fixture = await openHubTestEnv({ prefix: 'helm-runtime-boundary-' })
})

after(async () => {
  await fixture?.close().catch(() => {})
})

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(collectStrings)
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...collectStrings(item)])
  return []
}

test('真实组合：插件结果改写、机密脱敏与超长输出 Spill 共用最终边界', { timeout: 60_000 }, async () => {
  const { kernel } = fixture
  const conv = await kernel.createConversation({ title: 'boundary-results' })
  const secret = ['example"quoted', 'next line'].join('\n')
  const marker = kernel.stash.put(conv.id, 'BOUNDARY_EXAMPLE', secret)
  let executions = 0
  await kernel.plugins.register({
    id: 'boundary:results',
    definePlugin(ctx) {
      ctx.tool({ name: 'object_probe', description: 'test object output', inputSchema: { type: 'object' }, execute: () => { executions++; return { nested: { value: secret } } } })
      ctx.tool({ name: 'transform_probe', description: 'test output change write', inputSchema: { type: 'object' }, execute: () => { executions++; return 'original-output' } })
      ctx.hook.onToolResult((payload) => payload.toolName === 'transform_probe'
        ? { action: 'transform', value: { ...payload, result: { output: [{ type: 'text', text: `transformed ${secret} ${'x'.repeat(40 * 1024)}` }] } } }
        : undefined)
    },
  })
  try {
    let observed: string[] = []
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('object_probe', {}), fauxToolCall('transform_probe', {})], { stopReason: 'toolUse' }),
      (context) => { observed = collectStrings(context.messages); return fauxAssistantMessage('finished') },
    ])
    await kernel.submitInput(conv.id, 'check plugin output')
    await kernel.waitForIdle(conv.id)
    assert.equal(executions, 2)
    assert.ok(observed.some((text) => text.includes(marker)))
    assert.ok(observed.some((text) => text.includes('transformed')))
    assert.ok(!observed.some((text) => text.includes('original-output')))
    assert.ok(!observed.some((text) => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))))
    const artifacts = await kernel.artifacts.list(conv.id)
    assert.equal(artifacts.length, 1)
    const spilled = await kernel.artifacts.readContent(artifacts[0]!.id)
    assert.ok(spilled.includes('transformed') && spilled.includes(marker))
    assert.ok(!spilled.includes(secret))
    const source = join(fixture.dataDir, 'sensitive.txt')
    await writeFile(source, secret)
    const registered = await kernel.artifacts.register(conv.id, source)
    assert.equal(await kernel.artifacts.readContent(registered.id), marker)
  } finally {
    await kernel.plugins.disable('boundary:results')
  }
})

test('真实组合：before_turn 可筛选内核工具，并应用消息与系统段落改写', { timeout: 60_000 }, async () => {
  const { kernel } = fixture
  const conv = await kernel.createConversation({ title: 'boundary-turn' })
  let sawKernelTool = false
  await kernel.plugins.register({
    id: 'boundary:turn',
    definePlugin(ctx) {
      ctx.hook.onBeforeTurn((turn) => {
        sawKernelTool = turn.tools.some((tool) => tool.name === 'bash')
        return {
          action: 'transform',
          value: {
            ...turn,
            tools: turn.tools.filter((tool) => tool.name === 'bash'),
            sections: [...turn.sections, { id: 'boundary.section', text: 'SECTION_AND_MESSAGE' }],
            messages: [...turn.messages, { role: 'user', content: [{ type: 'text', text: 'MESSAGE_EDIT' }] }],
          },
        }
      })
    },
  })
  try {
    fixture.faux.setResponses([(context) => {
      const tools = getCurrentTools(context.messages)
      assert.deepEqual(tools.map((tool) => tool.name), ['bash'])
      assert.ok(JSON.stringify(tools[0]!.parameters).includes('command'))
      assert.ok(getCurrentSystemPrompt(context.messages).includes('SECTION_AND_MESSAGE'))
      assert.ok(collectStrings(context.messages).includes('MESSAGE_EDIT'))
      return fauxAssistantMessage('checked')
    }])
    await kernel.submitInput(conv.id, 'check turn hook')
    await kernel.waitForIdle(conv.id)
    assert.equal(sawKernelTool, true)
    assert.equal(await kernel.getLastAssistantText(conv.id), 'checked')
  } finally {
    await kernel.plugins.disable('boundary:turn')
  }
})

test('真实组合：关闭时停止释放插件服务并结束仍连接的 SSE 读取', { timeout: 60_000 }, async () => {
  let stopped = false
  await fixture.kernel.plugins.register({
    id: 'boundary:service',
    definePlugin(ctx) {
      ctx.service({ id: 'service', start() {}, stop() { stopped = true } })
    },
  })
  const response = fixture.kernel.events.response(new Request('http://localhost/api/events'))
  const reader = response.body!.getReader()
  assert.equal((await reader.read()).done, false)
  await fixture.app.close()
  assert.equal(stopped, true)
  while (!(await reader.read()).done) { /* 排空已入队帧直至 EOF */ }
  assert.equal(fixture.kernel.events.subscriberCount, 0)
})
