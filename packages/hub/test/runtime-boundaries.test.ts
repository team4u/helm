import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';
import { getCurrentTools, getCurrentSystemPrompt } from '@earendil-works/pi-ai/utils/transcript';
import { openHubTestEnv } from './helpers/hub-test-env.js';

async function openFixture() {
  return openHubTestEnv({ prefix: 'helm-runtime-boundary-' });
}

function collectStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([key, item]) => [key, ...collectStrings(item)]);
  return [];
}

test('real combine: plugin result change write, secret redaction and over long output Spill shared use eventually boundary', { timeout: 60_000 }, async () => {
  const fixture = await openFixture();
  try {
    const { kernel } = fixture.app;
    const secret = ['example"quoted', 'next line'].join('\n');
    const marker = kernel.stash.put(1, 'BOUNDARY_EXAMPLE', secret);
    let executions = 0;
    await kernel.plugins.register({
      id: 'boundary:results',
      definePlugin(ctx) {
        ctx.tool({ name: 'object_probe', description: 'test object output', inputSchema: { type: 'object' }, execute: () => { executions++; return { nested: { value: secret } }; } });
        ctx.tool({ name: 'transform_probe', description: 'test output change write', inputSchema: { type: 'object' }, execute: () => { executions++; return 'original-output'; } });
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
    await kernel.submitInput(1, 'check plugin output');
    await kernel.waitForIdle(1);
    assert.equal(executions, 2);
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

test('real combine:before_turn can filter choose kernel tool, also should use message and system segment change', { timeout: 60_000 }, async () => {
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
    await fixture.app.kernel.submitInput(1, 'check turn hook');
    await fixture.app.kernel.waitForIdle(1);
    assert.equal(sawKernelTool, true);
    assert.equal(await fixture.app.kernel.getLastAssistantText(1), 'checked');
  } finally { await fixture.close(); }
});

test('real combine: closure stop release plugin service and end still connect SSE read', { timeout: 60_000 }, async () => {
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
    // close before eventually document broadcast may already stream queue; consume completely already queue frame after must receives EOF.
    while (!(await reader.read()).done) { /* arrange empty remaining SSE frame direct until EOF */ }
    assert.equal(fixture.app.kernel.events.subscriberCount, 0);
  } finally { await fixture.close(); }
});
