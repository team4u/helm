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
  type PluginSessionDocStore,
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
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}:`
    for (const key of [...this.data.keys()]) {
      if (key.startsWith(prefix) && !key.slice(prefix.length).includes(':')) this.data.delete(key)
    }
  }
  async flush(): Promise<void> {
    this.flushed = true;
  }
}

/** 三元组键内存实现：值存 JSON 字符串，与真实持久层语义一致。 */
class MemorySessionDocStore implements PluginSessionDocStore {
  data = new Map<string, string>();
  flushed = false;
  private key(pluginId: string, name: string, conversationId: number): string {
    return `${pluginId}\u0000${name}\u0000${conversationId}`;
  }
  get(pluginId: string, name: string, conversationId: number): string | undefined {
    return this.data.get(this.key(pluginId, name, conversationId));
  }
  put(pluginId: string, name: string, conversationId: number, valueJson: string): void {
    this.data.set(this.key(pluginId, name, conversationId), valueJson);
  }
  delete(pluginId: string, name: string, conversationId: number): void {
    this.data.delete(this.key(pluginId, name, conversationId));
  }
  deletePlugin(pluginId: string): void {
    const prefix = `${pluginId}\u0000`
    for (const k of [...this.data.keys()]) {
      if (k.startsWith(prefix)) this.data.delete(k)
    }
  }
  listConversationIds(pluginId: string, name: string): number[] {
    const prefix = `${pluginId}\u0000${name}\u0000`;
    const ids: number[] = [];
    for (const k of this.data.keys()) {
      if (k.startsWith(prefix)) ids.push(Number(k.slice(prefix.length)));
    }
    return ids;
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
});

/** 构造带完整会话端口与守卫的 registry 测试环境。 */
function createSessionFixture() {
  const store = new MemoryDocStore();
  const sessionStore = new MemorySessionDocStore();
  const existing = new Set<number>([101, 202]);
  const sessionEvents: Array<Record<string, unknown>> = [];
  const registry = new PluginDocRegistry(
    store,
    () => {},
    {
      sessionStore,
      assertConversationExists: (conversationId: number) => {
        if (!existing.has(conversationId)) {
          throw new HelmError('conversation_not_found', `会话 ${conversationId} 不存在`, 404, {
            conversationId,
          });
        }
      },
      emitSessionDocUpdated: (doc) => {
        sessionEvents.push({ ...doc });
      },
    },
  );
  let usable = true;
  const assertUsable = () => {
    if (!usable) throw new HelmError('plugin_context_expired', 'sessionDoc handle expired', 409);
  };
  return { registry, store, sessionStore, sessionEvents, existing, setUsable: (v: boolean) => (usable = v), assertUsable };
}

test('PluginDocRegistry：sessionDoc 读写、会话隔离与 delete 事件回初值', { timeout: 60_000 }, async () => {
  const f = createSessionFixture();
  const handle = f.registry.registerSessionDoc(
    'test-plugin',
    'convState',
    { text: 'init' },
    { public: true },
    f.assertUsable,
  );

  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'convState'), true);
  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'nonExistent'), false);

  // 未写过时回退初值；两个会话互相隔离
  assert.deepEqual(handle.get(101), { text: 'init' });
  handle.set(101, { text: 'updated' });
  handle.set(202, { text: 'other' });
  assert.deepEqual(handle.get(101), { text: 'updated' });
  assert.deepEqual(handle.get(202), { text: 'other' });
  assert.deepEqual(handle.listConversationIds(), [101, 202]);

  handle.update(101, (prev) => ({ text: `${prev.text}!` }));
  assert.deepEqual(handle.get(101), { text: 'updated!' });

  // public 事件：set/update 均发布
  assert.equal(f.sessionEvents.length, 3);
  assert.deepEqual(f.sessionEvents[0], {
    pluginId: 'test-plugin',
    name: 'convState',
    conversationId: 101,
    value: { text: 'updated' },
  });

  // delete：持久层删除，事件 value 恒为初值且带 deleted: true
  handle.delete(101);
  assert.deepEqual(handle.get(101), { text: 'init' });
  assert.deepEqual(f.sessionEvents.at(-1), {
    pluginId: 'test-plugin',
    name: 'convState',
    conversationId: 101,
    value: { text: 'init' },
    deleted: true,
  });
  assert.deepEqual(handle.listConversationIds(), [202]);

  // 未写过的会话 delete 同样发布 deleted 事件
  f.existing.add(303);
  handle.delete(303);
  assert.deepEqual(f.sessionEvents.at(-1), {
    pluginId: 'test-plugin',
    name: 'convState',
    conversationId: 303,
    value: { text: 'init' },
    deleted: true,
  });

  await handle.flush();
  assert.equal(f.sessionStore.flushed, true);
});

test('PluginDocRegistry：sessionDoc 会话不存在与非法 ID 拒绝，绝不回退全局键', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  const handle = f.registry.registerSessionDoc('test-plugin', 'convState', { text: 'init' }, undefined, f.assertUsable);

  // 会话不存在：宿主端口原样上抛 conversation_not_found（防删后孤儿回写）
  assert.throws(
    () => handle.get(999),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );
  assert.throws(
    () => handle.set(999, { text: 'orphan' }),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );
  assert.equal(f.sessionStore.listConversationIds('test-plugin', 'convState').length, 0);

  // 非法会话 ID：非正安全整数一律 400
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => handle.get(bad),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_conversation_id',
      `conversationId=${String(bad)} 应拒绝`,
    );
  }

  // 句柄守卫失效（停用/周期更替）后一切操作拒绝
  f.setUsable(false);
  assert.throws(
    () => handle.get(101),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
  );
  assert.throws(
    () => handle.listConversationIds(),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
  );
});

test('PluginDocRegistry：doc 与 sessionDoc 禁止同名共享命名空间', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  f.registry.registerDoc('test-plugin', 'shared', { a: 1 }, undefined, f.assertUsable);
  assert.throws(
    () => f.registry.registerSessionDoc('test-plugin', 'shared', { b: 2 }, undefined, f.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_doc',
  );

  const f2 = createSessionFixture();
  f2.registry.registerSessionDoc('test-plugin', 'shared', { b: 2 }, undefined, f2.assertUsable);
  assert.throws(
    () => f2.registry.registerDoc('test-plugin', 'shared', { a: 1 }, undefined, f2.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_doc',
  );
  // 同类重复声明同样拒绝
  assert.throws(
    () => f2.registry.registerSessionDoc('test-plugin', 'shared', {}, undefined, f2.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_doc',
  );

  // opts 非法形状拒绝
  assert.throws(
    () => f2.registry.registerSessionDoc('test-plugin', 'ok', {}, { extra: 1 } as never, f2.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_doc_spec',
  );
});

test('PluginDocRegistry：sessionDoc 端口缺失显式拒绝，不静默降级', { timeout: 60_000 }, () => {
  // 无任何会话端口：声明即 501
  const bare = new PluginDocRegistry(new MemoryDocStore(), () => {});
  assert.throws(
    () => bare.registerSessionDoc('p', 'doc1', {}, undefined, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_store_unavailable' && err.status === 501,
  );
  // 仅全局 doc 的旧用法不受影响
  bare.registerDoc('p', 'globalOnly', { ok: true }, undefined, () => {});

  // 有 sessionStore 但缺会话存在性校验端口：显式 501，不假装验证
  const noAssert = new PluginDocRegistry(new MemoryDocStore(), () => {}, {
    sessionStore: new MemorySessionDocStore(),
    emitSessionDocUpdated: () => {},
  });
  assert.throws(
    () => noAssert.registerSessionDoc('p', 'doc1', {}, undefined, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_port_unavailable' && err.status === 501,
  );

  // public:true 但缺事件端口：显式 501，不静默丢更新
  const noEmit = new PluginDocRegistry(new MemoryDocStore(), () => {}, {
    sessionStore: new MemorySessionDocStore(),
    assertConversationExists: () => {},
  });
  assert.throws(
    () => noEmit.registerSessionDoc('p', 'doc1', {}, { public: true }, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_port_unavailable' && err.status === 501,
  );
  // 私有 sessionDoc 无事件端口可正常声明
  noEmit.registerSessionDoc('p', 'privateDoc', {}, undefined, () => {});
});

test('PluginDocRegistry：getPublicSessionDoc 与路由歧义提示', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  f.registry.registerSessionDoc('test-plugin', 'convState', { text: 'init' }, { public: true }, f.assertUsable);
  f.registry.registerSessionDoc('test-plugin', 'privateConv', { secret: 1 }, undefined, f.assertUsable);
  f.registry.registerDoc('test-plugin', 'globalDoc', { g: 1 }, { public: true }, f.assertUsable);

  // 正常读取：未写过回初值，写过读真实值
  assert.deepEqual(f.registry.getPublicSessionDoc('test-plugin', 'convState', 101, true), {
    pluginId: 'test-plugin',
    name: 'convState',
    conversationId: 101,
    value: { text: 'init' },
  });
  f.sessionStore.put('test-plugin', 'convState', 101, JSON.stringify({ text: 'real' }));
  assert.deepEqual(
    f.registry.getPublicSessionDoc('test-plugin', 'convState', 101, true).value,
    { text: 'real' },
  );

  // 停用 / 私有 / 未声明一律 404，不泄漏 private 存在性
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'convState', 101, false),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'privateConv', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'nonExistent', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );

  // 会话不存在：原样上抛宿主端口错误（conversation_not_found）
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'convState', 999, true),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );

  // 非法会话 ID：400
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'convState', 0, true),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_conversation_id',
  );

  // getPublicDoc 命中 public session 名：提示需 conversationId
  assert.throws(
    () => f.registry.getPublicDoc('test-plugin', 'convState', true),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_requires_conversation',
  );
  // getPublicDoc 命中 private session 名：与未声明一致 404（不泄漏存在性）
  assert.throws(
    () => f.registry.getPublicDoc('test-plugin', 'privateConv', true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
  // getPublicSessionDoc 命中 public 全局名：提示不接 conversationId
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'globalDoc', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'global_doc_unexpected_conversation',
  );
  // getPublicSessionDoc 命中 private 全局名：与未声明一致 404（不泄漏存在性）
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'noGlobal', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
});

test('PluginDocRegistry：深拷贝隔离与 clear/removePlugin 双注册表清理', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  const sessionHandle = f.registry.registerSessionDoc(
    'test-plugin',
    'convState',
    { nested: { count: 0 } },
    { public: true },
    f.assertUsable,
  );
  const globalHandle = f.registry.registerDoc(
    'test-plugin',
    'myDoc',
    { nested: { count: 0 } },
    { public: true },
    f.assertUsable,
  );

  // get 返回深拷贝：原地突变不污染持久层
  const gotSession = sessionHandle.get(101);
  gotSession.nested.count = 99;
  assert.deepEqual(sessionHandle.get(101), { nested: { count: 0 } });
  sessionHandle.set(101, { nested: { count: 1 } });
  const mutated: { nested: { count: number } } = sessionHandle.get(101);
  mutated.nested.count = 42;
  assert.deepEqual(sessionHandle.get(101).nested, { count: 1 });

  const gotGlobal = globalHandle.get();
  gotGlobal.nested.count = 99;
  assert.deepEqual(globalHandle.get(), { nested: { count: 0 } });

  // 事件载荷也是深拷贝（消费方突变不回灌）
  sessionHandle.set(101, { nested: { count: 2 } });
  (f.sessionEvents.at(-1)!.value as { nested: { count: number } }).nested.count = 77;
  assert.deepEqual(sessionHandle.get(101).nested, { count: 2 });

  // clear：两个注册表句柄同清，hasPublic*/再声明可行（周期更替语义）
  f.registry.clear('test-plugin');
  assert.equal(f.registry.hasPublicDoc('test-plugin', 'myDoc'), false);
  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'convState'), false);
  f.registry.registerDoc('test-plugin', 'myDoc', { n: 1 }, { public: true }, f.assertUsable);
  f.registry.registerSessionDoc('test-plugin', 'convState', { n: 1 }, { public: true }, f.assertUsable);

  // removePlugin：卸载后同样全清
  f.registry.removePlugin('test-plugin');
  assert.equal(f.registry.hasPublicDoc('test-plugin', 'myDoc'), false);
  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'convState'), false);
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
  }, 'sidebarItem');

  // 重复 ID 抛 409
  assert.throws(
    () => {
      ui.registerUi('p1', 'sidebar.item', { id: 'p1Sidebar', label: 'Dup' }, 'sidebarItem');
    },
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_ui',
  );

  // docs 声明已随声明式 JSON 轨道移除：assertUiDocsRegistered 为挂点，不再校验引用
  ui.assertUiDocsRegistered('p1', () => false);

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
