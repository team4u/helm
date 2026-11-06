import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import { createHelm } from '../src/app.js';

async function openFixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'helm-runtime-boundary-'));
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  const app = await createHelm({ dataDir, cwd: dataDir, models, model: 'faux/faux-1' });
  return { app, faux, dataDir, async close() { await app.close(); await rm(dataDir, { recursive: true, force: true }); } };
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...collectStrings(item)]);
  return [];
}

test('真实组合：插件结果改写、机密脱敏与超长输出 Spill 共用最终边界', { timeout: 60_000 }, async () => {
  const fixture = await openFixture();
  try {
    const { kernel } = fixture.app;
    const secret = ['example"quoted', 'next line'].join('\n');
    const marker = kernel.stash.put(1, 'BOUNDARY_EXAMPLE', secret);
    await kernel.plugins.register({
      id: 'boundary:results',
      definePlugin(ctx) {
        ctx.tool({ name: 'object_probe', description: '测试对象输出', inputSchema: { type: 'object' }, execute: () => ({ nested: { value: secret } }) });
        ctx.tool({ name: 'transform_probe', description: '测试输出改写', inputSchema: { type: 'object' }, execute: () => 'original-output' });
        ctx.hook.onToolResult((payload) => payload.toolName === 'transform_probe'
          ? { action: 'transform', value: { ...payload, result: { output: [{ type: 'text', text: `transformed ${secret} ${'x'.repeat(40 * 1024)}` }] } } }
          : undefined);
      },
    });
    let observed: string[] = [];
    fixture.faux.setResponses([
      fauxAssistantMessage([fauxToolCall('object_probe', {}), fauxToolCall('transform_probe', {})], { stopReason: 'toolUse' }),
      (context) => { observed = collectStrings(context.messages); return fauxAssistantMessage('finished'); },
    ]);
    await kernel.submitInput(1, '检查插件输出');
    await kernel.waitForIdle(1);
    assert.ok(observed.some((text) => text.includes(marker)));
    assert.ok(observed.some((text) => text.includes('transformed')));
    assert.ok(!observed.some((text) => text.includes('original-output')));
    assert.ok(!observed.some((text) => text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))));
    const artifacts = await kernel.artifacts.list(1);
    assert.equal(artifacts.length, 1);
    const spilled = await kernel.artifacts.readContent(artifacts[0]!.id);
    assert.ok(spilled.includes('transformed') && spilled.includes(marker));
    assert.ok(!spilled.includes(secret));
    const source = join(fixture.dataDir, 'sensitive.txt');
    await writeFile(source, secret);
    const registered = await kernel.artifacts.register(1, source);
    assert.equal(await kernel.artifacts.readContent(registered.id), marker);
  } finally { await fixture.close(); }
});

test('真实组合：before_turn 可筛选内核工具，同时应用消息与系统段变更', { timeout: 60_000 }, async () => {
  const fixture = await openFixture();
  try {
    let sawKernelTool = false;
    await fixture.app.kernel.plugins.register({
      id: 'boundary:turn',
      definePlugin(ctx) {
        ctx.hook.onBeforeTurn((turn) => {
          sawKernelTool = turn.tools.some((tool) => tool.name === 'bash');
          return { action: 'transform', value: {
            ...turn,
            tools: turn.tools.filter((tool) => tool.name === 'bash'),
            sections: [...turn.sections, { id: 'boundary.section', text: 'SECTION_AND_MESSAGE' }],
            messages: [...turn.messages, { role: 'user', content: [{ type: 'text', text: 'MESSAGE_EDIT' }] }],
          } };
        });
      },
    });
    fixture.faux.setResponses([(context) => {
      const tools = getCurrentTools(context.messages);
      assert.deepEqual(tools.map((tool) => tool.name), ['bash']);
      assert.ok(JSON.stringify(tools[0]!.parameters).includes('command'));
      assert.ok(getCurrentSystemPrompt(context.messages).includes('SECTION_AND_MESSAGE'));
      assert.ok(collectStrings(context.messages).includes('MESSAGE_EDIT'));
      return fauxAssistantMessage('checked');
    }]);
    await fixture.app.kernel.submitInput(1, '检查回合钩子');
    await fixture.app.kernel.waitForIdle(1);
    assert.equal(sawKernelTool, true);
    assert.equal(await fixture.app.kernel.getLastAssistantText(1), 'checked');
  } finally { await fixture.close(); }
});

test('真实组合：关停释放插件服务并结束仍连接的 SSE 读取', { timeout: 60_000 }, async () => {
  const fixture = await openFixture();
  try {
    let stopped = false;
    await fixture.app.kernel.plugins.register({ id: 'boundary:service', definePlugin(ctx) {
      ctx.service({ id: 'service', start() {}, stop() { stopped = true; } });
    } });
    const response = fixture.app.kernel.events.response(new Request('http://localhost/api/events'));
    const reader = response.body!.getReader();
    assert.equal((await reader.read()).done, false);
    await fixture.app.close();
    assert.equal(stopped, true);
    assert.equal((await reader.read()).done, true);
    assert.equal(fixture.app.kernel.events.subscriberCount, 0);
  } finally { await fixture.close(); }
});
