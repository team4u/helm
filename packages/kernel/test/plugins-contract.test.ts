/**
 * new edition plugin core contract test: conversation effect domain, public document, host lifecycle port, each other for routing.
 * runner: tsx --test; each items explicit timeout: 60_000 guard against deadlock.
 */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { HelmError, type ConversationSummary, type EnvExecResponse, type MaybePromise, type PluginDefinition } from '@helm/protocol';
import { PluginHost } from '../src/plugins/index.js';
import { PluginHostBackendFixtureBase } from './helpers/plugin-host-backend.js';
import { createPluginBuildProvider } from '@helm/plugin-build';
import {
  MemoryDocStore,
  assertRejectsCode,
  cleanupDir,
  makeConversationSummary,
  makeTempDir,
} from './helpers.js';

// ---------------------------------------------------------------------------
// test base create
// ---------------------------------------------------------------------------

function makeConversation(id: number, over: Partial<ConversationSummary> = {}): ConversationSummary {
  return makeConversationSummary({ id, ...over });
}

/** can edit process conversation side:scope execute phase validate via host.getConversation now take real summary. */
class FakeBackend extends PluginHostBackendFixtureBase {
  conversations = new Map<number, ConversationSummary>();
  events: Array<{ type: string; payload: unknown }> = [];
  /** conversation manage protect record:(conversationId, pluginId) → still takes effect i.e. store in. */
  managed = new Map<string, { conversationId: number; pluginId: string }>();
  askSeqResolvers = new Set<(askId: string) => MaybePromise<number | undefined>>();
  workflowListeners = new Set<(run: unknown) => void | Promise<void>>();

  constructor() {
    super();
    this.conversations.set(1, makeConversation(1, { profileId: 'assistant', tags: ['root'] }));
    this.conversations.set(2, makeConversation(2, { profileId: 'superagent', tags: ['router'] }));
    this.conversations.set(3, makeConversation(3, { profileId: 'watchdog', tags: ['watchdog'] }));
    this.conversations.set(5, makeConversation(5, { profileId: 'worker', tags: ['worker'] }));
  }

  dispatchTrigger(): Promise<void> {
    return Promise.resolve();
  }
  submitInput(): Promise<void> {
    return Promise.resolve();
  }
  createConversation(): Promise<ConversationSummary> {
    return Promise.resolve(makeConversation(99));
  }
  listConversations(): ConversationSummary[] {
    return [...this.conversations.values()];
  }
  getConversation(id: number): ConversationSummary {
    const found = this.conversations.get(id);
    if (found === undefined) throw new HelmError('not_found', `conversation missing: ${id}`, 404);
    return found;
  }
  updateConversation(id: number): Promise<ConversationSummary> {
    return Promise.resolve(this.getConversation(id));
  }
  abortConversation(): Promise<void> {
    return Promise.resolve();
  }
  getConversationOwnership(): 'helm' | 'bot' | 'human' {
    return 'human';
  }
  spawnAgent(): Promise<unknown> {
    return Promise.resolve({});
  }
  runGate(): Promise<{ ok: boolean; output: string }> {
    return Promise.resolve({ ok: true, output: '' });
  }
  invokeAction(pluginId: string, actionId: string): Promise<unknown> {
    void pluginId;
    void actionId;
    return Promise.resolve({});
  }
  prepareAction(): { idempotent: boolean } {
    return { idempotent: false };
  }
  execEnv(): Promise<EnvExecResponse> {
    return Promise.reject(new HelmError('unsupported', 'this fixture do not execute node command', 501));
  }
  withFileMutationQueue(): Promise<never> { throw new Error('this fixture do not bear load file mutual exclusion queue') }
  listActions(): [] {
    return [];
  }
  manageConversation(id: number, pluginId: string): () => void {
    const entry = { conversationId: id, pluginId };
    const key = `${id}:${pluginId}`;
    this.managed.set(key, entry);
    return () => {
      this.managed.delete(key);
    };
  }
  markConversationOwnership(id: number, owner: 'helm' | 'bot' | 'human'): void {
    void id;
    void owner;
  }
  createAsk(): Promise<{ id: string; status: 'answered'; answers: Record<string, string> }> {
    return Promise.resolve({ id: 'ask-1', status: 'answered', answers: {} });
  }
  cancelAsk(): Promise<void> {
    return Promise.resolve();
  }
  registerAskSeqResolver(resolver: (askId: string) => MaybePromise<number | undefined>): () => void {
    this.askSeqResolvers.add(resolver);
    return () => {
      this.askSeqResolvers.delete(resolver);
    };
  }
  onEvent(_type: string, listener: (payload: unknown) => void | Promise<void>): () => void {
    this.workflowListeners.add(listener);
    return () => {
      this.workflowListeners.delete(listener);
    };
  }
  emitEvent(type: string, payload: unknown): void {
    this.events.push({ type, payload });
  }
}

