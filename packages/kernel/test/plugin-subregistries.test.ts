/**
 * plugin-subregistries.test.ts
 *
 * for decouple after sub- module:
 * 1. PluginDocRegistry
 * 2. CapabilityRegistry
 * 3. UiRegistry
 * enter row directly inside gather unit test, verify its independent behavior, boundary check and lifecycle semantics.
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
import { MemoryDocStore } from './helpers.js';

class TrackedDocStore extends MemoryDocStore {
  flushed = false;
  override async flush(): Promise<void> {
    this.flushed = true;
  }
}

/** three meta group key memory implement: value store JSON string, and real durable layer semantics consistent. */
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

test('PluginDocRegistry: document register, isolated, update notify and lifecycle guard', { timeout: 60_000 }, async () => {
  const store = new TrackedDocStore();
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

  // deactivate state take public document throw 404
  assert.throws(
    () => registry.getPublicDoc('test-plugin', 'myDoc', false),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );

  // guard expires when throw 409
  usable = false;
  assert.throws(
    () => handle.get(),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_context_expired',
  );
});

/** construct carries complete conversation port and guard registry test environment. */
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
          throw new HelmError('conversation_not_found', `conversation ${conversationId} missing`, 404, {
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

test('PluginDocRegistry:sessionDoc read write, conversation isolated and delete event back initial value', { timeout: 60_000 }, async () => {
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

  // not write when fall back initial value; two conversation mutual each other isolated
  assert.deepEqual(handle.get(101), { text: 'init' });
  handle.set(101, { text: 'updated' });
  handle.set(202, { text: 'other' });
  assert.deepEqual(handle.get(101), { text: 'updated' });
  assert.deepEqual(handle.get(202), { text: 'other' });
  assert.deepEqual(handle.listConversationIds(), [101, 202]);

  handle.update(101, (prev) => ({ text: `${prev.text}!` }));
  assert.deepEqual(handle.get(101), { text: 'updated!' });

  // public event:set/update all publish
  assert.equal(f.sessionEvents.length, 3);
  assert.deepEqual(f.sessionEvents[0], {
    pluginId: 'test-plugin',
    name: 'convState',
    conversationId: 101,
    value: { text: 'updated' },
  });

  // delete: durable layer delete, event value constant is initial value and carries deleted: true
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

  // not write conversation delete same publish deleted event
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

test('PluginDocRegistry:sessionDoc conversation missing and illegal ID reject, never fall back global key', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  const handle = f.registry.registerSessionDoc('test-plugin', 'convState', { text: 'init' }, undefined, f.assertUsable);

  // conversation missing: host port original on throw conversation_not_found(guard against delete after orphan child back write)
  assert.throws(
    () => handle.get(999),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );
  assert.throws(
    () => handle.set(999, { text: 'orphan' }),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );
  assert.equal(f.sessionStore.listConversationIds('test-plugin', 'convState').length, 0);

  // illegal conversation ID: non- correct security integer one rule 400
  for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => handle.get(bad),
      (err: unknown) => err instanceof HelmError && err.code === 'invalid_conversation_id',
      `conversationId=${String(bad)} should reject`,
    );
  }

  // handle guard expires (deactivate/cycle more replace) after everything operation reject
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

test('PluginDocRegistry:doc and sessionDoc forbidden same name sharing naming empty between', { timeout: 60_000 }, () => {
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
  // same class duplicate declaration same reject
  assert.throws(
    () => f2.registry.registerSessionDoc('test-plugin', 'shared', {}, undefined, f2.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_doc',
  );

  // opts illegal shape reject
  assert.throws(
    () => f2.registry.registerSessionDoc('test-plugin', 'ok', {}, { extra: 1 } as never, f2.assertUsable),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_doc_spec',
  );
});

test('PluginDocRegistry:sessionDoc port missing explicit reject, not silently fall back', { timeout: 60_000 }, () => {
  // without any conversation port: declaration i.e. 501
  const bare = new PluginDocRegistry(new MemoryDocStore(), () => {});
  assert.throws(
    () => bare.registerSessionDoc('p', 'doc1', {}, undefined, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_store_unavailable' && err.status === 501,
  );
  // only global doc old use method do not subject to affect
  bare.registerDoc('p', 'globalOnly', { ok: true }, undefined, () => {});

  // has sessionStore but missing conversation store in validate port: explicit 501, do not pretend verify
  const noAssert = new PluginDocRegistry(new MemoryDocStore(), () => {}, {
    sessionStore: new MemorySessionDocStore(),
    emitSessionDocUpdated: () => {},
  });
  assert.throws(
    () => noAssert.registerSessionDoc('p', 'doc1', {}, undefined, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_port_unavailable' && err.status === 501,
  );

  // public:true but missing event port: explicit 501, not silently lose update
  const noEmit = new PluginDocRegistry(new MemoryDocStore(), () => {}, {
    sessionStore: new MemorySessionDocStore(),
    assertConversationExists: () => {},
  });
  assert.throws(
    () => noEmit.registerSessionDoc('p', 'doc1', {}, { public: true }, () => {}),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_port_unavailable' && err.status === 501,
  );
  // private sessionDoc without event port can normal declaration
  noEmit.registerSessionDoc('p', 'privateDoc', {}, undefined, () => {});
});

test('PluginDocRegistry:getPublicSessionDoc and routing ambiguity hint', { timeout: 60_000 }, () => {
  const f = createSessionFixture();
  f.registry.registerSessionDoc('test-plugin', 'convState', { text: 'init' }, { public: true }, f.assertUsable);
  f.registry.registerSessionDoc('test-plugin', 'privateConv', { secret: 1 }, undefined, f.assertUsable);
  f.registry.registerDoc('test-plugin', 'globalDoc', { g: 1 }, { public: true }, f.assertUsable);

  // normal read: not write back initial value, write read real value
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

  // deactivate / private / not declaration one rule 404, without leaking private store in
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

  // conversation missing: original on throw host port error (conversation_not_found)
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'convState', 999, true),
    (err: unknown) => err instanceof HelmError && err.code === 'conversation_not_found',
  );

  // illegal conversation ID:400
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'convState', 0, true),
    (err: unknown) => err instanceof HelmError && err.code === 'invalid_conversation_id',
  );

  // getPublicDoc hit public session name: hint must conversationId
  assert.throws(
    () => f.registry.getPublicDoc('test-plugin', 'convState', true),
    (err: unknown) => err instanceof HelmError && err.code === 'session_doc_requires_conversation',
  );
  // getPublicDoc hit private session name: and not declaration consistent 404(without leaking store in)
  assert.throws(
    () => f.registry.getPublicDoc('test-plugin', 'privateConv', true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
  // getPublicSessionDoc hit public global name: hint do not connect conversationId
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'globalDoc', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'global_doc_unexpected_conversation',
  );
  // getPublicSessionDoc hit private global name: and not declaration consistent 404(without leaking store in)
  assert.throws(
    () => f.registry.getPublicSessionDoc('test-plugin', 'noGlobal', 101, true),
    (err: unknown) => err instanceof HelmError && err.code === 'plugin_doc_not_found',
  );
});

test('PluginDocRegistry: deep copy isolated and clear/removePlugin double register table clean up', { timeout: 60_000 }, () => {
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

  // get return deep copy: original ground sudden change do not pollute durable layer
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

  // event payload also is deep copy (consumer sudden change do not back pour)
  sessionHandle.set(101, { nested: { count: 2 } });
  (f.sessionEvents.at(-1)!.value as { nested: { count: number } }).nested.count = 77;
  assert.deepEqual(sessionHandle.get(101).nested, { count: 2 });

  // clear: two register table handle same clean,hasPublic*/again declaration can row (cycle more replace semantics)
  f.registry.clear('test-plugin');
  assert.equal(f.registry.hasPublicDoc('test-plugin', 'myDoc'), false);
  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'convState'), false);
  f.registry.registerDoc('test-plugin', 'myDoc', { n: 1 }, { public: true }, f.assertUsable);
  f.registry.registerSessionDoc('test-plugin', 'convState', { n: 1 }, { public: true }, f.assertUsable);

  // removePlugin: unload after same all clean
  f.registry.removePlugin('test-plugin');
  assert.equal(f.registry.hasPublicDoc('test-plugin', 'myDoc'), false);
  assert.equal(f.registry.hasPublicSessionDoc('test-plugin', 'convState'), false);
});

test('CapabilityRegistry: tool and action declaration, list derive and effect domain validate', { timeout: 60_000 }, async () => {
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

  // register action
  cap.registerAction('p1', {
    id: 'doSomething',
    description: 'test action',
    inputSchema: { type: 'object', properties: { val: { type: 'string' } }, required: ['val'] },
    outputSchema: { type: 'object', properties: { res: { type: 'string' } } },
    exposeAsTool: true,
    scope: { tags: ['allowed-tag'] },
    handler: (input: { val: string }) => ({ res: `handled:${input.val}` }),
  });

  // register tool
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
  // not declaration hint field manifest does not carry prompt key (no-options behavior do not change)
  assert.equal('promptSnippet' in actions[0]!, false);
  assert.equal('promptGuidelines' in actions[0]!, false);

  const tools = cap.listTools(['p1'], fakeConv);
  assert.equal(tools.length, 2); // 1 direct tool + 1 exposeAsTool action

  // effect domain does not match when filter
  const mismatchConv = { ...fakeConv, tags: ['other'] };
  const toolsMismatch = cap.listTools(['p1'], mismatchConv);
  assert.equal(toolsMismatch.length, 1); // exposeAsTool action by filter, only remain without scope  direct tool

  // invokeAction normal execute
  const actionRes = await cap.invokeAction('p1', 'doSomething', { val: 'hello' }, { conversationId: 1 }, options);
  assert.deepEqual(actionRes, { res: 'handled:hello' });

  // executeTool support all limit set name pluginId.actionId
  const toolExecRes = await cap.executeTool('p1.doSomething', { val: 'via-tool' }, { conversationId: 1 }, options);
  assert.deepEqual(toolExecRes, { res: 'handled:via-tool' });

  // executeTool directly tool invoke
  const directRes = await cap.executeTool('customTool', { num: 42 }, { conversationId: 1 }, options);
  assert.equal(directRes, 'tool:42');

  // scope exceeds right throw 403
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

test('UiRegistry: UI extension point collect, parameter validate and dependency validate', { timeout: 60_000 }, async () => {
  const ui = new UiRegistry();

  ui.registerUi('p1', 'sidebar.item', {
    id: 'p1Sidebar',
    label: 'Test Tab',
    icon: 'Terminal',
  }, 'sidebarItem');

  // duplicate ID throw 409
  assert.throws(
    () => {
      ui.registerUi('p1', 'sidebar.item', { id: 'p1Sidebar', label: 'Dup' }, 'sidebarItem');
    },
    (err: unknown) => err instanceof HelmError && err.code === 'duplicate_ui',
  );

  // docs declaration already follow declaration style JSON track path remove:assertUiDocsRegistered is hang point, no longer validate reference
  ui.assertUiDocsRegistered('p1', () => false);

  const list = ui.listUi(['p1']);
  assert.equal(list.length, 1);
  assert.equal(list[0]!.surface, 'sidebar.item');
  assert.equal((list[0]!.spec as { id: string }).id, 'p1Sidebar');
});

test('UiRegistry:listUi by activePluginIds iterate order return, do not pass when by internal insert order', { timeout: 60_000 }, async () => {
  const ui = new UiRegistry();

  // B first declaration UI
  ui.registerUi('B', 'sidebar.item', { id: 'bItem', label: 'B Tab' }, 'sidebarItem');
  // A after declaration UI
  ui.registerUi('A', 'sidebar.item', { id: 'aItem', label: 'A Tab' }, 'sidebarItem');

  // pass activePluginIds = ['A', 'B'] when, must by ['A', 'B'] order return, while non- internal map insert order
  const orderedList = ui.listUi(['A', 'B']);
  assert.equal(orderedList.length, 2);
  assert.equal(orderedList[0]!.pluginId, 'A');
  assert.equal((orderedList[0]!.spec as { id: string }).id, 'aItem');
  assert.equal(orderedList[1]!.pluginId, 'B');
  assert.equal((orderedList[1]!.spec as { id: string }).id, 'bItem');

  // pass activePluginIds = ['B', 'A'] when, by ['B', 'A'] order
  const reverseList = ui.listUi(['B', 'A']);
  assert.equal(reverseList.length, 2);
  assert.equal(reverseList[0]!.pluginId, 'B');
  assert.equal(reverseList[1]!.pluginId, 'A');

  // do not pass activePluginIds when, by internal map order (B first,A after)
  const defaultList = ui.listUi();
  assert.equal(defaultList.length, 2);
  assert.equal(defaultList[0]!.pluginId, 'B');
  assert.equal(defaultList[1]!.pluginId, 'A');
});
