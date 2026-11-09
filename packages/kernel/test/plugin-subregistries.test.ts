/**
 * plugin-subregistries.test.ts
 *
 * 针对解耦后的子模块：
 * 1. PluginDocRegistry
 * 2. CapabilityRegistry
 * 3. UiRegistry
 * 进行直接的内聚单元测试，验证其独立行为、边界检查及生命周期语义。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { HelmError, type ConversationSummary } from '@helm/protocol';
import {
  PluginDocRegistry,
  type PluginDocStore,
} from '../src/plugins/doc-registry.js';
import {
  CapabilityRegistry,
  type CapabilityExecutionOptions,
} from '../src/plugins/capability-registry.js';
import { UiRegistry } from '../src/plugins/ui-registry.js';
import { PluginTaskTracker } from '../src/plugins/tracking.js';

class MemoryDocStore implements PluginDocStore {
  data = new Map<string, unknown>();
  flushed = false;
  get<T>(key: string, initial: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : initial;
  }
  set<T>(key: string, value: T): void {
    this.data.set(key, value);
  }
  async flush(): Promise<void> {
    this.flushed = true;
  }
}

test('PluginDocRegistry：文档注册、隔离、更新通知与生命周期守卫', { timeout: 60_000 }, async () => {
  const store = new MemoryDocStore();
  const updates: Array<{ pluginId: string; name: string; value: unknown }> = [];
  const registry = new PluginDocRegistry(store, (pluginId, name, value) => {
    updates.push({ pluginId, name, value });
  });

  let usable = true;
  const assertUsable = () => {
    if (!usable) throw new HelmError('plugin_context_expired', 'doc myDoc expired', 409);
  };

  const handle = registry.registerDoc(
    'test-plugin',
    'myDoc',
    { count: 0 },
    { public: true },
    assertUsable,
  );

  assert.equal(registry.hasPublicDoc('test-plugin', 'myDoc'), true);
  assert.equal(registry.hasPublicDoc('test-plugin', 'nonExistent'), false);
  assert.deepEqual(handle.get(), { count: 0 });

  handle.set({ count: 1 });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], { pluginId: 'test-plugin', name: 'myDoc', value: { count: 1 } });
  assert.deepEqual(handle.get(), { count: 1 });

  handle.update((prev) => ({ count: prev.count + 1 }));
  assert.equal(updates.length, 2);
  assert.deepEqual(handle.get(), { count: 2 });

  await handle.flush();
  assert.equal(store.flushed, true);

  const pubDoc = registry.getPublicDoc('test-plugin', 'myDoc', true);
  assert.deepEqual(pubDoc, { pluginId: 'test-plugin', name: 'myDoc', value: { count: 2 } });

  const allPub = registry.listPublicDocs(['test-plugin']);
  assert.equal(allPub.length, 1);
  assert.deepEqual(allPub[0], pubDoc);

  // 停用态取公共文档抛 404
  assert.throws(
    () => registry.getPublicDoc('test-plugin', 'myDoc', false),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );

  // 守卫失效时抛 409
  usable = false;
  assert.throws(
    () => handle.get(),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
  );

  // 会话文档
  const sessionHandle = registry.registerSessionDoc('test-plugin', 1, 'convState', { text: 'init' });
  assert.deepEqual(sessionHandle.get(101), { text: 'init' });
  sessionHandle.set(101, { text: 'updated' });
  assert.deepEqual(sessionHandle.get(101), { text: 'updated' });
  assert.deepEqual(sessionHandle.listConversationIds(), [101]);
  sessionHandle.delete(101);
  assert.deepEqual(sessionHandle.get(101), { text: 'init' });
});

test('CapabilityRegistry：工具与动作声明、列表派生与作用域校验', { timeout: 60_000 }, async () => {
  const cap = new CapabilityRegistry();
  const tracker = new PluginTaskTracker();

  const fakeConv: ConversationSummary = {
    id: 1,
    title: 'test',
    profileId: 'agent',
    tags: ['allowed-tag'],
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

  const options: CapabilityExecutionOptions = {
    assertActive: () => {},
    getConversation: (id: number) => {
      if (id === 1) return fakeConv;
      throw new HelmError('conversation_not_found', 'not found', 404);
    },
    tracker,
    isPluginRegistered: () => true,
  };

  // 注册 action
  cap.registerAction('p1', {
    id: 'doSomething',
    description: 'test action',
    inputSchema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
    outputSchema: { type: 'object', properties: { res: { type: 'string' } } },
    exposeAsTool: true,
    scope: { tags: ['allowed-tag'] },
    handler: (input: { val: string }) => ({ res: `handled:${input.val}` }),
  });

  // 注册 tool
  cap.registerTool('p1', {
    name: 'customTool',
    description: 'test tool',
    inputSchema: { type: 'object', properties: { num: { type: 'number' } }, required: ['num'] },
    execute: (input: { num: number }) => `tool:${input.num}`,
  });

  assert.deepEqual(cap.getActionIds('p1'), ['doSomething']);
  assert.deepEqual(cap.getToolNames('p1'), ['customTool']);

  const actions = cap.listActions(['p1']);
  assert.equal(actions.length, 1);
  assert.equal(actions[0]!.id, 'doSomething');

  const tools = cap.listTools(['p1'], fakeConv);
  assert.equal(tools.length, 2); // 1 direct tool + 1 exposeAsTool action

  // 作用域不匹配时过滤
  const mismatchConv = { ...fakeConv, tags: ['other'] };
  const toolsMismatch = cap.listTools(['p1'], mismatchConv);
  assert.equal(toolsMismatch.length, 1); // exposeAsTool action 被过滤，仅剩无 scope 的 direct tool

  // invokeAction 正常执行
  const actionRes = await cap.invokeAction('p1', 'doSomething', { val: 'hello' }, { conversationId: 1 }, options);
  assert.deepEqual(actionRes, { res: 'handled:hello' });

  // executeTool 支持全限定名 pluginId.actionId
  const toolExecRes = await cap.executeTool('p1.doSomething', { val: 'via-tool' }, { conversationId: 1 }, options);
  assert.deepEqual(toolExecRes, { res: 'handled:via-tool' });

  // executeTool 直接工具调用
  const directRes = await cap.executeTool('customTool', { num: 42 }, { conversationId: 1 }, options);
  assert.equal(directRes, 'tool:42');

  // scope 越权抛 403
  await assert.rejects(
    async () => {
      await cap.invokeAction('p1', 'doSomething', { val: 'hello' }, { conversationId: 2 }, {
        ...options,
        getConversation: () => mismatchConv,
      });
    },
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_scope_violation',
  );
});

test('UiRegistry：界面扩展点收集、参数校验与依赖校验', { timeout: 60_000 }, async () => {
  const ui = new UiRegistry();

  ui.registerUi('p1', 'sidebar.item', {
    id: 'p1Sidebar',
    label: 'Test Tab',
    icon: 'Terminal',
    docs: ['statusDoc'],
  }, 'sidebarItem');

  // 重复 ID 抛 409
  assert.throws(
    () => {
      ui.registerUi('p1', 'sidebar.item', { id: 'p1Sidebar', label: 'Dup' }, 'sidebarItem');
    },
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_ui',
  );

  // 校验 docs 依赖未注册公共 doc 时抛 400
  assert.throws(
    () => {
      ui.assertUiDocsRegistered('p1', (doc) => doc === 'differentDoc');
    },
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_ui_spec',
  );

  // 校验通过
  ui.assertUiDocsRegistered('p1', (doc) => doc === 'statusDoc');

  const list = ui.listUi(['p1']);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.surface, 'sidebar.item');
  assert.equal((list[0]!.spec as { id: string }).id, 'p1Sidebar');
});

test('UiRegistry：listUi 按 activePluginIds 迭代顺序返回，不传时按内部插入顺序', { timeout: 60_000 }, async () => {
  const ui = new UiRegistry();

  // B 先声明 UI
  ui.registerUi('B', 'sidebar.item', { id: 'bItem', label: 'B Tab' }, 'sidebarItem');
  // A 后声明 UI
  ui.registerUi('A', 'sidebar.item', { id: 'aItem', label: 'A Tab' }, 'sidebarItem');

  // 传 activePluginIds = ['A', 'B'] 时，必须按 ['A', 'B'] 的顺序返回，而非内部 map 插入顺序
  const orderedList = ui.listUi(['A', 'B']);
  assert.equal(orderedList.length, 2);
  assert.equal(orderedList[0]!.pluginId, 'A');
  assert.equal((orderedList[0]!.spec as { id: string }).id, 'aItem');
  assert.equal(orderedList[1]!.pluginId, 'B');
  assert.equal((orderedList[1]!.spec as { id: string }).id, 'bItem');

  // 传 activePluginIds = ['B', 'A'] 时，按 ['B', 'A'] 顺序
  const reverseList = ui.listUi(['B', 'A']);
  assert.equal(reverseList.length, 2);
  assert.equal(reverseList[0]!.pluginId, 'B');
  assert.equal(reverseList[1]!.pluginId, 'A');

  // 不传 activePluginIds 时，按内部 map 顺序（B 先，A 后）
  const defaultList = ui.listUi();
  assert.equal(defaultList.length, 2);
  assert.equal(defaultList[0]!.pluginId, 'B');
  assert.equal(defaultList[1]!.pluginId, 'A');
});