let dataDir: string;
let backend: FakeBackend;
let docs: MemoryDocStore;

function makeHost(): PluginHost {
  return new PluginHost({ buildProvider: createPluginBuildProvider(), dataDir, host: backend, docs });
}

function throwsCode(fn: () => unknown, code: string): void {
  assert.throws(fn, (err: unknown) => {
    assert.ok(err instanceof HelmError, `expectation HelmError, actual:${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

/** construct a declaration tool and action plugin (scope can match; name carries id suffix avoid across plugin heavy name). */
function scopedPlugin(
  id: string,
  scope: { tool?: unknown; action?: unknown },
): PluginDefinition {
  const suffix = id.replaceAll(/[^A-Za-z0-9]/g, '_');
  return {
    id,
    definePlugin: (ctx) => {
      ctx.tool({
        name: `scoped_tool_${suffix}`,
        description: 'x',
        inputSchema: { type: 'object' },
        ...(scope.tool !== undefined ? { scope: scope.tool as never } : {}),
        execute: () => ({ ok: true }),
      });
      ctx.action({
        id: 'scoped_action',
        description: 'x',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        ...(scope.action !== undefined ? { scope: scope.action as never } : {}),
        handler: () => ({ ok: true }),
      });
    },
  };
}


/** scopedPlugin tool register name (and implement keep the same derive rule). */
function scopedToolName(pluginId: string): string {
  return `scoped_tool_${pluginId.replaceAll(/[^A-Za-z0-9]/g, '_')}`;
}

beforeEach(async () => {
  dataDir = await makeTempDir('helm-plugins-contract-');
  backend = new FakeBackend();
  docs = new MemoryDocStore();
});

afterEach(async () => {
  await cleanupDir(dataDir);
});

// ---------------------------------------------------------------------------
// 1. ConversationScope: register boundary validate
// ---------------------------------------------------------------------------

test('scope register boundary: non- pure object/unknown field/illegal element one rule invalid_plugin_scope and whole rollback', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const badScopes: unknown[] = [
    'not-object',
    42,
    null,
    new Map([['tags', ['a']]]),
    ['tags'],
    { conversationIds: '2,3' },
    { tags: [1, 'ok'] },
    { profileIds: [''] },
    { modelProviders: 'example' },
    { modelProviders: [''] },
    { modelProviders: [42] },
    { conversationIds: [0] },
    { conversationIds: [1.5] },
    { conversationIds: [-1] },
    { unknownField: ['x'] },
    { tags: 'worker' },
  ];
  for (const [i, scope] of badScopes.entries()) {
    await assertRejectsCode(
      () => host.register(scopedPlugin(`p:bad-${i}`, { tool: scope })),
      'invalid_plugin_scope',
      400,
    );
  }
  // all rollback: without plugin register
  assert.equal(host.list().length, 0);
  // action scope same in register boundary reject
  await assertRejectsCode(
    () => host.register(scopedPlugin('p:bad-action', { action: { tags: [new Date()] } })),
    'invalid_plugin_scope',
  );

  // legal scope(positive integer ID / non-empty string / empty array semantics another test) normal register
  const ok = makeHost();
  await ok.register(scopedPlugin('p:ok', { tool: { conversationIds: [1, 2], tags: ['worker'] } }));
  assert.equal(ok.list().length, 1);
});

test('model provider scope follow conversation switch takes effect, execute boundary re-check tool and action', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const scope = { modelProviders: ['example'] };
  await host.register(scopedPlugin('p:model-provider', { tool: scope, action: scope }));
  const conversation = backend.getConversation(1);
  conversation.model = 'example/group/nested-model';
  assert.ok(host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 });
  conversation.model = 'another/model';
  assert.ok(!host.listTools(conversation).some((tool) => tool.name === scopedToolName('p:model-provider')));
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:model-provider'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await assertRejectsCode(() => host.invokeAction('p:model-provider', 'scoped_action', {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
});

test('ui scope also in register boundary validate: illegal ui spec scope reject', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:ui-scope',
        definePlugin: (ctx) => {
          ctx.ui.screen({ id: 's', label: 'x', scope: { bogus: [1] } as never });
        },
      }),
    'invalid_plugin_scope',
  );
  // legal ui scope register succeeded and enter manifest
  await host.register({
    id: 'p:ui-scope-ok',
    definePlugin: (ctx) => {
      ctx.ui.screen({ id: 's', label: 'x', scope: { profileIds: ['superagent'] } });
    },
  });
  const ui = host.listUi();
  assert.equal(ui.length, 1);
  assert.deepEqual((ui[0]!.spec as { scope?: unknown }).scope, { profileIds: ['superagent'] });
});

test('timeline.renderer matchMeta only allows { renderer: non-empty string }', { timeout: 60_000 }, async () => {
  const host = makeHost();
  for (const [i, matchMeta] of [
    { renderer: '' },
    { renderer: 1 },
    { renderer: 'ok', extra: 1 },
    'nope',
    {},
  ].entries()) {
    await assertRejectsCode(
      () =>
        host.register({
          id: `p:mm-${i}`,
          definePlugin: (ctx) => {
            ctx.ui.timelineRenderer({ id: 'r', kinds: ['x'], matchMeta: matchMeta as never });
          },
        }),
      'invalid_ui_spec',
    );
  }
  await host.register({
    id: 'p:mm-ok',
    definePlugin: (ctx) => {
      ctx.ui.timelineRenderer({ id: 'r', kinds: ['worker.report'], matchMeta: { renderer: 'card' } });
    },
  });
  const spec = host.listUi()[0]!.spec as { matchMeta?: unknown };
  assert.deepEqual(spec.matchMeta, { renderer: 'card' });
});

// ---------------------------------------------------------------------------
// 2. listTools(conversation) by conversation filter choose + executeTool / invokeAction double heavy validate
// ---------------------------------------------------------------------------

test('listTools without reference all amount (runtime hot register); has reference by scope filter choose (profileIds is main example,tags through use)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:superagent-tools', {
      // new role example: router hub scope use profileIds express
      tool: { profileIds: ['superagent', 'watchdog'] },
      action: { profileIds: ['superagent', 'watchdog'] },
    }),
  );
  await host.register({
    id: 'p:worker-tools',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'archive',
        description: 'archive worker',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { tags: ['worker'] },
        exposeAsTool: true,
        handler: () => ({ archived: true }),
      });
    },
  });
  await host.register(scopedPlugin('p:unscoped', {}));

  // without reference: all tool (contains without scope and hit scope )
  const all = host.listTools();
  assert.equal(all.length, 3); // scoped_tool(superagent) + archive(worker) + scoped_tool(unscoped)

  // superagent conversation: visible profileIds hit two + without scope a
  const routerView = host.listTools(backend.conversations.get(2)!);
  const routerNames = routerView.map((t) => t.sourcePluginId).sort();
  assert.deepEqual(routerNames, ['p:superagent-tools', 'p:unscoped']);

  // worker conversation (tags hit)+ without scope
  const workerView = host.listTools(backend.conversations.get(5)!);
  assert.deepEqual(
    workerView.map((t) => t.sourcePluginId).sort(),
    ['p:unscoped', 'p:worker-tools'],
  );

  // assistant conversation: only remain without scope 
  const assistantView = host.listTools(backend.conversations.get(1)!);
  assert.deepEqual(assistantView.map((t) => t.sourcePluginId), ['p:unscoped']);
});

test('explicit empty array scope match fewer than any conversation (non- do not limit); default field do not limit', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(scopedPlugin('p:none', { tool: { conversationIds: [] } }));
  await host.register(scopedPlugin('p:partial', { tool: { profileIds: ['superagent'], tags: [] } }));
  await host.register(scopedPlugin('p:open', { tool: { profileIds: undefined } }));

  const conv = backend.conversations.get(2)!;
  const names = host.listTools(conv).map((t) => t.sourcePluginId);
  // p:none empty conversationIds do not hit;p:partial profileIds hit but tags empty array AND do not hit;
  // p:open without quality constraint hit
  assert.deepEqual(names, ['p:open']);
});

test('executeTool double heavy validate:scope missed 403, hit let through; without scope keep old behavior', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:guard', {
      tool: { profileIds: ['superagent'] },
      action: { profileIds: ['superagent'] },
    }),
  );

  // conversation 1(assistant) do not in scope: visible of outside directly execute also by refuse
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 1 }), 'conversation_scope_violation', 403);
  await assertRejectsCode(
    () => host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 1 }),
    'conversation_scope_violation',
    403,
  );
  // conversation 2(superagent) hit: let through
  assert.deepEqual(await host.executeTool(scopedToolName('p:guard'), {}, { conversationId: 2 }), { ok: true });
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}, { conversationId: 2 }), { ok: true });

  // without conversationId human invoke (HTTP/CLI without conversation context): let through (scope is conversation policy non- user authentication)
  assert.deepEqual(await host.invokeAction('p:guard', 'scoped_action', {}), { ok: true });

  // without scope plugin: any conversation and without conversation context all let through (old behavior)
  await host.register(scopedPlugin('p:free', {}));
  assert.deepEqual(await host.executeTool(scopedToolName('p:free'), {}, { conversationId: 1 }), { ok: true });
});

test('scope conversation summary via host.getConversation now take: conversation missing such as throw not_found', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register(
    scopedPlugin('p:gone', { tool: { conversationIds: [999] }, action: { conversationIds: [999] } }),
  );
  await assertRejectsCode(() => host.executeTool(scopedToolName('p:gone'), {}, { conversationId: 999 }), 'not_found', 404);
  // private change conversations panel does not affect:getConversation now take real data
  backend.conversations.delete(1);
  await assertRejectsCode(
    () => host.invokeAction('p:gone', 'scoped_action', {}, { conversationId: 1 }),
    'not_found',
  );
});

test('exposeAsTool action derive tool inherit scope:executeTool via invokeAction second validate', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'p:derived',
    definePlugin: (ctx) => {
      ctx.action({
        id: 'patrol',
        description: 'inspection',
        inputSchema: { type: 'object' },
        outputSchema: { type: 'object' },
        scope: { profileIds: ['watchdog'] },
        exposeAsTool: true,
        handler: () => ({ patrolled: true }),
      });
    },
  });
  const tools = host.listTools(backend.conversations.get(3)!); // watchdog conversation visible
  assert.equal(tools.length, 1);
  const alias = tools[0]!.name;
  assert.deepEqual(await host.executeTool(alias, {}, { conversationId: 3 }), { patrolled: true });
  // other conversation invisible and execute by refuse (double heavy validate)
  assert.equal(host.listTools(backend.conversations.get(1)!).length, 0);
  await assertRejectsCode(() => host.executeTool(alias, {}, { conversationId: 1 }), 'conversation_scope_violation');
  // listActions manifest carry scope(run_action manifest inject use)
  const manifest = host.listActions().find((a) => a.id === 'patrol')!;
  assert.deepEqual(manifest.scope, { profileIds: ['watchdog'] });
});

// ---------------------------------------------------------------------------
// 3. public document:public third reference / getPublicDoc / plugin.doc.updated
// ---------------------------------------------------------------------------

test('ctx.doc third reference public: private by default; public change plugin.doc.updated(value JSON-safe)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let publicHandle!: { set: (v: { n: number }) => void; update: (fn: (c: { n: number }) => { n: number }) => void };
  let privateHandle!: { set: (v: { n: number }) => void };
  await host.register({
    id: 'p:docs',
    definePlugin: (ctx) => {
      publicHandle = ctx.doc('pub', { n: 0 }, { public: true });
      privateHandle = ctx.doc('priv', { n: 0 });
    },
  });

  const docEvents = () =>
    backend.events
      .filter((e) => e.type === 'plugin.doc.updated')
      .map((e) => (e.payload as { doc: { pluginId: string; name: string; value: { n: number } } }).doc);

  // set / update all event, payload is PublicPluginDoc
  publicHandle.set({ n: 1 });
  publicHandle.update((c) => ({ n: c.n + 1 }));
  const emitted = docEvents();
  assert.equal(emitted.length, 2);
  assert.deepEqual(emitted.map((d) => d.value.n), [1, 2]);
  assert.equal(emitted[0]!.pluginId, 'p:docs');
  assert.equal(emitted[0]!.name, 'pub');

  // private doc write do not event
  privateHandle.set({ n: 9 });
  assert.equal(docEvents().length, 2);
});

test('getPublicDoc:public can read (contains not write initial value);private/missing/deactivate/not registered unify 404', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let publicHandle!: { set: (v: { n: number }) => void };
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // from not set
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
      publicHandle = ctx.doc('written', { n: 0 }, { public: true }) as never;
    },
  }).catch(() => {
    // written duplicate declaration will duplicate_doc - - swap clean write method
  });

  // on side deliberately register failed (duplicate_doc), swap clean plugin verify
  assert.equal(host.list().length, 0);
  await host.register({
    id: 'p:pub',
    definePlugin: (ctx) => {
      ctx.doc('fresh', { n: 7 }, { public: true }); // from not set: initial value can read
      ctx.doc('written', { n: 0 }, { public: true });
      ctx.doc('secret', { n: 0 });
    },
  });

  // initial value in not write when i.e. can read
  assert.deepEqual(host.getPublicDoc('p:pub', 'fresh'), { pluginId: 'p:pub', name: 'fresh', value: { n: 7 } });
  assert.deepEqual(host.getPublicDoc('p:pub', 'written'), { pluginId: 'p:pub', name: 'written', value: { n: 0 } });

  // private / not declaration: unify 404(external without from probe private doc store in)
  throwsCode(() => host.getPublicDoc('p:pub', 'secret'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:pub', 'missing'), 'plugin_doc_not_found');

  // deactivate after unify 404; not registered plugin 404
  await host.disable('p:pub');
  throwsCode(() => host.getPublicDoc('p:pub', 'fresh'), 'plugin_doc_not_found');
  throwsCode(() => host.getPublicDoc('p:none', 'any'), 'plugin_doc_not_found');

  // public doc illegal value (non- JSON):set boundary reject and do not event
  const h2 = makeHost();
  let handle2!: ReturnType<Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['doc']>;
  await h2.register({
    id: 'p:pub2',
    definePlugin: (ctx) => {
      handle2 = ctx.doc('bad', { n: 0 }, { public: true });
    },
  });
  throwsCode(() => handle2.set({ n: NaN }), 'invalid_json_value');
  assert.equal(
    backend.events.filter((e) => e.type === 'plugin.doc.updated').length,
    0,
  );
  void publicHandle;
});

test('doc opts only allows { public?: boolean }: unknown field reject', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:doc-opts',
        definePlugin: (ctx) => {
          ctx.doc('k', { n: 0 }, { public: true, extra: 1 } as never);
        },
      }),
    'invalid_doc_spec',
  );
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:doc-opts2',
        definePlugin: (ctx) => {
          ctx.doc('k', { n: 0 }, { public: 'yes' } as never);
        },
      }),
    'invalid_doc_spec',
  );
});

// ---------------------------------------------------------------------------
// 4. host lifecycle port:manageConversation / onWorkflowSettled / askSeq solve except
// ---------------------------------------------------------------------------

test('ctx.host.manageConversation automatically carry this plugin pluginId; release handle idempotent', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let release!: () => void;
  await host.register({
    id: 'p:manager',
    definePlugin: (ctx) => {
      release = ctx.host.manageConversation(2);
    },
  });
  // backend receives is (2, 'p:manager')- - plugin side only single reference, identity by host wrap inject
  assert.ok(backend.managed.has('2:p:manager'));

  // manually release idempotent: many time invoke only solve except once
  release();
  release();
  assert.ok(!backend.managed.has('2:p:manager'));

  // deactivate automatically release: re- manage after disable, no longer need to plugin manually release
  await host.register({
    id: 'p:manager2',
    definePlugin: (ctx) => {
      void ctx.host.manageConversation(3);
    },
  });
  assert.ok(backend.managed.has('3:p:manager2'));
  await host.disable('p:manager2');
  assert.ok(!backend.managed.has('3:p:manager2'));
});

test('register/enable failed without leaking host lifecycle asset (definePlugin throws i.e. rollback release)', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:leak',
        definePlugin: (ctx) => {
          void ctx.host.manageConversation(2);
          void ctx.host.onEvent('workflow.settled', () => {});
          void ctx.host.registerAskSeqResolver(() => undefined);
          throw new Error('definePlugin crash');
        },
      }),
    'plugin_registration_failed',
  );
  // three class asset all rollback release
  assert.equal(backend.managed.size, 0);
  assert.equal(backend.workflowListeners.size, 0);
  assert.equal(backend.askSeqResolvers.size, 0);

  // enable failed same rollback: first register succeeded again change broken definePlugin cannot row (define cannot change),
  // use service start failed drive enable rollback path
  let failStart = false;
  await host.register({
    id: 'p:leak2',
    definePlugin: (ctx) => {
      void ctx.host.manageConversation(5);
      ctx.service({
        id: 'svc',
        start: () => {
          if (failStart) throw new Error('start failed');
        },
        stop: () => {},
      });
    },
  });
  await host.disable('p:leak2');
  failStart = true;
  await assertRejectsCode(() => host.enable('p:leak2'), 'plugin_service_start_failed');
  assert.equal(backend.managed.size, 0);
});

test('onEvent(workflow.settled) listen: deactivate automatically solve except; call back count in-flight task protect; each run only trigger once', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let settledRuns: string[] = [];
  await host.register({
    id: 'p:wf',
    definePlugin: (ctx) => {
      void ctx.host.onEvent('workflow.settled', async (raw) => {
        // through use event channel:payload for kernel is do not transparent unknown(workflow.settled 
        // business shape by @helm/plugins contract explain,kernel independent of plugin business contract).
        const run = raw as { id: string };
        await new Promise((r) => setTimeout(r, 10));
        settledRuns.push(run.id);
      });
    },
  });
  assert.equal(backend.workflowListeners.size, 1);

  const makeRun = (id: string): { id: string } => ({
    id,
  });

  // normal trigger (listen is backend set: directly invoke i.e. can)
  for (const listener of backend.workflowListeners) await listener(makeRun('wf_a'));
  assert.deepEqual(settledRuns, ['wf_a']);

  // call back in-flight during disable by refuse (plugin_has_live_tasks)
  const firing = (async () => {
    for (const listener of backend.workflowListeners) await listener(makeRun('wf_b'));
  })();
  await new Promise((r) => setTimeout(r, 3));
  await assertRejectsCode(() => host.disable('p:wf'), 'plugin_has_live_tasks');
  await firing;
  assert.deepEqual(settledRuns, ['wf_a', 'wf_b']);

  // deactivate automatically solve except listen
  await host.disable('p:wf');
  assert.equal(backend.workflowListeners.size, 0);
  settledRuns = [];
});

test('registerAskSeqResolver deactivate automatically solve except; old cycle ctx host asset get by epoch guard reject', { timeout: 60_000 }, async () => {
  const host = makeHost();
  let stolenHost: Parameters<NonNullable<PluginDefinition['definePlugin']>>[0]['host'] | undefined;
  await host.register({
    id: 'p:seq',
    definePlugin: (ctx) => {
      void ctx.host.registerAskSeqResolver(() => 11);
      stolenHost = ctx.host;
    },
  });
  assert.equal(backend.askSeqResolvers.size, 1);
  await host.disable('p:seq');
  assert.equal(backend.askSeqResolvers.size, 0);

  // old cycle handle: get host lifecycle asset i.e. moment expires (409 plugin_context_expired)
  throwsCode(() => stolenHost!.manageConversation(1), 'plugin_context_expired');
  throwsCode(() => stolenHost!.onEvent('workflow.settled', () => {}), 'plugin_context_expired');
  throwsCode(() => stolenHost!.registerAskSeqResolver(() => undefined), 'plugin_context_expired');
});

test('ctx.host wrap layer forwarding new port:updateConversation / markConversationOwnership / createAsk three state', { timeout: 60_000 }, async () => {
  const host = makeHost();
  const marked: Array<{ id: number; owner: string }> = [];
  const origMark = backend.markConversationOwnership.bind(backend);
  backend.markConversationOwnership = (id: number, owner: 'helm' | 'bot' | 'human') => {
    marked.push({ id, owner });
    origMark(id, owner);
  };
  await host.register({
    id: 'p:fwd',
    definePlugin: (ctx) => {
      void ctx.host.updateConversation(1, { title: 'renamed' });
      ctx.host.markConversationOwnership(5, 'bot');
      void ctx.host.createAsk({
        conversationId: 1,
        title: 'confirm',
        fields: [{ name: 'ok', label: 'OK', type: 'confirm' }],
      });
    },
  });
  assert.equal(host.list().length, 1);
  assert.deepEqual(marked, [{ id: 5, owner: 'bot' }]);
});

// ---------------------------------------------------------------------------
// 5. each other for routing contract (new: only relative path)
// ---------------------------------------------------------------------------

test('each other for routing: host concatenate naming empty between,listRoutes output complete mount path', { timeout: 60_000 }, async () => {
  const host = makeHost();
  await host.register({
    id: 'builtin:triggers',
    definePlugin: (ctx) => {
      ctx.route({ method: 'POST', path: '/webhook/:id', public: true, handler: () => new Response('ok') });
    },
  });
  const routes = host.listRoutes();
  assert.equal(routes.length, 1);
  assert.equal(routes[0]!.path, '/api/plugins/builtin%3Atriggers/routes/webhook/:id');
  assert.equal(routes[0]!.public, true);

  // complete /api prefix, point segment escape, encode escape one rule reject
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/api/plugins/p%3Aevil/routes/x', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil2',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/%2e%2e/other', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  // illegal hundred number encode (%zz) register boundary i.e. refuse
  await assertRejectsCode(
    () =>
      host.register({
        id: 'p:evil3',
        definePlugin: (ctx) => {
          ctx.route({ method: 'GET', path: '/hook%zz', handler: () => new Response('x') });
        },
      }),
    'invalid_route_path',
  );
  assert.equal(host.listRoutes().length, 1);
});
