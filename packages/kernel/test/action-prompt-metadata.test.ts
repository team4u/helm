/**
 * action-prompt-metadata.test.ts
 *
 * action/tool hint metadata (promptSnippet / promptGuidelines) register contract:
 * - broken metadata in register boundary explicit reject (action and tool same standard);
 * - ActionManifest fidelity carry (contains no-options does not carry key);
 * - exposeAsTool action derive tool carry hint field;
 * - scope missed derive tool whole invisible (without phantom hint data);
 * - declaration register after original ground modify array do not pollute already validate data (guard against defend copy).
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
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
    description: 'action description',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: { type: 'object', properties: {} },
    handler: () => ({}),
    ...over,
  };
}

function baseTool(over: Partial<PluginToolSpec> = {}): PluginToolSpec {
  return {
    name: 'toolX',
    description: 'tool description',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    execute: () => 'ok',
    ...over,
  };
}

function expectHelmError(code: string, field: string): (err: unknown) => boolean {
  return (err: unknown): boolean => {
    assert.ok(err instanceof HelmError, `expectation HelmError, receives ${String(err)}`);
    assert.equal(err.code, code);
    assert.ok(err.message.includes(field), `errors should refer field ${field}:${err.message}`);
    return true;
  };
}

test('broken hint metadata in register boundary explicit reject: action and tool same standard', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();

  // action:snippet pure whitespace / non- string;guidelines empty array / non- array / items pure whitespace / items non- string
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

  assert.throws(
    () => cap.registerAction('p', baseAction({ promptGuidelines: new Array<string>(1) })),
    expectHelmError('invalid_action_spec', 'promptGuidelines'),
  );

  // tool: same standard (invalid_tool_spec)
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptSnippet: '\n' })),
    expectHelmError('invalid_tool_spec', 'promptSnippet'),
  );
  assert.throws(
    () => cap.registerTool('p', baseTool({ promptGuidelines: [' '] })),
    expectHelmError('invalid_tool_spec', 'promptGuidelines'),
  );

  assert.throws(
    () => cap.registerTool('p', baseTool({ promptGuidelines: new Array<string>(1) })),
    expectHelmError('invalid_tool_spec', 'promptGuidelines'),
  );

  // by refuse declaration leaves no residue register items
  assert.deepEqual(cap.getActionIds('p'), []);
  assert.deepEqual(cap.getToolNames('p'), []);

  // legal declaration (contains before after whitespace but content non-empty) via
  cap.registerAction('p', baseAction({ promptSnippet: ' use act sync config.' }));
  cap.registerTool('p', baseTool({ promptGuidelines: ['first read SKILL.md'] }));
  assert.deepEqual(cap.getActionIds('p'), ['act']);
  assert.deepEqual(cap.getToolNames('p'), ['toolX']);
});

test('ActionManifest fidelity carry hint field; not declaration does not carry key', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'withPrompt',
      promptSnippet: 'use withPrompt complete config sync.',
      promptGuidelines: ['invoke before first confirm target node online', 'result with outputSchema is allow'],
    }),
  );
  cap.registerAction('p', baseAction({ id: 'bare' }));

  const manifests = cap.listActions(['p']);
  const withPrompt = manifests.find((m) => m.id === 'withPrompt');
  const bare = manifests.find((m) => m.id === 'bare');
  assert.ok(withPrompt && bare);

  assert.equal(withPrompt.promptSnippet, 'use withPrompt complete config sync.');
  assert.deepEqual(withPrompt.promptGuidelines, ['invoke before first confirm target node online', 'result with outputSchema is allow']);
  assert.equal('promptSnippet' in bare, false);
  assert.equal('promptGuidelines' in bare, false);
});

test('exposeAsTool action derive tool carry hint field;scope missed whole invisible', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  cap.registerAction(
    'p',
    baseAction({
      id: 'scoped',
      exposeAsTool: true,
      scope: { tags: ['worker'] },
      promptSnippet: 'scoped action complete segment.',
      promptGuidelines: ['only worker conversation available'],
    }),
  );
  cap.registerTool('p', baseTool({ promptGuidelines: ['direct throw tool want point'] }));

  const worker = cap.listTools(['p'], fakeConversation(['worker']));
  const derived = worker.find((t) => t.sourceKind === 'action');
  assert.ok(derived);
  assert.equal(derived.name, actionToolAlias('p', 'scoped'));
  assert.equal(derived.qualifiedId, 'p.scoped');
  assert.equal(derived.promptSnippet, 'scoped action complete segment.');
  assert.deepEqual(derived.promptGuidelines, ['only worker conversation available']);

  const direct = worker.find((t) => t.sourceKind === 'tool');
  assert.ok(direct);
  assert.deepEqual(direct.promptGuidelines, ['direct throw tool want point']);

  // scope missed: derive tool whole filter, without leaking any hint data; without scope direct throw tool still in
  const other = cap.listTools(['p'], fakeConversation(['other']));
  assert.equal(other.some((t) => t.sourceKind === 'action'), false);
  assert.equal(other.every((t) => t.promptSnippet === undefined), true);
  assert.equal(other.some((t) => t.name === 'toolX'), true);
});

test('declaration register after original ground modify promptGuidelines do not pollute registered data', { timeout: 60_000 }, () => {
  const cap = new CapabilityRegistry();
  const guidelines = ['original want point'];
  cap.registerAction('p', baseAction({ id: 'a', promptGuidelines: guidelines }));
  const toolSpec = baseTool({ promptSnippet: 'original segment', promptGuidelines: guidelines });
  cap.registerTool('p', toolSpec);

  guidelines.push('pollute items');
  guidelines[0] = 'by change write';
  toolSpec.promptSnippet = 'by heavy bind segment';
  toolSpec.promptGuidelines = ['by heavy bind want point'];

  const manifest = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(manifest);
  assert.deepEqual(manifest.promptGuidelines, ['original want point']);

  const tool = cap.listTools(['p']).find((t) => t.name === 'toolX');
  assert.ok(tool);
  assert.equal(tool.promptSnippet, 'original segment');
  assert.deepEqual(tool.promptGuidelines, ['original want point']);

  // out station manifest again by consumer sudden change also do not back pour manual table
  manifest.promptGuidelines!.push('external pollute');
  const again = cap.listActions(['p']).find((m) => m.id === 'a');
  assert.ok(again);
  assert.deepEqual(again.promptGuidelines, ['original want point']);
});
