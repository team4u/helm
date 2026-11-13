/**
 * action-prompt-metadata.test.ts
 *
 * 动作/工具提示元数据（promptSnippet / promptGuidelines）注册契约：
 * - 坏元数据在注册边界显式拒绝（动作与工具同标准）；
 * - ActionManifest 保真携带（含 no-options 不携带键）；
 * - exposeAsTool 动作派生工具携带提示字段；
 * - scope 未命中的派生工具整体不可见（无幻影提示数据）；
 * - 声明者注册后原地修改数组不污染已校验数据（防御拷贝）。
 * runner: tsx --test；每项显式 timeout: 60_000 防死锁。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmError, type ConversationSummary, type PluginActionSpec, type PluginToolSpec } from '@helm/protocol';
import {
  CapabilityRegistry,
  actionToolAlias,
} from '../src/plugins/capability-registry.js';

function fakeConversation(tags: string[]): ConversationSummary {
  return {
    id: 1,
    title: 'test',
    profileId: 'assistant',
    tags,
    cwd: '/tmp',
    model: 'm',
    thinkingLevel: '',
    status: 'idle',
    stateChangeSeq: 1,
    completionSeq: 0,
    unread: false,
    pinned: false,
    pendingAskCount: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function baseAction(over: Partial<PluginActionSpec<unknown, unknown>> = {}): PluginActionSpec<unknown, unknown> {
  return {
    id: 'act',
    description: '动作描述',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {} },
    handler: () => ({}),
    ...over,
  };
}

function baseTool(over: Partial<PluginToolSpec> = {}): PluginToolSpec {
  return {
    name: 'toolX',
    description: '工具描述',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
    ...over,
  };
}

function expectHelmError(code: string, field: string): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof HelmError, `期望 HelmError，收到 ${String(err)}`);
    assert.equal(err.code, code);
    assert.ok(err.message.includes(field), `报错应指明字段 ${field}：${err.message}`);
    return true;
  };
}

test('坏提示元数据在注册边界显式拒绝：动作与工具同标准', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();

  // 动作：snippet 纯空白 / 非字符串；guidelines 空数组 / 非数组 / 项纯空白 / 项非字符串
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptSnippet: '   \t ' })),
    expectHelmError('invalid_action_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptSnippet: 42 as unknown as string })),
    expectHelmError('invalid_action_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: [] })),
    expectHelmError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: 'x' as unknown as string[] })),
    expectHelmError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: ['ok', '  '] })),
    expectHelmError('invalid_action_spec', 'promptGuidelines'),
  );
  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: [1] as unknown as string[] })),
    expectHelmError('invalid_action_spec', 'promptGuidelines'),
  );

  // 工具：同标准（invalid_tool_spec）
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptSnippet: '\n' })),
    expectHelmError('invalid_tool_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptGuidelines: [' '] })),
    expectHelmError('invalid_tool_spec', 'promptGuidelines'),
  );

  // 被拒声明不残留注册项
  assert.deepEqual(cap.getActionIds('p'), []);
  assert.deepEqual(cap.getToolNames('p'), []);

  // 合法声明（含前后空白但内容非空）通过
  cap.registerAction('p', baseAction({ promptSnippet: ' 使用 act 同步配置。' }));
  cap.registerTool('p', baseTool({ promptGuidelines: ['先读 SKILL.md'] }));
  assert.deepEqual(cap.getActionIds('p'), ['act']);
  assert.deepEqual(cap.getToolNames('p'), ['toolX']);
});

test('ActionManifest 保真携带提示字段；未声明不携带键', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'withPrompt',
      promptSnippet: '用 withPrompt 完成配置同步。',
      promptGuidelines: ['调用前先确认目标节点在线', '结果以 outputSchema 为准'],
    }),
  );
  cap.registerAction('p', baseAction({ id: 'bare' }));

  const manifests = cap.listActions(['p']);
  const withPrompt = manifests.find((m) => m.id === 'withPrompt');
  const bare = manifests.find((m) => m.id === 'bare');
  assert.ok(withPrompt && bare);

  assert.equal(withPrompt.promptSnippet, '用 withPrompt 完成配置同步。');
  assert.deepEqual(withPrompt.promptGuidelines, ['调用前先确认目标节点在线', '结果以 outputSchema 为准']);
  assert.equal('promptSnippet' in bare, false);
  assert.equal('promptGuidelines' in bare, false);
});

test('exposeAsTool 动作派生工具携带提示字段；scope 未命中整体不可见', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'scoped',
      exposeAsTool: true,
      scope: { tags: ['worker'] },
      promptSnippet: 'scoped 动作的完整段落。',
      promptGuidelines: ['仅 worker 会话可用'],
    }),
  );
  cap.registerTool('p', baseTool({ promptGuidelines: ['直投工具要点'] }));

  const worker = cap.listTools(['p'], fakeConversation(['worker']));
  const derived = worker.find((t) => t.sourceKind === 'action');
  assert.ok(derived);
  assert.equal(derived.name, actionToolAlias('p', 'scoped'));
  assert.equal(derived.qualifiedId, 'p.scoped');
  assert.equal(derived.promptSnippet, 'scoped 动作的完整段落。');
  assert.deepEqual(derived.promptGuidelines, ['仅 worker 会话可用']);

  const direct = worker.find((t) => t.sourceKind === 'tool');
  assert.ok(direct);
  assert.deepEqual(direct.promptGuidelines, ['直投工具要点']);

  // scope 未命中：派生工具整体过滤，不泄漏任何提示数据；无 scope 直投工具仍在
  const other = cap.listTools(['p'], fakeConversation(['other']));
  assert.equal(other.some((t) => t.sourceKind === 'action'), false);
  assert.equal(other.every((t) => t.promptSnippet === undefined), true);
  assert.equal(other.some((t) => t.name === 'toolX'), true);
});

test('声明者注册后原地修改 promptGuidelines 不污染已注册数据', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  const guidelines = ['原始要点'];
  cap.registerAction('p', baseAction({ id: 'a', promptGuidelines: guidelines }));
  cap.registerTool('p', baseTool({ promptGuidelines: guidelines }));

  guidelines.push('污染项');
  guidelines[0] = '被改写';

  const manifest = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(manifest);
  assert.deepEqual(manifest.promptGuidelines, ['原始要点']);

  const tool = cap.listTools(['p']).find((t) => t.name === 'toolX');
  assert.ok(tool);
  assert.deepEqual(tool.promptGuidelines, ['原始要点']);

  // 出站清单再被消费方突变也不回灌注册表
  manifest.promptGuidelines!.push('外部污染');
  const again = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(again);
  assert.deepEqual(again.promptGuidelines, ['原始要点']);
});
